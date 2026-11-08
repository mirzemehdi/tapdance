/**
 * Waits for a just-leased Android emulator to settle (#79). Simlock 0.6 boots every emulator as a
 * copy of its kind's seed, from the seed's boot snapshot (0.5 restored a per-device baseline
 * snapshot), and a spare booted shortly before the lease can be handed out while the guest is still
 * busy with the work that snapshot froze (#139): the CPU near 100 % for minutes (dexopt, Play
 * services), and System UI showing an "isn't responding" dialog over everything. Commands then take
 * 10-25 s each.
 *
 * The probe is `deviceCommands.android.guestState()`: `sys.boot_completed`, the first line of
 * /proc/stat (two reads give the guest's CPU load) and the focused window. The wait has two parts:
 * boot complete with no "isn't responding" or crash dialog in front (an ANR is answered with Wait),
 * bounded by READY_BUDGET_MS; then a short CPU check (`session.settleSeconds`, DEFAULT_CPU_CHECK_MS)
 * that ends early after SETTLED_SAMPLES calm intervals in a row or a clearly falling load (#101), and,
 * with the default length or less, as soon as the first BUSY_EXIT_SAMPLES readings are all high and
 * not falling: such a guest stays busy far longer than the check (#101, field run 2d).
 *
 * Not measured: the guest's /proc/stat may not show work the emulator does in host threads (software
 * rendering), so a calm guest can still mean a busy qemu process.
 */

import { bounded, HEARTBEAT_MS, withHeartbeat } from "./heartbeat.js";

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
 * How long a lease waits for what causes the "isn't responding" experience to end: boot complete and
 * no "isn't responding" or crash dialog in front. Past it the device goes out with a notice naming
 * what is still wrong.
 */
export const READY_BUDGET_MS = 90_000;
/**
 * How long a lease checks the guest's CPU once it is ready, by default (`session.settleSeconds`;
 * 0 skips the check). Short on purpose: measured on a Google Cloud N2 VM (nested virtualisation,
 * 2026-11-04, #101), the guest stayed busy for 65-145 s after a release and about 310 s after a fresh
 * boot, yet commands on the busy guest took 2-10 s and no "isn't responding" dialog appeared once
 * System UI's ANR was answered with Wait. A 90 s CPU wait would have cost most leases there the full
 * 90 s for commands that already work, so the lease hands the device out after a short check and the
 * notice says the guest is still busy.
 */
export const DEFAULT_CPU_CHECK_MS = 15_000;
/**
 * Early busy exit (#101, field run 2d): when the first BUSY_EXIT_SAMPLES readings of the CPU check are
 * all at least BUSY_EXIT_CPU and not falling (the last not more than BUSY_EXIT_MAX_DROP below the
 * first, and not lower at every reading by BUSY_EXIT_STEADY_DROP or more in all), the device goes out
 * at once with the busy notice. On the N2 VM a guest re-leased right after a release
 * read 94-97 % and stayed busy for another 55-60 s, so the rest of a 15 s check only added 10 s to the
 * lease and always ended with the same notice. Applies only when the check is DEFAULT_CPU_CHECK_MS or
 * shorter: a longer `session.settleSeconds` (or `--settle`, `settle_seconds`) asks to wait out the busy
 * phase, and still does.
 */
export const BUSY_EXIT_CPU = 0.8;
export const BUSY_EXIT_SAMPLES = 3;
const BUSY_EXIT_MAX_DROP = 0.1;
const BUSY_EXIT_STEADY_DROP = 0.04;
/** The most `session.settleSeconds` may ask for. */
export const MAX_CPU_CHECK_MS = 300_000;
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
  /** Bound on waiting for boot complete and no dialog in front (READY_BUDGET_MS). */
  readyBudgetMs?: number;
  /** How long to check the CPU once the guest is ready (DEFAULT_CPU_CHECK_MS); 0 skips the check. */
  cpuBudgetMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  /**
   * Called once, the first time the guest reads booted with nothing in front: work that needs a ready
   * guest (the snapshot-helper warm-up, #102) can start then, alongside the CPU check.
   */
  onReady?: () => void;
  /** Awaited before a dialog is answered, so that tap does not overlap other automation calls. */
  beforeDismiss?: () => Promise<unknown>;
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
   * falling load, handed out with a notice), `busy` (the first readings were high and not falling,
   * handed out at once with the busy notice; default-length checks only), `ready` (booted, nothing in front, and the CPU check is
   * off), `no-counters` (booted, nothing in front, no CPU counters to judge by), `bound` (the CPU
   * check or the ready budget ran out) or `skipped` (the probe could not run).
   */
  reason?: "calm" | "falling" | "busy" | "ready" | "no-counters" | "bound" | "skipped";
  /** The probe could not run, so nothing was checked. */
  skipped?: boolean;
}

const pct = (busy: number) => `${Math.round(busy * 100)} %`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** True when the first readings of a CPU check are all high and not falling (BUSY_EXIT_CPU). */
export function busyFromTheStart(readings: number[]): boolean {
  if (readings.length < BUSY_EXIT_SAMPLES) return false;
  const first = readings.slice(0, BUSY_EXIT_SAMPLES);
  if (!first.every((r) => r >= BUSY_EXIT_CPU)) return false;
  const drop = first[0]! - first.at(-1)!;
  // Falling: down by more than BUSY_EXIT_MAX_DROP, or down at every reading by a few points in all.
  const steadilyDown = first.every((r, i) => i === 0 || r < first[i - 1]!) && drop >= BUSY_EXIT_STEADY_DROP;
  return drop <= BUSY_EXIT_MAX_DROP && !steadilyDown;
}

/** The notice for a device handed out while its guest is still busy. */
function busyNotice(waitedS: number, last: number, recent: number[]): string {
  return (
    `The device is still busy with its start-up work after ${waitedS} s (guest CPU ${pct(last)} at the last reading, ${pct(mean(recent))} over the last ${recent.length}). ` +
    `It was handed out rather than kept waiting: commands work but may be slower, 2-10 s each, for a few more minutes (after a fresh boot on a slow host, up to about 5). ` +
    `Nothing needs to be done about it; to have leases wait longer, raise session.settleSeconds (CLI device lease --settle, MCP lease_device settle_seconds).`
  );
}

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
  const readyBudget = deps.readyBudgetMs ?? READY_BUDGET_MS;
  const cpuBudget = Math.min(Math.max(deps.cpuBudgetMs ?? DEFAULT_CPU_CHECK_MS, 0), MAX_CPU_CHECK_MS);
  const interval = deps.intervalMs ?? SETTLE_INTERVAL_MS;
  const earlyBusyExit = cpuBudget <= DEFAULT_CPU_CHECK_MS;
  const started = now();
  let readySignalled = false;
  const signalReady = () => {
    if (readySignalled) return;
    readySignalled = true;
    try {
      deps.onReady?.();
    } catch {
      // The caller's hook never fails the wait.
    }
  };
  /** When the guest was first seen booted with nothing in front: the CPU check runs from here. */
  let readyAt: number | undefined;
  const waited = () => Math.round((now() - started) / 1000);
  let previous: GuestSample | undefined;
  let busy: number | undefined;
  /** Busy shares since the last measurement restart, oldest first. */
  let readings: number[] = [];
  /** Busy shares read while the guest was booted with nothing in front, since that last began. */
  let quietReadings: number[] = [];
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
    if (current.dialog?.kind === "not-responding" && dismissed < MAX_DISMISSALS && (await dismissAfterOthers(deps, current.dialog))) {
      dismissed++;
      deps.progress?.(`Answered a ${describeDialog(current.dialog)} dialog with Wait (the device was still starting)`);
      // The tap and the dialog going away cost CPU of their own: measure afresh.
      previous = undefined;
      busy = undefined;
      readings = [];
      quietReadings = [];
      calm = 0;
    } else {
      const quiet = current.booted && !current.dialog;
      if (quiet) signalReady();
      // Booted and nothing in front: with the CPU check off, that is all a lease waits for.
      if (quiet && cpuBudget === 0) return done({ settled: true, notices: [], waitedMs: now() - started, reason: "ready" });
      if (quiet && readyAt === undefined) readyAt = now();
      const reading = previous ? busyBetween(previous, current) : undefined;
      previous = current;
      if (reading !== undefined) {
        busy = reading;
        readings.push(reading);
      }
      if (!quiet) quietReadings = [];
      else if (reading !== undefined) quietReadings.push(reading);
      calm = quiet && reading !== undefined && reading <= SETTLED_CPU ? calm + 1 : reading === undefined && quiet ? calm : 0;
      if (calm >= SETTLED_SAMPLES) return done({ settled: true, notices: [], waitedMs: now() - started, busy: busy!, reason: "calm" });
      // High and not falling from the first readings on: the rest of a default-length check would only
      // delay the same notice (#101, field run 2d).
      if (earlyBusyExit && quietReadings.length === BUSY_EXIT_SAMPLES && busyFromTheStart(quietReadings)) {
        const recent = quietReadings.slice(-TREND_WINDOW);
        deps.progress?.(`Handing the device out while it is still busy (guest CPU ${pct(mean(recent))} over the first ${recent.length} readings, not falling; waited ${waited()} s)`);
        return { settled: false, notices: [busyNotice(waited(), busy!, recent)], waitedMs: now() - started, busy: busy!, reason: "busy" };
      }
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
    // A ready guest gets the CPU check's time; one still booting or behind a dialog gets the ready
    // budget (or the CPU check's end, when that is later and a dialog came back).
    const cpuEnd = readyAt === undefined ? undefined : readyAt - started + cpuBudget;
    const bound = current.booted && !current.dialog && cpuEnd !== undefined ? cpuEnd : Math.max(readyBudget, cpuEnd ?? 0);
    if (elapsed >= bound || deps.signal?.aborted) break;
    // Said once something is not calm, then every 15 s: a calm device goes out without a word.
    const unsettled = !current.booted || current.dialog !== undefined || (busy !== undefined && busy > SETTLED_CPU);
    if (busy !== undefined && (lastReport === undefined ? unsettled : now() - lastReport >= REPORT_EVERY_MS)) {
      const why = !current.booted ? "boot not complete" : current.dialog ? `${describeDialog(current.dialog)} on screen` : `guest CPU ${pct(busy)}`;
      deps.progress?.(`${lastReport === undefined ? "Waiting for the device to settle" : "Still settling"} (${why}; ${Math.round(elapsed / 1000)} s, at most ${Math.round(bound / 1000)} s)`);
      lastReport = now();
    }
    await sleep(interval);
  }
  const notices: string[] = [];
  if (current?.dialog) notices.push(dialogAdvice(current.dialog));
  else if (current && !current.booted) notices.push(`The device had not finished booting after ${waited()} s; the first commands may fail or be slow. Check it with \`tapdance ui inspect\` (MCP inspect_screen) before installing.`);
  else if (busy !== undefined) {
    const recent = readings.slice(-TREND_WINDOW);
    // Calm at the end without a full calm run: nothing worth a warning.
    if (busy <= SETTLED_CPU && mean(recent) <= SETTLED_CPU) return done({ settled: true, notices: [], waitedMs: now() - started, busy, reason: "bound" });
    notices.push(busyNotice(waited(), busy, recent));
  }
  return { settled: false, notices, waitedMs: now() - started, ...(busy !== undefined ? { busy } : {}), reason: "bound" };
}

/** Answers a dialog once other automation calls (the warm-up) are done; false when it could not. */
async function dismissAfterOthers(deps: SettleDeps, dialog: SystemDialog): Promise<boolean> {
  await deps.beforeDismiss?.().catch(() => undefined);
  return deps.dismiss(dialog).catch(() => false);
}

export interface HandOutDeps {
  /** The settle wait (settleGuest), given the hooks that start and serialise the warm-up. */
  settle: (hooks: { onReady: () => void; beforeDismiss: () => Promise<unknown> }) => Promise<SettleResult>;
  /** The snapshot-helper warm-up (#102). Its own errors are its business; a rejection is ignored. */
  warmUp: () => Promise<unknown>;
  /** The longest the lease waits for the warm-up, counted from when it started. */
  warmUpBoundMs: number;
  /** Gets the settle wait's notices as soon as it ends, before the warm-up is awaited. */
  onNotice?: (notice: string) => void;
  progress?: (message: string) => void;
  heartbeatMs?: number;
}

/**
 * The end of an Android emulator lease (#101, #102, field run 2d): the settle wait and the
 * snapshot-helper warm-up run side by side, so the lease takes about the longer of the two, not their
 * sum. The warm-up starts once the guest first reads booted with nothing in front (or when the settle
 * wait ends without that), a dialog is answered only after it, and the settle wait's notices go to
 * `onNotice` the moment the wait ends. The warm-up is awaited for at most `warmUpBoundMs` from its
 * start and can never fail the lease.
 */
export async function settleAndWarmUp(deps: HandOutDeps): Promise<SettleResult> {
  let warming: Promise<unknown> | undefined;
  const startWarmUp = () => {
    if (warming) return;
    let started: Promise<unknown>;
    try {
      started = deps.warmUp();
    } catch {
      started = Promise.resolve();
    }
    warming = bounded(Promise.resolve(started), deps.warmUpBoundMs);
  };
  const settled = await deps.settle({ onReady: startWarmUp, beforeDismiss: () => warming ?? Promise.resolve() });
  for (const notice of settled.notices) {
    try {
      deps.onNotice?.(notice);
    } catch {
      // A listener's failure does not touch the lease.
    }
  }
  startWarmUp();
  await withHeartbeat(warming!, deps.progress, (s) => `Still reading the screen once so the first inspect is quick (${s} s more, at most ${Math.round(deps.warmUpBoundMs / 1000)} s in all)`, deps.heartbeatMs ?? HEARTBEAT_MS);
  return settled;
}
