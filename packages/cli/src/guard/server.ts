import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { SimlockConnection } from "@tapdance/sdk";
import { GuardTokens, audit, type GuardPolicy, type GuardToken } from "./policy.js";
import { execOf, routeOf, rpcOf } from "./rules.js";

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
  upstream: SimlockConnection;
  policy: GuardPolicy;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

export async function startGuard(options: GuardOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const { upstream, policy } = options;
  const env = options.env ?? process.env;
  const doFetch = options.fetchImpl ?? fetch;
  const tokens = new GuardTokens(env);
  /** leaseId → guard token id. Memory only: after a guard restart, old leases are nobody's and expire. */
  const owners = new Map<string, string>();
  /** Lease ids whose allocate is still running: reserved in `owners`, not yet known to Simlock. */
  const allocating = new Set<string>();
  /** Leases of physical phones (allocated with `physical`): no device shell on these. */
  const physicalLeases = new Set<string>();
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

  const send = (res: ServerResponse, status: number, code: string, message: string) => {
    if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: { code, message } }));
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
      if (["content-type", "content-length", "accept", "if-none-match"].includes(h) || h.startsWith("x-agent-device-")) headers[h] = v;
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
        if (ended && !allocating.has(leaseId)) owners.delete(leaseId);
      }),
    );
    return owners.size;
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
      if (!token) {
        await decide("deny", { reason: "unauthenticated" });
        return send(res, 401, "UNAUTHENTICATED", "Missing, expired or revoked worker-guard token");
      }
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
          if (r.action === "delete" && answer.ok) owners.delete(r.leaseId);
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
          const decision = rpcOf(parsed, policy);
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
            // Count and reserve with no await in between, so parallel allocates cannot all pass the cap.
            if (owners.size >= policy.limits.maxSessions) await activeLeases();
            if (owners.size >= policy.limits.maxSessions || owners.has(leaseId)) {
              await decide("deny", { reason: "session limit", leaseId });
              return send(res, 429, "NO_CAPACITY", `This worker allows ${policy.limits.maxSessions} session(s) at a time`);
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
          if (call.method === "lease.release") owners.delete(call.leaseId!);
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
    if (!route.ok || route.value.kind !== "lease" || route.value.action !== "input" || !token || owners.get(route.value.leaseId) !== token.id || !policy.allow.input) {
      await audit({ ...(token ? { client: token.id } : {}), method: "WS", path: (req.url ?? "").split("?")[0]!, decision: "deny", reason: "input not allowed" }, env).catch(() => undefined);
      socket.destroy();
      return;
    }
    await audit({ client: token.id, method: "WS", path: (req.url ?? "").split("?")[0]!, decision: "allow", leaseId: route.value.leaseId, command: "input" }, env).catch(() => undefined);
    wss.handleUpgrade(req, socket, head, (client) => {
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
      wss.close();
      server.close(() => resolve());
    }),
  };
}
