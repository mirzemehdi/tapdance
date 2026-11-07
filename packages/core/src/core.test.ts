import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalArtifactStore,
  SessionStore,
  TapdanceError,
  loadConfig,
  loadCredentials,
  parseConfig,
  parseTarget,
  redactObject,
  redactSecrets,
  resolveSessionIdentity,
  saveCredentials,
  sanitizeSessionId,
  sessionKey,
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
    // GitHub tokens, as a host with `host gh-login` holds one (fake values).
    expect(redactSecrets("fatal: https://x:ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@github.com")).not.toContain("ghp_aaaa");
    expect(redactSecrets("github_pat_11AAAAAAA0aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe("[REDACTED]");
    expect(redactObject({ token: "abc", nested: { daemonAuthToken: "x", ok: "slk_aaaaaaaaaaaaaaa" } })).toEqual({
      token: "[REDACTED]",
      nested: { daemonAuthToken: "[REDACTED]", ok: "[REDACTED]" },
    });
  });

  it.each([
    ["a worker-guard token", `guard tdg_${"a1B2".repeat(8)} done`],
    ["a JWT", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0YXBkYW5jZSJ9.c2lnbmF0dXJlX3NpZ25hdHVyZQ ok"],
    ["an env-style private key", "ASC_PRIVATE_KEY_B64=LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t"],
    ["the viewer key", `open http://127.0.0.1:9/#k=${"Zx9_".repeat(6)}`],
    ["a Simlock token", "token=slk_d2FybS1wb29sLWFnZW50"],
    ["a bearer header", "Authorization: Bearer abcdefghijklmnop"],
    ["an api key field", '{"apiKey":"sk-live-1234567890"}'],
    ["a key cut off before its BEGIN line", `${"QUJD".repeat(20)}\n-----END PRIVATE KEY-----`],
  ])("redacts %s", (_label, text) => {
    const secret = /tdg_\S+|eyJ\S+|LS0t\S+|#k=\S+|slk_\S+|abcdefghijklmnop|sk-live-\d+|QUJD/.exec(text)![0];
    const out = redactSecrets(text);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(secret.replace(/^#k=/, ""));
  });

  it("leaves ordinary key-ish words and ids alone", () => {
    expect(redactSecrets("key=value1234 and ASC_KEY_ID=ABC123DEF")).toBe("key=value1234 and ASC_KEY_ID=ABC123DEF");
    expect(redactObject({ key: "visible", apiKey: "hidden", joinUrl: "wss://gw/join?t=x" })).toEqual({ key: "visible", apiKey: "[REDACTED]", joinUrl: "[REDACTED]" });
  });

  it("stays fast on long base64-looking output", () => {
    const started = Date.now();
    redactSecrets(`${"A".repeat(200_000)} -----END PRIVATE KEY----- ${"B".repeat(200_000)}`);
    expect(Date.now() - started).toBeLessThan(2_000);
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

  it("session.settleSeconds defaults to 15, takes 0-300, may come from a project file, and TAPDANCE_SETTLE_SECONDS wins", async () => {
    expect(parseConfig({}).session.settleSeconds).toBe(15);
    expect(parseConfig({ session: {} }).session.settleSeconds).toBe(15);
    expect(parseConfig({ session: { settleSeconds: 0 } }).session.settleSeconds).toBe(0);
    expect(() => parseConfig({ session: { settleSeconds: 301 } })).toThrow(/settleSeconds/);
    const home = await tmp();
    const proj = await tmp();
    await writeFile(join(proj, "tapdance.config.json"), JSON.stringify({ session: { settleSeconds: 60 } }));
    const fromProject = await loadConfig({ cwd: proj, env: { TAPDANCE_HOME: home } });
    expect(fromProject.config.session.settleSeconds).toBe(60);
    expect(fromProject.warnings).toEqual([]);
    const fromEnv = await loadConfig({ cwd: proj, env: { TAPDANCE_HOME: home, TAPDANCE_SETTLE_SECONDS: "0", TAPDANCE_TTL_MINUTES: "12" } });
    expect(fromEnv.config.session).toMatchObject({ settleSeconds: 0, defaultTtlMinutes: 12 });
    await expect(loadConfig({ cwd: proj, env: { TAPDANCE_HOME: home, TAPDANCE_SETTLE_SECONDS: "soon" } })).rejects.toThrow(/TAPDANCE_SETTLE_SECONDS must be an integer/);
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

  it("reads security settings only from the user's config", async () => {
    const home = await tmp();
    const proj = await tmp();
    await writeFile(join(proj, "tapdance.config.json"), JSON.stringify({ tools: { paths: { asc: "/bin/sh" }, mcpEnabled: ["fastlane"], allowMutation: ["asc"] }, ios: { axePath: "/tmp/axe" }, simlock: { profilePath: "/tmp/p.json" }, session: { defaultTtlMinutes: 20 } }));
    const r = await loadConfig({ cwd: proj, env: { TAPDANCE_HOME: home } });
    expect(r.config.tools).toEqual({ mcpEnabled: ["asc", "android", "axe", "maestro"], allowMutation: [], paths: {} });
    expect(r.config.ios.axePath).toBeUndefined();
    expect(r.config.simlock.profilePath).toBeUndefined();
    expect(r.config.session.defaultTtlMinutes).toBe(20);
    expect(r.warnings).toHaveLength(5);
    expect(r.warnings[0]).toMatch(/^Ignored tools\.paths from .*tapdance\.config\.json: security settings are read only from ~\/\.tapdance\/config\.json/);

    await writeFile(join(home, "config.json"), JSON.stringify({ tools: { mcpEnabled: ["fastlane"] } }));
    await writeFile(join(proj, "tapdance.config.json"), JSON.stringify({ tools: { mcpEnabled: ["fastlane"] } }));
    const same = await loadConfig({ cwd: proj, env: { TAPDANCE_HOME: home } });
    expect(same.config.tools.mcpEnabled).toEqual(["fastlane"]);
    expect(same.warnings).toEqual([]);
  });

  it("records where the endpoint came from", async () => {
    const home = await tmp();
    const proj = await tmp();
    await writeFile(join(home, "config.json"), JSON.stringify({ endpoint: "https://a.example.com" }));
    expect((await loadConfig({ cwd: proj, env: { TAPDANCE_HOME: home } })).endpointSource).toBe("user");
    await writeFile(join(proj, "tapdance.config.json"), JSON.stringify({ endpoint: "https://a.example.com/" }));
    expect((await loadConfig({ cwd: proj, env: { TAPDANCE_HOME: home } })).endpointSource).toBe("user");
    await writeFile(join(proj, "tapdance.config.json"), JSON.stringify({ endpoint: "https://b.example.com" }));
    expect((await loadConfig({ cwd: proj, env: { TAPDANCE_HOME: home } })).endpointSource).toBe("project");
    expect((await loadConfig({ cwd: proj, env: { TAPDANCE_HOME: home, TAPDANCE_ENDPOINT: "https://c.example.com" } })).endpointSource).toBe("env");
    expect((await loadConfig({ cwd: await tmp(), env: { TAPDANCE_HOME: await tmp() } })).endpointSource).toBeUndefined();
  });

  it("binds saved tokens to an origin, and env tokens to none", async () => {
    const home = await tmp();
    const env = { TAPDANCE_HOME: home };
    await saveCredentials({ token: "slk_aaaaaaaaaaaa", endpoint: "https://gw.example.com/v1/x", operatorToken: "slk_bbbbbbbbbbbb", operatorEndpoint: "https://gw.example.com" }, env);
    expect((await loadCredentials(env)).credentials).toEqual({ token: "slk_aaaaaaaaaaaa", endpoint: "https://gw.example.com", operatorToken: "slk_bbbbbbbbbbbb", operatorEndpoint: "https://gw.example.com" });
    await saveCredentials({ token: "slk_cccccccccccc" }, env);
    expect((await loadCredentials(env)).credentials).toEqual({ token: "slk_cccccccccccc", operatorToken: "slk_bbbbbbbbbbbb", operatorEndpoint: "https://gw.example.com" });
    await saveCredentials({ token: "slk_cccccccccccc", endpoint: "https://gw.example.com" }, env);
    expect((await loadCredentials({ ...env, TAPDANCE_TOKEN: "env-token" })).credentials).toEqual({ token: "env-token", operatorToken: "slk_bbbbbbbbbbbb", operatorEndpoint: "https://gw.example.com" });
    await expect(saveCredentials({ token: "x", endpoint: "not a url" }, env)).rejects.toMatchObject({ code: "USAGE" });
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
    expect(path).toMatch(/screenshot-[0-9a-f]{8}\.png$/);
    await writeFile(path, "png");
    const ref = await store.record({ kind: "screenshot", path, sessionId: "claude-code:abc" });
    expect(ref.bytes).toBe(3);
    expect(await store.list("claude-code:abc")).toHaveLength(1);
    expect(await store.list("other")).toHaveLength(0);
    expect(JSON.parse(await readFile(join(store.sessionDir("claude-code:abc"), "manifest.json"), "utf8"))).toHaveLength(1);
    expect((await stat(join(store.sessionDir("claude-code:abc"), "manifest.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps every artifact when many are recorded at once", async () => {
    const root = await tmp();
    const stores = [new LocalArtifactStore(root), new LocalArtifactStore(root)];
    const refs = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const store = stores[i % 2]!;
        const path = await store.allocate("s1", "screenshot", "png");
        await writeFile(path, "png");
        return store.record({ kind: "screenshot", path, sessionId: "s1" });
      }),
    );
    const listed = await stores[0]!.list("s1");
    expect(listed).toHaveLength(20);
    expect(new Set(listed.map((r) => r.path)).size).toBe(20);
    expect(new Set(listed.map((r) => r.id))).toEqual(new Set(refs.map((r) => r.id)));
  });
});

describe("session lock", () => {
  const timings = { lockWaitMs: 400, lockStaleMs: 1_000, heartbeatMs: 20 };
  const lockOf = (store: SessionStore, sessionId: string) => join(store.dir, `${sessionKey(sessionId)}.lock`);
  async function storeWithLock(content: string, ageMs = 0) {
    const store = new SessionStore(await tmp(), timings);
    await mkdir(store.dir, { recursive: true });
    const lock = lockOf(store, "s");
    await writeFile(lock, content);
    if (ageMs > 0) {
      const then = new Date(Date.now() - ageMs);
      await utimes(lock, then, then);
    }
    return { store, lock };
  }
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", "0"]);
    await new Promise((r) => child.on("exit", r));
    return child.pid!;
  }

  it("does not steal an empty lockfile younger than 2 s", async () => {
    const { store, lock } = await storeWithLock("");
    await expect(store.withLock("s", async () => "ran")).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(await readFile(lock, "utf8")).toBe("");
    const old = new Date(Date.now() - 5_000);
    await utimes(lock, old, old);
    await expect(store.withLock("s", async () => "ran")).resolves.toBe("ran");
  });

  it("takes over a lock left by a dead process, including an old pid-only one", async () => {
    const pid = await deadPid();
    const { store, lock } = await storeWithLock(`${pid}:0123456789abcdef`);
    await expect(store.withLock("s", async () => readFile(lock, "utf8"))).resolves.toMatch(new RegExp(`^${process.pid}:[0-9a-f]{16}$`));
    const legacy = await storeWithLock(String(pid));
    await expect(legacy.store.withLock("s", async () => "ran")).resolves.toBe("ran");
  });

  it("takes over a live holder's lock nobody touched for lockStaleMs", async () => {
    const { store } = await storeWithLock(`${process.ppid}:0123456789abcdef`, 5_000);
    await expect(store.withLock("s", async () => "ran")).resolves.toBe("ran");
  });

  it("never lets two callers in at once", async () => {
    const store = new SessionStore(await tmp(), { lockWaitMs: 20_000 });
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.withLock("s", async () => {
          inside++;
          most = Math.max(most, inside);
          await new Promise((r) => setTimeout(r, 5));
          inside--;
        }),
      ),
    );
    expect(most).toBe(1);
  });

  it("does not delete a lock that someone else holds by the time it finishes", async () => {
    const store = new SessionStore(await tmp(), timings);
    const lock = lockOf(store, "s");
    await store.withLock("s", async () => {
      await writeFile(lock, `${process.ppid}:fedcba9876543210`);
    });
    expect(await readFile(lock, "utf8")).toBe(`${process.ppid}:fedcba9876543210`);
  });

  it("keeps its lock fresh while it works", async () => {
    const store = new SessionStore(await tmp(), timings);
    const lock = lockOf(store, "s");
    await store.withLock("s", async () => {
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      await new Promise((r) => setTimeout(r, 100));
      expect(Date.now() - (await stat(lock)).mtimeMs).toBeLessThan(10_000);
    });
  });

  it("gives up with TIMEOUT after lockWaitMs, naming an earlier call of this process", async () => {
    const other = await storeWithLock(`${process.ppid}:0123456789abcdef`);
    const started = Date.now();
    await expect(other.store.withLock("s", async () => "ran")).rejects.toMatchObject({ code: "TIMEOUT", message: expect.stringMatching(/Another Tapdance process/) });
    expect(Date.now() - started).toBeGreaterThanOrEqual(timings.lockWaitMs);
    const own = await storeWithLock(`${process.pid}:0123456789abcdef`);
    await expect(own.store.withLock("s", async () => "ran")).rejects.toMatchObject({ code: "TIMEOUT", message: expect.stringMatching(/earlier call in this process/), hint: expect.stringMatching(/30 s/) });
  });
});
