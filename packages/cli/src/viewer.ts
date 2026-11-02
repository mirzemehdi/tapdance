import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Command } from "commander";
import { WebSocket, WebSocketServer } from "ws";
import { TapdanceError, isPrivateHost, type Tapdance } from "@tapdance/sdk";
import { run, type GlobalOptions } from "./context.js";
import { VIEWER_PAGE } from "./viewer-page.js";
import { bold, dim } from "./output.js";
import { TAILSCALE_DNS_ADMIN, parseTailscaleStatus, tailscaleServeArgs, tailscaleServeOffArgs } from "./host/plan.js";

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
    .option("--allow-host <name>", "another name the page may be opened by (repeatable); this machine's Tailscale names are allowed already", (v: string, prev: string[] = []) => [...prev, v])
    .option("--tailscale", "serve the page over https on this machine's tailnet name (tailscale serve), for live video; needs HTTPS Certificates on the tailnet")
    .action(async (o: { host?: string; port?: string; allowHost?: string[]; tailscale?: boolean }) =>
      run(globals(), async (t, out) => {
        const cfg = t.resolved.config.viewer;
        if (o.tailscale && o.host) throw new TapdanceError("USAGE", "--tailscale listens on loopback behind tailscale serve; leave out --host");
        if (o.tailscale && !(Number(o.port ?? cfg.port) > 0)) throw new TapdanceError("USAGE", "--tailscale needs a fixed --port (tailscale serve exposes that port)");
        const host = o.tailscale ? "127.0.0.1" : (o.host ?? cfg.host);
        const port = o.port === undefined ? cfg.port : Number(o.port);
        if (!isPrivateHost(host) && host !== "0.0.0.0") {
          throw new TapdanceError("USAGE", `Refusing to serve the viewer on public address ${host}`, { hint: "Keep it on 127.0.0.1 and use `ssh -L` or a private network." });
        }
        if (host === "0.0.0.0") out.warn("Listening on all interfaces: anyone who can reach this port and has the link can control the device.");
        await t.viewer(); // fails early, with a clear error, when no device is leased
        const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
        // Names this machine answers to on its tailnet (MagicDNS, its 100.x addresses), so the link can
        // use the name and a browser opening it by name is not refused as DNS rebinding.
        const tailnet = loopback && !o.tailscale ? { names: [] as string[] } : await tailnetNames();
        const served = o.tailscale ? await serveOverTailscale(port, out) : undefined;
        const allowedHosts = [...tailnet.names, ...(served ? [served.dnsName] : []), ...(o.allowHost ?? [])];
        const { url, close: closeViewer } = await startViewer(t, { host, port, holdMs: cfg.humanHoldMs, allowedHosts, log: (m) => out.progress(m) }).catch(async (error: unknown) => {
          await served?.stop();
          throw error;
        });
        const close = async () => {
          await closeViewer();
          await served?.stop();
        };
        const shown = served
          ? url.replace(`http://${host}:${port}`, `https://${served.dnsName}:${port}`)
          : tailnet.dnsName && (host === "0.0.0.0" || tailnet.names.includes(host))
            ? url.replace(`//${host}:`, `//${tailnet.dnsName}:`)
            : url;
        if (served) await warm(shown.split("#")[0]!, out);
        // The link's `#k=` key is the one secret this command exists to hand the person: not redacted.
        out.secretResult({ url: shown }, () =>
          [
            bold(`Viewer: ${shown}`),
            dim("Anyone with this link can watch and control the device while this viewer runs (Ctrl-C stops it; so does the lease ending)."),
            served
              ? dim("Open it from any device on your tailnet (live video over https). Ctrl-C also removes the tailscale serve entry.")
              : loopback
                ? dim(`From another computer: ssh -L ${port}:127.0.0.1:${port} <this-host>, then open the link there (live video).`)
                : dim("Open it from a device on the same network. Over plain http on a non-localhost address, browsers do not allow the video decoder, so the page shows refreshed screenshots; for live video run `tapdance view --tailscale` (needs HTTPS Certificates on the tailnet) or use ssh -L to localhost."),
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

/**
 * Puts the viewer behind `tailscale serve --https=<port>` on this machine's tailnet name, so browsers
 * get a secure context (live video). Fails with the one-time fix when the tailnet has no HTTPS
 * certificates or this user may not change serve settings.
 */
async function serveOverTailscale(port: number, out: { progress: (m: string) => void }): Promise<{ dnsName: string; stop: () => Promise<void> }> {
  const tailscale = (args: string[], timeout = 30_000) =>
    new Promise<{ ok: boolean; text: string }>((resolve) => {
      execFile("tailscale", args, { timeout }, (error, stdout, stderr) => resolve({ ok: !error, text: `${stdout}${stderr}`.trim() || (error?.message ?? "") }));
    });
  const status = await tailscale(["status", "--json"], 5000);
  if (!status.ok) throw new TapdanceError("USAGE", "--tailscale needs the tailscale CLI on this machine", { hint: "Install Tailscale and run `tailscale up`, or use --host <this machine's 100.x address> (screenshot mode)." });
  const state = parseTailscaleStatus(status.text);
  if (!state.loggedIn || !state.dnsName) throw new TapdanceError("USAGE", `Tailscale is ${state.loggedIn ? "connected without a MagicDNS name" : `not connected (${state.backendState})`}`, { hint: `Run \`tailscale up\` and turn on MagicDNS (${TAILSCALE_DNS_ADMIN}).` });
  if (!state.https) {
    throw new TapdanceError("USAGE", "This tailnet has no HTTPS certificates, so tailscale serve cannot give the viewer an https address", {
      hint: `Turn on HTTPS Certificates (${TAILSCALE_DNS_ADMIN}), then run this again. Until then: tapdance view --host <this machine's 100.x address> (screenshot mode).`,
    });
  }
  const serve = await tailscale(tailscaleServeArgs(port, "https"));
  if (!serve.ok) {
    const denied = /access denied|permission|operator|must be root/i.test(serve.text);
    throw new TapdanceError("PROVIDER_UNAVAILABLE", `tailscale serve failed: ${serve.text.split("\n").slice(-2).join(" ")}`, {
      hint: denied ? "Allow your user to change serve settings once: sudo tailscale set --operator=$USER" : "Check `tailscale serve status`.",
    });
  }
  out.progress(`Serving the viewer at https://${state.dnsName}:${port} (tailscale serve)`);
  return { dnsName: state.dnsName, stop: async () => void (await tailscale(tailscaleServeOffArgs(port, "https"))) };
}

/** Requests the page once so the first open does not wait for the certificate to be issued. */
async function warm(origin: string, out: { progress: (m: string) => void }): Promise<void> {
  out.progress("Getting the tailnet certificate (the first time can take a few seconds)");
  await fetch(`${origin.replace(/\/+$/, "")}/favicon.ico`, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
}

export async function startViewer(
  t: Tapdance,
  options: { host: string; port: number; holdMs: number; allowedHosts?: string[]; log: (m: string) => void },
): Promise<{ url: string; close: () => Promise<void> }> {
  const key = randomBytes(18).toString("base64url");
  const cookieName = "td_view";
  const authorized = (req: IncomingMessage): boolean => {
    const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${cookieName}=`));
    const given = Buffer.from(cookie?.slice(cookieName.length + 1) ?? "");
    const expected = Buffer.from(key);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  // DNS rebinding guard: only loopback names, the address we were told to bind, and names this
  // machine has on its tailnet (or `--allow-host`) may appear in Host.
  const allowed = new Set(["127.0.0.1", "localhost", "::1", options.host, ...(options.allowedHosts ?? [])].map((h) => h.toLowerCase()));
  const hostOk = (req: IncomingMessage): boolean => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    return allowed.has(host);
  };
  // Fallback frames (pages that cannot decode video): one screenshot at a time, reused for 400 ms.
  let lastFrame: { at: number; png: Buffer } | undefined;
  let pendingFrame: Promise<Buffer> | undefined;
  const frame = async (): Promise<Buffer> => {
    if (lastFrame && Date.now() - lastFrame.at < 400) return lastFrame.png;
    pendingFrame ??= t.frame().then((png) => {
      lastFrame = { at: Date.now(), png };
      return png;
    }).finally(() => (pendingFrame = undefined));
    return pendingFrame;
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
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
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
        return send(res, 200, { device: status, takeover, recording: record.recording ?? null, artifacts: (await t.listArtifacts()).slice(-10), humanRequest: (await t.pendingHumanRequest()) ?? null });
      }
      if (url.pathname === "/api/frame") {
        const png = await frame();
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }).end(png);
        return;
      }
      if (url.pathname === "/stream") {
        const { endpoints } = await t.viewer();
        const upstream = await fetch(endpoints.streamUrl, { headers: endpoints.headers });
        if (!upstream.ok || !upstream.body) {
          let message = `stream unavailable (${upstream.status})`;
          if (upstream.status === 404) message = "Live streaming is off on this worker. Run `tapdance worker install` there (or `tapdance simlock -- config set capabilities.stream.enabled true` and `tapdance worker restart`), and on the gateway too.";
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
        // Handing back also answers the agent's open request for a person, if there is one.
        const answered = await t.completeHumanRequest("viewer hand back");
        return send(res, 200, { takeover, answered });
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

/** This machine's tailnet names and addresses from `tailscale status --json`; empty without Tailscale. */
export async function tailnetNames(): Promise<{ names: string[]; dnsName?: string }> {
  const raw = await new Promise<string>((resolve) => {
    execFile("tailscale", ["status", "--json"], { timeout: 5000 }, (error, stdout) => resolve(error ? "" : stdout));
  });
  return parseTailnetNames(raw);
}

export function parseTailnetNames(raw: string): { names: string[]; dnsName?: string } {
  try {
    const self = (JSON.parse(raw) as { Self?: { DNSName?: unknown; HostName?: unknown; TailscaleIPs?: unknown } }).Self ?? {};
    const dnsName = typeof self.DNSName === "string" && self.DNSName ? self.DNSName.replace(/\.$/, "") : undefined;
    const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((x): x is string => typeof x === "string") : [];
    // The short MagicDNS name (before the first dot) resolves inside the tailnet too.
    const names = [...(dnsName ? [dnsName, dnsName.split(".")[0]!] : []), ...ips];
    return { names, ...(dnsName ? { dnsName } : {}) };
  } catch {
    return { names: [] };
  }
}
