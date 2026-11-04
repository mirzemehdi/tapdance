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
/** The app group whose "File Provider Storage" folder is the Files app's "On My iPhone". */
export const FILES_GROUP = "group.com.apple.FileProvider.LocalStorage";

/** The path of `group` in `simctl get_app_container … groups` output (lines "<group>\t<path>"). */
export function parseGroupContainer(stdout: string, group: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const [name, path] = line.trim().split(/\s+(?=\/)/);
    if (name === group && path?.startsWith("/")) return path;
  }
  return undefined;
}

/** A BCP 47 locale such as de, de-DE, pt-BR or zh-Hans-CN. */
export const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/;
/** The most taps one timed sequence may hold. */
export const MAX_SEQUENCE_STEPS = 500;
/** The system dump script (`ui inspect --system`); the guard accepts exactly this string. */
export const UIAUTOMATOR_DUMP =
  "am force-stop com.callstack.agentdevice.snapshothelper; uiautomator dump /sdcard/tapdance-ui.xml >/dev/null 2>&1; cat /sdcard/tapdance-ui.xml; rm -f /sdcard/tapdance-ui.xml";
/**
 * Whether a just-leased emulator has settled (#79): boot finished, the CPU counters (two reads give
 * the guest's load) and the focused window (an "isn't responding" dialog). The guard accepts exactly
 * this string.
 */
export const GUEST_STATE = "getprop sys.boot_completed; head -n 1 /proc/stat; dumpsys window displays | grep mCurrentFocus=";
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
    // Android's mksh does 32-bit arithmetic, so nanosecond timestamps wrap every 2.1 s (#42). Count
    // microseconds since the start instead, from whole seconds and the sub-second part: 10 minutes is
    // 6e8 µs, well inside 32 bits. `10#` keeps a leading zero from reading as octal.
    const since = "set -- $(date '+%s %N'); n=$(( ($1 - s0) * 1000000 + 10#${2%???} - b ))";
    const lines = ["set -- $(date '+%s %N'); s0=$1; b=$((10#${2%???}))"];
    steps.forEach((step, i) => {
      const t = int(step.t, 600_000, "t");
      if (t < previous) throw usage("Taps must be in time order (t ascending)");
      previous = t;
      const x = int(step.x, 10_000, "x");
      const y = int(step.y, 10_000, "y");
      const hold = step.hold === undefined ? 0 : int(step.hold, 10_000, "hold");
      const action = hold > 0 ? `input swipe ${x} ${y} ${x} ${y} ${hold}` : `input tap ${x} ${y}`;
      // Sleep until the step's time (ms resolution), then start the tap without waiting for it.
      lines.push(`${since}; d=$(( (${t * 1000} - n) / 1000 )); [ $d -gt 0 ] && sleep $((d/1000)).$(printf %03d $((d%1000)))`);
      lines.push(`${since}; echo "${i} $n"; ${action} &`);
    });
    lines.push("wait");
    return { tool: "adb", args: ["shell", lines.join("\n")] };
  },
  /**
   * Every window on screen as the system sees it (XML on stdout), including other apps' windows.
   * agent-device's snapshot helper holds the one UiAutomation connection, so it is stopped first (its
   * next snapshot starts it again); `adb shell` without a terminal has no /dev/tty, so the dump goes
   * to a file that is printed and removed (#44).
   */
  uiautomatorDump(): DeviceCommand {
    return { tool: "adb", args: ["shell", UIAUTOMATOR_DUMP] };
  },
  chromeNotifications(): DeviceCommand {
    return { tool: "adb", args: ["shell", "pm", "grant", "com.android.chrome", "android.permission.POST_NOTIFICATIONS"] };
  },
  /** Android 13+: one app's language, e.g. de-DE. */
  appLocale(appId: string, locale: string): DeviceCommand {
    if (!LOCALE.test(locale)) throw usage(`"${locale}" is not a locale such as de-DE or pt-BR`);
    return { tool: "adb", args: ["shell", "cmd", "locale", "set-app-locales", app(appId), "--locales", locale] };
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
  /** Boot flag, CPU counters and focused window of a just-leased emulator (#79). */
  guestState(): DeviceCommand {
    return { tool: "adb", args: ["shell", GUEST_STATE] };
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
  /** The Files app's app-group containers (one of them is "On My iPhone"). */
  filesGroups(): DeviceCommand {
    return { tool: "simctl", args: ["get_app_container", "com.apple.DocumentsApp", "groups"] };
  },
  listApps(): DeviceCommand {
    return { tool: "simctl", args: ["listapps"] };
  },
  /**
   * Relaunches an app with its stdout and stderr in files on the Mac (#59): `print`/`println` go to
   * stdout, which the system log does not keep. Simlock puts the simulator after the options.
   */
  /** Launch Services' lines about URLs apps asked to open, over the last `minutes` (#60). */
  linkLog(minutes: number, unit: "m" | "s" = "m"): DeviceCommand {
    const m = unit === "s" ? Math.max(5, Math.min(59, Math.round(minutes))) : Math.max(1, Math.min(30, Math.round(minutes)));
    // [c]: Launch Services writes both "open URL" and "handle url scheme" (#68).
    return { tool: "simctl", args: ["spawn", "log", "show", "--last", `${m}${unit}`, "--style", "compact", "--predicate", 'subsystem == "com.apple.launchservices" AND eventMessage CONTAINS[c] "url"'] };
  },
  launchWithConsole(appId: string, stdoutPath: string, stderrPath: string, args: string[] = []): DeviceCommand {
    return { tool: "simctl", args: ["launch", "--terminate-running-process", `--stdout=${stdoutPath}`, `--stderr=${stderrPath}`, appId, ...args] };
  },
  /** The simulator's device-wide language and region (`de-DE`): what Settings › General › Language sets (#49). */
  setLanguage(locale: string): DeviceCommand[] {
    if (!LOCALE.test(locale)) throw usage(`"${locale}" is not a locale such as de-DE or pt-BR`);
    return [
      { tool: "simctl", args: ["spawn", "defaults", "write", "-g", "AppleLanguages", "-array", locale] },
      { tool: "simctl", args: ["spawn", "defaults", "write", "-g", "AppleLocale", "-string", locale.replace(/-/g, "_")] },
    ];
  },
  readLanguage(): DeviceCommand {
    return { tool: "simctl", args: ["spawn", "defaults", "read", "-g", "AppleLanguages"] };
  },
  statusBarList(): DeviceCommand {
    return { tool: "simctl", args: ["status_bar", "list"] };
  },
  statusBarClear(): DeviceCommand {
    return { tool: "simctl", args: ["status_bar", "clear"] };
  },
};
