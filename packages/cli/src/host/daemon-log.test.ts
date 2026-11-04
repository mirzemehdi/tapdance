/** #111: `tapdance worker logs` filters. MOCKED: log text is built in memory; no ~/.simlock is read. */
import { describe, expect, it } from "vitest";
import { MAX_WORKER_LOG_LINES, parseSince, readDaemonLogs, selectDaemonLogLines } from "./daemon-log.js";

const rec = (timestamp: number, message: string) => JSON.stringify({ timestamp, level: "info", module: "daemon", message });

describe("worker daemon log (#111; in-memory log files)", () => {
  // The baseline line, then 150 settle-wait lines that pushed it out of Simlock's 100-line window.
  const rotated = [rec(1_000, "old line"), rec(2_000, "older baseline: Capturing the Android clean baseline")].join("\n");
  const current = [rec(10_000, "Capturing the Android clean baseline"), ...Array.from({ length: 150 }, (_, i) => rec(11_000 + i, `device.exec ${i}`)), "plain stderr line"].join("\n") + "\n";

  it("keeps the last n lines, across the rotated file", () => {
    expect(selectDaemonLogLines([rotated, current], { lines: 3 })).toEqual([rec(11_148, "device.exec 148"), rec(11_149, "device.exec 149"), "plain stderr line"]);
    expect(selectDaemonLogLines([rotated, current], { lines: 5000 })).toHaveLength(2 + 1 + 150 + 1);
    expect(MAX_WORKER_LOG_LINES).toBe(5000);
  });

  it("finds the baseline line however many lines came after it, case-insensitively", () => {
    const found = selectDaemonLogLines([rotated, current], { lines: 100, contains: "CLEAN BASELINE" });
    expect(found).toEqual([rec(2_000, "older baseline: Capturing the Android clean baseline"), rec(10_000, "Capturing the Android clean baseline")]);
    expect(selectDaemonLogLines([rotated, current], { lines: 1, contains: "clean baseline" })).toEqual([rec(10_000, "Capturing the Android clean baseline")]);
  });

  it("--since drops older records; a plain-text line goes with the record before it", () => {
    const lines = selectDaemonLogLines([rotated, current], { lines: 5000, sinceMs: 11_148 });
    expect(lines).toEqual([rec(11_148, "device.exec 148"), rec(11_149, "device.exec 149"), "plain stderr line"]);
    expect(selectDaemonLogLines(["no timestamps here"], { lines: 10, sinceMs: 0 })).toEqual([]);
  });

  it("parses --since as a duration or an ISO time and refuses anything else", () => {
    const now = Date.parse("2026-11-04T22:16:00Z");
    expect(parseSince("30s", now)).toBe(now - 30_000);
    expect(parseSince("10m", now)).toBe(now - 600_000);
    expect(parseSince("2h", now)).toBe(now - 7_200_000);
    expect(parseSince("1d", now)).toBe(now - 86_400_000);
    expect(parseSince("2026-11-04T21:54:00Z", now)).toBe(Date.parse("2026-11-04T21:54:00Z"));
    for (const bad of ["", "10", "5 minutes", "yesterday", "2026-13-45"]) expect(() => parseSince(bad, now)).toThrow(/--since must be/);
  });

  it("reads daemon.log.1 then daemon.log; a missing file is empty", async () => {
    const files: Record<string, string> = { "/s/daemon.log": "b" };
    const r = await readDaemonLogs("/s", async (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p]!;
    });
    expect(r).toEqual({ files: ["", "b"], path: "/s/daemon.log" });
  });
});
