import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BACKEND_SYNTAX, fromAgentDeviceError, installRefusalHint, repoKeyPath } from "@tapdance/provider-simlock";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));

function tapdance(args: string[], env: Record<string, string> = {}, input?: string) {
  const home = env["TAPDANCE_HOME"] ?? mkdtempSync(join(tmpdir(), "td-cli-"));
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "td-cwd-")),
    env: { PATH: process.env["PATH"] ?? "", TAPDANCE_HOME: home, TAPDANCE_SESSION_ID: "cli-test", ...env },
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Non-test TypeScript files under a directory. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) return [];
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith(".ts") && !e.name.includes(".test.") ? [full] : [];
  });
}

/**
 * The string literals in every `hint:` and `fix:` value of a source file: the text after the colon
 * up to the comma, brace, parenthesis or semicolon that ends the value, with nested brackets and
 * strings skipped. (A semicolon ends a declaration such as `let hint: string;`, whose "value" would
 * otherwise run on through the code that follows.)
 */
function hintStrings(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/\b(?:hint|fix)\s*:/g)) {
    let i = m.index + m[0].length;
    let depth = 0;
    for (; i < source.length; i++) {
      const ch = source[i]!;
      if (ch === '"' || ch === "'" || ch === "`") {
        let j = i + 1;
        while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
        found.push(source.slice(i + 1, j));
        i = j;
      } else if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ";" && depth === 0) break;
      else if (ch === ")" || ch === "]" || ch === "}" || ch === ",") {
        if (depth === 0) break;
        if (ch !== ",") depth--;
      }
    }
  }
  return found;
}

describe("tapdance CLI (built)", () => {
  it("prints its version", () => {
    expect(tapdance(["--version"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("answers NO_ACTIVE_LEASE with exit 3 and JSON on stdout", () => {
    const r = tapdance(["--json", "screenshot"], { TAPDANCE_PROVIDER: "self-hosted", TAPDANCE_ENDPOINT: "https://gw.example.com", TAPDANCE_TOKEN: "slk_testtesttest" });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: { code: "NO_ACTIVE_LEASE", retryable: false } });
  });

  it("refuses bad arguments with exit 2", () => {
    expect(tapdance(["--json", "device", "lease", "--platform", "windows"]).code).toBe(2);
    expect(tapdance(["ui", "tap"]).code).toBe(2);
    expect(tapdance(["nonsense-command"]).code).toBe(2);
  });

  // Review: numbers were taken as given (NaN, negatives, out of range); refused like MCP refuses them.
  it("refuses bad numeric options with exit 2 USAGE before touching a device", () => {
    const env = { TAPDANCE_PROVIDER: "self-hosted", TAPDANCE_ENDPOINT: "https://gw.example.com", TAPDANCE_TOKEN: "slk_testtesttest" };
    const cases: Array<[string[], string]> = [
      [["device", "setting", "location", "--lat", "91", "--lon", "0"], "--lat"],
      [["device", "setting", "location", "--lat", "abc", "--lon", "0"], "--lat"],
      [["device", "setting", "location", "--lat", "10", "--lon", "-181"], "--lon"],
      [["device", "shell", "--timeout", "-5", "--", "id"], "--timeout"],
      [["device", "shell", "--timeout", "abc", "--", "id"], "--timeout"],
      [["ui", "tap", "--text", "OK", "--settle-ms", "5"], "--settle-ms"],
      [["ui", "tap", "--text", "OK", "--settle-ms", "abc"], "--settle-ms"],
      [["view", "--port", "abc"], "--port"],
      [["view", "--port", "70000"], "--port"],
      [["mcp", "--http", "--port", "abc"], "--port"],
      [["worker", "guard", "audit", "-n", "abc"], "--lines"],
      [["worker", "guard", "audit", "-n", "0"], "--lines"],
    ];
    for (const [args, flag] of cases) {
      const r = tapdance(["--json", ...args], env);
      expect({ args, code: r.code }).toEqual({ args, code: 2 });
      expect(JSON.parse(r.stdout).error).toMatchObject({ code: "USAGE", message: expect.stringContaining(flag) });
    }
  });

  // Review: revoke matches ids only, and `revoke <label>` used to revoke nothing and exit 0.
  it("worker guard revoke refuses an id that matches no active pairing", () => {
    const r = tapdance(["--json", "worker", "guard", "revoke", "my-laptop"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: "USAGE", hint: expect.stringContaining("tapdance worker guard tokens") });
  });

  // Review: under `curl | bash` a cut-off download must run nothing, so the body is one { … } block.
  it("host-setup.sh is one block that bash parses before it runs anything", () => {
    const script = readFileSync(join(root, "scripts/host-setup.sh"), "utf8");
    const lines = script.split("\n").filter((l) => l.trim() !== "");
    expect(lines.at(-1)).toBe("}");
    expect(lines.find((l) => !l.startsWith("#"))).toBe("{");
    // Parse only (`-n`): the whole script parses, and a download cut off half-way does not.
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
    expect(spawnSync("bash", ["-n"], { input: script.slice(0, Math.floor(script.length / 2)) }).status).not.toBe(0);
  });

  // #131: `ui inspect` prints refs like @e3~s1, and agents pass one as the argument.
  it("ui tap takes a ref as its argument and points other text at --text", () => {
    const env = { TAPDANCE_PROVIDER: "self-hosted", TAPDANCE_ENDPOINT: "https://gw.example.com", TAPDANCE_TOKEN: "slk_testtesttest" };
    expect(JSON.parse(tapdance(["--json", "ui", "tap", "@e3~s152203"], env).stdout).error).toMatchObject({ code: "NO_ACTIVE_LEASE" });
    const wrong = tapdance(["--json", "ui", "tap", "Sign in"], env);
    expect(wrong.code).toBe(2);
    expect(JSON.parse(wrong.stdout).error).toMatchObject({ code: "USAGE", hint: expect.stringContaining('--text "Sign in"') });
  });

  it("run: refuses a bad scenario with exit 2 and needs a device (exit 3) before any step", () => {
    const dir = mkdtempSync(join(tmpdir(), "td-scn-"));
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "name: bad\nsteps:\n  - tapp: { text: Sign in }\n");
    const r = tapdance(["--json", "run", bad]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: "USAGE", message: expect.stringContaining('Unknown step type "tapp"') });
    expect(tapdance(["--json", "run", join(dir, "missing.yaml")]).code).toBe(2);
    const ok = join(dir, "ok.json");
    writeFileSync(ok, JSON.stringify({ name: "ok", steps: [{ press_key: { key: "home" } }] }));
    const none = tapdance(["--json", "run", ok]);
    expect(none.code).toBe(3);
    expect(JSON.parse(none.stdout).error.code).toBe("NO_ACTIVE_LEASE");
  });

  it("refuses a token in config", () => {
    const r = tapdance(["--json", "config", "set", "token", "x"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("Tokens never go in config files");
  });

  it("explains the missing cloud provider", () => {
    const r = tapdance(["--json", "devices"], { TAPDANCE_PROVIDER: "cloud" });
    expect(r.code).toBe(8);
    expect(JSON.parse(r.stdout).error.code).toBe("NOT_SUPPORTED");
  });

  it("init --mode local points first at worker install, as the quick start does", () => {
    const r = tapdance(["init", "--mode", "local", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("tapdance worker install");
    expect(r.stdout).not.toContain("tapdance worker start");
  });

  it("binds a stored token to the endpoint it was given", () => {
    const home = mkdtempSync(join(tmpdir(), "td-cli-"));
    const r = tapdance(["--json", "config", "set-token", "--endpoint", "https://gw.example"], { TAPDANCE_HOME: home }, "slk_testtoken\n");
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ kind: "agent", endpoint: "https://gw.example" });
    const file = join(home, "credentials.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ token: "slk_testtoken", endpoint: "https://gw.example" });
  });

  it("binds a token to the configured endpoint by default and refuses plain http to a public host", () => {
    const home = mkdtempSync(join(tmpdir(), "td-cli-"));
    const env = { TAPDANCE_HOME: home, TAPDANCE_PROVIDER: "self-hosted", TAPDANCE_ENDPOINT: "https://gateway.example.com/v1/agent-device" };
    const r = tapdance(["--json", "config", "set-token", "--operator"], env, "slk_operator\n");
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "credentials.json"), "utf8"))).toEqual({ operatorToken: "slk_operator", operatorEndpoint: "https://gateway.example.com" });
    const plain = tapdance(["--json", "config", "set-token", "--endpoint", "http://gateway.example.com"], {}, "slk_x\n");
    expect(plain.code).toBe(2);
    expect(JSON.parse(plain.stdout)).toMatchObject({ error: { code: "USAGE" } });
    expect(tapdance(["--json", "config", "set-token", "--endpoint", "http://100.101.102.103:4720"], {}, "slk_x\n").code).toBe(0);
  });

  it("host builds files and key --repo: validate their arguments and never print a file's content", () => {
    const home = mkdtempSync(join(tmpdir(), "td-cli-"));
    const env = { TAPDANCE_HOME: home };
    const repo = "https://github.com/acme/app";
    const file = join(home, "google-services.json");
    writeFileSync(file, '{"api_key":"FILE_SECRET_CONTENT"}');
    expect(tapdance(["host", "builds", "files", "add", "--repo", "file:///etc", "a.json", "--from", file], env).code).toBe(2);
    for (const bad of ["/etc/passwd", "../x", ".git/config", "sub/.git/hooks/post-checkout"]) {
      const r = tapdance(["host", "builds", "files", "add", "--repo", repo, bad, "--from", file], env);
      expect(r.code, bad).toBe(2);
    }
    expect(tapdance(["host", "builds", "files", "add", "--repo", repo, "a.json", "--from", join(home, "missing")], env).code).toBe(2);
    const big = join(home, "big.bin");
    writeFileSync(big, Buffer.alloc(1024 * 1024 + 1));
    expect(tapdance(["host", "builds", "files", "add", "--repo", repo, "big.bin", "--from", big], env).stderr).toMatch(/larger than 1 MB/);
    expect(tapdance(["host", "builds", "files", "add", "--repo", repo, "empty.txt"], env).code).toBe(2); // nothing on stdin
    expect(tapdance(["host", "builds", "files", "add", "--repo", repo, "androidApp/google-services.json", "--from", file], env).code).toBe(0);
    expect(tapdance(["--json", "host", "builds", "files", "add", "--repo", repo, "local.properties"], env, "sdk.dir=STDIN_SECRET_CONTENT\n").code).toBe(0);
    const listed = tapdance(["--json", "host", "builds", "files", "list"], env);
    expect(listed.code).toBe(0);
    const rows = (JSON.parse(listed.stdout) as { files: Array<{ path: string; size: number; sha256: string }> }).files;
    expect(rows.map((f) => f.path)).toEqual(["androidApp/google-services.json", "local.properties"]);
    expect(rows.every((f) => /^[0-9a-f]{8}$/.test(f.sha256))).toBe(true);
    expect(listed.stdout + tapdance(["host", "builds", "files", "list", "--repo", repo], env).stdout).not.toMatch(/SECRET_CONTENT/);
    expect(tapdance(["host", "builds", "files", "remove", "--repo", repo, "local.properties"], env).code).toBe(0);
    expect(tapdance(["host", "builds", "files", "remove", "--repo", repo, "local.properties"], env).code).toBe(2);
    expect(tapdance(["host", "builds", "key", "--repo", "file:///etc"], env).code).toBe(2);
    expect(tapdance(["host", "builds", "files", "list", "--repo", "not a url"], env).code).toBe(2);
  }, 30_000);

  it("logs: --contains, --level and --lines are checked before any lease (#82)", () => {
    for (const args of [
      ["logs", "--level", "warning"],
      ["logs", "--contains", "x".repeat(201)],
      ["logs", "-n", "20001"],
      ["logs", "-n", "0"],
    ]) {
      const r = tapdance(["--json", ...args]);
      expect(r.code, args.join(" ")).toBe(2);
      expect(JSON.parse(r.stdout), args.join(" ")).toMatchObject({ error: { code: "USAGE" } });
    }
    expect(tapdance(["--json", "logs", "--contains", "ANR in", "--level", "error", "-n", "20000"]).code).toBe(3);
  });

  it("host builds: key --remove, the deploy key column, --check without git, and refusals before any guard restart (#86 #87)", () => {
    // PATH without git or gh: --check reports that it could not run, and nothing reaches a network.
    const home = mkdtempSync(join(tmpdir(), "td-cli-"));
    const env = { TAPDANCE_HOME: home, PATH: "/nonexistent" };
    const ssh = "git" + "@github.com:KAppMakerDeveloperApps/Pianolune-All.git";
    const https = "https://github.com/KAppMakerDeveloperApps/Pianolune-All";
    const builds = join(home, "worker", "builds");
    mkdirSync(join(builds, "keys"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "worker", "policy.json"), JSON.stringify({ allow: { builds: true }, builds: { repos: [ssh, https], gitAuth: "gh" } }), { mode: 0o600 });
    const status = () => JSON.parse(tapdance(["--json", "host", "builds", "status"], env).stdout) as { repositories: Array<{ repo: string; deployKey: string; keyFingerprint?: string }>; gradleDaemonIdleMinutes: number };
    expect(status().gradleDaemonIdleMinutes).toBe(10);
    expect(status().repositories.map((r) => r.deployKey)).toEqual(["none", "none"]);
    // A key where `host builds key --repo` leaves it (written here without ssh-keygen): GitHub's published host key.
    const key = repoKeyPath(builds, ssh);
    writeFileSync(key, "PRIVATE", { mode: 0o600 });
    writeFileSync(`${key}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl tapdance-builds@host\n");
    const fingerprint = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";
    // The ssh URL uses it; the https URL of the same repository never does.
    expect(status().repositories).toMatchObject([
      { repo: ssh, deployKey: "own", keyFingerprint: fingerprint },
      { repo: https, deployKey: "unused-https" },
    ]);
    expect(tapdance(["host", "builds", "status"], env).stdout).toContain("not used (https)");
    const removed = tapdance(["host", "builds", "key", "--repo", https, "--remove"], env);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toContain(fingerprint);
    expect(removed.stdout).toContain("https://github.com/KAppMakerDeveloperApps/Pianolune-All/settings/keys");
    expect(existsSync(key) || existsSync(`${key}.pub`)).toBe(false);
    const removeMissing = tapdance(["--json", "host", "builds", "key", "--repo", ssh, "--remove"], env);
    expect(removeMissing.code).toBe(2);
    expect(JSON.parse(removeMissing.stdout)).toMatchObject({ error: { code: "USAGE", message: expect.stringContaining("github.com/KAppMakerDeveloperApps/Pianolune-All") } });
    // Not on the list: refused before the policy changes or the guard restarts.
    expect(tapdance(["host", "builds", "disable", "--repo", "https://github.com/acme/other"], env).code).toBe(2);
    expect(JSON.parse(readFileSync(join(home, "worker", "policy.json"), "utf8"))).toMatchObject({ allow: { builds: true }, builds: { repos: [ssh, https] } });
    expect(tapdance(["host", "builds", "enable", "--repo", https, "--gradle-idle-minutes", "-1"], env).code).toBe(2);
    expect(tapdance(["host", "artifacts", "disable", "--repo", "acme/other"], env).code).toBe(2);
    const checked = tapdance(["--json", "host", "builds", "status", "--check"], env);
    expect(checked.code, checked.stderr).toBe(0);
    const access = (JSON.parse(checked.stdout) as { repositories: Array<{ access?: { ok: boolean } }> }).repositories.map((r) => r.access?.ok);
    expect(access).toEqual([false, false]);
  }, 60_000);

  it("app install: a path or --from-ci with --artifact, never both; refused with exit 2 before any lease", () => {
    for (const args of [
      ["app", "install"],
      ["app", "install", "./app.apk", "--from-ci", "acme/app", "--artifact", "app-debug"],
      ["app", "install", "--from-ci", "acme/app"],
      ["app", "install", "--from-ci", "acme/app", "--artifact", "app-debug", "--run", "42", "--branch", "main"],
      ["app", "install", "--from-ci", "acme/app", "--artifact", "app-debug", "--run", "42;id"],
      ["app", "install", "--from-ci", "acme/app", "--artifact", "app-debug", "--app-id", "com.x"],
      ["app", "install", "./app.apk", "--artifact", "app-debug"],
      ["app", "install", "./app.apk", "--run", "42"],
    ]) {
      const r = tapdance(["--json", ...args]);
      expect(r.code, args.join(" ")).toBe(2);
      expect(JSON.parse(r.stdout), args.join(" ")).toMatchObject({ error: { code: "USAGE" } });
    }
    // A valid request gets as far as needing a device.
    expect(tapdance(["--json", "app", "install", "--from-ci", "acme/app", "--artifact", "app-debug", "--branch", "main"]).code).toBe(3);
  }, 60_000);

  it("host artifacts: enable validates repositories, branches and the size limit; status reads the owner's policy", () => {
    // enable and disable restart the guard service on success, so only their refusals run here; PATH
    // without gh keeps `status` from running the real gh.
    const home = mkdtempSync(join(tmpdir(), "td-cli-"));
    const env = { TAPDANCE_HOME: home, PATH: "/nonexistent" };
    for (const bad of [
      ["--repo", "https://gitlab.com/acme/app"],
      ["--repo", "acme/app;id"],
      ["--repo", "acme/app/extra"],
      ["--repo", "acme/app", "--branch", "../main"],
      ["--repo", "acme/app", "--max-mb", "0"],
    ]) {
      expect(tapdance(["host", "artifacts", "enable", ...bad], env).code, bad.join(" ")).toBe(2);
    }
    const dir = join(home, "worker");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ allow: { artifacts: true }, artifacts: { repos: ["acme/app"], branches: ["main"], maxMB: 300 } }), { mode: 0o600 });
    const status = tapdance(["--json", "host", "artifacts", "status"], env);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ enabled: true, repos: ["acme/app"], branches: ["main"], maxMB: 300, cacheBytes: 0, ghReady: false });
  }, 60_000);

  it("hints never name a bare simlock command or a global npm install", () => {
    const bad: string[] = [];
    for (const dir of ["cli", "provider-simlock", "sdk", "core", "mcp"]) {
      for (const file of sourceFiles(join(root, "packages", dir, "src"))) {
        for (const text of hintStrings(readFileSync(file, "utf8"))) {
          if (/(?<!tapdance )\bsimlock /.test(text) || /npm (i|install) -g/.test(text)) bad.push(`${file.replace(root, "")}: ${text}`);
        }
      }
    }
    expect(bad).toEqual([]);
    // The extractor itself must see the hints, or the check above proves nothing.
    expect(hintStrings('x({ hint: "a" + `b ${c}`, fix: d ? "e" : "f", other: "g" })')).toEqual(["a", "b ${c}", "e", "f"]);
    expect(hintStrings('let hint: string | undefined; const x = "not a hint";')).toEqual([]);
  });

  it("hints name only MCP tools that exist, never agent-device's own CLI syntax or <appId> (#108, #109)", async () => {
    const { TOOLS } = await import("@tapdance/mcp");
    const tools = new Set(TOOLS.map((t) => t.name));
    // The first word of every multi-word tool name: a snake_case word that starts with one of them is
    // meant as a tool (get_logs, launch_app), so it must be one.
    const verbs = new Set(TOOLS.filter((t) => t.name.includes("_")).map((t) => t.name.split("_")[0]!));
    const agentDeviceOnly = /snapshot -i|\bfind <|--debug\b|diagnostics log|--save-script|\bopen <app>/;
    const bad: string[] = [];
    for (const dir of ["cli", "provider-simlock", "sdk", "core", "mcp"]) {
      for (const file of sourceFiles(join(root, "packages", dir, "src"))) {
        for (const text of hintStrings(readFileSync(file, "utf8"))) {
          const where = `${file.replace(root, "")}: ${text}`;
          if (agentDeviceOnly.test(text)) bad.push(`agent-device syntax in ${where}`);
          // Every app-specific hint knows its app: name it, or say where to find it (#109).
          if (/<app-?id>/i.test(text)) bad.push(`placeholder in ${where}`);
          for (const m of text.matchAll(/\b([a-z]+)_[a-z_]+\b/g)) if (verbs.has(m[1]!) && !tools.has(m[0])) bad.push(`no MCP tool ${m[0]} in ${where}`);
        }
      }
    }
    expect(bad).toEqual([]);

    // agent-device's own hints, passed through the error mapping, come out without its syntax (#108).
    const backend = [
      { code: "ELEMENT_NOT_FOUND", message: 'Selector did not match: text="No such button"', details: { hint: 'Selector text/label values match exactly (quote multi-word values: text="Sign in"). Run snapshot -i to see current elements and refs, or use find <text> for contains matching.' } },
      { code: "COMMAND_FAILED", message: "Android helper could not launch the application", details: { hint: "Retry with --debug and inspect diagnostics log for details." } },
      { code: "COMMAND_FAILED", message: "fill failed", details: { hint: "The tap most likely missed the field. Re-check the target with snapshot -i and fill the element it reports, rather than retrying the same coordinates." } },
      { code: "COMMAND_FAILED", message: "session closed", details: { hint: "Close this session and start a fresh one with open <app> --save-script[=<path>]." } },
      { code: "AMBIGUOUS_MATCH", message: "find matched 2 elements", details: { hint: "Multiple candidates matched. Narrow the query or pass an exact identifier." } },
    ];
    for (const e of backend) {
      const hint = fromAgentDeviceError(e, "tap").hint ?? "";
      expect(hint, e.details.hint).not.toMatch(BACKEND_SYNTAX);
      expect(hint).not.toMatch(agentDeviceOnly);
    }
    // An install refusal names the package when it is known, and never prints a placeholder.
    for (const reason of ["INSTALL_SIGNATURE", "INSTALL_DOWNGRADE", "INSTALL_STORAGE"] as const) {
      for (const surface of ["cli", "mcp", "both"] as const) {
        expect(installRefusalHint(reason, undefined, surface)).not.toMatch(/<[A-Za-z-]+>/);
        const named = installRefusalHint(reason, "com.example.app", surface);
        expect(named).not.toMatch(/<[A-Za-z-]+>/);
        if (reason !== "INSTALL_STORAGE") expect(named).toContain("com.example.app");
      }
    }
  });

  it("every docs page named in code exists", () => {
    const missing: string[] = [];
    for (const file of [...sourceFiles(join(root, "packages")), join(root, "scripts/host-setup.sh")]) {
      for (const m of readFileSync(file, "utf8").matchAll(/docs\/[A-Za-z0-9_./-]+\.md/g)) {
        if (!existsSync(join(root, m[0]))) missing.push(`${file.replace(root, "")}: ${m[0]}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it("only names commands that exist, in code hints and in every doc", () => {
    const help = (args: string[]) => tapdance([...args, "--help"]).stdout;
    const known = new Set<string>();
    const walk = (path: string[]) => {
      const section = help(path).split("Commands:")[1] ?? "";
      for (const line of section.split("\n")) {
        const name = /^\s{2}([a-z][a-z-]*)/.exec(line)?.[1];
        if (!name || name === "help") continue;
        const full = [...path, name].join(" ");
        if (known.has(full)) continue;
        known.add(full);
        if (path.length < 2) walk([...path, name]);
      }
    };
    walk([]);
    const hasChildren = (prefix: string) => [...known].some((k) => k.startsWith(`${prefix} `));
    const files = (dir: string, ext: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) return [];
        const full = join(dir, e.name);
        if (e.isDirectory()) return files(full, ext);
        return e.name.endsWith(ext) && !e.name.includes(".test.") ? [full] : [];
      });
    const sources = [...files(join(root, "packages"), ".ts"), ...files(join(root, "docs"), ".md"), ...files(join(root, "infrastructure"), ".md"), ...files(join(root, "infrastructure"), ".sh"), ...files(join(root, "examples"), ".md"),
      ...["README.md", "CONTRIBUTING.md", "SECURITY.md", "AGENTS.md", "CLAUDE.md"].map((f) => join(root, f))];
    const missing: string[] = [];
    for (const file of sources) {
      for (const m of readFileSync(file, "utf8").matchAll(/(?<![\w@/.-])tapdance((?: [a-z][a-z-]*){1,3})/g)) {
        // Walk the words: wherever the command so far has subcommands, the next word must be one of them.
        let prefix = "";
        const words = m[1]!.trim().split(" ");
        if (["and", "is", "are", "the", "to", "with", "on", "for", "in", "can", "will", "itself"].includes(words[0]!)) continue; // prose
        for (const word of words) {
          if (prefix !== "" && !hasChildren(prefix)) break; // the rest are arguments
          const next = prefix ? `${prefix} ${word}` : word;
          if (!known.has(next)) {
            missing.push(`${file.replace(root, "")}: tapdance ${next}`);
            break;
          }
          prefix = next;
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  }, 300_000);

  it("documents every command, MCP tool and config key in its reference page", async () => {
    const help = (args: string[]) => tapdance([...args, "--help"]).stdout;
    const commands: string[] = [];
    const walk = (path: string[]) => {
      const section = help(path).split("Commands:")[1] ?? "";
      for (const line of section.split("\n")) {
        const name = /^\s{2}([a-z][a-z-]*)/.exec(line)?.[1];
        if (!name || name === "help") continue;
        commands.push([...path, name].join(" "));
        if (path.length < 2) walk([...path, name]);
      }
    };
    walk([]);
    const cliRef = readFileSync(join(root, "docs/cli-reference.md"), "utf8");
    const undocumented = [...new Set(commands)].filter((c) => !cliRef.includes(`tapdance ${c}`));
    const { TOOLS } = await import("@tapdance/mcp");
    const mcpRef = readFileSync(join(root, "docs/mcp.md"), "utf8");
    const missingTools = TOOLS.map((t) => t.name).filter((n) => !mcpRef.includes(`\`${n}\``));
    const { ConfigSchema } = await import("@tapdance/core");
    const configRef = readFileSync(join(root, "docs/configuration.md"), "utf8");
    const keys: string[] = [];
    const shape = (ConfigSchema as unknown as { shape: Record<string, unknown> }).shape;
    for (const [k, v] of Object.entries(shape)) {
      if (k === "$schema") continue;
      const inner = (v as { _zod?: { def?: { innerType?: { shape?: Record<string, unknown> } } } })._zod?.def?.innerType?.shape;
      if (inner) for (const sub of Object.keys(inner)) keys.push(`${k}.${sub}`);
      else keys.push(k);
    }
    const missingKeys = keys.filter((k) => !configRef.includes(k));
    const stale = spawnSync(process.execPath, [join(root, "scripts/gen-cli-index.mjs"), "--check"], { encoding: "utf8" });
    expect(stale.status, stale.stderr).toBe(0);
    expect({ undocumented, missingTools, missingKeys }).toEqual({ undocumented: [], missingTools: [], missingKeys: [] });
  }, 300_000);
});

describe("repository URL", () => {
  it("every clone command and package points at the repository package.json declares", () => {
    const declared = (JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")) as { repository: { url: string } }).repository.url.replace(/\.git$/, "");
    for (const pkg of ["core", "sdk", "mcp", "provider-simlock"]) {
      const url = (JSON.parse(readFileSync(join(root, `packages/${pkg}/package.json`), "utf8")) as { repository: { url: string } }).repository.url.replace(/\.git$/, "");
      expect(url, pkg).toBe(declared);
    }
    for (const file of ["README.md", "docs/installation.md", "docs/deployment/gateway-mode.md", "docs/deployment/local.md", "docs/testing/field-testing.md"]) {
      for (const m of readFileSync(join(root, file), "utf8").matchAll(/git clone (https:\/\/github\.com\/[^\s]+?)(?:\.git)?(?=\s)/g)) {
        expect(m[1], file).toBe(declared);
      }
    }
  });
});
