import { deviceCommands } from "@tapdance/sdk";
import type { GuardPolicy } from "./policy.js";

/**
 * What a remote client may ask of a personal Mac (or any worker) through the guard. Everything here
 * is an allowlist: a route, RPC command or exec argument list not matched below is refused. Upstream
 * additions to Simlock or agent-device are therefore refused until reviewed and added here.
 */

export type Decision<T> = { ok: true; value: T } | { ok: false; reason: string };
const deny = (reason: string) => ({ ok: false as const, reason });

export type Route =
  | { kind: "healthz" }
  | { kind: "identity" }
  | { kind: "status" }
  | { kind: "catalog" }
  | { kind: "lease"; leaseId: string; action: "get" | "delete" | "exec" | "stream" | "input" | "events" | "files-put" | "files-get" | "build" | "crashes" | "console-launch" | "console-read" | "touches"; crashName?: string }
  | { kind: "rpc" }
  | { kind: "agent-device-health" }
  | { kind: "upload"; path: string }
  | { kind: "artifact"; path: string }
  | { kind: "diagnostics"; path: string; leasePrefix: string };

const LEASE = /^[0-9a-f]{32}$/;

export function routeOf(method: string, rawPath: string): Decision<Route> {
  const path = rawPath.split("?")[0] ?? "";
  // Encoded dots and slashes are refused in the path; query values are validated by each route's rules.
  if (path.includes("..") || path.includes("//") || /%2e|%2f/i.test(path)) return deny("path not allowed");
  if (method === "GET" && path === "/v1/healthz") return { ok: true, value: { kind: "healthz" } };
  if (method === "GET" && path === "/v1/identity") return { ok: true, value: { kind: "identity" } };
  if (method === "GET" && path === "/v1/status") return { ok: true, value: { kind: "status" } };
  if (method === "GET" && path === "/v1/catalog") return { ok: true, value: { kind: "catalog" } };
  const crash = /^\/v1\/leases\/([^/]+)\/crashes(?:\/([^/]+))?$/.exec(path);
  if (crash && method === "GET") {
    if (!LEASE.test(crash[1]!)) return deny("unknown lease id format");
    const name = crash[2] === undefined ? undefined : decodeURIComponent(crash[2]);
    if (name !== undefined && name !== "latest" && !/^[A-Za-z0-9 _.+-]{1,200}\.ips$/.test(name)) return deny("crash report names are plain .ips file names");
    return { ok: true, value: { kind: "lease", leaseId: crash[1]!, action: "crashes", ...(name !== undefined ? { crashName: name } : {}) } };
  }
  const touches = /^\/v1\/leases\/([^/]+)\/touches$/.exec(path);
  if (touches && method === "POST") {
    if (!LEASE.test(touches[1]!)) return deny("unknown lease id format");
    return { ok: true, value: { kind: "lease", leaseId: touches[1]!, action: "touches" } };
  }
  const consoleRoute = /^\/v1\/leases\/([^/]+)\/console$/.exec(path);
  if (consoleRoute && (method === "POST" || method === "GET")) {
    if (!LEASE.test(consoleRoute[1]!)) return deny("unknown lease id format");
    return { ok: true, value: { kind: "lease", leaseId: consoleRoute[1]!, action: method === "POST" ? "console-launch" : "console-read" } };
  }
  const lease = /^\/v1\/leases\/([^/]+)(?:\/(exec|stream|input|events|files|build))?$/.exec(path);
  if (lease) {
    const leaseId = lease[1]!;
    if (!LEASE.test(leaseId)) return deny("unknown lease id format");
    const sub = lease[2];
    if (!sub && method === "GET") return { ok: true, value: { kind: "lease", leaseId, action: "get" } };
    if (!sub && method === "DELETE") return { ok: true, value: { kind: "lease", leaseId, action: "delete" } };
    if (sub === "exec" && method === "POST") return { ok: true, value: { kind: "lease", leaseId, action: "exec" } };
    if ((sub === "stream" || sub === "events") && method === "GET") return { ok: true, value: { kind: "lease", leaseId, action: sub } };
    if (sub === "input" && method === "GET") return { ok: true, value: { kind: "lease", leaseId, action: "input" } };
    if (sub === "files" && method === "POST") return { ok: true, value: { kind: "lease", leaseId, action: "files-put" } };
    if (sub === "files" && method === "GET") return { ok: true, value: { kind: "lease", leaseId, action: "files-get" } };
    if (sub === "build" && method === "POST") return { ok: true, value: { kind: "lease", leaseId, action: "build" } };
    return deny("lease route not allowed");
  }
  if (path === "/v1/agent-device/rpc" && method === "POST") return { ok: true, value: { kind: "rpc" } };
  if (path === "/v1/agent-device/health" && method === "GET") return { ok: true, value: { kind: "agent-device-health" } };
  if (/^\/v1\/agent-device\/upload(\/preflight|\/finalize|\/direct\/[A-Za-z0-9_-]+)?$/.test(path) && (method === "POST" || method === "PUT")) {
    return { ok: true, value: { kind: "upload", path } };
  }
  if (/^\/v1\/agent-device\/artifacts\/[A-Za-z0-9_.-]+$/.test(path) && method === "GET") return { ok: true, value: { kind: "artifact", path } };
  // agent-device fetches a failed request's diagnostics; Tapdance's session names end in the lease id's
  // first 12 characters, which tie the request to a lease (the guard checks the token owns it).
  const diag = /^\/v1\/agent-device\/sessions\/[A-Za-z0-9_.%:-]{1,300}-([a-f0-9]{12})\/requests\/[A-Za-z0-9_-]{1,100}\/diagnostics$/.exec(path);
  if (diag && method === "GET") return { ok: true, value: { kind: "diagnostics", path, leasePrefix: diag[1]! } };
  return deny(`${method} ${path} is not part of the device API`);
}

/** agent-device commands by the policy switch that governs them. Anything else is refused. */
const COMMANDS: Record<string, Exclude<keyof GuardPolicy["allow"], "physicalDevices"> | "session"> = {
  open: "session",
  close: "session",
  devices: "inspection",
  apps: "inspection",
  appstate: "inspection",
  snapshot: "inspection",
  find: "inspection",
  get: "inspection",
  is: "inspection",
  wait: "inspection",
  diff: "inspection",
  install: "install",
  reinstall: "install",
  uninstall: "install",
  press: "interaction",
  click: "interaction",
  longpress: "interaction",
  fill: "interaction",
  type: "interaction",
  focus: "interaction",
  scroll: "interaction",
  swipe: "interaction",
  pan: "interaction",
  drag: "interaction",
  fling: "interaction",
  gesture: "interaction",
  back: "interaction",
  home: "interaction",
  keyboard: "interaction",
  "app-switcher": "interaction",
  alert: "interaction",
  orientation: "interaction",
  clipboard: "interaction",
  settings: "settings",
  perf: "perf",
  push: "notifications",
  screenshot: "screenshots",
  record: "recording",
  logs: "logs",
};

export interface RpcCall {
  method: "command" | "lease.allocate" | "lease.heartbeat" | "lease.release";
  command?: string;
  leaseId?: string;
  ttlMs?: number;
}

/** Why a policy switch refused something, with where the host's owner turns it on. */
export function policyOff(area: string, what = area): string {
  return `${what} is disabled by the local policy (${area}); the host owner can set allow.${area}: true in ~/.tapdance/worker/policy.json`;
}

export function rpcOf(body: unknown, policy: GuardPolicy, isPhysical: (leaseId: string) => boolean = () => false): Decision<RpcCall> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return deny("malformed request");
  const b = body as { method?: unknown; params?: unknown };
  const method = typeof b.method === "string" ? b.method.replace(/^agent_device\./, "") : "";
  const params = (b.params && typeof b.params === "object" ? b.params : {}) as Record<string, unknown>;
  // agent-device repeats the lease in params, params.meta and params.flags; every copy must agree,
  // so a request cannot name its own lease in one place and someone else's in another.
  const sub = (key: string) => (params[key] && typeof params[key] === "object" ? (params[key] as Record<string, unknown>) : {});
  const ids = [params["leaseId"], sub("meta")["leaseId"], sub("flags")["leaseId"]].filter((v): v is string => typeof v === "string");
  if (new Set(ids).size > 1) return deny("conflicting lease ids in one request");
  const leaseId = ids[0];
  if (method === "lease.allocate" || method === "lease.heartbeat" || method === "lease.release") {
    if (!leaseId || !LEASE.test(leaseId)) return deny("lease calls need a 32-hex lease id");
    const physical = (v: unknown) => v === true || v === "true";
    if (method === "lease.allocate" && (physical(params["physical"]) || physical(sub("flags")["physical"])) && !policy.allow.physicalDevices) {
      return deny(policyOff("physicalDevices", "physical devices"));
    }
    const ttl = typeof params["ttlMs"] === "number" ? params["ttlMs"] : typeof sub("flags")["ttlMs"] === "number" ? (sub("flags")["ttlMs"] as number) : undefined;
    return { ok: true, value: { method, leaseId, ...(ttl !== undefined ? { ttlMs: ttl } : {}) } };
  }
  if (method !== "command") return deny(`RPC method ${method || "(none)"} is not allowed`);
  const command = typeof params["command"] === "string" ? params["command"].toLowerCase() : "";
  let area = COMMANDS[command];
  if (!area) return deny(`agent-device command "${command || "(none)"}" is not part of the device API`);
  if (!leaseId || !LEASE.test(leaseId)) return deny("commands must name their lease");
  // A push to a simulator or emulator holds no one's private data; to a physical phone it needs the
  // notifications switch (#49).
  if (command === "push" && !isPhysical(leaseId)) area = "interaction";
  if (area !== "session" && !policy.allow[area]) return deny(policyOff(area, `"${command}"`));
  const narrowed = narrow(command, params);
  if (narrowed) return deny(narrowed);
  return { ok: true, value: { method: "command", command, leaseId } };
}

/** A file name the guard writes: no directories, no leading dot. */
export const FILE_NAME = /^(?!\.)[A-Za-z0-9 _.()+-]{1,128}$/;
/** A path inside an app's data container the guard reads: fixed top folders, plain names, no "..". */
export const CONTAINER_PATH = /^(Documents|Library|tmp)(\/(?!\.{1,2}(\/|$))[A-Za-z0-9 _.()+-]{1,128}){1,8}$/;
const PHOTO = /\.(png|jpe?g|heic|gif|mov|mp4|m4v)$/i;

export type FileRequest =
  | { op: "put"; destination: "photos"; name: string }
  | { op: "put"; destination: "documents"; appId: string; name: string }
  /** The Files app's "On My iPhone" (File Provider local storage). */
  | { op: "put"; destination: "files"; name: string }
  | { op: "get"; appId: string; path: string }
  | { op: "get"; area: "files"; path: string };

/**
 * Files for a leased iOS simulator: the caller names a destination kind, an app and a plain file name,
 * never a path on the Mac. The guard itself resolves where that is (simctl, through Simlock).
 */
export function filesOf(method: "PUT" | "GET", query: URLSearchParams, policy: GuardPolicy): Decision<FileRequest> {
  if (!policy.allow.files) return deny(policyOff("files"));
  const app = query.get("app") ?? "";
  if (method === "GET") {
    const path = query.get("path") ?? "";
    if (query.get("area") === "files") return FILE_NAME.test(path) ? { ok: true, value: { op: "get", area: "files", path } } : deny("path must be a plain file name in On My iPhone");
    if (!APP_ID.test(app)) return deny("app must be an app id");
    if (!CONTAINER_PATH.test(path)) return deny("path must be inside the app's Documents, Library or tmp folder");
    return { ok: true, value: { op: "get", appId: app, path } };
  }
  const name = query.get("name") ?? "";
  if (!FILE_NAME.test(name)) return deny("name must be a plain file name");
  const destination = query.get("destination");
  if (destination === "photos") return PHOTO.test(name) ? { ok: true, value: { op: "put", destination, name } } : deny("Photos takes images and videos");
  if (destination === "documents") return APP_ID.test(app) ? { ok: true, value: { op: "put", destination, appId: app, name } } : deny("documents needs app");
  if (destination === "files") return { ok: true, value: { op: "put", destination, name } };
  return deny("destination must be photos, files or documents");
}

/** Settings that change the leased device only. macOS host permissions (TCC) are never reachable. */
const DEVICE_SETTINGS = new Set(["wifi", "bluetooth", "airplane", "mobile-data", "location", "animations", "appearance", "text-size", "faceid", "touchid", "fingerprint", "clear-app-state", "reset-keychain", "permission"]);
const HOST_PERMISSIONS = new Set(["accessibility", "screen-recording", "input-monitoring"]);
/** Flags that would make agent-device read or write a path on the worker. */
const PATH_FLAGS = ["out", "tracePath", "template", "kind", "path", "file", "payloadFile"];

/**
 * Commands whose read-only or device-only forms are allowed, and whose other forms run tools or touch
 * files on the worker (xctrace/simpleperf profiles, payload files, macOS permissions). Returns a reason
 * to refuse, or undefined.
 */
function narrow(command: string, params: Record<string, unknown>): string | undefined {
  const pos = Array.isArray(params["positionals"]) ? (params["positionals"] as unknown[]).map(String) : [];
  const flags = params["flags"] && typeof params["flags"] === "object" ? (params["flags"] as Record<string, unknown>) : {};
  const pathFlag = PATH_FLAGS.find((f) => flags[f] !== undefined || params[f] !== undefined);
  switch (command) {
    case "perf":
      if (pathFlag) return `perf --${pathFlag} is not allowed: profiles write files on the worker`;
      // agent-device sends `memory` alone when "sample" is meant (its default) (#49).
      if (pos[0] === "frames" && (pos.length === 1 || (pos.length === 2 && pos[1] === "sample"))) return undefined;
      if (pos[0] === "memory" && (pos.length === 1 || (pos.length === 2 && pos[1] === "sample"))) return undefined;
      return "only `perf frames` and `perf memory sample` are allowed";
    case "settings":
      if (!DEVICE_SETTINGS.has(pos[0] ?? "")) return `setting "${pos[0] ?? ""}" is not allowed`;
      if (pos[0] === "permission" && pos.some((x) => HOST_PERMISSIONS.has(x))) return "macOS host permissions cannot be changed remotely";
      return pos.every((x) => /^[A-Za-z0-9_.:+-]{1,128}$/.test(x)) ? undefined : "setting arguments not allowed";
    case "push":
      // A JSON payload only: a path would make agent-device read a file on the worker.
      return pos.length === 2 && APP_ID.test(pos[0]!) && pos[1]!.trim().startsWith("{") && pathFlag === undefined ? undefined : "push needs an app id and an inline JSON payload";
    default:
      return undefined;
  }
}

// Output paths in screenshot/record requests are the *client's* paths: agent-device's daemon treats a
// remote request's outputs as downloadable artifacts written to its own temp directory and refuses
// local output paths "by command policy" (agent-device 0.21.35, runtime-factory). The guard relies on
// that rather than parsing every command's path flags.

const APP_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,254}$/;
const LINES = /^[1-9][0-9]{0,3}$/;
const DURATION = /^[1-9][0-9]?m$/;
/** The only log predicates Tapdance generates (see provider-simlock), with the app id slot validated. */
const PREDICATE = /^[A-Za-z0-9_.()" =[\]-]+$/;

type Area = Exclude<keyof GuardPolicy["allow"], "physicalDevices">;
type ExecValue = { tool: "adb" | "simctl"; args: string[]; stdin?: string };

const { APP_ID: DEVICE_APP_ID, QUOTED, PLAIN, SHARED_PATH, SANDBOX_PATH, CLOCK, INTENT_FLAG, EXTRA_KEY, MAX_PUSH_BYTES } = deviceCommands;
const value = (v: string | undefined) => v !== undefined && (PLAIN.test(v) || QUOTED.test(v));
const unquote = (v: string) => (v.startsWith("'") ? v.slice(1, -1) : v);

/** `am start -W` followed only by known flags with validated values (see device-commands.ts). */
function intentArgs(rest: string[]): boolean {
  if (rest.length === 0) return false;
  for (let i = 0; i < rest.length; ) {
    const flag = rest[i]!;
    if (flag === "-a" || flag === "-d" || flag === "-c") {
      if (!value(rest[i + 1])) return false;
      i += 2;
    } else if (flag === "-n") {
      if (!/^[A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.$]+$/.test(rest[i + 1] ?? "")) return false;
      i += 2;
    } else if (flag === "-f") {
      if (!INTENT_FLAG.test(rest[i + 1] ?? "")) return false;
      i += 2;
    } else if (flag === "--es" || flag === "--ez" || flag === "--ei") {
      if (!EXTRA_KEY.test(rest[i + 1] ?? "")) return false;
      const v = rest[i + 2] ?? "";
      if (flag === "--ez" ? !/^(true|false)$/.test(v) : flag === "--ei" ? !/^-?[0-9]{1,10}$/.test(v) : !value(v)) return false;
      i += 3;
    } else return false;
  }
  return true;
}

/**
 * Exact argument lists the guard lets through to Simlock's exec, each under a policy switch. This is
 * what makes a lease "device-only": no spawn of arbitrary programs, no host paths, no host shell.
 * Simlock runs adb/simctl with argument arrays and inserts the leased device itself; strings that
 * reach the Android device's own shell are limited to validated, single-quoted values.
 */
export function execOf(body: unknown, policy: GuardPolicy, lease: { physical?: boolean } = {}): Decision<ExecValue> {
  if (body === null || typeof body !== "object") return deny("malformed exec");
  const { tool, args, stdin } = body as { tool?: unknown; args?: unknown; stdin?: unknown };
  if ((tool !== "adb" && tool !== "simctl") || !Array.isArray(args) || !args.every((a) => typeof a === "string")) return deny("exec needs tool adb|simctl and string args");
  if (stdin !== undefined && typeof stdin !== "string") return deny("stdin must be a string");
  const a = args as string[];
  const gate = (area: Area, v: ExecValue): Decision<ExecValue> => (policy.allow[area] ? { ok: true, value: v } : deny(policyOff(area)));
  const plain = (area: Area) => (stdin !== undefined ? deny("stdin is not allowed for this command") : gate(area, { tool: tool as "adb" | "simctl", args: a }));
  if (tool === "simctl") {
    if (a.length === 2 && a[0] === "terminate" && APP_ID.test(a[1]!)) return plain("interaction");
    if (a[0] === "spawn" && a[1] === "log" && a[2] === "show") {
      const rest = a.slice(3);
      const allowed: string[][] = [];
      for (let i = 0; i < rest.length; i += 2) allowed.push([rest[i]!, rest[i + 1] ?? ""]);
      const valid = allowed.every(([flag, v]) =>
        flag === "--last" ? DURATION.test(v!) : flag === "--style" ? v === "compact" : flag === "--predicate" ? PREDICATE.test(v!) && v!.length < 600 : false,
      );
      return valid ? plain("logs") : deny("log show arguments not allowed");
    }
    if (a.length === 4 && a[0] === "status_bar" && a[1] === "override" && a[2] === "--time" && CLOCK.test(a[3]!)) return plain("settings");
    if (a.length === 2 && a[0] === "status_bar" && a[1] === "clear") return plain("settings");
    if (a.length === 2 && a[0] === "status_bar" && a[1] === "list") return plain("inspection");
    // The device-wide language (#49): the global AppleLanguages / AppleLocale defaults, nothing else.
    if (a.length === 7 && a[0] === "spawn" && a[1] === "defaults" && a[2] === "write" && a[3] === "-g") {
      if (a[4] === "AppleLanguages" && a[5] === "-array" && /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/.test(a[6]!)) return plain("settings");
      if (a[4] === "AppleLocale" && a[5] === "-string" && /^[a-z]{2,3}(_[A-Z][a-z]{3})?(_([A-Z]{2}|\d{3}))?$/.test(a[6]!)) return plain("settings");
      return deny("only the device language can be written");
    }
    if (a.length === 5 && a[0] === "spawn" && a[1] === "defaults" && a[2] === "read" && a[3] === "-g" && a[4] === "AppleLanguages") return plain("inspection");
    if (a.length === 1 && a[0] === "listapps") return plain("inspection");
    return deny(`simctl ${String(a[0] ?? "")} is not part of the device API`);
  }
  if (a.length === 4 && a[0] === "shell" && a[1] === "am" && a[2] === "force-stop" && APP_ID.test(a[3]!)) return plain("interaction");
  if (a.length === 3 && a[0] === "shell" && a[1] === "pidof" && APP_ID.test(a[2]!)) return stdin === undefined ? { ok: true, value: { tool, args: a } } : deny("stdin is not allowed for this command");
  if (a[0] === "logcat") {
    const okFlags = a.slice(1).every((x, i, arr) => ["-d", "-v", "threadtime", "-t", "-b", "crash"].includes(x) || /^--pid=\d+$/.test(x) || (arr[i - 1] === "-t" && LINES.test(x)));
    return okFlags ? plain("logs") : deny("logcat arguments not allowed");
  }
  if (a[0] !== "shell") return deny(`adb ${String(a[0] ?? "")} is not part of the device API`);
  const s = a.slice(1);
  // Launch with an explicit intent.
  if (s[0] === "am" && s[1] === "start" && s[2] === "-W" && intentArgs(s.slice(3))) return plain("interaction");
  // The system's view of every window (ui inspect --system).
  if (s.length === 1 && s[0] === deviceCommands.UIAUTOMATOR_DUMP) return plain("inspection");
  // One app's language (Android 13+).
  if (s.length === 6 && s[0] === "cmd" && s[1] === "locale" && s[2] === "set-app-locales" && APP_ID.test(s[3]!) && s[4] === "--locales" && deviceCommands.LOCALE.test(s[5]!)) return plain("settings");
  // Chrome without its first-run screens (a setting).
  if (s.length === 1 && s[0] === `echo '${deviceCommands.CHROME_FLAGS}' > /data/local/tmp/chrome-command-line`) return plain("settings");
  if (s.length === 4 && s[0] === "am" && s[1] === "set-debug-app" && s[2] === "--persistent" && s[3] === "com.android.chrome") return plain("settings");
  if (s.length === 4 && s[0] === "pm" && s[1] === "grant" && s[2] === "com.android.chrome" && s[3] === "android.permission.POST_NOTIFICATIONS") return plain("settings");
  // Ending an app like a user: Home, then stop-app (Android 14+) or trim + kill of the cached process.
  if (s.length === 3 && s[0] === "input" && s[1] === "keyevent" && s[2] === "3") return plain("interaction");
  if (s.length === 3 && s[0] === "am" && (s[1] === "stop-app" || s[1] === "kill") && APP_ID.test(s[2]!)) return plain("interaction");
  if (s.length === 4 && s[0] === "am" && s[1] === "send-trim-memory" && APP_ID.test(s[2]!) && s[3] === "COMPLETE") return plain("interaction");
  // Raw taps (system pickers ignore the automation helper) and which window is in front.
  if (s.length === 4 && s[0] === "input" && s[1] === "tap" && /^\d{1,5}$/.test(s[2]!) && /^\d{1,5}$/.test(s[3]!)) return plain("interaction");
  if (s.length === 3 && s[0] === "dumpsys" && s[1] === "window" && s[2] === "displays") return plain("inspection");
  // Notifications: an emulator's own shade is inspection; a physical phone's can hold the owner's
  // messages, so reading it (and posting anywhere) needs `notifications`.
  if (s.length === 3 && s[0] === "dumpsys" && s[1] === "notification" && s[2] === "--noredact") return plain(lease.physical ? "notifications" : "inspection");
  if (s.length === 3 && s[0] === "cmd" && s[1] === "statusbar" && (s[2] === "expand-notifications" || s[2] === "collapse")) return plain("interaction");
  if (s.length === 7 && s[0] === "cmd" && s[1] === "notification" && s[2] === "post" && s[3] === "-t" && value(s[4]) && s[5] === "tapdance" && value(s[6])) return plain(lease.physical ? "notifications" : "interaction");
  // Files: shared storage and a debuggable app's own sandbox, contents base64 on stdin or stdout.
  const pushShared = s.length === 1 ? /^base64 -d > '(.+)'$/.exec(s[0]!) : null;
  if (pushShared && SHARED_PATH.test(pushShared[1]!)) return withFile(stdin, a, policy);
  if (s.length === 5 && s[0] === "run-as" && DEVICE_APP_ID.test(s[1]!) && s[2] === "sh" && s[3] === "-c") {
    const m = /^'base64 -d > (.+)'$/.exec(s[4]!);
    if (m && SANDBOX_PATH.test(m[1]!)) return withFile(stdin, a, policy);
  }
  if (s.length === 2 && s[0] === "base64" && QUOTED.test(s[1]!) && SHARED_PATH.test(unquote(s[1]!))) return plain("files");
  if (s.length === 4 && s[0] === "run-as" && DEVICE_APP_ID.test(s[1]!) && s[2] === "base64" && SANDBOX_PATH.test(s[3]!)) return plain("files");
  if (s.length === 6 && s[0] === "am" && s[1] === "broadcast" && s[2] === "-a" && s[3] === "android.intent.action.MEDIA_SCANNER_SCAN_FILE" && s[4] === "-d") {
    const m = /^'file:\/\/(.+)'$/.exec(s[5]!);
    if (m && SHARED_PATH.test(m[1]!)) return plain("files");
  }
  // Anything else in the emulator's own shell: it runs inside the emulator's VM, not on this Mac. Host
  // reach (push/pull of Mac paths, port forwarding, emulator console) is not `adb shell` and stays refused.
  if (s.length >= 1 && s.join("").trim() !== "") {
    if (!policy.allow.deviceShell) return deny(policyOff("deviceShell"));
    if (lease.physical) return deny("device shell is refused on physical devices");
    if (stdin !== undefined && stdin.length > Math.min(24, policy.limits.maxUploadMB) * 1024 * 1024 * 1.4) return deny("stdin too large");
    return { ok: true, value: { tool: "adb", args: a, ...(stdin !== undefined ? { stdin } : {}) } };
  }
  return deny(`adb shell ${String(s[0] ?? "")} is not part of the device API`);
}

function withFile(stdin: string | undefined, args: string[], policy: GuardPolicy): Decision<ExecValue> {
  if (!policy.allow.files) return deny(policyOff("files"));
  if (stdin === undefined || !/^[A-Za-z0-9+/=\s]*$/.test(stdin)) return deny("file contents must be base64 on stdin");
  if ((stdin.length * 3) / 4 > Math.min(MAX_PUSH_BYTES, policy.limits.maxUploadMB * 1024 * 1024)) return deny("file too large");
  return { ok: true, value: { tool: "adb", args, stdin } };
}
