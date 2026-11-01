import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalArtifactStore,
  SessionStore,
  TapdanceError,
  loadConfig,
  parseConfig,
  parseTarget,
  redactObject,
  redactSecrets,
  resolveSessionIdentity,
  saveCredentials,
  sanitizeSessionId,
  type LeaseHandle,
} from "./index.js";

const tmp = () => mkdtemp(join(tmpdir(), "tapdance-core-"));

describe("errors and redaction", () => {
  it("maps codes to exit codes", () => {
    expect(new TapdanceError("USAGE", "x").exitCode).toBe(2);
    expect(new TapdanceError("NO_ACTIVE_LEASE", "x").exitCode).toBe(3);
    expect(new TapdanceError("PROVIDER_UNREACHABLE", "x").exitCode).toBe(4);
    expect(new TapdanceError("HUMAN_HELD", "x").exitCode).toBe(11);
  });

  it("redacts Simlock secrets, bearer headers and token fields", () => {
    expect(redactSecrets("token slk_d2FybS1wb29sLWFnZW50 here")).toBe("token [REDACTED] here");
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: Bearer [REDACTED]");
    expect(redactObject({ token: "abc", nested: { daemonAuthToken: "x", ok: "slk_aaaaaaaaaaaaaaa" } })).toEqual({
      token: "[REDACTED]",
      nested: { daemonAuthToken: "[REDACTED]", ok: "[REDACTED]" },
    });
  });

  it("never carries a secret in a thrown message", () => {
    const e = new TapdanceError("AUTH_FAILED", "bad slk_SECRETSECRETSECRET", { hint: "use slk_OTHERSECRETVALUE" });
    expect(JSON.stringify(e.toJSON())).not.toContain("SECRET");
  });
});

describe("config", () => {
  it("defaults to local with sane session settings", () => {
    const c = parseConfig({});
    expect(c.provider).toBe("local");
    expect(c.session.defaultTtlMinutes).toBe(30);
    expect(c.viewer.host).toBe("127.0.0.1");
  });

  it("rejects unknown keys and bad values", () => {
    expect(() => parseConfig({ provider: "aws" })).toThrow(TapdanceError);
    expect(() => parseConfig({ endpoint: "ftp://x" })).toThrow(/http/);
    expect(() => parseConfig({ typo: true })).toThrow(/Unrecognized|typo/);
  });

  it("merges user ← project ← env, with env winning", async () => {
    const home = await tmp();
    const proj = await tmp();
    await writeFile(join(home, "config.json"), JSON.stringify({ provider: "self-hosted", endpoint: "https://a.example.com", session: { defaultTtlMinutes: 10 } }));
    await writeFile(join(proj, "tapdance.config.json"), JSON.stringify({ session: { defaultTtlMinutes: 20 } }));
    const r = await loadConfig({ cwd: proj, env: { TAPDANCE_HOME: home, TAPDANCE_ENDPOINT: "https://b.example.com" } });
    expect(r.config.provider).toBe("self-hosted");
    expect(r.config.endpoint).toBe("https://b.example.com");
    expect(r.config.session.defaultTtlMinutes).toBe(20);
    expect(r.artifactsDir).toBe(join(proj, "tapdance-artifacts"));
    expect(r.sources).toHaveLength(3);
  });

  it("refuses tokens in config files", async () => {
    const proj = await tmp();
    await writeFile(join(proj, "tapdance.config.json"), JSON.stringify({ token: "slk_x" }));
    await expect(loadConfig({ cwd: proj, env: { TAPDANCE_HOME: await tmp() } })).rejects.toThrow(/Tokens must not/);
  });

  it("stores credentials with mode 600 and lets env override them", async () => {
    const home = await tmp();
    const env = { TAPDANCE_HOME: home };
    const file = await saveCredentials({ token: "file-token" }, env);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const r = await loadConfig({ cwd: await tmp(), env: { ...env, TAPDANCE_TOKEN: "env-token" } });
    expect(r.credentials.token).toBe("env-token");
    expect(r.credentialSources).toEqual([file, "TAPDANCE_TOKEN"]);
  });
});

describe("session identity", () => {
  it("prefers TAPDANCE_SESSION_ID, then the agent's session", async () => {
    const home = await tmp();
    expect((await resolveSessionIdentity(home, { TAPDANCE_SESSION_ID: "mine", CLAUDE_CODE_SESSION_ID: "c" })).id).toBe("mine");
    expect((await resolveSessionIdentity(home, { CLAUDE_CODE_SESSION_ID: "abc" })).id).toBe("claude-code:abc");
    expect((await resolveSessionIdentity(home, { CODEX_SESSION_ID: "x" })).id).toBe("codex:x");
  });

  it("keeps a stable per-user identity otherwise", async () => {
    const home = await tmp();
    const a = await resolveSessionIdentity(home, {});
    const b = await resolveSessionIdentity(home, {});
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^cli:/);
  });

  it("hashes ids with unsafe characters", () => {
    expect(sanitizeSessionId("ok:id-1")).toBe("ok:id-1");
    expect(sanitizeSessionId("../../etc/passwd")).toMatch(/^h-[0-9a-f]{32}$/);
  });
});

describe("targets", () => {
  it("accepts exactly one target", () => {
    expect(parseTarget({ text: "Sign in" })).toEqual({ kind: "text", text: "Sign in" });
    expect(parseTarget({ ref: "@e7" })).toEqual({ kind: "ref", ref: "e7" });
    expect(parseTarget({ x: 10, y: 20 })).toEqual({ kind: "point", x: 10, y: 20 });
  });

  it("refuses none, several, half coordinates and empty values", () => {
    expect(() => parseTarget({})).toThrow(/Name a target/);
    expect(() => parseTarget({ text: "a", id: "b" })).toThrow(/one target/);
    expect(() => parseTarget({ x: 1 })).toThrow(/both x and y/);
    expect(() => parseTarget({ text: "  " })).toThrow(/empty/);
    expect(() => parseTarget({ x: -1, y: 2 })).toThrow(/non-negative/);
  });
});

describe("session store and artifacts", () => {
  const handle = (sessionId: string): LeaseHandle => ({
    provider: "fake",
    leaseId: "l1",
    sessionId,
    platform: "android",
    model: "Pixel 8",
    osVersion: "35",
    physical: false,
    deviceId: "emulator-5554",
    location: { kind: "local", endpoint: "http://127.0.0.1:4701" },
    ttlMs: 60_000,
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    providerData: {},
  });

  it("keeps one record per session, written 0600", async () => {
    const store = new SessionStore(await tmp());
    await store.put({ sessionId: "s1", handle: handle("s1"), updatedAt: "" });
    expect((await store.get("s1"))?.handle.leaseId).toBe("l1");
    expect(await store.get("s2")).toBeUndefined();
    expect((await stat(store.path("s1"))).mode & 0o777).toBe(0o600);
    await store.update("s1", (r) => ({ ...r, keepalivePid: 42 }));
    expect((await store.get("s1"))?.keepalivePid).toBe(42);
    await store.delete("s1");
    expect(await store.get("s1")).toBeUndefined();
  });

  it("records artifacts in a per-session manifest", async () => {
    const store = new LocalArtifactStore(await tmp());
    const path = await store.allocate("claude-code:abc", "screenshot", "png");
    expect(path).toMatch(/screenshot-[0-9a-f]{4}\.png$/);
    await writeFile(path, "png");
    const ref = await store.record({ kind: "screenshot", path, sessionId: "claude-code:abc" });
    expect(ref.bytes).toBe(3);
    expect(await store.list("claude-code:abc")).toHaveLength(1);
    expect(await store.list("other")).toHaveLength(0);
    expect(JSON.parse(await readFile(join(store.sessionDir("claude-code:abc"), "manifest.json"), "utf8"))).toHaveLength(1);
  });
});
