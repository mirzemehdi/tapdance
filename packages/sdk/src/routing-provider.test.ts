import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TapdanceError, type DeviceInventory, type LeaseHandle, type LeaseRequest, type Platform } from "@tapdance/core";
import { SimlockProvider } from "@tapdance/provider-simlock";
import { RoutingProvider, type RouteTarget } from "./routing-provider.js";
import { Tapdance } from "./tapdance.js";
import { createProvider } from "./provider-factory.js";
import { loadConfig } from "@tapdance/core";
import { FakeProvider } from "./testing.js";

/** A FakeProvider (mocked, no device) that stands for one host: its leases record its endpoint. */
class HostFake extends FakeProvider {
  constructor(
    readonly endpoint: string,
    readonly serves: Platform[],
  ) {
    super();
  }
  override async lease(sessionId: string, request: LeaseRequest): Promise<LeaseHandle> {
    const handle = await super.lease(sessionId, request);
    return { ...handle, location: { ...handle.location, endpoint: this.endpoint }, providerData: { baseUrl: this.endpoint } };
  }
  override async inventory(): Promise<DeviceInventory> {
    return {
      catalog: this.serves.map((platform) => ({ platform, models: [platform === "ios" ? "iPhone 16" : "Pixel 8"], osVersions: [platform === "ios" ? "18.5" : "35"] })),
      capacity: this.serves.map((platform) => ({ platform, running: 0, limit: 1, warm: 0, leased: 0 })),
      devices: [],
      queueDepth: 0,
      notes: [],
    };
  }
}

function target(name: string, endpoint: string, serves: Platform[], options: { down?: boolean; platforms?: Platform[] } = {}): RouteTarget & { fake: HostFake } {
  const fake = new HostFake(endpoint, serves);
  return {
    name,
    endpoint,
    fake,
    provider: fake,
    ...(options.platforms ? { platforms: options.platforms } : {}),
    probe: async () => {
      if (options.down) throw new TapdanceError("PROVIDER_UNREACHABLE", "fetch failed", { cause: new Error("connect ECONNREFUSED 100.64.0.9:443") });
      return fake.inventory();
    },
  };
}

const N2 = "https://n2-host.tail1.ts.net";
const MAC = "https://mac-mini.tail1.ts.net";
const lease = (platform: Platform, extra: Partial<LeaseRequest> = {}): LeaseRequest => ({ platform, ttlMs: 60_000, ...extra });

// Every test here uses FakeProvider-based hosts (mocked): routing and errors are under test, not devices.
describe("RoutingProvider (mocked hosts)", () => {
  it("routes a lease by platform to the target that serves it", async () => {
    const n2 = target("n2", N2, ["android"]);
    const mac = target("mac", MAC, ["ios"]);
    const router = new RoutingProvider([n2, mac]);
    const ios = await router.lease("s1", lease("ios"));
    expect(ios.location).toMatchObject({ endpoint: MAC, target: "mac" });
    expect(mac.fake.calls.some((c) => c.method === "lease")).toBe(true);
    expect(n2.fake.calls.some((c) => c.method === "lease")).toBe(false);
    const android = await router.lease("s2", lease("android"));
    expect(android.location).toMatchObject({ endpoint: N2, target: "n2" });
  });

  it("prefers config order when several targets serve the platform, and --target overrides it", async () => {
    const a = target("a", "https://a.example.com", ["android"]);
    const b = target("b", "https://b.example.com", ["android"]);
    const router = new RoutingProvider([a, b]);
    expect((await router.lease("s1", lease("android"))).location.target).toBe("a");
    expect((await router.lease("s2", lease("android", { target: "b" }))).location.target).toBe("b");
    // The target name is not passed on to the host.
    const forwarded = b.fake.calls.find((c) => c.method === "lease")!.args[1] as LeaseRequest;
    expect(forwarded.target).toBeUndefined();
    await expect(router.lease("s3", lease("android", { target: "nope" }))).rejects.toMatchObject({ code: "USAGE", hint: expect.stringContaining("a, b") });
  });

  it("picks the target that has the requested model", async () => {
    const a = target("a", "https://a.example.com", ["ios"]);
    const b = new HostFake("https://b.example.com", ["ios"]);
    b.inventory = async () => ({ catalog: [{ platform: "ios", models: ["iPhone 17 Pro"], osVersions: ["26.1"] }], capacity: [], devices: [], queueDepth: 0, notes: [] });
    const router = new RoutingProvider([a, { name: "b", endpoint: "https://b.example.com", provider: b, probe: () => b.inventory() }]);
    expect((await router.lease("s1", lease("ios", { device: "iPhone 17 Pro" }))).location.target).toBe("b");
    await expect(router.lease("s2", lease("ios", { device: "iPhone 3G" }))).rejects.toMatchObject({ code: "DEVICE_UNAVAILABLE", retryable: false });
  });

  it("sends every follow-up call to the endpoint recorded on the lease", async () => {
    const n2 = target("n2", N2, ["android"]);
    const mac = target("mac", MAC, ["ios"]);
    const router = new RoutingProvider([n2, mac]);
    const handle = await router.lease("s1", lease("ios"));
    await router.installApp(handle, "/tmp/App.app");
    await router.tap(handle, { kind: "text", text: "OK" });
    await router.screenshot(handle, "/tmp/shot.png");
    await router.status(handle);
    await router.release(handle);
    const macCalls = mac.fake.calls.map((c) => c.method);
    expect(macCalls).toEqual(expect.arrayContaining(["installApp", "tap", "status", "release"]));
    expect(n2.fake.calls.map((c) => c.method)).toEqual([]);
    // A lease from a host that is no longer a target is refused, not sent elsewhere.
    const stray = { ...handle, location: { ...handle.location, endpoint: "https://gone.example.com" }, providerData: { baseUrl: "https://gone.example.com" } };
    expect(() => router.targetFor(stray)).toThrow(/not a connect target any more/);
  });

  it("fails fast and names the host when the platform's only host is down, and the other still leases", async () => {
    const n2 = target("n2", N2, ["android"]);
    const mac = target("mac", MAC, ["ios"], { down: true });
    const router = new RoutingProvider([n2, mac]);
    const error = await router.lease("s1", lease("ios")).catch((e: unknown) => e as TapdanceError);
    expect(error).toMatchObject({ code: "PROVIDER_UNREACHABLE", retryable: true });
    expect(error.message).toContain(`target mac (${MAC})`);
    expect(error.message).toContain("ECONNREFUSED");
    expect(error.hint).toContain("Up: n2 (android)");
    expect(error.details).toMatchObject({ target: "mac", up: ["n2"], down: ["mac"] });
    // Never another platform instead.
    expect(n2.fake.calls.some((c) => c.method === "lease")).toBe(false);
    expect((await router.lease("s2", lease("android"))).location.target).toBe("n2");
  });

  it("skips a down host for another host of the same platform", async () => {
    const a = target("a", "https://a.example.com", ["android"], { down: true });
    const b = target("b", "https://b.example.com", ["android"]);
    const progress: string[] = [];
    const handle = await new RoutingProvider([a, b]).lease("s1", lease("android"), { onProgress: (m) => progress.push(m) });
    expect(handle.location.target).toBe("b");
    expect(progress.join("\n")).toMatch(/a \(https:\/\/a\.example\.com\) does not answer/);
  });

  it("honours a target's platform limit and says when no target serves a platform", async () => {
    const both = target("both", N2, ["android", "ios"], { platforms: ["android"] });
    const router = new RoutingProvider([both]);
    await expect(router.lease("s1", lease("ios"))).rejects.toMatchObject({ code: "DEVICE_UNAVAILABLE", hint: expect.stringContaining("tapdance connect <endpoint> --platform ios") });
  });

  it("doctor: one section per host, OK while one is usable, the down host only warns", async () => {
    const n2 = target("n2", N2, ["android"]);
    const mac = target("mac", MAC, ["ios"], { down: true });
    mac.fake.doctor = async () => [{ id: "simlock.reachable", title: "Simlock gateway/worker reachable", status: "fail", detail: "fetch failed" }];
    const checks = await new RoutingProvider([n2, mac]).doctor();
    expect(checks[0]).toMatchObject({ id: "targets", status: "warn" });
    expect(checks[0]!.detail).toContain("Android → n2");
    expect(checks[0]!.detail).toContain("iOS → no host up");
    expect(checks.find((c) => c.id === "target.n2")).toMatchObject({ status: "pass", target: "n2" });
    expect(checks.find((c) => c.id === "target.mac")).toMatchObject({ status: "warn", target: "mac" });
    expect(checks.find((c) => c.id === "target.mac.simlock.reachable")).toMatchObject({ status: "warn" });
    expect(checks.some((c) => c.status === "fail")).toBe(false);
    // Both down: a failure.
    const down = await new RoutingProvider([target("x", N2, ["android"], { down: true }), mac]).doctor();
    expect(down[0]).toMatchObject({ id: "targets", status: "fail" });
  });

  it("inventory: merged lists plus one entry per host, a down host with its reason", async () => {
    const inv = await new RoutingProvider([target("n2", N2, ["android"]), target("mac", MAC, ["ios"], { down: true })]).inventory();
    expect(inv.hosts).toEqual([
      expect.objectContaining({ target: "n2", endpoint: N2, reachable: true }),
      expect.objectContaining({ target: "mac", endpoint: MAC, reachable: false, error: expect.stringContaining("ECONNREFUSED") }),
    ]);
    expect(inv.catalog.map((c) => c.platform)).toEqual(["android"]);
    expect(inv.notes[0]).toContain("mac");
  });
});

describe("Tapdance with several targets (mocked hosts)", () => {
  it("keeps one lease per session: Android, release, then iOS, each on its own host", async () => {
    const home = await mkdtemp(join(tmpdir(), "td-sdk-"));
    const cwd = await mkdtemp(join(tmpdir(), "td-proj-"));
    const n2 = target("n2", N2, ["android"]);
    const mac = target("mac", MAC, ["ios"]);
    const t = await Tapdance.create({ cwd, env: { TAPDANCE_HOME: home }, session: { id: "s1", source: "test" }, provider: new RoutingProvider([n2, mac]) });
    const first = await t.lease({ platform: "android", target: "n2" });
    expect(first.summary.location).toMatchObject({ endpoint: N2, target: "n2" });
    await expect(t.lease({ platform: "ios" })).rejects.toMatchObject({ code: "LEASE_ALREADY_HELD" });
    await t.screenshot();
    await t.release();
    const second = await t.lease({ platform: "ios" });
    expect(second.summary.location).toMatchObject({ endpoint: MAC, target: "mac" });
    await t.tap({ kind: "text", text: "Settings" });
    expect(mac.fake.calls.map((c) => c.method)).toContain("tap");
    expect(n2.fake.calls.map((c) => c.method)).not.toContain("tap");
  });

  it("refuses --target when no targets are configured", async () => {
    const home = await mkdtemp(join(tmpdir(), "td-sdk-"));
    const t = await Tapdance.create({ cwd: home, env: { TAPDANCE_HOME: home }, session: { id: "s1", source: "test" }, provider: new FakeProvider() });
    await expect(t.lease({ platform: "android", target: "n2" })).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("createProvider with connect targets", () => {
  it("gives each target only the token saved for its origin", async () => {
    const home = await mkdtemp(join(tmpdir(), "td-sdk-"));
    await writeFile(join(home, "config.json"), JSON.stringify({ provider: "self-hosted", targets: [{ name: "n2", endpoint: N2 }, { name: "mac", endpoint: MAC }] }));
    await writeFile(join(home, "credentials.json"), JSON.stringify({ tokens: { [N2]: "tdg_n2secret", [MAC]: "tdg_macsecret" } }), { mode: 0o600 });
    const resolved = await loadConfig({ cwd: home, env: { TAPDANCE_HOME: home } });
    const router = (await createProvider(resolved, "s1", { TAPDANCE_HOME: home })) as RoutingProvider;
    expect(router).toBeInstanceOf(RoutingProvider);
    const tokens = router.targets.map((t) => [t.name, (t.provider as SimlockProvider).connection.token, (t.provider as SimlockProvider).connection.baseUrl]);
    expect(tokens).toEqual([
      ["n2", "tdg_n2secret", N2],
      ["mac", "tdg_macsecret", MAC],
    ]);
  });

  it("a target without a token reports it and does not take the others down", async () => {
    const home = await mkdtemp(join(tmpdir(), "td-sdk-"));
    await writeFile(join(home, "config.json"), JSON.stringify({ provider: "self-hosted", targets: [{ name: "n2", endpoint: N2 }, { name: "mac", endpoint: MAC }] }));
    await writeFile(join(home, "credentials.json"), JSON.stringify({ tokens: { [N2]: "tdg_n2secret" } }), { mode: 0o600 });
    const router = (await createProvider(await loadConfig({ cwd: home, env: { TAPDANCE_HOME: home } }), "s1", { TAPDANCE_HOME: home })) as RoutingProvider;
    expect((router.targets[0]!.provider as SimlockProvider).connection.token).toBe("tdg_n2secret");
    const doctor = await router.targets[1]!.provider.doctor();
    expect(doctor[0]).toMatchObject({ status: "fail", detail: expect.stringContaining(`No agent token for ${MAC}`) });
    await expect(router.targets[1]!.probe(1000)).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
});
