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
import { summarizeDiff } from "./provider.js";
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
    expect(fromAgentDeviceError({ code: "TEXT_INPUT_NOT_FOCUSED", message: "No focused text input" }, "x").code).toBe("ELEMENT_NOT_FOUND");
    expect(fromAgentDeviceError({ message: "refused: lease abc is not one of yours on this gateway" }, "x").code).toBe("FORBIDDEN");
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
