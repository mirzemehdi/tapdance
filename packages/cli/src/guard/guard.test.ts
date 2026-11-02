import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LeaseHandle } from "@tapdance/core";
import { SimlockProvider } from "@tapdance/provider-simlock";
import { GuardPolicySchema, GuardTokens, type GuardPolicy } from "./policy.js";
import { execOf } from "./rules.js";
import { startGuard } from "./server.js";

/**
 * Security tests for the worker guard, written as a deliberately malicious remote client against
 * the guard's HTTP API. The Simlock side is a recording fake: these tests prove what the guard lets
 * through and what never reaches Simlock. They say nothing about OS, Simulator or virtualization
 * vulnerabilities on the worker.
 */

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

interface Upstream {
  server: Server;
  url: string;
  seen: Array<{ method: string; path: string; body: string; headers: Record<string, string | string[] | undefined> }>;
}

interface FakeOptions {
  /** Delay before answering GET /v1/leases/<id>, in ms. */
  leaseDelayMs?: number;
  /** Replaces the GET /v1/status body. */
  status?: unknown;
  /** Answers lease.allocate with HTTP 200 and this JSON-RPC error instead of granting. */
  allocateError?: { code: number; message: string };
  /** Platform in GET /v1/leases/<id> (default "ios"). */
  leasePlatform?: string;
  /** What `simctl get_app_container … data` prints (an app's data container on the "Mac"). */
  container?: string;
}

async function fakeSimlock(options: FakeOptions = {}): Promise<Upstream> {
  const seen: Upstream["seen"] = [];
  const live = new Set<string>();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({ method: req.method ?? "", path: req.url ?? "", body, headers: req.headers });
    const lease = /^\/v1\/leases\/([0-9a-f]{32})/.exec(req.url ?? "");
    if (req.url === "/v1/agent-device/rpc") {
      const call = JSON.parse(body) as { method: string; params: { leaseId: string } };
      if (call.method.endsWith("lease.allocate") && options.allocateError) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: options.allocateError }));
        return;
      }
      if (call.method.endsWith("lease.allocate")) live.add(call.params.leaseId);
      if (call.method.endsWith("lease.release")) live.delete(call.params.leaseId);
      // A screenshot answers with a downloadable artifact named after the lease, as agent-device does.
      const artifact = (call.params as { command?: string }).command === "screenshot" ? { artifacts: [{ artifactId: `art-${call.params.leaseId.slice(0, 4)}` }] } : {};
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", result: { ok: true, echo: call, ...artifact } }));
      return;
    }
    if (lease && req.method === "GET" && !req.url!.includes("/stream")) {
      if (options.leaseDelayMs) await new Promise((r) => setTimeout(r, options.leaseDelayMs));
      res.writeHead(live.has(lease[1]!) ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify({ lease: { id: lease[1], platform: options.leasePlatform ?? "ios" } }));
      return;
    }
    if (req.url === "/v1/status" && options.status !== undefined) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(options.status));
      return;
    }
    if (lease && req.url!.endsWith("/exec")) {
      const args = (JSON.parse(body || "{}") as { args?: string[] }).args ?? [];
      const out = args[0] === "get_app_container" && options.container ? `event: output\ndata: ${JSON.stringify({ stream: "stdout", chunk: `${options.container}\n` })}\n\n` : "";
      res.writeHead(200, { "content-type": "text/event-stream" }).end(`${out}event: exit\ndata: {"exitCode":0}\n\n`);
      return;
    }
    if (req.url?.startsWith("/v1/agent-device/upload")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ uploaded: body.length, uploadId: `up-${req.headers["x-agent-device-lease-id"] ?? "none"}`.slice(0, 7) }));
      return;
    }
    if (req.url?.startsWith("/v1/agent-device/artifacts/")) {
      res.writeHead(200, { "content-type": "image/png" }).end("PNGDATA");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ leases: [{ id: A }, { id: B }], devices: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${address.port}`, seen };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(overrides: Partial<GuardPolicy> = {}, fake: FakeOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "td-guard-"));
  const env = { TAPDANCE_HOME: home };
  const upstream = await fakeSimlock(fake);
  const policy = GuardPolicySchema.parse({ listen: { host: "127.0.0.1", port: 0 }, ...overrides });
  const guard = await startGuard({
    upstream: { kind: "local", baseUrl: upstream.url, token: "slk_LOCALONLYSECRET", tenant: "local", runId: "r", clientId: "c", source: "test" },
    policy,
    env,
  });
  cleanups.push(guard.close, () => new Promise((r) => upstream.server.close(() => r())));
  const tokens = new GuardTokens(env);
  const alice = await tokens.issue("alice-vps", 7);
  const mallory = await tokens.issue("mallory-vps", 7);
  const call = (secret: string | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${guard.url}${path}`, {
      method,
      headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
  const rpc = (secret: string, method: string, params: Record<string, unknown>) => call(secret, "POST", "/v1/agent-device/rpc", { jsonrpc: "2.0", id: 1, method, params });
  const allocate = (secret: string, leaseId: string, extra: Record<string, unknown> = {}) => rpc(secret, "agent_device.lease.allocate", { leaseId, platform: "ios", ...extra });
  const exec = (secret: string, leaseId: string, tool: string, args: string[]) => call(secret, "POST", `/v1/leases/${leaseId}/exec`, { tool, args });
  const forwardedExecs = () => upstream.seen.filter((s) => s.path.endsWith("/exec"));
  return { env, home, upstream, tokens, alice, mallory, call, rpc, allocate, exec, forwardedExecs, policy };
}

describe("worker guard vs a malicious remote client", () => {
  it("1. cannot run arbitrary shell commands (simctl spawn, adb shell)", async () => {
    // `adb shell` runs inside the emulator's VM, not on the Mac; the owner can turn it off
    // (allow.deviceShell), and with it off every shell form below is refused before Simlock.
    const t = await setup({ allow: { ...GuardPolicySchema.parse({}).allow, deviceShell: false } });
    await t.allocate(t.alice.secret, A);
    for (const [tool, args] of [
      ["simctl", ["spawn", "booted", "/bin/sh", "-c", "id"]],
      ["simctl", ["spawn", "/bin/zsh"]],
      ["adb", ["shell", "sh", "-c", "id"]],
      ["adb", ["shell", "am", "force-stop", "com.x; rm -rf /"]],
      ["sh", ["-c", "id"]],
    ] as const) {
      expect((await t.exec(t.alice.secret, A, tool, [...args])).status).toBe(403);
    }
    expect(t.forwardedExecs()).toHaveLength(0);
  });

  it("2. cannot use sudo", async () => {
    // `adb shell` runs inside the emulator's VM, not on the Mac; the owner can turn it off
    // (allow.deviceShell), and with it off every shell form below is refused before Simlock.
    const t = await setup({ allow: { ...GuardPolicySchema.parse({}).allow, deviceShell: false } });
    await t.allocate(t.alice.secret, A);
    expect((await t.exec(t.alice.secret, A, "simctl", ["spawn", "booted", "sudo", "-n", "true"])).status).toBe(403);
    expect((await t.exec(t.alice.secret, A, "adb", ["shell", "su", "-c", "id"])).status).toBe(403);
    expect(t.forwardedExecs()).toHaveLength(0);
  });

  it("3. cannot read personal files (pull, cat, traversal, raw routes)", async () => {
    const t = await setup();
    await t.allocate(t.alice.secret, A);
    expect((await t.exec(t.alice.secret, A, "adb", ["pull", "/Users/owner/.ssh/id_ed25519", "/tmp/x"])).status).toBe(403);
    expect((await t.exec(t.alice.secret, A, "simctl", ["spawn", "booted", "cat", "/Users/owner/Documents/secret.txt"])).status).toBe(403);
    expect((await t.exec(t.alice.secret, A, "simctl", ["get_app_container", "booted", "com.x"])).status).toBe(403);
    expect((await t.call(t.alice.secret, "GET", "/v1/../../etc/passwd")).status).toBe(404);
    expect((await t.call(t.alice.secret, "GET", "/v1/agent-device/artifacts/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await t.rpc(t.alice.secret, "agent_device.command", { command: "pull", leaseId: A, positionals: ["/Users/owner/.zshrc"] })).status).toBe(403);
    expect(t.forwardedExecs()).toHaveLength(0);
  });

  it("4. cannot delete files outside the workspace", async () => {
    // `adb shell` runs inside the emulator's VM, not on the Mac; the owner can turn it off
    // (allow.deviceShell), and with it off every shell form below is refused before Simlock.
    const t = await setup({ allow: { ...GuardPolicySchema.parse({}).allow, deviceShell: false } });
    await t.allocate(t.alice.secret, A);
    expect((await t.exec(t.alice.secret, A, "simctl", ["spawn", "booted", "rm", "-rf", "/Users/owner"])).status).toBe(403);
    expect((await t.exec(t.alice.secret, A, "simctl", ["delete", "all"])).status).toBe(403);
    expect((await t.exec(t.alice.secret, A, "adb", ["shell", "rm", "-rf", "/sdcard"])).status).toBe(403);
    expect(t.forwardedExecs()).toHaveLength(0);
  });

  it("5. cannot reach the Keychain", async () => {
    const t = await setup();
    await t.allocate(t.alice.secret, A);
    expect((await t.exec(t.alice.secret, A, "simctl", ["spawn", "booted", "security", "find-generic-password", "-a", "owner"])).status).toBe(403);
    expect((await t.exec(t.alice.secret, A, "simctl", ["keychain", "booted", "add-root-cert", "/tmp/ca.pem"])).status).toBe(403);
    expect(t.forwardedExecs()).toHaveLength(0);
  });

  it("6. cannot change the local policy or mint credentials", async () => {
    const t = await setup();
    const before = await readFile(t.tokens.path, "utf8");
    for (const [m, p] of [["PUT", "/v1/policy"], ["POST", "/v1/tokens"], ["POST", "/v1/config"], ["POST", "/guard/policy"], ["POST", "/v1/workers/x/drain"], ["POST", "/v1/update"]] as const) {
      expect((await t.call(t.alice.secret, m, p, { profile: "anything", allow: { shell: true } })).status).toBe(404);
    }
    expect(await readFile(t.tokens.path, "utf8")).toBe(before);
    expect(t.upstream.seen.filter((s) => !s.path.startsWith("/v1/leases/"))).toHaveLength(0);
  });

  it("7. a lease only covers its own device; another client cannot use or release it", async () => {
    const t = await setup({ limits: { maxSessions: 2, maxLeaseMinutes: 60, maxUploadMB: 1, tokenDays: 7 } });
    expect((await t.allocate(t.alice.secret, A)).status).toBe(200);
    expect((await t.rpc(t.mallory.secret, "agent_device.command", { command: "press", leaseId: A })).status).toBe(403);
    expect((await t.rpc(t.mallory.secret, "agent_device.lease.release", { leaseId: A })).status).toBe(403);
    expect((await t.exec(t.mallory.secret, A, "simctl", ["terminate", "com.example.app"])).status).toBe(404);
    expect((await t.call(t.mallory.secret, "DELETE", `/v1/leases/${A}`)).status).toBe(404);
    expect((await t.allocate(t.mallory.secret, A)).status).toBe(409); // cannot take over a lease id
    expect((await t.rpc(t.alice.secret, "agent_device.command", { command: "press", leaseId: A })).status).toBe(200);
  });

  it("8. one session cannot see another session's leases, stream or logs", async () => {
    const t = await setup({ limits: { maxSessions: 2, maxLeaseMinutes: 60, maxUploadMB: 1, tokenDays: 7 } });
    await t.allocate(t.alice.secret, A);
    await t.allocate(t.mallory.secret, B);
    const status = (await (await t.call(t.mallory.secret, "GET", "/v1/status")).json()) as { leases: Array<{ id: string }> };
    expect(status.leases.map((l) => l.id)).toEqual([B]);
    expect((await t.call(t.mallory.secret, "GET", `/v1/leases/${A}/stream`)).status).toBe(404);
    expect((await t.call(t.mallory.secret, "GET", `/v1/leases/${A}`)).status).toBe(404);
    expect((await t.exec(t.mallory.secret, A, "adb", ["logcat", "-d", "-t", "10"])).status).toBe(404);
  });

  it("9. rejects missing, wrong and expired credentials", async () => {
    const t = await setup();
    expect((await t.call(undefined, "GET", "/v1/status")).status).toBe(401);
    expect((await t.call("tdg_guessing", "GET", "/v1/status")).status).toBe(401);
    expect((await t.call("slk_LOCALONLYSECRET", "GET", "/v1/status")).status).toBe(401); // the local Simlock token is not a guard token
    const file = JSON.parse(await readFile(t.tokens.path, "utf8")) as Array<{ id: string; expiresAt: string }>;
    file[0]!.expiresAt = new Date(Date.now() - 1000).toISOString();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(t.tokens.path, JSON.stringify(file), { mode: 0o600 });
    expect((await t.call(t.alice.secret, "GET", "/v1/status")).status).toBe(401);
  });

  it("10. revoking stops a client on its next request", async () => {
    const t = await setup();
    await t.allocate(t.alice.secret, A);
    expect((await t.rpc(t.alice.secret, "agent_device.command", { command: "snapshot", leaseId: A })).status).toBe(200);
    await t.tokens.revoke(t.alice.token.id);
    expect((await t.rpc(t.alice.secret, "agent_device.command", { command: "snapshot", leaseId: A })).status).toBe(401);
  });

  it("11. device-only mode refuses builds and code-running commands", async () => {
    const t = await setup();
    await t.allocate(t.alice.secret, A);
    for (const command of ["install-from-source", "replay", "test", "batch", "metro", "push", "perf", "trace", "debug", "settings", "doctor"]) {
      expect((await t.rpc(t.alice.secret, "agent_device.command", { command, leaseId: A })).status, command).toBe(403);
    }
    // Their device-only forms pass; host-touching forms do not.
    const rpc = (command: string, positionals: string[], extra: Record<string, unknown> = {}) => t.rpc(t.alice.secret, "agent_device.command", { command, leaseId: A, positionals, ...extra });
    expect((await rpc("perf", ["frames"])).status).toBe(200);
    expect((await rpc("perf", ["memory", "sample"])).status).toBe(200);
    expect((await rpc("perf", ["cpu", "profile", "start"], { flags: { leaseId: A, kind: "xctrace", out: "/Users/owner/x.trace" } })).status).toBe(403);
    expect((await rpc("settings", ["appearance", "dark"])).status).toBe(200);
    expect((await rpc("settings", ["permission", "grant", "screen-recording"])).status).toBe(403);
    expect((await rpc("settings", ["shell-hack", "on"])).status).toBe(403);
    // agent-device's audio probe captures the host's system audio with ScreenCaptureKit (macOS Screen
    // Recording permission): never reachable through the guard.
    expect((await rpc("audio", ["probe", "start", "5"])).status).toBe(403);
    expect((await rpc("push", ["com.example.app", "/Users/owner/.ssh/id_rsa"])).status).toBe(403);
    expect((await t.exec(t.alice.secret, A, "xcodebuild", ["-scheme", "Evil", "build"])).status).toBe(403);
    expect((await t.call(t.alice.secret, "POST", "/v1/lease-requests", { platform: "ios" })).status).toBe(404);
    expect(GuardPolicySchema.safeParse({ profile: "approved-build" }).success).toBe(false);
  });

  it("12. limits stop runaway sessions, oversized uploads and long leases", async () => {
    const t = await setup({ limits: { maxSessions: 1, maxLeaseMinutes: 30, maxUploadMB: 1, tokenDays: 7 } });
    expect((await t.allocate(t.alice.secret, A, { ttlMs: 24 * 3_600_000 })).status).toBe(200);
    const forwarded = JSON.parse(t.upstream.seen.find((s) => s.path === "/v1/agent-device/rpc")!.body) as { params: { ttlMs: number } };
    expect(forwarded.params.ttlMs).toBe(30 * 60_000);
    expect((await t.allocate(t.mallory.secret, C)).status).toBe(429);
    const big = "x".repeat(2 * 1024 * 1024);
    expect((await t.call(t.alice.secret, "POST", "/v1/agent-device/upload", big, { "content-type": "application/octet-stream" })).status).toBe(413);
  });

  it("allows the normal device flow and records it in the audit log", async () => {
    const t = await setup();
    expect((await t.allocate(t.alice.secret, A)).status).toBe(200);
    expect((await t.rpc(t.alice.secret, "agent_device.command", { command: "press", leaseId: A, selector: 'label="Sign in"' })).status).toBe(200);
    expect((await t.exec(t.alice.secret, A, "simctl", ["terminate", "com.example.app"])).status).toBe(200);
    expect((await t.exec(t.alice.secret, A, "simctl", ["spawn", "log", "show", "--last", "3m", "--style", "compact"])).status).toBe(200);
    expect((await t.exec(t.alice.secret, A, "adb", ["logcat", "-d", "-v", "threadtime", "-t", "200"])).status).toBe(200);
    const forwarded = t.upstream.seen.filter((s) => s.path.endsWith("/exec"));
    expect(forwarded).toHaveLength(3);
    for (const s of t.upstream.seen) expect(s.body).not.toContain("tdg_");
    const auditFile = join(t.home, "worker", "audit.log");
    const log = await readFile(auditFile, "utf8");
    expect(log).toContain('"decision":"allow"');
    expect(log).not.toContain(t.alice.secret);
    expect(log).not.toContain("slk_");
    expect((await stat(auditFile)).mode & 0o777).toBe(0o600);
  });

  it("disabling a capability in the local policy refuses it", async () => {
    const t = await setup({ allow: { install: false, interaction: true, inspection: true, screenshots: true, recording: false, logs: false, streaming: false, input: false, physicalDevices: false } });
    await t.allocate(t.alice.secret, A);
    expect((await t.rpc(t.alice.secret, "agent_device.command", { command: "install", leaseId: A })).status).toBe(403);
    expect((await t.rpc(t.alice.secret, "agent_device.command", { command: "record", leaseId: A, positionals: ["start"] })).status).toBe(403);
    expect((await t.exec(t.alice.secret, A, "adb", ["logcat", "-d"])).status).toBe(403);
    expect((await t.call(t.alice.secret, "GET", `/v1/leases/${A}/stream`)).status).toBe(403);
    expect((await t.call(t.alice.secret, "POST", "/v1/agent-device/upload", "x", { "content-type": "application/octet-stream" })).status).toBe(403);
  });
});

describe("worker guard: lease ids in real agent-device requests", () => {
  it("reads the lease from meta/flags and refuses conflicting copies", async () => {
    const t = await setup({ limits: { maxSessions: 2, maxLeaseMinutes: 60, maxUploadMB: 1, tokenDays: 7 } });
    await t.allocate(t.alice.secret, A);
    await t.allocate(t.mallory.secret, B);
    const real = (lease: { meta: string; flags: string }) => ({ session: "s", command: "snapshot", positionals: [], flags: { leaseId: lease.flags }, meta: { leaseId: lease.meta }, token: "tdg_client_side" });
    expect((await t.rpc(t.alice.secret, "agent_device.command", real({ meta: A, flags: A }))).status).toBe(200);
    expect((await t.rpc(t.alice.secret, "agent_device.command", real({ meta: A, flags: B }))).status).toBe(403);
    expect((await t.rpc(t.mallory.secret, "agent_device.command", real({ meta: A, flags: A }))).status).toBe(403);
    const forwarded = t.upstream.seen.filter((s) => s.path === "/v1/agent-device/rpc").map((s) => s.body);
    expect(forwarded.some((b) => b.includes("tdg_client_side"))).toBe(false);
  });
});

describe("worker guard: hardening", () => {
  const two = { limits: { maxSessions: 2, maxLeaseMinutes: 60, maxUploadMB: 1, tokenDays: 7 } };

  it("refuses physical devices unless the local policy allows them", async () => {
    const t = await setup();
    expect((await t.allocate(t.alice.secret, A, { physical: true })).status).toBe(403);
    expect((await t.allocate(t.alice.secret, A, { flags: { physical: true } })).status).toBe(403);
    expect(t.upstream.seen).toHaveLength(0);
    const allowed = await setup({ allow: { ...GuardPolicySchema.parse({}).allow, physicalDevices: true } });
    expect((await allowed.allocate(allowed.alice.secret, A, { physical: true })).status).toBe(200);
  });

  it("parallel allocates cannot pass the session cap", async () => {
    const t = await setup(two, { leaseDelayMs: 50 });
    expect((await t.allocate(t.alice.secret, A)).status).toBe(200);
    const ids = ["1", "2", "3", "4", "5"].map((d) => d.repeat(32));
    const statuses = await Promise.all(ids.map((id) => t.allocate(t.mallory.secret, id).then((r) => r.status)));
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
  });

  it("frees a slot once Simlock no longer knows the lease", async () => {
    const t = await setup();
    expect((await t.allocate(t.alice.secret, A)).status).toBe(200);
    expect((await t.rpc(t.alice.secret, "agent_device.lease.release", { leaseId: A })).status).toBe(200);
    expect((await t.allocate(t.mallory.secret, B)).status).toBe(200);
  });

  it("status shows only this token's waiting requests and devices", async () => {
    const status = {
      leases: [{ id: A, deviceId: "dev-a" }, { id: B, deviceId: "dev-b" }],
      waiting: [{ id: "w1", requesterId: A }, { id: "w2", requesterId: B }, { id: "w3", requesterId: "someone-else" }],
      devices: [{ id: "dev-a", state: "leased" }, { id: "dev-b", state: "leased" }, { id: "dev-c", state: "idle" }],
    };
    const t = await setup(two, { status });
    await t.allocate(t.alice.secret, A);
    await t.allocate(t.mallory.secret, B);
    const seen = (await (await t.call(t.mallory.secret, "GET", "/v1/status")).json()) as typeof status;
    expect(seen.leases.map((l) => l.id)).toEqual([B]);
    expect(seen.waiting.map((w) => w.requesterId)).toEqual([B]);
    expect(seen.devices.map((d) => d.id)).toEqual(["dev-b"]);
  });

  it("an allocate answered with a JSON-RPC error leaves no ownership behind", async () => {
    const t = await setup({}, { allocateError: { code: -32000, message: "NO_CAPACITY" } });
    const r = await t.allocate(t.alice.secret, A);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ error: { message: "NO_CAPACITY" } });
    expect((await t.rpc(t.alice.secret, "agent_device.command", { command: "snapshot", leaseId: A })).status).toBe(403);
    expect((await t.exec(t.alice.secret, A, "simctl", ["terminate", "com.x"])).status).toBe(404);
  });

  it("allows exactly the exec argument lists the provider sends (MOCKED Simlock fetch)", async () => {
    const bodies: unknown[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/exec") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { args: string[] };
        bodies.push(body);
        const stdout = body.args.includes("pidof") ? "1234" : "";
        const events = `${stdout ? `event: output\ndata: ${JSON.stringify({ stream: "stdout", chunk: stdout })}\n\n` : ""}event: exit\ndata: {"exitCode":0}\n\n`;
        return new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const provider = new SimlockProvider(
      { kind: "remote", baseUrl: "http://127.0.0.1:1", token: "tdg_test", tenant: "tapdance", runId: "tapdance", clientId: "c", source: "test" },
      {},
      fakeFetch,
    );
    const handle = (platform: "android" | "ios"): LeaseHandle => ({
      provider: "simlock",
      leaseId: A,
      sessionId: "s",
      platform,
      model: "m",
      osVersion: "1",
      physical: false,
      deviceId: "d",
      location: { kind: "remote", endpoint: "http://127.0.0.1:1" },
      ttlMs: 60_000,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      providerData: {},
    });
    for (const platform of ["android", "ios"] as const) {
      await provider.stopApp(handle(platform), "com.x");
      await provider.logs(handle(platform), { lines: 50, appId: "com.x" });
      await provider.logs(handle(platform), { lines: 50 });
      await provider.crashLogs(handle(platform), { lines: 50, appId: "com.x" });
      await provider.crashLogs(handle(platform), { lines: 50 });
    }
    expect(bodies.length).toBeGreaterThanOrEqual(11);
    expect(bodies).toContainEqual({ tool: "adb", args: ["logcat", "-d", "-v", "threadtime", "-t", "50", "--pid=1234"] });
    const policy = GuardPolicySchema.parse({});
    for (const body of bodies) expect(execOf(body, policy), JSON.stringify(body)).toMatchObject({ ok: true });
  });

  it("13. uploads and artifacts belong to the client that created them (H-06)", async () => {
    const t = await setup({ limits: { maxSessions: 2, maxLeaseMinutes: 60, maxUploadMB: 1, tokenDays: 7 } });
    await t.allocate(t.alice.secret, A);
    await t.allocate(t.mallory.secret, B);
    // Uploads must name one of the caller's own leases.
    expect((await t.call(t.alice.secret, "POST", "/v1/agent-device/upload/preflight", { sha256: "x" })).status).toBe(403);
    expect((await t.call(t.mallory.secret, "POST", "/v1/agent-device/upload/preflight", { sha256: "x" }, { "x-agent-device-lease-id": A })).status).toBe(403);
    const pre = await t.call(t.alice.secret, "POST", "/v1/agent-device/upload/preflight", { sha256: "x" }, { "x-agent-device-lease-id": A });
    const uploadId = ((await pre.json()) as { uploadId: string }).uploadId;
    expect(uploadId).toBe("up-aaaa");
    // Mallory cannot push bytes into, finalize or install Alice's upload.
    expect((await t.call(t.mallory.secret, "PUT", `/v1/agent-device/upload/direct/${uploadId}`, "bytes", { "x-agent-device-lease-id": B })).status).toBe(403);
    expect((await t.call(t.mallory.secret, "POST", "/v1/agent-device/upload/finalize", { uploadId }, { "x-agent-device-lease-id": B })).status).toBe(403);
    expect((await t.rpc(t.mallory.secret, "agent_device.command", { command: "install", leaseId: B, positionals: [uploadId] })).status).toBe(403);
    // Alice can.
    expect((await t.call(t.alice.secret, "POST", "/v1/agent-device/upload/finalize", { uploadId }, { "x-agent-device-lease-id": A })).status).toBe(200);
    expect((await t.rpc(t.alice.secret, "agent_device.command", { command: "install", leaseId: A, positionals: [uploadId] })).status).toBe(200);
    // Artifacts: only the client whose command produced one can download it; unknown ids are refused.
    const shot = await t.rpc(t.alice.secret, "agent_device.command", { command: "screenshot", leaseId: A });
    expect(JSON.stringify(await shot.json())).toContain("art-aaaa");
    expect((await t.call(t.mallory.secret, "GET", "/v1/agent-device/artifacts/art-aaaa")).status).toBe(404);
    expect((await t.call(t.mallory.secret, "GET", "/v1/agent-device/artifacts/guessed-id")).status).toBe(404);
    const mine = await t.call(t.alice.secret, "GET", "/v1/agent-device/artifacts/art-aaaa");
    expect(mine.status).toBe(200);
    expect(await mine.text()).toBe("PNGDATA");
  });

  it("14. the device-command channel allows exactly the shapes Tapdance builds (#14)", async () => {
    const { deviceCommands: dc } = await import("@tapdance/provider-simlock");
    const all = GuardPolicySchema.parse({ allow: { notifications: true } });
    const built = [
      dc.android.startIntent({ action: "android.intent.action.VIEW", data: "https://example.com/a?b=c&d=e", component: "com.example/.Main", categories: ["android.intent.category.DEFAULT"], flags: "0x10000000", extras: { mode: "first run; rm -rf /", count: 3, fresh: true } }),
      dc.android.notifications(),
      dc.android.inputTap(400, 955),
      dc.android.focusedWindow(),
      dc.android.shade(true),
      dc.android.postNotification("Hi there", "Body with $(stuff)"),
      dc.android.pushShared("/sdcard/Download/song.mid", "TVRoZA=="),
      dc.android.pushSandbox("com.example", "files/seed.json", "e30="),
      dc.android.pullShared("/sdcard/Download/export.pdf"),
      dc.android.pullSandbox("com.example", "files/export.json"),
      dc.android.mediaScan("/sdcard/Pictures/cat.png"),
      dc.ios.statusBarTime("09:41"),
      dc.ios.statusBarClear(),
    ];
    for (const cmd of built) expect(execOf(cmd, all), JSON.stringify(cmd.args)).toMatchObject({ ok: true });
    // Injection attempts and paths outside the allowed areas.
    const refused: Array<{ tool: string; args: string[]; stdin?: string }> = [
      { tool: "adb", args: ["shell", "am", "start", "-W", "-a", "x; reboot"] },
      { tool: "adb", args: ["shell", "am", "start", "-W", "-d", "'a'b'"] },
      { tool: "adb", args: ["shell", "base64 -d > '/sdcard/../data/x'"], stdin: "e30=" },
      { tool: "adb", args: ["shell", "base64 -d > '/data/local/tmp/x'"], stdin: "e30=" },
      { tool: "adb", args: ["shell", "base64", "'/sdcard/Download/../../data/x'"] },
      { tool: "adb", args: ["shell", "run-as", "com.example", "sh", "-c", "'base64 -d > ../../x'"], stdin: "e30=" },
      { tool: "adb", args: ["shell", "run-as", "com.example", "sh", "-c", "'reboot'"] },
      { tool: "adb", args: ["shell", "settings", "put", "global", "adb_enabled", "0"] },
      { tool: "adb", args: ["shell", "dumpsys", "notification", "--noredact"], stdin: "x" },
      { tool: "adb", args: ["push", "/Users/owner/.ssh/id_rsa", "/sdcard/Download/k"] },
      { tool: "adb", args: ["pull", "/sdcard/Download/x", "/Users/owner/x"] },
      { tool: "simctl", args: ["addmedia", "/Users/owner/Pictures/private.jpg"] },
      { tool: "simctl", args: ["status_bar", "override", "--time", "9:41; rm"] },
    ];
    // With the device shell off, only the fixed shapes pass.
    const fixedOnly = GuardPolicySchema.parse({ allow: { notifications: true, deviceShell: false } });
    for (const cmd of refused) expect(execOf(cmd, fixedOnly).ok, JSON.stringify(cmd.args)).toBe(false);
    // With it on (the default), `adb shell` reaches the emulator's own shell; anything that touches the
    // Mac (push/pull of Mac paths, simctl) is still refused, and phones never get a shell.
    const hostReach = refused.filter((c) => c.tool !== "adb" || c.args[0] !== "shell");
    expect(hostReach.length).toBeGreaterThanOrEqual(3);
    for (const cmd of hostReach) expect(execOf(cmd, all).ok, JSON.stringify(cmd.args)).toBe(false);
    expect(execOf({ tool: "adb", args: ["shell", "dumpsys media.audio_flinger"] }, all).ok).toBe(true);
    expect(execOf({ tool: "adb", args: ["shell", "dumpsys media.audio_flinger"] }, all, { physical: true }).ok).toBe(false);
    for (const args of [["forward", "tcp:1", "tcp:2"], ["reverse", "tcp:1", "tcp:2"], ["emu", "screenrecord", "start", "/Users/owner/x.webm"], ["install", "/Users/owner/x.apk"], ["shell"], ["shell", "  "]]) {
      expect(execOf({ tool: "adb", args }, all).ok, args.join(" ")).toBe(false);
    }
    // Reading an emulator's notifications is inspection (#35); a phone's stays behind `notifications`,
    // and so does posting. Files can be turned off.
    const defaults = GuardPolicySchema.parse({ allow: { deviceShell: false } });
    expect(execOf(dc.android.notifications(), defaults).ok).toBe(true);
    expect(execOf(dc.android.notifications(), defaults, { physical: true }).ok).toBe(false);
    expect(execOf(dc.android.postNotification("a", "b"), defaults).ok).toBe(false);
    expect(execOf({ tool: "adb", args: ["shell", "input", "tap", "1", "2; reboot"] }, defaults).ok).toBe(false);
    expect(execOf(dc.android.pushShared("/sdcard/Download/a.txt", "YQ=="), GuardPolicySchema.parse({ allow: { files: false, deviceShell: false } })).ok).toBe(false);
    // The builders refuse what they cannot quote.
    expect(() => dc.android.startIntent({ data: "it's" })).toThrow(/single quote/);
    expect(() => dc.android.pushShared("/sdcard/Download/../x", "")).toThrow();
  });

  it("15. the device shell reaches leased emulators only, never phones", async () => {
    const t = await setup({ allow: { ...GuardPolicySchema.parse({}).allow, physicalDevices: true }, limits: { maxSessions: 2, maxLeaseMinutes: 60, maxUploadMB: 512, tokenDays: 7 } });
    await t.allocate(t.alice.secret, A);
    await t.allocate(t.alice.secret, B, { physical: true });
    expect((await t.exec(t.alice.secret, A, "adb", ["shell", "dumpsys media.audio_flinger | grep -c Track"])).status).toBe(200);
    expect((await t.exec(t.alice.secret, B, "adb", ["shell", "dumpsys media.audio_flinger"])).status).toBe(403);
    expect((await t.exec(t.mallory.secret, A, "adb", ["shell", "id"])).status).toBe(404);
    const off = await setup({ allow: { ...GuardPolicySchema.parse({}).allow, deviceShell: false } });
    await off.allocate(off.alice.secret, A);
    expect((await off.exec(off.alice.secret, A, "adb", ["shell", "id"])).status).toBe(403);
  });

  it("16. files reach a leased iOS simulator's Photos or app container only (#5)", async () => {
    const { mkdir: mk, readFile: rf, symlink, writeFile: wf } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "td-container-"));
    await mk(join(root, "Documents"));
    await wf(join(root, "Documents", "export.json"), '{"ok":true}');
    const outside = await mkdtemp(join(tmpdir(), "td-outside-"));
    await wf(join(outside, "secret.txt"), "owner's file");
    await symlink(join(outside, "secret.txt"), join(root, "Documents", "link.txt"));
    const { realpath: rp } = await import("node:fs/promises");
    const t = await setup({}, { container: await rp(root) });
    await t.allocate(t.alice.secret, A);
    const put = (secret: string, lease: string, q: string, body = "data") => t.call(secret, "POST", `/v1/leases/${lease}/files?${q}`, body, { "content-type": "application/octet-stream" });
    const get = (secret: string, lease: string, q: string) => t.call(secret, "GET", `/v1/leases/${lease}/files?${q}`);
    // Writes land in the app's Documents, under the given plain name only.
    expect((await put(t.alice.secret, A, "destination=documents&app=com.example&name=seed.json", '{"n":1}')).status).toBe(200);
    expect(await rf(join(root, "Documents", "seed.json"), "utf8")).toBe('{"n":1}');
    for (const name of ["../escape.json", "/Users/owner/x", ".hidden", "a/b.json", ""]) {
      // Refused by the route check (encoded slashes and dots: 404) or by the name rule (403).
      expect([403, 404], name).toContain((await put(t.alice.secret, A, `destination=documents&app=com.example&name=${encodeURIComponent(name)}`)).status);
    }
    const { readdir: rd } = await import("node:fs/promises");
    expect((await rd(join(root, "Documents"))).sort()).toEqual(["export.json", "link.txt", "seed.json"]);
    // No writing through a link that points out of the container.
    expect((await put(t.alice.secret, A, "destination=documents&app=com.example&name=link.txt", "overwrite")).status).toBe(403);
    expect(await rf(join(outside, "secret.txt"), "utf8")).toBe("owner's file");
    // Photos takes media only; the staged copy is handed to simctl addmedia and removed.
    expect((await put(t.alice.secret, A, "destination=photos&name=cat.png", "PNG")).status).toBe(200);
    expect(t.upstream.seen.some((x) => x.path.endsWith("/exec") && x.body.includes("addmedia"))).toBe(true);
    expect((await put(t.alice.secret, A, "destination=photos&name=script.sh")).status).toBe(403);
    // Reads stay inside the container, links included.
    const ok = await get(t.alice.secret, A, "app=com.example&path=Documents%2Fexport.json");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('{"ok":true}');
    expect((await get(t.alice.secret, A, "app=com.example&path=Documents%2Flink.txt")).status).toBe(403);
    for (const path of ["../../etc/passwd", "/etc/passwd", "Documents/../../x", "Other/x"]) {
      expect([403, 404], path).toContain((await get(t.alice.secret, A, `app=com.example&path=${encodeURIComponent(path)}`)).status);
    }
    // Another client's lease, an Android lease, and the policy switch.
    expect((await put(t.mallory.secret, A, "destination=documents&app=com.example&name=x.json")).status).toBe(404);
    const android = await setup({}, { leasePlatform: "android", container: root });
    await android.allocate(android.alice.secret, A);
    expect((await android.call(android.alice.secret, "POST", `/v1/leases/${A}/files?destination=photos&name=a.png`, "x")).status).toBe(400);
    const off = await setup({ allow: { ...GuardPolicySchema.parse({}).allow, files: false } }, { container: root });
    await off.allocate(off.alice.secret, A);
    expect((await off.call(off.alice.secret, "GET", `/v1/leases/${A}/files?app=com.example&path=Documents%2Fexport.json`)).status).toBe(403);
  });

  it("17. uploads keep agent-device's artifact and resume headers (#23)", async () => {
    const t = await setup();
    await t.allocate(t.alice.secret, A);
    const headers = {
      "x-agent-device-lease-id": A,
      "content-type": "application/octet-stream",
      "x-artifact-type": "file",
      "x-artifact-filename": "app-debug.apk",
      "x-artifact-hash": "a".repeat(64),
      "x-artifact-hash-algorithm": "sha256",
      "content-range": "bytes 0-3/4",
      "x-upload-offset": "0",
    };
    expect((await t.call(t.alice.secret, "POST", "/v1/agent-device/upload", "APK!", headers)).status).toBe(200);
    const forwarded = t.upstream.seen.find((x) => x.path === "/v1/agent-device/upload")!.headers;
    for (const [k, v] of Object.entries(headers)) expect(forwarded[k], k).toBe(v);
    // The client's credential never reaches Simlock; the guard sends the local one.
    expect(forwarded["authorization"]).toBe("Bearer slk_LOCALONLYSECRET");
  });
});

