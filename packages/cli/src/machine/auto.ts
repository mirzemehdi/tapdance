import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TapdanceError, redactSecrets, type MachineAutoHook, type MachineAutoInput, type Platform } from "@tapdance/sdk";
import { destroyingNow, disconnectMachine, setupLog, type MachineIo } from "./common.js";
import { gcpDiskHourly } from "./cost.js";
import { GCP_DEFAULTS, GCP_STOPPED, Gcp, gcpStart, type GcpInstance } from "./gcp.js";
import { LOCK_TOKEN_ENV, acquireLock, handOver, lockHolder } from "./lock.js";
import { Scaleway } from "./scaleway.js";
import { assertMachineName, machinesDir, resourceName, type Cloud, type MachineRecord } from "./state.js";

/**
 * Auto mode (`tapdance machine auto on`): when a lease finds no host for a platform, the CLI on this
 * computer starts the stopped machine, or creates one in the background, with the user's own gcloud or
 * scw. It never deletes a machine: only `tapdance machine destroy`, which asks a person, does. The
 * policy lives in ~/.tapdance/machines/auto.json, never in a project's config: a repository must not be
 * able to spend its reader's money.
 */
export interface AutoPolicy {
  cloud: Cloud;
  name: string;
  project?: string;
  zone?: string;
  type?: string;
  idleStop?: number | "off";
  maxHours?: number | "off";
  /** gcp: remind the person to destroy the machine once it has been stopped this many days (its disk bills meanwhile). */
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

/** The same create, for a person to run in a terminal (it continues where the background one stopped). */
function createCommand(p: AutoPolicy): string {
  return `tapdance ${createArgs(p).filter((a) => a !== "--yes").join(" ")}`;
}

const LOGIN_URL = /https:\/\/login\.tailscale\.com\/a\/\S+/;
const BOOTING = new Set(["PROVISIONING", "STAGING", "RUNNING", "STOPPING", "SUSPENDING", "REPAIRING"]);
/** A background create that failed is started again no sooner than this after the last one started. */
export const AUTO_RETRY_MS = 10 * 60_000;

function autoLog(io: MachineIo, name: string): string {
  return join(io.store.dir(name), "auto-create.log");
}

function attemptFile(io: MachineIo, name: string): string {
  return join(io.store.dir(name), "auto-create.json");
}

async function lastAttempt(io: MachineIo, name: string): Promise<{ startedAt: string; pid?: number } | undefined> {
  try {
    const a = JSON.parse(await readFile(attemptFile(io, name), "utf8")) as { startedAt?: unknown; pid?: unknown };
    return typeof a.startedAt === "string" ? { startedAt: a.startedAt, ...(typeof a.pid === "number" ? { pid: a.pid } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/** The last lines of the background create's output, redacted, without colours. */
async function logTail(io: MachineIo, name: string, lines = 6): Promise<string> {
  const text = await readFile(autoLog(io, name), "utf8").catch(() => "");
  return redactSecrets(text.replace(/\u001b\[[0-9;]*m/g, ""))
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .slice(-lines)
    .join("\n");
}

function macWhere(p: AutoPolicy): string {
  return `a Scaleway Mac mini (${p.type ?? "the cheapest offer in stock"}; it bills at least 24 hours, as accepted with --accept-mac-day)`;
}

function destroyingError(platform: Platform, p: AutoPolicy): TapdanceError {
  return new TapdanceError("PROVIDER_UNAVAILABLE", `Machine ${p.name} for ${platform} is being destroyed right now`, {
    hint: "Lease again once the person's `tapdance machine destroy` has finished.",
    retryable: true,
    retryAfterMs: 60_000,
  });
}

/** A retryable error that tells the agent (and through it, the person) what is happening. */
async function creatingError(io: MachineIo, platform: Platform, p: AutoPolicy, startedNow: boolean): Promise<TapdanceError> {
  const rec = await io.store.get(p.name);
  const log = await readFile(setupLog(io, p.name), "utf8").catch(() => "");
  const link = LOGIN_URL.exec(log)?.[0];
  const where = p.cloud === "gcp" ? `a Google Cloud N2 VM in project ${p.project ?? "(gcloud's default)"}` : macWhere(p);
  const progress = rec ? `${rec.done.length} of 6 steps done` : "starting";
  const eta = p.cloud === "gcp" ? "about 10 minutes" : "often 30-80 minutes, most of it Scaleway installing macOS";
  return new TapdanceError(
    "PROVIDER_UNAVAILABLE",
    `${startedNow ? "Creating" : "Still creating"} machine ${p.name} for ${platform}: ${where} (${progress}; ${eta} in all)`,
    {
      hint: `${link ? `The person must approve the machine in their Tailscale network: ${link} . ` : ""}Lease again in a few minutes. Progress: \`tapdance machine auto\`; the setup log is ${setupLog(io, p.name)}. To stop it, the person runs \`tapdance machine destroy ${p.name}\` in a terminal: it asks first, stops this create, then removes what it made.`,
      retryable: true,
      retryAfterMs: 60_000,
      details: { machine: p.name, cloud: p.cloud, platform, ...(rec ? { done: rec.done } : {}), ...(link ? { tailscaleLogin: link } : {}) },
    },
  );
}

async function startCreate(io: MachineIo, platform: Platform, p: AutoPolicy): Promise<never> {
  if (await destroyingNow(io, p.name)) throw destroyingError(platform, p);
  if (await lockHolder(io, p.name)) throw await creatingError(io, platform, p, false);
  // A background create that failed is not started again on every lease: once per AUTO_RETRY_MS.
  const last = await lastAttempt(io, p.name);
  const since = last ? io.now().getTime() - Date.parse(last.startedAt) : Number.POSITIVE_INFINITY;
  if (since < AUTO_RETRY_MS) {
    const rec = await io.store.get(p.name);
    const tail = await logTail(io, p.name);
    const retryAt = new Date(Date.parse(last!.startedAt) + AUTO_RETRY_MS);
    throw new TapdanceError(
      "PROVIDER_UNAVAILABLE",
      `The background create of machine ${p.name} for ${platform}, started ${last!.startedAt}, stopped before it finished (${rec ? `${rec.done.length} of 6 steps done` : "nothing created yet"}). Auto mode tries again no sooner than ${retryAt.toISOString()}.${tail ? `\nIts last output:\n${tail}` : ""}`,
      {
        hint: `Tell the person what failed. They can fix it and continue the create in a terminal with \`${createCommand(p)}\` (it continues where it stopped), or remove what it made with \`tapdance machine destroy ${p.name}\`. Its full output is in ${autoLog(io, p.name)}.`,
        retryable: true,
        retryAfterMs: Math.max(60_000, AUTO_RETRY_MS - since),
        details: { machine: p.name, cloud: p.cloud, platform, lastAttempt: last!.startedAt, retryAt: retryAt.toISOString(), ...(rec ? { done: rec.done } : {}) },
      },
    );
  }
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
  // The lock is taken before the spawn and handed to the child: two leases cannot both start a create.
  const token = randomBytes(16).toString("hex");
  const { release, lock } = await acquireLock(io, p.name, "starting", { token });
  let pid: number;
  try {
    pid = await io.spawnCreate(createArgs(p), autoLog(io, p.name), { [LOCK_TOKEN_ENV]: token });
  } catch (error) {
    await release();
    throw error;
  }
  await handOver(io, p.name, { ...lock, pid, role: "create", startedAt: io.now().getTime() });
  await writeFile(attemptFile(io, p.name), `${JSON.stringify({ startedAt: io.now().toISOString(), pid })}\n`, { mode: 0o600 });
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

/** Lease errors that mean "the host did not answer", as opposed to a host that answered and refused. */
const HOST_DOWN = new Set(["PROVIDER_UNREACHABLE", "WORKER_OFFLINE"]);

/**
 * Whether auto mode may bring a machine up for this lease failure: "provision" only when no host serves
 * the platform at all, or when the failing host is auto mode's own machine and it does not answer.
 * Anything else ("rethrow": a host that answered and refused, an unknown model, a device in use, a
 * missing runtime, another host that is down) must reach the agent unchanged, and costs nothing.
 */
export function autoDecision(input: MachineAutoInput, own: string | undefined): "provision" | "rethrow" {
  if (input.reason === "no-target") return input.localWorker ? "rethrow" : "provision";
  const e = input.error;
  const down = e !== undefined && HOST_DOWN.has(e.code);
  if (own !== undefined && input.failedTarget === own) return down ? "provision" : "rethrow";
  const unservedList = e?.details?.["unserved"];
  const unserved = new Set(Array.isArray(unservedList) ? unservedList.filter((x): x is string => typeof x === "string") : []);
  const serves = (t: MachineAutoInput["targets"][number]) => (!t.platforms || t.platforms.includes(input.platform)) && !unserved.has(t.name);
  if (input.targets.some((t) => t.name !== own && serves(t))) return "rethrow";
  if (input.localWorker) return "rethrow";
  const ownTarget = own !== undefined && input.targets.some((t) => t.name === own && serves(t));
  if (ownTarget) return down ? "provision" : "rethrow";
  // No host serves the platform: the lease failed for want of one.
  return "provision";
}

/** What the SDK calls when a lease finds no host for an auto platform, or its host did not answer. */
export async function ensureMachine(io: MachineIo, input: MachineAutoInput, progress: (m: string) => void): Promise<{ notice?: string }> {
  const { platform } = input;
  const p = (await readAuto(io))[platform];
  if (!p) {
    if (input.error) throw input.error;
    return {};
  }
  if (await destroyingNow(io, p.name)) throw destroyingError(platform, p);
  let rec = await io.store.get(p.name);
  if (rec && rec.cloud !== p.cloud) throw new TapdanceError("CONFIG_INVALID", `Auto mode for ${platform} names machine ${p.name} on ${p.cloud}, but that machine is on ${rec.cloud}`, { hint: "Run `tapdance machine auto on` again with another --name." });
  const own = rec?.done.includes("connect") ? rec.target : undefined;
  if (autoDecision(input, own) === "rethrow") {
    throw input.error ?? new TapdanceError("PROVIDER_UNAVAILABLE", `A host for ${platform} is configured on this computer; auto mode leaves it to answer`);
  }
  if (rec && !rec.done.includes("connect")) {
    if (await lockHolder(io, p.name)) throw await creatingError(io, platform, p, false);
    return startCreate(io, platform, p);
  }
  if (!rec) return startCreate(io, platform, p);
  const started = io.now().getTime();
  const secs = () => Math.round((io.now().getTime() - started) / 1000);
  if (rec.cloud === "gcp") {
    const gcp = new Gcp(io, rec.project!);
    let vm = await gcp.instance(rec);
    if (!vm) {
      if (await lockHolder(io, p.name)) throw await creatingError(io, platform, p, false);
      // Nothing is deleted here (only `machine destroy`, which asks a person, deletes): the VM is made
      // again in the machine's own network, which create checks is still marked as this machine's.
      progress(`Machine ${p.name} is gone from Google Cloud: creating its VM again in the same network (its old Tailscale node stays listed as offline until the person deletes it)`);
      rec.done = rec.done.filter((step) => step === "apis" || step === "network");
      rec.tailscaleHostname = resourceName(rec.name);
      delete rec.endpoint;
      await io.store.save(rec);
      return startCreate(io, platform, p);
    }
    const shell = `\`gcloud compute ssh ${rec.resourceName} --zone ${rec.zone} --project ${rec.project} --tunnel-through-iap\``;
    for (let i = 0; i < 36 && (vm!.status === "STOPPING" || vm!.status === "SUSPENDING"); i++) {
      await io.sleep(5_000);
      vm = await gcp.instance(rec);
    }
    if (vm && GCP_STOPPED.has(vm.status)) {
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
    if (await lockHolder(io, p.name)) throw await creatingError(io, platform, p, false);
    progress(`Machine ${p.name} was deleted by Scaleway after its paid day: renting a new one`);
    // The Mac is gone already: what is left is its connect target here (the new Mac takes that name)
    // and, if one was kept, its ssh key in the project. Removing them deletes no machine.
    await disconnectMachine(io, rec.target);
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
    ensure: (input, progress) => ensureMachine(io, input, progress),
  };
}

/**
 * Reminds the person of an auto Android machine that has been stopped for `deleteAfterDays` (its disk
 * bills while it is stopped). It deletes nothing: only `tapdance machine destroy`, which asks a person,
 * does. Runs on this computer when Tapdance does (`machine auto`, `machine list`, the MCP server's
 * start). Returns the reminders.
 */
export async function autoHousekeeping(io: MachineIo): Promise<string[]> {
  const p = (await readAuto(io)).android;
  if (!p || p.cloud !== "gcp" || !p.deleteAfterDays) return [];
  const rec = await io.store.get(p.name);
  if (!rec || !rec.done.includes("vm")) return [];
  const gcp = new Gcp(io, rec.project!);
  const vm: GcpInstance | undefined = await gcp.instance(rec);
  if (!vm || !GCP_STOPPED.has(vm.status)) return [];
  const since = Date.parse(vm.lastStopTimestamp ?? vm.lastStartTimestamp ?? vm.creationTimestamp);
  const days = (io.now().getTime() - since) / 86_400_000;
  if (!(days >= p.deleteAfterDays)) return [];
  const monthly = gcpDiskHourly(rec.diskGb ?? GCP_DEFAULTS.diskGb) * 730;
  return [`Machine ${rec.name} has been stopped ${Math.floor(days)} days (limit ${p.deleteAfterDays}); its disk bills about USD ${monthly.toFixed(2)} a month. Remove it with \`tapdance machine destroy ${rec.name}\`.`];
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
    return `${platform}: machine ${p.name} on Google Cloud (${p.type ?? GCP_DEFAULTS.machineType}${p.project ? `, project ${p.project}` : ""}): created on the first lease that needs it, started when stopped, stops itself after ${p.idleStop === "off" ? "(idle stop off)" : `${p.idleStop ?? GCP_DEFAULTS.idleStop} idle minutes`}${p.deleteAfterDays ? `; after ${p.deleteAfterDays} day(s) stopped you are reminded to destroy it (nothing is deleted automatically)` : ""}`;
  }
  return `${platform}: machine ${p.name} on Scaleway (${p.type ?? "the cheapest Mac mini in stock"}): rented on the first lease that needs it, kept for its paid day, deleted by Scaleway at the 24-hour mark; the next lease after that rents a new one (another day)`;
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

