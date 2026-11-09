import { closeSync, openSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TapdanceError, type MachineAutoHook, type Platform } from "@tapdance/sdk";
import { setupLog, type MachineIo } from "./common.js";
import { GCP_DEFAULTS, Gcp, gcpDestroy, gcpStart, type GcpInstance } from "./gcp.js";
import { SCALEWAY_DEFAULTS, Scaleway } from "./scaleway.js";
import { assertMachineName, machinesDir, type Cloud, type MachineRecord } from "./state.js";

/**
 * Auto mode (`tapdance machine auto on`): when a lease finds no reachable host for a platform, the CLI
 * on this computer starts the stopped machine, or creates one in the background, with the user's own
 * gcloud or scw. The policy lives in ~/.tapdance/machines/auto.json, never in a project's config: a
 * repository must not be able to spend its reader's money.
 */
export interface AutoPolicy {
  cloud: Cloud;
  name: string;
  project?: string;
  zone?: string;
  type?: string;
  idleStop?: number | "off";
  maxHours?: number | "off";
  /** gcp: destroy the machine once it has been stopped this many days (its disk bills meanwhile). */
  deleteAfterDays?: number;
  /** scaleway: the person accepted that each new Mac costs at least 24 hours. */
  acceptMacDay?: boolean;
  enabledAt: string;
}

export type AutoConfig = Partial<Record<Platform, AutoPolicy>>;

export function autoPath(io: Pick<MachineIo, "env">): string {
  return join(machinesDir(io.env), "auto.json");
}

export async function readAuto(io: Pick<MachineIo, "env">): Promise<AutoConfig> {
  try {
    return JSON.parse(await readFile(autoPath(io), "utf8")) as AutoConfig;
  } catch {
    return {};
  }
}

export async function writeAuto(io: Pick<MachineIo, "env" | "store">, config: AutoConfig): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(machinesDir(io.env), { recursive: true, mode: 0o700 });
  await writeFile(autoPath(io), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** The `machine create` arguments a policy stands for. */
export function createArgs(p: AutoPolicy): string[] {
  const a = ["machine", "create", "--cloud", p.cloud, "--name", p.name, "--yes"];
  if (p.project) a.push("--project", p.project);
  if (p.zone) a.push("--zone", p.zone);
  if (p.type) a.push("--type", p.type);
  if (p.cloud === "gcp") {
    if (p.idleStop !== undefined) a.push("--idle-stop", String(p.idleStop));
    if (p.maxHours !== undefined) a.push("--max-hours", String(p.maxHours));
  }
  return a;
}

const LOGIN_URL = /https:\/\/login\.tailscale\.com\/a\/\S+/;
const STOPPED = new Set(["TERMINATED", "STOPPED", "SUSPENDED"]);
const BOOTING = new Set(["PROVISIONING", "STAGING", "RUNNING", "STOPPING", "SUSPENDING", "REPAIRING"]);

function pidFile(io: MachineIo, name: string): string {
  return join(io.store.dir(name), "auto-create.pid");
}

async function runningCreate(io: MachineIo, name: string): Promise<number | undefined> {
  const pid = Number((await readFile(pidFile(io, name), "utf8").catch(() => "")).trim());
  return Number.isInteger(pid) && pid > 0 && io.alive(pid) ? pid : undefined;
}

/** A retryable error that tells the agent (and through it, the person) what is happening. */
async function creatingError(io: MachineIo, platform: Platform, p: AutoPolicy, startedNow: boolean): Promise<TapdanceError> {
  const rec = await io.store.get(p.name);
  const log = await readFile(setupLog(io, p.name), "utf8").catch(() => "");
  const link = LOGIN_URL.exec(log)?.[0];
  const where = p.cloud === "gcp" ? `a Google Cloud N2 VM in project ${p.project ?? "(gcloud's default)"}` : `a Scaleway Mac mini (${p.type ?? SCALEWAY_DEFAULTS.machineType}; it bills at least 24 hours, as accepted with --accept-mac-day)`;
  const progress = rec ? `${rec.done.length} of 6 steps done` : "starting";
  const eta = p.cloud === "gcp" ? "about 10 minutes" : "often 30-80 minutes, most of it Scaleway installing macOS";
  return new TapdanceError(
    "PROVIDER_UNAVAILABLE",
    `${startedNow ? "Creating" : "Still creating"} machine ${p.name} for ${platform}: ${where} (${progress}; ${eta} in all)`,
    {
      hint: `${link ? `The person must approve the machine in their Tailscale network: ${link} . ` : ""}Lease again in a few minutes. Progress: \`tapdance machine auto\`; the setup log is ${setupLog(io, p.name)}. To stop it: \`tapdance machine destroy ${p.name}\`.`,
      retryable: true,
      retryAfterMs: 60_000,
      details: { machine: p.name, cloud: p.cloud, platform, ...(rec ? { done: rec.done } : {}), ...(link ? { tailscaleLogin: link } : {}) },
    },
  );
}

async function startCreate(io: MachineIo, platform: Platform, p: AutoPolicy): Promise<never> {
  const running = await runningCreate(io, p.name);
  if (running) throw await creatingError(io, platform, p, false);
  if (p.cloud === "scaleway") {
    // A Mac the person already rented is set up, not rented again: that takes a person, once.
    const known = new Set((await io.store.list()).map((r) => r.serverId).filter(Boolean));
    const theirs = (await new Scaleway(io, p.project).listServers(p.zone ? [p.zone] : [])).filter((s) => !known.has(s.id) && s.status !== "deleting");
    if (theirs.length > 0) {
      throw new TapdanceError("PROVIDER_UNAVAILABLE", `Auto mode will not rent a Mac for ${platform}: this Scaleway project already has ${theirs.map((s) => `${s.name} (${s.type}, ${s.zone ?? "?"})`).join(", ")}`, {
        hint: `Ask the person to set it up once with \`tapdance machine create --cloud scaleway --name ${p.name} --server-id ${theirs[0]!.id}\`; auto mode then uses it.`,
        retryable: false,
      });
    }
  }
  const { mkdir } = await import("node:fs/promises");
  await mkdir(io.store.dir(p.name), { recursive: true, mode: 0o700 });
  const pid = await io.spawnCreate(createArgs(p), join(io.store.dir(p.name), "auto-create.log"));
  await writeFile(pidFile(io, p.name), `${pid}\n`, { mode: 0o600 });
  io.out.progress(`Auto mode: creating machine ${p.name} in the background (pid ${pid})`);
  // Give the first steps a moment, so the error can say how far it got.
  await io.sleep(2_000);
  throw await creatingError(io, platform, p, true);
}

async function waitHealthy(io: MachineIo, endpoint: string, seconds: number): Promise<boolean> {
  const deadline = io.now().getTime() + seconds * 1000;
  while (io.now().getTime() < deadline) {
    if (await io.healthz(endpoint)) return true;
    await io.sleep(5_000);
  }
  return false;
}

function unreachable(p: AutoPolicy, rec: MachineRecord, detail: string, shell: string): TapdanceError {
  return new TapdanceError("PROVIDER_UNREACHABLE", `Machine ${p.name} is ${detail}, but its host does not answer at ${rec.endpoint ?? "?"}`, {
    hint: `Check it: ${shell} then \`tapdance host status\` there. Retry in a minute.`,
    retryable: true,
    retryAfterMs: 60_000,
  });
}

/** What the SDK calls when a lease finds no host for an auto platform. */
export async function ensureMachine(io: MachineIo, platform: Platform, progress: (m: string) => void): Promise<{ notice?: string }> {
  const p = (await readAuto(io))[platform];
  if (!p) return {};
  let rec = await io.store.get(p.name);
  if (rec && rec.cloud !== p.cloud) throw new TapdanceError("CONFIG_INVALID", `Auto mode for ${platform} names machine ${p.name} on ${p.cloud}, but that machine is on ${rec.cloud}`, { hint: "Run `tapdance machine auto on` again with another --name." });
  if (rec && !rec.done.includes("connect")) {
    if (await runningCreate(io, p.name)) throw await creatingError(io, platform, p, false);
    return startCreate(io, platform, p);
  }
  if (!rec) return startCreate(io, platform, p);
  const started = io.now().getTime();
  const secs = () => Math.round((io.now().getTime() - started) / 1000);
  if (rec.cloud === "gcp") {
    const gcp = new Gcp(io, rec.project!);
    let vm = await gcp.instance(rec);
    if (!vm) {
      progress(`Machine ${p.name} is gone from Google Cloud: cleaning up its record and creating a new one`);
      await gcpDestroy(io, gcp, rec).catch(() => undefined);
      await io.store.remove(p.name);
      return startCreate(io, platform, p);
    }
    const shell = `\`gcloud compute ssh ${rec.resourceName} --zone ${rec.zone} --project ${rec.project} --tunnel-through-iap\``;
    for (let i = 0; i < 36 && (vm!.status === "STOPPING" || vm!.status === "SUSPENDING"); i++) {
      await io.sleep(5_000);
      vm = await gcp.instance(rec);
    }
    if (vm && STOPPED.has(vm.status)) {
      progress(`Auto mode: starting machine ${p.name} (it was stopped)…`);
      await gcpStart(gcp, rec);
      if (!(await waitHealthy(io, rec.endpoint!, 240))) throw unreachable(p, rec, "started", shell);
      return { notice: `Started machine ${p.name} for this lease in ${secs()} s; it stops itself again when idle.` };
    }
    if (vm && BOOTING.has(vm.status)) {
      if (await waitHealthy(io, rec.endpoint!, 180)) return secs() > 5 ? { notice: `Waited ${secs()} s for machine ${p.name} to come up.` } : {};
      throw unreachable(p, rec, vm.status.toLowerCase(), shell);
    }
    throw unreachable(p, rec, `in state ${vm?.status ?? "unknown"}`, shell);
  }
  const scw = new Scaleway(io, rec.project);
  const server = rec.serverId ? await scw.server(rec.serverId, rec.zone) : undefined;
  if (!server || server.status === "deleting") {
    // Its paid day is over and Scaleway deleted it: a new Mac is a new day, only with consent.
    if (!p.acceptMacDay) throw new TapdanceError("PROVIDER_UNAVAILABLE", `Machine ${p.name} (Scaleway Mac) is gone and auto mode may not rent a new one`, { hint: "Turn it on with `tapdance machine auto on --platform ios --accept-mac-day`, or create one with `tapdance machine create --cloud scaleway`." });
    progress(`Machine ${p.name} was deleted by Scaleway after its paid day: renting a new one`);
    if (rec.sshKeyId) await scw.deleteKey(rec.sshKeyId).catch(() => false);
    await io.store.remove(p.name);
    rec = undefined;
    return startCreate(io, platform, p);
  }
  const shell = `\`ssh -i ${io.store.dir(rec.name)}/id_ed25519 ${rec.sshUser ?? "m1"}@${rec.ip}\``;
  if (await waitHealthy(io, rec.endpoint!, 120)) return secs() > 5 ? { notice: `Waited ${secs()} s for machine ${p.name} to answer.` } : {};
  throw unreachable(p, rec, `Scaleway state ${server.status}`, shell);
}

export function machineAutoHook(io: MachineIo, config: AutoConfig): MachineAutoHook {
  return {
    handles: (platform) => config[platform] !== undefined,
    ensure: ({ platform }, progress) => ensureMachine(io, platform, progress),
  };
}

/**
 * Deletes an auto Android machine that has been stopped for `deleteAfterDays` (its disk bills while
 * it is stopped). Runs on this computer when Tapdance does (`machine auto`, `machine list`, the MCP
 * server's start), since nothing else of ours runs anywhere. Returns what it did.
 */
export async function autoHousekeeping(io: MachineIo): Promise<string[]> {
  const p = (await readAuto(io)).android;
  if (!p || p.cloud !== "gcp" || !p.deleteAfterDays) return [];
  const rec = await io.store.get(p.name);
  if (!rec || !rec.done.includes("vm")) return [];
  const gcp = new Gcp(io, rec.project!);
  const vm: GcpInstance | undefined = await gcp.instance(rec);
  if (!vm || !STOPPED.has(vm.status)) return [];
  const since = Date.parse(vm.lastStopTimestamp ?? vm.lastStartTimestamp ?? vm.creationTimestamp);
  const days = (io.now().getTime() - since) / 86_400_000;
  if (!(days >= p.deleteAfterDays)) return [];
  const d = await gcpDestroy(io, gcp, rec);
  if (d.leftovers.ours.length === 0 && d.leftovers.unknown.length === 0) await io.store.remove(rec.name);
  return [`Auto mode destroyed machine ${rec.name}: stopped for ${Math.floor(days)} days (limit ${p.deleteAfterDays}). The next ${"android"} lease creates a new one.`];
}

export interface AutoOnOptions {
  platform?: string;
  cloud?: string;
  name?: string;
  project?: string;
  zone?: string;
  type?: string;
  idleStop?: string;
  maxHours?: string;
  deleteAfterDays?: string;
  acceptMacDay?: boolean;
}

export function autoPolicyFrom(o: AutoOnOptions, parsers: { idleStop: (v?: string) => number | "off"; maxHours: (v?: string) => number | "off" }, now: Date): { platform: Platform; policy: AutoPolicy } {
  if (o.platform !== "android" && o.platform !== "ios") throw new TapdanceError("USAGE", "Say which platform: --platform android (Google Cloud) or --platform ios (Scaleway)");
  const platform = o.platform;
  const cloud = (o.cloud ?? (platform === "android" ? "gcp" : "scaleway")) as Cloud;
  if (platform === "android" && cloud !== "gcp") throw new TapdanceError("USAGE", "Android machines run on --cloud gcp");
  if (platform === "ios" && cloud !== "scaleway") throw new TapdanceError("USAGE", "iOS machines run on --cloud scaleway");
  const name = assertMachineName(o.name ?? platform);
  if (platform === "ios" && !o.acceptMacDay) {
    throw new TapdanceError("USAGE", "Auto mode for iOS rents a Scaleway Mac mini when a lease needs one, and each new Mac bills at least 24 hours", {
      hint: "Add --accept-mac-day to agree to that. A Mac is then kept for its paid day and deleted by Scaleway at the 24-hour mark.",
    });
  }
  let deleteAfterDays: number | undefined;
  if (o.deleteAfterDays !== undefined) {
    if (platform !== "android") throw new TapdanceError("USAGE", "--delete-after-days is for Android machines (a Scaleway Mac is deleted at its 24-hour mark anyway)");
    deleteAfterDays = Number(o.deleteAfterDays);
    if (!Number.isInteger(deleteAfterDays) || deleteAfterDays < 1 || deleteAfterDays > 365) throw new TapdanceError("USAGE", "--delete-after-days must be 1 to 365");
  }
  const policy: AutoPolicy = {
    cloud,
    name,
    ...(o.project ? { project: o.project } : {}),
    ...(o.zone ? { zone: o.zone } : {}),
    ...(o.type ? { type: o.type } : {}),
    ...(cloud === "gcp" ? { idleStop: parsers.idleStop(o.idleStop), maxHours: parsers.maxHours(o.maxHours) } : {}),
    ...(deleteAfterDays ? { deleteAfterDays } : {}),
    ...(platform === "ios" ? { acceptMacDay: true } : {}),
    enabledAt: now.toISOString(),
  };
  return { platform, policy };
}

export function describePolicy(platform: Platform, p: AutoPolicy): string {
  if (p.cloud === "gcp") {
    return `${platform}: machine ${p.name} on Google Cloud (${p.type ?? GCP_DEFAULTS.machineType}${p.project ? `, project ${p.project}` : ""}): created on the first lease that needs it, started when stopped, stops itself after ${p.idleStop === "off" ? "(idle stop off)" : `${p.idleStop ?? GCP_DEFAULTS.idleStop} idle minutes`}${p.deleteAfterDays ? `, destroyed after ${p.deleteAfterDays} day(s) stopped` : ""}`;
  }
  return `${platform}: machine ${p.name} on Scaleway (${p.type ?? SCALEWAY_DEFAULTS.machineType}): rented on the first lease that needs it, kept for its paid day, deleted by Scaleway at the 24-hour mark; the next lease after that rents a new one (another day)`;
}

/** Closes a file descriptor the background create's output went to (used by the real spawner). */
export function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}

export function openLog(path: string): number {
  return openSync(path, "a", 0o600);
}

export async function clearPid(io: MachineIo, name: string): Promise<void> {
  await rm(pidFile(io, name), { force: true });
}
