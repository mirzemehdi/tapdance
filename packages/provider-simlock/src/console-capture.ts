import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * An iOS app's stdout and stderr, captured on the Mac by `simctl launch --stdout --stderr` (#59).
 * `print` and Kotlin's `println` go to stdout, which the system log does not keep. One pair of files
 * per lease, chosen here and never by a client.
 */

const LEASE = /^[A-Za-z0-9_-]{1,128}$/;
/** How much of each file a read looks at: its last 4 MB. */
const TAIL_BYTES = 4 * 1024 * 1024;

export function consolePaths(dir: string, leaseId: string): { stdout: string; stderr: string } {
  if (!LEASE.test(leaseId)) throw new Error("unexpected lease id");
  return { stdout: join(dir, `${leaseId}.out.log`), stderr: join(dir, `${leaseId}.err.log`) };
}

/** Removes a lease's earlier capture, so a relaunch starts a fresh one. */
export async function clearConsole(dir: string, leaseId: string): Promise<void> {
  const p = consolePaths(dir, leaseId);
  await Promise.all([rm(p.stdout, { force: true }), rm(p.stderr, { force: true })]);
}

/** The last `lines` lines of the lease's captured stdout and stderr; `captured` is false before any `launch --console`. */
export async function readConsole(dir: string, leaseId: string, lines: number): Promise<{ stdout: string[]; stderr: string[]; captured: boolean }> {
  const p = consolePaths(dir, leaseId);
  const [stdout, stderr] = await Promise.all([tailLines(p.stdout, lines), tailLines(p.stderr, lines)]);
  return { stdout: stdout ?? [], stderr: stderr ?? [], captured: stdout !== undefined || stderr !== undefined };
}

async function tailLines(path: string, lines: number): Promise<string[] | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const start = Math.max(0, info.size - TAIL_BYTES);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const all = buffer.toString("utf8").split("\n").filter((l) => l.length > 0);
    return all.slice(-Math.max(1, Math.min(lines, 5000)));
  } finally {
    await handle.close();
  }
}
