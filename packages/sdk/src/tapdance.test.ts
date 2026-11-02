import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROFILE_PROVIDER, Tapdance, TapdanceError, createProvider, loadConfig, renewIfDue, runKeepalive, type LeaseHandle } from "./index.js";
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

  it("doctor warns about security settings a project file tried to set", async () => {
    const { cwd, home } = await setup();
    await writeFile(join(cwd, "tapdance.config.json"), JSON.stringify({ tools: { paths: { asc: "/bin/sh" } } }));
    const t = await Tapdance.create({ cwd, env: { TAPDANCE_HOME: home }, session: { id: "x", source: "test" }, provider: new FakeProvider() });
    const config = (await t.doctor({ host: false })).find((c) => c.id === "config");
    expect(config).toMatchObject({ status: "warn", detail: expect.stringMatching(/Ignored tools\.paths/), fix: expect.stringMatching(/--global/) });
    expect(t.resolved.config.tools.paths).toEqual({});
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
    expect(stopped.bytes).toBeGreaterThan(0);
    await expect(t.stopRecording()).rejects.toMatchObject({ code: "USAGE" });
  });

  it("release while recording keeps the video as an artifact", async () => {
    const { t } = await setup();
    await t.lease({ platform: "android" });
    await t.startRecording();
    const released = await t.release();
    expect(released.released).toBe(true);
    expect(released.artifacts).toHaveLength(1);
    const recordings = (await t.listArtifacts()).filter((a) => a.kind === "recording");
    expect(recordings).toHaveLength(1);
    expect(recordings[0]).toMatchObject({ note: "stopped at release" });
    expect(recordings[0]!.bytes).toBeGreaterThan(0);
  });

  it("still releases when the recording cannot be stopped", async () => {
    const { t, provider } = await setup();
    await t.lease({ platform: "android" });
    await t.startRecording();
    provider.failNext("stopRecording", new TapdanceError("DEVICE_ERROR", "recorder crashed"));
    expect((await t.release()).released).toBe(true);
    expect(await t.current()).toBeUndefined();
  });

  it("a failed stop does not wedge recording", async () => {
    const { t, provider } = await setup();
    await t.lease({ platform: "android" });
    await t.startRecording();
    provider.failNext("stopRecording", new TapdanceError("DEVICE_ERROR", "recorder crashed"));
    await expect(t.stopRecording()).rejects.toMatchObject({ code: "DEVICE_ERROR", hint: expect.stringMatching(/start_recording/) });
    await expect(t.startRecording()).resolves.toMatchObject({ path: expect.any(String) });
  });

  it("LEASE_LOST from a device call releases the lease before forgetting it", async () => {
    const { t, provider } = await setup();
    const { record } = await t.lease({ platform: "android" });
    provider.failNext("tap", new TapdanceError("LEASE_LOST", "lease ended by simlock"));
    await expect(t.tap({ kind: "text", text: "Sign in" })).rejects.toMatchObject({ code: "LEASE_LOST" });
    expect(provider.calls.some((c) => c.method === "release" && c.args[0] === record.handle.leaseId)).toBe(true);
    expect(provider.active.size).toBe(0);
    expect(await t.current()).toBeUndefined();
  });

  it("renew of an ended lease throws LEASE_LOST and clears the record", async () => {
    const { t, provider } = await setup();
    await t.lease({ platform: "android" });
    // MOCKED: a provider whose renew answers that the lease has ended.
    provider.renew = async (handle: LeaseHandle) => ({ state: "ended", handle, endReason: "expired" });
    await expect(t.renew()).rejects.toMatchObject({ code: "LEASE_LOST", details: { reason: "expired" } });
    expect(await t.current()).toBeUndefined();
  });

  it("a person driving the viewer counts as use", async () => {
    const { t } = await setup();
    await t.lease({ platform: "android" });
    await t.store.update(t.sessionId, (r) => ({ ...r, lastUsedAt: new Date(0).toISOString() }));
    await t.setHumanHold(5_000, "browser viewer");
    await vi.waitFor(async () => expect(Date.parse((await t.current())!.lastUsedAt!)).toBeGreaterThan(Date.now() - 60_000));
  });
});

describe("tools on the leased device", () => {
  it("a tool run on the device counts as use", async () => {
    const bin = await mkdtemp(join(tmpdir(), "td-maestro-bin-"));
    await writeFile(join(bin, "maestro"), '#!/bin/sh\necho "maestro $*"\n');
    await chmod(join(bin, "maestro"), 0o755);
    const home = await mkdtemp(join(tmpdir(), "td-sdk-"));
    const t = await Tapdance.create({ cwd: await mkdtemp(join(tmpdir(), "td-proj-")), env: { TAPDANCE_HOME: home, PATH: `${bin}:/usr/bin:/bin` }, session: { id: "m", source: "test" }, provider: new FakeProvider() });
    await t.lease({ platform: "android" });
    // The fake lease is remote; lease tools run only where the device is, so place it here.
    await t.store.update(t.sessionId, (r) => ({ ...r, lastUsedAt: new Date(0).toISOString(), handle: { ...r.handle, location: { kind: "local", endpoint: "http://127.0.0.1:4701" } } }));
    const run = await t.tool("maestro", ["test", "flow.yaml"], { fromAgent: true });
    expect(run.stdout).toContain("maestro test flow.yaml --device emulator-5554");
    expect(Date.parse((await t.current())!.lastUsedAt!)).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("agent access to asc", () => {
  async function withAsc() {
    const bin = await mkdtemp(join(tmpdir(), "td-asc-bin-"));
    await writeFile(join(bin, "asc"), '#!/bin/sh\necho "asc $*"\n');
    await chmod(join(bin, "asc"), 0o755);
    const t = await Tapdance.create({
      cwd: await mkdtemp(join(tmpdir(), "td-proj-")),
      env: { TAPDANCE_HOME: await mkdtemp(join(tmpdir(), "td-sdk-")), PATH: `${bin}:/usr/bin:/bin` },
      session: { id: "asc", source: "test" },
      provider: new FakeProvider(),
    });
    return t;
  }

  it("refuses commands that print credentials or run shell steps", async () => {
    const t = await withAsc();
    await expect(t.tool("asc", ["auth", "token", "--confirm"], { fromAgent: true })).rejects.toMatchObject({ code: "FORBIDDEN", hint: expect.stringMatching(/terminal/) });
    await expect(t.tool("asc", ["workflow", "run", "x"], { fromAgent: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(t.tool("asc", ["install-skills"], { fromAgent: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("still allows help, auth status and ordinary reads", async () => {
    const t = await withAsc();
    expect((await t.tool("asc", ["auth", "--help"], { fromAgent: true })).stdout).toContain("asc auth --help");
    expect((await t.tool("asc", ["auth", "status"], { fromAgent: true })).exitCode).toBe(0);
    expect((await t.tool("asc", ["apps", "list"], { fromAgent: true })).readOnly).toBe(true);
    // A person at the terminal is not an agent.
    expect((await t.tool("asc", ["auth", "token"])).exitCode).toBe(0);
  });
});

describe("keepalive", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("renewIfDue never rejects when idle release fails", async () => {
    const { t } = await setup();
    await t.lease({ platform: "android" });
    await t.store.update(t.sessionId, (r) => ({ ...r, lastUsedAt: new Date(0).toISOString() }));
    // MOCKED: release fails the way a busy session lock does.
    t.release = async () => {
      throw new TapdanceError("TIMEOUT", "Another Tapdance process is busy with this session");
    };
    await expect(renewIfDue(t, { idleMs: 30 * 60_000 })).resolves.toBe("error");
  });

  it("no idle release while a human hold is active", async () => {
    const { t, provider } = await setup();
    await t.lease({ platform: "android" });
    await t.setHumanHold(60_000, "browser viewer");
    await t.store.update(t.sessionId, (r) => ({ ...r, lastUsedAt: new Date(0).toISOString() }));
    expect(await renewIfDue(t, { idleMs: 30 * 60_000 })).not.toBe("released-idle");
    expect(provider.active.size).toBe(1);
  });

  it("keeps renewing through an offline worker until the lease would have expired", async () => {
    const realSetTimeout = setTimeout;
    const { t, provider } = await setup();
    await t.lease({ platform: "android", ttlMinutes: 3 });
    // MOCKED: the worker stays offline for every renew.
    let renews = 0;
    provider.renew = async () => {
      renews++;
      throw new TapdanceError("WORKER_OFFLINE", "worker offline");
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const expiresAt = Date.parse((await t.current())!.handle.expiresAt);
    let outcome: string | undefined;
    const done = runKeepalive(t, { maxMs: 60 * 60_000, intervalMs: 30_000 }).then((o) => (outcome = o));
    while (outcome === undefined) {
      await vi.advanceTimersByTimeAsync(30_000);
      // Let the store's real file I/O finish between ticks.
      await new Promise((r) => realSetTimeout(r, 5));
    }
    await done;
    expect(outcome).toBe("lost");
    expect(Date.now()).toBeGreaterThan(expiresAt);
    expect(renews).toBeGreaterThan(1);
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

  async function homeAndProject(user: { config?: object; credentials?: object }, project?: object) {
    const home = await mkdtemp(join(tmpdir(), "td-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "td-proj-"));
    if (user.config) await writeFile(join(home, "config.json"), JSON.stringify(user.config));
    if (user.credentials) await writeFile(join(home, "credentials.json"), JSON.stringify(user.credentials), { mode: 0o600 });
    if (project) await writeFile(join(cwd, "tapdance.config.json"), JSON.stringify(project));
    return loadConfig({ cwd, env: { TAPDANCE_HOME: home } });
  }

  /** MOCKED: a fetch that records every Authorization header it is handed. */
  function recordingFetch() {
    const seen: Array<string | undefined> = [];
    const fetchSpy = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.["Authorization"]);
      return new Response(JSON.stringify({ devices: [], leases: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    return { seen, fetchSpy };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not send a saved token to an endpoint a project file redirects to", async () => {
    const { seen, fetchSpy } = recordingFetch();
    const r = await homeAndProject({ credentials: { token: "slk_xxxxxxxxxxxx", endpoint: "https://gw.example" } }, { provider: "self-hosted", endpoint: "https://evil.example" });
    expect(r.endpointSource).toBe("project");
    await expect(createProvider(r, "s")).rejects.toMatchObject({ code: "AUTH_FAILED", message: expect.stringContaining("https://gw.example"), hint: expect.stringContaining("--endpoint https://evil.example") });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("refuses an unbound token for an endpoint only a project file names", async () => {
    const r = await homeAndProject({ credentials: { token: "slk_xxxxxxxxxxxx" } }, { provider: "self-hosted", endpoint: "https://gw.example" });
    await expect(createProvider(r, "s")).rejects.toMatchObject({ code: "CONFIG_INVALID", hint: expect.stringMatching(/set-token/) });
  });

  it("sends a token to the origin it is bound to, wherever the endpoint is configured", async () => {
    const { seen } = recordingFetch();
    const r = await homeAndProject({ credentials: { token: "slk_xxxxxxxxxxxx", endpoint: "https://gw.example" } }, { provider: "self-hosted", endpoint: "https://gw.example/" });
    const provider = (await createProvider(r, "s")) as unknown as { http: { status: () => Promise<unknown> } };
    await provider.http.status();
    expect(seen).toEqual(["Bearer slk_xxxxxxxxxxxx"]);
  });

  it("keeps working with a legacy credentials file and a user-level endpoint", async () => {
    const { seen } = recordingFetch();
    const r = await homeAndProject({ config: { provider: "self-hosted", endpoint: "https://gw.example" }, credentials: { token: "slk_xxxxxxxxxxxx" } });
    expect(r.endpointSource).toBe("user");
    const provider = (await createProvider(r, "s")) as unknown as { http: { status: () => Promise<unknown> } };
    await provider.http.status();
    expect(seen).toEqual(["Bearer slk_xxxxxxxxxxxx"]);
  });
});

describe("device profiles and requests for a person", () => {
  class FakeProfiles extends FakeProvider {
    override readonly name: string = PROFILE_PROVIDER;
  }

  it("routes a profile lease, and every call on it, to the profile provider", async () => {
    const home = await mkdtemp(join(tmpdir(), "td-sdk-"));
    const cwd = await mkdtemp(join(tmpdir(), "td-proj-"));
    const simlock = new FakeProvider();
    const profiles = new FakeProfiles();
    const t = await Tapdance.create({ cwd, env: { TAPDANCE_HOME: home }, session: { id: "p1", source: "test" }, provider: simlock, profileProvider: profiles });
    await t.lease({ platform: "android", profile: "play-tester" });
    await t.tap({ kind: "text", text: "Buy" });
    await t.release();
    expect(profiles.calls.map((c) => c.method)).toEqual(expect.arrayContaining(["lease", "tap", "release"]));
    expect((profiles.calls.find((c) => c.method === "lease")!.args[1] as { profile: string }).profile).toBe("play-tester");
    expect(simlock.calls.filter((c) => ["lease", "tap", "release"].includes(c.method))).toEqual([]);
  });

  it("request_human waits until the person marks it done, and times out otherwise", async () => {
    const { t } = await setup("h1");
    await t.lease({ platform: "android" });
    const waiting = t.requestHuman("Sign in to the license-tester account", 10_000);
    await new Promise((r) => setTimeout(r, 300));
    expect((await t.pendingHumanRequest())?.reason).toBe("Sign in to the license-tester account");
    expect(await t.completeHumanRequest("viewer hand back")).toBe(true);
    expect(await waiting).toMatchObject({ completed: true, how: "viewer hand back" });
    expect(await t.pendingHumanRequest()).toBeUndefined();
    const timedOut = await t.requestHuman("Approve the purchase", 1_200);
    expect(timedOut.completed).toBe(false);
    expect(timedOut.hint).toMatch(/Approve the purchase/);
    expect(await t.completeHumanRequest("late")).toBe(false);
  });

  it("device operations need a provider that has them", async () => {
    const { t } = await setup("d1");
    await t.lease({ platform: "android" });
    await expect(t.device({ kind: "uninstall", appId: "com.example" })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });
});

describe("lease loss and TTL caps (#27)", () => {
  it("names when and why the lease ended on the next command, instead of 'no device'", async () => {
    const { t, provider } = await setup("lost1");
    await t.lease({ platform: "android" });
    // MOCKED: the worker ends the lease underneath us (a host restart) and the next call fails oddly.
    provider.active.clear();
    const original = provider.tap.bind(provider);
    provider.tap = async () => {
      throw new TapdanceError("DEVICE_ERROR", "Unexpected internal error");
    };
    await expect(t.tap({ kind: "text", text: "Next" })).rejects.toMatchObject({ code: "LEASE_LOST" });
    provider.tap = original;
    await expect(t.screenshot()).rejects.toMatchObject({ code: "LEASE_LOST", message: expect.stringMatching(/ended at .*: /) });
    // A new lease clears the note.
    await t.lease({ platform: "android" });
    await expect(t.inspect()).resolves.toBeDefined();
  });
});
