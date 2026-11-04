import { describe, expect, it } from "vitest";
import { busyBetween, dialogAdvice, dialogFromDumpsys, dialogInNodes, parseGuestState, settleGuest } from "./guest-settle.js";

const ANR_FOCUS = "  mCurrentFocus=Window{4f2a1c u0 Application Not Responding: com.android.systemui}";
const APP_FOCUS = "  mCurrentFocus=Window{9b1e u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity}";
/** One probe answer: boot flag, /proc/stat's first line (busy and idle jiffies), the focus line. */
const probe = (booted: boolean, total: number, idle: number, focus = APP_FOCUS) => `${booted ? "1" : ""}\ncpu  ${total - idle} 0 0 ${idle} 0 0 0 0 0 0\n${focus}\n`;

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

  it("hands a calm device out after two reads, saying nothing", async () => {
    const s = scripted([probe(true, 1000, 900), probe(true, 1100, 990)]);
    expect(await settleGuest(s.deps)).toMatchObject({ settled: true, notices: [] });
    expect(s.calls.probes).toBe(2);
    expect(s.calls.progress).toEqual([]);
  });

  it("waits while the guest is busy, then hands it out once it is calm", async () => {
    const s = scripted([probe(true, 0, 0), probe(true, 1000, 20), probe(true, 2000, 40), probe(true, 3000, 900)]);
    const r = await settleGuest(s.deps);
    expect(r).toMatchObject({ settled: true, notices: [] });
    expect(s.calls.progress[0]).toMatch(/Waiting for the device to settle \(guest CPU 98 %/);
  });

  it("answers an \"isn't responding\" dialog with Wait, then measures afresh", async () => {
    const s = scripted([probe(true, 0, 0, ANR_FOCUS), probe(true, 100, 50), probe(true, 200, 150)]);
    expect(await settleGuest(s.deps)).toMatchObject({ settled: true });
    expect(s.calls.dismissed).toBe(1);
    expect(s.calls.progress[0]).toMatch(/"System UI isn't responding" dialog with Wait/);
  });

  it("hands a device that stays busy out after the budget, with a notice", async () => {
    const answers = Array.from({ length: 100 }, (_, i) => probe(true, i * 1000, i * 10));
    const s = scripted(answers);
    const r = await settleGuest({ ...s.deps, budgetMs: 10_000 });
    expect(r.settled).toBe(false);
    expect(r.notices[0]).toMatch(/still busy \(guest CPU 99 % after 1\d s\)/);
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
