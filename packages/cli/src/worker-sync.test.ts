import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncAgentDeviceCommand } from "./commands-worker.js";
import { agentDeviceBin } from "./context.js";

describe("worker start/restart keeps Simlock on this Tapdance's agent-device", () => {
  const out = { progress: () => undefined };

  it("rewrites a stale path left by an earlier install (a patched agent-device moves folders)", async () => {
    const home = await mkdtemp(join(tmpdir(), "td-simlock-"));
    await writeFile(join(home, "config.json"), JSON.stringify({ capabilities: { "agent-device": { command: "/old/node_modules/.pnpm/agent-device@0.21.35/node_modules/agent-device/bin/agent-device.mjs" } } }));
    const set: string[] = [];
    expect(await syncAgentDeviceCommand(out, home, async (p) => void set.push(p))).toBe(true);
    expect(set).toEqual([agentDeviceBin()]);
  });

  it("leaves a current path, a worker without the capability and a missing config alone", async () => {
    const home = await mkdtemp(join(tmpdir(), "td-simlock-"));
    const set: string[] = [];
    const record = async (p: string) => void set.push(p);
    expect(await syncAgentDeviceCommand(out, home, record)).toBe(false);
    await writeFile(join(home, "config.json"), JSON.stringify({ capabilities: { "agent-device": { command: agentDeviceBin() } } }));
    expect(await syncAgentDeviceCommand(out, home, record)).toBe(false);
    await writeFile(join(home, "config.json"), JSON.stringify({ capabilities: {} }));
    expect(await syncAgentDeviceCommand(out, home, record)).toBe(false);
    expect(set).toEqual([]);
  });
});
