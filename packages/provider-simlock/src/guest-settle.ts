/**
 * Waits for a just-leased Android emulator to settle (#79). A warm spare restored from Simlock's
 * baseline snapshot, or a guest rebooted by the previous release, can be handed out while it is still
 * starting: boot not complete, the CPU near 100 % for minutes (dexopt, Play services), and System UI
 * showing an "isn't responding" dialog over everything. Commands then take 10-25 s each.
 *
 * The probe is `deviceCommands.android.guestState()`: `sys.boot_completed`, the first line of
 * /proc/stat (two reads give the guest's CPU load) and the focused window. The guest counts as
 * settled after SETTLED_SAMPLES calm intervals in a row, or once its load clearly falls (#101).
 *
 * Not measured: the guest's /proc/stat may not show work the emulator does in host threads (software
 * rendering), so a calm guest can still mean a busy qemu process.
 */

/** One read of the probe. */
export interface GuestSample {
  booted: boolean;
  /** CPU time counters from /proc/stat: everything, and the idle part. */
  cpu?: { total: number; idle: number };
  /** An "isn't responding" or crash dialog that has the focus. */
  dialog?: SystemDialog;
}

export interface SystemDialog {
  kind: "not-responding" | "crashed";
  /** The package the dialog is about, e.g. com.android.systemui. */
  app: string;
}

/** The dialog in `mCurrentFocus` of `dumpsys window`, e.g. `Window{… u0 Application Not Responding: com.android.systemui}`. */
export function dialogFromDumpsys(text: string): SystemDialog | undefined {
  const m = /mCurrentFocus=Window\{\S+ \S+ (Application Not Responding|Application Error): ([A-Za-z][\w.]*)\}/.exec(text);
  if (!m) return undefined;
  return { kind: m[1] === "Application Error" ? "crashed" : "not-responding", app: m[2]! };
}

export function parseGuestState(stdout: string): GuestSample {
  const lines = stdout.split("\n").map((l) => l.trim());
  const booted = lines[0] === "1";
  const cpuLine = lines.find((l) => /^cpu\s/.test(l));
  let cpu: GuestSample["cpu"];
  if (cpuLine) {
    // user nice system idle iowait irq softirq steal: waiting on I/O or for the host's CPU is busy too.
    const n = cpuLine.split(/\s+/).slice(1, 9).map(Number);
    if (n.length >= 4 && n.every((v) => Number.isFinite(v))) cpu = { total: n.reduce((a, b) => a + b, 0), idle: n[3]! };
  }
  const dialog = dialogFromDumpsys(stdout);
  return { booted, ...(cpu ? { cpu } : {}), ...(dialog ? { dialog } : {}) };
}

/** The share of CPU time the guest spent busy between two samples, from 0 to 1; undefined without both. */
export function busyBetween(a: GuestSample, b: GuestSample): number | undefined {
  if (!a.cpu || !b.cpu) return undefined;
  const total = b.cpu.total - a.cpu.total;
  const idle = b.cpu.idle - a.cpu.idle;
  if (total <= 0 || idle < 0) return undefined;
  return Math.min(1, Math.max(0, (total - idle) / total));
}

/** How a dialog reads to a person, e.g. `"com.android.systemui isn't responding"`. */
export function describeDialog(d: SystemDialog): string {
  const name = d.app === "com.android.systemui" ? "System UI" : d.app;
  return d.kind === "crashed" ? `"${name} has stopped"` : `"${name} isn't responding"`;
}

/**
 * What to tell an agent about a system dialog that covers the screen (#80). `title` is what it says,
 * e.g. `"System UI isn't responding"` (quoted), or a dialog from `dumpsys window`.
 */
export function dialogAdvice(dialog: SystemDialog | { title?: string; crashed: boolean }): string {
  const crashed = "kind" in dialog ? dialog.kind === "crashed" : dialog.crashed;
  const title = "kind" in dialog ? describeDialog(dialog) : dialog.title ? `"${dialog.title}"` : undefined;
  const what = `A system dialog${title ? ` ${title}` : ""} covers the screen; the app under it cannot be reached until it is closed`;
  const close = "Close app (`tapdance ui tap --id android:id/aerr_close`, MCP tap with id \"android:id/aerr_close\")";
  return crashed
    ? `${what}: tap ${close}.`
    : `${what}: tap Wait (\`tapdance ui tap --id android:id/aerr_wait\`, MCP tap with id "android:id/aerr_wait") to give it time, or ${close}.`;
}

/** An "isn't responding" or crash dialog among snapshot nodes (agent-device or uiautomator), by its button ids. */
export function dialogInNodes(nodes: Array<Record<string, unknown>>): { title?: string; crashed: boolean } | undefined {
  const ids = nodes.map((n) => (typeof n["identifier"] === "string" ? n["identifier"] : typeof n["resourceId"] === "string" ? n["resourceId"] : ""));
  if (!ids.some((id) => /^android:id\/aerr_/.test(id))) return undefined;
  const labels = nodes.flatMap((n) => ["label", "text", "value"].map((k) => n[k]).filter((v): v is string => typeof v === "string"));
  const title = labels.find((l) => /isn.t responding|is not responding|has stopped|keeps stopping/i.test(l));
  const crashed = (title !== undefined && /has stopped|keeps stopping/i.test(title)) || !ids.includes("android:id/aerr_wait");
  return { ...(title ? { title } : {}), crashed };
}

/** An interval counts as calm when the guest was busy at most this share of it. */
export const SETTLED_CPU = 0.5;
/**
 * Consecutive calm intervals needed before the device counts as settled (#101). The guest's load is
 * bursty while it starts: a single calm 1.5 s interval ended the wait on the N2 VM while the next
 * readings were back above 90 %.
 */
export const SETTLED_SAMPLES = 3;
/**
 * How long a lease waits for the guest to settle before handing it out with a notice.
 *
 * Why only about 90 s although the busy phase is longer: measured on a Google Cloud N2 VM (nested
 * virtualisation, 2026-11-04, #101), the guest stayed busy for 65-145 s after a release and about
 * 310 s after a fresh boot, yet commands on the busy guest took 2-10 s and no "isn't responding"
 * dialog appeared (the dialog is answered here, and the clean baseline is taken from a calm guest).
 * Waiting the whole phase out would cost every lease minutes for commands that already work, and a
 * lease already waits up to 330 s in the queue, longer than many MCP clients allow a tool call. So
 * the wait covers most of the phase after a release and the notice says what is left.
 */
export const SETTLE_BUDGET_MS = 90_000;
export const SETTLE_INTERVAL_MS = 1500;
/**
 * A clearly falling load counts as good enough: the mean of the last TREND_WINDOW readings is at most
 * TREND_CEILING, at least TREND_DROP below the mean of the TREND_WINDOW readings before them, and no
 * recent reading is above the lowest of the older ones. The device then goes out with a short notice.
 */
const TREND_WINDOW = 3;
const TREND_DROP = 0.25;
const TREND_CEILING = 0.65;
const REPORT_EVERY_MS = 15_000;
const MAX_DISMISSALS = 3;

export interface SettleDeps {
  /** Runs the probe; a rejection (an older guard, exec unavailable) skips the wait. */
  probe: () => Promise<string>;
  /** Answers an "isn't responding" dialog with Wait; true when it was pressed. */
  dismiss: (dialog: SystemDialog) => Promise<boolean>;
  progress?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  budgetMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface SettleResult {
  settled: boolean;
  /** Said to the agent with the lease: what is still wrong with the device. */
  notices: string[];
  waitedMs: number;
  /** The guest's busy share in the last interval read, 0..1. */
  busy?: number;
  /**
   * Why the wait ended: `calm` (SETTLED_SAMPLES calm intervals in a row), `falling` (a clearly
   * falling load, handed out with a notice), `no-counters` (booted, nothing in front, no CPU counters
   * to judge by), `bound` (the budget ran out) or `skipped` (the probe could not run).
   */
  reason?: "calm" | "falling" | "no-counters" | "bound" | "skipped";
  /** The probe could not run, so nothing was checked. */
  skipped?: boolean;
}

const pct = (busy: number) => `${Math.round(busy * 100)} %`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** The recent and older means when the readings show a clearly falling load; undefined otherwise. */
export function fallingTrend(readings: number[]): { recent: number; older: number } | undefined {
  if (readings.length < 2 * TREND_WINDOW) return undefined;
  const recent = readings.slice(-TREND_WINDOW);
  const older = readings.slice(-2 * TREND_WINDOW, -TREND_WINDOW);
  const r = mean(recent);
  const o = mean(older);
  if (r > TREND_CEILING || o - r < TREND_DROP || Math.max(...recent) > Math.min(...older)) return undefined;
  return { recent: r, older: o };
}

export async function settleGuest(deps: SettleDeps): Promise<SettleResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budget = deps.budgetMs ?? SETTLE_BUDGET_MS;
  const interval = deps.intervalMs ?? SETTLE_INTERVAL_MS;
  const started = now();
  const waited = () => Math.round((now() - started) / 1000);
  let previous: GuestSample | undefined;
  let busy: number | undefined;
  /** Busy shares since the last measurement restart, oldest first. */
  let readings: number[] = [];
  let calm = 0;
  let dismissed = 0;
  let lastReport: number | undefined;
  let current: GuestSample | undefined;
  /** Closes a wait that told the agent it was waiting, so the last line says how it ended. */
  const done = (result: SettleResult): SettleResult => {
    if (lastReport !== undefined && result.settled) {
      deps.progress?.(
        result.reason === "falling"
          ? `Handing the device out while its load falls (guest CPU ${pct(result.busy ?? 0)}; waited ${waited()} s)`
          : `Settled (guest CPU ${result.busy === undefined ? "calm" : pct(result.busy)}; waited ${waited()} s)`,
      );
    }
    return result;
  };
  for (;;) {
    let text: string;
    try {
      text = await deps.probe();
    } catch {
      return { settled: false, notices: [], waitedMs: now() - started, reason: "skipped", skipped: true };
    }
    current = parseGuestState(text);
    if (!current.cpu && !current.booted) return { settled: false, notices: [], waitedMs: now() - started, reason: "skipped", skipped: true };
    // Booted, nothing in front, but no CPU counters to judge the load by: nothing more to wait for.
    if (!current.cpu && !current.dialog) return done({ settled: true, notices: [], waitedMs: now() - started, reason: "no-counters" });
    if (current.dialog?.kind === "not-responding" && dismissed < MAX_DISMISSALS && (await deps.dismiss(current.dialog).catch(() => false))) {
      dismissed++;
      deps.progress?.(`Answered a ${describeDialog(current.dialog)} dialog with Wait (the device was still starting)`);
      // The tap and the dialog going away cost CPU of their own: measure afresh.
      previous = undefined;
      busy = undefined;
      readings = [];
      calm = 0;
    } else {
      const reading = previous ? busyBetween(previous, current) : undefined;
      previous = current;
      if (reading !== undefined) {
        busy = reading;
        readings.push(reading);
      }
      const quiet = current.booted && !current.dialog;
      calm = quiet && reading !== undefined && reading <= SETTLED_CPU ? calm + 1 : reading === undefined && quiet ? calm : 0;
      if (calm >= SETTLED_SAMPLES) return done({ settled: true, notices: [], waitedMs: now() - started, busy: busy!, reason: "calm" });
      const trend = quiet ? fallingTrend(readings) : undefined;
      if (trend) {
        return done({
          settled: true,
          notices: [
            `The device is still finishing its start-up work (guest CPU ${pct(trend.recent)}, down from ${pct(trend.older)}): the first commands may take a few seconds longer than usual for about another minute.`,
          ],
          waitedMs: now() - started,
          busy: busy!,
          reason: "falling",
        });
      }
    }
    const elapsed = now() - started;
    if (elapsed >= budget || deps.signal?.aborted) break;
    // Said once something is not calm, then every 15 s: a calm device goes out without a word.
    const unsettled = !current.booted || current.dialog !== undefined || (busy !== undefined && busy > SETTLED_CPU);
    if (busy !== undefined && (lastReport === undefined ? unsettled : now() - lastReport >= REPORT_EVERY_MS)) {
      const why = !current.booted ? "boot not complete" : current.dialog ? `${describeDialog(current.dialog)} on screen` : `guest CPU ${pct(busy)}`;
      deps.progress?.(`${lastReport === undefined ? "Waiting for the device to settle" : "Still settling"} (${why}; ${Math.round(elapsed / 1000)} s, at most ${Math.round(budget / 1000)} s)`);
      lastReport = now();
    }
    await sleep(interval);
  }
  const notices: string[] = [];
  if (current?.dialog) notices.push(dialogAdvice(current.dialog));
  else if (current && !current.booted) notices.push(`The device had not finished booting after ${waited()} s; the first commands may fail or be slow. Check it with \`tapdance ui inspect\` (MCP inspect_screen) before installing.`);
  else if (busy !== undefined) {
    const recent = readings.slice(-TREND_WINDOW);
    notices.push(
      `The device is still busy with its start-up work after ${waited()} s (guest CPU ${pct(busy)} at the last reading, ${pct(mean(recent))} over the last ${recent.length}). ` +
        `It was handed out rather than kept waiting: commands work but can take 2-10 s each for up to a few more minutes (after a fresh boot on a slow host, up to about 4). Nothing needs to be done about it.`,
    );
  }
  return { settled: false, notices, waitedMs: now() - started, ...(busy !== undefined ? { busy } : {}), reason: "bound" };
}
