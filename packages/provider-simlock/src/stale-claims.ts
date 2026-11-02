import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface StaleClaimReport {
  /** Devices whose stale claim was released ("local:android:none:emulator-5588"). */
  released: string[];
  /** Claims agent-device kept, with its reason. */
  retained: Array<{ device: string; reason: string }>;
  /** Unfinished screen recordings of dead sessions that were set aside so their claims could go. */
  abandonedRecordings: string[];
}

interface ReleaseEntry {
  deviceKey?: string;
  classification?: string;
  session?: string;
  reason?: string;
}

export interface StaleClaimOptions {
  /** Simlock's home (default $SIMLOCK_HOME or ~/.simlock). */
  simlockHome?: string;
  timeoutMs?: number;
}

/** The agent-device CLI that ships with Tapdance (and that Simlock runs its daemon from). */
export function agentDeviceCli(): string {
  // agent-device is ESM-only (an "import" export condition), so require.resolve cannot find it.
  const entry = fileURLToPath(import.meta.resolve("agent-device"));
  return join(dirname(entry), "..", "..", "bin", "agent-device.mjs");
}

export function simlockHomeDir(): string {
  return process.env["SIMLOCK_HOME"] ?? join(homedir(), ".simlock");
}

/**
 * Releases device claims left behind by a dead agent-device daemon, on the machine that runs the
 * worker.
 *
 * A claim belongs to the daemon process that opened the session. When that process goes (a worker
 * restart, the Mac going offline mid-lease) the claim stays on disk, keyed by the device serial, and
 * the next lease of that device fails with "owned by session …". agent-device releases provably stale
 * claims itself, but keeps any whose session left a screen recording unfinished: that recording died
 * with its daemon and can never complete. Only for a claim whose owner process is provably dead, this
 * renames that recording record (to `*.abandoned-<time>`, kept for inspection) and releases again.
 * Live and uncertain owners are never touched.
 */
export async function releaseStaleDeviceClaims(options: StaleClaimOptions = {}): Promise<StaleClaimReport> {
  const home = resolve(options.simlockHome ?? simlockHomeDir());
  const stateDir = join(home, "agent-device");
  const claimsDir = join(stateDir, "device-claims");
  const report: StaleClaimReport = { released: [], retained: [], abandonedRecordings: [] };
  if (!existsSync(claimsDir) || (await readdir(claimsDir)).filter((f) => f.endsWith(".json")).length === 0) return report;

  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_DEVICE_STATE_DIR: stateDir, AGENT_DEVICE_CLAIMS_DIR: claimsDir };
  // Simlock runs its own adb server; settling a claim must talk to that one.
  try {
    const adb = JSON.parse(await readFile(join(home, "adb-server.json"), "utf8")) as { port?: unknown };
    if (typeof adb.port === "number") env["ANDROID_ADB_SERVER_PORT"] = String(adb.port);
  } catch {
    // No Simlock adb server recorded: agent-device uses the default one.
  }
  const run = async (): Promise<{ released: ReleaseEntry[]; retained: ReleaseEntry[] }> => {
    const { stdout } = await exec(process.execPath, [agentDeviceCli(), "device", "release", "--stale", "--json"], {
      env,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { data?: { released?: ReleaseEntry[]; retained?: ReleaseEntry[] } };
    return { released: parsed.data?.released ?? [], retained: parsed.data?.retained ?? [] };
  };

  let result = await run();
  report.released.push(...result.released.map((e) => e.deviceKey ?? "unknown"));
  const sessionsDir = join(stateDir, "sessions");
  for (const entry of result.retained) {
    if (entry.classification !== "owner-process-dead" || !entry.session || !/^screen-recording-/.test(entry.reason ?? "")) continue;
    const dir = resolve(sessionsDir, entry.session.replace(/:/g, "_"));
    if (!dir.startsWith(sessionsDir + sep)) continue;
    const record = join(dir, "screen-recording.resource.json");
    if (!existsSync(record)) continue;
    await rename(record, `${record}.abandoned-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    report.abandonedRecordings.push(entry.session);
  }
  if (report.abandonedRecordings.length > 0) {
    result = await run();
    report.released.push(...result.released.map((e) => e.deviceKey ?? "unknown"));
  }
  report.retained = result.retained.map((e) => ({ device: e.deviceKey ?? "unknown", reason: e.reason ?? "unknown" }));
  return report;
}
