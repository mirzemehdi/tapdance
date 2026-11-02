import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TapdanceError } from "@tapdance/core";
import {
  SimlockHttp,
  decodeFrames,
  fromAgentDeviceError,
  isPrivateHost,
  parseExecStream,
  readLocalProfile,
  remoteConnection,
  toAgentDeviceTarget,
  toUiElement,
  validateAppPath,
} from "./index.js";
import { CODE_MAP } from "./agent-device-errors.js";
import { RAW_INPUT_APPS, SimlockProvider, actionResult, bundleIdOf, describeBadHealth, focusedPackage, matchesTarget, summarizeDiff } from "./provider.js";
import { encodeFrame } from "./stream-framing.js";

describe("exec stream", () => {
  it("collects stdout, stderr and the exit code", () => {
    const body = 'event: output\ndata: {"stream":"stdout","chunk":"a\\n"}\n\nevent: output\ndata: {"stream":"stderr","chunk":"warn"}\n\nevent: exit\ndata: {"exitCode":3}\n\n';
    expect(parseExecStream(body)).toEqual({ exitCode: 3, stdout: "a\n", stderr: "warn" });
  });

  it("turns an error event into a TapdanceError", () => {
    expect(() => parseExecStream('event: error\ndata: {"code":"EXEC_TIMEOUT","message":"slow"}\n\n')).toThrow(/EXEC_TIMEOUT/);
  });

  it("refuses a stream with no exit", () => {
    expect(() => parseExecStream("event: output\ndata: {}\n\n")).toThrow(/without an exit/);
  });
});

describe("connections", () => {
  it("knows private hosts", () => {
    for (const h of ["127.0.0.1", "localhost", "10.1.2.3", "192.168.0.4", "172.20.0.1", "100.101.102.103", "mac.tail1234.ts.net", "::1"]) expect(isPrivateHost(h)).toBe(true);
    for (const h of ["8.8.8.8", "gateway.example.com", "172.32.0.1", "100.128.0.1"]) expect(isPrivateHost(h)).toBe(false);
  });

  it("refuses to send a token over plain http to a public host", () => {
    expect(() => remoteConnection({ endpoint: "http://gw.example.com", token: "t", sessionId: "s" })).toThrow(/plain HTTP/);
    expect(remoteConnection({ endpoint: "http://100.64.0.2:4700", token: "t", sessionId: "s" }).baseUrl).toBe("http://100.64.0.2:4700");
    expect(remoteConnection({ endpoint: "https://gw.example.com/v1/agent-device/", token: "t", sessionId: "s" }).baseUrl).toBe("https://gw.example.com");
  });

  it("needs a token for a remote endpoint", () => {
    expect(() => remoteConnection({ endpoint: "https://gw.example.com", token: undefined, sessionId: "s" })).toThrow(TapdanceError);
  });

  it("gives each session its own stable agent-device client id", () => {
    const a = remoteConnection({ endpoint: "https://gw.example.com", token: "t", sessionId: "s1" });
    const b = remoteConnection({ endpoint: "https://gw.example.com", token: "t", sessionId: "s2" });
    expect(a.clientId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.clientId).not.toBe(b.clientId);
  });

  it("reads Simlock's local agent-device profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "td-profile-"));
    const file = join(dir, "agent-device-profile.json");
    await writeFile(file, JSON.stringify({ daemonBaseUrl: "http://127.0.0.1:4701/v1/agent-device", daemonAuthToken: "slk_x", tenant: "local", runId: "simlock-local", clientId: "a51a51a51a51a51a" }));
    const c = await readLocalProfile(file);
    expect(c).toMatchObject({ kind: "local", baseUrl: "http://127.0.0.1:4701", tenant: "local", runId: "simlock-local" });
    await expect(readLocalProfile(join(dir, "missing.json"))).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", hint: expect.stringMatching(/tapdance worker start/) });
  });
});

describe("targets and elements", () => {
  it("builds agent-device selectors with escaping", () => {
    expect(toAgentDeviceTarget({ kind: "text", text: 'Say "hi"' })).toEqual({ selector: 'label="Say \\"hi\\"" || text="Say \\"hi\\"" || value="Say \\"hi\\""' });
    expect(toAgentDeviceTarget({ kind: "ref", ref: "e7" })).toEqual({ ref: "@e7" });
    expect(toAgentDeviceTarget({ kind: "id", id: "login" })).toEqual({ selector: 'id="login"' });
    expect(toAgentDeviceTarget({ kind: "point", x: 10.4, y: 20.6 })).toEqual({ x: 10, y: 21 });
  });

  it("maps snapshot nodes to compact elements", () => {
    const el = toUiElement({ ref: "e3", type: "SearchField", kind: "search", label: "Search", value: "Search", placeholder: "Search", rect: { x: 16, y: 150.6, width: 361, height: 36 }, depth: 2, editable: true, enabled: true });
    expect(el).toEqual({ ref: "@e3", role: "search", label: "Search", editable: true, rect: { x: 16, y: 151, width: 361, height: 36 }, depth: 2 });
  });

  it("summarizes settle diffs with additions first and a cap", () => {
    const diff = [{ kind: "removed", text: "@e1 [cell] \"A\"" }, { kind: "added", text: "@e2 [text-field] \"Email\"" }];
    expect(summarizeDiff(diff)).toEqual(['+ @e2 [text-field] "Email"', '- @e1 [cell] "A"']);
    const big = Array.from({ length: 50 }, (_, i) => ({ kind: "added", text: `@e${i}` }));
    expect(summarizeDiff(big)).toHaveLength(31);
  });
});

describe("action results", () => {
  it("says when the action replaced the screen", () => {
    const r = actionResult({ settle: { settled: true, surfaceChange: { from: "com.example.app", to: "com.apple.SafariViewService", disclosure: "A web sheet opened." } } }, "Tapped");
    expect(r).toMatchObject({ ok: true, message: "Tapped", screenChanged: true, hint: expect.stringMatching(/inspect_screen/) });
    expect(r.changes).toBeUndefined();
    expect(r.warning).toContain("A web sheet opened.");
  });

  it("reports how a target was resolved, with alternatives", () => {
    expect(actionResult({ resolution: { source: "ref", phase: "pre-action", kind: "label-fallback" } }, "Tapped")).toMatchObject({ resolvedBy: "label-fallback", warning: expect.stringMatching(/stale/) });
    const r = actionResult(
      { resolution: { source: "runtime", phase: "pre-action", kind: "disambiguated", matchCount: 3, alternatives: [{ diagnosticRef: "d1", label: "Next" }, { diagnosticRef: "d2", role: "button" }] } },
      "Tapped",
    );
    expect(r).toMatchObject({ resolvedBy: "disambiguated", alternatives: ["Next", "button"] });
    expect(actionResult({ resolution: { source: "ref", phase: "pre-action", kind: "exact" } }, "Tapped").resolvedBy).toBeUndefined();
  });

  it("keeps the diff, passes warnings and hints through, and lists what is still on screen", () => {
    const r = actionResult(
      {
        warning: "Keyboard covers the field",
        hint: "Dismiss the keyboard",
        settle: { diff: { lines: [{ kind: "removed", text: "@e4 [alert] \"Saved\"" }] }, tail: [{ ref: "e9", role: "button", label: "Done" }, { ref: "e10", role: "cell" }] },
      },
      "Tapped",
    );
    expect(r.changes).toEqual(['- @e4 [alert] "Saved"']);
    expect(r.stillOnScreen).toEqual(['@e9 [button] "Done"', "@e10 [cell]"]);
    expect(r.warning).toContain("Keyboard covers the field");
    expect(r.hint).toBe("Dismiss the keyboard");
  });

  it("flags a fill that could not be confirmed", () => {
    const r = actionResult({ text: "a@b.co", verification: "unconfirmed", requested: "a@b.co", before: "", after: "ab.co", target: {} }, "Filled");
    expect(r).toMatchObject({ typed: "unconfirmed", fieldNow: "ab.co", warning: expect.stringMatching(/ab\.co/) });
    expect(actionResult({ text: "x" }, "Filled").typed).toBeUndefined();
  });
});

describe("installed app ids", () => {
  it("reads the bundle id from a simulator app's XML Info.plist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "td-plist-"));
    const app = join(dir, "Demo.app");
    await mkdir(app);
    await writeFile(
      join(app, "Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleName</key><string>Demo</string>\n<key>CFBundleIdentifier</key>\n\t<string>com.example.Demo</string>\n</dict></plist>\n',
    );
    expect(await bundleIdOf(app)).toBe("com.example.Demo");
    expect(await bundleIdOf(join(dir, "Missing.app"))).toBeUndefined();
  });

  it("falls back to the plist when the backend returns no id (MOCKED agent-device client)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "td-install-"));
    const app = join(dir, "Demo.app");
    await mkdir(app);
    await writeFile(join(app, "Info.plist"), "<plist><dict><key>CFBundleIdentifier</key><string>com.example.Demo</string></dict></plist>");
    const { SimlockProvider } = await import("./provider.js");
    const provider = new SimlockProvider({ kind: "local", baseUrl: "http://127.0.0.1:1", token: "t", tenant: "local", runId: "r", clientId: "c", source: "test" });
    // MOCKED: the agent-device client is replaced by a stub whose install answers without any id.
    (provider as unknown as { clients: Map<string, unknown> }).clients.set("td-x", { apps: { install: async () => ({ app: app, appPath: app, platform: "ios", identifiers: {} }) } });
    const handle = {
      provider: "simlock",
      leaseId: "l1",
      sessionId: "s",
      platform: "ios" as const,
      model: "iPhone 16",
      osVersion: "18.5",
      physical: false,
      deviceId: "6F1D2A8C-3B4E-4F7A-9C2D-8E5B1A7F3C90",
      location: { kind: "local" as const, endpoint: "http://127.0.0.1:1" },
      ttlMs: 60_000,
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      providerData: { baseUrl: "http://127.0.0.1:1", agentDeviceSession: "td-x", deviceKey: "ios:local:x", tenant: "local", runId: "r", clientId: "c" },
    };
    expect(await provider.installApp(handle, app)).toMatchObject({ appId: "com.example.Demo", platform: "ios" });
    // MOCKED: a snapshot with a ref generation; refs come back pinned to it.
    (provider as unknown as { clients: Map<string, unknown> }).clients.set("td-x", {
      capture: { snapshot: async () => ({ nodes: [{ ref: "e7", type: "Button", label: "Next" }], refsGeneration: 4, warnings: ["sparse tree"] }) },
    });
    const screen = await provider.inspect(handle);
    expect(screen.elements[0]?.ref).toBe("@e7~s4");
    expect(screen.warnings).toEqual(["sparse tree"]);
    expect(toAgentDeviceTarget({ kind: "ref", ref: "e7~s4" })).toEqual({ ref: "@e7~s4" });
  });
});

describe("app paths", () => {
  it("accepts an apk for android and refuses the wrong kind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "td-app-"));
    await writeFile(join(dir, "app-debug.apk"), "x");
    await writeFile(join(dir, "app.aab"), "x");
    await writeFile(join(dir, "App.ipa"), "x");
    await mkdir(join(dir, "App.app"));
    expect(validateAppPath(join(dir, "app-debug.apk"), "android", false)).toBe(join(dir, "app-debug.apk"));
    expect(() => validateAppPath(join(dir, "app.aab"), "android", false)).toThrow(/bundles/);
    expect(() => validateAppPath(join(dir, "nope.apk"), "android", false)).toThrow(/No file/);
    expect(() => validateAppPath(join(dir, "App.ipa"), "ios", false)).toThrow(/simulator \.app/);
    expect(validateAppPath(join(dir, "App.app"), "ios", false)).toBe(join(dir, "App.app"));
    expect(() => validateAppPath(join(dir, "app-debug.apk"), "ios", false)).toThrow(/not an iOS/);
  });
});

describe("stream framing", () => {
  it("splits whole frames and keeps the partial tail", () => {
    const a = encodeFrame(0x05, new TextEncoder().encode('{"codec":"h264"}'));
    const b = encodeFrame(0x02, new Uint8Array([1, 2, 3]));
    const joined = new Uint8Array([...a, ...b.subarray(0, 4)]);
    const { frames, rest } = decodeFrames(joined);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.tag).toBe(0x05);
    expect(rest).toHaveLength(4);
  });
});

describe("error mapping", () => {
  it("recognises lease loss, auth and reachability", () => {
    expect(fromAgentDeviceError({ code: "UNAUTHORIZED", message: "Lease is not active" }, "x").code).toBe("LEASE_LOST");
    expect(fromAgentDeviceError({ message: "lease ended by simlock; run disconnect, then open" }, "x").code).toBe("LEASE_LOST");
    expect(fromAgentDeviceError({ message: "fetch failed: ECONNREFUSED" }, "x").code).toBe("PROVIDER_UNREACHABLE");
    const stale = fromAgentDeviceError(
      {
        message: 'android device emulator-5588 is owned by session "tok_x:td-y" in workspace "/".',
        details: { hint: "The recorded owner can no longer release this device; settle its resources and release the claim with: agent-device device release --platform android --serial emulator-5588 --stale" },
      },
      "open device session",
    );
    expect(stale.code).toBe("DEVICE_UNAVAILABLE");
    expect(stale.retryable).toBe(true);
    expect(stale.hint).toContain("tapdance worker cleanup");
    expect(stale.hint).not.toContain("agent-device device release");
    expect(stale.details?.["reason"]).toBe("STALE_DEVICE_CLAIM");
    // A live owner is a real conflict, not a stale claim.
    expect(fromAgentDeviceError({ code: "DEVICE_IN_USE", message: 'android device emulator-5588 is owned by session "a" in workspace "/".' }, "x").details?.["reason"]).toBeUndefined();
    expect(fromAgentDeviceError({ code: "TEXT_INPUT_NOT_FOCUSED", message: "No focused text input" }, "x").code).toBe("ELEMENT_NOT_FOUND");
    expect(fromAgentDeviceError({ message: "refused: lease abc is not one of yours on this gateway" }, "x").code).toBe("FORBIDDEN");
  });

  it.each(Object.entries(CODE_MAP))("maps backend code %s to %s", (backendCode, expected) => {
    const mapped = fromAgentDeviceError({ code: backendCode, message: "something went wrong" }, "x");
    expect(mapped.code).toBe(expected);
    expect(mapped.details).toMatchObject({ backendCode });
  });

  it("treats a worker the gateway lost as offline, not as a missing capability", () => {
    const mapped = fromAgentDeviceError(
      {
        code: "COMMAND_FAILED",
        message: "agent-device is not available on this simlock: the worker holding this device is not connected to the gateway; try again",
        details: { reason: "WORKER_UNREACHABLE" },
      },
      "tap",
    );
    expect(mapped.code).toBe("WORKER_OFFLINE");
    expect(mapped.retryable).toBe(true);
    expect(mapped.hint).toMatch(/do not release the device/);
    expect(fromAgentDeviceError({ code: "COMMAND_FAILED", message: "x", details: { reason: "WORKER_UNREACHABLE" } }, "x").code).toBe("WORKER_OFFLINE");
    expect(fromAgentDeviceError({ code: "COMMAND_FAILED", message: "agent-device is not available on this simlock: disabled" }, "x").code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("tells a bad token, a foreign lease and a lost lease apart", () => {
    expect(fromAgentDeviceError({ code: "UNAUTHORIZED", message: "Invalid proxy token" }, "x").code).toBe("AUTH_FAILED");
    expect(fromAgentDeviceError({ code: "UNAUTHORIZED", message: "lease ended by simlock; run disconnect, then open", details: { reason: "LEASE_ENDED_BY_HOST" } }, "x").code).toBe("LEASE_LOST");
    expect(fromAgentDeviceError({ code: "UNAUTHORIZED", message: "nope", details: { reason: "LEASE_ENDED_BY_HOST" } }, "x").code).toBe("LEASE_LOST");
    expect(fromAgentDeviceError({ code: "UNAUTHORIZED", message: "nope", details: { reason: "LEASE_NOT_FOUND" } }, "x").code).toBe("LEASE_LOST");
    expect(fromAgentDeviceError({ code: "UNAUTHORIZED", message: "nope", details: { reason: "LEASE_SCOPE_MISMATCH" } }, "x").code).toBe("FORBIDDEN");
    expect(fromAgentDeviceError({ code: "UNAUTHORIZED", message: "lease is outside this tenant" }, "x").code).toBe("FORBIDDEN");
    expect(fromAgentDeviceError({ code: "UNAUTHORIZED", message: "who are you" }, "x").code).toBe("AUTH_FAILED");
  });

  it("classifies Simlock's allocate refusals", () => {
    const busy = fromAgentDeviceError({ code: "INVALID_ARGS", message: "refused by simlock: no capacity for android" }, "lease");
    expect(busy.code).toBe("NO_CAPACITY");
    expect(busy.retryable).toBe(true);
    expect(busy.hint).toMatch(/list_devices/);
    expect(fromAgentDeviceError({ code: "INVALID_ARGS", message: "refused by simlock: No worker in the fleet can currently serve this request" }, "lease").code).toBe("NO_CAPACITY");
    const unknown = fromAgentDeviceError({ code: "INVALID_ARGS", message: "refused by simlock: unknown model \"Pixel 99\"" }, "lease");
    expect(unknown).toMatchObject({ code: "DEVICE_UNAVAILABLE", hint: expect.stringMatching(/list_devices/) });
    expect(fromAgentDeviceError({ code: "INVALID_ARGS", message: "refused by simlock: image tags are Android only" }, "lease").code).toBe("USAGE");
  });

  it("keeps an app that is not installed apart from a missing element", () => {
    const mapped = fromAgentDeviceError({ code: "APP_NOT_INSTALLED", message: "Application com.x not found" }, "launch com.x");
    expect(mapped.code).not.toBe("ELEMENT_NOT_FOUND");
    expect(mapped.code).toBe("APP_NOT_INSTALLED");
    expect(mapped.hint).toMatch(/install_app/);
  });

  it("marks a busy device retryable and a stale ref as needing a fresh inspect", () => {
    expect(fromAgentDeviceError({ code: "DEVICE_IN_USE", message: "busy" }, "x")).toMatchObject({ code: "DEVICE_UNAVAILABLE", retryable: true });
    const stale = fromAgentDeviceError({ code: "COMMAND_FAILED", message: "Ref @e7 was minted from a superseded snapshot generation", details: { reason: "ref_generation_mismatch" } }, "tap @e7~s3");
    expect(stale).toMatchObject({ code: "ELEMENT_NOT_FOUND", hint: expect.stringMatching(/inspect again/) });
    expect(fromAgentDeviceError({ code: "ref_generation_mismatch", message: "stale" }, "x").code).toBe("ELEMENT_NOT_FOUND");
  });

  it("keeps the backend's hint next to Tapdance's own", () => {
    const mapped = fromAgentDeviceError({ code: "ELEMENT_NOT_FOUND", message: "no element", details: { hint: "Try scrolling first." } }, "tap");
    expect(mapped.hint).toContain("inspect_screen");
    expect(mapped.hint).toContain("Try scrolling first.");
    expect(fromAgentDeviceError({ code: "ELEMENT_NOT_FOUND", message: "no element", details: { hint: "run --help for usage" } }, "tap").hint).not.toMatch(/--help/);
  });

  it("lists a few candidates for an ambiguous selector", () => {
    const candidates = Array.from({ length: 8 }, (_, i) => `@e${i} [button] "Next ${i}"`);
    const mapped = fromAgentDeviceError({ code: "AMBIGUOUS_MATCH", message: "find matched 8 elements", details: { matches: 8, candidates } }, "tap");
    expect(mapped.details?.["candidates"]).toEqual(candidates.slice(0, 5));
    const fromObjects = fromAgentDeviceError({ code: "AMBIGUOUS_MATCH", message: "x", details: { matches: [{ ref: "e1", node: { label: "OK" } }, { label: "Cancel" }] } }, "tap");
    expect(fromObjects.details?.["candidates"]).toEqual(["OK", "Cancel"]);
  });
});

describe("Simlock HTTP client", () => {
  const fake = (routes: Record<string, () => Response>): typeof fetch =>
    (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const route = routes[path];
      return route ? route() : new Response("{}", { status: 404 });
    }) as typeof fetch;

  it("returns undefined for an ended lease and maps error codes", async () => {
    const http = new SimlockHttp("http://x", "t", fake({
      "/v1/leases/gone": () => new Response(JSON.stringify({ error: { code: "UNKNOWN_LEASE", message: "gone" } }), { status: 404 }),
      "/v1/status": () => new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "no" } }), { status: 401 }),
      "/v1/workers": () => new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "admin only" } }), { status: 403 }),
    }));
    expect(await http.lease("gone")).toBeUndefined();
    await expect(http.status()).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(http.workers("t")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("gives an offline worker and a refused pass-through actionable hints", async () => {
    const http = new SimlockHttp("http://x", "t", fake({
      "/v1/leases/l1": () => new Response(JSON.stringify({ error: { code: "WORKER_UNREACHABLE", message: "worker offline" } }), { status: 503 }),
      "/v1/status": () => new Response(JSON.stringify({ error: { code: "PASSTHROUGH_REFUSED", message: "no" } }), { status: 422 }),
      "/v1/catalog": () => new Response(JSON.stringify({ error: { code: "UNKNOWN_PASSTHROUGH_TOOL", message: "xcodebuild" } }), { status: 422 }),
    }));
    const offline = await http.lease("l1").catch((e: unknown) => e as TapdanceError);
    expect(offline).toMatchObject({ code: "WORKER_OFFLINE", retryable: true });
    expect((offline as TapdanceError).hint).toBe(fromAgentDeviceError({ code: "COMMAND_FAILED", message: "x", details: { reason: "WORKER_UNREACHABLE" } }, "x").hint);
    await expect(http.status()).rejects.toMatchObject({ code: "FORBIDDEN", hint: expect.stringMatching(/accept-gateway-exec/) });
    await expect(http.catalog()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("reads Simlock 0.4's string runtimes and drops models no image can boot", async () => {
    const { SimlockProvider } = await import("./provider.js");
    const catalog = {
      platforms: [
        { platform: "android", models: ["Pixel 8", "Pixel 9"], runtimes: ["31", "34"], defaultRuntime: "34", modelRuntimes: { "Pixel 8": ["34"], "Pixel 9": [] } },
      ],
    };
    const provider = new SimlockProvider(
      { kind: "local", baseUrl: "http://x", token: "t", tenant: "local", runId: "r", clientId: "c", source: "test" },
      {},
      fake({
        "/v1/catalog": () => new Response(JSON.stringify(catalog)),
        "/v1/status": () => new Response(JSON.stringify({ leases: [], devices: [], queue: [] })),
      }),
    );
    const inventory = await provider.inventory();
    expect(inventory.catalog[0]).toMatchObject({ platform: "android", models: ["Pixel 8"], osVersions: ["31", "34"], defaultOsVersion: "34" });
  });

  it("reports an unreachable endpoint with a fix", async () => {
    const http = new SimlockHttp("http://127.0.0.1:1", "t", (async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    }) as typeof fetch);
    await expect(http.identity()).rejects.toMatchObject({ code: "PROVIDER_UNREACHABLE" });
  });
});

describe("AXe backend", () => {
  it("flattens AXe's tree into refs with centers", async () => {
    const { flattenAxe } = await import("./axe.js");
    const flat = flattenAxe([
      { type: "Application", AXLabel: "Demo", frame: { x: 0, y: 0, width: 390, height: 844 }, children: [{ type: "Button", AXLabel: "Sign in", AXUniqueId: "login", frame: { x: 20, y: 700, width: 350, height: 50 } }] },
    ]);
    expect(flat).toHaveLength(2);
    expect(flat[1]).toMatchObject({ ref: "@a2", role: "button", label: "Sign in", identifier: "login", center: { x: 195, y: 725 }, depth: 1 });
  });

  it("finds a SwiftUI text field by its placeholder and prefers interactive elements", async () => {
    const { flattenAxe, matchText } = await import("./axe.js");
    const flat = flattenAxe([
      {
        type: "Application",
        AXLabel: "Demo",
        frame: { x: 0, y: 0, width: 390, height: 844 },
        children: [
          { type: "StaticText", AXLabel: "Email", frame: { x: 20, y: 100, width: 100, height: 20 } },
          { type: "TextField", AXLabel: null, AXPlaceholderValue: "Email", AXUniqueId: "email", frame: { x: 20, y: 130, width: 350, height: 40 } },
          { type: "Button", AXLabel: "Sign in", frame: { x: 20, y: 700, width: 350, height: 50 } },
        ],
      },
    ]);
    expect(matchText(flat, "Email")).toMatchObject({ role: "textfield", identifier: "email", center: { x: 195, y: 150 } });
    expect(matchText(flat, "sign in")).toMatchObject({ role: "button" });
    expect(matchText(flat, "Nope")).toBeUndefined();
  });

  it("retries describe-ui while a just-launched app's tree is not ready", async () => {
    const { mkdtemp, writeFile, chmod } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { AxeBackend } = await import("./axe.js");
    const dir = await mkdtemp(join(tmpdir(), "td-axe-"));
    const bin = join(dir, "axe");
    // Fails twice with AXe's not-ready error, then prints a tree.
    await writeFile(bin, `#!/bin/sh\nn=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"\nif [ $n -lt 3 ]; then echo "Error: No translation object returned for simulator" >&2; exit 1; fi\necho '[{"type":"Application","AXLabel":"Demo"}]'\n`);
    await chmod(bin, 0o755);
    const flat = await new AxeBackend(bin).describe("6F1D2A8C-3B4E-4F7A-9C2D-8E5B1A7F3C90", 5_000);
    expect(flat[0]).toMatchObject({ label: "Demo" });
  });

  it("refuses anything but a simulator UDID", async () => {
    const { AxeBackend } = await import("./axe.js");
    await expect(new AxeBackend("axe").describe("emulator-5554")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(new AxeBackend("axe").describe("--udid")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("explains a missing AXe install", async () => {
    const { AxeBackend } = await import("./axe.js");
    await expect(new AxeBackend("/nonexistent/axe").describe("6F1D2A8C-3B4E-4F7A-9C2D-8E5B1A7F3C90")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("Android notifications", () => {
  it("reads posted notifications from dumpsys", async () => {
    const { parseNotifications } = await import("./device-operations.js");
    const dump = [
      "Current Notification Manager state:",
      "  NotificationRecord(0x0a1: pkg=com.android.shell user=UserHandle{0} id=2020 tag=tapdance importance=3 key=0|com.android.shell|2020|tapdance|2000: Notification(channel=tapdance))",
      "    uid=2000 userId=0",
      "    when=1793580000000",
      "      android.title=String (Order shipped)",
      "      android.text=String (Your parcel is on its way)",
      "  NotificationRecord(0x0b2: pkg=dev.tapdance.demo user=UserHandle{0} id=1 tag=null importance=4 key=0|dev.tapdance.demo|1|null|10190: Notification(channel=reminders))",
      "      android.title=SpannableString (Practice time)",
    ].join("\n");
    const list = parseNotifications(dump);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ package: "com.android.shell", title: "Order shipped", text: "Your parcel is on its way", key: "0|com.android.shell|2020|tapdance|2000" });
    expect(list[0]!.postedAt).toBe(new Date(1793580000000).toISOString());
    expect(list[1]).toMatchObject({ package: "dev.tapdance.demo", title: "Practice time" });
  });
});

describe("ui wait --stable and element states (#26, #28)", () => {
  const handle = { provider: "simlock", leaseId: "l1", sessionId: "s", platform: "android", model: "Pixel 7", osVersion: "34", physical: false, deviceId: "emulator-5554", location: { kind: "local", endpoint: "x" }, ttlMs: 60_000, createdAt: "", expiresAt: "", providerData: {} } as const;

  async function providerWithScreens(screens: Array<Array<{ role: string; label?: string; rect?: { x: number; y: number; width: number; height: number } }>>) {
    const { SimlockProvider } = await import("./provider.js");
    const p = new SimlockProvider({ kind: "local", baseUrl: "http://127.0.0.1:1", token: "t", tenant: "local", runId: "r", clientId: "c", source: "test" });
    let i = 0;
    // MOCKED: inspect returns a scripted sequence of screens.
    (p as unknown as { inspect: () => Promise<unknown> }).inspect = async () => ({ elements: screens[Math.min(i++, screens.length - 1)]!.map((e, n) => ({ ref: `@e${n}`, ...e })), truncated: false, warnings: [] });
    return p;
  }

  it("is stable once the content stops changing, even while things move", async () => {
    const moving = (x: number) => [{ role: "image", rect: { x, y: 0, width: 10, height: 10 } }, { role: "text", label: "Question 2" }];
    const p = await providerWithScreens([[{ role: "text", label: "Question 1" }], moving(0), moving(5), moving(10), moving(15), moving(20), moving(25)]);
    const r = await p.waitFor(handle as never, { kind: "stable" }, 5000);
    expect(r.found).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(1000);
  });

  it("says the UI is still changing on timeout, instead of 'not found'", async () => {
    const screens = Array.from({ length: 40 }, (_, n) => [{ role: "text", label: `Tick ${n}` }]);
    const p = await providerWithScreens(screens);
    const r = await p.waitFor(handle as never, { kind: "stable" }, 1200);
    expect(r.found).toBe(false);
    expect(r.hint).toMatch(/still changing/);
  });

  it("keeps checked, selected and focused states from the backend", async () => {
    expect(toUiElement({ ref: "e5", kind: "radiobutton", label: "Yes", checked: true }).states).toEqual(["checked"]);
    expect(toUiElement({ ref: "e6", kind: "radiobutton", label: "No", checked: false, focused: true }).states).toEqual(["unchecked", "focused"]);
    expect(toUiElement({ ref: "e7", kind: "tab", label: "Home", selected: true }).states).toEqual(["selected"]);
    expect(toUiElement({ ref: "e8", kind: "text", label: "Hi" }).states).toBeUndefined();
  });

  it("folds unlabelled containers in the compact view", async () => {
    const { compactElements } = await import("@tapdance/core");
    const els = [
      { ref: "@e1", role: "group" },
      { ref: "@e2", role: "group", label: "Answers" },
      { ref: "@e3", role: "radiobutton", states: ["checked"] },
      { ref: "@e4", role: "text", label: "It was too much at once" },
    ];
    expect(compactElements(els).map((e) => e.ref)).toEqual(["@e2", "@e3", "@e4"]);
  });
});

describe("doctor reachability", () => {
  it("names the https address when the guard answers an http request with its TLS error", () => {
    const r = describeBadHealth("http://mac.tail.ts.net:4720", { status: 400, body: "Client sent an HTTP request to an HTTPS server.", ms: 20 }, "x");
    expect(r.detail).toContain("serves HTTPS now");
    expect(r.fix).toContain("tapdance connect https://mac.tail.ts.net:4720");
  });
  it("retries a slow first healthz before calling the endpoint unreachable", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new Error("The operation was aborted due to timeout");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new SimlockProvider({ kind: "remote", baseUrl: "https://mac.tail.ts.net:4720", token: "t", tenant: "x", runId: "r", clientId: "c" } as never, {}, fetchImpl);
    const checks = await provider.doctor();
    expect(checks.find((c) => c.id === "simlock.reachable")?.status).toBe("pass");
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("raw taps (#34)", () => {
  it("reads the focused app from dumpsys window", () => {
    const dump = "  mCurrentFocus=Window{a1b2c3 u0 com.google.android.documentsui/com.android.documentsui.picker.PickActivity}\n  mFocusedApp=…";
    expect(focusedPackage(dump)).toBe("com.google.android.documentsui");
    expect(RAW_INPUT_APPS.has(focusedPackage(dump)!)).toBe(true);
    expect(focusedPackage("mCurrentFocus=null")).toBeUndefined();
  });
  it("matches elements by ref, id, exact text and simple selectors", () => {
    const el = { ref: "@e7", role: "button", label: "tones.mp3", identifier: "item_title" };
    expect(matchesTarget(el, { kind: "ref", ref: "e7" })).toBe(true);
    expect(matchesTarget(el, { kind: "id", id: "item_title" })).toBe(true);
    expect(matchesTarget(el, { kind: "text", text: "tones.mp3" })).toBe(true);
    expect(matchesTarget(el, { kind: "selector", selector: 'label="tones.mp3"' })).toBe(true);
    expect(matchesTarget(el, { kind: "text", text: "tones" })).toBe(false);
  });
});

describe("platform on offer (#39)", () => {
  it("fails the Android check when the worker has room for it but offers no Android device", async () => {
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname;
      const body =
        path === "/v1/healthz"
          ? { ok: true }
          : path === "/v1/identity"
            ? { principal: "p", role: "agent" }
            : path === "/v1/status"
              ? { leases: [], devices: [], capacity: { android: { limit: 2, running: 0 }, ios: { limit: 5, running: 0 } } }
              : path === "/v1/catalog"
                ? { platforms: [{ platform: "ios", models: ["iPhone 17"], runtimes: ["26.5"] }] }
                : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const provider = new SimlockProvider({ kind: "remote", baseUrl: "https://mac.tail.ts.net:4720", token: "t", tenant: "x", runId: "r", clientId: "c" } as never, {}, fetchImpl);
    const checks = await provider.doctor();
    const android = checks.find((c) => c.id === "simlock.capacity.android");
    expect(android?.status).toBe("fail");
    expect(android?.fix).toContain("tapdance worker restart");
    expect(checks.find((c) => c.id === "simlock.capacity.ios")?.status).toBe("pass");
    const inventory = await provider.inventory();
    expect(inventory.notes.some((n) => n.startsWith("android is not available"))).toBe(true);
  });
});

describe("kill-app (#43)", () => {
  const handle = { provider: "simlock", leaseId: "l", sessionId: "s", platform: "android", deviceId: "emulator-5554" } as never;
  it("goes Home, uses am stop-app, and confirms the pid is gone", async () => {
    const { runDeviceOperation } = await import("./device-operations.js");
    const calls: string[] = [];
    let alive = true;
    const exec = async (cmd: { args: string[] }) => {
      calls.push(cmd.args.slice(1).join(" "));
      if (cmd.args[1] === "pidof") return { exitCode: alive ? 0 : 1, stdout: alive ? "4242\n" : "", stderr: "" };
      if (cmd.args[2] === "stop-app") alive = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = await runDeviceOperation({ client: {} as never, scope: {}, exec: exec as never, local: true }, handle, { kind: "kill-app", appId: "com.example.app" });
    expect(r).toMatchObject({ ok: true, data: { method: "am stop-app", pidBefore: "4242" } });
    expect(calls).toEqual(["pidof com.example.app", "input keyevent 3", "am stop-app com.example.app", "pidof com.example.app"]);
  });
  it("falls back to trim + kill on older Android and reports a process that survives", async () => {
    const { runDeviceOperation } = await import("./device-operations.js");
    const exec = async (cmd: { args: string[] }) => {
      if (cmd.args[1] === "pidof") return { exitCode: 0, stdout: "4242\n", stderr: "" };
      if (cmd.args[2] === "stop-app") return { exitCode: 255, stdout: "Unknown command: stop-app", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = await runDeviceOperation({ client: {} as never, scope: {}, exec: exec as never, local: true }, handle, { kind: "kill-app", appId: "com.example.app" });
    expect(r).toMatchObject({ ok: false, data: { method: "am send-trim-memory + am kill", pidAfter: "4242" } });
  }, 10_000);
});

describe("system inspect (#44)", () => {
  it("reads every window from uiautomator, with bounds, states and a Custom Tab's URL", async () => {
    const { parseUiautomator } = await import("./provider.js");
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="com.android.chrome:id/url_bar" class="android.widget.TextView" package="com.android.chrome" content-desc="pianolune.com/terms" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" selected="false" bounds="[160,120][900,200]" />
<node index="1" text="Accept &amp; continue" resource-id="" class="android.widget.Button" package="com.android.chrome" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" bounds="[100,2000][980,2120]" />
<node index="2" text="" resource-id="" class="android.widget.FrameLayout" package="com.measify.pianolune" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
<node index="3" text="Reminders" resource-id="com.measify.pianolune:id/toggle" class="android.widget.Switch" package="com.measify.pianolune" checkable="true" checked="true" clickable="true" bounds="[0,300][1080,400]" /></hierarchy>
UI hierchary dumped to: /dev/tty`;
    const s = parseUiautomator(xml, true);
    expect(s.elements.map((e) => e.label)).toEqual(["pianolune.com/terms", "Accept & continue", "Reminders"]);
    expect(s.elements[1]!.rect).toEqual({ x: 100, y: 2000, width: 880, height: 120 });
    expect(s.elements[2]!.states).toEqual(["checked"]);
    expect(s.warnings).toContain("browser: pianolune.com/terms");
    expect(s.app).toBe("com.android.chrome, com.measify.pianolune");
    expect(parseUiautomator(xml, false).elements).toHaveLength(4);
  });
});

describe("tap sequence (#42)", () => {
  it("builds one device script from whole numbers only, in time order", async () => {
    const { android } = await import("./device-commands.js");
    const cmd = android.tapSequence([{ t: 0, x: 120, y: 900 }, { t: 480, x: 240, y: 900, hold: 200 }]);
    expect(cmd.args[0]).toBe("shell");
    expect(cmd.args[1]).toContain("input tap 120 900 &");
    expect(cmd.args[1]).toContain("input swipe 240 900 240 900 200 &");
    expect(cmd.args[1]).toContain("+ 480000000 -");
    expect(() => android.tapSequence([{ t: 100, x: 1, y: 1 }, { t: 50, x: 1, y: 1 }])).toThrow(/time order/);
    expect(() => android.tapSequence([{ t: 0, x: "1; reboot" as never, y: 1 }])).toThrow(/whole number/);
    expect(() => android.tapSequence([])).toThrow(/1 to 500/);
  });
  it("reports when each tap started and the drift", async () => {
    const { runDeviceOperation } = await import("./device-operations.js");
    const exec = async () => ({ exitCode: 0, stdout: "0 1200\n1 481500\n", stderr: "" });
    const handle = { provider: "simlock", leaseId: "l", sessionId: "s", platform: "android", deviceId: "e" } as never;
    const r = await runDeviceOperation({ client: {} as never, scope: {}, exec: exec as never, local: true }, handle, { kind: "tap-sequence", steps: [{ t: 0, x: 1, y: 1 }, { t: 480, x: 2, y: 2 }] });
    expect(r.ok).toBe(true);
    expect((r.data as { steps: Array<{ actualMs: number; driftMs: number }> }).steps.map((s) => s.driftMs)).toEqual([1.2, 1.5]);
  });
});
