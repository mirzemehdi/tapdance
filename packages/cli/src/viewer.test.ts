import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tapdance } from "@tapdance/sdk";
import { FakeProvider } from "../../sdk/src/testing.js";
import { Script } from "node:vm";
import { parseTailnetNames, startViewer, waitForStop } from "./viewer.js";
import { VIEWER_PAGE } from "./viewer-page.js";

/** MOCKED provider (FakeProvider): proves the viewer's own HTTP rules, not a real device stream. */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function viewer(allowedHosts: string[] = []) {
  const home = await mkdtemp(join(tmpdir(), "td-view-"));
  const cwd = await mkdtemp(join(tmpdir(), "td-view-proj-"));
  const t = await Tapdance.create({ cwd, env: { TAPDANCE_HOME: home }, session: { id: "v1", source: "test" }, provider: new FakeProvider() });
  await t.lease({ platform: "android" });
  const v = await startViewer(t, { host: "127.0.0.1", port: 0, holdMs: 5000, allowedHosts, log: () => undefined });
  closers.push(v.close);
  const base = new URL(v.url);
  const key = /k=([A-Za-z0-9_-]+)/.exec(v.url)![1]!;
  // Node's fetch cannot set Host; send raw requests with the Host header a browser would send.
  const get = async (path: string, host: string, cookie?: string) => {
    const { request } = await import("node:http");
    return new Promise<{ status: number; type: string; body: Buffer }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: base.port, path, headers: { host, ...(cookie ? { cookie } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
  };
  return { key, get, port: base.port };
}

describe("tapdance view (MOCKED device)", () => {
  it("ships a page script that compiles (#29: a duplicate declaration killed the whole page)", () => {
    const scripts = [...VIEWER_PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    // Parsing is enough to catch early errors such as redeclared identifiers or syntax mistakes.
    for (const code of scripts) expect(() => new Script(code)).not.toThrow();
  });

  it("accepts this machine's tailnet names and refuses other Host headers (#24)", async () => {
    const v = await viewer(["my-vps.tail1234.ts.net", "my-vps", "100.74.77.19"]);
    expect((await v.get("/", `my-vps.tail1234.ts.net:${v.port}`)).status).toBe(200);
    expect((await v.get("/", `100.74.77.19:${v.port}`)).status).toBe(200);
    expect((await v.get("/", `127.0.0.1:${v.port}`)).status).toBe(200);
    expect((await v.get("/", `evil.example.com:${v.port}`)).status).toBe(403);
  });

  it("accepts allowed names on any port, e.g. behind tailscale serve on 8443 (#40)", async () => {
    const v = await viewer(["mac.tail1234.ts.net", "other.tail1234.ts.net:8443"]);
    expect((await v.get("/", "mac.tail1234.ts.net:8443")).status).toBe(200);
    expect((await v.get("/", "other.tail1234.ts.net")).status).toBe(200);
    const refused = await v.get("/", "evil.example.com:8443");
    expect(refused.status).toBe(403);
    expect(refused.body.toString()).toContain("evil.example.com");
  });

  it("serves screenshot frames for pages that cannot decode video, only with the key", async () => {
    const v = await viewer();
    expect((await v.get("/api/frame", `127.0.0.1:${v.port}`)).status).toBe(401);
    const ok = await v.get("/api/frame", `127.0.0.1:${v.port}`, `td_view=${v.key}`);
    expect(ok.status).toBe(200);
    expect(ok.type).toBe("image/png");
    expect(ok.body.subarray(1, 4).toString()).toBe("PNG");
  });

  // Review: server.close() waited for the open /stream response, so Ctrl-C hung while a page was open.
  it("closes within a second while a page holds the live stream open (MOCKED stream that never ends)", async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write(Buffer.from([0, 1, 2, 3]));
      // never ends
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    try {
      const home = await mkdtemp(join(tmpdir(), "td-view-"));
      const cwd = await mkdtemp(join(tmpdir(), "td-view-proj-"));
      const t = await Tapdance.create({ cwd, env: { TAPDANCE_HOME: home }, session: { id: "v2", source: "test" }, provider: new FakeProvider() });
      await t.lease({ platform: "android" });
      const record = (await t.current())!;
      vi.spyOn(t, "viewer").mockResolvedValue({ endpoints: { streamUrl: `http://127.0.0.1:${upstreamPort}/stream`, inputUrl: `ws://127.0.0.1:${upstreamPort}/input`, headers: {} }, record } as never);
      const v = await startViewer(t, { host: "127.0.0.1", port: 0, holdMs: 5000, log: () => undefined });
      const port = new URL(v.url).port;
      const key = /k=([A-Za-z0-9_-]+)/.exec(v.url)![1]!;
      const { request } = await import("node:http");
      const gotBytes = new Promise<void>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/stream", headers: { host: `127.0.0.1:${port}`, cookie: `td_view=${key}` } }, (res) => {
          expect(res.statusCode).toBe(200);
          res.once("data", () => resolve());
          res.on("error", () => undefined);
        });
        req.on("error", () => undefined);
        req.on("timeout", () => reject(new Error("no stream")));
        req.end();
      });
      await gotBytes;
      const started = Date.now();
      await Promise.race([v.close(), new Promise((_, reject) => setTimeout(() => reject(new Error("close() hung")), 1000))]);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  // Review: the viewer said it stops when the lease ends; now it checks.
  it("waitForStop ends once the session holds no lease (MOCKED device)", async () => {
    const home = await mkdtemp(join(tmpdir(), "td-view-"));
    const cwd = await mkdtemp(join(tmpdir(), "td-view-proj-"));
    const t = await Tapdance.create({ cwd, env: { TAPDANCE_HOME: home }, session: { id: "v3", source: "test" }, provider: new FakeProvider() });
    await t.lease({ platform: "android" });
    const listeners = process.listenerCount("SIGINT");
    const waiting = waitForStop(t, 20);
    await new Promise((r) => setTimeout(r, 60));
    await t.release();
    await expect(waiting).resolves.toBe("lease-ended");
    expect(process.listenerCount("SIGINT")).toBe(listeners);
  });

  it("reads this machine's MagicDNS name and addresses from tailscale status", () => {
    const raw = JSON.stringify({ Self: { DNSName: "my-vps.tail1234.ts.net.", TailscaleIPs: ["100.74.77.19", "fd7a:115c:a1e0::1"] } });
    expect(parseTailnetNames(raw)).toEqual({ dnsName: "my-vps.tail1234.ts.net", names: ["my-vps.tail1234.ts.net", "my-vps", "100.74.77.19", "fd7a:115c:a1e0::1"] });
    expect(parseTailnetNames("")).toEqual({ names: [] });
  });
});
