import { TapdanceError, deviceCommands, redactSecrets } from "@tapdance/sdk";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { SimlockConnection } from "@tapdance/sdk";
import { checkBuildRequest, checkTimedTaps, clearConsole, consolePaths, crashReportsDir, listCrashReports, playTouches, toFramebuffer, viewportFromConfig, type Orientation, parseExecStream, readConsole, readCrashReport, runBuild, type BuildRequest, type BuildSettings, type CommandRunner } from "@tapdance/provider-simlock";
import { GuardTokens, audit, guardDir, scopedPolicy, type GuardPolicy, type GuardToken } from "./policy.js";
import { execOf, filesOf, policyOff, routeOf, rpcOf, type FileRequest } from "./rules.js";
import { HOST_STOP_COMMAND, describeHostStop, hostStopApplies, hostStopDecision, parseProcUptime, uptimeCapReached, uptimeCapRefusal } from "./host-stop.js";
import { runCommand, type CommandRunner as HostCommandRunner } from "./service.js";

/**
 * The worker guard: the only endpoint a remote control machine reaches on a worker in device-only
 * mode. It looks like the subset of Simlock's HTTP API that Tapdance uses, so the self-hosted provider
 * talks to it unchanged, but it decides locally, per request, what may pass:
 *
 * - its own revocable tokens (issued by the owner at the machine), checked on every request;
 * - an allowlist of routes, agent-device commands and exact exec argument lists (rules.ts);
 * - lease ownership per guard token, a session cap, a lease TTL cap and an upload size cap;
 * - a local audit log.
 *
 * The Simlock token stays on the machine; Simlock itself listens on loopback and must not be joined
 * to a remote gateway (that would hand the gateway shell-equivalent rights around the guard).
 */
export interface GuardOptions {
  /** Where the Mac keeps crash reports (tests pass a temporary folder). */
  crashReportsDir?: string;
  /** Runs build commands (tests pass a fake; the service uses spawn). */
  buildRunner?: CommandRunner;
  upstream: SimlockConnection;
  policy: GuardPolicy;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
  /**
   * Clears device claims left by dead agent-device processes before a lease is allocated (the remote
   * agent cannot do it). The service passes `releaseStaleDeviceClaims`; failures never block a lease.
   */
  settleStaleClaims?: () => Promise<{ released: string[]; retained: Array<{ device: string; reason: string }> }>;
  /**
   * Runs the cost guard's fixed stop command (`policy.hostStop`). The service runs it for real; tests
   * pass a fake that records the call and never powers anything off.
   */
  hostStopRunner?: HostCommandRunner;
  /** Seconds since boot (default: /proc/uptime). Tests pass a fake. */
  uptimeSeconds?: () => Promise<number | undefined>;
  /** The platform the cost guard decides for (default: this one). It never acts on darwin. */
  platform?: NodeJS.Platform;
  /** How often the cost guard checks, in ms (default 60 s). */
  hostStopIntervalMs?: number;
  /** The clock the cost guard uses (tests move it forward). */
  now?: () => number;
}

/** Seconds since boot on Linux, from /proc/uptime. */
async function procUptime(): Promise<number | undefined> {
  return parseProcUptime(await readFile("/proc/uptime", "utf8").catch(() => ""));
}

/** A Map/Set that calls `changed` after every write. */
class SavedMap extends Map<string, string> {
  changed: () => void = () => undefined;
  override set(key: string, value: string): this {
    super.set(key, value);
    this.changed();
    return this;
  }
  override delete(key: string): boolean {
    const had = super.delete(key);
    if (had) this.changed();
    return had;
  }
}
class SavedSet extends Set<string> {
  changed: () => void = () => undefined;
  override add(value: string): this {
    super.add(value);
    this.changed();
    return this;
  }
  override delete(value: string): boolean {
    const had = super.delete(value);
    if (had) this.changed();
    return had;
  }
}

/** The guard's lease ownership, kept in `file` (mode 600) so it outlives a restart. */
export function loadLeaseBook(file: string): { owners: Map<string, string>; physical: Set<string> } {
  const owners = new SavedMap();
  const physical = new SavedSet();
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { owners?: Record<string, unknown>; physical?: unknown[] };
    for (const [lease, token] of Object.entries(saved.owners ?? {})) if (typeof token === "string") owners.set(lease, token);
    for (const lease of saved.physical ?? []) if (typeof lease === "string") physical.add(lease);
  } catch {
    // No file yet, or unreadable: start empty, as before.
  }
  const save = () => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, JSON.stringify({ owners: Object.fromEntries(owners), physical: [...physical] }), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch {
      // Ownership still works in memory; only a restart would forget it.
    }
  };
  owners.changed = save;
  physical.changed = save;
  return { owners, physical };
}

/**
 * A policy refusal that the host policy allows but the token's scopes do not: says so, with the
 * pairing that would allow it, instead of sending the owner to a policy switch that is already on.
 */
export function scopeRefusal(message: string, token: GuardToken | undefined, hostPolicy: GuardPolicy): string | undefined {
  if (!token?.scopes) return undefined;
  const area = /local policy \((\w+)\)/.exec(message)?.[1] ?? (/App installs are disabled/.test(message) ? "install" : undefined);
  if (!area || !(hostPolicy.allow as Record<string, boolean>)[area]) return undefined;
  return `Refused: this token is limited to ${token.scopes.join(", ")}, and ${area} is not one of them. The host owner can pair a token that includes it: tapdance worker guard pair --label <name> --scope ${[...token.scopes, area].join(",")}`;
}

export async function startGuard(options: GuardOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const { upstream } = options;
  const policy = options.policy;
  const hostPolicy = options.policy;
  const env = options.env ?? process.env;
  const doFetch = options.fetchImpl ?? fetch;
  const tokens = new GuardTokens(env);
  // Lease ownership survives a guard restart (an update, a crash), so a running agent keeps its lease;
  // leases that ended meanwhile are dropped by activeLeases().
  const book = loadLeaseBook(join(guardDir(env), "leases.json"));
  /** leaseId → guard token id. */
  const owners = book.owners;
  /** Lease ids whose allocate is still running: reserved in `owners`, not yet known to Simlock. */
  const allocating = new Set<string>();
  /** Leases of physical phones (allocated with `physical`): no device shell on these. */
  const physicalLeases = book.physical;
  /** agent-device upload id → guard token id, learned from upload replies. */
  const uploads = new Map<string, string>();
  /** agent-device artifact id → guard token id, learned from the replies to that token's commands. */
  const artifacts = new Map<string, string>();
  /** Records every id of `key` ("uploadId", "artifactId") in a reply as belonging to `owner`. */
  const learnIds = (text: string, key: string, into: Map<string, string>, owner: string) => {
    for (const m of text.matchAll(new RegExp(`"${key}"\\s*:\\s*"([A-Za-z0-9_.-]{1,200})"`, "g"))) if (!into.has(m[1]!)) into.set(m[1]!, owner);
  };
  /** An upload id named by `text` (a request body or path) that belongs to another client. */
  const foreignUpload = (text: string, owner: string): string | undefined => {
    for (const [id, who] of uploads) if (who !== owner && text.includes(id)) return id;
    return undefined;
  };
  const upstreamHeaders = { Authorization: `Bearer ${upstream.token}` };
  let lastSettle = 0;
  const settleStaleClaims = async () => {
    if (!options.settleStaleClaims || Date.now() - lastSettle < 15_000) return;
    lastSettle = Date.now();
    try {
      const r = await options.settleStaleClaims();
      if (r.released.length > 0) options.log?.(`released stale device claims: ${r.released.join(", ")}`);
      for (const k of r.retained) options.log?.(`stale device claim kept on ${k.device}: ${k.reason}`);
    } catch (error) {
      options.log?.(`stale claim cleanup failed: ${(error as Error).message}`);
    }
  };

  /** The token a response answers, so a refusal can say when the token's scopes, not the policy, refused. */
  const tokenOf = new WeakMap<ServerResponse, GuardToken>();
  const send = (res: ServerResponse, status: number, code: string, message: string, hint?: string) => {
    if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: { code, message: scopeRefusal(message, tokenOf.get(res), hostPolicy) ?? message, ...(hint ? { hint } : {}) } }));
  };

  // ---------------------------------------------------------------- cost guard (policy.hostStop)
  const now = options.now ?? Date.now;
  const stopPlatform = options.platform ?? process.platform;
  const stopSettings = hostStopApplies(hostPolicy.hostStop, stopPlatform) ? hostPolicy.hostStop : undefined;
  if (!stopSettings && stopPlatform === "darwin" && hostPolicy.hostStop && (hostPolicy.hostStop.idleMinutes > 0 || hostPolicy.hostStop.maxUptimeHours > 0)) {
    options.log?.("policy.hostStop is ignored on macOS: the guard never powers a Mac off");
  }
  const uptime = options.uptimeSeconds ?? procUptime;
  /** When a lease, an authenticated request or a build last ran. */
  let lastActivity = now();
  /** Authenticated requests and input sockets still open: a long stream counts as use. */
  let inFlight = 0;
  /** The stop command ran and succeeded: the machine is going down. */
  let stopping = false;
  let lastStopReport = Number.NEGATIVE_INFINITY;
  const touch = () => {
    lastActivity = now();
  };
  /** Counts a request or socket as use until `onEnd` calls back. */
  const holdOpen = (onEnd: (release: () => void) => void) => {
    inFlight++;
    touch();
    let released = false;
    onEnd(() => {
      if (released) return;
      released = true;
      inFlight--;
      touch();
    });
  };

  const authenticate = async (req: IncomingMessage): Promise<GuardToken | undefined> => {
    const header = req.headers.authorization ?? "";
    const secret = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    return secret ? tokens.verify(secret) : undefined;
  };

  const readBody = async (req: IncomingMessage, limit: number): Promise<Buffer | undefined> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) return undefined;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  };

  const forward = async (req: IncomingMessage, res: ServerResponse, body?: Buffer | Readable, rewrite?: (data: unknown) => unknown, observe?: (text: string) => void) => {
    const headers: Record<string, string> = { ...upstreamHeaders };
    for (const [h, v] of Object.entries(req.headers)) {
      if (typeof v !== "string") continue;
      // agent-device's upload protocol describes the artifact and resumes in headers (agent-device
      // 0.21.35 daemon-client): without them Simlock refuses the upload.
      if (["content-type", "content-length", "accept", "if-none-match", "content-range", "x-upload-offset", "upload-offset"].includes(h) || h.startsWith("x-agent-device-") || h.startsWith("x-artifact-")) headers[h] = v;
    }
    if (Buffer.isBuffer(body)) headers["content-length"] = String(body.length);
    const init: RequestInit & { duplex?: string } = { method: req.method ?? "GET", headers };
    if (body !== undefined) {
      init.body = Buffer.isBuffer(body) ? new Uint8Array(body) : (Readable.toWeb(body) as never);
      if (!Buffer.isBuffer(body)) init.duplex = "half";
    }
    const started = Date.now();
    const answer = await doFetch(`${upstream.baseUrl}${req.url ?? ""}`, init);
    if (env["TAPDANCE_GUARD_DEBUG"]) {
      options.log?.(`upstream ${req.method} ${(req.url ?? "").split("?")[0]} headers after ${Date.now() - started} ms (${answer.headers.get("content-type") ?? ""})`);
      res.on("finish", () => options.log?.(`relayed ${(req.url ?? "").split("?")[0]} in ${Date.now() - started} ms`));
    }
    const passHeaders: Record<string, string> = {};
    answer.headers.forEach((value, key) => {
      if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(key)) passHeaders[key] = value;
    });
    if (rewrite && (answer.headers.get("content-type") ?? "").includes("json")) {
      const data = rewrite(await answer.json());
      const text = JSON.stringify(data);
      observe?.(text);
      res.writeHead(answer.status, { ...passHeaders, "content-type": "application/json" }).end(text);
      return answer;
    }
    res.writeHead(answer.status, passHeaders);
    if (answer.body) {
      const stream = Readable.fromWeb(answer.body as never);
      req.on("close", () => stream.destroy());
      if (observe) {
        // Streamed replies (progress events, then the result) are scanned as they pass; a short tail
        // carries over so an id split across two chunks is still seen.
        let tail = "";
        stream.on("data", (chunk: Buffer) => {
          const text = tail + chunk.toString("utf8");
          observe(text);
          tail = text.slice(-256);
        });
      }
      stream.pipe(res);
      await new Promise<void>((resolve) => {
        stream.on("end", resolve);
        stream.on("close", resolve);
        stream.on("error", () => resolve());
      });
    } else res.end();
    return answer;
  };

  const activeLeases = async (): Promise<number> => {
    // Drop leases that have ended (Simlock no longer knows them, or their deadline has passed), so a
    // crashed client does not hold a slot forever. Reservations of running allocates are kept.
    await Promise.all(
      [...owners.keys()].map(async (leaseId) => {
        if (allocating.has(leaseId)) return;
        const r = await doFetch(`${upstream.baseUrl}/v1/leases/${leaseId}`, { headers: upstreamHeaders }).catch(() => undefined);
        if (r === undefined) return;
        let ended = r.status === 404;
        if (r.ok) {
          const body = (await r.json().catch(() => ({}))) as { lease?: { expiresAt?: unknown } };
          const expires = typeof body.lease?.expiresAt === "string" ? Date.parse(body.lease.expiresAt) : Number.NaN;
          ended = Number.isFinite(expires) && expires <= Date.now();
        } else await r.body?.cancel().catch(() => undefined);
        if (ended && !allocating.has(leaseId)) {
          owners.delete(leaseId);
          physicalLeases.delete(leaseId);
        }
      }),
    );
    return owners.size;
  };

  /** Runs adb or simctl against a lease through the local Simlock (it puts the leased device in). */
  const execUpstream = async (leaseId: string, tool: "adb" | "simctl", args: string[]) => {
    const r = await doFetch(`${upstream.baseUrl}/v1/leases/${leaseId}/exec`, {
      method: "POST",
      headers: { ...upstreamHeaders, "content-type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
    if (!r.ok) throw new Error(`${tool} ${args[0]} answered ${r.status}`);
    return parseExecStream(await r.text());
  };
  /** Runs simctl against a lease through the local Simlock (it puts the leased simulator in). */
  const simctl = async (leaseId: string, args: string[]) => {
    const r = await doFetch(`${upstream.baseUrl}/v1/leases/${leaseId}/exec`, {
      method: "POST",
      headers: { ...upstreamHeaders, "content-type": "application/json" },
      body: JSON.stringify({ tool: "simctl", args }),
    });
    if (!r.ok) throw new Error(`simctl ${args[0]} answered ${r.status}`);
    return parseExecStream(await r.text());
  };

  /** The leased simulator's data container for an app, resolved on this Mac. */
  const container = async (leaseId: string, appId: string): Promise<string | undefined> => {
    const r = await simctl(leaseId, ["get_app_container", appId, "data"]);
    const path = r.stdout.trim().split("\n").pop() ?? "";
    if (r.exitCode !== 0 || !path.startsWith("/")) return undefined;
    return realpath(path).catch(() => undefined);
  };

  /** The leased simulator's Files app storage ("On My iPhone"), resolved and created on this Mac. */
  const filesRoot = async (leaseId: string): Promise<string | undefined> => {
    const r = await simctl(leaseId, deviceCommands.ios.filesGroups().args);
    const group = r.exitCode === 0 ? deviceCommands.parseGroupContainer(r.stdout, deviceCommands.FILES_GROUP) : undefined;
    if (!group) return undefined;
    const root = await realpath(group).catch(() => undefined);
    if (!root) return undefined;
    const storage = join(root, "File Provider Storage");
    await mkdir(storage, { recursive: true });
    // The storage folder must be a real folder inside the group container, not a link out of it.
    if ((await lstat(storage)).isSymbolicLink() || !(await realpath(storage)).startsWith(root + sep)) return undefined;
    return storage;
  };

  let building = false;
  /** Leases Simlock reports, made through this guard or locally; undefined when Simlock does not answer. */
  const simlockLeases = async (): Promise<number | undefined> => {
    const r = await doFetch(`${upstream.baseUrl}/v1/status`, { headers: upstreamHeaders }).catch(() => undefined);
    if (!r?.ok) {
      await r?.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const body = (await r.json().catch(() => ({}))) as { leases?: unknown };
    return Array.isArray(body.leases) ? body.leases.length : 0;
  };
  /** One cost-guard check: notes activity, then powers off when the policy says so. */
  let checking = false;
  const checkHostStop = async () => {
    if (!stopSettings || stopping || checking) return;
    checking = true;
    try {
      const leases = await simlockLeases();
      const busy = (leases ?? 0) > 0 || allocating.size > 0 || building || inFlight > 0;
      if (busy) touch();
      const decision = hostStopDecision(stopSettings, { now: now(), lastActivity, busy, uptimeSeconds: await uptime() });
      // For `tapdance host status`: how long the host has been idle.
      await writeFile(
        join(guardDir(env), "host-stop.json"),
        JSON.stringify({ checkedAt: new Date(now()).toISOString(), lastActivityAt: new Date(lastActivity).toISOString(), leases: leases ?? null, ...stopSettings }),
        { mode: 0o600 },
      ).catch(() => undefined);
      if (!decision.stop) return;
      // Report the first attempt, then a failing one (no sudo rule yet) at most once an hour.
      const report = now() - lastStopReport >= 3_600_000;
      const command = HOST_STOP_COMMAND.join(" ");
      if (report) await audit({ method: "TIMER", path: "host-stop", decision: "allow", command, reason: decision.message }, env).catch(() => undefined);
      const [file, ...args] = HOST_STOP_COMMAND;
      const r = await (options.hostStopRunner ?? runCommand)(file, args).catch((error: Error) => ({ ok: false, out: error.message }));
      if (r.ok) {
        stopping = true;
        options.log?.(`cost guard: powering off (${decision.message})`);
        return;
      }
      if (report) {
        lastStopReport = now();
        const why = redactSecrets(r.out.split("\n")[0] ?? "").slice(0, 200);
        options.log?.(`cost guard: ${command} failed (${why}); the host keeps running. Install the sudoers rule that \`tapdance host up\` prints.`);
        await audit({ method: "TIMER", path: "host-stop", decision: "deny", command, reason: `stop command failed: ${why}` }, env).catch(() => undefined);
      }
    } catch (error) {
      options.log?.(`cost guard check failed: ${(error as Error).message}`);
    } finally {
      checking = false;
    }
  };
  const stopTimer = stopSettings ? setInterval(() => void checkHostStop(), options.hostStopIntervalMs ?? 60_000) : undefined;
  stopTimer?.unref();
  if (stopSettings) options.log?.(`cost guard: ${describeHostStop(stopSettings, stopPlatform)}`);
  /** The owner's build settings, with the deploy key `host builds key` created, when there is one. */
  const buildSettings = (): BuildSettings => {
    const key = join(guardDir(env), "builds", "deploy_key");
    return { ...hostPolicy.builds, ...(existsSync(key) ? { deployKeyPath: key } : {}) };
  };
  /**
   * Builds on this machine and installs the result on the lease, streaming the log as NDJSON lines
   * ({"log": …}, then {"result": …} or {"error": …}).
   */
  const runBuildRoute = async (res: ServerResponse, leaseId: string, request: BuildRequest, decide: (d: "allow" | "deny", e?: { reason?: string; command?: string; leaseId?: string }) => Promise<void>) => {
    building = true;
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    const line = (value: unknown) => res.write(`${JSON.stringify(value)}\n`);
    try {
      const result = await runBuild(request, buildSettings(), join(guardDir(env), "builds"), (l) => line({ log: redactSecrets(l) }), options.buildRunner);
      const install =
        request.platform === "ios"
          ? await execUpstream(leaseId, "simctl", ["install", result.artifact])
          : await execUpstream(leaseId, "adb", ["install", "-r", "-t", result.artifact]);
      if (install.exitCode !== 0) throw new TapdanceError("DEVICE_ERROR", `Installing the build failed: ${(install.stderr || install.stdout).trim().split("\n").slice(-3).join(" ")}`);
      await decide("allow", { command: `build installed ${result.sha}`, leaseId });
      line({ result: { sha: result.sha, seconds: result.seconds, artifact: result.artifact.split(sep).pop(), installed: true, ...(result.reused ? { reused: true } : {}) } });
    } catch (error) {
      const e = error instanceof TapdanceError ? error : new TapdanceError("INTERNAL", (error as Error).message);
      await decide("deny", { reason: `build failed: ${e.message}`, leaseId });
      line({ error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}), ...(e.details?.["tail"] ? { tail: e.details["tail"] } : {}) } });
    } finally {
      building = false;
      res.end();
    }
  };

  /** Carries a file to or from a leased iOS simulator. Paths are the guard's own, never the caller's. */
  const handleFiles = async (req: IncomingMessage, res: ServerResponse, leaseId: string, file: FileRequest, decide: (d: "allow" | "deny", e?: { reason?: string; command?: string; leaseId?: string }) => Promise<void>) => {
    const detail = await doFetch(`${upstream.baseUrl}/v1/leases/${leaseId}`, { headers: upstreamHeaders });
    const lease = detail.ok ? ((await detail.json()) as { lease?: { platform?: string } }).lease : undefined;
    if (lease?.platform !== "ios") {
      await decide("deny", { reason: "files route is for iOS simulators", leaseId });
      return send(res, 400, "NOT_SUPPORTED", "This route is for iOS simulators; Android files go through exec");
    }
    const limit = policy.limits.maxUploadMB * 1024 * 1024;
    if (file.op === "get" && "area" in file) {
      const root = await filesRoot(leaseId);
      if (!root) return send(res, 404, "DEVICE_ERROR", "The Files app's local storage was not found on this simulator");
      const target = await realpath(join(root, file.path)).catch(() => undefined);
      if (!target || !target.startsWith(root + sep)) {
        await decide("deny", { reason: "path leaves On My iPhone", leaseId });
        return send(res, 404, "USAGE", "No such file in On My iPhone");
      }
      const info = await stat(target);
      if (!info.isFile() || info.size > limit) return send(res, 400, "USAGE", info.isFile() ? "File too large" : "Not a file");
      await decide("allow", { command: "files get files", leaseId });
      res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" }).end(await readFile(target));
      return;
    }
    if (file.op === "get") {
      const root = await container(leaseId, file.appId);
      if (!root) return send(res, 404, "APP_NOT_INSTALLED", `${file.appId} has no data container on this simulator`);
      const target = await realpath(join(root, file.path)).catch(() => undefined);
      // realpath follows links: whatever a link inside the container points at must still be inside it.
      if (!target || !target.startsWith(root + sep)) {
        await decide("deny", { reason: "path leaves the app container", leaseId });
        return send(res, 403, "FORBIDDEN", "That path is not inside the app's container");
      }
      const info = await stat(target);
      if (!info.isFile() || info.size > limit) return send(res, 400, "USAGE", info.isFile() ? "File too large" : "Not a file");
      await decide("allow", { command: "files get", leaseId });
      res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" }).end(await readFile(target));
      return;
    }
    const body = await readBody(req, limit);
    if (body === undefined) {
      await decide("deny", { reason: "file too large", leaseId });
      return send(res, 413, "TOO_LARGE", `Files are limited to ${policy.limits.maxUploadMB} MB on this worker`);
    }
    if (file.destination === "photos") {
      // Staged in the guard's own folder (mode 700) under a random name, handed to simctl, then deleted.
      const dir = join(guardDir(env), "staging", leaseId, randomBytes(8).toString("hex"));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const staged = join(dir, file.name);
      try {
        await writeFile(staged, body, { mode: 0o600, flag: "wx" });
        const r = await simctl(leaseId, ["addmedia", staged]);
        if (r.exitCode !== 0) return send(res, 400, "DEVICE_ERROR", `simctl addmedia failed: ${r.stderr.trim().slice(0, 200)}`);
      } finally {
        await rm(join(guardDir(env), "staging", leaseId), { recursive: true, force: true });
      }
      await decide("allow", { command: "files put photos", leaseId });
      return send200(res, { ok: true, devicePath: "Photos" });
    }
    if (file.destination === "files") {
      const storage = await filesRoot(leaseId);
      if (!storage) return send(res, 404, "DEVICE_ERROR", "The Files app's local storage was not found on this simulator");
      const target = join(storage, file.name);
      if ((await lstat(target).catch(() => undefined))?.isSymbolicLink()) {
        await decide("deny", { reason: "target is a link", leaseId });
        return send(res, 403, "FORBIDDEN", "Refusing to write through a link");
      }
      const tmp = join(storage, `.tapdance-${randomBytes(6).toString("hex")}`);
      await writeFile(tmp, body, { mode: 0o644, flag: "wx" });
      await rename(tmp, target);
      await decide("allow", { command: "files put files", leaseId });
      return send200(res, { ok: true, devicePath: `On My iPhone/${file.name}` });
    }
    const root = await container(leaseId, file.appId);
    if (!root) return send(res, 404, "APP_NOT_INSTALLED", `${file.appId} has no data container on this simulator`);
    const documents = join(root, "Documents");
    await mkdir(documents, { recursive: true });
    // Documents itself must be a real folder in the container, not a link out of it.
    if ((await lstat(documents)).isSymbolicLink() || !(await realpath(documents)).startsWith(root + sep)) {
      await decide("deny", { reason: "Documents is not inside the container", leaseId });
      return send(res, 403, "FORBIDDEN", "The app's Documents folder is not inside its container");
    }
    const target = join(documents, file.name);
    const existing = await lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink()) {
      await decide("deny", { reason: "target is a link", leaseId });
      return send(res, 403, "FORBIDDEN", "Refusing to write through a link");
    }
    const tmp = join(dirname(target), `.tapdance-${randomBytes(6).toString("hex")}`);
    await writeFile(tmp, body, { mode: 0o644, flag: "wx" });
    await rename(tmp, target);
    await decide("allow", { command: "files put documents", leaseId });
    return send200(res, { ok: true, devicePath: `Documents/${file.name}` });
  };

  const send200 = (res: ServerResponse, value: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
  };

  /** A JSON-RPC reply that reports success: no `error` member and no `result.ok === false`. */
  const rpcSucceeded = (data: unknown): boolean => {
    if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
    const d = data as { error?: unknown; result?: unknown };
    if (d.error !== undefined && d.error !== null) return false;
    const result = d.result as { ok?: unknown } | undefined;
    return !(result && typeof result === "object" && result.ok === false);
  };

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    let token: GuardToken | undefined;
    const decide = async (decision: "allow" | "deny", extra: { reason?: string; command?: string; leaseId?: string } = {}) =>
      audit({ client: token?.id, method, path: path.split("?")[0]!, decision, ...extra }, env).catch(() => undefined);
    try {
      const route = routeOf(method, path);
      if (!route.ok) {
        await decide("deny", { reason: route.reason });
        return send(res, 404, "NOT_ALLOWED", route.reason);
      }
      if (route.value.kind === "healthz") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }
      token = await authenticate(req);
      if (token) tokenOf.set(res, token);
      if (!token) {
        await decide("deny", { reason: "unauthenticated" });
        return send(res, 401, "UNAUTHENTICATED", "Missing, expired or revoked worker-guard token");
      }
      // Any authenticated request is use of the host, for as long as it stays open.
      holdOpen((release) => res.once("close", release));
      // This token's view of the policy: a switch is on only when the host allows it and the token's
      // scopes (when it has any) include it.
      const policy = scopedPolicy(hostPolicy, token);
      const r = route.value;
      switch (r.kind) {
        case "identity":
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ principal: token.id, name: token.label, role: "agent", via: "tapdance-worker-guard" }));
          return;
        case "status":
          await forward(req, res, undefined, (data) => {
            // Simlock sees one local principal behind the guard, so it cannot filter per client: the
            // guard keeps only this token's leases, its own waiting requests and the devices they hold.
            type Device = { id?: string; udid?: string };
            const d = data as { leases?: Array<{ id: string; deviceId?: string; udid?: string }>; waiting?: Array<{ requesterId?: string }>; devices?: Device[] };
            const leases = (d.leases ?? []).filter((l) => owners.get(l.id) === token!.id);
            const held = new Set(leases.flatMap((l) => [l.deviceId, l.udid].filter((v): v is string => typeof v === "string")));
            return {
              ...d,
              leases,
              ...(d.waiting !== undefined ? { waiting: d.waiting.filter((w) => typeof w.requesterId === "string" && owners.get(w.requesterId) === token!.id) } : {}),
              devices: (d.devices ?? []).filter((dev) => (dev.id !== undefined && held.has(dev.id)) || (dev.udid !== undefined && held.has(dev.udid))),
            };
          });
          return;
        case "catalog":
        case "agent-device-health":
          await forward(req, res);
          return;
        case "lease": {
          if (owners.get(r.leaseId) !== token.id) {
            await decide("deny", { reason: "not this token's lease", leaseId: r.leaseId });
            return send(res, 404, "UNKNOWN_LEASE", "No such lease for this token");
          }
          if (r.action === "build") {
            if (!policy.allow.builds) {
              await decide("deny", { reason: "builds off", leaseId: r.leaseId, command: "build" });
              return send(res, 403, "FORBIDDEN", policyOff("builds", "Builds"));
            }
            if (building) return send(res, 429, "NO_CAPACITY", "Another build is running on this host; try again when it finishes");
            const raw = await readBody(req, 64 * 1024);
            // The platform is the lease's, not whatever the client says.
            const detail = await doFetch(`${upstream.baseUrl}/v1/leases/${r.leaseId}`, { headers: upstreamHeaders });
            const platform = detail.ok ? ((await detail.json()) as { lease?: { platform?: string } }).lease?.platform : undefined;
            let request: BuildRequest;
            try {
              const asked = raw ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};
              request = checkBuildRequest({ ...asked, platform }, buildSettings());
            } catch (error) {
              const e = error instanceof TapdanceError ? error : new TapdanceError("USAGE", "The build request is not valid JSON");
              await decide("deny", { reason: e.message, leaseId: r.leaseId, command: "build" });
              return send(res, e.code === "FORBIDDEN" ? 403 : 400, e.code, e.message);
            }
            await decide("allow", { command: `build ${request.platform} ${request.repo}@${request.ref}`, leaseId: r.leaseId });
            await runBuildRoute(res, r.leaseId, request, decide);
            return;
          }
          if (r.action === "touches") {
            // Timed taps on an iOS simulator, scheduled here next to Simlock so the network between
            // the agent and this machine adds no jitter (#58). Same rights as live input.
            if (!policy.allow.interaction || !policy.allow.input) {
              await decide("deny", { reason: "interaction or input off", leaseId: r.leaseId, command: "touches" });
              return send(res, 403, "FORBIDDEN", policyOff(policy.allow.interaction ? "input" : "interaction", "Timed taps"));
            }
            const detail = await doFetch(`${upstream.baseUrl}/v1/leases/${r.leaseId}`, { headers: upstreamHeaders });
            const lease = detail.ok ? ((await detail.json()) as { lease?: { platform?: string } }).lease : undefined;
            if (lease?.platform !== "ios") return send(res, 400, "NOT_SUPPORTED", "This route is for iOS simulators; Android sequences run in the emulator's shell");
            let steps;
            let viewport: { width: number; height: number } | undefined;
            let orientation: Orientation;
            let model = "";
            try {
              const raw = await readBody(req, 512 * 1024);
              const body = JSON.parse(raw ? raw.toString("utf8") : "{}") as { steps?: unknown; viewport?: { width?: unknown; height?: unknown }; orientation?: unknown; model?: unknown };
              steps = checkTimedTaps(body.steps);
              if (body.viewport !== undefined) {
                const w = Number(body.viewport?.width);
                const h = Number(body.viewport?.height);
                if (!(w > 0 && w < 5000 && h > 0 && h < 5000)) throw new TapdanceError("USAGE", "viewport must give the screen's width and height in points");
                viewport = { width: w, height: h };
              }
              if (typeof body.model === "string" && body.model.length < 100) model = body.model;
              const o = body.orientation ?? "portrait";
              if (!["portrait", "landscape-left", "landscape-right", "portrait-upside-down"].includes(String(o))) throw new TapdanceError("USAGE", "orientation must be portrait, landscape-left, landscape-right or portrait-upside-down");
              orientation = o as Orientation;
            } catch (error) {
              const e = error instanceof TapdanceError ? error : new TapdanceError("USAGE", "The request is not valid JSON");
              await decide("deny", { reason: e.message, leaseId: r.leaseId, command: "touches" });
              return send(res, 400, e.code, e.message);
            }
            await decide("allow", { command: `touches ${steps.length}`, leaseId: r.leaseId });
            const up = new WebSocket(`${upstream.baseUrl.replace(/^http/, "ws")}/v1/leases/${r.leaseId}/input`, { headers: upstreamHeaders });
            try {
              await new Promise<void>((resolve, reject) => {
                up.once("open", () => resolve());
                up.once("error", reject);
              });
              const played = await playTouches(up, steps, (x, y, config) => toFramebuffer(x, y, viewport ?? viewportFromConfig(config, orientation, model), orientation));
              res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
              res.end(JSON.stringify({ steps: played }));
            } catch (error) {
              const e = error instanceof TapdanceError ? error : new TapdanceError("DEVICE_ERROR", `The input channel failed: ${(error as Error).message}`);
              send(res, e.code === "NOT_SUPPORTED" ? 400 : 502, e.code, e.message);
            } finally {
              up.close();
            }
            return;
          }
          if (r.action === "console-launch" || r.action === "console-read") {
            // An iOS app's stdout/stderr (print, println), captured in files the guard chooses (#59).
            const area = r.action === "console-launch" ? "interaction" : "logs";
            if (!policy.allow[area]) {
              await decide("deny", { reason: `${area} off`, leaseId: r.leaseId, command: r.action });
              return send(res, 403, "FORBIDDEN", policyOff(area, r.action === "console-launch" ? "Launching apps" : "Logs"));
            }
            const detail = await doFetch(`${upstream.baseUrl}/v1/leases/${r.leaseId}`, { headers: upstreamHeaders });
            const lease = detail.ok ? ((await detail.json()) as { lease?: { platform?: string } }).lease : undefined;
            if (lease?.platform !== "ios") {
              await decide("deny", { reason: "console capture is for iOS simulators", leaseId: r.leaseId });
              return send(res, 400, "NOT_SUPPORTED", "Console capture is for iOS simulators; on Android, logs --app reads logcat");
            }
            const dir = join(guardDir(env), "console");
            if (r.action === "console-read") {
              const lines = Number(new URL(path, "http://guard").searchParams.get("lines") ?? "200");
              await decide("allow", { command: "console read", leaseId: r.leaseId });
              res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
              res.end(JSON.stringify(await readConsole(dir, r.leaseId, Number.isFinite(lines) ? lines : 200)));
              return;
            }
            const raw = await readBody(req, 64 * 1024);
            const body = (raw ? JSON.parse(raw.toString("utf8")) : {}) as { appId?: unknown; args?: unknown };
            const appId = typeof body.appId === "string" ? body.appId : "";
            const args = Array.isArray(body.args) ? body.args : [];
            if (!/^[A-Za-z][A-Za-z0-9_.-]{0,254}$/.test(appId) || args.length > 32 || args.some((a) => typeof a !== "string" || a.length > 1024 || a.includes("\u0000") || a.startsWith("--std"))) {
              await decide("deny", { reason: "bad console launch", leaseId: r.leaseId });
              return send(res, 400, "USAGE", "console launch takes an app id and up to 32 plain launch arguments");
            }
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await clearConsole(dir, r.leaseId);
            const p = consolePaths(dir, r.leaseId);
            const cmd = deviceCommands.ios.launchWithConsole(appId, p.stdout, p.stderr, args as string[]);
            await decide("allow", { command: `launch ${appId} with console`, leaseId: r.leaseId });
            const launched = await execUpstream(r.leaseId, "simctl", cmd.args);
            if (launched.exitCode !== 0) return send(res, 502, "DEVICE_ERROR", `Launching ${appId} failed: ${(launched.stderr || launched.stdout).trim().slice(0, 300)}`);
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(JSON.stringify({ launched: appId }));
            return;
          }
          if (r.action === "crashes") {
            if (!policy.allow.logs) {
              await decide("deny", { reason: "logs off", leaseId: r.leaseId, command: "crashes" });
              return send(res, 403, "FORBIDDEN", policyOff("logs", "Logs and crash reports"));
            }
            // Only reports that name this lease's simulator, written since the lease began (#59).
            const detail = await doFetch(`${upstream.baseUrl}/v1/leases/${r.leaseId}`, { headers: upstreamHeaders });
            const lease = detail.ok ? ((await detail.json()) as { lease?: { platform?: string; udid?: string; deviceId?: string; createdAt?: string } }).lease : undefined;
            const udid = lease?.udid ?? lease?.deviceId;
            if (lease?.platform !== "ios" || !udid || !/^[0-9A-F-]{36}$/i.test(udid)) {
              await decide("deny", { reason: "crash reports are for iOS simulators", leaseId: r.leaseId });
              return send(res, 400, "NOT_SUPPORTED", "Crash report files are for iOS simulators; on Android use logs --crash");
            }
            const created = lease.createdAt ? Date.parse(lease.createdAt) : Number.NaN;
            const app = new URL(path, "http://guard").searchParams.get("app") ?? undefined;
            if (app !== undefined && !/^[A-Za-z][A-Za-z0-9_.-]{0,254}$/.test(app)) return send(res, 400, "USAGE", "app must be a bundle id");
            const filter = { udid, since: Number.isFinite(created) ? created - 60_000 : Date.now() - 24 * 3_600_000, ...(app ? { bundleId: app } : {}) };
            const dir = options.crashReportsDir ?? crashReportsDir();
            await decide("allow", { command: r.crashName ? `crash report ${r.crashName}` : "crash reports", leaseId: r.leaseId });
            if (!r.crashName) {
              res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
              res.end(JSON.stringify({ reports: await listCrashReports(dir, filter) }));
              return;
            }
            try {
              const report = await readCrashReport(dir, r.crashName, filter);
              res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-tapdance-crash-name": encodeURIComponent(report.name) });
              res.end(report.text);
            } catch (error) {
              const e = error instanceof TapdanceError ? error : new TapdanceError("INTERNAL", (error as Error).message);
              return send(res, 404, e.code, e.message);
            }
            return;
          }
          if (r.action === "files-put" || r.action === "files-get") {
            const decision = filesOf(r.action === "files-put" ? "PUT" : "GET", new URL(path, "http://guard").searchParams, policy);
            if (!decision.ok) {
              await decide("deny", { reason: decision.reason, leaseId: r.leaseId, command: "files" });
              return send(res, 403, "FORBIDDEN", decision.reason);
            }
            await handleFiles(req, res, r.leaseId, decision.value, decide);
            return;
          }
          if ((r.action === "stream" && !policy.allow.streaming) || (r.action === "input" && !policy.allow.input)) {
            await decide("deny", { reason: `${r.action} disabled by policy`, leaseId: r.leaseId });
            return send(res, 403, "FORBIDDEN", `${r.action} is disabled by the worker's local policy`);
          }
          if (r.action === "exec") {
            // File pushes carry base64 contents on stdin; everything else is a short argument list.
            const body = await readBody(req, policy.allow.files ? Math.ceil(Math.min(24, policy.limits.maxUploadMB) * 1024 * 1024 * 1.4) + 64 * 1024 : 64 * 1024);
            let parsed: unknown;
            try {
              parsed = body ? JSON.parse(body.toString("utf8")) : undefined;
            } catch {
              parsed = undefined;
            }
            const decision = execOf(parsed, policy, { physical: physicalLeases.has(r.leaseId) });
            if (!decision.ok) {
              await decide("deny", { reason: decision.reason, leaseId: r.leaseId, command: "exec" });
              return send(res, 403, "PASSTHROUGH_REFUSED", decision.reason);
            }
            await decide("allow", { leaseId: r.leaseId, command: `exec ${decision.value.tool} ${decision.value.args[0]}` });
            await forward(req, res, Buffer.from(JSON.stringify(decision.value)));
            return;
          }
          await decide("allow", { leaseId: r.leaseId, command: r.action });
          const answer = await forward(req, res);
          if (r.action === "delete" && answer.ok) {
            owners.delete(r.leaseId);
            physicalLeases.delete(r.leaseId);
          }
          return;
        }
        case "rpc": {
          const body = await readBody(req, 1024 * 1024);
          let parsed: unknown;
          try {
            parsed = body ? JSON.parse(body.toString("utf8")) : undefined;
          } catch {
            parsed = undefined;
          }
          const decision = rpcOf(parsed, policy, (id) => physicalLeases.has(id));
          if (!decision.ok && env["TAPDANCE_GUARD_DEBUG"]) {
            // Shapes only, never values: enough to extend the allowlist safely.
            const shape = (v: unknown, depth = 0): unknown =>
              v && typeof v === "object" && depth < 3 ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shape(x, depth + 1)])) : typeof v;
            options.log?.(`denied rpc shape: ${JSON.stringify(shape(parsed))}`);
          }
          if (!decision.ok) {
            await decide("deny", { reason: decision.reason });
            return send(res, 403, "FORBIDDEN", decision.reason);
          }
          const call = decision.value;
          const params = (parsed as { params: Record<string, unknown> }).params;
          // The client's credential is the guard token; Simlock gets the local one, as a local client would send.
          if ("token" in params) params["token"] = upstream.token;
          // The client names the guard as its daemon; Simlock and agent-device should see themselves.
          const flags = params["flags"] as Record<string, unknown> | undefined;
          if (flags && typeof flags["daemonBaseUrl"] === "string") flags["daemonBaseUrl"] = `${upstream.baseUrl}/v1/agent-device`;
          const owner = call.leaseId ? owners.get(call.leaseId) : undefined;
          if (call.method === "lease.allocate") {
            if (owner) {
              await decide("deny", { reason: "lease id already in use", leaseId: call.leaseId });
              return send(res, 409, "FORBIDDEN", "Lease id already in use");
            }
            const leaseId = call.leaseId!;
            if (stopSettings && (stopping || uptimeCapReached(stopSettings, await uptime()))) {
              const refusal = uptimeCapRefusal(stopSettings);
              await decide("deny", { reason: stopping ? "host is powering off" : "uptime cap", leaseId });
              return send(res, 503, refusal.code, stopping ? "This host is powering off (its owner's cost guard) and takes no new leases" : refusal.message, refusal.hint);
            }
            // Count and reserve with no await in between, so parallel allocates cannot all pass the cap.
            if (owners.size >= policy.limits.maxSessions) await activeLeases();
            if (owners.size >= policy.limits.maxSessions || owners.has(leaseId)) {
              await decide("deny", { reason: "session limit", leaseId });
              return send(res, 429, "NO_CAPACITY", `This worker allows ${policy.limits.maxSessions} session(s) at a time; another lease is running (release it first, or the host owner raises limits.maxSessions in ~/.tapdance/worker/policy.json and restarts the guard)`);
            }
            owners.set(leaseId, token.id); // reserved while the allocate runs
            allocating.add(leaseId);
            const ap = (parsed as { params: Record<string, unknown> }).params;
            const flagsOf = (ap["flags"] && typeof ap["flags"] === "object" ? ap["flags"] : {}) as Record<string, unknown>;
            if ([ap["physical"], flagsOf["physical"]].some((v) => v === true || v === "true")) physicalLeases.add(leaseId);
            let granted = false;
            try {
              const cap = policy.limits.maxLeaseMinutes * 60_000;
              const p = (parsed as { params: Record<string, unknown> }).params;
              if (typeof p["ttlMs"] !== "number" || p["ttlMs"] > cap) p["ttlMs"] = cap;
              await decide("allow", { command: "lease.allocate", leaseId });
              await settleStaleClaims();
              let succeeded = false;
              const answer = await forward(req, res, Buffer.from(JSON.stringify(parsed)), (data) => {
                succeeded = rpcSucceeded(data);
                return data;
              });
              // agent-device reports a refused allocate as HTTP 200 with a JSON-RPC error: ownership
              // stays only on a 2xx JSON reply that says it succeeded.
              granted = answer.ok && succeeded;
            } finally {
              allocating.delete(leaseId);
              if (!granted) {
                owners.delete(leaseId);
                physicalLeases.delete(leaseId);
              }
            }
            return;
          }
          if (owner !== token.id) {
            await decide("deny", { reason: "not this token's lease", ...(call.command ? { command: call.command } : {}), ...(call.leaseId ? { leaseId: call.leaseId } : {}) });
            return send(res, 403, "FORBIDDEN", "refused: lease is not one of yours on this worker");
          }
          if (call.method === "lease.heartbeat") {
            const p = (parsed as { params: Record<string, unknown> }).params;
            const cap = policy.limits.maxLeaseMinutes * 60_000;
            if (typeof p["ttlMs"] !== "number" || p["ttlMs"] > cap) p["ttlMs"] = cap;
          }
          const foreign = foreignUpload(body!.toString("utf8"), token.id);
          if (foreign) {
            await decide("deny", { reason: "upload belongs to another client", ...(call.command ? { command: call.command } : {}), leaseId: call.leaseId! });
            return send(res, 403, "FORBIDDEN", "refused: that upload is not one of yours");
          }
          await decide("allow", { command: call.command ?? call.method, ...(call.leaseId ? { leaseId: call.leaseId } : {}) });
          const owner_ = token.id;
          await forward(req, res, Buffer.from(JSON.stringify(parsed)), undefined, (text) => learnIds(text, "artifactId", artifacts, owner_));
          // `close` ends the session; ownership lasts until the lease is released or expires.
          if (call.method === "lease.release") {
            owners.delete(call.leaseId!);
            physicalLeases.delete(call.leaseId!);
          }
          return;
        }
        case "upload": {
          if (!policy.allow.install) {
            await decide("deny", { reason: "install disabled by policy" });
            return send(res, 403, "FORBIDDEN", "App installs are disabled by the worker's local policy");
          }
          const limit = policy.limits.maxUploadMB * 1024 * 1024;
          const declared = Number(req.headers["content-length"] ?? "0");
          if (declared > limit) {
            await decide("deny", { reason: "upload too large" });
            return send(res, 413, "TOO_LARGE", `Uploads are limited to ${policy.limits.maxUploadMB} MB on this worker`);
          }
          // Uploads name their lease in a header; it must be this client's, and an upload id in the path
          // or body must be one this client started.
          const uploadLease = req.headers["x-agent-device-lease-id"];
          if (typeof uploadLease !== "string" || owners.get(uploadLease) !== token.id) {
            await decide("deny", { reason: "upload without one of this token's leases" });
            return send(res, 403, "FORBIDDEN", "refused: uploads must name one of your leases");
          }
          const owner_ = token.id;
          const directId = /\/upload\/direct\/([A-Za-z0-9_-]+)$/.exec(r.path)?.[1];
          if (directId && uploads.get(directId) !== token.id) {
            await decide("deny", { reason: "upload belongs to another client", leaseId: uploadLease });
            return send(res, 403, "FORBIDDEN", "refused: that upload is not one of yours");
          }
          if (r.path.endsWith("/finalize")) {
            const body = await readBody(req, 64 * 1024);
            const text = body?.toString("utf8") ?? "";
            const named = /"uploadId"\s*:\s*"([A-Za-z0-9_.-]+)"/.exec(text)?.[1];
            if (!named || uploads.get(named) !== token.id) {
              await decide("deny", { reason: "finalize of an upload that is not this client's", leaseId: uploadLease });
              return send(res, 403, "FORBIDDEN", "refused: that upload is not one of yours");
            }
            await decide("allow", { command: "upload finalize", leaseId: uploadLease });
            await forward(req, res, body, undefined, (t) => learnIds(t, "artifactId", artifacts, owner_));
            return;
          }
          let seen = 0;
          const counted = new Readable({ read() {} });
          req.on("data", (c: Buffer) => {
            seen += c.length;
            if (seen > limit) {
              counted.destroy(new Error("upload too large"));
              req.destroy();
            } else counted.push(c);
          });
          req.on("end", () => counted.push(null));
          await decide("allow", { command: "upload", leaseId: uploadLease });
          await forward(req, res, counted, undefined, (t) => learnIds(t, "uploadId", uploads, owner_));
          return;
        }
        case "artifact": {
          const id = decodeURIComponent(r.path.split("/").pop() ?? "");
          if (artifacts.get(id) !== token.id) {
            await decide("deny", { reason: "artifact belongs to another client or is unknown" });
            return send(res, 404, "NOT_FOUND", "No such artifact for this token");
          }
          await decide("allow", { command: "artifact download" });
          await forward(req, res);
          return;
        }
        case "diagnostics": {
          const leaseId = [...owners].find(([id, who]) => who === token!.id && id.startsWith(r.leasePrefix))?.[0];
          if (!leaseId) {
            await decide("deny", { reason: "diagnostics of a session this token does not own" });
            return send(res, 404, "NOT_FOUND", "No such session for this token");
          }
          await decide("allow", { command: "diagnostics", leaseId });
          await forward(req, res);
          return;
        }
      }
    } catch (error) {
      options.log?.(`guard: ${(error as Error).message}`);
      send(res, 502, "UPSTREAM_ERROR", "The worker's Simlock did not answer");
    }
  });

  // Live input: same ownership and policy checks, then a socket-to-socket relay with the local token.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", async (req, socket, head) => {
    const route = routeOf("GET", req.url ?? "/");
    const token = await authenticate(req);
    if (!route.ok || route.value.kind !== "lease" || route.value.action !== "input" || !token || owners.get(route.value.leaseId) !== token.id || !scopedPolicy(hostPolicy, token).allow.input) {
      await audit({ ...(token ? { client: token.id } : {}), method: "WS", path: (req.url ?? "").split("?")[0]!, decision: "deny", reason: "input not allowed" }, env).catch(() => undefined);
      socket.destroy();
      return;
    }
    await audit({ client: token.id, method: "WS", path: (req.url ?? "").split("?")[0]!, decision: "allow", leaseId: route.value.leaseId, command: "input" }, env).catch(() => undefined);
    wss.handleUpgrade(req, socket, head, (client) => {
      holdOpen((release) => client.once("close", release));
      const up = new WebSocket(`${upstream.baseUrl.replace(/^http/, "ws")}${req.url}`, { headers: upstreamHeaders });
      const pending: Buffer[] = [];
      up.on("open", () => pending.splice(0).forEach((m) => up.send(m)));
      up.on("message", (d, binary) => client.readyState === WebSocket.OPEN && client.send(d, { binary }));
      up.on("close", (code, reason) => client.close(code >= 4000 || code === 1000 ? code : 1011, reason.toString().slice(0, 120)));
      up.on("error", () => client.close(1011, "input unavailable"));
      client.on("message", (d: Buffer) => (up.readyState === WebSocket.OPEN ? up.send(d) : pending.push(d)));
      client.on("close", () => up.close());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(policy.listen.port, policy.listen.host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : policy.listen.port;
  return {
    server,
    url: `http://${policy.listen.host}:${port}`,
    close: () => new Promise<void>((resolve) => {
      if (stopTimer) clearInterval(stopTimer);
      wss.close();
      server.close(() => resolve());
    }),
  };
}
