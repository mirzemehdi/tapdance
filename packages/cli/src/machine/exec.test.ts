// realExec with REAL local processes (sh and sleep only): no cloud, ssh or network is involved.
import { describe, expect, it } from "vitest";
import { realExec } from "./exec.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("realExec (real sh and sleep processes)", () => {
  it("returns when the command exits, even though a grandchild keeps its output pipes open", async () => {
    const started = Date.now();
    // The background sleep inherits stdout and stderr and outlives sh.
    const r = await realExec("sh", ["-c", "sleep 20 & echo $!; echo done"], { timeoutMs: 60_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("done");
    const grandchild = Number(r.stdout.split("\n")[0]);
    process.kill(grandchild, "SIGKILL");
  }, 20_000);

  it("on a timeout ends the command and everything it started, with exit 124", async () => {
    const started = Date.now();
    const lines: string[] = [];
    const r = await realExec("sh", ["-c", "sleep 30 & echo $!; wait"], { timeoutMs: 500, onLine: (l) => lines.push(l) });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.code).toBe(124);
    const grandchild = Number(lines[0]);
    expect(grandchild).toBeGreaterThan(0);
    // The whole process group got the signal: the backgrounded sleep is gone too.
    for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((res) => setTimeout(res, 100));
    expect(alive(grandchild)).toBe(false);
  }, 20_000);

  it("reports a missing command as exit 127", async () => {
    expect((await realExec("tapdance-no-such-command-xyz", [])).code).toBe(127);
  });
});
