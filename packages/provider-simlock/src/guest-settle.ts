/**
 * Waits for a just-leased Android emulator to settle (#79). A warm spare restored from Simlock's
 * baseline snapshot, or a guest rebooted by the previous release, can be handed out while it is still
 * starting: boot not complete, the CPU near 100 % for minutes (dexopt, Play services), and System UI
 * showing an "isn't responding" dialog over everything. Commands then take 10-25 s each.
 *
 * The probe is `deviceCommands.android.guestState()`: `sys.boot_completed`, the first line of
 * /proc/stat (two reads give the guest's CPU load) and the focused window.
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

/** The guest counts as settled when it was busy at most this share of the time between two reads. */
export const SETTLED_CPU = 0.5;
/** How long a lease waits for the guest to settle before handing it out with a notice. */
export const SETTLE_BUDGET_MS = 90_000;
const SETTLE_INTERVAL_MS = 1500;
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
  /** The probe could not run, so nothing was checked. */
  skipped?: boolean;
}

const pct = (busy: number) => `${Math.round(busy * 100)} %`;

export async function settleGuest(deps: SettleDeps): Promise<SettleResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budget = deps.budgetMs ?? SETTLE_BUDGET_MS;
  const interval = deps.intervalMs ?? SETTLE_INTERVAL_MS;
  const started = now();
  let previous: GuestSample | undefined;
  let busy: number | undefined;
  let dismissed = 0;
  let lastReport: number | undefined;
  let current: GuestSample | undefined;
  for (;;) {
    let text: string;
    try {
      text = await deps.probe();
    } catch {
      return { settled: false, notices: [], waitedMs: now() - started, skipped: true };
    }
    current = parseGuestState(text);
    if (!current.cpu && !current.booted) return { settled: false, notices: [], waitedMs: now() - started, skipped: true };
    // Booted, nothing in front, but no CPU counters to judge the load by: nothing more to wait for.
    if (!current.cpu && !current.dialog) return { settled: true, notices: [], waitedMs: now() - started };
    if (current.dialog?.kind === "not-responding" && dismissed < MAX_DISMISSALS && (await deps.dismiss(current.dialog).catch(() => false))) {
      dismissed++;
      deps.progress?.(`Answered a ${describeDialog(current.dialog)} dialog with Wait (the device was still starting)`);
      // The tap and the dialog going away cost CPU of their own: measure afresh.
      previous = undefined;
      busy = undefined;
    } else {
      busy = previous ? busyBetween(previous, current) : undefined;
      previous = current;
      if (current.booted && !current.dialog && busy !== undefined && busy <= SETTLED_CPU) {
        return { settled: true, notices: [], waitedMs: now() - started };
      }
    }
    const elapsed = now() - started;
    if (elapsed >= budget || deps.signal?.aborted) break;
    if (busy !== undefined && (lastReport === undefined || now() - lastReport >= REPORT_EVERY_MS)) {
      const why = !current.booted ? "boot not complete" : current.dialog ? `${describeDialog(current.dialog)} on screen` : `guest CPU ${pct(busy)}`;
      deps.progress?.(`${lastReport === undefined ? "Waiting for the device to settle" : "Still settling"} (${why}; ${Math.round(elapsed / 1000)} s, at most ${Math.round(budget / 1000)} s)`);
      lastReport = now();
    }
    await sleep(interval);
  }
  const waited = Math.round((now() - started) / 1000);
  const notices: string[] = [];
  if (current?.dialog) notices.push(dialogAdvice(current.dialog));
  else if (current && !current.booted) notices.push(`The device had not finished booting after ${waited} s; the first commands may fail or be slow. Check it with \`tapdance ui inspect\` (MCP inspect_screen) before installing.`);
  else if (busy !== undefined) notices.push(`The device is still busy (guest CPU ${pct(busy)} after ${waited} s): it was handed out while still starting, so the first commands can take 10-20 s each until it settles.`);
  return { settled: false, notices, waitedMs: now() - started };
}
