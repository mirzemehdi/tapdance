// Unit tests for `tapdance machine`. Every cloud CLI here is MOCKED: a fake `Exec` answers gcloud, scw,
// ssh, scp, ssh-keygen and this CLI's own connect/disconnect. No real cloud, VM or Mac is touched.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TapdanceError } from "@tapdance/sdk";
import { createSummary, machineCreate, machineDestroy, machineList, machineStop, parseCloud, parseIdleStop, parseMaxHours, renderDestroy } from "../commands-machine.js";
import type { MachineIo } from "./common.js";
import { autoHousekeeping, autoPolicyFrom, createArgs, ensureMachine, writeAuto } from "./auto.js";
import { gcpCost, gcpRunningHourly, scalewayCost } from "./cost.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import { shJoin } from "./exec.js";
import { gcpInstanceCreateArgs } from "./gcp.js";
import { macSetupCommand, sudoersInstallCommand } from "./scaleway.js";
import { MachineStore, assertMachineName, type MachineRecord } from "./state.js";

// Fake values, built from parts so no secret scanner mistakes this file for one holding a real key.
const TOKEN = ["slk", "fake", "test", "token"].join("_");
const TS_KEY = ["tskey", "fake", "for", "tests"].join("-");
const MAC_PW = "mac-sudo-password-xyz";
const ENDPOINT = "https://tapdance-android.tail1234.ts.net:4720";

interface Call {
  file: string;
  args: string[];
  input?: string;
}

type Handler = (call: Call) => Partial<ExecResult> | undefined;

async function fakeIo(handler: Handler, opts: { targets?: string[]; createRunning?: boolean; healthy?: () => boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "td-machine-"));
  const calls: Call[] = [];
  const spawned: string[][] = [];
  const progress: string[] = [];
  let clock = Date.parse("2026-11-09T10:00:00Z");
  const io: MachineIo = {
    exec: async (file: string, args: string[], options: ExecOptions = {}) => {
      const call: Call = { file, args, ...(options.input !== undefined ? { input: options.input } : {}) };
      calls.push(call);
      clock += 1000;
      const r = handler(call) ?? {};
      const res: ExecResult = { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      if (options.onLine) for (const l of `${res.stdout}\n${res.stderr}`.split("\n")) options.onLine(l);
      return res;
    },
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
    out: { progress: (m: string) => progress.push(m), warn: (m: string) => progress.push(`warning: ${m}`) },
    store: new MachineStore({ TAPDANCE_HOME: home }),
    env: { TAPDANCE_HOME: home },
    self: ["node", "/cli/main.js"],
    assets: { hostSetup: "/assets/host-setup.sh", autoLogin: "/assets/macos-auto-login.sh" },
    verbose: false,
    tailscaleBin: "/usr/bin/tailscale",
    targetNames: async () => opts.targets ?? [],
    readSecret: async () => TS_KEY,
    spawnCreate: async (args: string[]) => {
      spawned.push(args);
      return 4242;
    },
    alive: (pid: number) => pid === 4242 && opts.createRunning === true,
    healthz: async () => opts.healthy?.() ?? true,
  };
  return { io, calls, progress, home, spawned };
}

const has = (call: Call, ...parts: string[]) => parts.every((p) => call.args.includes(p));
const flat = (calls: Call[]) => calls.map((c) => [c.file, ...c.args].join(" ")).join("\n");

/** A healthy Google Cloud project, as gcloud would answer (mocked). */
function gcloudOk(state: { vm?: boolean; failSetup?: boolean; labelled?: boolean; leftover?: string } = {}): Handler {
  const created = new Set<string>();
  return (c) => {
    if (c.file === "/usr/bin/tailscale") return { stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "laptop.tail1234.ts.net." }, CertDomains: ["laptop.tail1234.ts.net"] }) };
    if (c.file === "node") {
      if (c.args.includes("connect")) return { stdout: JSON.stringify({ ok: true, checks: [] }) };
      if (c.args.includes("disconnect")) return { stdout: "{}" };
    }
    if (c.file !== "gcloud") return undefined;
    const a = c.args;
    if (has(c, "auth", "list")) return { stdout: "me@example.com\n" };
    if (has(c, "config", "get-value", "project")) return { stdout: "my-project\n" };
    if (has(c, "config", "get-value", "compute/zone")) return { stdout: "(unset)\n" };
    if (has(c, "services", "list")) return { stdout: "compute.googleapis.com\n" };
    if (a.includes("describe")) {
      const kind = a.slice(0, a.indexOf("describe")).join(" ");
      const name = a[a.indexOf("describe") + 1]!;
      if (kind === "compute instances") {
        if (!state.vm && !created.has(`instance ${name}`)) return { code: 1, stderr: `ERROR: The resource 'projects/my-project/zones/us-central1-a/instances/${name}' was not found` };
        return { stdout: JSON.stringify({ name, zone: "zones/us-central1-a", status: "RUNNING", machineType: "machineTypes/n2-standard-4", creationTimestamp: "2026-11-09T10:00:00Z", labels: state.labelled === false ? {} : { "tapdance-machine": "android", "created-by": "tapdance" } }) };
      }
      return created.has(`${kind} ${name}`) || state.vm ? { stdout: name } : { code: 1, stderr: `ERROR: (gcloud) resource ${name} was not found` };
    }
    if (a.includes("create")) {
      const kind = a.slice(0, a.indexOf("create")).join(" ");
      created.add(`${kind === "compute instances" ? "instance" : kind} ${a[a.indexOf("create") + 1]}`);
      return {};
    }
    if (has(c, "compute", "ssh")) {
      const cmd = a[a.indexOf("--command") + 1]!;
      if (cmd.includes("host-setup.sh")) {
        if (state.failSetup) return { code: 1, stderr: "host-setup: something broke" };
        return { stdout: "host-setup: installing\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/abc123\n\nTAPDANCE HOST READY" };
      }
      if (cmd.includes("host status --json")) return { stdout: JSON.stringify({ ready: true, endpoint: ENDPOINT, steps: [] }) };
      if (cmd.startsWith("cat ")) return { stdout: `${TOKEN}\n` };
      return {};
    }
    if (a.includes("list")) {
      if (has(c, "compute", "instances") && state.leftover) return { stdout: state.leftover };
      if (has(c, "compute", "disks")) return { stdout: "someone-elses-disk us-central1-a 10\n" };
      return { stdout: "" };
    }
    return {};
  };
}

describe("machine option parsing", () => {
  it("validates names, clouds, idle stop and max hours", () => {
    expect(assertMachineName("android")).toBe("android");
    expect(() => assertMachineName("Android")).toThrow(TapdanceError);
    expect(() => assertMachineName("a".repeat(21))).toThrow(/not a machine name/);
    expect(parseCloud("gcp")).toBe("gcp");
    expect(() => parseCloud("aws")).toThrow(/Unknown cloud/);
    expect(() => parseCloud(undefined)).toThrow(/--cloud gcp/);
    expect(parseIdleStop(undefined)).toBe(30);
    expect(parseIdleStop("off")).toBe("off");
    expect(() => parseIdleStop("2")).toThrow(/5 to 1440/);
    expect(parseMaxHours(undefined)).toBe(8);
    expect(() => parseMaxHours("0")).toThrow();
  });
});

describe("cost estimates", () => {
  it("prices an n2-standard-4 and a Scaleway M1-M from list prices", () => {
    expect(gcpRunningHourly("n2-standard-4")).toBeCloseTo(0.199, 2);
    const now = new Date("2026-11-09T12:00:00Z");
    const c = gcpCost({ machineType: "n2-standard-4", diskGb: 64, createdAt: new Date("2026-11-09T10:00:00Z"), status: "TERMINATED", now })!;
    expect(c.hourly).toBeCloseTo((64 * 0.1) / 730, 4);
    expect(c.soFar).toBeGreaterThan(0.39);
    // Less than 24 hours old still costs the 24-hour minimum.
    expect(scalewayCost({ type: "M1-M", createdAt: new Date("2026-11-09T11:00:00Z"), now })!.soFar).toBeCloseTo(2.64, 2);
    expect(scalewayCost({ type: "M1-M", createdAt: new Date("2026-11-07T12:00:00Z"), now })!.soFar).toBeCloseTo(5.28, 2);
  });
});

describe("machine create --cloud gcp (mocked gcloud)", () => {
  it("creates labelled resources, sets the host up and connects, keeping the token and key out of arguments", async () => {
    const { io, calls, progress } = await fakeIo(gcloudOk());
    const record = await machineCreate(io, { cloud: "gcp", yes: true, tailscaleKey: false }, [], false);
    expect(record.done).toEqual(["apis", "network", "vm", "ssh", "setup", "connect"]);
    expect(record.endpoint).toBe(ENDPOINT);
    const create = calls.find((c) => has(c, "instances", "create"))!;
    expect(create.args).toEqual(expect.arrayContaining(["--enable-nested-virtualization", "--labels=tapdance-machine=android,created-by=tapdance", "--max-run-duration=8h", "--instance-termination-action=STOP", "--no-service-account", "--project", "my-project"]));
    const fw = calls.find((c) => has(c, "firewall-rules", "create"))!;
    expect(fw.args).toEqual(expect.arrayContaining(["--source-ranges=35.235.240.0/20", "--rules=tcp:22", "--target-tags=tapdance-android", "--description=tapdance-machine=android"]));
    expect(calls.some((c) => has(c, "services", "enable", "iap.googleapis.com"))).toBe(true);
    const connect = calls.find((c) => c.file === "node" && c.args.includes("connect"))!;
    expect(connect.args).toEqual(["/cli/main.js", "--json", "connect", ENDPOINT, "--name", "android", "--platform", "android"]);
    expect(connect.input).toBe(`${TOKEN}\n`);
    expect(flat(calls)).not.toContain(TOKEN);
    expect(progress.join("\n")).toContain("https://login.tailscale.com/a/abc123");
    expect(progress.join("\n")).not.toContain(TOKEN);
  });

  it("passes a Tailscale auth key on standard input only", async () => {
    const { io, calls, progress } = await fakeIo(gcloudOk());
    await machineCreate(io, { cloud: "gcp", yes: true, tailscaleKey: true }, ["--play-store"], false);
    const setup = calls.find((c) => has(c, "compute", "ssh") && c.args.some((x) => x.includes("host-setup.sh")))!;
    expect(setup.input).toBe(`${TS_KEY}\n`);
    expect(setup.args.find((x) => x.includes("host-setup.sh"))).toMatch(/--tailscale-auth-key-stdin --idle-stop 30 --tapdance-version \d+\.\d+\.\d+ --play-store/);
    expect(flat(calls)).not.toContain(TS_KEY);
    expect(progress.join("\n")).not.toContain(TS_KEY);
    expect(shJoin(["it's"])).toBe(`'it'\\''s'`);
  });

  it("refuses something that is not a Tailscale auth key", async () => {
    const { io } = await fakeIo(gcloudOk());
    io.readSecret = async () => "not-a-key";
    await expect(machineCreate(io, { cloud: "gcp", yes: true, tailscaleKey: true }, [], false)).rejects.toThrow(/not a Tailscale auth key/);
  });

  it("continues at the failed step when run again", async () => {
    const state = { failSetup: true };
    const { io, calls } = await fakeIo(gcloudOk(state));
    const err = await machineCreate(io, { cloud: "gcp", yes: true }, [], false).catch((e: unknown) => e as TapdanceError);
    expect(err).toBeInstanceOf(TapdanceError);
    expect((err as TapdanceError).message).toMatch(/Step 5 of 6 \("Set up the machine/);
    expect((err as TapdanceError).hint).toMatch(/tapdance machine create --cloud gcp --name android --project my-project/);
    expect((err as TapdanceError).hint).toMatch(/tapdance machine destroy android/);
    state.failSetup = false;
    const before = calls.filter((c) => has(c, "instances", "create")).length;
    const record = await machineCreate(io, { cloud: "gcp", yes: true }, [], false);
    expect(record.done).toContain("connect");
    expect(calls.filter((c) => has(c, "instances", "create")).length).toBe(before);
  });

  it("asks before creating, and refuses a name that is already a connect target", async () => {
    const { io } = await fakeIo(gcloudOk());
    await expect(machineCreate(io, { cloud: "gcp" }, [], false)).rejects.toThrow(/confirmation/);
    expect(await io.store.get("android")).toBeUndefined();
    const other = await fakeIo(gcloudOk(), { targets: ["android"] });
    await expect(machineCreate(other.io, { cloud: "gcp", yes: true }, [], false)).rejects.toThrow(/already has a connect target called android/);
  });

  it("explains how to log in when gcloud is missing or logged out", async () => {
    const missing = await fakeIo((c) => (c.file === "gcloud" ? { code: 127 } : undefined));
    await expect(machineCreate(missing.io, { cloud: "gcp", yes: true }, [], false)).rejects.toMatchObject({ code: "HOST_CHECK_FAILED", hint: expect.stringContaining("gcloud auth login") });
    const out = await fakeIo((c) => (c.file === "gcloud" ? { stdout: "" } : undefined));
    await expect(machineCreate(out.io, { cloud: "gcp", yes: true }, [], false)).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("builds the VM without a service account and without a run cap when --max-hours off", () => {
    const args = gcpInstanceCreateArgs({ name: "android", resourceName: "tapdance-android", zone: "europe-west1-b", machineType: "n2-standard-4", diskGb: 64, maxHours: "off" } as MachineRecord);
    expect(args).not.toContain("--instance-termination-action=STOP");
    expect(args).toContain("--subnet=tapdance-android");
  });
});

describe("machine destroy / stop on Google Cloud (mocked gcloud)", () => {
  it("removes only this machine's resources, logs out of Tailscale, and reports others without touching them", async () => {
    const { io, calls } = await fakeIo(gcloudOk());
    await machineCreate(io, { cloud: "gcp", yes: true }, [], false);
    const d = await machineDestroy(io, "android", { yes: true }, false);
    expect(d.clean).toBe(true);
    const deletes = calls.filter((c) => c.args.includes("delete")).map((c) => c.args.slice(0, c.args.indexOf("delete") + 2).join(" "));
    expect(deletes).toEqual(["compute instances delete tapdance-android", "compute firewall-rules delete tapdance-android-iap-ssh", "compute networks subnets delete tapdance-android", "compute networks delete tapdance-android"]);
    expect(calls.some((c) => c.args.some((x) => x.endsWith("tailscale logout")))).toBe(true);
    expect(calls.some((c) => c.file === "node" && c.args.includes("disconnect"))).toBe(true);
    expect(d.leftovers.others).toEqual(["disk someone-elses-disk us-central1-a 10"]);
    expect(renderDestroy(d)).toContain("Nothing billable left from this machine.");
    expect(await io.store.get("android")).toBeUndefined();
  });

  it("builds from source only with --setup-ref, and says nothing to remove when the VM never joined Tailscale", async () => {
    const base = gcloudOk();
    const { io, calls } = await fakeIo((c) => (c.file === "gcloud" && c.args.some((a) => a.includes("tailscale logout")) ? { code: 3 } : base(c)));
    const record = await machineCreate(io, { cloud: "gcp", yes: true, setupRef: "feat/x" }, [], false);
    const setup = calls.find((c) => has(c, "compute", "ssh") && c.args.some((x) => x.includes("bash tapdance-host-setup.sh")))!.args.find((x) => x.includes("bash tapdance-host-setup.sh"))!;
    expect(setup).toContain("TAPDANCE_REF=feat/x ");
    expect(setup).not.toContain("--tapdance-version");
    expect(record.tapdanceVersion).toBeUndefined();
    const d = await machineDestroy(io, "android", { yes: true }, false);
    expect(d.removed).toContain("Tailscale: the machine had not joined your tailnet, nothing to remove");
    expect(d.notes).toEqual([]);
  });

  it("refuses a VM that is not labelled as this machine", async () => {
    const { io } = await fakeIo(gcloudOk({ vm: true, labelled: false }));
    await io.store.save({ version: 1, name: "android", cloud: "gcp", createdAt: "2026-11-09T10:00:00Z", project: "my-project", zone: "us-central1-a", machineType: "n2-standard-4", resourceName: "tapdance-android", label: "l", target: "android", tailscaleHostname: "tapdance-android", setupRef: "v0.2.0", done: ["vm"], timings: {} });
    await expect(machineDestroy(io, "android", { yes: true }, false)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reports a leftover of this machine and keeps its record", async () => {
    const { io } = await fakeIo(gcloudOk({ vm: true, leftover: "tapdance-android us-central1-a STOPPING tapdance-machine=android\n" }));
    await io.store.save({ version: 1, name: "android", cloud: "gcp", createdAt: "2026-11-09T10:00:00Z", project: "my-project", zone: "us-central1-a", machineType: "n2-standard-4", resourceName: "tapdance-android", label: "l", target: "android", tailscaleHostname: "tapdance-android", setupRef: "v0.2.0", done: ["vm"], timings: {} });
    const d = await machineDestroy(io, "android", { yes: true }, false);
    expect(d.clean).toBe(false);
    expect(renderDestroy(d)).toContain("Still there from this machine");
    expect(await io.store.get("android")).toBeDefined();
  });

  it("stops and starts a gcp VM", async () => {
    const { io, calls } = await fakeIo(gcloudOk());
    await machineCreate(io, { cloud: "gcp", yes: true }, [], false);
    expect(await machineStop(io, "android", false)).toMatch(/bills only its disk/);
    expect(await machineStop(io, "android", true)).toMatch(/come back by themselves/);
    expect(calls.some((c) => has(c, "instances", "stop", "tapdance-android"))).toBe(true);
    expect(calls.some((c) => has(c, "instances", "start", "tapdance-android"))).toBe(true);
  });

  it("lists machines with state, age and an estimated cost", async () => {
    const { io } = await fakeIo((c) => {
      if (c.file === "gcloud" && has(c, "instances", "list")) {
        return { stdout: JSON.stringify([{ name: "tapdance-android", zone: "z/us-central1-a", status: "RUNNING", machineType: "m/n2-standard-4", creationTimestamp: "2026-11-09T08:00:00Z", labels: { "tapdance-machine": "android" }, disks: [{ diskSizeGb: "64" }] }]) };
      }
      return undefined;
    });
    const { machines } = await machineList(io, { project: "my-project" });
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({ name: "android", cloud: "gcp", state: "RUNNING", tracked: false });
    expect(machines[0]!.costSoFar).toMatch(/^USD 0\.\d\d$/);
  });
});

/** A Scaleway account, as scw would answer (mocked). The Mac's password comes only from `server get`. */
function scwOk(state: { deletableAt?: string; failSetup?: boolean } = {}): Handler {
  const server = { id: "srv-1", name: "tapdance-ios", type: "M1-M", status: "ready", ip: "51.0.0.1", ssh_username: "m1", sudo_password: MAC_PW, created_at: "2026-11-09T10:00:00Z", deletable_at: state.deletableAt ?? "2026-11-10T10:00:00Z", vnc_url: "vnc://m1:secret@51.0.0.1" };
  return (c) => {
    if (c.file === "/usr/bin/tailscale") return { stdout: JSON.stringify({ BackendState: "Running", CertDomains: ["x"] }) };
    if (c.file === "node") return { stdout: JSON.stringify(c.args.includes("connect") ? { ok: true, checks: [] } : {}) };
    if (c.file === "ssh-keygen") return {};
    if (c.file === "scp") return {};
    if (c.file === "ssh") {
      const cmd = c.args[c.args.length - 1]!;
      if (cmd === "who") return { stdout: "m1  console  Nov  9 10:05\n" };
      if (cmd.includes("host-setup.sh")) return state.failSetup ? { code: 1, stderr: "boom" } : { stdout: "TAPDANCE HOST READY" };
      if (cmd.includes("host status --json")) return { stdout: JSON.stringify({ ready: true, endpoint: "https://tapdance-ios.tail1234.ts.net:4720" }) };
      if (cmd.startsWith("cat ")) return { stdout: TOKEN };
      return {};
    }
    if (c.file !== "scw") return undefined;
    if (has(c, "server-type", "list")) return { stdout: JSON.stringify([{ name: "M1-M", stock: "available" }]) };
    if (has(c, "ssh-key", "create")) return { stdout: JSON.stringify({ id: "key-1" }) };
    if (has(c, "server", "create")) return { stdout: JSON.stringify({ ...server, status: "starting", ip: "" }) };
    if (has(c, "server", "get")) return { stdout: JSON.stringify(server) };
    if (has(c, "server", "list")) return { stdout: JSON.stringify([server, { ...server, id: "srv-2", name: "my-own-mac" }]) };
    if (has(c, "private-network", "list")) return { stdout: "[]" };
    return { stdout: "{}" };
  };
}

async function writeKeyStub(io: MachineIo, name: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(io.store.dir(name), { recursive: true });
  await writeFile(join(io.store.dir(name), "id_ed25519.pub"), "ssh-ed25519 AAAA tapdance-ios\n");
}

describe("machine create --cloud scaleway (mocked scw and ssh)", () => {
  it("warns about the 24-hour minimum before renting", () => {
    const text = createSummary({ cloud: "scaleway", name: "ios", machineType: "M1-M", zone: "fr-par-3", tailscaleHostname: "tapdance-ios", target: "ios", scheduledDeletion: true } as MachineRecord).join("\n");
    expect(text).toMatch(/at least 24 hours/);
    expect(text).toMatch(/also while switched off/);
    expect(text).toMatch(/automatic deletion at the 24-hour mark/);
  });

  it("rents, schedules deletion, sets up with the Mac's password on stdin only, and removes the setup's sudo rule", async () => {
    const { io, calls } = await fakeIo(scwOk());
    await writeKeyStub(io, "ios");
    const record = await machineCreate(io, { cloud: "scaleway", yes: true }, ["--with-gh"], false);
    expect(record.done).toEqual(["ssh-key", "server", "install", "auto-login", "setup", "connect"]);
    expect(calls.some((c) => has(c, "update", "srv-1", "schedule-deletion=true"))).toBe(true);
    expect(calls.some((c) => has(c, "reboot", "srv-1"))).toBe(true);
    expect(flat(calls)).not.toContain(MAC_PW);
    expect(flat(calls)).not.toContain(TOKEN);
    const pwInputs = calls.filter((c) => c.input === `${MAC_PW}\n`);
    expect(pwInputs.length).toBeGreaterThanOrEqual(2);
    const setup = calls.find((c) => c.file === "ssh" && c.args.at(-1)!.includes("host-setup.sh"))!;
    expect(setup.args.at(-1)).toContain("--ios-only --yes --allow-admin-account --label");
    expect(setup.args.at(-1)).toMatch(/--warm android=0,ios=0 --tapdance-version \d+\.\d+\.\d+ --with-gh/);
    expect(setup.args.at(-1)).not.toContain("TAPDANCE_REF");
    const last = calls.filter((c) => c.file === "ssh").map((c) => c.args.at(-1)!);
    expect(last.indexOf("sudo -n rm -f /etc/sudoers.d/tapdance-setup /etc/sudoers.d/tapdance-setup.new")).toBeGreaterThan(last.findIndex((x) => x.includes("host-setup.sh")));
    const saved = await readFile(join(io.store.dir("ios"), "machine.json"), "utf8");
    expect(saved).not.toContain(MAC_PW);
    expect(saved).not.toContain("vnc");
  });

  it("removes the setup's sudo rule even when setup fails", async () => {
    const { io, calls } = await fakeIo(scwOk({ failSetup: true }));
    await writeKeyStub(io, "ios");
    await expect(machineCreate(io, { cloud: "scaleway", yes: true }, [], false)).rejects.toThrow(/Step 5 of 6/);
    expect(calls.filter((c) => c.file === "ssh").some((c) => c.args.at(-1)!.startsWith("sudo -n rm -f /etc/sudoers.d/tapdance-setup"))).toBe(true);
  });

  it("refuses stop and start, explaining the billing", async () => {
    const { io } = await fakeIo(scwOk());
    await writeKeyStub(io, "ios");
    await machineCreate(io, { cloud: "scaleway", yes: true }, [], false);
    await expect(machineStop(io, "ios", false)).rejects.toMatchObject({ code: "NOT_SUPPORTED", hint: expect.stringContaining("also while it is switched off") });
  });

  it("schedules deletion before the 24 hours are up, and leaves other Macs alone", async () => {
    const { io, calls } = await fakeIo(scwOk({ deletableAt: "2026-11-10T10:00:00Z" }));
    await writeKeyStub(io, "ios");
    await machineCreate(io, { cloud: "scaleway", yes: true }, [], false);
    const d = await machineDestroy(io, "ios", { yes: true }, false);
    expect(calls.some((c) => has(c, "server", "delete"))).toBe(false);
    expect(d.record.pendingDeletionAt).toBe("2026-11-10T10:00:00Z");
    expect(d.leftovers.others.join()).toContain("my-own-mac");
    expect(calls.some((c) => has(c, "ssh-key", "delete", "key-1"))).toBe(true);
    expect(renderDestroy(d)).toContain("scheduled for deletion at 2026-11-10T10:00:00Z");
    expect(await io.store.get("ios")).toBeDefined();
  });

  it("deletes after the 24 hours", async () => {
    const { io, calls } = await fakeIo(scwOk({ deletableAt: "2026-11-09T09:00:00Z" }));
    await writeKeyStub(io, "ios");
    await machineCreate(io, { cloud: "scaleway", yes: true }, [], false);
    await machineDestroy(io, "ios", { yes: true }, false);
    expect(calls.some((c) => has(c, "server", "delete", "srv-1"))).toBe(true);
  });

  it("builds the sudo rule command with the password on stdin, not the command line", () => {
    const cmd = sudoersInstallCommand("m1");
    expect(cmd).toMatch(/^sudo -S -p '' sh -c /);
    expect(cmd).toContain("visudo -cf");
    expect(macSetupCommand({ label: "laptop", tailscaleHostname: "tapdance-ios", setupRef: "v0.2.0", machineType: "M2-M" } as MachineRecord, { withKey: false, extra: [] })).not.toContain("--warm");
  });
});

describe("host-setup.sh --tailscale-auth-key-stdin (runs the real script, which stops before installing anything)", () => {
  const script = new URL("../../../../scripts/host-setup.sh", import.meta.url).pathname;
  const run = async (input: string, args: string[]) => {
    const { spawnSync } = await import("node:child_process");
    return spawnSync("bash", [script, ...args], { input, encoding: "utf8", env: { ...process.env, HOME: await mkdtemp(join(tmpdir(), "td-hs-")) } });
  };
  it("refuses standard input that is not an auth key, without echoing it", async () => {
    const r = await run("not-a-key-SECRETVALUE\n", ["--tailscale-auth-key-stdin", "--check"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("did not hold a Tailscale auth key");
    expect(`${r.stdout}${r.stderr}`).not.toContain("SECRETVALUE");
  });
  it("refuses a --tapdance-version that is not a version", async () => {
    const r = await run("", ["--tapdance-version", "latest;rm", "--check"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("is not a version like 0.2.1");
  });
  it("refuses a bad --tailscale-hostname", async () => {
    const r = await run("", ["--tailscale-hostname", "bad name;rm", "--check"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("is not a host name");
  });
});

describe("machine auto (mocked gcloud and scw)", () => {
  const parsers = { idleStop: parseIdleStop, maxHours: parseMaxHours };

  it("needs --accept-mac-day before it may rent Macs, and builds the create command from the policy", () => {
    expect(() => autoPolicyFrom({ platform: "ios" }, parsers, new Date())).toThrow(/at least 24 hours/);
    const { policy } = autoPolicyFrom({ platform: "android", project: "my-project", deleteAfterDays: "7" }, parsers, new Date());
    expect(createArgs(policy)).toEqual(["machine", "create", "--cloud", "gcp", "--name", "android", "--yes", "--project", "my-project", "--idle-stop", "30", "--max-hours", "8"]);
    expect(() => autoPolicyFrom({ platform: "ios", acceptMacDay: true, deleteAfterDays: "2" }, parsers, new Date())).toThrow(/for Android/);
    expect(() => autoPolicyFrom({ platform: "android", cloud: "scaleway" }, parsers, new Date())).toThrow(/--cloud gcp/);
  });

  it("creates a missing machine in the background and answers with a retryable error", async () => {
    const { io, spawned } = await fakeIo(gcloudOk());
    await writeAuto(io, { android: autoPolicyFrom({ platform: "android", project: "my-project" }, parsers, io.now()).policy });
    const err = await ensureMachine(io, "android", () => undefined).catch((e: unknown) => e as TapdanceError);
    expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(err.message).toMatch(/Creating machine android for android/);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain("--yes");
  });

  it("does not start a second create while one runs, and shows the Tailscale link from the setup log", async () => {
    const { io, spawned } = await fakeIo(gcloudOk(), { createRunning: true });
    await writeAuto(io, { android: autoPolicyFrom({ platform: "android", project: "my-project" }, parsers, io.now()).policy });
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(io.store.dir("android"), { recursive: true });
    await writeFile(join(io.store.dir("android"), "auto-create.pid"), "4242\n");
    await writeFile(join(io.store.dir("android"), "setup.log"), "To authenticate, visit:\n\thttps://login.tailscale.com/a/xyz789\n");
    const err = await ensureMachine(io, "android", () => undefined).catch((e: unknown) => e as TapdanceError);
    expect(err.message).toMatch(/Still creating/);
    expect(err.hint).toContain("https://login.tailscale.com/a/xyz789");
    expect(spawned).toHaveLength(0);
  });

  it("starts a stopped machine and waits for its guard", async () => {
    const stopped = gcloudOk({ vm: true });
    let started = false;
    const handler: Handler = (c) => {
      if (c.file === "gcloud" && has(c, "instances", "describe")) return { stdout: JSON.stringify({ name: "tapdance-android", zone: "z/us-central1-a", status: started ? "RUNNING" : "TERMINATED", machineType: "m/n2-standard-4", creationTimestamp: "2026-11-01T10:00:00Z", labels: { "tapdance-machine": "android" } }) };
      if (c.file === "gcloud" && has(c, "instances", "start")) started = true;
      return stopped(c);
    };
    const { io, calls } = await fakeIo(handler, { healthy: () => started });
    await io.store.save({ version: 1, name: "android", cloud: "gcp", createdAt: "2026-11-01T10:00:00Z", project: "my-project", zone: "us-central1-a", machineType: "n2-standard-4", resourceName: "tapdance-android", label: "l", target: "android", tailscaleHostname: "tapdance-android", setupRef: "v0.2.0", endpoint: ENDPOINT, done: ["apis", "network", "vm", "ssh", "setup", "connect"], timings: {} });
    await writeAuto(io, { android: autoPolicyFrom({ platform: "android", project: "my-project" }, parsers, io.now()).policy });
    const r = await ensureMachine(io, "android", () => undefined);
    expect(r.notice).toMatch(/Started machine android for this lease/);
    expect(calls.some((c) => has(c, "instances", "start", "tapdance-android"))).toBe(true);
  });

  it("destroys an Android machine stopped longer than --delete-after-days, and nothing sooner", async () => {
    const make = (stoppedAt: string) => (c: Call) => {
      if (c.file === "gcloud" && has(c, "instances", "describe")) return { stdout: JSON.stringify({ name: "tapdance-android", zone: "z", status: "TERMINATED", machineType: "m/n2-standard-4", creationTimestamp: "2026-10-01T10:00:00Z", lastStopTimestamp: stoppedAt, labels: { "tapdance-machine": "android" } }) };
      return gcloudOk({ vm: true })(c);
    };
    for (const [stoppedAt, destroyed] of [["2026-11-08T10:00:00Z", false], ["2026-10-20T10:00:00Z", true]] as const) {
      const { io, calls } = await fakeIo(make(stoppedAt));
      await io.store.save({ version: 1, name: "android", cloud: "gcp", createdAt: "2026-10-01T10:00:00Z", project: "my-project", zone: "us-central1-a", machineType: "n2-standard-4", resourceName: "tapdance-android", label: "l", target: "android", tailscaleHostname: "tapdance-android", setupRef: "v0.2.0", done: ["vm", "connect"], timings: {} });
      await writeAuto(io, { android: autoPolicyFrom({ platform: "android", project: "my-project", deleteAfterDays: "7" }, parsers, io.now()).policy });
      const msgs = await autoHousekeeping(io);
      expect(calls.some((c) => has(c, "instances", "delete"))).toBe(destroyed);
      expect(msgs.length > 0).toBe(destroyed);
    }
  });

  it("refuses to rent a new Mac after the old one is gone unless the day was accepted", async () => {
    const { io, spawned } = await fakeIo((c) => (c.file === "scw" && has(c, "server", "get") ? { code: 1, stderr: "404 not found" } : scwOk()(c)));
    await io.store.save({ version: 1, name: "ios", cloud: "scaleway", createdAt: "2026-11-08T10:00:00Z", zone: "fr-par-3", machineType: "M1-M", resourceName: "tapdance-ios", label: "l", target: "ios", tailscaleHostname: "tapdance-ios", setupRef: "v0.2.0", serverId: "srv-1", done: ["connect"], timings: {} });
    await writeAuto(io, { ios: { cloud: "scaleway", name: "ios", enabledAt: "x" } });
    await expect(ensureMachine(io, "ios", () => undefined)).rejects.toThrow(/may not rent a new one/);
    await writeAuto(io, { ios: { cloud: "scaleway", name: "ios", acceptMacDay: true, enabledAt: "x" } });
    await expect(ensureMachine(io, "ios", () => undefined)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(spawned).toHaveLength(1);
  });
});

describe("Scaleway zones, offers and a Mac you rented (mocked scw and ssh)", () => {
  /** An account with one Mac the person rented in fr-par-1, and stock per zone. */
  function account(opts: { sshDenied?: boolean } = {}): Handler {
    const mine = { id: "own-1", name: "apple-silicon-wizardly-shirley", type: "M2-L", status: "ready", ip: "62.0.0.9", ssh_username: "m1", sudo_password: MAC_PW, created_at: "2026-11-09T14:39:00Z", deletable_at: "2026-11-10T14:39:00Z", zone: "fr-par-1" };
    let keyInstalled = !opts.sshDenied;
    return (c) => {
      if (c.file === "/usr/bin/tailscale") return { stdout: JSON.stringify({ BackendState: "Running", CertDomains: ["x"] }) };
      if (c.file === "node") return { stdout: JSON.stringify(c.args.includes("connect") ? { ok: true, checks: [] } : {}) };
      if (c.file === "ssh-keygen" || c.file === "scp") return {};
      if (c.file === "ssh") {
        const cmd = c.args[c.args.length - 1]!;
        if (cmd.includes("authorized_keys")) {
          keyInstalled = true;
          return {};
        }
        if (!keyInstalled) return { code: 255, stderr: "m1@62.0.0.9: Permission denied (publickey,password,keyboard-interactive)." };
        if (cmd === "who") return { stdout: "m1 console\n" };
        if (cmd.includes("host status --json")) return { stdout: JSON.stringify({ ready: true, endpoint: "https://apple-silicon-wizardly-shirley.tail1234.ts.net:4720" }) };
        if (cmd.startsWith("cat ")) return { stdout: TOKEN };
        return {};
      }
      if (c.file !== "scw") return undefined;
      const zone = c.args.find((a) => a.startsWith("zone="))?.slice(5);
      if (has(c, "server-type", "list")) {
        return { stdout: JSON.stringify(zone === "fr-par-1" ? [{ name: "M1-M", stock: "no_stock" }, { name: "M4-S", stock: "low_stock" }] : [{ name: "M1-M", stock: "no_stock" }, { name: "M2-M", stock: "available" }]) };
      }
      if (has(c, "server", "get")) return zone === "fr-par-1" && c.args.includes("own-1") ? { stdout: JSON.stringify(mine) } : { code: 1, stderr: "404 not found" };
      if (has(c, "server", "list")) return { stdout: JSON.stringify(zone === "fr-par-1" ? [mine] : []) };
      if (has(c, "private-network", "list")) return { stdout: "[]" };
      return { stdout: "{}" };
    };
  }

  it("never asks for zone=all, and picks the cheapest Mac mini in stock in any zone", async () => {
    const { io, calls } = await fakeIo(account());
    const { pickScalewayOffer } = await import("./scaleway.js");
    expect(await pickScalewayOffer(io, {})).toMatchObject({ type: "M2-M", zone: "fr-par-3" });
    expect(await pickScalewayOffer(io, { type: "M4-S" })).toMatchObject({ type: "M4-S", zone: "fr-par-1" });
    await expect(pickScalewayOffer(io, { type: "M1-M" })).rejects.toMatchObject({ code: "NO_CAPACITY", hint: expect.stringContaining("M2-M in fr-par-3") });
    const { Scaleway } = await import("./scaleway.js");
    expect((await new Scaleway(io, undefined).listServers()).map((s) => s.zone)).toEqual(["fr-par-1"]);
    expect(calls.some((c) => c.args.includes("zone=all"))).toBe(false);
  });

  it("sets up a Mac the person rented: rents nothing, adds no project key, schedules no deletion", async () => {
    const { io, calls } = await fakeIo(account({ sshDenied: true }));
    await writeKeyStub(io, "ios");
    const record = await machineCreate(io, { cloud: "scaleway", serverId: "own-1", yes: true }, [], false);
    expect(record).toMatchObject({ adopted: true, serverId: "own-1", zone: "fr-par-1", machineType: "M2-L", resourceName: "apple-silicon-wizardly-shirley" });
    expect(record.done).toContain("connect");
    expect(calls.some((c) => has(c, "server", "create"))).toBe(false);
    expect(calls.some((c) => has(c, "ssh-key", "create"))).toBe(false);
    expect(calls.some((c) => c.args.includes("schedule-deletion=true"))).toBe(false);
    // The password went to ssh only through the askpass helper's environment, never an argument.
    const keyCall = calls.find((c) => c.file === "ssh" && c.args.at(-1)!.includes("authorized_keys"))!;
    expect(keyCall.args).toContain("PubkeyAuthentication=no");
    expect(flat(calls)).not.toContain(MAC_PW);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(io.store.dir("ios"), "askpass.sh"))).toBe(false);
  });

  it("refuses an id that is not in the project", async () => {
    const { io } = await fakeIo(account());
    await expect(machineCreate(io, { cloud: "scaleway", serverId: "nope", yes: true }, [], false)).rejects.toThrow(/No Mac mini nope/);
  });
});
