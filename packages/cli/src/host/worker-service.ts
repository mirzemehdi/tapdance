/**
 * The worker's login service after an update (#110).
 *
 * Simlock's `daemon install` writes the absolute paths of Node and of Simlock's daemon into the
 * systemd unit (`ExecStart=`) or the launchd plist (`ProgramArguments`). pnpm puts a new Simlock
 * patch in a new folder (`simlock@0.5.0_patch_hash=…`), so after `git pull && pnpm install` the
 * service, and every `daemon start` that goes through it, still runs the old copy until the service
 * is installed again; once pnpm prunes the old folder the worker does not start at all.
 *
 * This module finds the service file the way Simlock names it, reads the paths it starts, and says
 * whether they are this Tapdance's. Where Tapdance starts the worker daemon (`worker start` and
 * `restart`, `host up`, `host resume`), a stale service is installed again (`daemon install`, which
 * rewrites the file and reloads the manager) instead of being started as it is. Simlock's config,
 * including the warm-spare settings, is not touched, and its device records are reconciled with
 * `doctor --fix` only (never reset), so the warm spares it learned are kept.
 */
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { TapdanceError } from "@tapdance/sdk";

export type ServiceManagerKind = "systemd" | "launchd";

export interface WorkerServiceFacts {
  platform: NodeJS.Platform;
  home: string;
  /** Simlock's root (SIMLOCK_HOME, or ~/.simlock). */
  simlockHome: string;
  env: Record<string, string | undefined>;
}

/** Where Simlock's `daemon install` puts the worker's service file (Simlock's `serviceDefinition`). */
export function workerServiceFile(f: WorkerServiceFacts): { manager: ServiceManagerKind; name: string; path: string } | undefined {
  const manager: ServiceManagerKind | undefined = f.platform === "linux" ? "systemd" : f.platform === "darwin" ? "launchd" : undefined;
  if (manager === undefined) return undefined;
  const base = "com.callstack.simlock.worker";
  const root = resolve(f.simlockHome);
  const name = root === join(f.home, ".simlock") ? base : `${base}.${createHash("sha256").update(root).digest("hex").slice(0, 6)}`;
  if (manager === "launchd") return { manager, name, path: join(f.home, "Library", "LaunchAgents", `${name}.plist`) };
  const configured = f.env["XDG_CONFIG_HOME"];
  const config = configured !== undefined && isAbsolute(configured) ? configured : join(f.home, ".config");
  return { manager, name, path: join(config, "systemd", "user", `${name}.service`) };
}

const unescapeXml = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");

/** The program and its first argument (Node and Simlock's daemon main) a service file starts. */
export function installedServicePaths(text: string, manager: ServiceManagerKind): { node?: string; main?: string } {
  let parts: string[] = [];
  if (manager === "systemd") {
    const line = text.split("\n").find((l) => l.startsWith("ExecStart="));
    parts = line?.slice("ExecStart=".length).trim().split(/\s+/).filter(Boolean) ?? [];
  } else {
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
    parts = [...args.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unescapeXml(m[1]!));
  }
  return { ...(parts[0] ? { node: parts[0] } : {}), ...(parts[1] ? { main: parts[1] } : {}) };
}

/** "simlock 0.5.0 (patch c76b69d8)" for a path inside pnpm's store, else the path itself. */
export function describeSimlockPath(path: string): string {
  const m = /simlock@([^/_]+)(?:_patch_hash=([0-9a-f]{8}))?/.exec(path);
  if (!m) return path;
  return `simlock ${m[1]}${m[2] ? ` (patch ${m[2]})` : " (unpatched)"}`;
}

export interface WorkerServiceCheck {
  /** none: no service installed; current: it starts this Tapdance's Simlock; stale: it does not. */
  state: "none" | "current" | "stale";
  path?: string;
  manager?: ServiceManagerKind;
  installed?: { node?: string; main?: string };
  wanted?: { node: string; main: string };
  /** Why it is stale, in words. */
  reasons?: string[];
}

/**
 * Compares the installed service with this Tapdance. Stale when it starts another Simlock daemon
 * (another version or patch folder), or a Node or Simlock that no longer exists. A different Node
 * that still exists is not a reason on its own: Simlock records whichever Node ran `daemon install`.
 */
export async function checkWorkerService(
  f: WorkerServiceFacts & { wanted: { node: string; main: string } },
  io: { readFile: (path: string) => Promise<string>; exists: (path: string) => Promise<boolean> },
): Promise<WorkerServiceCheck> {
  const file = workerServiceFile(f);
  if (file === undefined) return { state: "none" };
  let text: string;
  try {
    text = await io.readFile(file.path);
  } catch {
    return { state: "none" };
  }
  const installed = installedServicePaths(text, file.manager);
  const reasons: string[] = [];
  if (installed.main === undefined) reasons.push("the service file names no Simlock daemon");
  else if (resolve(installed.main) !== resolve(f.wanted.main)) {
    reasons.push(`it starts ${describeSimlockPath(installed.main)}, this Tapdance ships ${describeSimlockPath(f.wanted.main)}`);
  } else if (!(await io.exists(installed.main))) reasons.push(`its Simlock (${installed.main}) is gone`);
  if (installed.node !== undefined && !(await io.exists(installed.node))) reasons.push(`its Node (${installed.node}) is gone`);
  return { state: reasons.length > 0 ? "stale" : "current", path: file.path, manager: file.manager, installed, wanted: f.wanted, ...(reasons.length > 0 ? { reasons } : {}) };
}

/**
 * The Simlock command that starts the worker daemon: `daemon install` when the service is stale (it
 * rewrites the service file, reloads the manager and starts the daemon from this Tapdance's Simlock),
 * otherwise `daemon start`.
 */
export function workerStartArgs(check: WorkerServiceCheck): string[] {
  return check.state === "stale" ? ["daemon", "install"] : ["daemon", "start"];
}

/** Why the service is stale, as one sentence without a full stop. */
export function staleServiceReason(check: WorkerServiceCheck): string {
  return `The worker's login service (${check.path ?? "?"}) is out of date: ${(check.reasons ?? []).join("; ")}`;
}

/** The progress line for a stale service that is about to be installed again. */
export function staleServiceLine(check: WorkerServiceCheck): string {
  return `${staleServiceReason(check)}. Installing it again from this Tapdance; warm-spare settings and learned spares are kept.`;
}

/**
 * What `host up` does about a worker that already runs (#110): apply new warm-spare counts (that
 * restarts it), restart it to install a stale service again, or leave it alone. A stale service with
 * leases running is left with a warning, because a restart ends them.
 */
export function hostUpWorkerAction(o: { warm: boolean; service: WorkerServiceCheck; activeLeases: number }): "apply-warm" | "refresh-service" | "warn-stale-busy" | "leave" {
  if (o.warm) return "apply-warm";
  if (o.service.state !== "stale") return "leave";
  return o.activeLeases > 0 ? "warn-stale-busy" : "refresh-service";
}

/**
 * Installing a stale login service again over a non-interactive ssh command (#118). Simlock's
 * `daemon install` removes the old service file before it runs `systemctl --user daemon-reload`, so
 * when that has no user bus the worker is left with no login service. Tapdance therefore points
 * this process at the user manager and checks that `systemctl --user` answers *before* it stops the
 * worker; when the install still fails it starts the worker without the service, records that the
 * service is missing, and says so with the fix. Every effect goes through `ServiceRefreshIo`.
 */
export interface ServiceRefreshIo {
  platform: NodeJS.Platform;
  /** Linux: linger and the user manager's bus (prepareLinuxUserServices). Throws when there is none. */
  prepareUserServices: () => Promise<void>;
  /** Linux: whether `systemctl --user` reaches the user manager (a read-only call), with its output. */
  userManagerReachable: () => Promise<{ ok: boolean; out: string }>;
  /** Simlock's `daemon install`. */
  install: () => Promise<unknown>;
  /** Simlock's `daemon start` (no service), used when the install failed. */
  start: () => Promise<unknown>;
  serviceFileExists: () => Promise<boolean>;
  recordMissing: (record: MissingServiceRecord) => Promise<void>;
  clearMissing: () => Promise<void>;
  now?: () => Date;
}

/** Written to TAPDANCE_HOME when a refresh left the worker without its login service (#118). */
export interface MissingServiceRecord {
  path: string;
  failedAt: string;
  reason: string;
}

export const MISSING_SERVICE_FILE = "worker-service-missing.json";
export const SERVICE_FIX = "tapdance worker install --service";

/** Fails before anything is stopped or removed when the login service cannot be installed here. */
export async function precheckServiceRefresh(check: WorkerServiceCheck, io: Pick<ServiceRefreshIo, "platform" | "prepareUserServices" | "userManagerReachable">): Promise<void> {
  if (check.state !== "stale" || io.platform !== "linux") return;
  await io.prepareUserServices();
  const reach = await io.userManagerReachable();
  if (reach.ok) return;
  throw new TapdanceError(
    "HOST_CHECK_FAILED",
    `${staleServiceReason(check)}, but \`systemctl --user\` cannot reach this account's user manager (${firstLine(reach.out)}), so it cannot be installed again from here. Nothing was changed: the worker and its old login service are as they were`,
    {
      hint: `Run \`sudo loginctl enable-linger $USER\` (it starts the user manager and keeps it running), or log in over an interactive ssh session, then run \`${SERVICE_FIX}\`.`,
    },
  );
}

/**
 * Runs `daemon install`; on failure starts the worker without the service, records the missing
 * service when its file is gone, and throws an error that says so with the fix. A success clears
 * an earlier record.
 */
export async function installServiceOrReport(check: WorkerServiceCheck, io: ServiceRefreshIo): Promise<void> {
  try {
    await io.install();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const present = await io.serviceFileExists().catch(() => false);
    const started = await io.start().then(
      () => true,
      () => false,
    );
    const where = check.path ?? "the worker's login service";
    if (!present) await io.recordMissing({ path: where, failedAt: (io.now?.() ?? new Date()).toISOString(), reason }).catch(() => undefined);
    const state = started ? "the worker was started without it" : "the worker is stopped";
    throw new TapdanceError(
      "HOST_CHECK_FAILED",
      present
        ? `Installing the worker's login service again failed (${reason}); ${state}`
        : `Installing the worker's login service again failed (${reason}). The login service is now missing (${where} was removed): ${state}, and it will not start at boot or keep running after you log out`,
      {
        hint: `Run \`${SERVICE_FIX}\` to install it again${io.platform === "linux" ? " (if it says no user manager runs, run `sudo loginctl enable-linger $USER` first)" : ""}.`,
      },
    );
  }
  await io.clearMissing().catch(() => undefined);
}

/**
 * The warning for a worker that runs without the login service an earlier refresh failed to
 * install (#118), or undefined. `record` is the saved record; `check` is the service now.
 */
export function missingServiceWarning(record: MissingServiceRecord | undefined, check: WorkerServiceCheck): string | undefined {
  if (record === undefined || check.state !== "none") return undefined;
  return `The worker has no login service (${record.path}): installing it again failed at ${record.failedAt} (${firstLine(record.reason)}), so the worker does not start at boot or keep running after you log out. Run \`${SERVICE_FIX}\`.`;
}

/** Parses the saved record; undefined when there is none or it is not one. */
export function parseMissingServiceRecord(text: string | undefined): MissingServiceRecord | undefined {
  if (text === undefined) return undefined;
  try {
    const r = JSON.parse(text) as Partial<MissingServiceRecord>;
    return typeof r.path === "string" && typeof r.failedAt === "string" && typeof r.reason === "string" ? { path: r.path, failedAt: r.failedAt, reason: r.reason } : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  return (text.trim().split("\n")[0] ?? "").slice(0, 300) || "no output";
}
