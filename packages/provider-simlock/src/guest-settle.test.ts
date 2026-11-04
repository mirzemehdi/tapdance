import { describe, expect, it } from "vitest";
import { busyBetween, dialogAdvice, dialogFromDumpsys, dialogInNodes, fallingTrend, parseGuestState, SETTLED_SAMPLES, settleGuest } from "./guest-settle.js";

const ANR_FOCUS = "  mCurrentFocus=Window{4f2a1c u0 Application Not Responding: com.android.systemui}";
const APP_FOCUS = "  mCurrentFocus=Window{9b1e u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity}";
/** One probe answer: boot flag, /proc/stat's first line (busy and idle jiffies), the focus line. */
const probe = (booted: boolean, total: number, idle: number, focus = APP_FOCUS) => `${booted ? "1" : ""}\ncpu  ${total - idle} 0 0 ${idle} 0 0 0 0 0 0\n${focus}\n`;

/**
 * Probe answers whose CPU counters advance by 1000 jiffies per read, busy for the given share of each
 * interval (the first answer is the starting point).
 */
const loads = (shares: number[], start = 0) => {
  let total = start;
  let idle = start;
  return [probe(true, total, idle), ...shares.map((b) => ((total += 1000), (idle += Math.round(1000 * (1 - b))), probe(true, total, idle)))];
};

/** A fake clock and probe sequence: each call to the probe returns the next answer (MOCKED device). */
function scripted(answers: string[]) {
  let t = 0;
  const calls = { probes: 0, dismissed: 0, progress: [] as string[] };
  return {
    calls,
    deps: {
      probe: async () => answers[Math.min(calls.probes++, answers.length - 1)]!,
      dismiss: async () => (calls.dismissed++, true),
      progress: (m: string) => calls.progress.push(m),
      sleep: async (ms: number) => void (t += ms),
      now: () => t,
    },
  };
}

describe("guest settle (#79)", () => {
  it("parses the boot flag, CPU counters and an ANR dialog", () => {
    expect(parseGuestState(probe(true, 1000, 900))).toEqual({ booted: true, cpu: { total: 1000, idle: 900 } });
    expect(parseGuestState(probe(false, 10, 1, ANR_FOCUS))).toEqual({ booted: false, cpu: { total: 10, idle: 1 }, dialog: { kind: "not-responding", app: "com.android.systemui" } });
    expect(dialogFromDumpsys("mCurrentFocus=Window{1 u0 Application Error: com.google.android.gms}")).toEqual({ kind: "crashed", app: "com.google.android.gms" });
    expect(dialogFromDumpsys(APP_FOCUS)).toBeUndefined();
    expect(busyBetween(parseGuestState(probe(true, 1000, 900)), parseGuestState(probe(true, 2000, 1100)))).toBeCloseTo(0.8);
    expect(busyBetween(parseGuestState(probe(true, 1000, 900)), parseGuestState("1\n"))).toBeUndefined();
  });

  it("hands a calm device out after three calm intervals in a row, saying nothing (#101)", async () => {
    expect(SETTLED_SAMPLES).toBe(3);
    const s = scripted(loads([0.1, 0.1, 0.1]));
    expect(await settleGuest(s.deps)).toMatchObject({ settled: true, notices: [], reason: "calm", busy: 0.1 });
    expect(s.calls.probes).toBe(4);
    expect(s.calls.progress).toEqual([]);
  });

  it("waits while the guest is busy, then hands it out once it is calm", async () => {
    const s = scripted(loads([0.98, 0.98, 0.1, 0.1, 0.1]));
    const r = await settleGuest(s.deps);
    expect(r).toMatchObject({ settled: true, notices: [], reason: "calm" });
    expect(s.calls.progress[0]).toMatch(/Waiting for the device to settle \(guest CPU 98 %/);
    expect(s.calls.progress.at(-1)).toMatch(/^Settled \(guest CPU 10 %; waited \d+ s\)$/);
  });

  it("one calm interval in a bursty load does not end the wait (#101: B1 and A4 went out at 91-96 %)", async () => {
    // busy, one quiet gap, busy again, two calm, busy, then three calm in a row.
    const s = scripted(loads([0.96, 0.3, 0.95, 0.92, 0.2, 0.2, 0.93, 0.2, 0.2, 0.2]));
    const r = await settleGuest(s.deps);
    expect(r).toMatchObject({ settled: true, reason: "calm" });
    expect(s.calls.probes).toBe(11);
  });

  it("hands a device out with a short notice when its load is clearly falling (#101)", async () => {
    const s = scripted(loads([0.95, 0.92, 0.9, 0.6, 0.55, 0.5, 0.6, 0.55, 0.5]));
    const r = await settleGuest(s.deps);
    expect(r).toMatchObject({ settled: true, reason: "falling" });
    expect(s.calls.probes).toBe(7);
    expect(r.notices[0]).toMatch(/still finishing its start-up work \(guest CPU 55 %, down from 92 %\).*about another minute/);
    expect(s.calls.progress.at(-1)).toMatch(/^Handing the device out while its load falls/);
  });

  it("tells a falling load from a bursty one", () => {
    expect(fallingTrend([0.95, 0.92, 0.9, 0.6, 0.55, 0.5])).toEqual({ recent: expect.closeTo(0.55), older: expect.closeTo(0.923, 2) });
    // A recent reading above the lowest older one: bursty, not falling.
    expect(fallingTrend([0.95, 0.5, 0.9, 0.6, 0.55, 0.4])).toBeUndefined();
    // Falling but still too busy.
    expect(fallingTrend([1, 1, 1, 0.75, 0.7, 0.7])).toBeUndefined();
    // Too few readings.
    expect(fallingTrend([0.9, 0.9, 0.2, 0.2])).toBeUndefined();
  });

  it("answers an \"isn't responding\" dialog with Wait, then measures afresh", async () => {
    const s = scripted([probe(true, 0, 0, ANR_FOCUS), ...loads([0.1, 0.1, 0.1], 100)]);
    expect(await settleGuest(s.deps)).toMatchObject({ settled: true });
    expect(s.calls.dismissed).toBe(1);
    expect(s.calls.progress[0]).toMatch(/"System UI isn't responding" dialog with Wait/);
  });

  it("hands a device that stays busy out after the budget, with a notice that says how busy and for how long", async () => {
    const answers = Array.from({ length: 100 }, (_, i) => probe(true, i * 1000, i * 10));
    const s = scripted(answers);
    const r = await settleGuest({ ...s.deps, budgetMs: 10_000 });
    expect(r).toMatchObject({ settled: false, reason: "bound", busy: 0.99 });
    expect(r.notices[0]).toMatch(/still busy with its start-up work after 1\d s \(guest CPU 99 % at the last reading, 99 % over the last 3\)/);
    expect(r.notices[0]).toMatch(/2-10 s each for up to a few more minutes/);
  });

  it("names a dialog that would not close, and skips the wait when the probe is refused", async () => {
    const stuck = scripted([probe(true, 0, 0, ANR_FOCUS)]);
    const r = await settleGuest({ ...stuck.deps, dismiss: async () => false, budgetMs: 5_000 });
    expect(r.notices[0]).toMatch(/"System UI isn't responding" covers the screen.*android:id\/aerr_wait/);
    // An older worker guard refuses the probe: the lease goes on as before.
    expect(await settleGuest({ probe: async () => Promise.reject(new Error("FORBIDDEN")), dismiss: async () => false })).toMatchObject({ settled: false, skipped: true, notices: [] });
  });

  it("finds an ANR or crash dialog among snapshot nodes (#80)", () => {
    const anr = [
      { ref: "e1", label: "System UI isn't responding", identifier: "android:id/alertTitle" },
      { ref: "e2", label: "Close app", identifier: "android:id/aerr_close" },
      { ref: "e3", label: "Wait", identifier: "android:id/aerr_wait" },
    ];
    expect(dialogInNodes(anr)).toEqual({ title: "System UI isn't responding", crashed: false });
    expect(dialogInNodes([{ label: "Pianolune keeps stopping" }, { identifier: "android:id/aerr_close" }])).toEqual({ title: "Pianolune keeps stopping", crashed: true });
    expect(dialogInNodes([{ identifier: "android:id/button1" }, { identifier: "com.example:id/ok" }])).toBeUndefined();
    expect(dialogAdvice({ title: "System UI isn't responding", crashed: false })).toMatch(/tap Wait .*or Close app/);
    expect(dialogAdvice({ kind: "crashed", app: "com.example" })).not.toMatch(/Wait/);
  });
});
