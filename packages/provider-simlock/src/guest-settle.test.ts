import { describe, expect, it, vi } from "vitest";
import { BUSY_EXIT_CPU, BUSY_EXIT_SAMPLES, busyBetween, busyFromTheStart, DEFAULT_CPU_CHECK_MS, dialogAdvice, dialogFromDumpsys, dialogInNodes, fallingTrend, parseGuestState, SETTLED_SAMPLES, settleAndWarmUp, settleGuest, type SettleResult } from "./guest-settle.js";

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

describe("guest settle (#79, #101; MOCKED probe and clock)", () => {
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

  /** A guest that stays 99 % busy on every read. */
  const busyForever = () => Array.from({ length: 400 }, (_, i) => probe(true, i * 1000, i * 10));
  /** A guest that stays 70 % busy on every read: busy, but below the early busy exit's 80 %. */
  const busyBelowExit = () => Array.from({ length: 400 }, (_, i) => probe(true, i * 1000, i * 300));

  it("early busy exit: with the default check, readings high and not falling from the start hand the device out at once (#101, field run 2d)", async () => {
    expect(DEFAULT_CPU_CHECK_MS).toBe(15_000);
    expect(BUSY_EXIT_CPU).toBe(0.8);
    expect(BUSY_EXIT_SAMPLES).toBe(3);
    const s = scripted(busyForever());
    const r = await settleGuest(s.deps);
    expect(r).toMatchObject({ settled: false, reason: "busy", busy: 0.99 });
    // Three readings (four probes, 1.5 s apart): about 4.5 s instead of the full 15 s.
    expect(s.calls.probes).toBe(4);
    expect(r.waitedMs).toBe(4_500);
    expect(r.notices[0]).toMatch(/still busy with its start-up work after 5 s \(guest CPU 99 % at the last reading, 99 % over the last 3\)/);
    expect(r.notices[0]).toMatch(/may be slower, 2-10 s each, for a few more minutes/);
    expect(r.notices[0]).toMatch(/raise session\.settleSeconds/);
    expect(s.calls.progress[0]).toMatch(/Waiting for the device to settle \(guest CPU 99 %; \d s, at most 15 s\)/);
    expect(s.calls.progress.at(-1)).toMatch(/^Handing the device out while it is still busy \(guest CPU 99 % over the first 3 readings, not falling; waited 5 s\)$/);
    // An explicit value at or below the default exits early too.
    const short = scripted(busyForever());
    expect(await settleGuest({ ...short.deps, cpuBudgetMs: 10_000 })).toMatchObject({ reason: "busy" });
  });

  it("early busy exit only for readings that are all high and not falling", () => {
    expect(busyFromTheStart([0.96, 0.94, 0.97])).toBe(true);
    // A few points down at every reading, as noise does: still busy.
    expect(busyFromTheStart([0.96, 0.95, 0.94])).toBe(true);
    // Too few readings, one below 80 %, down by more than 10 points, or steadily down.
    expect(busyFromTheStart([0.96, 0.95])).toBe(false);
    expect(busyFromTheStart([0.96, 0.79, 0.97])).toBe(false);
    expect(busyFromTheStart([0.99, 0.9, 0.85])).toBe(false);
    expect(busyFromTheStart([0.95, 0.92, 0.9])).toBe(false);
  });

  it("without an early exit, the default check still runs its 15 s and hands a busy device out with a notice (#101 follow-up)", async () => {
    const s = scripted(busyBelowExit());
    const r = await settleGuest(s.deps);
    expect(r).toMatchObject({ settled: false, reason: "bound", busy: 0.7 });
    expect(r.waitedMs).toBeGreaterThanOrEqual(15_000);
    expect(r.waitedMs).toBeLessThan(17_000);
    expect(r.notices[0]).toMatch(/still busy with its start-up work after 15 s \(guest CPU 70 % at the last reading, 70 % over the last 3\)/);
  });

  it("starts the CPU check only once the guest has booted (#101 follow-up)", async () => {
    // 6 s of boot, then busy: the check still gets its 15 s after boot.
    const booting = Array.from({ length: 5 }, (_, i) => probe(false, i * 1000, i * 300));
    const s = scripted([...booting, ...busyBelowExit().map((p, i) => probe(true, (i + 5) * 1000, (i + 5) * 300))]);
    const r = await settleGuest(s.deps);
    expect(r).toMatchObject({ settled: false, reason: "bound" });
    expect(r.waitedMs).toBeGreaterThanOrEqual(21_000);
    expect(r.waitedMs).toBeLessThan(24_000);
  });

  it("a configured larger value waits longer for a calm device (session.settleSeconds)", async () => {
    // Busy for 40 s, then calm: the default goes out busy, 60 s waits it out.
    const busyThenCalm = (() => {
      let total = 0;
      let idle = 0;
      return Array.from({ length: 60 }, (_, i) => ((total += 1000), (idle += i < 27 ? 10 : 900), probe(true, total, idle)));
    })();
    // The default leaves at once on the early busy exit (#101, field run 2d) ...
    const short = scripted(busyThenCalm);
    expect(await settleGuest(short.deps)).toMatchObject({ settled: false, reason: "busy", waitedMs: 4_500 });
    // ... while a user-set longer value (60 s) still waits the busy phase out: no early busy exit.
    const long = scripted(busyThenCalm);
    const r = await settleGuest({ ...long.deps, cpuBudgetMs: 60_000 });
    // The sudden drop ends it as a falling load, or as a calm run.
    expect(r.settled).toBe(true);
    expect(["calm", "falling"]).toContain(r.reason);
    expect(r.waitedMs).toBeGreaterThan(40_000);
    // And one that stays busy goes out at the larger bound.
    const stays = scripted(busyForever());
    const bound = await settleGuest({ ...stays.deps, cpuBudgetMs: 60_000 });
    expect(bound).toMatchObject({ settled: false, reason: "bound" });
    expect(bound.waitedMs).toBeGreaterThanOrEqual(60_000);
    expect(bound.waitedMs).toBeLessThan(62_000);
  });

  it("0 skips the CPU check but still waits for boot and answers a dialog (session.settleSeconds 0)", async () => {
    // Busy, but booted with nothing in front: handed out at the first read.
    const busy = scripted(busyForever());
    expect(await settleGuest({ ...busy.deps, cpuBudgetMs: 0 })).toMatchObject({ settled: true, reason: "ready", notices: [] });
    expect(busy.calls.probes).toBe(1);
    // Not booted, then an ANR dialog, then ready: both are waited for.
    const s = scripted([probe(false, 0, 0), probe(false, 1000, 10), probe(true, 2000, 20, ANR_FOCUS), probe(true, 3000, 30)]);
    const r = await settleGuest({ ...s.deps, cpuBudgetMs: 0 });
    expect(r).toMatchObject({ settled: true, reason: "ready", notices: [] });
    expect(s.calls.dismissed).toBe(1);
    expect(s.calls.probes).toBe(4);
    // A dialog that will not close is still named.
    const stuck = scripted([probe(true, 0, 0, ANR_FOCUS)]);
    const named = await settleGuest({ ...stuck.deps, cpuBudgetMs: 0, dismiss: async () => false, readyBudgetMs: 5_000 });
    expect(named).toMatchObject({ settled: false, reason: "bound" });
    expect(named.notices[0]).toMatch(/"System UI isn't responding" covers the screen/);
  });

  it("says nothing when the check ends calm without a full calm run", async () => {
    // Alternating, ending on two calm reads: no 3-in-a-row, but nothing busy to warn about.
    const s = scripted(loads([0.2, 0.6, 0.2, 0.2, 0.6, 0.2, 0.2, 0.6, 0.2, 0.2, 0.1]));
    const r = await settleGuest({ ...s.deps, cpuBudgetMs: 15_000 });
    expect(r).toMatchObject({ settled: true, reason: "bound", notices: [] });
  });

  it("names a dialog that would not close, and skips the wait when the probe is refused", async () => {
    const stuck = scripted([probe(true, 0, 0, ANR_FOCUS)]);
    const r = await settleGuest({ ...stuck.deps, dismiss: async () => false, readyBudgetMs: 5_000 });
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

describe("settle wait and snapshot-helper warm-up side by side (#101, #102, field run 2d; MOCKED settle and warm-up, FAKE clock)", () => {
  const busyResult: SettleResult = { settled: false, notices: ["The device is still busy"], waitedMs: 5_000, busy: 0.97, reason: "busy" };
  const after = <T,>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

  it("takes about the longer of the two, not their sum, and hands the notice over before the warm-up ends", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const t0 = Date.now();
      const at = (what: string) => events.push(`${Math.round((Date.now() - t0) / 1000)}s ${what}`);
      const done = settleAndWarmUp({
        // The guest reads ready at once; the CPU check takes 5 s.
        settle: async (hooks) => {
          hooks.onReady();
          at("settle start");
          const r = await after(5_000, busyResult);
          at("settle end");
          return r;
        },
        // The warm-up (a failed first read and the retry) takes 8 s.
        warmUp: async () => {
          at("warm-up start");
          await after(8_000, true);
          at("warm-up end");
        },
        warmUpBoundMs: 15_000,
        onNotice: (n) => at(`notice: ${n}`),
        progress: (m) => at(`progress: ${m}`),
      });
      let finished: number | undefined;
      void done.then(() => (finished = Date.now() - t0));
      await vi.advanceTimersByTimeAsync(7_999);
      expect(finished).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      // 8 s (the longer of 5 s and 8 s), not 13 s (their sum).
      expect(finished).toBe(8_000);
      expect(await done).toBe(busyResult);
      expect(events).toEqual(["0s warm-up start", "0s settle start", "5s settle end", "5s notice: The device is still busy", "8s warm-up end"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hanging warm-up holds the lease up only to its bound, with a progress line every 5 s", async () => {
    vi.useFakeTimers();
    try {
      const progress: string[] = [];
      const t0 = Date.now();
      let finished: number | undefined;
      const done = settleAndWarmUp({
        settle: async (hooks) => {
          hooks.onReady();
          return after(2_000, { settled: true, notices: [], waitedMs: 2_000, reason: "calm" } as SettleResult);
        },
        warmUp: () => new Promise(() => undefined),
        warmUpBoundMs: 15_000,
        progress: (m) => progress.push(m),
      });
      void done.then(() => (finished = Date.now() - t0));
      await vi.advanceTimersByTimeAsync(14_999);
      expect(finished).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toBe(15_000);
      expect(await done).toMatchObject({ settled: true, reason: "calm" });
      // 13 s of waiting after the settle wait: lines at 5 and 10 s, no silent gap longer than that.
      expect(progress).toHaveLength(2);
      expect(progress[0]).toMatch(/^Still reading the screen once so the first inspect is quick \(5 s more, at most 15 s in all\)$/);
    } finally {
      vi.useRealTimers();
    }
    // A warm-up that throws or rejects never fails the lease either.
    await expect(
      settleAndWarmUp({
        settle: async () => ({ settled: false, notices: [], waitedMs: 0, reason: "skipped", skipped: true }),
        warmUp: () => {
          throw new Error("boom");
        },
        warmUpBoundMs: 1_000,
      }),
    ).resolves.toMatchObject({ skipped: true });
    await expect(
      settleAndWarmUp({
        settle: async (h) => (h.onReady(), busyResult),
        warmUp: () => Promise.reject(new Error("offline")),
        warmUpBoundMs: 1_000,
      }),
    ).resolves.toBe(busyResult);
  });

  it("starts the warm-up only once the guest is ready, and answers a dialog only after it", async () => {
    const order: string[] = [];
    let finishWarmUp!: () => void;
    const warmUpGate = new Promise<void>((r) => (finishWarmUp = r));
    const result = await settleAndWarmUp({
      settle: async (hooks) => {
        order.push("dialog while booting: dismiss");
        await hooks.beforeDismiss(); // nothing running yet: no wait
        hooks.onReady();
        order.push("ready");
        const dismissing = hooks.beforeDismiss().then(() => order.push("dialog again: dismiss after the warm-up"));
        order.push("warm-up still running");
        finishWarmUp();
        await dismissing;
        return { settled: true, notices: [], waitedMs: 0, reason: "calm" };
      },
      warmUp: async () => {
        order.push("warm-up start");
        await warmUpGate;
        order.push("warm-up end");
      },
      warmUpBoundMs: 5_000,
    });
    expect(result.reason).toBe("calm");
    expect(order).toEqual(["dialog while booting: dismiss", "warm-up start", "ready", "warm-up still running", "warm-up end", "dialog again: dismiss after the warm-up"]);
  });

  it("starts the warm-up when the settle wait ends without a ready guest (probe refused)", async () => {
    let warmed = 0;
    await settleAndWarmUp({
      settle: async () => ({ settled: false, notices: [], waitedMs: 0, reason: "skipped", skipped: true }),
      warmUp: async () => void warmed++,
      warmUpBoundMs: 1_000,
    });
    expect(warmed).toBe(1);
  });

  it("settleGuest calls onReady once, at the first ready read, and beforeDismiss before a tap", async () => {
    let ready = 0;
    let waitedFor = 0;
    const s = scripted([probe(false, 0, 0), probe(true, 1000, 10, ANR_FOCUS), ...loads([0.1, 0.1, 0.1], 2000)]);
    await settleGuest({ ...s.deps, onReady: () => void ready++, beforeDismiss: async () => void waitedFor++ });
    expect(ready).toBe(1);
    expect(waitedFor).toBe(1);
    expect(s.calls.dismissed).toBe(1);
  });
});
