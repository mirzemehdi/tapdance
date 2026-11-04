/**
 * `tapdance worker logs` (#111): the worker daemon's log, read straight from Simlock's `daemon.log`
 * (and `daemon.log.1`, the file Simlock rotates it to at 5 MB), so it can show more than the 100
 * lines `simlock daemon logs` prints and filter them like `tapdance logs` does.
 *
 * Simlock writes one JSON record per line (`{"timestamp": <ms>, "level", "module", "message",
 * "fields"}`); the service manager appends the daemon's own stdout and stderr to the same file, so a
 * line may also be plain text.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TapdanceError } from "@tapdance/sdk";

export const DEFAULT_WORKER_LOG_LINES = 100;
export const MAX_WORKER_LOG_LINES = 5000;
const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * `--since`: a duration back from now (`30s`, `10m`, `2h`, `1d`) or an ISO date/time
 * (`2026-11-04T21:54:00Z`). Returns the cut-off in ms since the epoch.
 */
export function parseSince(value: string, now: number): number {
  const relative = /^(\d{1,6})\s*([smhd])$/i.exec(value.trim());
  if (relative) return now - Number(relative[1]) * UNITS[relative[2]!.toLowerCase()]!;
  if (/^\d{4}-\d{2}-\d{2}/.test(value.trim())) {
    const at = Date.parse(value.trim());
    if (Number.isFinite(at)) return at;
  }
  throw new TapdanceError("USAGE", `--since must be a duration such as 30s, 10m, 2h or 1d, or an ISO time such as 2026-11-04T21:54:00Z, not "${value}"`);
}

/** The record's time, or undefined for a plain-text line. */
function lineTime(line: string): number | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const t = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
    return typeof t === "number" && Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The last `lines` lines of the log files (oldest file first) that pass the filters: `contains`
 * (case-insensitive, like `tapdance logs`) and `sinceMs` (a plain-text line counts as the time of
 * the record before it).
 */
export function selectDaemonLogLines(files: string[], o: { lines: number; contains?: string; sinceMs?: number }): string[] {
  const needle = o.contains?.toLowerCase();
  const kept: string[] = [];
  let lastTime: number | undefined;
  for (const text of files) {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      lastTime = lineTime(line) ?? lastTime;
      if (o.sinceMs !== undefined && (lastTime === undefined || lastTime < o.sinceMs)) continue;
      if (needle !== undefined && !line.toLowerCase().includes(needle)) continue;
      kept.push(line);
    }
  }
  return kept.slice(-o.lines);
}

/** Reads `daemon.log.1` and `daemon.log` from the worker's data directory (missing files are empty). */
export async function readDaemonLogs(dataDirectory: string, read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")): Promise<{ files: string[]; path: string }> {
  const path = join(dataDirectory, "daemon.log");
  const files = await Promise.all([`${path}.1`, path].map((p) => read(p).catch(() => "")));
  return { files, path };
}
