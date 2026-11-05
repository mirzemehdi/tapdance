import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
import { BACKEND_SYNTAX, CODE_MAP, readerHint } from "./agent-device-errors.js";
import { RAW_INPUT_APPS, SimlockProvider, actionResult, appInFront, bundleIdOf, describeBadHealth, editableFocus, focusedPackage, frontApp, iosAppPredicate, matchesTarget, parseSimctlApps, summarizeDiff, switchKnobPoint, toLogResult, triesNote, withoutFillTargetDoubt } from "./provider.js";
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
    // Microseconds since the start, never nanosecond epochs: Android's shell arithmetic is 32-bit (#42).
    expect(cmd.args[1]).toContain("(480000 - n) / 1000");
    expect(cmd.args[1]).not.toMatch(/%s%N/);
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

describe("iOS gaps (#48-#50)", () => {
  it("parses simctl listapps", async () => {
    const { parseSimctlApps } = await import("./provider.js");
    const plist = `{
    "com.apple.Maps" =     {
        ApplicationType = System;
        CFBundleDisplayName = Maps;
        CFBundleIdentifier = "com.apple.Maps";
    };
    "com.measify.pianolune" =     {
        ApplicationType = User;
        CFBundleDisplayName = Pianolune;
        CFBundleIdentifier = "com.measify.pianolune";
    };
}`;
    expect(parseSimctlApps(plist)).toEqual([
      { bundleId: "com.apple.Maps", name: "Maps", user: false },
      { bundleId: "com.measify.pianolune", name: "Pianolune", user: true },
    ]);
  });
  it("refuses iOS wifi/airplane changes instead of faking them, and reads the status bar time", async () => {
    const { runDeviceOperation } = await import("./device-operations.js");
    const handle = { provider: "simlock", leaseId: "l", sessionId: "s", platform: "ios", deviceId: "U" } as never;
    const exec = async () => ({ exitCode: 0, stdout: "Current Status Bar Overrides:\n  Time: 09:41\n", stderr: "" });
    const ctx = { client: {} as never, scope: {}, exec: exec as never, local: true };
    await expect(runDeviceOperation(ctx, handle, { kind: "setting", change: { name: "airplane", value: "on" } })).rejects.toThrow(/cannot go offline/);
    expect(await runDeviceOperation(ctx, handle, { kind: "setting", change: { name: "status-bar-time" } })).toMatchObject({ data: { time: "09:41" } });
    await expect(runDeviceOperation(ctx, handle, { kind: "uninstall", appId: "com.apple.Maps" })).rejects.toThrow(/system app/);
  });
  it("maps the Home Screen snapshot refusal to a launch hint", () => {
    const e = fromAgentDeviceError({ message: "iOS snapshot requires an active app session for this device. Run open first.", details: { hint: "agent-device open <app>" } }, "inspect");
    expect(e.hint).toMatch(/Home Screen/);
    expect(e.hint).not.toMatch(/agent-device open/);
    // The same hint when the session's app was killed (#50).
    expect(fromAgentDeviceError({ message: "app 'com.measify.pianolune' is not running" }, "inspect").hint).toMatch(/launch it again/);
  });
  it("keeps a lease whose release nobody answered, and accepts an already-ended one", async () => {
    const handle = { provider: "simlock", leaseId: "l", sessionId: "s", platform: "ios", deviceId: "U", providerData: { baseUrl: "http://x", agentDeviceSession: "td-x", deviceKey: "ios:mobile:U", tenant: "local", runId: "r", clientId: "c" } } as never;
    const withClient = (fail: Error) =>
      new (class extends SimlockProvider {
        protected override agentClient() {
          const reject = async () => {
            throw fail;
          };
          return { sessions: { close: reject }, leases: { release: reject } } as never;
        }
      })({ kind: "local", baseUrl: "http://x", token: "t", tenant: "local", runId: "r", clientId: "c", source: "test" });
    // A guard restarting mid-release: agent-device's transport error, not "unreachable" by name.
    expect(await withClient(new Error("Retry command. If this persists, verify the remote daemon URL")).release(handle)).toEqual({ released: false, unreachable: true });
    expect(await withClient(new Error("session not active")).release(handle)).toEqual({ released: false });
  });
  it("passes a guard's refusal of an upload through as its own code and text", () => {
    const e = fromAgentDeviceError({ code: "COMMAND_FAILED", message: 'Upload failed: {"error":{"code":"FORBIDDEN","message":"Refused: this token is limited to interaction, screenshots, and install is not one of them."}}' }, "install");
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toBe("install failed: Refused: this token is limited to interaction, screenshots, and install is not one of them.");
  });
  it("reports a lease whose device the worker forgot (restart mid-lease) as lost, with the fix", () => {
    const e = fromAgentDeviceError({ code: "INVALID_ARGS", message: "refused: simlock picks the device" }, "inspect");
    expect(e.code).toBe("LEASE_LOST");
    expect(e.hint).toMatch(/lease again/);
  });
  it("reads a filled field back and fills it slower when characters were dropped (#58)", async () => {
    const handle = { provider: "simlock", leaseId: "l", sessionId: "s", platform: "ios", deviceId: "U", providerData: { baseUrl: "http://x", agentDeviceSession: "td-x", deviceKey: "ios:mobile:U", tenant: "local", runId: "r", clientId: "c" } } as never;
    const make = (shown: string[]) => {
      const delays: Array<number | undefined> = [];
      const p = new (class extends SimlockProvider {
        protected override agentClient() {
          return { interactions: { fill: async (o: { delayMs?: number }) => (delays.push(o.delayMs), { message: "filled" }) } } as never;
        }
        override async inspect() {
          return { elements: [{ ref: "@e8", role: "text-view", label: "Code", identifier: "settings_code_field", value: shown.shift() ?? "" }], truncated: false, warnings: [] };
        }
      })({ kind: "local", baseUrl: "http://x", token: "t", tenant: "local", runId: "r", clientId: "c", source: "test" });
      return { p, delays };
    };
    const text = "WRONGCODE1 Für Elise 2026";
    const fixed = make(["WRONGCOE1 FDr Elise 026", text]);
    const r = await fixed.p.typeText(handle, text, { kind: "id", id: "settings_code_field" });
    expect(fixed.delays).toEqual([undefined, 80]);
    expect(r.message).toMatch(/with 80 ms between keystrokes/);
    const never = make(["WRONGCOE1", "WRONGCOE1", "WRONGCOE1"]);
    await expect(never.p.typeText(handle, text, { kind: "id", id: "settings_code_field" })).rejects.toThrow(/The field reads "WRONGCOE1"/);
    expect(never.delays).toEqual([undefined, 80, 150]);
    const asked = make(["WRONGCOE1"]);
    await expect(asked.p.typeText(handle, text, { kind: "id", id: "settings_code_field" }, { delayMs: 40 })).rejects.toThrow(/even at 40 ms/);
  });

  // MOCKED agent-device client: a snapshot with or without a focused field, a keyboard status, and a
  // type call that is recorded.
  const androidWith = (nodes: Array<Record<string, unknown>> | Error, appBundleId = "com.measify.pianolune", keyboard: Record<string, unknown> | Error = { visible: false }) => {
    const typed: string[] = [];
    const keyboardCalls: unknown[] = [];
    const p = new (class extends SimlockProvider {
      protected override agentClient() {
        return {
          capture: { snapshot: async () => (nodes instanceof Error ? Promise.reject(nodes) : { nodes, appBundleId }) },
          command: { keyboard: async (o: unknown) => (keyboardCalls.push(o), keyboard instanceof Error ? Promise.reject(keyboard) : { platform: "android", action: "status", ...keyboard }) },
          interactions: { type: async (o: { text: string }) => (typed.push(o.text), {}) },
        } as never;
      }
    })({ kind: "local", baseUrl: "http://x", token: "t", tenant: "local", runId: "r", clientId: "c", source: "test" });
    return { p, typed, keyboardCalls };
  };
  const androidHandle = { provider: "simlock", leaseId: "l", sessionId: "s", platform: "android", deviceId: "emulator-5554", providerData: { baseUrl: "http://x", agentDeviceSession: "td-x", deviceKey: "android:mobile:emulator-5554", tenant: "local", runId: "r", clientId: "c" } } as never;

  it("refuses to type with no target when no field has focus, with a hint to pass one (#72, MOCKED client)", async () => {
    const unfocused = androidWith([
      { ref: "e1", type: "android.widget.EditText", placeholder: "Your code", focused: false, editable: true },
      { ref: "e2", type: "android.widget.Button", label: "Apply", focused: false },
    ]);
    await expect(unfocused.p.typeText(androidHandle, "N2 field")).rejects.toMatchObject({ code: "ELEMENT_NOT_FOUND", hint: expect.stringMatching(/--text.*into_text/) });
    expect(unfocused.typed).toEqual([]);
  });

  it("refuses when the snapshot carries no focus flags at all, as agent-device's Android snapshot does for an unfocused field (#72 reopen, MOCKED client)", async () => {
    // The field run's "Have a code?" sheet: agent-device sets `focused` only when true, so no node has the key.
    const sheet = [
      { ref: "e1", type: "android.widget.TextView", label: "Have a code?" },
      { ref: "e3", type: "android.widget.EditText", editable: true },
      { ref: "e4", type: "android.widget.Button", label: "Apply" },
    ];
    const noFlags = androidWith(sheet);
    await expect(noFlags.p.typeText(androidHandle, "N2 field 2026 Für Elise")).rejects.toMatchObject({ code: "ELEMENT_NOT_FOUND", message: "No text field has focus, so nothing was typed" });
    expect(noFlags.typed).toEqual([]);
    expect(noFlags.keyboardCalls).toEqual([expect.objectContaining({ action: "status" })]);
    // The keyboard status cannot be read: the snapshot's answer stands.
    const noStatus = androidWith(sheet, undefined, new Error("dumpsys timed out"));
    await expect(noStatus.p.typeText(androidHandle, "abc")).rejects.toMatchObject({ code: "ELEMENT_NOT_FOUND" });
    // The keyboard is up: some view takes text that the snapshot did not mark, so typing goes ahead.
    const keyboardUp = androidWith(sheet, undefined, { visible: true, inputOwner: "app" });
    await keyboardUp.p.typeText(androidHandle, "abc");
    expect(keyboardUp.typed).toEqual(["abc"]);
  });

  it("types with no target into the focused field, and when the snapshot cannot tell (#72, MOCKED client)", async () => {
    // After a targeted fill the field shows [focused]: only that node carries the flag.
    const focused = androidWith([{ ref: "e1", type: "android.widget.EditText", focused: true }, { ref: "e2", type: "android.widget.Button" }]);
    expect((await focused.p.typeText(androidHandle, "abc")).message).toMatch(/Typed 3 characters/);
    expect(focused.typed).toEqual(["abc"]);
    expect(focused.keyboardCalls).toEqual([]);
    // No text field on screen (a game canvas, a custom view): it cannot tell, so it types.
    const noField = androidWith([{ ref: "e1", type: "android.view.View", label: "Play" }]);
    await noField.p.typeText(androidHandle, "abc");
    expect(noField.typed).toEqual(["abc"]);
    const failed = androidWith(new Error("snapshot helper busy"));
    await failed.p.typeText(androidHandle, "abc");
    expect(failed.typed).toEqual(["abc"]);
  });

  it("reads focus from snapshot nodes (#72)", () => {
    expect(editableFocus([{ type: "android.widget.EditText", focused: true }])).toBe(true);
    expect(editableFocus([{ type: "android.view.View", focused: true, editable: true }])).toBe(true);
    expect(editableFocus([{ type: "android.widget.EditText", focused: false }])).toBe(false);
    expect(editableFocus([{ type: "android.widget.Button", focused: true, editable: false }])).toBe(false);
    expect(editableFocus([{ type: "android.view.View", focused: true }])).toBeUndefined();
    // The real Android snapshot: no `focused` key unless true (#72 reopen).
    expect(editableFocus([{ type: "android.widget.EditText" }])).toBe(false);
    expect(editableFocus([{ type: "android.view.View", editable: true }, { type: "android.widget.Button" }])).toBe(false);
    expect(editableFocus([{ type: "android.widget.EditText", editable: false }])).toBeUndefined();
    expect(editableFocus([{ type: "android.widget.Button" }])).toBeUndefined();
    expect(editableFocus([])).toBeUndefined();
  });

  it("drops agent-device's TextView doubt once the field reads back the text (#82)", () => {
    const doubt = 'fill target label="Your code" resolved to "android.widget.TextView", attempting fill anyway.';
    expect(withoutFillTargetDoubt({ ok: true, message: "Filled 18 chars", warning: doubt })).toEqual({ ok: true, message: "Filled 18 chars" });
    expect(withoutFillTargetDoubt({ ok: true, message: "m", warning: `${doubt} New screen opened.` }).warning).toBe("New screen opened.");
    expect(withoutFillTargetDoubt({ ok: true, message: "m", warning: "Other" }).warning).toBe("Other");
  });

  it("keeps the TextView doubt when the field cannot be read back, and drops it when it can (#82, MOCKED client)", async () => {
    const doubt = 'fill target label="Your code" resolved to "android.widget.TextView", attempting fill anyway.';
    const make = (value: string | undefined) =>
      new (class extends SimlockProvider {
        protected override agentClient() {
          return { interactions: { fill: async () => ({ message: "Filled 18 chars", warning: doubt }) } } as never;
        }
        override async inspect() {
          const field = value === undefined ? { ref: "@e3", role: "secure-text-field", label: "Your code" } : { ref: "@e3", role: "text-field", label: "Your code", value };
          return { elements: [field], truncated: false, warnings: [] };
        }
      })({ kind: "local", baseUrl: "http://x", token: "t", tenant: "local", runId: "r", clientId: "c", source: "test" });
    const read = await make("MCP into Für Elise").typeText(androidHandle, "MCP into Für Elise", { kind: "text", text: "Your code" });
    expect(read.warning).toBeUndefined();
    const unread = await make(undefined).typeText(androidHandle, "MCP into Für Elise", { kind: "text", text: "Your code" });
    expect(unread.warning).toBe(doubt);
  });

  it("names the timeout that fired when doctor cannot reach Simlock (#82)", () => {
    expect(triesNote("Cannot reach Simlock at https://h:4720: Connect Timeout Error (attempted address: h:4720, timeout: 10000ms)")).toBe("two tries, each gave up connecting after 10 s");
    expect(triesNote("Cannot reach Simlock at https://h:4720: The operation was aborted due to timeout")).toBe("two tries, each given 15 s");
    expect(triesNote("Cannot reach Simlock at http://h:1: connect ECONNREFUSED")).toBe("two tries");
  });

  it("searches a log dump with a filter and says how much matched (#82)", () => {
    const dump = ["--------- beginning of main", "11-03 22:04:01.100  100  100 I ActivityManager: Start proc", "11-03 22:04:02.200  100  100 E ActivityManager: ANR in com.android.systemui", "11-03 22:06:49.643  200  200 D App: tick"].join("\n");
    const anr = toLogResult("logcat", dump, 50, { contains: "anr IN" });
    expect(anr.lines).toEqual(["11-03 22:04:02.200  100  100 E ActivityManager: ANR in com.android.systemui"]);
    expect(anr.source).toBe("logcat, 1 of 4 lines matched (log kept since 22:04:01)");
    expect(anr.filtered).toBe(true);
    expect(toLogResult("logcat", dump, 50, { contains: "ActivityManager", level: "error" }).lines).toHaveLength(1);
    expect(toLogResult("logcat", dump, 1, { contains: "ActivityManager" })).toMatchObject({ truncated: true, lines: [expect.stringContaining("ANR")] });
    expect(toLogResult("logcat", dump, 2)).toMatchObject({ source: "logcat", lines: [expect.stringContaining("ANR"), expect.stringContaining("tick")], truncated: true });
  });

  it("matches log levels by the line's own level, not by \"default\" or an I-level exception frame (#106)", () => {
    const lines = [
      "11-04 21:04:39.730 10549 10549 W NearbyMediums: Failed to retrieve default NfcAdapter, NFC is unsupported.",
      "11-04 21:04:39.814 10549 10601 I NearbyMediums: WifiNetwork defaultNetworkCallback onAvailable netId:100",
      "11-04 21:04:41.164 10549 10652 W herk    : Primes not initialized, returning default (no-op) Primes instance",
      "11-04 21:04:42.000 10549 10549 I NearbyMediums: \tat android.os.Parcel.createExceptionOrNull(Parcel.java:3011)",
      "11-04 21:04:43.000 10549 10549 E App     : request failed",
      "11-04 21:04:44.000 10549 10549 E AndroidRuntime: FATAL EXCEPTION: main",
      "11-04 21:04:45.000   900   900 F libc    : Fatal signal 11 (SIGSEGV)",
      "F/DEBUG   (  900): backtrace:",
      "E/Brief   (  901): brief error",
      "2026-11-04 21:04:46.123 Df MyApp[123:456] using default settings",
      "2026-11-04 21:04:46.124 Df MyApp[123:456] network error: offline",
      "2026-11-04 21:04:46.125 F  MyApp[123:456] assertion",
      "2026-11-04 21:04:46.126 E  MyApp[123:456] something went wrong",
    ];
    const keep = (level: "error" | "fault") => toLogResult("log", lines.join("\n"), 100, { level }).lines;
    expect(keep("fault")).toEqual([lines[5], lines[6], lines[7], lines[11]]);
    expect(keep("error")).toEqual([lines[4], lines[5], lines[6], lines[7], lines[8], lines[10], lines[11], lines[12]]);
  });

  it("names the launcher, not the session's app, when the launcher's elements fill the screen (#73, MOCKED client)", async () => {
    const launcher = androidWith([
      { ref: "e1", type: "android.view.View", identifier: "com.google.android.apps.nexuslauncher:id/workspace" },
      { ref: "e2", type: "android.widget.TextView", label: "Play Store", identifier: "com.google.android.apps.nexuslauncher:id/icon" },
      { ref: "e3", type: "android.widget.TextView", label: "Gmail", bundleId: "com.google.android.apps.nexuslauncher" },
      { ref: "e4", type: "android.view.View", identifier: "com.android.systemui:id/clock" },
    ]);
    const screen = await launcher.p.inspect(androidHandle);
    expect(screen.app).toBe("com.google.android.apps.nexuslauncher");
    expect(screen.warnings[0]).toMatch(/not the session's app com\.measify\.pianolune/);
    const inApp = androidWith([
      { ref: "e1", type: "android.widget.EditText", identifier: "com.measify.pianolune:id/code" },
      { ref: "e2", type: "android.view.View", identifier: "com.android.systemui:id/clock" },
      { ref: "e3", type: "android.view.View", identifier: "com.android.systemui:id/battery" },
    ]);
    const own = await inApp.p.inspect(androidHandle);
    expect(own.app).toBe("com.measify.pianolune");
    expect(own.warnings).toEqual([]);
    // A Compose screen with no ids at all keeps the session's app.
    expect((await androidWith([{ ref: "e1", type: "android.view.View", label: "Play" }]).p.inspect(androidHandle)).app).toBe("com.measify.pianolune");
  });

  it("picks the front app from element packages (#73)", () => {
    expect(frontApp([{ identifier: "com.a.launcher:id/x" }, { identifier: "com.a.launcher:id/y" }, { identifier: "com.b.app:id/z" }], "com.c.session")).toBe("com.a.launcher");
    expect(frontApp([{ identifier: "com.a.launcher:id/x" }, { identifier: "com.c.session:id/z" }], "com.c.session")).toBe("com.c.session");
    expect(frontApp([{ identifier: "android:id/content" }, { bundleId: "com.google.android.inputmethod.latin" }, { identifier: "com.android.systemui:id/clock" }], "com.c.session")).toBe("com.c.session");
    expect(frontApp([], undefined)).toBeUndefined();
  });

  it("retries a rotation the device was slow to confirm, then trusts the screen's shape (#65)", async () => {
    const { runDeviceOperation } = await import("./device-operations.js");
    const handle = { provider: "simlock", leaseId: "l", sessionId: "s", platform: "android", deviceId: "emulator-5554" } as never;
    const slow = { code: "COMMAND_FAILED", message: "orientation landscape-left could not confirm the display rotation: adb timed out after 1ms" };
    let calls = 0;
    const flaky = { command: { orientation: async () => { if (++calls < 3) throw slow; return {}; } }, capture: { snapshot: async () => ({}) } };
    const r = await runDeviceOperation({ client: flaky as never, scope: {}, exec: (async () => ({ exitCode: 0, stdout: "", stderr: "" })) as never, local: true }, handle, { kind: "setting", change: { name: "orientation", value: "landscape" } });
    expect(r.message).toBe("Rotated to landscape-left");
    expect(calls).toBe(3);
    const neverConfirms = { command: { orientation: async () => { throw slow; } }, capture: { snapshot: async () => ({ viewport: { width: 2400, height: 1080 } }) } };
    const turned = await runDeviceOperation({ client: neverConfirms as never, scope: {}, exec: (async () => ({ exitCode: 0, stdout: "", stderr: "" })) as never, local: true }, handle, { kind: "setting", change: { name: "orientation", value: "landscape" } });
    expect(turned.message).toMatch(/slow to confirm; the screen is landscape/);
    // The Pixel launcher never rotates: say so instead of a timeout; a locked app gets the reason.
    const portraitScreen = { command: { orientation: async () => { throw slow; } }, capture: { snapshot: async () => ({ viewport: { width: 1080, height: 2400 } }) } };
    const focused = (pkg: string) => (async () => ({ exitCode: 0, stdout: `  mCurrentFocus=Window{abc u0 ${pkg}/${pkg}.Main}\n`, stderr: "" })) as never;
    const home = await runDeviceOperation({ client: portraitScreen as never, scope: {}, exec: focused("com.google.android.apps.nexuslauncher"), local: true }, handle, { kind: "setting", change: { name: "orientation", value: "landscape" } });
    expect(home.message).toMatch(/Home Screen \(com.google.android.apps.nexuslauncher\) does not rotate/);
    await expect(runDeviceOperation({ client: portraitScreen as never, scope: {}, exec: focused("com.example.portraitonly"), local: true }, handle, { kind: "setting", change: { name: "orientation", value: "landscape" } })).rejects.toThrow(/com.example.portraitonly stays portrait/);
  }, 40_000);
  it("filters iOS logs by the app's executable, without case (#59)", () => {
    const plist = `{\n    "com.measify.pianolune" =     {\n        ApplicationType = User;\n        CFBundleDisplayName = Pianolune;\n        CFBundleExecutable = Pianolune;\n    };\n}`;
    expect(parseSimctlApps(plist)).toEqual([{ bundleId: "com.measify.pianolune", name: "Pianolune", executable: "Pianolune", user: true }]);
    expect(iosAppPredicate("com.measify.pianolune", "Pianolune")).toBe('subsystem BEGINSWITH "com.measify.pianolune" OR process ==[c] "Pianolune"');
    expect(iosAppPredicate("com.measify.pianolune")).toContain('process ==[c] "pianolune"');
    expect(iosAppPredicate("com.x", 'bad"name')).toContain('process ==[c] "x"');
  });
  it("taps an iOS switch row at its toggle, not its label (#58)", () => {
    expect(switchKnobPoint({ x: 0, y: 136, width: 402, height: 48 })).toEqual({ x: 360, y: 160 });
  });
});

describe("iOS on a host that is not a Mac", () => {
  it("is never expected from a Linux worker, and still expected from a Mac or an unknown host", async () => {
    const { iosNeedsMac } = await import("./provider.js");
    expect(iosNeedsMac("ios", "linux")).toBe(true);
    expect(iosNeedsMac("ios", "darwin")).toBe(false);
    expect(iosNeedsMac("ios", "macOS")).toBe(false);
    expect(iosNeedsMac("ios", undefined)).toBe(false);
    expect(iosNeedsMac("android", "linux")).toBe(false);
  });
});

describe("Android install refusals", () => {
  it("says to uninstall when a build is signed with another key (CI debug keys differ per run)", async () => {
    const { androidInstallHint, fromAgentDeviceError } = await import("./agent-device-errors.js");
    const adb = "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.measify.pianolune signatures do not match newer version; ignoring!]";
    expect(androidInstallHint(adb)).toMatch(/Uninstall it first/);
    expect(androidInstallHint("Success")).toBeUndefined();
    expect(fromAgentDeviceError({ code: "COMMAND_FAILED", message: adb }, "install").hint).toMatch(/app uninstall/);
    expect(fromAgentDeviceError({ code: "COMMAND_FAILED", message: adb }, "install").details).toMatchObject({ reason: "INSTALL_SIGNATURE" });
  });

  it("names the real package, and only its reader's syntax, in a downgrade hint (#89)", async () => {
    const { androidInstallHint, installRefusal, withInstallHintFor } = await import("./agent-device-errors.js");
    const { TapdanceError } = await import("@tapdance/core");
    const adb = "adb: failed to install app.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code 2 is older than current 3]";
    expect(installRefusal(adb)).toBe("INSTALL_DOWNGRADE");
    const both = androidInstallHint(adb, "com.measify.pianolune")!;
    expect(both).toContain('MCP uninstall_app {app_id: "com.measify.pianolune"}');
    expect(both).toContain("`tapdance app uninstall com.measify.pianolune`");
    expect(both).not.toContain("<appId>");
    const fromGuard = new TapdanceError("DEVICE_ERROR", "Installing the APK failed", { hint: both, details: { reason: "INSTALL_DOWNGRADE", appId: "com.measify.pianolune" } });
    const mcp = withInstallHintFor(fromGuard, "mcp") as InstanceType<typeof TapdanceError>;
    expect(mcp.hint).toContain('uninstall_app {app_id: "com.measify.pianolune"}');
    expect(mcp.hint).not.toContain("tapdance");
    expect(mcp).toMatchObject({ code: "DEVICE_ERROR", message: "Installing the APK failed", details: { appId: "com.measify.pianolune" } });
    const cli = withInstallHintFor(fromGuard, "cli") as InstanceType<typeof TapdanceError>;
    expect(cli.hint).toContain("`tapdance app uninstall com.measify.pianolune`");
    expect(cli.hint).not.toContain("uninstall_app");
    // Without a package name the MCP hint points at list_apps instead of a placeholder.
    expect((withInstallHintFor(new TapdanceError("DEVICE_ERROR", "x", { details: { reason: "INSTALL_DOWNGRADE" } }), "mcp") as InstanceType<typeof TapdanceError>).hint).toContain("list_apps");
    // Other errors pass through untouched.
    const other = new TapdanceError("AUTH_FAILED", "git clone failed", { hint: "h", details: { reason: "GIT_AUTH" } });
    expect(withInstallHintFor(other, "mcp")).toBe(other);
  });
});

describe("leases on a slow or just-started host (#79, #92, #94, #101, #102; MOCKED agent-device client and Simlock HTTP)", () => {
  const SETTLED = "1\ncpu  100 0 0 900 0 0 0 0 0 0\n  mCurrentFocus=Window{1 u0 com.google.android.apps.nexuslauncher/.Launcher}\n";
  const CALMER = "1\ncpu  110 0 0 990 0 0 0 0 0 0\n  mCurrentFocus=Window{1 u0 com.google.android.apps.nexuslauncher/.Launcher}\n";
  /** A provider whose agent-device client, Simlock HTTP and device exec are fakes. */
  function fakeHost(o: {
    allocate: (p: { leaseId: string }) => Promise<unknown>;
    status?: (leaseId: string | undefined) => unknown;
    probes?: string[];
    dumpsys?: string;
    press?: (p: Record<string, unknown>) => Promise<unknown>;
    snapshot?: () => Promise<unknown>;
    warmUpTimeoutMs?: number;
    catalog?: unknown;
  }) {
    let leaseId: string | undefined;
    const pressed: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const probes = [...(o.probes ?? [SETTLED, CALMER])];
    // Once the scripted answers run out, the guest stays calm: 10 % busy per read.
    let calmReads = 0;
    const nextProbe = () => {
      if (probes.length > 0) return probes.shift()!;
      calmReads++;
      return `1\ncpu  ${1000 + calmReads * 10} 0 0 ${10_000 + calmReads * 90} 0 0 0 0 0 0\n  mCurrentFocus=Window{1 u0 com.google.android.apps.nexuslauncher/.Launcher}\n`;
    };
    const client = {
      leases: {
        allocate: async (p: { leaseId: string }) => {
          leaseId = p.leaseId;
          return o.allocate(p);
        },
        release: async () => ({ released: true }),
      },
      sessions: { close: async () => ({}) },
      apps: { open: async () => ({}) },
      interactions: { press: async (p: Record<string, unknown>) => (pressed.push(p), o.press ? o.press(p) : {}) },
      capture: { snapshot: async () => (calls.push("snapshot"), (o.snapshot ?? (async () => ({ nodes: [] })))()) },
    };
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/v1/status") return new Response(JSON.stringify(o.status?.(leaseId) ?? { devices: [], leases: [] }), { status: 200 });
      if (path === "/v1/catalog" && o.catalog !== undefined) return new Response(JSON.stringify(o.catalog), { status: 200 });
      return new Response(JSON.stringify({ lease: { id: leaseId } }), { status: 200 });
    }) as typeof fetch;
    const p = new (class extends SimlockProvider {
      protected override staleRecordRetryMs = 5;
      protected override queuePollMs = 10;
      protected override settleIntervalMs = 5;
      protected override warmUpTimeoutMs = o.warmUpTimeoutMs ?? 20_000;
      protected override leaseClient() {
        return client as never;
      }
      protected override agentClient() {
        return client as never;
      }
      protected override async execOn(_h: unknown, _tool: string, args: string[]) {
        if (args[1]?.startsWith("getprop")) return (calls.push("probe"), { exitCode: 0, stdout: nextProbe(), stderr: "" });
        return { exitCode: 0, stdout: o.dumpsys ?? "", stderr: "" };
      }
    })({ kind: "remote", baseUrl: "https://host.example:4720", token: "t", tenant: "t", runId: "r", clientId: "c", source: "test" }, {}, fetchImpl);
    return { p, pressed, calls };
  }
  const granted = { leaseId: "x", deviceKey: "android:mobile:emulator-5554", device: { model: "Pixel 8", osVersion: "34" } };
  const request = { platform: "android" as const, ttlMs: 60_000 };
  const androidHandle = { provider: "simlock", leaseId: "l", sessionId: "s", platform: "android", deviceId: "emulator-5554", physical: false, providerData: { baseUrl: "https://host.example:4720", agentDeviceSession: "td-x", deviceKey: "android:mobile:emulator-5554", tenant: "t", runId: "r", clientId: "c" } } as never;

  it("asks again while the host offers a device that is not running, then leases (#94)", async () => {
    let calls = 0;
    const { p } = fakeHost({
      allocate: async (a) => {
        if (++calls < 3) throw { code: "DEVICE_NOT_FOUND", message: "No Android device with serial emulator-5586" };
        return { ...granted, leaseId: a.leaseId };
      },
    });
    const progress: string[] = [];
    const handle = await p.lease("s", request, { onProgress: (m) => progress.push(m) });
    expect(calls).toBe(3);
    expect(handle.deviceId).toBe("emulator-5554");
    expect(progress.filter((m) => /not running \(its records are stale/.test(m))).toHaveLength(2);
  });

  it("gives up with a hint that says the host just started, not to check selectors (#94)", async () => {
    const { p } = fakeHost({ allocate: async () => Promise.reject({ code: "DEVICE_NOT_FOUND", message: "No Android device with serial emulator-5586" }) });
    await expect(p.lease("s", { ...request, waitTimeoutMs: 1 })).rejects.toMatchObject({
      code: "DEVICE_UNAVAILABLE",
      retryable: true,
      hint: expect.stringMatching(/about a minute after the host \(re\)starts/),
      details: expect.objectContaining({ reason: "STALE_DEVICE_RECORD" }),
    });
    // Any other refusal is not retried.
    let calls = 0;
    const other = fakeHost({ allocate: async () => (calls++, Promise.reject({ code: "INVALID_ARGS", message: "refused by simlock: unknown model Pixel 99" })) });
    await expect(other.p.lease("s", request)).rejects.toMatchObject({ code: "DEVICE_UNAVAILABLE" });
    expect(calls).toBe(1);
  });

  it("says whether a spare is ready and where a waiting request stands (#92)", async () => {
    const { p } = fakeHost({
      allocate: async (a) => (await new Promise((r) => setTimeout(r, 80)), { ...granted, leaseId: a.leaseId }),
      status: (id) => ({ devices: [], leases: [], capacity: { android: { warm: 0 } }, warmPool: { enabled: true, targets: [] }, waiting: id ? [{ id: "w1", requesterId: id, stage: "starting" }] : [] }),
    });
    const progress: string[] = [];
    await p.lease("s", request, { onProgress: (m) => progress.push(m) });
    expect(progress[0]).toMatch(/no device of this kind exists yet, so one has to be created and booted: a first boot can take a few minutes/);
    expect(progress.some((m) => /^Starting a device for this lease .*\(\d+ s\)$/.test(m))).toBe(true);
    // Said once per stage, not on every poll.
    expect(progress.filter((m) => m.startsWith("Starting a device")).length).toBe(1);
  });

  it("names a ready spare instead of warning that a device may take minutes (#92)", async () => {
    const { spareNote, describeWaiting } = await import("./provider.js");
    const status = { devices: [], leases: [], capacity: { android: { warm: 1 } }, warmPool: { targets: [{ platform: "android", model: "Pixel 8", osVersion: "34", ready: 1 }] } };
    expect(spareNote(status, { platform: "android" })).toBe("a warm spare is ready");
    expect(spareNote(status, { platform: "android", device: "pixel 8" })).toBe("a warm spare is ready");
    expect(spareNote(status, { platform: "android", device: "Pixel 9" })).toMatch(/no device of this kind exists yet/);
    expect(spareNote({ ...status, warmPool: { targets: [{ platform: "android", model: "Pixel 8", ready: 0, booting: 1 }] }, capacity: {} }, { platform: "android" })).toMatch(/a spare is booting/);
    expect(spareNote(undefined, { platform: "android" })).toBe("queues if busy; starting a device usually takes under a minute, longer on a first boot");
    // The ready spare must be of the requested image tag (#112).
    const play = { devices: [], leases: [], capacity: { android: { warm: 1 } }, warmPool: { targets: [{ platform: "android", model: "Pixel 8", osVersion: "34", ready: 1 }] } };
    expect(spareNote(play, { platform: "android", imageTag: "google_apis" })).toMatch(/no device of this kind exists yet/);
    const tagged = { ...play, warmPool: { targets: [{ platform: "android", model: "Pixel 8", osVersion: "34", imageTag: "google_apis", ready: 1 }] } };
    expect(spareNote(tagged, { platform: "android", imageTag: "google_apis", osVersion: "34" })).toBe("a warm spare is ready");
    expect(spareNote(tagged, { platform: "android" })).toMatch(/no device of this kind exists yet/);
    // Simlock's bare warm count is not a ready spare of another kind.
    expect(spareNote({ devices: [], leases: [], capacity: { android: { warm: 1 } }, warmPool: { targets: [] } }, { platform: "android" })).toMatch(/no device of this kind exists yet/);
    expect(spareNote({ devices: [], leases: [], capacity: { android: { warm: 1 } } }, { platform: "android" })).toBe("a warm spare is ready");
    expect(spareNote({ devices: [], leases: [], capacity: { android: { warm: 1 } } }, { platform: "android", imageTag: "google_apis" })).toMatch(/no device of this kind exists yet/);
    expect(describeWaiting({ stage: "queued", queuePosition: 2, reason: "full" })).toBe("Queued for a device (position 2, every slot is busy)");
    expect(describeWaiting(undefined)).toBeUndefined();
    expect(describeWaiting({ stage: "reclaiming" })).toMatch(/released device of this kind to be restored/);
  });

  it("says a released device is restored in seconds instead of warning about minutes (#117; fake status)", async () => {
    const { spareNote } = await import("./provider.js");
    const empty = { leases: [], capacity: { android: { warm: 0 } }, warmPool: { enabled: true, targets: [{ platform: "android", model: "Pixel 8", osVersion: "34", imageTag: "google_apis", ready: 0 }] } };
    const device = (state: string, spec: Record<string, unknown> = {}) => ({ id: "d1", state, spec: { platform: "android", model: "Pixel 8", osVersion: "34", imageTag: "google_apis", physical: false, ...spec } });
    const req = { platform: "android" as const, osVersion: "34", imageTag: "google_apis" };
    // Right after a release the emulator is reclaimed from its clean snapshot (N2 field run: Granted in about 4 s).
    expect(spareNote({ ...empty, devices: [device("reclaiming")] }, req)).toBe("a released device is being restored from its snapshot: usually ready in seconds");
    expect(spareNote({ ...empty, devices: [device("reclaiming")] }, req)).not.toMatch(/few minutes/);
    // A free device of that kind is a ready spare even when the warm pool counts none.
    expect(spareNote({ ...empty, devices: [device("ready")] }, req)).toBe("a warm spare is ready");
    expect(spareNote({ ...empty, devices: [device("provisioning")] }, req)).toMatch(/a spare is booting/);
    expect(spareNote({ ...empty, devices: [device("shutdown")] }, req)).toBe("a stopped device of this kind will start: usually under a minute, longer on a first boot");
    // Only a host with no device of this kind needs a first boot: the long-wait text.
    expect(spareNote({ ...empty, devices: [] }, req)).toMatch(/no device of this kind exists yet.*a first boot can take a few minutes/);
    expect(spareNote({ ...empty, devices: [device("reclaiming", { imageTag: undefined })] }, req)).toMatch(/no device of this kind exists yet/);
    expect(spareNote({ ...empty, devices: [device("reclaiming", { model: "Pixel 9" })] }, { ...req, device: "Pixel 8" })).toMatch(/no device of this kind exists yet/);
    expect(spareNote({ ...empty, devices: [device("leased")] }, req)).toMatch(/^every device of this kind is busy/);
    // iOS: a released simulator is erased and booted again.
    const ios = { id: "s1", state: "reclaiming", spec: { platform: "ios", model: "iPhone 16", osVersion: "18.5", physical: false } };
    expect(spareNote({ devices: [ios], leases: [] }, { platform: "ios" })).toBe("a released device is being reset: usually ready in under a minute");
    // Through a worker guard the list holds only the client's own devices: no claim about the host.
    expect(spareNote({ ...empty, devices: [], devicesScope: "held" }, req)).toBe("no spare is ready, so a device has to start: usually under a minute, longer on a first boot");
  });

  it("on a host with both images, a lease without a tag asks for google_apis at the default API level, and says so (#112; fake catalog)", async () => {
    const catalog = {
      platforms: [
        {
          platform: "android",
          models: ["Pixel 8", "Pixel 9"],
          runtimes: ["34", "35"],
          defaultRuntime: "34",
          images: [
            { runtime: "34", tag: "google_apis", abi: "x86_64" },
            { runtime: "34", tag: "google_apis_playstore", abi: "x86_64" },
            { runtime: "35", tag: "google_apis", abi: "x86_64" },
          ],
        },
      ],
    };
    const sent: Array<Record<string, unknown>> = [];
    const { p } = fakeHost({
      catalog,
      allocate: async (a) => (sent.push(a as Record<string, unknown>), { ...granted, leaseId: a.leaseId }),
      // The ready spare is the old untagged (Play) kind: not claimed as ready for this request.
      status: () => ({ devices: [], leases: [], capacity: { android: { warm: 1 } }, warmPool: { targets: [{ platform: "android", model: "Pixel 8", osVersion: "34", ready: 1 }] } }),
    });
    const progress: string[] = [];
    await p.lease("s", request, { onProgress: (m) => progress.push(m) });
    expect(sent[0]).toMatchObject({ imageTag: "google_apis", osVersion: "34" });
    expect(progress[0]).toMatch(/^Using the google_apis image \(this host also has google_apis_playstore.*\), API 34, the host's default$/);
    expect(progress[1]).toMatch(/no device of this kind exists yet/);

    // An explicit tag without --os keeps the default API level instead of the newest (35).
    sent.length = 0;
    await p.lease("s", { ...request, imageTag: "google_apis" });
    expect(sent[0]).toMatchObject({ imageTag: "google_apis", osVersion: "34" });
    // A request that names its OS, or asks for Play, is sent as given (only google_apis exists at 35).
    sent.length = 0;
    await p.lease("s", { ...request, osVersion: "35" });
    expect(sent[0]).toMatchObject({ osVersion: "35" });
    expect(sent[0]?.["imageTag"]).toBeUndefined();
    sent.length = 0;
    await p.lease("s", { ...request, imageTag: "google_apis_playstore", osVersion: "34" });
    expect(sent[0]).toMatchObject({ imageTag: "google_apis_playstore", osVersion: "34" });
  });

  it("leaves the request alone on a host with one kind of image, or when the catalog cannot be read (#112; fake catalog)", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const one = { platforms: [{ platform: "android", defaultRuntime: "34", images: [{ runtime: "34", tag: "google_apis_playstore", abi: "x86_64" }] }] };
    const { p } = fakeHost({ catalog: one, allocate: async (a) => (sent.push(a as Record<string, unknown>), { ...granted, leaseId: a.leaseId }) });
    await p.lease("s", request);
    expect(sent[0]?.["imageTag"]).toBeUndefined();
    expect(sent[0]?.["osVersion"]).toBeUndefined();
    // No catalog route (an older endpoint): the fake answers something else.
    const other = fakeHost({ allocate: async (a) => (sent.push(a as Record<string, unknown>), { ...granted, leaseId: a.leaseId }) });
    await other.p.lease("s", request);
    expect(sent[1]?.["imageTag"]).toBeUndefined();
  });

  it("waits for a busy guest, answers a System UI ANR with Wait, and hands it out (#79)", async () => {
    const ANR = "1\ncpu  0 0 0 0 0 0 0 0 0 0\n  mCurrentFocus=Window{4f u0 Application Not Responding: com.android.systemui}\n";
    const { p, pressed } = fakeHost({ allocate: async (a) => ({ ...granted, leaseId: a.leaseId }), probes: [ANR, SETTLED, CALMER] });
    const progress: string[] = [];
    const handle = await p.lease("s", request, { onProgress: (m) => progress.push(m) });
    expect(pressed).toEqual([expect.objectContaining({ selector: 'id="android:id/aerr_wait"' })]);
    expect(progress.some((m) => /System UI isn't responding" dialog with Wait/.test(m))).toBe(true);
    expect(handle.notices).toBeUndefined();
  }, 15_000);

  it("checks the CPU only as long as the request's settleMs, and not at all for 0 (session.settleSeconds)", async () => {
    // A guest that stays 99 % busy.
    const busy = Array.from({ length: 2000 }, (_, i) => `1\ncpu  ${i * 1000} 0 0 ${i * 10} 0 0 0 0 0 0\n  mCurrentFocus=Window{1 u0 com.google.android.apps.nexuslauncher/.Launcher}\n`);
    const short = fakeHost({ allocate: async (a) => ({ ...granted, leaseId: a.leaseId }), probes: [...busy] });
    const handle = await short.p.lease("s", { ...request, settleMs: 40 });
    expect(handle.notices?.[0]).toMatch(/still busy with its start-up work .*guest CPU 99 %.*raise session\.settleSeconds/);
    expect(short.calls.filter((c) => c === "probe").length).toBeLessThan(40);
    // 0: one read (booted, nothing in front), no notice, and the warm-up still runs.
    const off = fakeHost({ allocate: async (a) => ({ ...granted, leaseId: a.leaseId }), probes: [...busy] });
    const quick = await off.p.lease("s", { ...request, settleMs: 0 });
    expect(quick.notices).toBeUndefined();
    expect(off.calls.filter((c) => c === "probe")).toHaveLength(1);
    expect(off.calls).toContain("snapshot");
    // 0 still answers an "isn't responding" dialog with Wait.
    const ANR = "1\ncpu  0 0 0 0 0 0 0 0 0 0\n  mCurrentFocus=Window{4f u0 Application Not Responding: com.android.systemui}\n";
    const dialog = fakeHost({ allocate: async (a) => ({ ...granted, leaseId: a.leaseId }), probes: [ANR, ...busy] });
    await dialog.p.lease("s", { ...request, settleMs: 0 });
    expect(dialog.pressed).toEqual([expect.objectContaining({ selector: 'id="android:id/aerr_wait"' })]);
  });

  it("hands a guest busy from the start out early and says so before the warm-up ends (#101, field run 2d)", async () => {
    // A guest that stays 99 % busy, and a warm-up read that takes a while.
    const busy = Array.from({ length: 2000 }, (_, i) => `1\ncpu  ${i * 1000} 0 0 ${i * 10} 0 0 0 0 0 0\n  mCurrentFocus=Window{1 u0 com.google.android.apps.nexuslauncher/.Launcher}\n`);
    const events: string[] = [];
    const { p, calls } = fakeHost({
      allocate: async (a) => ({ ...granted, leaseId: a.leaseId }),
      probes: [...busy],
      snapshot: async () => {
        await new Promise((r) => setTimeout(r, 150));
        events.push("warm-up read done");
        return { nodes: [] };
      },
    });
    const handle = await p.lease("s", { ...request, settleMs: 15_000 }, { onNotice: (n) => events.push(`notice: ${n.slice(0, 41)}`), onProgress: () => undefined });
    // The early busy exit: four probes (three readings), not a 15 s check.
    expect(calls.filter((c) => c === "probe")).toHaveLength(4);
    expect(handle.notices?.[0]).toMatch(/still busy with its start-up work/);
    expect(events).toEqual(["notice: The device is still busy with its start-u", "warm-up read done"]);
  });

  it("warms agent-device's snapshot helper alongside the settle wait, so the agent's first inspect works (#102, field run 2d)", async () => {
    // The helper fails its first start on a restored spare, as on every warm lease of the N2 run.
    let snapshots = 0;
    const { p, calls } = fakeHost({
      allocate: async (a) => ({ ...granted, leaseId: a.leaseId }),
      snapshot: async () => {
        if (++snapshots === 1) throw new Error("Android snapshot helper failed: INSTRUMENTATION_FAILED");
        return { nodes: [{ ref: "e1", label: "Settings" }] };
      },
    });
    await p.lease("s", request);
    // The warm-up starts once the first probe reads the guest ready and runs during the CPU check:
    // a failed read and one more after the back-off.
    expect(calls.filter((c) => c === "snapshot")).toHaveLength(2);
    expect(calls.indexOf("snapshot")).toBeGreaterThan(calls.indexOf("probe"));
    expect(calls.indexOf("snapshot")).toBeLessThan(calls.lastIndexOf("probe"));
    // The agent's first inspect then reads the screen at once.
    const screen = await p.inspect(androidHandle);
    expect(snapshots).toBe(3);
    expect(screen.elements.map((e) => e.label)).toEqual(["Settings"]);
  });

  it("never fails or holds up a lease over the warm-up (#102)", async () => {
    // A helper that keeps failing, another error, and a read that never answers: the lease stands.
    const failing = fakeHost({ allocate: async (a) => ({ ...granted, leaseId: a.leaseId }), snapshot: async () => Promise.reject(new Error("INSTRUMENTATION_FAILED")) });
    const handle = await failing.p.lease("s", request);
    expect(handle.deviceId).toBe("emulator-5554");
    expect(failing.calls.filter((c) => c === "snapshot")).toHaveLength(2);
    const other = fakeHost({ allocate: async (a) => ({ ...granted, leaseId: a.leaseId }), snapshot: async () => Promise.reject(new Error("device offline")) });
    await expect(other.p.lease("s", request)).resolves.toMatchObject({ deviceId: "emulator-5554" });
    expect(other.calls.filter((c) => c === "snapshot")).toHaveLength(1);
    const hung = fakeHost({ allocate: async (a) => ({ ...granted, leaseId: a.leaseId }), snapshot: () => new Promise(() => undefined), warmUpTimeoutMs: 20 });
    await expect(hung.p.lease("s", request)).resolves.toMatchObject({ deviceId: "emulator-5554" });
    // A helper that keeps failing slowly: the whole warm-up (both reads and the pause) stays within
    // its bound, not one bound per read.
    const slow = fakeHost({
      allocate: async (a) => ({ ...granted, leaseId: a.leaseId }),
      snapshot: () => new Promise((_, reject) => setTimeout(() => reject(new Error("INSTRUMENTATION_FAILED")), 300)),
      warmUpTimeoutMs: 400,
    });
    const started = Date.now();
    await slow.p.lease("s", request);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(slow.calls.filter((c) => c === "snapshot")).toHaveLength(1);
  });

  it("reports an ANR dialog from inspect, launch and a missed tap instead of a plain miss (#80)", async () => {
    const nodes = [
      { ref: "e1", label: "System UI isn't responding", identifier: "android:id/alertTitle" },
      { ref: "e2", label: "Close app", identifier: "android:id/aerr_close" },
      { ref: "e3", label: "Wait", identifier: "android:id/aerr_wait" },
    ];
    const { p } = fakeHost({
      allocate: async () => granted,
      dumpsys: "  mCurrentFocus=Window{4f u0 Application Not Responding: com.android.systemui}\n",
      snapshot: async () => ({ nodes, appBundleId: "com.measify.pianolune", warnings: ["A system surface (notification shade, quick settings, or another system overlay) covers the app"] }),
      press: async () => Promise.reject({ code: "COMMAND_FAILED", message: 'Selector did not match: label="Let me try"' }),
    });
    const screen = await p.inspect(androidHandle);
    expect(screen.app).toBe("android");
    expect(screen.warnings).toHaveLength(1);
    expect(screen.warnings[0]).toMatch(/"System UI isn't responding" covers the screen.*aerr_wait/);
    const launched = await p.launchApp(androidHandle, "com.measify.pianolune");
    expect(launched).toMatchObject({ ok: true, message: expect.stringMatching(/system dialog is in front/), warning: expect.stringMatching(/Wait/) });
    await expect(p.tap(androidHandle, { kind: "text", text: "Let me try" })).rejects.toMatchObject({
      code: "ELEMENT_NOT_FOUND",
      message: expect.stringMatching(/a system dialog "System UI isn't responding" is in front/),
      hint: expect.stringMatching(/aerr_wait/),
    });
  });
});

describe("reading the screen when agent-device's helper fails, and what a miss shows (phone-harness ideas, MOCKED client and adb)", () => {
  const handle = { provider: "simlock", leaseId: "l", sessionId: "s", platform: "android", deviceId: "emulator-5554", providerData: { baseUrl: "http://x", agentDeviceSession: "td-x", deviceKey: "android:mobile:emulator-5554", tenant: "local", runId: "r", clientId: "c" } } as never;
  const conn = { kind: "local", baseUrl: "http://x", token: "t", tenant: "local", runId: "r", clientId: "c", source: "test" } as const;
  const dump = '<?xml version="1.0"?><hierarchy rotation="0"><node index="0" text="Let me try" resource-id="" class="android.widget.Button" package="com.measify.pianolune" clickable="true" enabled="true" bounds="[42,2169][1038,2295]" /></hierarchy>';
  const make = (snapshots: Array<Error | Record<string, unknown>>, adb: { stdout: string; exitCode?: number } | Error = { stdout: dump }) => {
    let reads = 0;
    const execs: string[][] = [];
    const p = new (class extends SimlockProvider {
      protected override agentClient() {
        return {
          capture: { snapshot: async () => { const s = snapshots[Math.min(reads++, snapshots.length - 1)]!; if (s instanceof Error) throw s; return s; } },
          interactions: { press: async () => { throw Object.assign(new Error("Selector did not match: id=\"buy\""), { code: "SELECTOR_NOT_FOUND" }); } },
        } as never;
      }
      protected override async execOn(_h: never, _tool: "adb" | "simctl", args: string[]) {
        execs.push(args);
        if (adb instanceof Error) throw adb;
        // The focused-window read for a system dialog answers with an ordinary app window.
        if (args.includes("window")) return { exitCode: 0, stdout: "mCurrentFocus=Window{1 u0 com.measify.pianolune/.MainActivity}", stderr: "" };
        return { exitCode: adb.exitCode ?? 0, stdout: adb.stdout, stderr: "" };
      }
    })(conn);
    return { p, execs, reads: () => reads };
  };
  const flake = new Error("Android snapshot helper failed: INSTRUMENTATION_FAILED");

  it("backs off and reads again while the helper is starting", async () => {
    vi.useFakeTimers();
    try {
      const t = make([flake, flake, { nodes: [{ ref: "e1", type: "android.widget.Button", label: "Let me try" }], appBundleId: "com.measify.pianolune" }]);
      const pending = t.p.inspect(handle);
      await vi.advanceTimersByTimeAsync(5000);
      const screen = await pending;
      expect(t.reads()).toBe(3);
      expect(screen.source).toBeUndefined();
      expect(screen.elements.map((e) => e.label)).toEqual(["Let me try"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a uiautomator dump, marked as such, when the helper keeps failing; fails with the helper's error when the dump fails too", async () => {
    vi.useFakeTimers();
    try {
      const t = make([flake]);
      const pending = t.p.inspect(handle);
      await vi.advanceTimersByTimeAsync(5000);
      const screen = await pending;
      expect(t.reads()).toBe(4);
      expect(screen.source).toBe("uiautomator");
      expect(screen.warnings[0]).toMatch(/uiautomator dump.*refs cannot be tapped/);
      expect(screen.elements.some((e) => e.label === "Let me try")).toBe(true);
      const both = make([flake], { stdout: "ERROR: could not get idle state" });
      const failing = both.p.inspect(handle).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await failing).toMatchObject({ message: expect.stringMatching(/INSTRUMENTATION_FAILED/) });
      // Other failures are not retried.
      const other = make([new Error("device offline")]);
      await expect(other.p.inspect(handle)).rejects.toThrow(/device offline/);
      expect(other.reads()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a tap whose target is missing names what is on screen", async () => {
    const t = make([{ nodes: [{ ref: "e1", label: "Start free trial" }, { ref: "e2", label: "Restore purchases" }, { ref: "e3", label: "Start free trial" }, { ref: "e4", label: "" }], appBundleId: "com.measify.pianolune" }]);
    const error = await t.p.tap(handle, { kind: "id", id: "buy" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ELEMENT_NOT_FOUND", message: expect.stringMatching(/On screen: "Start free trial", "Restore purchases"$/), details: { visible: ["Start free trial", "Restore purchases"] } });
  });

  it("caps and shortens the list it shows", async () => {
    const { visibleLabels, describeVisible } = await import("./provider.js");
    const labels = visibleLabels(Array.from({ length: 40 }, (_, i) => ({ label: `Row ${i} ${"x".repeat(i === 0 ? 50 : 1)}` })));
    expect(labels).toHaveLength(30);
    expect(labels[0]).toHaveLength(40);
    expect(describeVisible(labels)).toMatch(/and 18 more \(details\.visible\)$/);
  });
});

describe("hints name only what a Tapdance reader can run (#108)", () => {
  // agent-device's own hints, as the field run saw them.
  const elementHint = 'Selector text/label values match exactly (quote multi-word values: text="Sign in"). Run snapshot -i to see current elements and refs, or use find <text> for contains matching.';
  const debugHint = "Retry with --debug and inspect diagnostics log for details.";
  const ambiguousHint = "Multiple candidates matched. Narrow the query or pass an exact identifier.";

  it("drops the sentences of a backend hint that name agent-device's CLI and keeps plain advice", () => {
    expect(readerHint(elementHint)).toBe('Selector text/label values match exactly (quote multi-word values: text="Sign in").');
    expect(readerHint(debugHint)).toBeUndefined();
    expect(readerHint(ambiguousHint)).toBe(ambiguousHint);
    expect(readerHint("Re-check the target with snapshot -i and fill the element it reports.")).toBeUndefined();
    expect(readerHint(undefined)).toBeUndefined();
  });

  it("maps a miss, a failed command and an ambiguous tap without agent-device syntax", () => {
    const miss = fromAgentDeviceError({ code: "SELECTOR_NOT_FOUND", message: 'Selector did not match: text="No such button"', details: { hint: elementHint } }, 'tap "No such button"');
    expect(miss.hint).toContain("inspect_screen");
    expect(miss.hint).not.toMatch(BACKEND_SYNTAX);
    const failed = fromAgentDeviceError({ code: "COMMAND_FAILED", message: "Android helper could not launch the application", details: { hint: debugHint } }, "launch com.x");
    expect(failed.hint ?? "").not.toMatch(BACKEND_SYNTAX);
    const ambiguous = fromAgentDeviceError({ code: "AMBIGUOUS_MATCH", message: "find matched 2 elements", details: { hint: ambiguousHint } }, "tap");
    expect(ambiguous.hint).toBe(ambiguousHint);
  });
});

describe("launch right after clear_app_data (#107, MOCKED agent-device client and adb)", () => {
  const handle = { provider: "simlock", leaseId: "l", sessionId: "s", platform: "android", deviceId: "emulator-5554", providerData: { baseUrl: "http://x", agentDeviceSession: "td-x", deviceKey: "android:mobile:emulator-5554", tenant: "local", runId: "r", clientId: "c" } } as never;
  const conn = { kind: "local", baseUrl: "http://x", token: "t", tenant: "local", runId: "r", clientId: "c", source: "test" } as const;
  const APP = "com.measify.pianolune";
  const inApp = `  mCurrentFocus=Window{1 u0 ${APP}/${APP}.MainActivity}\n  mFocusedApp=ActivityRecord{2 u0 ${APP}/.MainActivity t12}\n`;
  const starting = `  mCurrentFocus=null\n  mFocusedApp=ActivityRecord{2 u0 ${APP}/.MainActivity t12}\n`;
  const launcher = "  mCurrentFocus=Window{1 u0 com.google.android.apps.nexuslauncher/.Launcher}\n";
  const helperStall = { code: "COMMAND_FAILED", message: "Android helper could not launch the application", details: { hint: "Retry with --debug and inspect diagnostics log for details." } };
  const make = (opens: Array<unknown>, windows: string[]) => {
    let opened = 0;
    let looked = 0;
    const p = new (class extends SimlockProvider {
      protected override agentClient() {
        return {
          apps: {
            open: async () => {
              const r = opens[Math.min(opened++, opens.length - 1)];
              if (r) throw r;
              return {};
            },
          },
        } as never;
      }
      protected override async execOn(_h: never, _tool: "adb" | "simctl", args: string[]) {
        if (args.includes("window")) return { exitCode: 0, stdout: windows[Math.min(looked++, windows.length - 1)]!, stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    })(conn);
    return { p, opens: () => opened };
  };
  const run = async <T,>(work: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers();
    try {
      const pending = work();
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(20_000);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  };

  it("reads the focused app from either focus line", () => {
    expect(appInFront(inApp, APP)).toBe(true);
    expect(appInFront(starting, APP)).toBe(true);
    expect(appInFront(launcher, APP)).toBe(false);
  });

  it("reports success when the helper failed but the app is in front", async () => {
    const t = make([helperStall], [starting]);
    const r = await run(() => t.p.launchApp(handle, APP));
    expect(r).toMatchObject({ ok: true, message: `Launched ${APP}`, warning: expect.stringMatching(/is in front: it launched/) });
    expect(t.opens()).toBe(1);
  });

  it("opens once more when the app is not in front yet, and succeeds", async () => {
    const t = make([{ code: "COMMAND_FAILED", message: "Android snapshot helper session request timed out" }, undefined], [launcher]);
    const r = await run(() => t.p.launchApp(handle, APP));
    expect(r).toMatchObject({ ok: true, warning: expect.stringMatching(/second one worked/) });
    expect(t.opens()).toBe(2);
  });

  it("fails after the second try with a hint a Tapdance reader can follow", async () => {
    const t = make([helperStall, helperStall], [launcher]);
    const error = (await run(() => t.p.launchApp(handle, APP).catch((e: unknown) => e))) as TapdanceError;
    expect(error).toMatchObject({ code: "DEVICE_ERROR", message: expect.stringMatching(/could not launch/) });
    expect(error.hint).toMatch(/inspect_screen/);
    expect(error.hint).not.toMatch(BACKEND_SYNTAX);
    expect(t.opens()).toBe(2);
  });

  it("does not retry a failure that is not the helper's", async () => {
    const t = make([{ code: "APP_NOT_INSTALLED", message: "Application com.measify.pianolune not found" }], [inApp]);
    await expect(t.p.launchApp(handle, APP)).rejects.toMatchObject({ code: "APP_NOT_INSTALLED" });
    expect(t.opens()).toBe(1);
  });
});
