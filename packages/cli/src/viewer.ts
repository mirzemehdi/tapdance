import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Command } from "commander";
import { WebSocket, WebSocketServer } from "ws";
import { TapdanceError, isPrivateHost, type Tapdance } from "@tapdance/sdk";
import { run, type GlobalOptions } from "./context.js";
import { VIEWER_PAGE } from "./viewer-page.js";
import { bold, dim } from "./output.js";

/**
 * `tapdance view`: a loopback web page that shows the session's device live and lets a person
 * drive it. The browser never sees the Simlock token: this process proxies Simlock's lease stream
 * (`GET /v1/leases/{id}/stream`) and input socket (`WS /v1/leases/{id}/input`) and adds the header.
 *
 * Human/agent hand-off follows Loupe's model (bmcreations/loupe, Apache-2.0): a touch takes control,
 * agent actions are refused with HUMAN_HELD while it lasts, and "Hand back" returns it.
 */
export function registerViewerCommand(program: Command, globals: () => GlobalOptions): void {
  program
    .command("view")
    .description("Open a live view of this session's device in your browser (watch the agent, take over, hand back)")
    .option("--host <host>", "address to listen on (loopback by default; use SSH -L or Tailscale to reach it)")
    .option("--port <port>", "port to listen on")
    .action(async (o: { host?: string; port?: string }) =>
      run(globals(), async (t, out) => {
        const cfg = t.resolved.config.viewer;
        const host = o.host ?? cfg.host;
        const port = o.port === undefined ? cfg.port : Number(o.port);
        if (!isPrivateHost(host) && host !== "0.0.0.0") {
          throw new TapdanceError("USAGE", `Refusing to serve the viewer on public address ${host}`, { hint: "Keep it on 127.0.0.1 and use `ssh -L` or a private network." });
        }
        if (host === "0.0.0.0") out.warn("Listening on all interfaces: anyone who can reach this port and has the link can control the device.");
        await t.viewer(); // fails early, with a clear error, when no device is leased
        const { url, close } = await startViewer(t, { host, port, holdMs: cfg.humanHoldMs, log: (m) => out.progress(m) });
        out.result({ url }, () =>
          [
            bold(`Viewer: ${url}`),
            dim("The link carries a one-time key; it stops working when this process exits or the lease ends."),
            dim(`From another computer: ssh -L ${port}:127.0.0.1:${port} <this-host>, then open the link there.`),
            dim("Ctrl-C to stop."),
          ].join("\n"),
        );
        await new Promise<void>((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
        await close();
      }),
    );
}

export async function startViewer(
  t: Tapdance,
  options: { host: string; port: number; holdMs: number; log: (m: string) => void },
): Promise<{ url: string; close: () => Promise<void> }> {
  const key = randomBytes(18).toString("base64url");
  const cookieName = "td_view";
  const authorized = (req: IncomingMessage): boolean => {
    const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${cookieName}=`));
    const given = Buffer.from(cookie?.slice(cookieName.length + 1) ?? "");
    const expected = Buffer.from(key);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  // DNS rebinding guard: only loopback names, or the address we were told to bind, may appear in Host.
  const hostOk = (req: IncomingMessage): boolean => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    return ["127.0.0.1", "localhost", "::1", options.host].includes(host);
  };
  const originOk = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };
  let takeover = false;
  const hold = (ms: number) => t.setHumanHold(ms, "browser viewer").catch(() => undefined);

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://viewer");
    try {
      if (!hostOk(req)) return send(res, 403, { error: "unexpected Host header" });
      if (req.method === "POST" && !originOk(req)) return send(res, 403, { error: "cross-origin" });
      // The page carries no secret; the one-time key travels in the URL fragment, which browsers never
      // send, and is exchanged here for an HttpOnly cookie.
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'" }).end(VIEWER_PAGE);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/login") {
        const body = await new Promise<string>((resolve) => {
          let data = "";
          req.on("data", (c: Buffer) => (data += c.toString().slice(0, 256)));
          req.on("end", () => resolve(data));
        });
        const given = Buffer.from((JSON.parse(body || "{}") as { k?: string }).k ?? "");
        const expected = Buffer.from(key);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return send(res, 401, { error: "bad key" });
        res.writeHead(204, { "Set-Cookie": `${cookieName}=${key}; HttpOnly; SameSite=Strict; Path=/` }).end();
        return;
      }
      if (!authorized(req)) return send(res, 401, { error: "Open the link `tapdance view` printed." });
      if (url.pathname === "/api/status") {
        const record = await t.current();
        if (!record) return send(res, 410, { error: "No device is leased in this session any more." });
        const status = await t.status().catch((e: TapdanceError) => ({ error: e.message }));
        return send(res, 200, { device: status, takeover, recording: record.recording ?? null, artifacts: (await t.listArtifacts()).slice(-10) });
      }
      if (url.pathname === "/stream") {
        const { endpoints } = await t.viewer();
        const upstream = await fetch(endpoints.streamUrl, { headers: endpoints.headers });
        if (!upstream.ok || !upstream.body) {
          let message = `stream unavailable (${upstream.status})`;
          if (upstream.status === 404) message = "Live streaming is off on this worker. Run `tapdance worker install` there (or `simlock config set capabilities.stream.enabled true` and restart), and on the gateway too.";
          else message = await upstream.text().catch(() => message);
          return send(res, upstream.status === 404 ? 503 : upstream.status, { error: message });
        }
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        const body = Readable.fromWeb(upstream.body as never);
        req.on("close", () => body.destroy());
        body.pipe(res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/takeover") {
        takeover = true;
        await hold(10 * 60_000);
        return send(res, 200, { takeover });
      }
      if (req.method === "POST" && url.pathname === "/api/handback") {
        takeover = false;
        await hold(0);
        return send(res, 200, { takeover });
      }
      if (req.method === "POST" && url.pathname === "/api/screenshot") {
        const ref = await t.screenshot(undefined, "from the browser viewer");
        return send(res, 200, { artifact: ref });
      }
      if (req.method === "POST" && url.pathname === "/api/record/start") return send(res, 200, await t.startRecording());
      if (req.method === "POST" && url.pathname === "/api/record/stop") return send(res, 200, { artifact: await t.stopRecording() });
      if (url.pathname === "/api/artifact") {
        const id = url.searchParams.get("id");
        const ref = (await t.listArtifacts()).find((a) => a.id === id);
        if (!ref) return send(res, 404, { error: "unknown artifact" });
        const type = ref.kind === "screenshot" ? "image/png" : ref.kind === "recording" ? "video/mp4" : "text/plain; charset=utf-8";
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
        createReadStream(ref.path).pipe(res);
        return;
      }
      send(res, 404, { error: "not found" });
    } catch (error) {
      const e = error instanceof TapdanceError ? error : new TapdanceError("INTERNAL", (error as Error).message);
      if (!res.headersSent) send(res, 500, { error: e.message, hint: e.hint });
      else res.end();
    }
  });

  // Input: browser ⇄ this process ⇄ Simlock. Every touch from the browser extends the human hold.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", async (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://viewer").pathname !== "/input" || !hostOk(req) || !originOk(req) || !authorized(req)) {
      socket.destroy();
      return;
    }
    let endpoints;
    try {
      ({ endpoints } = await t.viewer());
    } catch {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(endpoints.inputUrl, { headers: endpoints.headers });
      const pending: Buffer[] = [];
      upstream.on("open", () => {
        for (const m of pending.splice(0)) upstream.send(m);
      });
      upstream.on("message", (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }));
      upstream.on("close", (code, reason) => client.close(code >= 4000 || code === 1000 ? code : 1011, reason.toString().slice(0, 120)));
      upstream.on("error", (err) => {
        options.log(`input upstream: ${err.message}`);
        client.close(1011, "Input is unavailable on this worker (turn on capabilities.input.enabled)");
      });
      let lastHold = 0;
      client.on("message", (data: Buffer) => {
        if (data[0] === 0x03 || data[0] === 0x04 || data[0] === 0x06 || data[0] === 0x0b) {
          const now = Date.now();
          if (!takeover && now - lastHold > 1000) {
            lastHold = now;
            void hold(options.holdMs);
          }
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
        else if (upstream.readyState === WebSocket.CONNECTING) pending.push(data);
      });
      client.on("close", () => upstream.close());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const shownHost = options.host === "0.0.0.0" ? "127.0.0.1" : options.host;
  return {
    url: `http://${shownHost}:${port}/#k=${key}`,
    close: async () => {
      await hold(0);
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
