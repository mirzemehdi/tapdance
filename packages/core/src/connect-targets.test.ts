import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, migrateLegacyToken, saveCredentials, targetNameFor, targetToken } from "./config.js";

const N2 = "https://n2-host.tail1.ts.net";
const MAC = "https://mac-mini.tail1.ts.net";

async function home(config?: unknown, credentials?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "td-targets-"));
  if (config !== undefined) await writeFile(join(dir, "config.json"), JSON.stringify(config));
  if (credentials !== undefined) await writeFile(join(dir, "credentials.json"), JSON.stringify(credentials), { mode: 0o600 });
  return dir;
}

describe("connect targets in the configuration", () => {
  it("resolves the user config's targets with their origins", async () => {
    const dir = await home({ provider: "self-hosted", targets: [{ name: "n2", endpoint: `${N2}/`, platforms: ["android"] }, { name: "mac", endpoint: MAC }] });
    const r = await loadConfig({ cwd: dir, env: { TAPDANCE_HOME: dir } });
    expect(r.targets).toEqual([
      { name: "n2", endpoint: `${N2}/`, platforms: ["android"], origin: N2 },
      { name: "mac", endpoint: MAC, origin: MAC },
    ]);
  });

  it("ignores a project file's targets (they decide where tokens go)", async () => {
    const dir = await home({ provider: "self-hosted", targets: [{ name: "n2", endpoint: N2 }] });
    const project = await mkdtemp(join(tmpdir(), "td-proj-"));
    await writeFile(join(project, "tapdance.config.json"), JSON.stringify({ targets: [{ name: "evil", endpoint: "https://evil.example.com" }] }));
    const r = await loadConfig({ cwd: project, env: { TAPDANCE_HOME: dir } });
    expect(r.targets.map((t) => t.name)).toEqual(["n2"]);
    expect(r.warnings.join(" ")).toContain("Ignored targets");
  });

  it("uses one endpoint instead when TAPDANCE_ENDPOINT names one", async () => {
    const dir = await home({ provider: "self-hosted", targets: [{ name: "n2", endpoint: N2 }] });
    const r = await loadConfig({ cwd: dir, env: { TAPDANCE_HOME: dir, TAPDANCE_ENDPOINT: MAC } });
    expect(r.targets).toEqual([]);
    expect(r.config.endpoint).toBe(MAC);
  });

  it("keeps an older single-endpoint config working unchanged (no targets)", async () => {
    const dir = await home({ provider: "self-hosted", endpoint: N2 }, { token: "tdg_old", endpoint: N2 });
    const r = await loadConfig({ cwd: dir, env: { TAPDANCE_HOME: dir } });
    expect(r.targets).toEqual([]);
    expect(r.credentials).toMatchObject({ token: "tdg_old", endpoint: N2 });
  });

  it("rejects a bad target name", async () => {
    const dir = await home({ provider: "self-hosted", targets: [{ name: "Mac Mini", endpoint: MAC }] });
    await expect(loadConfig({ cwd: dir, env: { TAPDANCE_HOME: dir } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("per-origin tokens", () => {
  it("saves tokens per origin, mode 600, merging and removing one origin at a time", async () => {
    const dir = await home();
    const env = { TAPDANCE_HOME: dir };
    await saveCredentials({ tokens: { [`${N2}/some/path`]: "tdg_a" } }, env);
    await saveCredentials({ tokens: { [MAC]: "tdg_b" } }, env);
    const file = join(dir, "credentials.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ tokens: { [N2]: "tdg_a", [MAC]: "tdg_b" } });
    await saveCredentials({ tokens: { [N2]: "" } }, env);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ tokens: { [MAC]: "tdg_b" } });
  });

  it("looks a target's token up by its origin only", () => {
    const credentials = { tokens: { [N2]: "tdg_n2" }, token: "tdg_old", endpoint: MAC };
    expect(targetToken(credentials, N2)).toBe("tdg_n2");
    // The older single token serves only the origin it was saved for.
    expect(targetToken(credentials, MAC)).toBe("tdg_old");
    expect(targetToken(credentials, "https://other.example.com")).toBeUndefined();
    expect(targetToken({ token: "tdg_unbound" }, N2)).toBeUndefined();
  });

  it("migrates an older bound token into the map and drops the single fields", async () => {
    const dir = await home(undefined, { token: "tdg_old", endpoint: N2, operatorToken: "slk_op", operatorEndpoint: N2 });
    expect(await migrateLegacyToken(undefined, { TAPDANCE_HOME: dir })).toBe(N2);
    expect(JSON.parse(await readFile(join(dir, "credentials.json"), "utf8"))).toEqual({ tokens: { [N2]: "tdg_old" }, operatorToken: "slk_op", operatorEndpoint: N2 });
  });

  it("binds an unbound older token to the user config's endpoint when migrating", async () => {
    const dir = await home(undefined, { token: "tdg_unbound" });
    expect(await migrateLegacyToken(MAC, { TAPDANCE_HOME: dir })).toBe(MAC);
    expect(JSON.parse(await readFile(join(dir, "credentials.json"), "utf8"))).toEqual({ tokens: { [MAC]: "tdg_unbound" } });
    // Nothing to move: a no-op.
    expect(await migrateLegacyToken(MAC, { TAPDANCE_HOME: dir })).toBeUndefined();
  });
});

describe("targetNameFor", () => {
  it("names a target after the host's first DNS label, avoiding taken names", () => {
    expect(targetNameFor("https://N2-Host.tail1.ts.net:4720")).toBe("n2-host");
    expect(targetNameFor("http://100.64.0.7:4720")).toBe("100-64-0-7");
    expect(targetNameFor("https://mac.example.com", ["mac", "mac-2"])).toBe("mac-3");
  });
});
