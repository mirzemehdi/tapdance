import { TapdanceError, type IntentSpec, type TimedTap } from "@tapdance/core";

/**
 * Device-level commands Tapdance sends through Simlock's lease exec (`POST /v1/leases/{id}/exec`).
 * Simlock runs `adb`/`simctl` on the machine that owns the leased device and puts that device into
 * the command itself, so these reach a remote emulator or simulator the same way as a local one.
 *
 * Every builder here produces one fixed shape. The worker guard (packages/cli/src/guard/rules.ts)
 * accepts exactly these shapes and nothing else, and a unit test checks that each builder's output
 * passes the guard. Values that reach the Android device's shell are validated and single-quoted;
 * they never reach a shell on the worker host (adb and simctl are spawned with argument arrays).
 */
export interface DeviceCommand {
  tool: "adb" | "simctl";
  args: string[];
  /** One-shot stdin (file contents, base64). */
  stdin?: string;
}

export const APP_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,254}$/;
/** A value safe to pass to the Android device shell without quotes. */
export const PLAIN = /^[A-Za-z0-9_.:/=+@,%-]{1,512}$/;
/** A value single-quoted for the Android device shell: no quote, newline or NUL inside. */
export const QUOTED = /^'[^'\n\r\0]{0,2048}'$/;
export const SHARED_DIRS = ["Download", "Pictures", "DCIM", "Documents", "Movies", "Music"] as const;
export const SHARED_PATH = /^\/sdcard\/(Download|Pictures|DCIM|Documents|Movies|Music)\/(?!\.{1,2}$)[A-Za-z0-9 _.()+-]{1,128}$/;
export const SANDBOX_PATH = /^(files|cache|databases|shared_prefs|no_backup)\/(?!\.{1,2}$)[A-Za-z0-9 _.()+-]{1,128}$/;
export const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const INTENT_FLAG = /^(0x[0-9a-fA-F]{1,8}|[0-9]{1,10})$/;
export const EXTRA_KEY = /^[A-Za-z][A-Za-z0-9_.]{0,127}$/;
/** The most taps one timed sequence may hold. */
export const MAX_SEQUENCE_STEPS = 500;
/** Chrome without its welcome, sign-in and default-browser screens. */
export const CHROME_FLAGS = "chrome --disable-fre --no-default-browser-check --no-first-run";
/** Files pushed through exec travel as base64 on stdin; keep them small enough for one request. */
export const MAX_PUSH_BYTES = 24 * 1024 * 1024;

const usage = (message: string, hint?: string) => new TapdanceError("USAGE", message, hint ? { hint } : {});

/** Quotes a value for the Android device shell, refusing what cannot be quoted safely. */
export function quote(value: string, what: string): string {
  if (PLAIN.test(value)) return value;
  const q = `'${value}'`;
  if (!QUOTED.test(q)) throw usage(`${what} cannot contain a single quote, a newline or a NUL`);
  return q;
}

function app(id: string): string {
  if (!APP_ID.test(id)) throw usage(`"${id}" is not a valid app id`);
  return id;
}

export type { IntentSpec };

export const android = {
  /** `am start -W` with an explicit intent; every field validated, values quoted for the device shell. */
  startIntent(intent: IntentSpec): DeviceCommand {
    const args = ["shell", "am", "start", "-W"];
    if (intent.action) args.push("-a", quote(intent.action, "intent action"));
    if (intent.data) args.push("-d", quote(intent.data, "intent data"));
    if (intent.component) {
      if (!/^[A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.$]+$/.test(intent.component)) throw usage("component must look like com.example/.MainActivity");
      args.push("-n", intent.component);
    }
    for (const c of intent.categories ?? []) args.push("-c", quote(c, "intent category"));
    if (intent.flags) {
      if (!INTENT_FLAG.test(intent.flags)) throw usage("flags must be a number such as 0x10000000");
      args.push("-f", intent.flags);
    }
    for (const [key, value] of Object.entries(intent.extras ?? {})) {
      if (!EXTRA_KEY.test(key)) throw usage(`extra key "${key}" is not allowed`);
      if (typeof value === "boolean") args.push("--ez", key, String(value));
      else if (typeof value === "number" && Number.isInteger(value)) args.push("--ei", key, String(value));
      else args.push("--es", key, quote(String(value), `extra ${key}`));
    }
    if (args.length === 4) throw usage("An intent needs at least an action, data or component");
    return { tool: "adb", args };
  },
  /** A raw touch through Android's input service: system pickers ignore the automation helper's events. */
  inputTap(x: number, y: number): DeviceCommand {
    if (![x, y].every((n) => Number.isInteger(n) && n >= 0 && n < 100_000)) throw usage("tap coordinates must be whole pixels");
    return { tool: "adb", args: ["shell", "input", "tap", String(x), String(y)] };
  },
  /** Chrome reads extra flags from this file when it is the debug app (userdebug emulator images). */
  chromeFlags(): DeviceCommand {
    return { tool: "adb", args: ["shell", `echo '${CHROME_FLAGS}' > /data/local/tmp/chrome-command-line`] };
  },
  chromeDebugApp(): DeviceCommand {
    return { tool: "adb", args: ["shell", "am", "set-debug-app", "--persistent", "com.android.chrome"] };
  },
  /**
   * A timed tap sequence as one script for the emulator's shell: each tap starts in the background at
   * its time (so a slow `input` call does not delay the next one) and prints when it started.
   */
  tapSequence(steps: TimedTap[]): DeviceCommand {
    const int = (n: number, max: number, what: string) => {
      if (!Number.isInteger(n) || n < 0 || n > max) throw usage(`${what} must be a whole number from 0 to ${max}`);
      return n;
    };
    if (steps.length === 0 || steps.length > MAX_SEQUENCE_STEPS) throw usage(`A sequence has 1 to ${MAX_SEQUENCE_STEPS} taps`);
    let previous = 0;
    const lines = ["s=$(date +%s%N)"];
    steps.forEach((step, i) => {
      const t = int(step.t, 600_000, "t");
      if (t < previous) throw usage("Taps must be in time order (t ascending)");
      previous = t;
      const x = int(step.x, 10_000, "x");
      const y = int(step.y, 10_000, "y");
      const hold = step.hold === undefined ? 0 : int(step.hold, 10_000, "hold");
      const action = hold > 0 ? `input swipe ${x} ${y} ${x} ${y} ${hold}` : `input tap ${x} ${y}`;
      // Sleep until the step's time (ms resolution), then start the tap without waiting for it.
      lines.push(`d=$(( (s + ${t}000000 - $(date +%s%N)) / 1000000 )); [ $d -gt 0 ] && sleep $((d/1000)).$(printf %03d $((d%1000)))`);
      lines.push(`echo "${i} $(( ($(date +%s%N) - s) / 1000 ))"; ${action} &`);
    });
    lines.push("wait");
    return { tool: "adb", args: ["shell", lines.join("\n")] };
  },
  /** Every window on screen as the system sees it (XML on stdout), including other apps' windows. */
  uiautomatorDump(): DeviceCommand {
    return { tool: "adb", args: ["shell", "uiautomator", "dump", "/dev/tty"] };
  },
  /** The Home key, through Android's input service. */
  home(): DeviceCommand {
    return { tool: "adb", args: ["shell", "input", "keyevent", "3"] };
  },
  /** Android 14+: stop an app and its services without cancelling its alarms and jobs (unlike force-stop). */
  stopApp(appId: string): DeviceCommand {
    return { tool: "adb", args: ["shell", "am", "stop-app", app(appId)] };
  },
  /** Ask a backgrounded app to release memory, as the system does before reclaiming it. */
  trimMemory(appId: string): DeviceCommand {
    return { tool: "adb", args: ["shell", "am", "send-trim-memory", app(appId), "COMPLETE"] };
  },
  /** Kill a background (cached) app's process, as the system does under memory pressure. */
  killBackground(appId: string): DeviceCommand {
    return { tool: "adb", args: ["shell", "am", "kill", app(appId)] };
  },
  pidOf(appId: string): DeviceCommand {
    return { tool: "adb", args: ["shell", "pidof", app(appId)] };
  },
  /** Window manager state; `mCurrentFocus` names the app in front. */
  focusedWindow(): DeviceCommand {
    return { tool: "adb", args: ["shell", "dumpsys", "window", "displays"] };
  },
  notifications(): DeviceCommand {
    return { tool: "adb", args: ["shell", "dumpsys", "notification", "--noredact"] };
  },
  shade(open: boolean): DeviceCommand {
    return { tool: "adb", args: ["shell", "cmd", "statusbar", open ? "expand-notifications" : "collapse"] };
  },
  postNotification(title: string, text: string): DeviceCommand {
    return { tool: "adb", args: ["shell", "cmd", "notification", "post", "-t", quote(title, "title"), "tapdance", quote(text, "text")] };
  },
  pushShared(path: string, base64: string): DeviceCommand {
    if (!SHARED_PATH.test(path)) throw usage(`Files go to /sdcard/{${SHARED_DIRS.join(",")}}/<name>; "${path}" is not allowed`);
    return { tool: "adb", args: ["shell", `base64 -d > '${path}'`], stdin: base64 };
  },
  pushSandbox(appId: string, relative: string, base64: string): DeviceCommand {
    if (!SANDBOX_PATH.test(relative)) throw usage(`App files go to files/, cache/, databases/, shared_prefs/ or no_backup/; "${relative}" is not allowed`);
    return { tool: "adb", args: ["shell", "run-as", app(appId), "sh", "-c", `'base64 -d > ${relative}'`], stdin: base64 };
  },
  pullShared(path: string): DeviceCommand {
    if (!SHARED_PATH.test(path)) throw usage(`Only files in /sdcard/{${SHARED_DIRS.join(",")}}/ can be pulled; "${path}" is not allowed`);
    return { tool: "adb", args: ["shell", "base64", `'${path}'`] };
  },
  pullSandbox(appId: string, relative: string): DeviceCommand {
    if (!SANDBOX_PATH.test(relative)) throw usage(`"${relative}" is not under files/, cache/, databases/, shared_prefs/ or no_backup/`);
    return { tool: "adb", args: ["shell", "run-as", app(appId), "base64", relative] };
  },
  mediaScan(path: string): DeviceCommand {
    if (!SHARED_PATH.test(path)) throw usage(`"${path}" is not in shared storage`);
    return { tool: "adb", args: ["shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `'file://${path}'`] };
  },
};

export const ios = {
  statusBarTime(time: string): DeviceCommand {
    if (!CLOCK.test(time)) throw usage("time must be HH:MM");
    return { tool: "simctl", args: ["status_bar", "override", "--time", time] };
  },
  statusBarClear(): DeviceCommand {
    return { tool: "simctl", args: ["status_bar", "clear"] };
  },
};
