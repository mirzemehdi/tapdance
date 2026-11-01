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
  | { kind: "lease"; leaseId: string; action: "get" | "delete" | "exec" | "stream" | "input" | "events" }
  | { kind: "rpc" }
  | { kind: "agent-device-health" }
  | { kind: "upload"; path: string }
  | { kind: "artifact"; path: string };

const LEASE = /^[0-9a-f]{32}$/;

export function routeOf(method: string, rawPath: string): Decision<Route> {
  const path = rawPath.split("?")[0] ?? "";
  if (path.includes("..") || path.includes("//") || /%2e|%2f/i.test(rawPath)) return deny("path not allowed");
  if (method === "GET" && path === "/v1/healthz") return { ok: true, value: { kind: "healthz" } };
  if (method === "GET" && path === "/v1/identity") return { ok: true, value: { kind: "identity" } };
  if (method === "GET" && path === "/v1/status") return { ok: true, value: { kind: "status" } };
  if (method === "GET" && path === "/v1/catalog") return { ok: true, value: { kind: "catalog" } };
  const lease = /^\/v1\/leases\/([^/]+)(?:\/(exec|stream|input|events))?$/.exec(path);
  if (lease) {
    const leaseId = lease[1]!;
    if (!LEASE.test(leaseId)) return deny("unknown lease id format");
    const sub = lease[2];
    if (!sub && method === "GET") return { ok: true, value: { kind: "lease", leaseId, action: "get" } };
    if (!sub && method === "DELETE") return { ok: true, value: { kind: "lease", leaseId, action: "delete" } };
    if (sub === "exec" && method === "POST") return { ok: true, value: { kind: "lease", leaseId, action: "exec" } };
    if ((sub === "stream" || sub === "events") && method === "GET") return { ok: true, value: { kind: "lease", leaseId, action: sub } };
    if (sub === "input" && method === "GET") return { ok: true, value: { kind: "lease", leaseId, action: "input" } };
    return deny("lease route not allowed");
  }
  if (path === "/v1/agent-device/rpc" && method === "POST") return { ok: true, value: { kind: "rpc" } };
  if (path === "/v1/agent-device/health" && method === "GET") return { ok: true, value: { kind: "agent-device-health" } };
  if (/^\/v1\/agent-device\/upload(\/preflight|\/finalize|\/direct\/[A-Za-z0-9_-]+)?$/.test(path) && (method === "POST" || method === "PUT")) {
    return { ok: true, value: { kind: "upload", path } };
  }
  if (/^\/v1\/agent-device\/artifacts\/[A-Za-z0-9_.-]+$/.test(path) && method === "GET") return { ok: true, value: { kind: "artifact", path } };
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

export function rpcOf(body: unknown, policy: GuardPolicy): Decision<RpcCall> {
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
      return deny("physical devices are disabled by the local policy");
    }
    const ttl = typeof params["ttlMs"] === "number" ? params["ttlMs"] : typeof sub("flags")["ttlMs"] === "number" ? (sub("flags")["ttlMs"] as number) : undefined;
    return { ok: true, value: { method, leaseId, ...(ttl !== undefined ? { ttlMs: ttl } : {}) } };
  }
  if (method !== "command") return deny(`RPC method ${method || "(none)"} is not allowed`);
  const command = typeof params["command"] === "string" ? params["command"].toLowerCase() : "";
  const area = COMMANDS[command];
  if (!area) return deny(`agent-device command "${command || "(none)"}" is not part of the device API`);
  if (area !== "session" && !policy.allow[area]) return deny(`"${command}" is disabled by the local policy (${area})`);
  if (!leaseId || !LEASE.test(leaseId)) return deny("commands must name their lease");
  const narrowed = narrow(command, params);
  if (narrowed) return deny(narrowed);
  return { ok: true, value: { method: "command", command, leaseId } };
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
      if (pos[0] === "frames" && pos.length === 1) return undefined;
      if (pos[0] === "memory" && pos[1] === "sample" && pos.length === 2) return undefined;
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

const { APP_ID: DEVICE_APP_ID, QUOTED, PLAIN, SHARED_PATH, SANDBOX_PATH, LOCALE, TIME_ZONE, CLOCK, INTENT_FLAG, EXTRA_KEY, MAX_PUSH_BYTES } = deviceCommands;
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
export function execOf(body: unknown, policy: GuardPolicy): Decision<ExecValue> {
  if (body === null || typeof body !== "object") return deny("malformed exec");
  const { tool, args, stdin } = body as { tool?: unknown; args?: unknown; stdin?: unknown };
  if ((tool !== "adb" && tool !== "simctl") || !Array.isArray(args) || !args.every((a) => typeof a === "string")) return deny("exec needs tool adb|simctl and string args");
  if (stdin !== undefined && typeof stdin !== "string") return deny("stdin must be a string");
  const a = args as string[];
  const gate = (area: Area, v: ExecValue): Decision<ExecValue> => (policy.allow[area] ? { ok: true, value: v } : deny(`${area} is disabled by the local policy`));
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
  // Settings.
  if (s.length === 3 && s[0] === "wm" && s[1] === "density" && (s[2] === "reset" || /^[0-9]{2,3}$/.test(s[2]!))) return plain("settings");
  if (s.length === 6 && s[0] === "cmd" && s[1] === "locale" && s[2] === "set-app-locales" && DEVICE_APP_ID.test(s[3]!) && s[4] === "--locales" && LOCALE.test(s[5]!)) return plain("settings");
  if (s.length === 5 && s[0] === "settings" && s[1] === "put" && s[2] === "global" && s[3] === "auto_time_zone" && (s[4] === "0" || s[4] === "1")) return plain("settings");
  if (s.length === 6 && s[0] === "service" && s[1] === "call" && s[2] === "alarm" && s[3] === "3" && s[4] === "s16" && TIME_ZONE.test(s[5]!)) return plain("settings");
  // Notifications.
  if (s.length === 3 && s[0] === "dumpsys" && s[1] === "notification" && s[2] === "--noredact") return plain("notifications");
  if (s.length === 3 && s[0] === "cmd" && s[1] === "statusbar" && (s[2] === "expand-notifications" || s[2] === "collapse")) return plain("interaction");
  if (s.length === 7 && s[0] === "cmd" && s[1] === "notification" && s[2] === "post" && s[3] === "-t" && value(s[4]) && s[5] === "tapdance" && value(s[6])) return plain("notifications");
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
  return deny(`adb shell ${String(s[0] ?? "")} is not part of the device API`);
}

function withFile(stdin: string | undefined, args: string[], policy: GuardPolicy): Decision<ExecValue> {
  if (!policy.allow.files) return deny("files is disabled by the local policy");
  if (stdin === undefined || !/^[A-Za-z0-9+/=\s]*$/.test(stdin)) return deny("file contents must be base64 on stdin");
  if ((stdin.length * 3) / 4 > Math.min(MAX_PUSH_BYTES, policy.limits.maxUploadMB * 1024 * 1024)) return deny("file too large");
  return { ok: true, value: { tool: "adb", args, stdin } };
}
