// Unit tests for `tapdance machine`. Every cloud CLI here is MOCKED: a fake `Exec` answers gcloud, scw,
// ssh, scp, ssh-keygen and this CLI's own connect/disconnect. No real cloud, VM or Mac is touched.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TapdanceError, type MachineAutoInput } from "@tapdance/sdk";
import { createSummary, machineCreate, machineDestroy, machineList, machineStop, parseCloud, parseIdleStop, parseMaxHours, refuseLocalWorker, renderDestroy } from "../commands-machine.js";
import { tailnetEndpoint, type MachineIo } from "./common.js";
import { autoDecision, autoHousekeeping, autoPolicyFrom, createArgs, describePolicy, ensureMachine, writeAuto } from "./auto.js";
import { LOCK_TOKEN_ENV } from "./lock.js";
import { gcpCost, gcpRunningHourly, scalewayCost } from "./cost.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import { shJoin } from "./exec.js";
import { gcpInstanceCreateArgs } from "./gcp.js";
import { macSetupCommand, scalewayCheapestLine, sudoersInstallCommand } from "./scaleway.js";
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

/** Answers the destroy question: yes. */
const yes = async () => true;

async function fakeIo(
  handler: Handler,
  opts: { targets?: string[]; createRunning?: boolean; healthy?: () => boolean; localWorker?: boolean; ignoreSigterm?: boolean; starts?: Record<number, number> } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "td-machine-"));
  const calls: Call[] = [];
  const spawned: string[][] = [];
  const spawnEnv: Array<Record<string, string>> = [];
  const killed: Array<[number, string]> = [];
  const progress: string[] = [];
  let clock = Date.parse("2026-11-09T10:00:00Z");
  /** The fake background create (pid 4242) runs while this is true. */
  const state = { createRunning: opts.createRunning === true };
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
    spawnCreate: async (args: string[], _log: string, env: Record<string, string>) => {
      spawned.push(args);
      spawnEnv.push(env);
      return 4242;
    },
    alive: (pid: number) => pid === 1000 || (pid === 4242 && state.createRunning),
    processStart: async (pid: number) => opts.starts?.[pid],
    kill: (pid: number, signal: NodeJS.Signals) => {
      killed.push([pid, signal]);
      if (pid === 4242 && !opts.ignoreSigterm) state.createRunning = false;
      return true;
    },
    proc: { pid: 1000, startedAt: clock },
    localWorker: async () => opts.localWorker === true,
    healthz: async () => opts.healthy?.() ?? true,
  };
  return { io, calls, progress, home, spawned, spawnEnv, killed, state };
}

/** The hook input the SDK passes when no connect target serves the platform. */
const noTarget = (platform: "android" | "ios"): MachineAutoInput => ({ platform, reason: "no-target", provider: "self-hosted", targets: [], localWorker: false });

const has = (call: Call, ...parts: string[]) => parts.every((p) => call.args.includes(p));
const flat = (calls: Call[]) => calls.map((c) => [c.file, ...c.args].join(" ")).join("\n");

/** A healthy Google Cloud project, as gcloud would answer (mocked). */
function gcloudOk(state: { vm?: boolean; failSetup?: boolean; labelled?: boolean; leftover?: string; foreign?: string } = {}): Handler {
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
      if (!created.has(`${kind} ${name}`) && !state.vm) return { code: 1, stderr: `ERROR: (gcloud) resource ${name} was not found` };
      // Network, subnet and firewall rule carry tapdance-machine=<name> in their description.
      const machine = name.replace(/^tapdance-/, "").replace(/-iap-ssh$/, "");
      return { stdout: state.foreign === kind ? "made by someone else" : `tapdance-machine=${machine}` };
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
    const d = await machineDestroy(io, "android", true, yes);
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
    const d = await machineDestroy(io, "android", true, yes);
    expect(d.removed).toContain("Tailscale: the machine had not joined your tailnet, nothing to remove");
    expect(d.notes).toEqual([]);
  });

  it("refuses a VM that is not labelled as this machine", async () => {
    const { io } = await fakeIo(gcloudOk({ vm: true, labelled: false }));
    await io.store.save({ version: 1, name: "android", cloud: "gcp", createdAt: "2026-11-09T10:00:00Z", project: "my-project", zone: "us-central1-a", machineType: "n2-standard-4", resourceName: "tapdance-android", label: "l", target: "android", tailscaleHostname: "tapdance-android", setupRef: "v0.2.0", done: ["vm"], timings: {} });
    await expect(machineDestroy(io, "android", true, yes)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reports a leftover of this machine and keeps its record", async () => {
    const { io } = await fakeIo(gcloudOk({ vm: true, leftover: "tapdance-android us-central1-a STOPPING tapdance-machine=android\n" }));
    await io.store.save({ version: 1, name: "android", cloud: "gcp", createdAt: "2026-11-09T10:00:00Z", project: "my-project", zone: "us-central1-a", machineType: "n2-standard-4", resourceName: "tapdance-android", label: "l", target: "android", tailscaleHostname: "tapdance-android", setupRef: "v0.2.0", done: ["vm"], timings: {} });
    const d = await machineDestroy(io, "android", true, yes);
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
function scwOk(state: { deletableAt?: string; failSetup?: boolean; failAutoLogin?: boolean; rented?: boolean } = {}): Handler {
  let rented = state.rented === true;
  const server = { id: "srv-1", name: "tapdance-ios", type: "M1-M", status: "ready", ip: "51.0.0.1", ssh_username: "m1", sudo_password: MAC_PW, created_at: "2026-11-09T10:00:00Z", deletable_at: state.deletableAt ?? "2026-11-10T10:00:00Z", vnc_url: "vnc://m1:secret@51.0.0.1" };
  return (c) => {
    if (c.file === "/usr/bin/tailscale") return { stdout: JSON.stringify({ BackendState: "Running", CertDomains: ["x"] }) };
    if (c.file === "node") return { stdout: JSON.stringify(c.args.includes("connect") ? { ok: true, checks: [] } : {}) };
    if (c.file === "ssh-keygen") return {};
    if (c.file === "scp") return {};
    if (c.file === "ssh") {
      const cmd = c.args[c.args.length - 1]!;
      if (cmd === "who") return { stdout: "m1  console  Nov  9 10:05\n" };
      if (cmd.includes("tapdance-auto-login.sh") && state.failAutoLogin) return { code: 1, stderr: "auto-login broke" };
      if (cmd.includes("host-setup.sh")) return state.failSetup ? { code: 1, stderr: "boom" } : { stdout: "TAPDANCE HOST READY" };
      if (cmd.includes("host status --json")) return { stdout: JSON.stringify({ ready: true, endpoint: "https://tapdance-ios.tail1234.ts.net:4720" }) };
      if (cmd.startsWith("cat ")) return { stdout: TOKEN };
      return {};
    }
    if (c.file !== "scw") return undefined;
    if (has(c, "server-type", "list")) return { stdout: JSON.stringify([{ name: "M1-M", stock: "available" }]) };
    if (has(c, "ssh-key", "create")) return { stdout: JSON.stringify({ id: "key-1" }) };
    if (has(c, "server", "create")) {
      rented = true;
      return { stdout: JSON.stringify({ ...server, status: "starting", ip: "" }) };
    }
    if (has(c, "server", "get")) return { stdout: JSON.stringify(server) };
    if (has(c, "server", "list")) return { stdout: JSON.stringify([...(rented ? [server] : []), { ...server, id: "srv-2", name: "my-own-mac" }]) };
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
    const record = await machineCreate(io, { cloud: "scaleway", yes: true, new: true }, ["--with-gh"], false);
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
    // The NOPASSWD rule is removed right after the auto-login step, and again after setup.
    const REMOVE = "sudo -n rm -f /etc/sudoers.d/tapdance-setup /etc/sudoers.d/tapdance-setup.new";
    expect(last.indexOf(REMOVE)).toBeGreaterThan(last.findIndex((x) => x.includes("tapdance-auto-login.sh")));
    expect(last.indexOf(REMOVE)).toBeLessThan(last.findIndex((x) => x.includes("host-setup.sh")));
    expect(last.lastIndexOf(REMOVE)).toBeGreaterThan(last.findIndex((x) => x.includes("host-setup.sh")));
    const saved = await readFile(join(io.store.dir("ios"), "machine.json"), "utf8");
    expect(saved).not.toContain(MAC_PW);
    expect(saved).not.toContain("vnc");
  });

  it("removes the setup's sudo rule even when setup fails", async () => {
    const { io, calls } = await fakeIo(scwOk({ failSetup: true }));
    await writeKeyStub(io, "ios");
    await expect(machineCreate(io, { cloud: "scaleway", yes: true, new: true }, [], false)).rejects.toThrow(/Step 5 of 6/);
    expect(calls.filter((c) => c.file === "ssh").some((c) => c.args.at(-1)!.startsWith("sudo -n rm -f /etc/sudoers.d/tapdance-setup"))).toBe(true);
  });

  it("refuses stop and start, explaining the billing", async () => {
    const { io } = await fakeIo(scwOk());
    await writeKeyStub(io, "ios");
    await machineCreate(io, { cloud: "scaleway", yes: true, new: true }, [], false);
    await expect(machineStop(io, "ios", false)).rejects.toMatchObject({ code: "NOT_SUPPORTED", hint: expect.stringContaining("also while it is switched off") });
  });

  it("schedules deletion before the 24 hours are up, and leaves other Macs alone", async () => {
    const { io, calls } = await fakeIo(scwOk({ deletableAt: "2026-11-10T10:00:00Z" }));
    await writeKeyStub(io, "ios");
    await machineCreate(io, { cloud: "scaleway", yes: true, new: true }, [], false);
    const d = await machineDestroy(io, "ios", true, yes);
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
    await machineCreate(io, { cloud: "scaleway", yes: true, new: true }, [], false);
    await machineDestroy(io, "ios", true, yes);
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
  const androidRecord = (extra: Partial<MachineRecord> = {}): MachineRecord => ({
    version: 1, name: "android", cloud: "gcp", createdAt: "2026-11-01T10:00:00Z", project: "my-project", zone: "us-central1-a", machineType: "n2-standard-4", resourceName: "tapdance-android", label: "l", target: "android", tailscaleHostname: "tapdance-android", setupRef: "v0.2.0", endpoint: ENDPOINT, done: ["apis", "network", "vm", "ssh", "setup", "connect"], timings: {}, ...extra,
  });

  it("needs --accept-mac-day before it may rent Macs, and builds the create command from the policy", () => {
    expect(() => autoPolicyFrom({ platform: "ios" }, parsers, new Date())).toThrow(/at least 24 hours/);
    const { policy } = autoPolicyFrom({ platform: "android", project: "my-project", deleteAfterDays: "7" }, parsers, new Date());
    expect(createArgs(policy)).toEqual(["machine", "create", "--cloud", "gcp", "--name", "android", "--yes", "--project", "my-project", "--idle-stop", "30", "--max-hours", "8"]);
    expect(() => autoPolicyFrom({ platform: "ios", acceptMacDay: true, deleteAfterDays: "2" }, parsers, new Date())).toThrow(/for Android/);
    expect(() => autoPolicyFrom({ platform: "android", cloud: "scaleway" }, parsers, new Date())).toThrow(/--cloud gcp/);
    // Without --type, auto mode rents the cheapest Mac in stock, and says so (not the M1-M price).
    const ios = autoPolicyFrom({ platform: "ios", acceptMacDay: true }, parsers, new Date()).policy;
    expect(describePolicy("ios", ios)).toContain("the cheapest Mac mini in stock");
    expect(scalewayCheapestLine()).toMatch(/cheapest Mac mini in stock when it rents: EUR 2\.64 to 11\.76 a day before VAT/);
    expect(describePolicy("android", policy)).toMatch(/reminded to destroy it \(nothing is deleted automatically\)/);
  });

  it("creates a missing machine in the background, holding its lock, and answers with a retryable error", async () => {
    const { io, spawned, spawnEnv } = await fakeIo(gcloudOk());
    await writeAuto(io, { android: autoPolicyFrom({ platform: "android", project: "my-project" }, parsers, io.now()).policy });
    const err = (await ensureMachine(io, noTarget("android"), () => undefined).catch((e: unknown) => e)) as TapdanceError;
    expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(err.message).toMatch(/Creating machine android for android/);
    // The agent cannot run destroy (it asks a person): the hint says the person runs it in a terminal.
    expect(err.hint).toMatch(/the person runs `tapdance machine destroy android` in a terminal: it asks first, stops this create/);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain("--yes");
    // The lock names the background create, and the token that lets it take the lock over.
    const lock = JSON.parse(await readFile(join(io.store.dir("android"), "create.lock"), "utf8")) as { pid: number; role: string; token: string };
    expect(lock).toMatchObject({ pid: 4242, role: "create" });
    expect(spawnEnv[0]![LOCK_TOKEN_ENV]).toBe(lock.token);
  });

  it("does not start a second create while one runs, and shows the Tailscale link from the setup log", async () => {
    const { io, spawned } = await fakeIo(gcloudOk(), { createRunning: true });
    await writeAuto(io, { android: autoPolicyFrom({ platform: "android", project: "my-project" }, parsers, io.now()).policy });
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(io.store.dir("android"), { recursive: true });
    await writeFile(join(io.store.dir("android"), "create.lock"), JSON.stringify({ pid: 4242, role: "create", since: "2026-11-09T09:59:00Z" }));
    await writeFile(join(io.store.dir("android"), "setup.log"), "To authenticate, visit:\n\thttps://login.tailscale.com/a/xyz789\n");
    const err = (await ensureMachine(io, noTarget("android"), () => undefined).catch((e: unknown) => e)) as TapdanceError;
    expect(err.message).toMatch(/Still creating/);
    expect(err.hint).toContain("https://login.tailscale.com/a/xyz789");
    expect(spawned).toHaveLength(0);
  });

  it("does not respawn a failed background create on every lease: once per 10 minutes, saying why", async () => {
    const { io, spawned, state } = await fakeIo(gcloudOk());
    await writeAuto(io, { android: autoPolicyFrom({ platform: "android", project: "my-project" }, parsers, io.now()).policy });
    await ensureMachine(io, noTarget("android"), () => undefined).catch(() => undefined);
    expect(spawned).toHaveLength(1);
    // The background create failed: its process is gone, and its log says why.
    state.createRunning = false;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(io.store.dir("android"), "auto-create.log"), `[3/6] failed after 12 s\nError: Google Cloud refused the VM: Quota 'N2_CPUS' exceeded ${TOKEN}\n`);
    const err = (await ensureMachine(io, noTarget("android"), () => undefined).catch((e: unknown) => e)) as TapdanceError;
    expect(spawned).toHaveLength(1);
    expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(err.message).toMatch(/stopped before it finished.*tries again no sooner than/s);
    expect(err.message).toContain("N2_CPUS");
    expect(err.message).not.toContain(TOKEN);
    expect(err.hint).toContain("tapdance machine create --cloud gcp --name android --project my-project");
    // Ten minutes later it may try again.
    await io.sleep(10 * 60_000);
    await ensureMachine(io, noTarget("android"), () => undefined).catch(() => undefined);
    expect(spawned).toHaveLength(2);
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
    await io.store.save(androidRecord());
    await writeAuto(io, { android: autoPolicyFrom({ platform: "android", project: "my-project" }, parsers, io.now()).policy });
    const r = await ensureMachine(io, { platform: "android", reason: "unreachable", error: new TapdanceError("PROVIDER_UNREACHABLE", "target android does not answer"), provider: "self-hosted", targets: [{ name: "android", endpoint: ENDPOINT }], localWorker: false, failedTarget: "android" }, () => undefined);
    expect(r.notice).toMatch(/Started machine android for this lease/);
    expect(calls.some((c) => has(c, "instances", "start", "tapdance-android"))).toBe(true);
  });

  // #167, reproduced from the 2026-11-09 VPS run: an old Mac connect target with no platform list was
  // offline, the android machine was stopped, and auto mode backed off instead of starting it.
  // Fixed in #170.
  it("#167: starts its stopped machine when the other target is an offline host with no platform list", async () => {
    let started = false;
    const handler: Handler = (c) => {
      if (c.file === "gcloud" && has(c, "instances", "describe")) return { stdout: JSON.stringify({ name: "tapdance-android", zone: "z/us-central1-a", status: started ? "RUNNING" : "TERMINATED", machineType: "m/n2-standard-4", creationTimestamp: "2026-11-01T10:00:00Z", labels: { "tapdance-machine": "android" } }) };
      if (c.file === "gcloud" && has(c, "instances", "start")) started = true;
      return gcloudOk({ vm: true })(c);
    };
    const { io, calls } = await fakeIo(handler, { healthy: () => started });
    await io.store.save(androidRecord());
    await writeAuto(io, { android: autoPolicyFrom({ platform: "android", project: "my-project" }, parsers, io.now()).policy });
    const OLD_MAC = "https://old-mac.tail1234.ts.net:4720";
    // The error RoutingProvider.lease throws when both hosts time out; the SDK names its first target as failedTarget.
    const error = new TapdanceError("PROVIDER_UNREACHABLE", `Cannot lease android: target old-mac (${OLD_MAC}) does not answer (The operation was aborted due to timeout); nor does android`, {
      details: { platform: "android", target: "old-mac", endpoint: OLD_MAC, down: ["old-mac", "android"], up: [] },
    });
    const input: MachineAutoInput = { platform: "android", reason: "unreachable", error, provider: "self-hosted", targets: [{ name: "old-mac", endpoint: OLD_MAC }, { name: "android", endpoint: ENDPOINT, platforms: ["android"] }], localWorker: false, failedTarget: "old-mac" };
    const r = await ensureMachine(io, input, () => undefined);
    expect(r.notice).toMatch(/Started machine android for this lease/);
    expect(calls.some((c) => has(c, "instances", "start", "tapdance-android"))).toBe(true);
  });

  it("creates nothing when the lease failed on a host that answered (an unknown model on its own machine)", async () => {
    const { io, calls, spawned } = await fakeIo(gcloudOk({ vm: true }));
    await io.store.save(androidRecord());
    await writeAuto(io, { android: autoPolicyFrom({ platform: "android", project: "my-project" }, parsers, io.now()).policy });
    const unknownModel = new TapdanceError("DEVICE_UNAVAILABLE", "UNKNOWN_MODEL: no Pixel 99 on this worker");
    const input: MachineAutoInput = { platform: "android", reason: "unreachable", error: unknownModel, provider: "self-hosted", targets: [{ name: "android", endpoint: ENDPOINT }], localWorker: false, failedTarget: "android" };
    await expect(ensureMachine(io, input, () => undefined)).rejects.toBe(unknownModel);
    expect(spawned).toHaveLength(0);
    expect(calls.some((c) => c.args.includes("start") || c.args.includes("create"))).toBe(false);
  });

  it("creates nothing when another host of the person's serves the platform, even if it is down", async () => {
    const { io, spawned } = await fakeIo(gcloudOk());
    await writeAuto(io, { android: autoPolicyFrom({ platform: "android", project: "my-project" }, parsers, io.now()).policy });
    const down = new TapdanceError("PROVIDER_UNREACHABLE", "Cannot lease android: target kvm does not answer", { details: { target: "kvm" } });
    const viaRouting = new TapdanceError("DEVICE_UNAVAILABLE", 'No connect target can lease android "Pixel 99": kvm has no such model', { details: { skipped: ["kvm has no such model"], unserved: [] } });
    for (const error of [down, viaRouting]) {
      const input: MachineAutoInput = { platform: "android", reason: "unreachable", error, provider: "self-hosted", targets: [{ name: "kvm", endpoint: "https://kvm.tail1234.ts.net:4720" }], localWorker: false, failedTarget: "kvm" };
      await expect(ensureMachine(io, input, () => undefined)).rejects.toBe(error);
    }
    // A local worker serves it too.
    const local = new TapdanceError("DEVICE_UNAVAILABLE", "RUNTIME_MISSING: no Android image");
    await expect(ensureMachine(io, { platform: "android", reason: "unreachable", error: local, provider: "local", targets: [], localWorker: true }, () => undefined)).rejects.toBe(local);
    expect(spawned).toHaveLength(0);
  });

  it("creates a machine when no host serves the platform at all", async () => {
    const { io, spawned } = await fakeIo(scwOk());
    await writeAuto(io, { ios: { cloud: "scaleway", name: "ios", acceptMacDay: true, enabledAt: "x" } });
    // An Android-only host answered; nothing serves iOS.
    const error = new TapdanceError("DEVICE_UNAVAILABLE", "No connect target can lease ios: kvm serves android", { details: { skipped: ["kvm serves android"], unserved: ["kvm"] } });
    const input: MachineAutoInput = { platform: "ios", reason: "unreachable", error, provider: "self-hosted", targets: [{ name: "kvm", endpoint: "https://kvm.tail1234.ts.net:4720" }], localWorker: false };
    // The project has a Mac of the person's (my-own-mac): auto mode refuses to rent next to it.
    await expect(ensureMachine(io, input, () => undefined)).rejects.toMatchObject({ hint: expect.stringContaining("--server-id") });
    const empty = await fakeIo((c) => (c.file === "scw" && has(c, "server", "list") ? { stdout: "[]" } : scwOk()(c)));
    await writeAuto(empty.io, { ios: { cloud: "scaleway", name: "ios", acceptMacDay: true, enabledAt: "x" } });
    await expect(ensureMachine(empty.io, input, () => undefined)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: expect.stringMatching(/Creating machine ios/) });
    expect(empty.spawned).toHaveLength(1);
    expect(spawned).toHaveLength(0);
    expect(autoDecision(noTarget("android"), undefined)).toBe("provision");
  });

  // #167: an offline connect target with no platform list must not stop auto mode starting its own machine.
  it("starts its own stopped machine even when another target is down, and creates nothing for a refusal", () => {
    const targets = [{ name: "old-mac", endpoint: "https://old.tail1.ts.net:4720" }, { name: "android", endpoint: "https://a.tail1.ts.net:4720", platforms: ["android" as const] }];
    const bothDown = new TapdanceError("PROVIDER_UNREACHABLE", "Cannot lease android: target old-mac does not answer; nor does android", { details: { target: "old-mac", down: ["old-mac", "android"] } });
    const base = { platform: "android" as const, reason: "unreachable" as const, provider: "self-hosted", targets, localWorker: false };
    expect(autoDecision({ ...base, error: bothDown, failedTarget: "old-mac" }, "android")).toBe("provision");
    // The own machine answers; only the old Mac is down: nothing to start, and nothing is created.
    const otherDown = new TapdanceError("PROVIDER_UNREACHABLE", "Cannot lease android: target old-mac does not answer", { details: { target: "old-mac", down: ["old-mac"] } });
    expect(autoDecision({ ...base, error: otherDown, failedTarget: "old-mac" }, "android")).toBe("rethrow");
    // The own machine answered and refused (no such model): rethrown, never provisioned.
    const refused = new TapdanceError("DEVICE_UNAVAILABLE", "No connect target that answered can lease android \"Pixel 99\"", { details: { down: ["old-mac"] } });
    expect(autoDecision({ ...base, error: refused }, "android")).toBe("rethrow");
    expect(autoDecision({ ...base, error: refused, failedTarget: "android" }, "android")).toBe("rethrow");
  });

  it("only reminds about an Android machine stopped longer than --delete-after-days: it deletes nothing", async () => {
    const make = (stoppedAt: string) => (c: Call) => {
      if (c.file === "gcloud" && has(c, "instances", "describe")) return { stdout: JSON.stringify({ name: "tapdance-android", zone: "z", status: "TERMINATED", machineType: "m/n2-standard-4", creationTimestamp: "2026-10-01T10:00:00Z", lastStopTimestamp: stoppedAt, labels: { "tapdance-machine": "android" } }) };
      return gcloudOk({ vm: true })(c);
    };
    for (const [stoppedAt, remind] of [["2026-11-08T10:00:00Z", false], ["2026-10-20T10:00:00Z", true]] as const) {
      const { io, calls } = await fakeIo(make(stoppedAt));
      await io.store.save(androidRecord({ createdAt: "2026-10-01T10:00:00Z", done: ["vm", "connect"], diskGb: 64 }));
      await writeAuto(io, { android: autoPolicyFrom({ platform: "android", project: "my-project", deleteAfterDays: "7" }, parsers, io.now()).policy });
      const msgs = await autoHousekeeping(io);
      expect(calls.some((c) => c.args.includes("delete"))).toBe(false);
      expect(await io.store.get("android")).toBeDefined();
      expect(msgs.length > 0).toBe(remind);
      if (remind) expect(msgs[0]).toBe("Machine android has been stopped 20 days (limit 7); its disk bills about USD 6.40 a month. Remove it with `tapdance machine destroy android`.");
    }
  });

  it("makes a vanished VM again in its own network without deleting anything", async () => {
    const { io, calls, spawned } = await fakeIo(gcloudOk());
    await io.store.save(androidRecord({ tailscaleHostname: "tapdance-android-1" }));
    await writeAuto(io, { android: autoPolicyFrom({ platform: "android", project: "my-project" }, parsers, io.now()).policy });
    await expect(ensureMachine(io, noTarget("android"), () => undefined)).rejects.toMatchObject({ message: expect.stringMatching(/Creating machine android/) });
    expect(calls.some((c) => c.args.includes("delete"))).toBe(false);
    expect(spawned).toHaveLength(1);
    expect(await io.store.get("android")).toMatchObject({ done: ["apis", "network"], tailscaleHostname: "tapdance-android" });
  });

  it("refuses to rent a new Mac after the old one is gone unless the day was accepted, and frees its target name first", async () => {
    const { io, spawned, calls } = await fakeIo((c) => (c.file === "scw" && has(c, "server", "get") ? { code: 1, stderr: "404 not found" } : c.file === "scw" && has(c, "server", "list") ? { stdout: "[]" } : scwOk()(c)));
    await io.store.save({ version: 1, name: "ios", cloud: "scaleway", createdAt: "2026-11-08T10:00:00Z", zone: "fr-par-3", machineType: "M1-M", resourceName: "tapdance-ios", label: "l", target: "ios", tailscaleHostname: "tapdance-ios", setupRef: "v0.2.0", serverId: "srv-1", done: ["connect"], timings: {} });
    await writeAuto(io, { ios: { cloud: "scaleway", name: "ios", enabledAt: "x" } });
    await expect(ensureMachine(io, noTarget("ios"), () => undefined)).rejects.toThrow(/may not rent a new one/);
    await writeAuto(io, { ios: { cloud: "scaleway", name: "ios", acceptMacDay: true, enabledAt: "x" } });
    await expect(ensureMachine(io, noTarget("ios"), () => undefined)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(spawned).toHaveLength(1);
    // The old Mac's connect target is removed, or the new create would refuse the taken name.
    expect(calls.some((c) => c.file === "node" && has(c, "disconnect", "ios"))).toBe(true);
  });

  it("does not rent a Mac in the background when the project already has one of the person's", async () => {
    const { io, spawned } = await fakeIo((c) => (c.file === "scw" && has(c, "server", "get") ? { code: 1, stderr: "404 not found" } : scwOk()(c)));
    await writeAuto(io, { ios: { cloud: "scaleway", name: "ios", acceptMacDay: true, enabledAt: "x" } });
    await expect(ensureMachine(io, noTarget("ios"), () => undefined)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", hint: expect.stringContaining("--server-id") });
    expect(spawned).toHaveLength(0);
  });
});

describe("Scaleway zones, offers and a Mac you rented (mocked scw and ssh)", () => {
  /** An account with one Mac the person rented in fr-par-1, and stock per zone. */
  function account(opts: { sshDenied?: boolean } = {}): Handler {
    const mine = { id: "5b6b4f7c-0000-4000-8000-00000000c0de", name: "apple-silicon-wizardly-shirley", type: "M2-L", status: "ready", ip: "62.0.0.9", ssh_username: "m1", sudo_password: MAC_PW, created_at: "2026-11-09T14:39:00Z", deletable_at: "2026-11-10T14:39:00Z", zone: "fr-par-1" };
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
      if (has(c, "server", "get")) return zone === "fr-par-1" && c.args.includes("5b6b4f7c-0000-4000-8000-00000000c0de") ? { stdout: JSON.stringify(mine) } : { code: 1, stderr: "404 not found" };
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
    const record = await machineCreate(io, { cloud: "scaleway", serverId: "5b6b4f7c-0000-4000-8000-00000000c0de", yes: true }, [], false);
    expect(record).toMatchObject({ adopted: true, serverId: "5b6b4f7c-0000-4000-8000-00000000c0de", zone: "fr-par-1", machineType: "M2-L", resourceName: "apple-silicon-wizardly-shirley" });
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

  it("does not rent another Mac when the project already has one, and finds it by name", async () => {
    const { io, calls } = await fakeIo(account());
    await expect(machineCreate(io, { cloud: "scaleway", yes: true }, [], false)).rejects.toMatchObject({ code: "USAGE", hint: expect.stringContaining("--server-id 5b6b4f7c-0000-4000-8000-00000000c0de") });
    expect(calls.some((c) => has(c, "server", "create"))).toBe(false);
    const { Scaleway } = await import("./scaleway.js");
    expect((await new Scaleway(io, undefined).findServer("apple-silicon-wizardly-shirley"))?.id).toBe("5b6b4f7c-0000-4000-8000-00000000c0de");
  });

  it("refuses an id that is not in the project", async () => {
    const { io } = await fakeIo(account());
    await expect(machineCreate(io, { cloud: "scaleway", serverId: "nope", yes: true }, [], false)).rejects.toThrow(/No Mac mini nope/);
  });
});

describe("machine destroy always asks a person (mocked gcloud)", () => {
  it("refuses --yes, refuses without a terminal, and a no answer deletes nothing", async () => {
    const { io, calls } = await fakeIo(gcloudOk());
    await machineCreate(io, { cloud: "gcp", yes: true }, [], false);
    const before = calls.length;
    await expect(machineDestroy(io, "android", true, yes, { yes: true })).rejects.toMatchObject({ code: "USAGE", message: "destroy always asks for confirmation; --yes is not accepted", hint: expect.stringContaining("in a terminal") });
    let asked = 0;
    const no = async () => {
      asked++;
      return false;
    };
    await expect(machineDestroy(io, "android", false, no)).rejects.toMatchObject({ code: "USAGE", message: "destroy asks you at a terminal", hint: "Run `tapdance machine destroy android` yourself in a terminal." });
    expect(asked).toBe(0);
    await expect(machineDestroy(io, "android", true, no)).rejects.toMatchObject({ code: "USAGE", message: "Cancelled; nothing was changed" });
    expect(asked).toBe(1);
    // Nothing ran against the cloud or this computer's targets, and the record is still there.
    expect(calls.length).toBe(before);
    expect(await io.store.get("android")).toBeDefined();
    expect(await io.store.destroyingPid("android")).toBeUndefined();
  });

  it("stops a create that is still running before it removes anything", async () => {
    const { io, killed, calls } = await fakeIo(gcloudOk(), { createRunning: true });
    await machineCreate(io, { cloud: "gcp", yes: true }, [], false);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(io.store.dir("android"), "create.lock"), JSON.stringify({ pid: 4242, role: "create", since: "x" }));
    const d = await machineDestroy(io, "android", true, yes);
    expect(killed).toEqual([[4242, "SIGTERM"]]);
    expect(d.clean).toBe(true);
    expect(calls.some((c) => has(c, "instances", "delete", "tapdance-android"))).toBe(true);
  });

  it("refuses when the running create does not stop, and deletes nothing", async () => {
    const { io, calls } = await fakeIo(gcloudOk(), { createRunning: true, ignoreSigterm: true });
    await machineCreate(io, { cloud: "gcp", yes: true }, [], false);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(io.store.dir("android"), "create.lock"), JSON.stringify({ pid: 4242, role: "create", since: "x" }));
    await expect(machineDestroy(io, "android", true, yes)).rejects.toMatchObject({ code: "TIMEOUT", message: expect.stringContaining("nothing was destroyed") });
    expect(calls.some((c) => c.args.includes("delete"))).toBe(false);
    expect(await io.store.destroyingPid("android")).toBeUndefined();
  });

  it("a create stops before its next step while the machine is being destroyed", async () => {
    const { io, calls } = await fakeIo(gcloudOk());
    await io.store.save({ version: 1, name: "android", cloud: "gcp", createdAt: "2026-11-09T10:00:00Z", project: "my-project", zone: "us-central1-a", machineType: "n2-standard-4", resourceName: "tapdance-android", label: "l", target: "android", tailscaleHostname: "tapdance-android", setupRef: "", tapdanceVersion: "0.2.1", done: ["apis", "network"], timings: {} });
    // A destroy that runs (pid 1000 is alive in the fake) marked the machine.
    await io.store.markDestroying("android", 1000);
    await expect(machineCreate(io, { cloud: "gcp", yes: true }, [], false)).rejects.toMatchObject({ code: "CANCELLED", message: expect.stringMatching(/being destroyed/) });
    expect(calls.some((c) => has(c, "instances", "create"))).toBe(false);
  });
});

describe("create lock and record saves (mocked gcloud)", () => {
  const lockAt = async (io: MachineIo, lock: object) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(io.store.dir("android"), { recursive: true });
    await writeFile(join(io.store.dir("android"), "create.lock"), JSON.stringify(lock));
  };

  it("refuses a second create while a live one holds the lock", async () => {
    const { io, calls } = await fakeIo(gcloudOk(), { createRunning: true });
    await lockAt(io, { pid: 4242, role: "create", since: "2026-11-09T09:00:00Z" });
    await expect(machineCreate(io, { cloud: "gcp", yes: true }, [], false)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: expect.stringMatching(/being created by another process \(pid 4242/) });
    expect(calls.some((c) => c.file === "gcloud")).toBe(false);
  });

  it("takes over a stale lock: a dead pid, or a live pid that started at another time (reused)", async () => {
    const dead = await fakeIo(gcloudOk());
    await lockAt(dead.io, { pid: 4242, role: "create", since: "x" });
    expect((await machineCreate(dead.io, { cloud: "gcp", yes: true }, [], false)).done).toContain("connect");
    const reused = await fakeIo(gcloudOk(), { createRunning: true, starts: { 4242: Date.parse("2026-11-09T12:00:00Z") } });
    await lockAt(reused.io, { pid: 4242, startedAt: Date.parse("2026-11-08T12:00:00Z"), role: "create", since: "x" });
    expect((await machineCreate(reused.io, { cloud: "gcp", yes: true }, [], false)).done).toContain("connect");
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(reused.io.store.dir("android"), "create.lock"))).toBe(false);
  });

  it("lets the background create take over the lock its spawner holds, by token", async () => {
    const { io } = await fakeIo(gcloudOk(), { createRunning: true });
    await lockAt(io, { pid: 4242, role: "create", token: "tok-123", since: "x" });
    io.env = { ...io.env, [LOCK_TOKEN_ENV]: "tok-123" };
    expect((await machineCreate(io, { cloud: "gcp", yes: true }, [], false)).done).toContain("connect");
  });

  it("saves records atomically, also when several saves race", async () => {
    const { io } = await fakeIo(gcloudOk());
    const base: MachineRecord = { version: 1, name: "android", cloud: "gcp", createdAt: "x", zone: "z", machineType: "m", resourceName: "tapdance-android", label: "l", target: "android", tailscaleHostname: "t", setupRef: "", done: [], timings: {} };
    await Promise.all(Array.from({ length: 20 }, (_, i) => io.store.save({ ...base, done: Array.from({ length: i }, (__, j) => `step-${j}`) })));
    const saved = await io.store.get("android");
    expect(saved?.name).toBe("android");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(io.store.dir("android"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to create or turn auto mode on when this computer uses its own local worker", async () => {
    const { io, calls } = await fakeIo(gcloudOk(), { localWorker: true });
    await expect(machineCreate(io, { cloud: "gcp", yes: true }, [], false)).rejects.toMatchObject({ code: "USAGE", hint: expect.stringContaining("tapdance config set provider self-hosted --global") });
    await expect(refuseLocalWorker(io)).rejects.toMatchObject({ code: "USAGE" });
    expect(calls.some((c) => c.file === "gcloud")).toBe(false);
  });
});

describe("Google Cloud resources are matched exactly (mocked gcloud)", () => {
  it("does not count machine android-2's resources as android's", async () => {
    const lists: Record<string, string> = {
      instances: "tapdance-android-2 us-central1-a RUNNING created-by=tapdance;tapdance-machine=android-2\n",
      "firewall-rules": "default-allow-ssh\ntapdance-android-2-iap-ssh\n",
      networks: "default\ntapdance-android-2\n",
      disks: "tapdance-android-2 us-central1-a 64\n",
    };
    const { io } = await fakeIo((c) => {
      if (c.file !== "gcloud" || !c.args.includes("list")) return undefined;
      return { stdout: lists[c.args[1]!] ?? "" };
    });
    const { Gcp, gcpLeftovers } = await import("./gcp.js");
    const r = await gcpLeftovers(new Gcp(io, "my-project"), { name: "android", resourceName: "tapdance-android" });
    expect(r.ours).toEqual([]);
    expect(r.others).toEqual(["instance tapdance-android-2 us-central1-a RUNNING created-by=tapdance;tapdance-machine=android-2", "disk tapdance-android-2 us-central1-a 64"]);
    const two = await gcpLeftovers(new Gcp(io, "my-project"), { name: "android-2", resourceName: "tapdance-android-2" });
    expect(two.ours).toEqual(["instance tapdance-android-2 us-central1-a RUNNING created-by=tapdance;tapdance-machine=android-2", "disk tapdance-android-2 us-central1-a 64", "firewall rule tapdance-android-2-iap-ssh", "network tapdance-android-2"]);
  });

  it("refuses to reuse or delete a network that is not marked as this machine's", async () => {
    const { io, calls } = await fakeIo(gcloudOk({ vm: true, foreign: "compute networks" }));
    await expect(machineCreate(io, { cloud: "gcp", yes: true }, [], false)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("network tapdance-android") });
    await io.store.save({ version: 1, name: "android", cloud: "gcp", createdAt: "2026-11-09T10:00:00Z", project: "my-project", zone: "us-central1-a", machineType: "n2-standard-4", resourceName: "tapdance-android", label: "l", target: "android", tailscaleHostname: "tapdance-android", setupRef: "", done: ["vm"], timings: {} });
    await expect(machineDestroy(io, "android", true, yes)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls.some((c) => c.args.includes("delete"))).toBe(false);
  });

  it("refuses to reuse a VM of the machine's name that is not labelled as this machine", async () => {
    const { io, calls } = await fakeIo(gcloudOk({ vm: true, labelled: false }));
    await expect(machineCreate(io, { cloud: "gcp", yes: true }, [], false)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("VM tapdance-android") });
    expect(calls.some((c) => has(c, "compute", "ssh"))).toBe(false);
  });

  it("starts a VM that stopped between create runs before it uses SSH again", async () => {
    let running = false;
    const base = gcloudOk({ vm: true });
    const { io, calls } = await fakeIo((c) => {
      if (c.file === "gcloud" && has(c, "instances", "describe")) return { stdout: JSON.stringify({ name: "tapdance-android", zone: "z", status: running ? "RUNNING" : "TERMINATED", machineType: "m", creationTimestamp: "x", labels: { "tapdance-machine": "android" } }) };
      if (c.file === "gcloud" && has(c, "instances", "start")) running = true;
      return base(c);
    });
    await io.store.save({ version: 1, name: "android", cloud: "gcp", createdAt: "2026-11-09T10:00:00Z", project: "my-project", zone: "us-central1-a", machineType: "n2-standard-4", resourceName: "tapdance-android", label: "l", target: "android", tailscaleHostname: "tapdance-android", setupRef: "", tapdanceVersion: "0.2.1", done: ["apis", "network", "vm"], timings: {} });
    const record = await machineCreate(io, { cloud: "gcp", yes: true }, [], false);
    expect(record.done).toContain("connect");
    const start = calls.findIndex((c) => has(c, "instances", "start"));
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(calls.findIndex((c) => has(c, "compute", "ssh")));
  });

  it("lists every machine even when one VM's label is not a machine name", async () => {
    const { io } = await fakeIo((c) => {
      if (c.file === "gcloud" && has(c, "instances", "list")) {
        return { stdout: JSON.stringify([
          { name: "tapdance-odd", zone: "z/us-central1-a", status: "RUNNING", machineType: "m/n2-standard-4", creationTimestamp: "2026-11-09T08:00:00Z", labels: { "tapdance-machine": "Not_A_Name" } },
          { name: "tapdance-android", zone: "z/us-central1-a", status: "RUNNING", machineType: "m/n2-standard-4", creationTimestamp: "2026-11-09T08:00:00Z", labels: { "tapdance-machine": "android" } },
        ]) };
      }
      return undefined;
    });
    const { machines, warnings } = await machineList(io, { project: "my-project" });
    expect(machines.map((m) => m.name)).toEqual(["android"]);
    expect(warnings.join()).toContain("tapdance-odd");
  });
});

describe("Scaleway safety (mocked scw and ssh)", () => {
  it("adds no project ssh key that outlives the install, and lists Macs in the record's project", async () => {
    const { io, calls } = await fakeIo(scwOk());
    await writeKeyStub(io, "ios");
    const record = await machineCreate(io, { cloud: "scaleway", yes: true, new: true, project: "11111111-2222-4333-8444-555555555555" }, [], false);
    expect(calls.some((c) => has(c, "ssh-key", "delete", "key-1"))).toBe(true);
    expect(record.sshKeyId).toBeUndefined();
    // Every ssh and scp call ends its options with `--` before the destination.
    for (const c of calls.filter((x) => x.file === "ssh" || x.file === "scp")) expect(c.args).toContain("--");
    const before = calls.length;
    await machineList(io);
    expect(calls.slice(before).filter((c) => has(c, "server", "list")).every((c) => c.args.includes("project-id=11111111-2222-4333-8444-555555555555"))).toBe(true);
  });

  it("removes the NOPASSWD sudo rule when the auto-login step fails", async () => {
    const { io, calls } = await fakeIo(scwOk({ failAutoLogin: true }));
    await writeKeyStub(io, "ios");
    await expect(machineCreate(io, { cloud: "scaleway", yes: true, new: true }, [], false)).rejects.toThrow(/Step 4 of 6/);
    expect(calls.filter((c) => c.file === "ssh").at(-1)!.args.at(-1)).toBe("sudo -n rm -f /etc/sudoers.d/tapdance-setup /etc/sudoers.d/tapdance-setup.new");
  });

  it("refuses an address or user from the API that ssh could misread", async () => {
    const { sshTarget } = await import("./scaleway.js");
    expect(sshTarget({ ip: "51.0.0.1", sshUser: "m1" }).dest).toBe("m1@51.0.0.1");
    expect(sshTarget({ ip: "2001:db8::1", sshUser: "m1" }).scpHost).toBe("m1@[2001:db8::1]");
    expect(() => sshTarget({ ip: "-oProxyCommand=evil", sshUser: "m1" })).toThrow(/not an IP address/);
    expect(() => sshTarget({ ip: "51.0.0.1", sshUser: "-oProxyCommand=x" })).toThrow(/not a user name/);
  });

  it("uses a Mac an earlier run rented but did not record, instead of renting a second one; destroy finds it too", async () => {
    const { io, calls } = await fakeIo(scwOk({ rented: true }));
    await writeKeyStub(io, "ios");
    const rec: MachineRecord = { version: 1, name: "ios", cloud: "scaleway", createdAt: "2026-11-09T09:59:00Z", zone: "fr-par-3", machineType: "M1-M", resourceName: "tapdance-ios", label: "l", target: "ios", tailscaleHostname: "tapdance-ios", setupRef: "", tapdanceVersion: "0.2.1", scheduledDeletion: true, done: ["ssh-key"], timings: {} };
    await io.store.save(rec);
    const record = await machineCreate(io, { cloud: "scaleway", yes: true }, [], false);
    expect(record.serverId).toBe("srv-1");
    expect(calls.some((c) => has(c, "server", "create"))).toBe(false);
    // A record that never learned the id: destroy acts on the Mac of that exact name rented for it.
    await io.store.save({ ...rec, done: [] });
    const d = await machineDestroy(io, "ios", true, yes);
    expect(calls.some((c) => has(c, "update", "srv-1", "schedule-deletion=true"))).toBe(true);
    expect(d.record.pendingDeletionAt).toBe("2026-11-10T10:00:00Z");
  });

  it("never adopts a Mac of that name rented before the record", async () => {
    const { io, calls } = await fakeIo(scwOk({ rented: true }));
    await writeKeyStub(io, "ios");
    await io.store.save({ version: 1, name: "ios", cloud: "scaleway", createdAt: "2026-11-09T12:00:00Z", zone: "fr-par-3", machineType: "M1-M", resourceName: "tapdance-ios", label: "l", target: "ios", tailscaleHostname: "tapdance-ios", setupRef: "", tapdanceVersion: "0.2.1", scheduledDeletion: true, done: ["ssh-key"], timings: {} });
    await expect(machineCreate(io, { cloud: "scaleway", yes: true }, [], false)).rejects.toThrow(/that this machine's record did not rent/);
    expect(calls.some((c) => has(c, "server", "create"))).toBe(false);
  });

  it("schedules deletion only for Scaleway's 24-hour refusal, and shows any other delete error", async () => {
    for (const [stderr, deletableAfter, scheduled] of [
      ["permission denied: insufficient permissions", "2026-11-09T09:00:00Z", false],
      ["precondition failed: server is not deletable yet", "2026-11-09T09:00:00Z", true],
      ["some error", "2026-11-12T09:00:00Z", true],
    ] as const) {
      const base = scwOk({ deletableAt: "2026-11-09T09:00:00Z" });
      const { io, calls } = await fakeIo((c) => {
        if (c.file === "scw" && has(c, "server", "delete")) return { code: 1, stderr };
        // The read after the failed delete reports Scaleway's deletable_at then.
        if (c.file === "scw" && has(c, "server", "get") && calls.some((x) => has(x, "server", "delete"))) {
          const r = base(c)!;
          return { stdout: JSON.stringify({ ...JSON.parse(r.stdout!), deletable_at: deletableAfter }) };
        }
        return base(c);
      });
      await writeKeyStub(io, "ios");
      await machineCreate(io, { cloud: "scaleway", yes: true, new: true }, [], false);
      const result = machineDestroy(io, "ios", true, yes);
      if (scheduled) {
        await result;
        expect(calls.some((c) => has(c, "schedule-deletion=true") && calls.indexOf(c) > calls.findIndex((x) => has(x, "server", "delete")))).toBe(true);
      } else {
        await expect(result).rejects.toThrow(/insufficient permissions/);
      }
    }
  });
});

describe("the machine's endpoint", () => {
  it("accepts only an http(s) Tailscale name without user info or path", () => {
    expect(tailnetEndpoint("https://tapdance-android.tail1234.ts.net:4720/")).toBe("https://tapdance-android.tail1234.ts.net:4720");
    expect(tailnetEndpoint("http://tapdance-ios.tail1234.ts.net")).toBe("http://tapdance-ios.tail1234.ts.net");
    for (const bad of ["https://user:pw@x.tail1234.ts.net", "https://evil.example.com/.ts.net", "https://x.ts.net.evil.com", "ftp://x.tail1234.ts.net", "https://x.tail1234.ts.net/path", "https://x.tail1234.ts.net?q=1", "not a url", undefined]) {
      expect(tailnetEndpoint(bad)).toBeUndefined();
    }
  });
});
