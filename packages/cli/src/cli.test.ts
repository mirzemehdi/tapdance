import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));

function tapdance(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "td-cli-"));
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "td-cwd-")),
    env: { PATH: process.env["PATH"] ?? "", TAPDANCE_HOME: home, TAPDANCE_SESSION_ID: "cli-test", ...env },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
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

  it("only names commands that exist in hints and docs", () => {
    const help = (args: string[]) => tapdance([...args, "--help"]).stdout;
    const known = new Set<string>();
    const walk = (path: string[]) => {
      const text = help(path);
      const section = text.split("Commands:")[1] ?? "";
      for (const line of section.split("\n")) {
        const name = /^\s{2}([a-z][a-z-]*)/.exec(line)?.[1];
        if (!name || name === "help") continue;
        const full = [...path, name].join(" ");
        if (known.has(full)) continue;
        known.add(full);
        if (path.length < 1) walk([...path, name]);
      }
    };
    walk([]);
    const sources = [
      ...readdirSync(join(root, "packages")).flatMap((p) => {
        try {
          return readdirSync(join(root, "packages", p, "src")).filter((f) => f.endsWith(".ts") && !f.includes(".test.")).map((f) => join(root, "packages", p, "src", f));
        } catch {
          return [];
        }
      }),
    ];
    const missing: string[] = [];
    for (const file of sources) {
      for (const m of readFileSync(file, "utf8").matchAll(/`tapdance ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
        const [one, two] = [m[1]!, m[2]];
        if (known.has(`${one} ${two}`) || (known.has(one) && (two === undefined || !known.has(`${one} ${two}`)))) continue;
        missing.push(`${file.replace(root, "")}: tapdance ${one} ${two ?? ""}`);
      }
    }
    expect(missing).toEqual([]);
  }, 60_000);
});
