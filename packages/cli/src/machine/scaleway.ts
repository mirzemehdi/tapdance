import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TapdanceError } from "@tapdance/sdk";
import {
  ENV_PREFIX,
  TAILSCALE_LOGOUT,
  installArgs,
  checkLocalTailscale,
  connectMachine,
  disconnectMachine,
  remoteEndpoint,
  runSteps,
  setupLineHandler,
  setupLog,
  type MachineIo,
  type Step,
} from "./common.js";
import { check, errorTail, parseJson, shJoin, type ExecResult } from "./exec.js";
import { SCALEWAY_HOURLY_EUR, scalewayCost, type CostEstimate } from "./cost.js";
import type { DestroyReport, LeftoverReport } from "./gcp.js";
import type { MachineRecord } from "./state.js";

/**
 * iOS machines on a Scaleway Mac mini, made with the user's own logged-in scw. Apple silicon servers
 * take no tags, so Tapdance's are the ones named tapdance-<name> whose id this computer recorded; list
 * and destroy act on nothing else. The Mac's sudo password comes from Scaleway's API (it is the
 * machine's password, not a cloud key): it is read into memory, sent to the Mac over ssh's standard
 * input, and never printed or stored.
 */

export const SCALEWAY_DEFAULTS = { zone: "fr-par-3", machineType: "M1-M" } as const;
/**
 * The zones Scaleway rents Mac minis in (2026-11-09). `scw ... list zone=all` does NOT include fr-par-1
 * for Apple silicon (it returned nothing while a Mac ran there), so every list asks each zone by name.
 */
export const MAC_ZONES = ["fr-par-1", "fr-par-3"] as const;
export const SCW_LOGIN_HINT = "Install the scw CLI (https://www.scaleway.com/en/docs/scaleway-cli/quickstart/) and run `scw init`. Tapdance uses your scw login and never reads or stores its keys.";
const SUDOERS = "/etc/sudoers.d/tapdance-setup";
/** Offers with 8 GB: one simulator at a time, so no warm spare (docs/ios/scaleway-mac.md). */
const SMALL_MEMORY = new Set(["M1-M"]);

export interface ScwServer {
  id: string;
  name: string;
  type: string;
  status: string;
  zone?: string;
  ip?: string;
  ssh_username?: string;
  sudo_password?: string;
  created_at?: string;
  deletable_at?: string;
  deletion_scheduled?: boolean;
  project_id?: string;
}

export class Scaleway {
  constructor(
    private readonly io: MachineIo,
    readonly project: string | undefined,
  ) {}

  scw(args: string[], options: { timeoutMs?: number } = {}): Promise<ExecResult> {
    return this.io.exec("scw", [...args, "-o", "json"], { timeoutMs: 300_000, ...options });
  }

  private projectArg(): string[] {
    return this.project ? [`project-id=${this.project}`] : [];
  }

  async server(id: string, zone: string): Promise<ScwServer | undefined> {
    const r = await this.scw(["apple-silicon", "server", "get", id, `zone=${zone}`], { timeoutMs: 60_000 });
    if (r.code !== 0) {
      if (/not found|404/i.test(r.stderr)) return undefined;
      check(r, "scw apple-silicon server get", SCW_LOGIN_HINT);
    }
    return parseJson<ScwServer>(r.stdout, "scw apple-silicon server get");
  }

  /** Every Mac in the project, asking each Mac zone by name (and any extra zone given). */
  async listServers(extraZones: string[] = []): Promise<ScwServer[]> {
    const zones = [...new Set([...MAC_ZONES, ...extraZones])];
    const all: ScwServer[] = [];
    for (const zone of zones) {
      const r = check(await this.scw(["apple-silicon", "server", "list", `zone=${zone}`, ...this.projectArg()], { timeoutMs: 120_000 }), `scw apple-silicon server list zone=${zone}`, SCW_LOGIN_HINT);
      for (const s of parseJson<ScwServer[]>(r.stdout || "[]", "scw apple-silicon server list") ?? []) all.push({ ...s, zone: s.zone ?? zone });
    }
    return all;
  }

  /** Finds a Mac by id in any Mac zone. */
  async findServer(id: string, zone?: string): Promise<ScwServer | undefined> {
    for (const z of zone ? [zone] : MAC_ZONES) {
      const s = await this.server(id, z);
      if (s) return { ...s, zone: s.zone ?? z };
    }
    return undefined;
  }

  async createKey(name: string, publicKey: string): Promise<string> {
    const r = check(await this.scw(["iam", "ssh-key", "create", `name=${name}`, `public-key=${publicKey}`, ...this.projectArg()]), "scw iam ssh-key create", SCW_LOGIN_HINT);
    const key = parseJson<{ id?: string }>(r.stdout, "scw iam ssh-key create");
    if (!key.id) throw new TapdanceError("INTERNAL", "scw iam ssh-key create returned no id");
    return key.id;
  }

  async deleteKey(id: string): Promise<boolean> {
    const r = await this.scw(["iam", "ssh-key", "delete", id], { timeoutMs: 60_000 });
    return r.code === 0 || /not found|404/i.test(r.stderr);
  }

  async create(record: MachineRecord): Promise<ScwServer> {
    const r = await this.scw(["apple-silicon", "server", "create", `name=${record.resourceName}`, `type=${record.machineType}`, `zone=${record.zone}`, "commitment-type=none", ...this.projectArg()], { timeoutMs: 300_000 });
    if (r.code !== 0 && /stock|out of stock|no_stock|unavailable/i.test(r.stderr)) {
      throw new TapdanceError("NO_CAPACITY", `Scaleway has no ${record.machineType} in ${record.zone} right now: ${errorTail(r, 2)}`, { hint: "Try another offer with --type (e.g. M2-M), or later." });
    }
    check(r, "scw apple-silicon server create", SCW_LOGIN_HINT);
    return parseJson<ScwServer>(r.stdout, "scw apple-silicon server create");
  }

  async scheduleDeletion(id: string, zone: string): Promise<void> {
    check(await this.scw(["apple-silicon", "server", "update", id, "schedule-deletion=true", `zone=${zone}`], { timeoutMs: 120_000 }), "scw apple-silicon server update schedule-deletion=true");
  }

  async reboot(id: string, zone: string): Promise<void> {
    check(await this.scw(["apple-silicon", "server", "reboot", id, `zone=${zone}`], { timeoutMs: 120_000 }), "scw apple-silicon server reboot");
  }

  async delete(id: string, zone: string): Promise<ExecResult> {
    return this.scw(["apple-silicon", "server", "delete", id, `zone=${zone}`], { timeoutMs: 300_000 });
  }
}

export async function scalewayPreflight(io: MachineIo): Promise<void> {
  const r = await io.exec("scw", ["apple-silicon", "server-type", "list", `zone=${MAC_ZONES[0]}`, "-o", "json"], { timeoutMs: 60_000 });
  if (r.code === 127) throw new TapdanceError("HOST_CHECK_FAILED", "scw is not installed on this computer", { hint: SCW_LOGIN_HINT });
  if (r.code !== 0) throw new TapdanceError("AUTH_FAILED", `scw cannot reach Scaleway with your login: ${errorTail(r, 2)}`, { hint: SCW_LOGIN_HINT });
}

/** The offers of a zone with their stock (`available`, `low_stock`, `no_stock`), or [] when unknown. */
export async function scalewayOffers(io: MachineIo, zone: string): Promise<Array<{ name: string; stock: string }>> {
  const r = await io.exec("scw", ["apple-silicon", "server-type", "list", `zone=${zone}`, "-o", "json"], { timeoutMs: 60_000 });
  if (r.code !== 0) return [];
  try {
    return (JSON.parse(r.stdout) as Array<{ name?: string; stock?: string }>).filter((t) => t.name).map((t) => ({ name: t.name!, stock: t.stock ?? "unknown" }));
  } catch {
    return [];
  }
}

const inStock = (stock: string) => !/no_stock|out/i.test(stock);

/**
 * Picks the offer and zone to rent: the ones asked for, else the first zone with the asked offer in
 * stock, else the cheapest offer in stock in any Mac zone. Refuses only when nothing is in stock.
 */
export async function pickScalewayOffer(io: MachineIo, want: { type?: string; zone?: string }): Promise<{ type: string; zone: string; note?: string }> {
  const zones = want.zone ? [want.zone] : [...MAC_ZONES];
  const offers: Array<{ zone: string; name: string; stock: string }> = [];
  for (const zone of zones) for (const o of await scalewayOffers(io, zone)) offers.push({ zone, ...o });
  if (offers.length === 0) return { type: want.type ?? SCALEWAY_DEFAULTS.machineType, zone: want.zone ?? SCALEWAY_DEFAULTS.zone, note: "Scaleway did not report its stock; trying anyway" };
  const price = (n: string) => SCALEWAY_HOURLY_EUR[n] ?? Number.POSITIVE_INFINITY;
  const candidates = offers.filter((o) => (!want.type || o.name === want.type) && inStock(o.stock)).sort((a, b) => price(a.name) - price(b.name) || zones.indexOf(a.zone as never) - zones.indexOf(b.zone as never));
  const pick = candidates[0];
  if (!pick) {
    const seen = offers.filter((o) => inStock(o.stock)).map((o) => `${o.name} in ${o.zone}`);
    throw new TapdanceError("NO_CAPACITY", `Scaleway has no ${want.type ?? "Mac mini"} in stock${want.zone ? ` in ${want.zone}` : ""} right now`, {
      hint: seen.length ? `In stock now: ${seen.join(", ")}. Pick one with --type and --zone.` : "No Mac mini is in stock in any zone; try later.",
    });
  }
  return { type: pick.name, zone: pick.zone, ...(want.type ? {} : { note: `cheapest Mac mini in stock: ${pick.name} in ${pick.zone} (${pick.stock})` }) };
}

/** Server-type stock, when Scaleway reports it (field names vary; undefined when unknown). */
export async function scalewayStock(io: MachineIo, type: string, zone: string): Promise<string | undefined> {
  const r = await io.exec("scw", ["apple-silicon", "server-type", "list", `zone=${zone}`, "-o", "json"], { timeoutMs: 60_000 });
  if (r.code !== 0) return undefined;
  try {
    const types = JSON.parse(r.stdout) as Array<{ name?: string; stock?: string }>;
    return types.find((t) => t.name === type)?.stock;
  } catch {
    return undefined;
  }
}

export function sshBase(io: MachineIo, record: MachineRecord): string[] {
  const dir = io.store.dir(record.name);
  return [
    "-i", join(dir, "id_ed25519"),
    "-o", "IdentitiesOnly=yes",
    "-o", `UserKnownHostsFile=${join(dir, "known_hosts")}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=30",
  ];
}

export function macSsh(io: MachineIo, record: MachineRecord, command: string, options: { input?: string; timeoutMs?: number; onLine?: (l: string) => void } = {}): Promise<ExecResult> {
  return io.exec("ssh", [...sshBase(io, record), `${record.sshUser ?? "m1"}@${record.ip}`, command], { timeoutMs: 120_000, ...options });
}

export function macScp(io: MachineIo, record: MachineRecord, local: string, remote: string): Promise<ExecResult> {
  return io.exec("scp", [...sshBase(io, record), local, `${record.sshUser ?? "m1"}@${record.ip}:${remote}`], { timeoutMs: 180_000 });
}

/** The command line create runs on the Mac. */
export function macSetupCommand(record: MachineRecord, opts: { withKey: boolean; extra: string[] }): string {
  const args = ["bash", "tapdance-host-setup.sh", "--ios-only", "--yes", "--allow-admin-account", "--label", record.label, "--tailscale-hostname", record.tailscaleHostname];
  if (opts.withKey) args.push("--tailscale-auth-key-stdin");
  if (SMALL_MEMORY.has(record.machineType)) args.push("--warm", "android=0,ios=0");
  const install = installArgs(record);
  args.push(...install.args, ...opts.extra);
  return `${ENV_PREFIX}${install.env ? `TAPDANCE_REF=${shJoin([record.setupRef])} ` : ""}${shJoin(args)}`;
}

/** A sudoers drop-in for the setup only, validated by visudo before it is moved into place. */
export function sudoersInstallCommand(user: string): string {
  const staged = `${SUDOERS}.new`;
  return `sudo -S -p '' sh -c ${shJoin([`printf '%s ALL=(ALL) NOPASSWD: ALL\\n' "$1" > ${staged} && chmod 440 ${staged} && visudo -cf ${staged} >/dev/null && mv ${staged} ${SUDOERS}`])} sh ${shJoin([user])}`;
}
export const SUDOERS_REMOVE = `sudo -n rm -f ${SUDOERS} ${SUDOERS}.new`;

/**
 * Appends this computer's public key for the Mac to its authorized_keys with one password login. The
 * password reaches ssh through a throwaway SSH_ASKPASS helper that prints it from its environment: never
 * on a command line, in a file or in a log. The helper is deleted right after.
 */
export async function installKeyWithPassword(io: MachineIo, record: MachineRecord, password: string, publicKey: string): Promise<void> {
  const { writeFile, rm } = await import("node:fs/promises");
  const helper = join(io.store.dir(record.name), "askpass.sh");
  await writeFile(helper, '#!/bin/sh\nprintf \'%s\\n\' "$TAPDANCE_ASKPASS"\n', { mode: 0o700 });
  try {
    const dir = io.store.dir(record.name);
    const r = await io.exec(
      "ssh",
      [
        "-o", `UserKnownHostsFile=${join(dir, "known_hosts")}`,
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "PubkeyAuthentication=no",
        "-o", "PreferredAuthentications=keyboard-interactive,password",
        "-o", "NumberOfPasswordPrompts=1",
        "-o", "ConnectTimeout=15",
        `${record.sshUser ?? "m1"}@${record.ip}`,
        "umask 077; mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys",
      ],
      { input: `${publicKey}\n`, timeoutMs: 60_000, env: { ...io.env, SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: "force", DISPLAY: io.env["DISPLAY"] ?? ":0", TAPDANCE_ASKPASS: password } },
    );
    check(r, "adding this computer's ssh key to the Mac with its password");
  } finally {
    await rm(helper, { force: true });
  }
}

export interface ScalewayCreateInput {
  record: MachineRecord;
  tailscaleKey?: string;
  extraSetupArgs: string[];
}

export async function scalewayCreate(io: MachineIo, scw: Scaleway, input: ScalewayCreateInput): Promise<void> {
  const { record } = input;
  const dir = io.store.dir(record.name);
  const keyFile = join(dir, "id_ed25519");
  /** Read from the API when needed, kept in memory only. */
  const sudoPassword = async (): Promise<string> => {
    const s = await scw.server(record.serverId!, record.zone);
    if (!s?.sudo_password) throw new TapdanceError("INTERNAL", "Scaleway's API returned no password for the Mac yet");
    return s.sudo_password;
  };
  const waitReady = async (what: string, minutes: number): Promise<ScwServer> => {
    const started = io.now().getTime();
    const deadline = started + minutes * 60_000;
    let lastStatus = "";
    let lastShown = 0;
    while (io.now().getTime() < deadline) {
      const s = await scw.server(record.serverId!, record.zone);
      if (!s) throw new TapdanceError("INTERNAL", `The Mac ${record.serverId} is gone`);
      if (s.status === "ready" && s.ip) return s;
      if (s.status === "error" || s.status === "locked") throw new TapdanceError("PROVIDER_UNAVAILABLE", `Scaleway reports the Mac as ${s.status}`, { hint: "Look at it in the Scaleway console (Bare Metal > Apple silicon)." });
      const mins = Math.round((io.now().getTime() - started) / 60_000);
      if (s.status !== lastStatus || mins - lastShown >= 5) {
        io.out.progress(`  ${what}: ${s.status} (${mins} min)`);
        lastStatus = s.status;
        lastShown = mins;
      }
      await io.sleep(30_000);
    }
    throw new TapdanceError("TIMEOUT", `The Mac was not ready after ${minutes} minutes (last state: ${lastStatus})`, { hint: "Scaleway sometimes needs longer; run the same command again later to keep waiting." });
  };
  const waitSsh = async (minutes: number): Promise<void> => {
    const deadline = io.now().getTime() + minutes * 60_000;
    let last: ExecResult | undefined;
    while (io.now().getTime() < deadline) {
      last = await macSsh(io, record, "true", { timeoutMs: 30_000 });
      if (last.code === 0) return;
      await io.sleep(10_000);
    }
    throw new TapdanceError("TIMEOUT", `The Mac did not answer over ssh in ${minutes} minutes${last ? `: ${errorTail(last, 2)}` : ""}`);
  };
  const steps: Step[] = [
    {
      id: "ssh-key",
      title: record.adopted ? "Make an ssh key for this Mac" : "Make an ssh key for this Mac and add it to your Scaleway project",
      run: async () => {
        const have = await readFile(`${keyFile}.pub`, "utf8").catch(() => undefined);
        if (!have) check(await io.exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", record.resourceName, "-f", keyFile, "-q"], { timeoutMs: 30_000 }), "ssh-keygen");
        const pub = (await readFile(`${keyFile}.pub`, "utf8")).trim();
        // A Mac already rented does not get the project's keys again, so an adopted Mac needs none there.
        if (!record.sshKeyId && !record.adopted) record.sshKeyId = await scw.createKey(record.resourceName, pub);
      },
    },
    {
      id: "server",
      title: record.adopted ? `Use your Mac mini ${record.resourceName} (${record.machineType}, ${record.zone})` : `Rent the Mac mini (${record.machineType}, ${record.zone})`,
      run: async () => {
        if (record.adopted) return;
        if (!record.serverId) {
          const s = await scw.create(record);
          record.serverId = s.id;
          record.createdAt = s.created_at ?? record.createdAt;
          await io.store.save(record);
        }
        if (record.scheduledDeletion) await scw.scheduleDeletion(record.serverId, record.zone);
      },
    },
    {
      id: "install",
      title: record.adopted ? "Wait until the Mac answers over ssh" : "Wait for Scaleway to install macOS (often 20-60 min; nothing to do meanwhile)",
      run: async () => {
        const s = await waitReady("macOS install", 150);
        record.ip = s.ip;
        record.sshUser = s.ssh_username ?? "m1";
        record.deletableAt = s.deletable_at;
        await io.store.save(record);
        // Scaleway installs the project's ssh keys only when it installs macOS: a Mac rented before the
        // key was added (one handed over with --server-id) needs it added once, with its password.
        const probe = await macSsh(io, record, "true", { timeoutMs: 30_000 });
        if (probe.code !== 0 && /Permission denied/i.test(probe.stderr)) {
          io.out.progress("  adding this computer's key for the Mac, with one password login (the password comes from Scaleway's API and is not shown)");
          await installKeyWithPassword(io, record, await sudoPassword(), (await readFile(`${keyFile}.pub`, "utf8")).trim());
        }
        await waitSsh(10);
      },
    },
    {
      id: "auto-login",
      title: "Turn on automatic login, so the host comes back after a restart",
      run: async () => {
        const pw = await sudoPassword();
        check(await macSsh(io, record, sudoersInstallCommand(record.sshUser ?? "m1"), { input: `${pw}\n`, timeoutMs: 60_000 }), "installing the setup's sudo rule on the Mac");
        check(await macScp(io, record, io.assets.autoLogin, "tapdance-auto-login.sh"), "copying macos-auto-login.sh to the Mac");
        check(await macSsh(io, record, `bash tapdance-auto-login.sh --password-stdin ${shJoin([record.sshUser ?? "m1"])}`, { input: `${pw}\n`, timeoutMs: 120_000 }), "macos-auto-login.sh on the Mac");
        io.out.progress("  restarting the Mac so the login session starts…");
        await scw.reboot(record.serverId!, record.zone);
        await io.sleep(30_000);
        await waitReady("restart", 20);
        await waitSsh(10);
        const deadline = io.now().getTime() + 5 * 60_000;
        while (io.now().getTime() < deadline) {
          const who = await macSsh(io, record, "who", { timeoutMs: 30_000 });
          if (who.code === 0 && /\bconsole\b/.test(who.stdout)) return;
          await io.sleep(10_000);
        }
        throw new TapdanceError("HOST_CHECK_FAILED", "The Mac restarted but nobody is logged in on its console: automatic login did not take", {
          hint: "Look at the Mac's screen through the VNC link in the Scaleway console.",
        });
      },
    },
    {
      id: "setup",
      title: "Set up the Mac: Xcode first launch, an iOS runtime, Tailscale, Tapdance host (about 15 min)",
      run: async () => {
        try {
          // The sudo rule from the previous step may be gone if this step is re-run alone.
          const probe = await macSsh(io, record, "sudo -n true", { timeoutMs: 30_000 });
          if (probe.code !== 0) check(await macSsh(io, record, sudoersInstallCommand(record.sshUser ?? "m1"), { input: `${await sudoPassword()}\n`, timeoutMs: 60_000 }), "installing the setup's sudo rule on the Mac");
          check(await macScp(io, record, io.assets.hostSetup, "tapdance-host-setup.sh"), "copying host-setup.sh to the Mac");
          const r = await macSsh(io, record, macSetupCommand(record, { withKey: input.tailscaleKey !== undefined, extra: input.extraSetupArgs }), {
            timeoutMs: 90 * 60_000,
            onLine: setupLineHandler(io, setupLog(io, record.name)),
            ...(input.tailscaleKey !== undefined ? { input: `${input.tailscaleKey}\n` } : {}),
          });
          if (r.code !== 0) {
            throw new TapdanceError("HOST_CHECK_FAILED", `host-setup.sh on the Mac failed (exit ${r.code}); the last lines are above and the full log is in ${setupLog(io, record.name)}`, {
              hint: "Fix what it names (a Tailscale approval that timed out, a download that failed).",
            });
          }
        } finally {
          await macSsh(io, record, SUDOERS_REMOVE, { timeoutMs: 30_000 }).catch(() => undefined);
        }
      },
    },
    {
      id: "connect",
      title: "Connect this computer to the Mac",
      run: async () => {
        const remote = (c: string) => macSsh(io, record, c, { timeoutMs: 90_000 });
        record.endpoint = await remoteEndpoint(remote);
        // Tailscale may have named it tapdance-<name>-1 (an older node of that name is still listed).
        record.tailscaleHostname = new URL(record.endpoint).hostname.split(".")[0] ?? record.tailscaleHostname;
        const c = await connectMachine(io, { endpoint: record.endpoint, target: record.target, label: record.label, platform: "ios" }, remote);
        if (!c.ok) io.out.warn(`connect saved the Mac, but some checks failed: ${c.checks.filter((x) => x.status === "fail").map((x) => `${x.name}: ${x.message ?? ""}`).join("; ")}`);
      },
    },
  ];
  await checkLocalTailscale(io);
  await runSteps(record, steps, io, { create: `tapdance machine create --cloud scaleway --name ${record.name} --yes`, destroy: `tapdance machine destroy ${record.name}` });
}

export async function scalewayDestroy(io: MachineIo, scw: Scaleway, record: MachineRecord): Promise<DestroyReport> {
  const removed: string[] = [];
  const notes: string[] = [];
  const server = record.serverId ? await scw.server(record.serverId, record.zone) : undefined;
  if (server && server.name !== record.resourceName) {
    throw new TapdanceError("FORBIDDEN", `The Scaleway server ${record.serverId} is called ${server.name}, not ${record.resourceName}; Tapdance leaves it alone`);
  }
  if (server && server.status === "ready" && record.ip && record.done.includes("install")) {
    io.out.progress("Logging the Mac out of Tailscale (removes it from your tailnet)…");
    const r = await macSsh(io, record, TAILSCALE_LOGOUT, { timeoutMs: 90_000 });
    if (r.code === 0) {
      removed.push(`Tailscale: ${record.tailscaleHostname} logged out`);
      notes.push(`Tailscale may keep ${record.tailscaleHostname} listed as offline: delete it under Machines in the admin console (https://login.tailscale.com/admin/machines).`);
    } else if (r.code === 3 || r.code === 4) removed.push("Tailscale: the Mac had not joined your tailnet, nothing to remove");
    else notes.push(`Could not log ${record.tailscaleHostname} out of Tailscale; remove it under Machines in the Tailscale admin console (https://login.tailscale.com/admin/machines).`);
  }
  io.out.progress(`Removing connect target ${record.target}…`);
  removed.push(await disconnectMachine(io, record.target));
  if (server && server.status !== "deleting") {
    const now = io.now();
    const deletable = server.deletable_at ? new Date(server.deletable_at) : undefined;
    if (deletable && deletable > now) {
      await scw.scheduleDeletion(server.id, record.zone);
      record.pendingDeletionAt = server.deletable_at;
      notes.push(`Scaleway does not delete a Mac before its first 24 hours: it is scheduled for deletion at ${server.deletable_at} and billed until then. Nothing else to do; \`tapdance machine list\` shows it until it is gone.`);
    } else {
      const r = await scw.delete(server.id, record.zone);
      if (r.code !== 0 && /24|deletable|minimum/i.test(r.stderr)) {
        await scw.scheduleDeletion(server.id, record.zone);
        record.pendingDeletionAt = server.deletable_at ?? "after its first 24 hours";
        notes.push("Scaleway refused to delete the Mac yet (24-hour minimum); it is scheduled for deletion instead.");
      } else {
        check(r, "scw apple-silicon server delete");
        removed.push(`Mac mini ${record.resourceName} (Scaleway wipes and removes it in about 30 minutes; billing stops now)`);
      }
    }
  } else if (server?.status === "deleting") {
    removed.push(`Mac mini ${record.resourceName} (already being deleted)`);
  }
  if (record.sshKeyId) {
    if (await scw.deleteKey(record.sshKeyId)) {
      removed.push(`ssh key ${record.resourceName} in your Scaleway project`);
      delete record.sshKeyId;
    } else notes.push(`Could not delete the ssh key ${record.resourceName} from your Scaleway project; delete it under Project > SSH keys.`);
  }
  io.out.progress("Checking that nothing billable is left…");
  const leftovers = await scalewayLeftovers(scw, record);
  return { removed, notes, leftovers };
}

export async function scalewayLeftovers(scw: Scaleway, record: Pick<MachineRecord, "resourceName" | "serverId" | "pendingDeletionAt" | "zone">): Promise<LeftoverReport> {
  const ours: string[] = [];
  const others: string[] = [];
  const unknown: string[] = [];
  try {
    for (const s of await scw.listServers(record.zone ? [record.zone] : [])) {
      const row = `Mac mini ${s.name} id=${s.id} type=${s.type} status=${s.status}${s.deletable_at ? ` deletable_at=${s.deletable_at}` : ""}`;
      // A Mac being deleted no longer bills.
      if (s.status === "deleting") continue;
      if (s.id === record.serverId || s.name === record.resourceName) ours.push(row);
      else others.push(row);
    }
  } catch (error) {
    unknown.push(`Mac mini servers (${(error as Error).message.split("\n")[0]})`);
  }
  for (const zone of MAC_ZONES) {
    const pn = await scw.scw(["apple-silicon", "private-network", "list", `zone=${zone}`], { timeoutMs: 60_000 });
    if (pn.code !== 0) {
      unknown.push(`Mac mini private networks in ${zone} (${errorTail(pn, 1) || `exit ${pn.code}`})`);
      continue;
    }
    for (const p of parseJson<Array<{ server_id?: string; private_network_id?: string }>>(pn.stdout || "[]", "scw apple-silicon private-network list") ?? []) {
      const row = `private network ${p.private_network_id} on server ${p.server_id} (${zone})`;
      if (p.server_id === record.serverId) ours.push(row);
      else others.push(row);
    }
  }
  return { ours, others, unknown };
}

export function scalewayCostOf(record: Pick<MachineRecord, "machineType" | "createdAt">, now: Date): CostEstimate | undefined {
  return scalewayCost({ type: record.machineType, createdAt: new Date(record.createdAt), now });
}

export function scalewayPriceLine(type: string): string {
  const rate = SCALEWAY_HOURLY_EUR[type];
  return rate === undefined
    ? `${type}: see https://www.scaleway.com/en/pricing/apple-silicon/`
    : `EUR ${rate.toFixed(2)} an hour before VAT (${type}), billed for at least 24 hours: EUR ${(rate * 24).toFixed(2)} at least`;
}
