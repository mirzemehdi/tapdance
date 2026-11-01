import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
 * up to the comma, brace or parenthesis that ends the value, with nested brackets and strings skipped.
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
  }, 120_000);

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
  }, 120_000);
});
