// Every test here runs against FakeProvider (an in-memory stand-in, not a device).
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Tapdance, TapdanceError, describeStep, loadScenario, parseScenario, runScenario, scenarioFromToolCalls, validateScenario, type StepReport } from "./index.js";
import { FakeProvider } from "./testing.js";

async function setup(provider = new FakeProvider()) {
  const home = await mkdtemp(join(tmpdir(), "td-scn-"));
  const cwd = await mkdtemp(join(tmpdir(), "td-scn-proj-"));
  const t = await Tapdance.create({ cwd, env: { TAPDANCE_HOME: home }, session: { id: "scenario-test", source: "test" }, provider });
  return { t, provider, home, cwd };
}

const SIGN_IN_YAML = `
name: Sign in
platform: android
device:
  platform: android
  device: Pixel 8
app:
  id: dev.tapdance.demo
steps:
  - launch_app: { app_id: dev.tapdance.demo, relaunch: true }
  - type_text: { text: ada@example.com, into_text: Email }
  - type_text: { text: secret1, into_text: Password }
  - tap: { text: Sign in }
    name: press Sign in
  - expect_visible: { text: "Welcome, ada@example.com", timeout_ms: 5000 }
  - take_screenshot: { note: signed in }
`;

describe("scenario files (FakeProvider)", () => {
  it("parses YAML with step options, bare step names and null arguments", () => {
    const s = parseScenario(`${SIGN_IN_YAML}  - start_recording\n  - stop_recording:\n`, { filename: "signin.scenario.yaml" });
    expect(s.name).toBe("Sign in");
    expect(s.device).toEqual({ platform: "android", device: "Pixel 8" });
    expect(s.steps.map((x) => x.action)).toEqual(["launch_app", "type_text", "type_text", "tap", "expect_visible", "take_screenshot", "start_recording", "stop_recording"]);
    expect(s.steps[3]).toEqual({ action: "tap", args: { text: "Sign in" }, name: "press Sign in" });
  });

  it("parses JSON", () => {
    const s = parseScenario(JSON.stringify({ name: "j", steps: [{ press_key: { key: "back" }, continue_on_failure: true }] }), { filename: "x.json" });
    expect(s.steps[0]).toEqual({ action: "press_key", args: { key: "back" }, continue_on_failure: true });
  });

  it("rejects unknown step types, unknown arguments and ambiguous targets", () => {
    const bad = (steps: unknown[]) => {
      try {
        validateScenario({ name: "x", steps });
      } catch (error) {
        expect(error).toBeInstanceOf(TapdanceError);
        expect((error as TapdanceError).code).toBe("USAGE");
        return (error as TapdanceError).message;
      }
      throw new Error("expected a rejection");
    };
    expect(bad([{ tapp: { text: "x" } }])).toMatch(/steps\[0\]\.tapp: Unknown step type "tapp"/);
    expect(bad([{ tap: { label: "x" } }])).toMatch(/steps\[0\]\.tap/);
    expect(bad([{ tap: { text: "a", id: "b" } }])).toMatch(/Name one target/);
    expect(bad([{ tap: { text: "a" }, wait_for: { stable: true } }])).toMatch(/2 step types/);
    expect(bad([{ expect_visible: {} }])).toMatch(/exactly one of text, id/);
    expect(bad([{ wait_for: { text: "a", stable: true } }])).toMatch(/exactly one of text, absent, stable/);
    expect(bad([{ swipe: { from_x: 1 } }])).toMatch(/all of from_x/);
    expect(bad([])).toMatch(/steps/);
    expect(() => validateScenario({ name: "x", platform: "ios", device: { platform: "android" }, steps: ["stop_recording"] })).toThrow(/platform is ios/);
    expect(() => validateScenario({ name: "x", steps: ["stop_recording"], extra: 1 })).toThrow(/extra/);
    expect(() => parseScenario("name: [unclosed", { filename: "a.yaml" })).toThrow(/Cannot read a.yaml/);
  });

  it("runs a passing scenario, leasing and releasing the device, and writes the evidence bundle", async () => {
    const { t, provider, cwd } = await setup();
    provider.visibleText = ["Welcome, ada@example.com"];
    const file = join(cwd, "signin.scenario.yaml");
    await writeFile(file, SIGN_IN_YAML);
    const seen: StepReport[] = [];
    const report = await runScenario(t, await loadScenario(file), { file, onStep: (s) => seen.push(s) });
    expect(report.status).toBe("pass");
    expect(report.steps.map((s) => s.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"]);
    expect(seen).toHaveLength(6);
    expect(report.steps[3]!.name).toBe("press Sign in");
    expect(report.steps[1]!.name).toBe('type_text (15 chars) into text "Email"');
    expect(report.device).toMatchObject({ platform: "android", model: "Pixel 8", osVersion: "35", leaseId: "lease-1", location: "remote", worker: "laptop" });
    expect(report.app).toEqual({ id: "dev.tapdance.demo" });
    expect(report).toMatchObject({ leased: true, released: true, summary: { passed: 6, failed: 0, skipped: 0 }, file });
    expect(report.environment.node).toBe(process.version);
    // The steps went through the provider with the scenario's arguments.
    expect(provider.calls.find((c) => c.method === "typeText")?.args).toEqual(["ada@example.com", { kind: "text", text: "Email" }]);
    expect(provider.calls.find((c) => c.method === "tap")?.args[0]).toEqual({ kind: "text", text: "Sign in" });
    expect(provider.calls.some((c) => c.method === "release")).toBe(true);
    expect(await t.current()).toBeUndefined();
    // Evidence: report.json, report.md and the screenshot, all listed as session artifacts.
    expect(JSON.parse(readFileSync(report.reportPath, "utf8"))).toMatchObject({ status: "pass", scenario: "Sign in" });
    const md = await readFile(report.summaryPath, "utf8");
    expect(md).toContain("# Sign in: PASS");
    expect(md).not.toContain("secret1");
    expect(existsSync(report.steps[5]!.evidence!.screenshot!)).toBe(true);
    const artifacts = await t.listArtifacts();
    expect(artifacts.map((a) => a.path)).toEqual(expect.arrayContaining([report.reportPath, report.summaryPath, report.steps[5]!.evidence!.screenshot]));
    expect(JSON.stringify(report)).not.toContain("secret1");
  });

  it("fails on an unmet expectation with a screenshot and UI tree, and skips the rest", async () => {
    const { t, provider } = await setup();
    provider.visibleText = ["Invalid email or password"];
    await t.lease({ platform: "android" });
    const scenario = validateScenario({
      name: "Bad sign in",
      steps: [{ tap: { text: "Sign in" } }, { expect_visible: { text: "Welcome", timeout_ms: 100 } }, { take_screenshot: {} }],
    });
    const report = await runScenario(t, scenario);
    expect(report.status).toBe("fail");
    expect(report.steps.map((s) => s.status)).toEqual(["pass", "fail", "skipped"]);
    const failed = report.steps[1]!;
    expect(failed.error).toMatchObject({ code: "ASSERTION_FAILED", message: expect.stringContaining('"Welcome" is not on screen') });
    expect(existsSync(failed.evidence!.screenshot!)).toBe(true);
    expect(JSON.parse(readFileSync(failed.evidence!.tree!, "utf8"))).toMatchObject({ elements: [{ label: "Sign in" }] });
    expect((await t.listArtifacts()).map((a) => a.kind)).toEqual(expect.arrayContaining(["screenshot", "inspection", "other"]));
    // It did not lease the device, so it leaves it held.
    expect(report).toMatchObject({ leased: false, released: false });
    expect(await t.current()).toBeDefined();
    expect(await readFile(report.summaryPath, "utf8")).toMatch(/## Failures[\s\S]*ASSERTION_FAILED/);
  });

  it("goes on after a failed step marked continue_on_failure, and with the continueOnFailure option", async () => {
    const { t, provider } = await setup();
    await t.lease({ platform: "android" });
    provider.failNext("tap", new TapdanceError("ELEMENT_NOT_FOUND", "No element matches text \"Skip\"", { hint: "Inspect the screen." }));
    const scenario = validateScenario({
      name: "Onboarding",
      steps: [{ tap: { text: "Skip" }, continue_on_failure: true }, { press_key: { key: "back" } }, { expect_not_visible: { id: "spinner" } }],
    });
    const report = await runScenario(t, scenario);
    expect(report.steps.map((s) => s.status)).toEqual(["fail", "pass", "pass"]);
    expect(report.steps[0]!.error).toEqual({ code: "ELEMENT_NOT_FOUND", message: 'No element matches text "Skip"', hint: "Inspect the screen." });
    expect(report.status).toBe("fail");

    provider.visibleText = [];
    const again = await runScenario(t, validateScenario({ name: "two", steps: [{ wait_for: { text: "A", timeout_ms: 100 } }, { wait_for: { text: "B", timeout_ms: 100 } }] }), { continueOnFailure: true });
    expect(again.steps.map((s) => s.status)).toEqual(["fail", "fail"]);
  });

  it("checks ids and the foreground app from the UI tree", async () => {
    const { t, provider } = await setup();
    await t.lease({ platform: "ios" });
    provider.screen = { app: "dev.tapdance.demo", elements: [{ ref: "@e1", role: "text", label: "Welcome", identifier: "result" }], truncated: false, warnings: [] };
    const ok = await runScenario(t, validateScenario({ name: "ids", platform: "ios", steps: [{ expect_visible: { id: "result" } }, { expect_app: { app_id: "dev.tapdance.demo" } }] }));
    expect(ok.status).toBe("pass");
    const bad = await runScenario(t, validateScenario({ name: "ids", steps: [{ expect_app: { app_id: "com.other" } }] }));
    expect(bad.steps[0]!.error).toMatchObject({ code: "ASSERTION_FAILED", message: "The foreground app is dev.tapdance.demo, not com.other" });
  });

  it("refuses to start without a device or on the wrong platform", async () => {
    const { t } = await setup();
    await expect(runScenario(t, validateScenario({ name: "x", steps: ["stop_recording"] }))).rejects.toMatchObject({ code: "NO_ACTIVE_LEASE" });
    await t.lease({ platform: "android" });
    await expect(runScenario(t, validateScenario({ name: "x", platform: "ios", steps: ["stop_recording"] }))).rejects.toMatchObject({ code: "USAGE" });
    await expect(runScenario(t, validateScenario({ name: "x", device: { platform: "ios" }, steps: ["stop_recording"] }))).rejects.toMatchObject({ code: "USAGE" });
  });

  it("uses the device the session already holds, even when the device block names another model", async () => {
    const { t, provider } = await setup();
    await t.lease({ platform: "android", device: "Pixel 8" });
    const report = await runScenario(t, validateScenario({ name: "x", device: { platform: "android", device: "Pixel 9" }, steps: [{ press_key: { key: "home" } }] }));
    expect(report).toMatchObject({ status: "pass", leased: false, released: false, device: { model: "Pixel 8" } });
    expect(provider.calls.filter((c) => c.method === "lease")).toHaveLength(1);
  });

  it("installs app.path relative to the scenario file and stops a recording left running", async () => {
    const { t, provider, cwd } = await setup();
    const file = join(cwd, "flows", "a.yaml");
    const scenario = validateScenario({ name: "rec", device: { platform: "android" }, app: { path: "../build/app.apk" }, steps: ["start_recording", { press_key: { key: "home" } }] });
    const report = await runScenario(t, scenario, { file, keepLease: true });
    expect(provider.calls.find((c) => c.method === "installApp")?.args[0]).toBe(join(cwd, "build", "app.apk"));
    expect(report.steps[0]).toMatchObject({ action: "install_app", status: "pass" });
    expect(report.app).toEqual({ id: "com.example.app" });
    expect(report.steps[1]!.evidence!.recording).toBe(join(report.evidenceDir, "recording.mp4"));
    expect(provider.calls.some((c) => c.method === "stopRecording")).toBe(true);
    expect(report).toMatchObject({ leased: true, released: false });
    expect(await t.current()).toBeDefined();
  });
});

describe("scenarioFromToolCalls", () => {
  it("turns MCP tool calls into a scenario and notes what will not replay", () => {
    const { scenario, notes } = scenarioFromToolCalls(
      [
        { tool: "lease_device", arguments: { platform: "ios", device: "iPhone 16", ttl_minutes: 30 } },
        { tool: "install_app", arguments: { path: "build/App.app" } },
        { tool: "launch_app", arguments: { app_id: "dev.tapdance.demo" } },
        { tool: "inspect_screen", arguments: {} },
        { tool: "type_text", arguments: { text: "ada@example.com", into_id: "email" } },
        { tool: "tap", arguments: { ref: "@e7" } },
        { tool: "tap", arguments: { text: "Nope" }, isError: true },
        { tool: "handle_alert", arguments: { action: "get" } },
        { tool: "wait_for", arguments: { text: "Welcome, ada@example.com" } },
        { tool: "take_screenshot", arguments: { note: "done", include_image: false } },
        { tool: "execute_tool", arguments: { tool: "asc", args: ["--help"] } },
        { tool: "release_device", arguments: {} },
      ],
      { name: "From the agent" },
    );
    expect(scenario.name).toBe("From the agent");
    expect(scenario.device).toEqual({ platform: "ios", device: "iPhone 16" });
    expect(scenario.steps.map((s) => s.action)).toEqual(["install_app", "launch_app", "type_text", "tap", "wait_for", "take_screenshot"]);
    expect(scenario.steps[5]).toEqual({ action: "take_screenshot", args: { note: "done" } });
    expect(notes).toEqual([
      expect.stringContaining("targets a ref (@e7)"),
      expect.stringContaining("(tap) failed"),
      expect.stringContaining("execute_tool asc"),
    ]);
  });

  it("refuses calls with nothing to replay and invalid arguments", () => {
    expect(() => scenarioFromToolCalls([{ tool: "inspect_screen" }])).toThrow(/None of these tool calls/);
    expect(() => scenarioFromToolCalls([{ tool: "tap", arguments: {} }])).toThrow(/Invalid scenario/);
  });
});

describe("example scenarios (parsed only, no device)", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  it.each(["examples/ios-demo/signin.scenario.yaml", "examples/android-demo/signin.scenario.yaml"])("%s is valid", async (file) => {
    const s = await loadScenario(join(root, file));
    expect(s.app).toMatchObject({ id: "dev.tapdance.demo" });
    expect(s.steps.map(describeStep)).toContain('expect_visible text "Welcome, ada@example.com"');
  });
});
