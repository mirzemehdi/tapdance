import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GuardPolicySchema, GuardTokens, type GuardPolicy } from "./policy.js";
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
  seen: Array<{ method: string; path: string; body: string }>;
}

async function fakeSimlock(): Promise<Upstream> {
  const seen: Upstream["seen"] = [];
  const live = new Set<string>();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({ method: req.method ?? "", path: req.url ?? "", body });
    const lease = /^\/v1\/leases\/([0-9a-f]{32})/.exec(req.url ?? "");
    if (req.url === "/v1/agent-device/rpc") {
      const call = JSON.parse(body) as { method: string; params: { leaseId: string } };
      if (call.method.endsWith("lease.allocate")) live.add(call.params.leaseId);
      if (call.method.endsWith("lease.release")) live.delete(call.params.leaseId);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", result: { ok: true, echo: call } }));
      return;
    }
    if (lease && req.method === "GET" && !req.url!.includes("/stream")) {
      res.writeHead(live.has(lease[1]!) ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify({ lease: { id: lease[1] } }));
      return;
    }
    if (lease && req.url!.endsWith("/exec")) {
      res.writeHead(200, { "content-type": "text/event-stream" }).end('event: exit\ndata: {"exitCode":0}\n\n');
      return;
    }
    if (req.url?.startsWith("/v1/agent-device/upload")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ uploaded: body.length }));
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

async function setup(overrides: Partial<GuardPolicy> = {}) {
  const home = await mkdtemp(join(tmpdir(), "td-guard-"));
  const env = { TAPDANCE_HOME: home };
  const upstream = await fakeSimlock();
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
    const t = await setup();
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
    const t = await setup();
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
    const t = await setup();
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
    const t = await setup({ allow: { install: false, interaction: true, inspection: true, screenshots: true, recording: false, logs: false, streaming: false, input: false } });
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
