import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Tapdance, TapdanceError, processSessionIdentity, renewIfDue, type TapdanceOptions } from "@tapdance/sdk";
import { SERVER_INSTRUCTIONS, TOOLS, errorResult, type ToolExtra } from "./tools.js";

export const SERVER_NAME = "tapdance";

/**
 * Routes Tapdance's progress messages to the MCP call they come from. Create it before the Tapdance
 * (pass `emit` as its onProgress) and give it to createMcpServer, which runs each call inside `run`.
 * The sink is bound to the call's async context, so calls that overlap, or a call without a progress
 * token, never send their messages to another call's token.
 */
export interface ProgressRouter {
  run: <T>(sink: ((message: string) => void) | undefined, fn: () => Promise<T>) => Promise<T>;
  emit: (message: string) => void;
}

export function createProgressRouter(): ProgressRouter {
  const current = new AsyncLocalStorage<((message: string) => void) | undefined>();
  return { run: (sink, fn) => current.run(sink, fn), emit: (message) => current.getStore()?.(message) };
}

/** A sink that sends `notifications/progress` for one call, or undefined when the client asked for none. */
function progressSink(extra: ToolExtra | undefined): ((message: string) => void) | undefined {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || extra === undefined) return undefined;
  let progress = 0;
  return (message) => {
    progress += 1;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, message } }).catch(() => undefined);
  };
}

/** Builds an MCP server whose tools act for one Tapdance session. */
export function createMcpServer(tapdance: Tapdance, version = "0.1.0", progress?: ProgressRouter): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions: SERVER_INSTRUCTIONS });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations },
      (async (args: Record<string, unknown>, extra: ToolExtra) => {
        const call = async () => {
          try {
            return await tool.run(tapdance, args ?? {}, extra);
          } catch (error) {
            return errorResult(error);
          }
        };
        return progress ? progress.run(progressSink(extra), call) : call();
      }) as never,
    );
  }
  return server;
}

/** Keeps the session's lease alive while the server runs, sharing the renewal rules with the CLI keepalive. */
export function startRenewal(tapdance: Tapdance, log: (m: string) => void): () => void {
  let busy = false;
  const idleMs = tapdance.resolved.config.session.idleReleaseMinutes * 60_000;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const outcome = await renewIfDue(tapdance, { idleMs, log: (m) => log(`tapdance: ${m}`) });
      if (outcome === "lost") log("tapdance: the lease ended; the next device tool call will say so");
    } catch (error) {
      // An unhandled rejection would end the process (Node 22), and with it the agent's tools.
      log(`tapdance: renewal check failed: ${(error as Error).message}`);
    } finally {
      busy = false;
    }
  }, 15_000);
  timer.unref();
  return () => clearInterval(timer);
}

async function shutdown(tapdance: Tapdance, log: (m: string) => void): Promise<void> {
  // Release only a lease this server process created: a CLI lease in the same agent session stays.
  const result = await tapdance.release({ onlyOwnedBy: { kind: "mcp", pid: process.pid } }).catch((error: Error) => {
    log(`tapdance: release on shutdown failed: ${error.message}`);
    return { released: false };
  });
  if (result.released) log("tapdance: released the device this server leased");
  await tapdance.close();
}

/** stdio transport: one server process per agent session, the lease released when the client goes. */
export async function runStdio(options: TapdanceOptions = {}): Promise<void> {
  const log = (m: string) => process.stderr.write(`${m}\n`);
  const progress = createProgressRouter();
  const tapdance = await Tapdance.create({
    ...options,
    owner: "mcp",
    session: options.session ?? processSessionIdentity(options.env ?? process.env),
    onProgress: (m) => {
      options.onProgress?.(m);
      progress.emit(m);
    },
  });
  const server = createMcpServer(tapdance, undefined, progress);
  const stopRenewal = startRenewal(tapdance, log);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    stopRenewal();
    await shutdown(tapdance, log);
    process.exit(0);
  };
  process.stdin.on("end", close);
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  await server.connect(new StdioServerTransport());
  log(`tapdance MCP server ready (session ${tapdance.sessionId})`);
}

export interface HttpServerOptions extends TapdanceOptions {
  host: string;
  port: number;
  /** Bearer token clients must send. Generated when omitted and printed once. */
  authToken?: string;
}

function bearerOk(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error("request body over 4 MiB");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/**
 * Streamable HTTP transport for remote agents. Each MCP session is its own Tapdance session with
 * its own lease. Loopback by default and always behind a bearer token.
 */
export async function runHttp(options: HttpServerOptions): Promise<{ server: Server; url: string; token: string }> {
  const log = (m: string) => process.stderr.write(`${m}\n`);
  const token = options.authToken ?? randomBytes(24).toString("base64url");
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; tapdance: Tapdance; stop: () => void }>();

  const http = createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404).end();
        return;
      }
      if (!bearerOk(req, token)) {
        res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (req.method === "POST") {
        const body = await readBody(req);
        if (existing) {
          await existing.transport.handleRequest(req, res, body);
          return;
        }
        if (!isInitializeRequest(body)) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no session; send initialize first" }));
          return;
        }
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomBytes(16).toString("hex"),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, tapdance, stop });
          },
        });
        const mcpId = randomBytes(8).toString("hex");
        const progress = createProgressRouter();
        const tapdance = await Tapdance.create({
          ...options,
          owner: "mcp",
          session: { id: `mcp-http:${mcpId}`, source: "mcp http session" },
          onProgress: (m) => {
            options.onProgress?.(m);
            progress.emit(m);
          },
        });
        const stop = startRenewal(tapdance, log);
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id && sessions.has(id)) {
            sessions.delete(id);
            stop();
            void shutdown(tapdance, log);
          }
        };
        await createMcpServer(tapdance, undefined, progress).connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if ((req.method === "GET" || req.method === "DELETE") && existing) {
        await existing.transport.handleRequest(req, res);
        return;
      }
      res.writeHead(400).end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new TapdanceError("USAGE", `Port ${options.port} on ${options.host} is already in use`, { hint: "Stop whatever listens there, or pick another port with `tapdance mcp --http --port <port>`." }));
      } else if (error.code === "EADDRNOTAVAIL" || error.code === "EACCES") {
        reject(new TapdanceError("USAGE", `Cannot listen on ${options.host}:${options.port} (${error.code})`, { hint: "Use an address this machine has (127.0.0.1 by default) and a port above 1023." }));
      } else reject(error);
    });
    http.listen(options.port, options.host, resolve);
  });
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const url = `http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${port}/mcp`;
  const close = async () => {
    for (const s of sessions.values()) {
      s.stop();
      await shutdown(s.tapdance, log);
    }
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  return { server: http, url, token };
}
