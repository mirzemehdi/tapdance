import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Tapdance, createProvider, loadConfig, renewIfDue, runKeepalive } from "./index.js";
import { FakeProvider } from "./testing.js";

async function setup(sessionId = "s1", provider = new FakeProvider()) {
  const home = await mkdtemp(join(tmpdir(), "td-sdk-"));
  const cwd = await mkdtemp(join(tmpdir(), "td-proj-"));
  const t = await Tapdance.create({ cwd, env: { TAPDANCE_HOME: home }, session: { id: sessionId, source: "test" }, provider });
  return { t, provider, home, cwd };
}

describe("Tapdance session scoping", () => {
  it("refuses device actions with no lease", async () => {
    const { t } = await setup();
    await expect(t.tap({ kind: "text", text: "Sign in" })).rejects.toMatchObject({ code: "NO_ACTIVE_LEASE" });
    await expect(t.screenshot()).rejects.toMatchObject({ code: "NO_ACTIVE_LEASE" });
  });

  it("leases, acts on that lease only, and releases it", async () => {
    const { t, provider } = await setup();
    const { summary } = await t.lease({ platform: "android", device: "Pixel 8" });
    expect(summary).toMatchObject({ model: "Pixel 8", state: "active", location: { workerLabel: "laptop" } });
    await t.tap({ kind: "text", text: "Sign in" });
    expect(provider.calls.find((c) => c.method === "tap")?.args[0]).toEqual({ kind: "text", text: "Sign in" });
    const shot = await t.screenshot(undefined, "login");
    expect(shot.kind).toBe("screenshot");
    expect(await t.listArtifacts()).toHaveLength(1);
    const released = await t.release();
    expect(released.released).toBe(true);
    await expect(t.status()).rejects.toMatchObject({ code: "NO_ACTIVE_LEASE" });
  });

  it("allows one lease per session", async () => {
    const { t } = await setup();
    await t.lease({ platform: "android" });
    await expect(t.lease({ platform: "ios" })).rejects.toMatchObject({ code: "LEASE_ALREADY_HELD" });
  });

  it("replaces a stale record whose lease has ended", async () => {
    const { t, provider } = await setup();
    const { record } = await t.lease({ platform: "android" });
    provider.active.delete(record.handle.leaseId);
    const again = await t.lease({ platform: "android" });
    expect(again.record.handle.leaseId).not.toBe(record.handle.leaseId);
  });

  it("does not let one session release another session's lease", async () => {
    const provider = new FakeProvider();
    const a = await setup("agent-a", provider);
    const b = await Tapdance.create({ cwd: a.cwd, env: { TAPDANCE_HOME: a.home }, session: { id: "agent-b", source: "test" }, provider });
    await a.t.lease({ platform: "android" });
    expect((await b.release()).released).toBe(false);
    expect((await a.t.status()).state).toBe("active");
  });

  it("clears the record when the provider says the lease is gone", async () => {
    const { t, provider } = await setup();
    const { record } = await t.lease({ platform: "android" });
    provider.active.delete(record.handle.leaseId);
    await expect(t.inspect()).rejects.toMatchObject({ code: "LEASE_LOST" });
    expect(await t.current()).toBeUndefined();
  });

  it("refuses agent input while a person holds the device", async () => {
    const { t } = await setup();
    await t.lease({ platform: "android" });
    await t.setHumanHold(5_000, "browser viewer");
    await expect(t.tap({ kind: "ref", ref: "e1" })).rejects.toMatchObject({ code: "HUMAN_HELD", details: { retryAfterMs: expect.any(Number) } });
    expect(await t.inspect()).toBeDefined(); // reading is still allowed
    await t.setHumanHold(0, "browser viewer");
    await expect(t.tap({ kind: "ref", ref: "e1" })).resolves.toMatchObject({ ok: true });
  });

  it("refuses a disabled platform", async () => {
    const { cwd, home } = await setup();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(cwd, "tapdance.config.json"), JSON.stringify({ platforms: { ios: { enabled: false } } }));
    const t = await Tapdance.create({ cwd, env: { TAPDANCE_HOME: home }, session: { id: "x", source: "test" }, provider: new FakeProvider() });
    await expect(t.lease({ platform: "ios" })).rejects.toMatchObject({ code: "USAGE" });
  });

  it("tracks one recording at a time", async () => {
    const { t } = await setup();
    await t.lease({ platform: "android" });
    await t.startRecording();
    await expect(t.startRecording()).rejects.toMatchObject({ code: "USAGE" });
    const stopped = await t.stopRecording();
    expect(stopped.kind).toBe("recording");
    await expect(t.stopRecording()).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("keepalive", () => {
  const due = (t: Tapdance) => t.store.update(t.sessionId, (r) => ({ ...r, handle: { ...r.handle, expiresAt: new Date(Date.now() + 1000).toISOString() } }));

  it("renews when a third of the lease has passed, and stops when the session releases", async () => {
    const { t, provider } = await setup();
    await t.lease({ platform: "android", ttlMinutes: 1 });
    await due(t);
    expect(await renewIfDue(t, { idleMs: 0 })).toBe("renewed");
    expect(await renewIfDue(t, { idleMs: 0 })).toBe("not-due");
    const done = runKeepalive(t, { maxMs: 60_000, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 50));
    await t.release();
    expect(await done).toBe("released");
    expect(provider.calls.filter((c) => c.method === "renew").length).toBe(1);
  });

  it("leaves renewal to another live renewer", async () => {
    const { t } = await setup();
    await t.lease({ platform: "android", ttlMinutes: 1 });
    await t.store.update(t.sessionId, (r) => ({ ...r, renewer: { pid: process.ppid, heartbeatAt: new Date().toISOString() }, handle: { ...r.handle, expiresAt: new Date(Date.now() + 1000).toISOString() } }));
    expect(await renewIfDue(t, { idleMs: 0 })).toBe("other-renewer");
  });

  it("reports a lost lease", async () => {
    const { t, provider } = await setup();
    const { record } = await t.lease({ platform: "android" });
    provider.active.delete(record.handle.leaseId);
    await due(t);
    expect(await runKeepalive(t, { maxMs: 60_000, intervalMs: 10 })).toBe("lost");
  });

  it("releases an idle lease", async () => {
    const { t, provider } = await setup();
    await t.lease({ platform: "android" });
    await t.store.update(t.sessionId, (r) => ({ ...r, lastUsedAt: new Date(Date.now() - 60 * 60_000).toISOString() }));
    expect(await renewIfDue(t, { idleMs: 30 * 60_000 })).toBe("released-idle");
    expect(provider.active.size).toBe(0);
  });
});

describe("ownership", () => {
  it("lets a process release only what it leased when asked", async () => {
    const { t } = await setup();
    await t.lease({ platform: "android" });
    expect(await t.release({ onlyOwnedBy: { kind: "mcp", pid: process.pid } })).toMatchObject({ released: false, skipped: expect.any(String) });
    expect(await t.release({ onlyOwnedBy: { kind: "sdk", pid: process.pid } })).toMatchObject({ released: true });
  });

  it("returns the held device when asked to reuse it", async () => {
    const { t } = await setup();
    const first = await t.lease({ platform: "android" });
    const again = await t.lease({ platform: "android", reuse: true });
    expect(again.reused).toBe(true);
    expect(again.record.handle.leaseId).toBe(first.record.handle.leaseId);
    await expect(t.lease({ platform: "ios", reuse: true })).rejects.toMatchObject({ code: "LEASE_ALREADY_HELD" });
  });

  it("serializes concurrent leases in one session", async () => {
    const { t, provider } = await setup();
    const results = await Promise.allSettled([t.lease({ platform: "android" }), t.lease({ platform: "android" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(provider.calls.filter((c) => c.method === "lease")).toHaveLength(1);
  });
});

describe("provider factory", () => {
  it("has no fake cloud provider", async () => {
    const r = await loadConfig({ cwd: await mkdtemp(join(tmpdir(), "x")), env: { TAPDANCE_HOME: await mkdtemp(join(tmpdir(), "y")), TAPDANCE_PROVIDER: "cloud" } });
    await expect(createProvider(r, "s")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("needs an endpoint for self-hosted", async () => {
    const r = await loadConfig({ cwd: await mkdtemp(join(tmpdir(), "x")), env: { TAPDANCE_HOME: await mkdtemp(join(tmpdir(), "y")), TAPDANCE_PROVIDER: "self-hosted" } });
    await expect(createProvider(r, "s")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
