import { existsSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Real devices, no mocks: runs the built `tapdance mcp` over stdio against a running Simlock worker
 * on this machine. Opt in with TAPDANCE_IT_PLATFORM=ios or android (and optionally
 * TAPDANCE_IT_DEVICE, TAPDANCE_IT_OS, TAPDANCE_IT_APP for an .apk/.app to install, and
 * TAPDANCE_IT_APP_ID). Set TAPDANCE_IT_ENDPOINT and TAPDANCE_IT_TOKEN to run the same loop through a
 * Simlock gateway (self-hosted provider). Skipped — and reported as skipped — otherwise.
 */
const platform = process.env["TAPDANCE_IT_PLATFORM"] as "ios" | "android" | undefined;
const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));

describe.skipIf(!platform)(`MCP over stdio on a real ${platform ?? "(unset)"} device`, () => {
  let client: Client | undefined;
  const results: Record<string, unknown> = {};

  afterAll(async () => {
    await client?.callTool({ name: "release_device", arguments: {} }).catch(() => undefined);
    await client?.close();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client!.callTool({ name, arguments: args }, undefined, { timeout: 330_000 })) as { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };
    const text = r.content.find((c) => c.type === "text")?.text ?? "{}";
    const json = (() => {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { raw: text };
      }
    })();
    results[name] = json;
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    return { json, content: r.content };
  };

  it("runs an agent's whole loop", async () => {
    expect(existsSync(cli), "build first: pnpm build").toBe(true);
    const home = await mkdtemp(join(tmpdir(), "td-it-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "td-it-proj-"));
    client = new Client({ name: "tapdance-it", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "mcp"],
        cwd,
        env: {
          ...(process.env as Record<string, string>),
          TAPDANCE_HOME: home,
          TAPDANCE_SESSION_ID: `it-${process.pid}`,
          ...(process.env["TAPDANCE_IT_APP"] ? { TAPDANCE_ALLOWED_ROOTS: dirname(process.env["TAPDANCE_IT_APP"]) } : {}),
          ...(process.env["TAPDANCE_IT_ENDPOINT"]
            ? { TAPDANCE_PROVIDER: "self-hosted", TAPDANCE_ENDPOINT: process.env["TAPDANCE_IT_ENDPOINT"], TAPDANCE_TOKEN: process.env["TAPDANCE_IT_TOKEN"] ?? "" }
            : { TAPDANCE_PROVIDER: "local" }),
        },
        stderr: "inherit",
      }),
    );

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(19);

    const leased = await call("lease_device", {
      platform,
      ...(process.env["TAPDANCE_IT_DEVICE"] ? { device: process.env["TAPDANCE_IT_DEVICE"] } : {}),
      ...(process.env["TAPDANCE_IT_OS"] ? { os_version: process.env["TAPDANCE_IT_OS"] } : {}),
      ttl_minutes: 15,
    });
    expect(leased.json).toMatchObject({ device: { platform, state: "active" } });

    const appPath = process.env["TAPDANCE_IT_APP"];
    let appId = process.env["TAPDANCE_IT_APP_ID"] ?? (platform === "ios" ? "com.apple.Preferences" : "com.android.settings");
    if (appPath) {
      const installed = await call("install_app", { path: appPath });
      appId = ((installed.json["installed"] as { appId?: string }).appId ?? appId) as string;
    }
    await call("launch_app", { app_id: appId, relaunch: true });

    const screen = await call("inspect_screen");
    const elements = screen.json["elements"] as Array<{ ref: string; label?: string; role: string }>;
    expect(elements.length).toBeGreaterThan(0);

    await call("start_recording");
    const tappable = elements.find((e) => e.label && /cell|button|text|other/.test(e.role) && e.ref !== "@e1") ?? elements[0]!;
    const tapped = await call("tap", { ref: tappable.ref });
    expect(tapped.json).toMatchObject({ ok: true });
    await call("press_key", { key: "back" }).catch(() => undefined);
    const waited = await call("wait_for", { stable: true, timeout_ms: 5000 });
    expect(waited.json).toHaveProperty("found");
    const alert = await call("handle_alert", { action: "get" });
    expect(alert.json).toHaveProperty("present");
    await call("swipe", { direction: "up" });

    const shot = await call("take_screenshot", { note: "integration test" });
    expect(shot.content.some((c) => c.type === "image" && (c.data?.length ?? 0) > 1000)).toBe(true);
    const shotPath = (shot.json["artifact"] as { path: string }).path;
    expect(statSync(shotPath).size).toBeGreaterThan(1000);

    const video = await call("stop_recording");
    const videoPath = (video.json["artifact"] as { path: string }).path;
    expect(statSync(videoPath).size).toBeGreaterThan(10_000);

    const logs = await call("get_logs", { lines: 50 });
    expect((logs.json["lines"] as string[]).length).toBeGreaterThan(0);
    await call("get_crash_logs", { lines: 20 });

    const artifacts = await call("get_test_artifacts");
    expect((artifacts.json["artifacts"] as unknown[]).length).toBeGreaterThanOrEqual(4);

    const registry = await call("list_tools");
    expect((registry.json["tools"] as Array<{ name: string }>).map((t) => t.name)).toContain("asc");
    if ((registry.json["tools"] as Array<{ name: string; installed: boolean }>).find((t) => t.name === "asc")?.installed) {
      const asc = await call("execute_tool", { tool: "asc", args: ["--version"] });
      expect(asc.json).toMatchObject({ exitCode: 0, readOnly: true });
    }

    const released = await call("release_device");
    expect(released.json).toMatchObject({ released: true });
    await expect(call("get_device_status")).rejects.toThrow(/NO_ACTIVE_LEASE/);
  });
});
