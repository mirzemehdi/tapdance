import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tapdance, TapdanceError, type LeaseHandle, type LeaseRequest } from "@tapdance/sdk";
import { FakeProvider } from "@tapdance/sdk/testing";
import { TOOLS, createMcpServer, createProgressRouter, startRenewal } from "./index.js";

const REQUIRED = [
  "list_workers", "list_devices", "lease_device", "get_device_status", "release_device", "install_app", "launch_app", "stop_app",
  "inspect_screen", "tap", "swipe", "type_text", "press_key", "take_screenshot", "start_recording", "stop_recording",
  "get_logs", "get_crash_logs", "get_test_artifacts", "wait_for", "handle_alert", "list_tools", "execute_tool", "list_apps",
  "uninstall_app", "kill_app", "build_app", "clipboard", "tap_sequence", "clear_app_data", "set_device_setting", "push_file", "pull_file", "notifications", "measure_performance", "device_shell", "run_scenario", "request_human",
];

/** Minimal valid arguments per tool, for the strictness check. */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  list_workers: {},
  list_devices: {},
  lease_device: { platform: "ios" },
  get_device_status: {},
  release_device: {},
  install_app: { path: "./build/App.app" },
  launch_app: { app_id: "com.example.app" },
  stop_app: { app_id: "com.example.app" },
  list_apps: {},
  inspect_screen: {},
  tap: { ref: "@e1" },
  swipe: { direction: "up" },
  wait_for: { text: "Welcome" },
  handle_alert: { action: "get" },
  type_text: { text: "hello" },
  press_key: { key: "enter" },
  take_screenshot: {},
  start_recording: {},
  stop_recording: {},
  get_logs: {},
  get_crash_logs: {},
  list_tools: {},
  execute_tool: { tool: "asc", args: ["--help"] },
  get_test_artifacts: {},
  uninstall_app: { app_id: "com.example.app" },
  kill_app: { app_id: "com.example.app" },
  build_app: { repo: "https://github.com/acme/app", ref: "main" },
  clipboard: { action: "get" },
  audit_screen: { app_id: "com.x" },
  crash_reports: { app_id: "com.x", pull: "latest" },
  tap_sequence: { steps: [{ t: 0, x: 10, y: 20 }] },
  clear_app_data: { app_id: "com.example.app" },
  set_device_setting: { name: "appearance", value: "dark" },
  push_file: { path: "./seed.json", destination: "downloads" },
  pull_file: { device_path: "/sdcard/Download/x.txt" },
  notifications: { action: "list" },
  measure_performance: { metric: "frames" },
  device_shell: { command: "getprop ro.build.version.sdk" },
  run_scenario: { scenario: { name: "x", steps: [{ press_key: { key: "home" } }] } },
  request_human: { reason: "Sign in to the test account" },
};

const DEVICE_ACTIONS = ["launch_app", "stop_app", "install_app", "tap", "swipe", "type_text", "press_key", "handle_alert", "start_recording", "stop_recording"];

async function connect(provider: FakeProvider = new FakeProvider()) {
  const progress = createProgressRouter();
  const tapdance = await Tapdance.create({
    cwd: await mkdtemp(join(tmpdir(), "td-mcp-")),
    env: { TAPDANCE_HOME: await mkdtemp(join(tmpdir(), "td-mcp-home-")) },
    session: { id: "mcp-test", source: "test" },
    provider,
    onProgress: progress.emit,
  });
  const server = createMcpServer(tapdance, undefined, progress);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = r.content.find((c) => c.type === "text")?.text ?? "{}";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { raw: text };
    }
    return { ...r, json: parsed };
  };
  return { client, call, provider, tapdance };
}

describe("MCP tool surface", () => {
  it("exposes every required tool and no host shell", () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of REQUIRED) expect(names).toContain(n);
    // device_shell is the one shell, and it runs inside the leased emulator, never on the host.
    for (const n of names.filter((x) => x !== "device_shell")) expect(n).not.toMatch(/shell|^exec$|adb|simctl|run_on_device/);
    expect(TOOLS.find((t) => t.name === "device_shell")!.description).toMatch(/inside the leased emulator/);
  });

  it("describes every tool and refuses unknown keys", () => {
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.input.safeParse({ nonsense: 1 }).success).toBe(false);
    }
  });

  it("every tool input is strict", () => {
    expect(Object.keys(VALID_ARGS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const t of TOOLS) {
      const valid = VALID_ARGS[t.name]!;
      expect(t.input.safeParse(valid).success, t.name).toBe(true);
      expect(t.input.safeParse({ ...valid, nonsense: 1 }).success, t.name).toBe(false);
    }
  });

  it("only tools that delete device state are destructive", () => {
    expect(TOOLS.filter((t) => t.annotations.destructiveHint === true).map((t) => t.name).sort()).toEqual(["clear_app_data", "release_device", "uninstall_app"]);
    for (const name of DEVICE_ACTIONS) {
      const t = TOOLS.find((x) => x.name === name)!;
      expect(t.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    }
    for (const name of ["take_screenshot", "get_logs", "get_crash_logs"]) {
      expect(TOOLS.find((x) => x.name === name)!.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
  });

  it("lists tools with JSON schemas over the protocol", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(tools.find((t) => t.name === "lease_device")?.inputSchema.required).toContain("platform");
  });
});

describe("MCP agent flow", () => {
  it("runs lease → install → launch → inspect → tap → screenshot → release", async () => {
    const { call, provider } = await connect();
    expect((await call("tap", { text: "Sign in" })).json).toMatchObject({ error: { code: "NO_ACTIVE_LEASE" } });
    const leased = await call("lease_device", { platform: "android", device: "Pixel 8" });
    expect(leased.json).toMatchObject({ device: { model: "Pixel 8", platform: "android" } });
    expect((await call("launch_app", { app_id: "com.example.app" })).json).toMatchObject({ ok: true });
    const screen = await call("inspect_screen");
    expect(screen.json).toMatchObject({ elements: [{ ref: "@e1", label: "Sign in" }] });
    const tapped = await call("tap", { ref: "@e1" });
    expect(tapped.json).toMatchObject({ ok: true, changes: ['+ @e2 [text-field] "Email"'] });
    expect(provider.calls.find((c) => c.method === "tap")?.args[0]).toEqual({ kind: "ref", ref: "e1" });
    const shot = await call("take_screenshot", { note: "after tap" });
    expect(shot.content.some((c) => c.type === "image")).toBe(true);
    expect((await call("get_test_artifacts")).json).toMatchObject({ artifacts: [{ kind: "screenshot", note: "after tap" }] });
    expect((await call("wait_for", { text: "Welcome" })).json).toMatchObject({ found: true });
    expect((await call("handle_alert", { action: "get" })).json).toMatchObject({ present: true, buttons: ["Allow", "Don't Allow"] });
    expect((await call("lease_device", { platform: "android" })).json).toMatchObject({ reused: true });
    expect((await call("release_device")).json).toMatchObject({ released: true });
  });

  it("confines install paths to the project", async () => {
    const { call } = await connect();
    await call("lease_device", { platform: "android" });
    const r = await call("install_app", { path: "/etc/hosts" });
    expect(r.json).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("returns structured, actionable errors", async () => {
    const { call } = await connect();
    await call("lease_device", { platform: "android" });
    const both = await call("tap", { text: "a", ref: "@e1" });
    expect(both.isError).toBe(true);
    expect(both.json).toMatchObject({ error: { code: "USAGE" } });
    const swipe = await call("swipe", { direction: "up", from_x: 1 });
    expect(swipe.json).toMatchObject({ error: { code: "USAGE" } });
    const bad = await call("launch_app", { app_id: "rm -rf /" });
    expect(bad.isError).toBe(true);
    expect(String(bad.json["raw"])).toMatch(/app_id/);
  });

  it("types into a named field", async () => {
    const { call, provider } = await connect();
    await call("lease_device", { platform: "ios" });
    await call("type_text", { text: "hello@example.com", into_text: "Email" });
    expect(provider.calls.find((c) => c.method === "typeText")?.args).toEqual(["hello@example.com", { kind: "text", text: "Email" }]);
  });
});

describe("execute_tool (MOCKED executable: proves pass-through, not asc itself)", () => {
  async function withFakeAsc(config: Record<string, unknown> = {}) {
    const { mkdtemp, writeFile, chmod } = await import("node:fs/promises");
    const bin = await mkdtemp(join(tmpdir(), "td-fake-bin-"));
    await writeFile(
      join(bin, "asc"),
      '#!/bin/sh\necho "args:$*"\necho "ro:${ASC_READ_ONLY:-unset}"\necho "leak:${SECRET_FROM_PARENT:-none}"\necho "-----BEGIN PRIVATE KEY-----"\necho "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"\necho "-----END PRIVATE KEY-----"\nexit 3\n',
    );
    await chmod(join(bin, "asc"), 0o755);
    const cwd = await mkdtemp(join(tmpdir(), "td-tool-"));
    const home = await mkdtemp(join(tmpdir(), "td-tool-home-"));
    // tools.* are user-only settings: a project's tapdance.config.json cannot set them.
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const tapdance = await Tapdance.create({
      cwd,
      env: { TAPDANCE_HOME: home, PATH: `${bin}:/usr/bin:/bin`, SECRET_FROM_PARENT: "s3cr3t", ASC_KEY_ID: "KEYID" },
      session: { id: "tool-test", source: "test" },
      provider: new FakeProvider(),
    });
    const server = createMcpServer(tapdance);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return async (args: Record<string, unknown>) => {
      const r = (await client.callTool({ name: "execute_tool", arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
      return { isError: r.isError, json: JSON.parse(r.content[0]!.text!) as Record<string, unknown> };
    };
  }

  it("forwards a subcommand Tapdance has never heard of, unchanged", async () => {
    const exec = await withFakeAsc();
    const r = await exec({ tool: "asc", args: ["brand-new-2027-command", "--flag", "value with spaces", "$(rm -rf /)"] });
    expect(r.json["exitCode"]).toBe(3);
    expect(r.json["stdout"]).toContain("args:brand-new-2027-command --flag value with spaces $(rm -rf /)");
  });

  it("runs asc read-only for agents and keeps parent secrets and keys out", async () => {
    const exec = await withFakeAsc();
    const r = await exec({ tool: "asc", args: ["apps", "list"] });
    expect(r.json).toMatchObject({ readOnly: true });
    expect(r.json["stdout"]).toContain("ro:1");
    expect(r.json["stdout"]).toContain("leak:none");
    expect(r.json["stdout"]).not.toContain("MIIEvQIBADANBg");
  });

  it("allows mutation only when the user authorized it in config", async () => {
    const denied = await (await withFakeAsc())({ tool: "asc", args: ["publish"], allow_mutation: true });
    expect(denied.json["stdout"]).toContain("ro:1");
    const allowed = await (await withFakeAsc({ tools: { allowMutation: ["asc"] } }))({ tool: "asc", args: ["publish"], allow_mutation: true });
    expect(allowed.json["stdout"]).toContain("ro:unset");
  }, 20_000); // two fake-tool spawns; slow when the whole suite runs in parallel

  it("refuses tools the user has not enabled and remote targets", async () => {
    const exec = await withFakeAsc({ tools: { mcpEnabled: [] } });
    expect((await exec({ tool: "asc", args: ["--help"] })).json).toMatchObject({ error: { code: "FORBIDDEN" } });
    const exec2 = await withFakeAsc();
    expect((await exec2({ tool: "asc", args: ["--help"], target: "mac-worker-1" })).json).toMatchObject({ error: { code: "NOT_SUPPORTED" } });
    expect((await exec2({ tool: "fastlane", args: ["supply"] })).json).toMatchObject({ error: { code: "FORBIDDEN" } });
  });
});

/** A fake provider whose logs are long, for the inline-size limits. */
class LongLogProvider extends FakeProvider {
  constructor(private readonly count: number, private readonly width = 60) {
    super();
  }
  override async logs(handle: LeaseHandle) {
    await super.logs(handle);
    const lines = Array.from({ length: this.count }, (_, i) =>
      `01-01 12:00:00.000  1234  1234 ${i % 100 === 0 ? "E" : "I"} App: line ${i} ${i % 7 === 0 ? "needle" : "hay"} ${"x".repeat(this.width)}`,
    );
    return { source: "fake", lines, truncated: false };
  }
}

describe("MCP logs and apps", () => {
  it("returns at most 50 log lines inline and saves the rest", async () => {
    const { call } = await connect(new LongLogProvider(3000));
    await call("lease_device", { platform: "android" });
    const r = await call("get_logs");
    const lines = r.json["lines"] as string[];
    expect(lines.length).toBeLessThanOrEqual(50);
    expect(lines.at(-1)).toContain("line 2999");
    expect(r.json["omittedLines"]).toBeGreaterThan(0);
    expect(r.json["artifact"]).toMatchObject({ kind: "log" });
    expect(r.content.find((c) => c.type === "text")!.text!.length).toBeLessThan(12_000);
  });

  it("never returns more than 12,000 characters, even when asked for many lines", async () => {
    const { call } = await connect(new LongLogProvider(3000, 500));
    await call("lease_device", { platform: "android" });
    const r = await call("get_logs", { lines: 2000 });
    expect(r.content.find((c) => c.type === "text")!.text!.length).toBeLessThan(12_000);
    expect(r.json["omittedLines"]).toBeGreaterThan(0);
  });

  it("filters by contains and level", async () => {
    const { call, provider } = await connect(new LongLogProvider(3000));
    await call("lease_device", { platform: "android" });
    const needles = await call("get_logs", { contains: "NEEDLE", app_id: "com.example.app" });
    const lines = needles.json["lines"] as string[];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.includes("needle"))).toBe(true);
    const errors = await call("get_logs", { level: "error" });
    expect((errors.json["lines"] as string[]).every((l) => / E App:/.test(l))).toBe(true);
    expect((errors.json["lines"] as string[]).length).toBe(30);
    expect(provider.calls.filter((c) => c.method === "lease")).toHaveLength(1);
  });

  it("lists installed apps", async () => {
    const { call } = await connect();
    await call("lease_device", { platform: "android" });
    expect((await call("list_apps")).json).toEqual({ apps: ["com.example.app"] });
  });
});

/** A fake provider that reports progress while it leases, as a booting worker would. */
class ProgressProvider extends FakeProvider {
  override async lease(sessionId: string, request: LeaseRequest, options?: { onProgress?: (m: string) => void }): Promise<LeaseHandle> {
    options?.onProgress?.("Waiting for a device");
    options?.onProgress?.("Booting Pixel 8");
    return super.lease(sessionId, request);
  }
}

describe("MCP server lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends progress notifications during a long call", async () => {
    const { client } = await connect(new ProgressProvider());
    const seen: Array<{ progress: number; message?: string }> = [];
    const r = (await client.callTool({ name: "lease_device", arguments: { platform: "android" } }, undefined, { onprogress: (p) => seen.push(p) })) as { isError?: boolean };
    expect(r.isError).toBeFalsy();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toMatchObject({ progress: 1, message: "Waiting for a device" });
  });

  it("a failing renewal check is logged, never an unhandled rejection (MOCKED current)", async () => {
    const tapdance = await Tapdance.create({
      cwd: await mkdtemp(join(tmpdir(), "td-mcp-")),
      env: { TAPDANCE_HOME: await mkdtemp(join(tmpdir(), "td-mcp-home-")) },
      session: { id: "renew-test", source: "test" },
      provider: new FakeProvider(),
    });
    vi.spyOn(tapdance, "current").mockRejectedValue(new TapdanceError("TIMEOUT", "session lock busy"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers();
    const log = vi.fn();
    const stop = startRenewal(tapdance, log);
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(15_000);
    } finally {
      stop();
      vi.useRealTimers();
    }
    await new Promise((r) => setImmediate(r));
    process.off("unhandledRejection", onUnhandled);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("tapdance: renewal check failed: session lock busy"));
    expect(log).toHaveBeenCalledTimes(2);
    expect(unhandled).toEqual([]);
  });
});
