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
  return { ok: true, value: { method: "command", command, leaseId } };
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

/**
 * Exact argument lists the guard lets through to Simlock's exec. This is what makes a lease
 * "device-only": no spawn of arbitrary programs, no file transfer, no shell.
 */
export function execOf(body: unknown, policy: GuardPolicy): Decision<{ tool: "adb" | "simctl"; args: string[] }> {
  if (body === null || typeof body !== "object") return deny("malformed exec");
  const { tool, args, stdin } = body as { tool?: unknown; args?: unknown; stdin?: unknown };
  if (stdin !== undefined) return deny("stdin is not allowed");
  if ((tool !== "adb" && tool !== "simctl") || !Array.isArray(args) || !args.every((a) => typeof a === "string")) return deny("exec needs tool adb|simctl and string args");
  const a = args as string[];
  const ok = (value: { tool: "adb" | "simctl"; args: string[] }) => ({ ok: true as const, value });
  if (tool === "simctl") {
    if (a.length === 2 && a[0] === "terminate" && APP_ID.test(a[1]!)) return policy.allow.interaction ? ok({ tool, args: a }) : deny("interaction disabled");
    if (a[0] === "spawn" && a[1] === "log" && a[2] === "show") {
      if (!policy.allow.logs) return deny("logs disabled by the local policy");
      const rest = a.slice(3);
      const allowed: string[][] = [];
      for (let i = 0; i < rest.length; i += 2) allowed.push([rest[i]!, rest[i + 1] ?? ""]);
      const valid = allowed.every(([flag, value]) =>
        flag === "--last" ? DURATION.test(value!) : flag === "--style" ? value === "compact" : flag === "--predicate" ? PREDICATE.test(value!) && value!.length < 600 : false,
      );
      return valid ? ok({ tool, args: a }) : deny("log show arguments not allowed");
    }
    return deny(`simctl ${String(a[0] ?? "")} is not part of the device API`);
  }
  if (a.length === 4 && a[0] === "shell" && a[1] === "am" && a[2] === "force-stop" && APP_ID.test(a[3]!)) return policy.allow.interaction ? ok({ tool, args: a }) : deny("interaction disabled");
  if (a.length === 3 && a[0] === "shell" && a[1] === "pidof" && APP_ID.test(a[2]!)) return ok({ tool, args: a });
  if (a[0] === "logcat") {
    if (!policy.allow.logs) return deny("logs disabled by the local policy");
    const okFlags = a.slice(1).every((x, i, arr) => ["-d", "-v", "threadtime", "-t", "-b", "crash"].includes(x) || /^--pid=\d+$/.test(x) || (arr[i - 1] === "-t" && LINES.test(x)));
    return okFlags ? ok({ tool, args: a }) : deny("logcat arguments not allowed");
  }
  return deny(`adb ${String(a[0] ?? "")} is not part of the device API`);
}
