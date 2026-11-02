import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listCrashReports, readCrashReport, summarizeCrash } from "./crash-reports.js";

const UDID = "2BAC63C2-803F-4A80-AAA5-457DAF09EC13";
const report = (udid: string) =>
  `${JSON.stringify({ app_name: "Pianolune", bundleID: "com.measify.pianolune", app_version: "1.0.0" })}\n${JSON.stringify(
    {
      exception: { type: "EXC_BREAKPOINT", signal: "SIGTRAP" },
      procPath: `\\/Users\\/USER\\/Library\\/Developer\\/CoreSimulator\\/Devices\\/${udid}\\/data`,
      faultingThread: 7,
      threads: [{}, {}, {}, {}, {}, {}, {}, { frames: [{ imageIndex: 0, symbol: "_dispatch_assert_queue_fail", symbolLocation: 104 }, { imageIndex: 1, symbol: "kfun:com.measify.pianolune.util.file#shareFileCommon" }] }],
      usedImages: [{ name: "libdispatch.dylib" }, { name: "Pianolune.debug.dylib" }],
    },
    null,
    2,
  )}`;

describe("iOS crash reports (#59)", () => {
  it("lists only the leased simulator's reports since the lease began, newest first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "td-ips-"));
    await writeFile(join(dir, "Pianolune-1.ips"), report(UDID));
    await writeFile(join(dir, "Pianolune-2.ips"), report(UDID));
    await writeFile(join(dir, "Pianolune-old.ips"), report(UDID));
    await writeFile(join(dir, "Other.ips"), report("00000000-0000-0000-0000-000000000000"));
    await writeFile(join(dir, "notes.txt"), UDID);
    const now = Date.now() / 1000;
    await utimes(join(dir, "Pianolune-1.ips"), now - 20, now - 20);
    await utimes(join(dir, "Pianolune-2.ips"), now - 10, now - 10);
    await utimes(join(dir, "Pianolune-old.ips"), now - 7200, now - 7200);
    const filter = { udid: UDID, since: Date.now() - 3_600_000 };
    expect((await listCrashReports(dir, filter)).map((r) => r.name)).toEqual(["Pianolune-2.ips", "Pianolune-1.ips"]);
    expect(await listCrashReports(dir, { ...filter, bundleId: "com.other" })).toEqual([]);
    expect((await readCrashReport(dir, "latest", filter)).name).toBe("Pianolune-2.ips");
    await expect(readCrashReport(dir, "Other.ips", filter)).rejects.toThrow(/No crash report/);
    await expect(readCrashReport(dir, "Pianolune-old.ips", filter)).rejects.toThrow(/No crash report/);
  });

  it("summarizes the exception and the crashed thread, saying when it is not the main thread", () => {
    const lines = summarizeCrash(report(UDID));
    expect(lines[0]).toBe("Exception: EXC_BREAKPOINT (SIGTRAP)");
    expect(lines[1]).toBe("Crashed thread 7 (not the main thread):");
    expect(lines[2]).toContain("libdispatch.dylib");
    expect(lines[2]).toContain("_dispatch_assert_queue_fail+104");
    expect(lines[3]).toContain("shareFileCommon");
  });
});
