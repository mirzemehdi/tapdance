import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tapdance, sanitizeSessionId, type DeviceSummary, type LeaseOptions } from "@tapdance/sdk";
import { Output, bold, cyan, dim, kv } from "./output.js";

export interface GlobalOptions {
  json?: boolean;
  config?: string;
  session?: string;
  quiet?: boolean;
}

export function output(opts: GlobalOptions): Output {
  return new Output(Boolean(opts.json), Boolean(opts.quiet));
}

export async function open(opts: GlobalOptions, out: Output, extra: { fleet?: boolean; owner?: "cli" | "cli-hold" } = {}): Promise<Tapdance> {
  return Tapdance.create({
    owner: extra.owner ?? "cli",
    ...(extra.fleet ? { fleet: true } : {}),
    ...(opts.config ? { configPath: opts.config } : {}),
    ...(opts.session ? { session: { id: sanitizeSessionId(opts.session), source: "--session" } } : {}),
    onProgress: (m) => out.progress(m),
  });
}

/**
 * Leases and prints the lease's notices as warnings the moment the provider knows them, not when the
 * lease returns: on Android the settle wait's "still busy" notice came 6-9 s late otherwise (field run
 * 2d). Notices the provider did not hand over early are printed when the lease returns. Used by
 * `device lease` and `host up`'s self-test.
 */
export async function leaseWithNotices(t: Pick<Tapdance, "lease">, options: Omit<LeaseOptions, "onNotice">, out: Pick<Output, "warn">): ReturnType<Tapdance["lease"]> {
  const printed = new Set<string>();
  const result = await t.lease({
    ...options,
    onNotice: (notice) => {
      if (printed.has(notice)) return;
      printed.add(notice);
      out.warn(notice);
    },
  });
  for (const notice of result.notices ?? []) if (!printed.has(notice)) out.warn(notice);
  return result;
}

/** Runs a command body with one Tapdance instance and uniform error handling / exit codes. */
export async function run(
  opts: GlobalOptions,
  body: (t: Tapdance, out: Output) => Promise<void>,
  extra: { fleet?: boolean; owner?: "cli" | "cli-hold" } = {},
): Promise<void> {
  const out = output(opts);
  let tapdance: Tapdance | undefined;
  try {
    tapdance = await open(opts, out, extra);
    await body(tapdance, out);
  } catch (error) {
    process.exitCode = out.error(error);
  } finally {
    await tapdance?.close().catch(() => undefined);
  }
}

export const CLI_ENTRY = fileURLToPath(new URL("./main.js", import.meta.url));

const require = createRequire(import.meta.url);

/** The Simlock CLI that ships with Tapdance, so workers need no separate global install. */
export function simlockBin(): string {
  const client = require.resolve("simlock/client");
  return join(dirname(client), "..", "cli", "main.js");
}

/** The agent-device CLI that ships with Tapdance; Simlock runs its daemon from this path. */
export function agentDeviceBin(): string {
  // agent-device is ESM-only (an "import" export condition), so require.resolve cannot find it.
  const entry = fileURLToPath(import.meta.resolve("agent-device"));
  return join(dirname(entry), "..", "..", "bin", "agent-device.mjs");
}

/** Starts the detached keepalive process for this session and returns its pid. */
export function spawnKeepalive(tapdance: Tapdance, opts: GlobalOptions): number | undefined {
  const child = spawn(process.execPath, [CLI_ENTRY, "__keepalive", ...(opts.config ? ["--config", opts.config] : [])], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, TAPDANCE_SESSION_ID: tapdance.sessionId },
  });
  child.unref();
  return child.pid;
}

export function describeLocation(d: DeviceSummary): string {
  const loc = d.location;
  if (loc.kind === "local") return "Local worker (this machine)";
  if (loc.kind === "cloud") return "Tapdance Cloud";
  return `Remote worker${loc.workerLabel ? ` "${loc.workerLabel}"` : loc.workerId ? ` ${loc.workerId}` : ""}`;
}

export function renderDevice(d: DeviceSummary, extra: Array<[string, string | undefined]> = []): string {
  const secure = d.location.endpoint.startsWith("https://") ? "TLS" : d.location.kind === "local" ? "loopback" : "private network (no TLS)";
  const mins = Math.max(0, Math.round((Date.parse(d.expiresAt) - Date.now()) / 60_000));
  return kv([
    ["Device", bold(d.model)],
    ["Platform", `${d.platform === "ios" ? "iOS" : "Android"} ${d.osVersion}`],
    ["Provider", describeLocation(d)],
    ["Worker", d.location.workerLabel ?? d.location.workerId ?? (d.location.kind === "local" ? "this machine" : undefined)],
    ["Endpoint", `${d.location.endpoint}${d.location.target ? ` (target ${d.location.target})` : ""} ${dim(`(${secure})`)}`],
    ["Status", d.state === "active" ? cyan("Ready") : d.state],
    ["Lease", `${d.leaseId} ${dim(`expires in ~${mins} min`)}`],
    ["Recording", d.recording],
    ["Human control", d.humanHoldUntil ? `held until ${d.humanHoldUntil}` : undefined],
    ...extra,
  ]);
}
