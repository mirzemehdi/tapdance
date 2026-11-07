import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { platform as osPlatform, release as osRelease } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  TapdanceError,
  describeTarget,
  parseTarget,
  redactObject,
  toTapdanceError,
  type ElementTarget,
  type ErrorCode,
  type Platform,
  type TargetInput,
  type WaitCondition,
} from "@tapdance/core";
import { renewIfDue } from "./keepalive.js";
import { leaseCommand, type Tapdance } from "./tapdance.js";

/**
 * Scenario files: a saved flow of device steps that `tapdance run` (and the SDK's `runScenario`)
 * replays on the session's leased device, step by step, through the Tapdance class only. Step names
 * and argument names are the MCP tool names and arguments, so a flow an agent ran can be saved as is.
 * Replay is not perfect: it repeats the steps, it does not restore the device, the app's data, the
 * network or the time the original run saw.
 */

// ------------------------------------------------------------------ schema

const appId = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,254}$/, "an Android package or iOS bundle id, e.g. dev.tapdance.demo");
const text = z.string().min(1).max(500);
const ref = z.string().regex(/^@?e\d+(~s\d+)?$/, "a ref such as @e7");
const selector = z.string().min(1).max(1000);
const coordinate = z.number().nonnegative();
const waitTimeout = z.number().int().min(100).max(30_000).optional();

/** Argument schemas per step type. The MCP tools of the same name take the same arguments. */
export const STEP_ARGS = {
  install_app: z.object({ path: z.string().min(1).max(4096), app_id: appId.optional() }).strict(),
  launch_app: z.object({ app_id: appId, relaunch: z.boolean().optional(), url: z.string().url().max(2048).optional() }).strict(),
  stop_app: z.object({ app_id: appId }).strict(),
  tap: z.object({ text: text.optional(), id: text.optional(), ref: ref.optional(), selector: selector.optional(), x: coordinate.optional(), y: coordinate.optional() }).strict(),
  type_text: z.object({ text: z.string().max(5000), into_ref: ref.optional(), into_text: text.optional(), into_id: text.optional() }).strict(),
  swipe: z
    .object({
      direction: z.enum(["up", "down", "left", "right"]).optional(),
      amount: z.number().min(0.1).max(0.8).optional(),
      until_text: text.optional(),
      from_x: coordinate.optional(),
      from_y: coordinate.optional(),
      to_x: coordinate.optional(),
      to_y: coordinate.optional(),
    })
    .strict(),
  press_key: z.object({ key: z.enum(["back", "home", "enter", "dismiss_keyboard", "app_switcher"]) }).strict(),
  wait_for: z.object({ text: text.optional(), absent: text.optional(), stable: z.boolean().optional(), timeout_ms: waitTimeout }).strict(),
  handle_alert: z.object({ action: z.enum(["get", "accept", "dismiss"]) }).strict(),
  take_screenshot: z.object({ note: z.string().max(200).optional() }).strict(),
  start_recording: z.object({}).strict(),
  stop_recording: z.object({}).strict(),
  sleep: z.object({ ms: z.number().int().min(0).max(60_000) }).strict(),
  expect_visible: z.object({ text: text.optional(), id: text.optional(), timeout_ms: waitTimeout }).strict(),
  expect_not_visible: z.object({ text: text.optional(), id: text.optional(), timeout_ms: waitTimeout }).strict(),
  expect_app: z.object({ app_id: appId }).strict(),
} as const;

export type StepAction = keyof typeof STEP_ARGS;
export const STEP_ACTIONS = Object.keys(STEP_ARGS) as StepAction[];

/** Options any step may carry next to its action. */
const STEP_OPTIONS = z
  .object({
    name: z.string().min(1).max(200).optional(),
    continue_on_failure: z.boolean().optional(),
    timeout_ms: z.number().int().min(1).max(3_600_000).optional(),
  })
  .strict();
const OPTION_KEYS = new Set(Object.keys(STEP_OPTIONS.shape));

export type ScenarioStep = {
  [K in StepAction]: { action: K; args: z.output<(typeof STEP_ARGS)[K]>; name?: string; continue_on_failure?: boolean; timeout_ms?: number };
}[StepAction];

/** Rules a plain object schema cannot state: exactly one target, one wait condition, and so on. */
function argProblem(step: ScenarioStep): string | undefined {
  const count = (o: Record<string, unknown>, keys: string[]) => keys.filter((k) => o[k] !== undefined && o[k] !== false).length;
  const tryTarget = (input: TargetInput): string | undefined => {
    try {
      parseTarget(input);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  };
  switch (step.action) {
    case "tap":
      return tryTarget(step.args);
    case "type_text": {
      const n = count(step.args, ["into_ref", "into_text", "into_id"]);
      return n > 1 ? "Name at most one of into_ref, into_text, into_id" : undefined;
    }
    case "swipe": {
      const points = count(step.args, ["from_x", "from_y", "to_x", "to_y"]);
      if (step.args.direction !== undefined) return points > 0 ? "Give a direction or coordinates, not both" : undefined;
      if (step.args.amount !== undefined || step.args.until_text !== undefined) return "amount and until_text need a direction";
      return points === 4 ? undefined : "Give direction, or all of from_x, from_y, to_x, to_y";
    }
    case "wait_for":
      return count(step.args, ["text", "absent", "stable"]) === 1 ? undefined : "Give exactly one of text, absent, stable";
    case "expect_visible":
    case "expect_not_visible":
      return count(step.args, ["text", "id"]) === 1 ? undefined : "Give exactly one of text, id";
    default:
      return undefined;
  }
}

/**
 * One step: an object with exactly one step type as its key and that type's arguments as the value,
 * plus the optional `name`, `continue_on_failure` and `timeout_ms`. A bare string names a step type
 * without arguments (`- stop_recording`).
 */
export const StepSchema = z.unknown().transform((raw, ctx): ScenarioStep => {
  let obj: Record<string, unknown>;
  if (typeof raw === "string") obj = { [raw]: {} };
  else if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) obj = raw as Record<string, unknown>;
  else {
    ctx.addIssue({ code: "custom", message: 'A step is an object such as { tap: { text: "Sign in" } }' });
    return z.NEVER;
  }
  const actions = Object.keys(obj).filter((k) => !OPTION_KEYS.has(k));
  if (actions.length !== 1) {
    ctx.addIssue({ code: "custom", message: actions.length === 0 ? "The step names no step type" : `The step names ${actions.length} step types (${actions.join(", ")}); use one per step` });
    return z.NEVER;
  }
  const action = actions[0]!;
  if (!Object.hasOwn(STEP_ARGS, action)) {
    ctx.addIssue({ code: "custom", path: [action], message: `Unknown step type "${action}"; known types: ${STEP_ACTIONS.join(", ")}` });
    return z.NEVER;
  }
  const options = STEP_OPTIONS.safeParse(Object.fromEntries(Object.entries(obj).filter(([k]) => OPTION_KEYS.has(k))));
  const args = STEP_ARGS[action as StepAction].safeParse(obj[action] ?? {});
  for (const issue of [...(options.error?.issues ?? []), ...(args.error?.issues ?? []).map((i) => ({ ...i, path: [action, ...i.path] }))]) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
  if (!options.success || !args.success) return z.NEVER;
  const step = { action, args: args.data, ...options.data } as ScenarioStep;
  const problem = argProblem(step);
  if (problem) {
    ctx.addIssue({ code: "custom", path: [action], message: problem });
    return z.NEVER;
  }
  return step;
});

const platformSchema = z.enum(["android", "ios"]);

export const ScenarioSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    /** The platform the steps are written for; the run refuses a device of the other platform. */
    platform: platformSchema.optional(),
    /** Lease this device when the session holds none (the same fields as lease_device). */
    device: z
      .object({
        platform: platformSchema,
        device: z.string().min(1).max(100).optional(),
        os_version: z.string().min(1).max(40).optional(),
        image_tag: z.string().min(1).max(60).optional(),
      })
      .strict()
      .optional(),
    /** The app under test: `path` is installed before the first step; `id` goes into the report. */
    app: z.object({ path: z.string().min(1).max(4096).optional(), id: appId.optional() }).strict().optional(),
    steps: z.array(StepSchema).min(1).max(500),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.platform && s.device && s.platform !== s.device.platform) {
      ctx.addIssue({ code: "custom", path: ["platform"], message: `platform is ${s.platform} but device.platform is ${s.device.platform}` });
    }
  });

export type Scenario = z.output<typeof ScenarioSchema>;
/** A scenario as written in a file, before validation. */
export type ScenarioInput = z.input<typeof ScenarioSchema>;

function issuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : `${i === 0 ? "" : "."}${String(p)}`)).join("");
}

/** Checks a parsed scenario object; a bad one fails with USAGE and every problem listed. */
export function validateScenario(value: unknown, source = "scenario"): Scenario {
  const parsed = ScenarioSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => (i.path.length ? `${issuePath(i.path)}: ${i.message}` : i.message));
  throw new TapdanceError("USAGE", `Invalid scenario ${source}: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ""}`, {
    hint: "See docs/scenarios.md for the format, the step types and their arguments.",
    details: { issues },
  });
}

/** Parses scenario text: JSON for a .json file name, YAML otherwise (YAML also reads JSON). */
export function parseScenario(source: string, options: { filename?: string } = {}): Scenario {
  const label = options.filename ? basename(options.filename) : "scenario";
  let value: unknown;
  try {
    value = options.filename && extname(options.filename).toLowerCase() === ".json" ? JSON.parse(source) : parseYaml(source);
  } catch (error) {
    throw new TapdanceError("USAGE", `Cannot read ${label}: ${(error as Error).message.split("\n")[0]}`, { hint: "Scenario files are YAML (.yaml, .yml) or JSON (.json)." });
  }
  return validateScenario(value, label);
}

export async function loadScenario(path: string): Promise<Scenario> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new TapdanceError("USAGE", `Cannot read the scenario file ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  return parseScenario(source, { filename: path });
}

// ------------------------------------------------------------------ report

export type StepStatus = "pass" | "fail" | "skipped";

export interface StepReport {
  /** 1-based position in the run (an `app.path` install counts as step 1). */
  index: number;
  name: string;
  action: StepAction;
  status: StepStatus;
  durationMs: number;
  error?: { code: ErrorCode; message: string; hint?: string };
  /** Files in the evidence folder: the screen and UI tree at a failure, a screenshot or recording the step took. */
  evidence?: { screenshot?: string; tree?: string; recording?: string };
}

export interface ScenarioReport {
  scenario: string;
  file?: string;
  status: "pass" | "fail";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sessionId: string;
  device: { platform: Platform; model: string; osVersion: string; leaseId: string; location: "local" | "remote" | "cloud"; worker?: string };
  /** The app under test as the scenario names it; the version is not read from the device yet. */
  app?: { id: string; version?: string };
  /** This run leased the device (it had none), and whether it released it at the end. */
  leased: boolean;
  released: boolean;
  environment: { tapdance: string; node: string; host: string; git?: { commit: string; branch?: string } };
  summary: { passed: number; failed: number; skipped: number };
  steps: StepReport[];
  evidenceDir: string;
  reportPath: string;
  summaryPath: string;
}

export interface RunScenarioOptions {
  /** The evidence folder; default `<session artifacts>/runs/<time>-<scenario name>`. */
  artifactsDir?: string;
  /** Called after each step, including skipped ones. */
  onStep?: (step: StepReport) => void;
  /** Keep going after a failed step (as if every step had continue_on_failure). */
  continueOnFailure?: boolean;
  /** Keep a device this run leased instead of releasing it at the end. */
  keepLease?: boolean;
  /** The scenario file, for the report and for relative app paths. */
  file?: string;
  /** Turns an app path from the scenario into the path to install; default: resolved against the file's folder. */
  resolvePath?: (path: string) => string;
}

const WAITING: ReadonlySet<StepAction> = new Set(["wait_for", "expect_visible", "expect_not_visible", "sleep"]);
const DEFAULT_WAIT_MS = 10_000;

function sdkVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function gitInfo(dir: string): Promise<{ commit: string; branch?: string } | undefined> {
  const git = async (args: string[]) => (await promisify(execFile)("git", ["-C", dir, ...args], { timeout: 3_000 })).stdout.trim();
  try {
    const commit = await git(["rev-parse", "HEAD"]);
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
    return { commit, ...(branch && branch !== "HEAD" ? { branch } : {}) };
  } catch {
    return undefined;
  }
}

function targetOf(input: TargetInput): ElementTarget | undefined {
  const named = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as TargetInput;
  return Object.keys(named).length ? parseTarget(named) : undefined;
}

/** A readable default name; typed text is never shown, only its length. */
export function describeStep(step: ScenarioStep): string {
  switch (step.action) {
    case "install_app":
      return `install_app ${basename(step.args.path)}`;
    case "launch_app":
    case "stop_app":
    case "expect_app":
      return `${step.action} ${step.args.app_id}`;
    case "tap":
      return `tap ${describeTarget(parseTarget(step.args))}`;
    case "type_text": {
      const into = targetOf({ ref: step.args.into_ref, text: step.args.into_text, id: step.args.into_id } as TargetInput);
      return `type_text (${step.args.text.length} chars)${into ? ` into ${describeTarget(into)}` : ""}`;
    }
    case "swipe":
      return step.args.direction
        ? `swipe ${step.args.direction}${step.args.until_text ? ` until "${step.args.until_text}"` : ""}`
        : `swipe (${step.args.from_x}, ${step.args.from_y}) → (${step.args.to_x}, ${step.args.to_y})`;
    case "press_key":
      return `press_key ${step.args.key}`;
    case "wait_for":
      return step.args.text ? `wait_for text "${step.args.text}"` : step.args.absent ? `wait_for absent "${step.args.absent}"` : "wait_for stable";
    case "handle_alert":
      return `handle_alert ${step.args.action}`;
    case "take_screenshot":
      return `take_screenshot${step.args.note ? ` "${step.args.note}"` : ""}`;
    case "sleep":
      return `sleep ${step.args.ms} ms`;
    case "expect_visible":
    case "expect_not_visible":
      return `${step.action} ${step.args.text !== undefined ? `text "${step.args.text}"` : `id "${step.args.id}"`}`;
    default:
      return step.action;
  }
}

function assertionFailed(message: string, hint = "Look at this step's failure screenshot and UI tree in the evidence folder."): TapdanceError {
  return new TapdanceError("ASSERTION_FAILED", message, { hint });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when an element with this accessibility id / resource id is on screen (Android ids may be `pkg:id/name`). */
async function idVisible(tapdance: Tapdance, id: string): Promise<boolean> {
  const screen = await tapdance.inspect({ interactiveOnly: false });
  return screen.elements.some((e) => e.identifier === id || e.identifier?.endsWith(`:id/${id}`) === true);
}

async function pollId(tapdance: Tapdance, id: string, present: boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    if ((await idVisible(tapdance, id)) === present) return true;
    if (Date.now() - started >= timeoutMs) return false;
    await delay(Math.min(500, Math.max(0, timeoutMs - (Date.now() - started))));
  }
}

interface RunContext {
  tapdance: Tapdance;
  dir: string;
  resolvePath: (path: string) => string;
  recording: boolean;
  recordings: number;
  appId?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Runs one step through the Tapdance class; throws on failure, returns evidence it produced. */
async function runStep(ctx: RunContext, step: ScenarioStep, index: number, name: string): Promise<StepReport["evidence"]> {
  const t = ctx.tapdance;
  const waitMs = (own?: number) => Math.min(own ?? step.timeout_ms ?? DEFAULT_WAIT_MS, 30_000);
  switch (step.action) {
    case "install_app": {
      const r = await t.installApp(ctx.resolvePath(step.args.path), step.args.app_id);
      ctx.appId ??= r.appId ?? step.args.app_id;
      return undefined;
    }
    case "launch_app":
      await t.launchApp(step.args.app_id, { ...(step.args.relaunch ? { relaunch: true } : {}), ...(step.args.url ? { url: step.args.url } : {}) });
      ctx.appId ??= step.args.app_id;
      return undefined;
    case "stop_app":
      await t.stopApp(step.args.app_id);
      return undefined;
    case "tap":
      await t.tap(parseTarget(step.args));
      return undefined;
    case "type_text": {
      const r = await t.typeText(step.args.text, targetOf({ ref: step.args.into_ref, text: step.args.into_text, id: step.args.into_id } as TargetInput));
      if (r.typed === "unconfirmed") throw assertionFailed("The field did not read back the typed text", "Check the field is editable and not secure-only; see the failure screenshot.");
      return undefined;
    }
    case "swipe": {
      const a = step.args;
      if (a.direction) await t.swipe({ kind: "direction", direction: a.direction, ...(a.amount ? { amount: a.amount } : {}), ...(a.until_text ? { untilText: a.until_text } : {}) });
      else await t.swipe({ kind: "points", from: { x: a.from_x!, y: a.from_y! }, to: { x: a.to_x!, y: a.to_y! } });
      return undefined;
    }
    case "press_key":
      await t.pressKey(step.args.key);
      return undefined;
    case "wait_for": {
      const a = step.args;
      const condition: WaitCondition = a.text ? { kind: "text", text: a.text } : a.absent ? { kind: "absent", text: a.absent } : { kind: "stable" };
      const r = await t.waitFor(condition, waitMs(a.timeout_ms));
      if (!r.found) {
        throw assertionFailed(
          a.text ? `"${a.text}" did not appear within ${r.waitedMs} ms` : a.absent ? `"${a.absent}" was still on screen after ${r.waitedMs} ms` : `The screen did not settle within ${r.waitedMs} ms`,
          r.hint,
        );
      }
      return undefined;
    }
    case "handle_alert": {
      const r = await t.alert(step.args.action);
      if (step.args.action !== "get" && !r.present) throw assertionFailed(`No alert was showing to ${step.args.action}`);
      return undefined;
    }
    case "take_screenshot": {
      const shot = await t.screenshot(join(ctx.dir, `step-${pad(index)}-screenshot.png`), step.args.note ?? name);
      return { screenshot: shot.path };
    }
    case "start_recording": {
      ctx.recordings += 1;
      const r = await t.startRecording(join(ctx.dir, ctx.recordings === 1 ? "recording.mp4" : `recording-${ctx.recordings}.mp4`));
      ctx.recording = true;
      return { recording: r.path };
    }
    case "stop_recording": {
      const r = await t.stopRecording();
      ctx.recording = false;
      return { recording: r.path };
    }
    case "sleep":
      await delay(step.args.ms);
      return undefined;
    case "expect_visible":
    case "expect_not_visible": {
      const a = step.args;
      const present = step.action === "expect_visible";
      const timeout = waitMs(a.timeout_ms);
      if (a.text !== undefined) {
        const r = await t.waitFor(present ? { kind: "text", text: a.text } : { kind: "absent", text: a.text }, timeout);
        if (!r.found) throw assertionFailed(present ? `"${a.text}" is not on screen (waited ${r.waitedMs} ms)` : `"${a.text}" is still on screen (waited ${r.waitedMs} ms)`, r.hint);
      } else if (!(await pollId(t, a.id!, present, timeout))) {
        throw assertionFailed(present ? `No element with id "${a.id}" on screen (waited ${timeout} ms)` : `The element with id "${a.id}" is still on screen (waited ${timeout} ms)`);
      }
      return undefined;
    }
    case "expect_app": {
      const screen = await t.inspect({ interactiveOnly: true });
      if (!screen.app) {
        throw new TapdanceError("NOT_SUPPORTED", "The device backend did not report which app is in the foreground", {
          hint: "Use expect_visible on text or an id only that app shows.",
        });
      }
      if (screen.app !== step.args.app_id) throw assertionFailed(`The foreground app is ${screen.app}, not ${step.args.app_id}`);
      return undefined;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, step: ScenarioStep): Promise<T> {
  if (step.timeout_ms === undefined || WAITING.has(step.action)) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new TapdanceError("TIMEOUT", `The step did not finish within ${step.timeout_ms} ms`, {
            hint: "Raise the step's timeout_ms. The device call itself was not cancelled and may still finish.",
            retryable: false,
          }),
        ),
      step.timeout_ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The screen and the full UI tree at a failure; each part is best effort. */
async function captureFailure(ctx: RunContext, index: number, name: string): Promise<StepReport["evidence"]> {
  const t = ctx.tapdance;
  const evidence: NonNullable<StepReport["evidence"]> = {};
  try {
    evidence.screenshot = (await t.screenshot(join(ctx.dir, `step-${pad(index)}-failure.png`), `step ${index} failed: ${name}`)).path;
  } catch {
    // The device may be gone (LEASE_LOST); the error says so.
  }
  try {
    const tree = await t.inspect({ interactiveOnly: false });
    const path = join(ctx.dir, `step-${pad(index)}-tree.json`);
    await writeFile(path, `${JSON.stringify(redactObject(tree), null, 2)}\n`);
    const record = await t.current();
    await t.artifacts.record({ kind: "inspection", path, sessionId: t.sessionId, ...(record ? { leaseId: record.handle.leaseId } : {}), note: `UI tree at step ${index} failure: ${name}` });
    evidence.tree = path;
  } catch {
    // As above.
  }
  return Object.keys(evidence).length ? evidence : undefined;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "scenario";
}

/**
 * Replays a scenario on the session's device and writes an evidence folder with report.json and
 * report.md. Leases the scenario's `device` when the session holds none (and releases it at the end
 * unless `keepLease`). Steps run in order; a failed step gets a screenshot and the UI tree, and stops
 * the run unless it (or the options) say continue_on_failure. Problems before the first step (no
 * device, a lease that fails, a platform mismatch) throw instead of returning a report.
 */
export async function runScenario(tapdance: Tapdance, scenario: Scenario, options: RunScenarioOptions = {}): Promise<ScenarioReport> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const baseDir = options.file ? dirname(resolve(options.file)) : process.cwd();
  let leased = false;
  // A device the session already holds is used as it is; `device` only says what to lease when there is none.
  if (scenario.device && (await tapdance.current()) === undefined) {
    const d = scenario.device;
    const r = await tapdance.lease({
      reuse: true,
      platform: d.platform,
      ...(d.device ? { device: d.device } : {}),
      ...(d.os_version ? { osVersion: d.os_version } : {}),
      ...(d.image_tag ? { imageTag: d.image_tag } : {}),
    });
    leased = !r.reused;
  }
  const record = await tapdance.current();
  if (record === undefined) {
    throw new TapdanceError("NO_ACTIVE_LEASE", "This session holds no device and the scenario names none to lease", {
      hint: `Add a device: block (platform, device) to the scenario, or lease one first with \`${leaseCommand(tapdance.resolved.config)}\`.`,
    });
  }
  const h = record.handle;
  const wanted = scenario.platform ?? scenario.device?.platform;
  if (wanted && h.platform !== wanted) {
    throw new TapdanceError("USAGE", `The scenario is for ${wanted} but this session holds ${h.model} (${h.platform})`, {
      hint: "Release it with `tapdance device release`, or run a scenario written for this platform.",
    });
  }

  const dir = resolve(options.artifactsDir ?? join(tapdance.artifacts.sessionDir(tapdance.sessionId), "runs", `${startedAt.replace(/[:.]/g, "-")}-${slug(scenario.name)}`));
  await mkdir(dir, { recursive: true });
  const ctx: RunContext = {
    tapdance,
    dir,
    resolvePath: options.resolvePath ?? ((p) => resolve(baseDir, p)),
    recording: false,
    recordings: 0,
    ...(scenario.app?.id ? { appId: scenario.app.id } : {}),
  };
  const steps: ScenarioStep[] = [
    ...(scenario.app?.path ? [{ action: "install_app" as const, args: { path: scenario.app.path, ...(scenario.app.id ? { app_id: scenario.app.id } : {}) }, name: "install the scenario's app" }] : []),
    ...scenario.steps,
  ];

  const reports: StepReport[] = [];
  let stopped = false;
  for (const [i, step] of steps.entries()) {
    const index = i + 1;
    const name = step.name ?? describeStep(step);
    let report: StepReport;
    if (stopped) {
      report = { index, name, action: step.action, status: "skipped", durationMs: 0 };
    } else {
      // Long runs keep the lease alive; another renewer (keepalive, MCP server) is left alone.
      await renewIfDue(tapdance, { idleMs: 0 }).catch(() => undefined);
      const stepStarted = Date.now();
      try {
        const evidence = await withTimeout(runStep(ctx, step, index, name), step);
        report = { index, name, action: step.action, status: "pass", durationMs: Date.now() - stepStarted, ...(evidence ? { evidence } : {}) };
      } catch (error) {
        const e = toTapdanceError(error);
        const durationMs = Date.now() - stepStarted;
        const lost = e.code === "LEASE_LOST" || e.code === "NO_ACTIVE_LEASE";
        const evidence = lost ? undefined : await captureFailure(ctx, index, name);
        report = {
          index,
          name,
          action: step.action,
          status: "fail",
          durationMs,
          error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) },
          ...(evidence ? { evidence } : {}),
        };
        // Without a device nothing after this can run.
        if (lost || !(options.continueOnFailure || step.continue_on_failure)) stopped = true;
      }
    }
    reports.push(report);
    options.onStep?.(report);
  }

  // A recording the scenario started and did not stop is evidence too.
  if (ctx.recording) {
    try {
      const r = await tapdance.stopRecording();
      const last = [...reports].reverse().find((s) => s.action === "start_recording");
      if (last) last.evidence = { ...last.evidence, recording: r.path };
    } catch {
      // The device may be gone.
    }
  }

  let released = false;
  if (leased && !options.keepLease) released = (await tapdance.release().catch(() => ({ released: false }))).released;

  const git = await gitInfo(baseDir);
  const appId = ctx.appId;
  const failed = reports.filter((s) => s.status === "fail").length;
  const report: ScenarioReport = redactObject({
    scenario: scenario.name,
    ...(options.file ? { file: resolve(options.file) } : {}),
    status: failed > 0 ? "fail" : "pass",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    sessionId: tapdance.sessionId,
    device: {
      platform: h.platform,
      model: h.model,
      osVersion: h.osVersion,
      leaseId: h.leaseId,
      location: h.location.kind,
      ...(h.location.workerLabel ?? h.location.workerId ? { worker: (h.location.workerLabel ?? h.location.workerId)! } : {}),
    },
    ...(appId ? { app: { id: appId } } : {}),
    leased,
    released,
    environment: { tapdance: sdkVersion(), node: process.version, host: `${osPlatform()} ${osRelease()}`, ...(git ? { git } : {}) },
    summary: { passed: reports.filter((s) => s.status === "pass").length, failed, skipped: reports.filter((s) => s.status === "skipped").length },
    steps: reports,
    evidenceDir: dir,
    reportPath: join(dir, "report.json"),
    summaryPath: join(dir, "report.md"),
  } satisfies ScenarioReport);

  await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(report.summaryPath, renderScenarioMarkdown(report));
  const base = { kind: "other" as const, sessionId: tapdance.sessionId, leaseId: h.leaseId };
  await tapdance.artifacts.record({ ...base, path: report.reportPath, note: `scenario "${scenario.name}" ${report.status.toUpperCase()}: report.json` });
  await tapdance.artifacts.record({ ...base, path: report.summaryPath, note: `scenario "${scenario.name}" ${report.status.toUpperCase()}: report.md` });
  return report;
}

/** The short human summary written as report.md. */
export function renderScenarioMarkdown(r: ScenarioReport): string {
  const rel = (p: string) => (p.startsWith(`${r.evidenceDir}/`) ? p.slice(r.evidenceDir.length + 1) : p);
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `# ${r.scenario}: ${r.status.toUpperCase()}`,
    "",
    `- Device: ${r.device.model}, ${r.device.platform === "ios" ? "iOS" : "Android"} ${r.device.osVersion} (${r.device.location}${r.device.worker ? `, worker ${r.device.worker}` : ""}), lease ${r.device.leaseId}`,
    ...(r.app ? [`- App: ${r.app.id}${r.app.version ? ` ${r.app.version}` : ""}`] : []),
    `- Started: ${r.startedAt}, took ${(r.durationMs / 1000).toFixed(1)} s`,
    `- Steps: ${r.summary.passed} passed, ${r.summary.failed} failed, ${r.summary.skipped} skipped`,
    `- Session: ${r.sessionId}${r.file ? `; file ${r.file}` : ""}`,
    `- Environment: Tapdance ${r.environment.tapdance}, Node ${r.environment.node}, ${r.environment.host}${r.environment.git ? `, git ${r.environment.git.commit.slice(0, 12)}${r.environment.git.branch ? ` (${r.environment.git.branch})` : ""}` : ""}`,
    "",
    "| # | Step | Result | ms | Evidence |",
    "| --- | --- | --- | --- | --- |",
    ...r.steps.map((s) => {
      const files = Object.values(s.evidence ?? {}).map((p) => `\`${rel(p)}\``);
      return `| ${s.index} | ${cell(s.name)} | ${s.status.toUpperCase()} | ${s.durationMs} | ${files.join(", ")} |`;
    }),
  ];
  const failures = r.steps.filter((s) => s.status === "fail");
  if (failures.length) {
    lines.push("", "## Failures", "");
    for (const s of failures) {
      lines.push(`- Step ${s.index} (${cell(s.name)}): \`${s.error?.code}\` ${s.error?.message ?? ""}${s.error?.hint ? ` Fix: ${s.error.hint}` : ""}`);
    }
  }
  lines.push("", "Replayed by Tapdance from a scenario file. A replay repeats the steps; it does not restore app data, accounts, network, location or time.", "");
  return lines.join("\n");
}

// ------------------------------------------------------------------ recorder

export interface RecordedToolCall {
  tool: string;
  arguments?: Record<string, unknown>;
  /** A call that failed is left out of the scenario. */
  isError?: boolean;
}

/** MCP tools that only read or that end the session: nothing to replay. */
const NOT_REPLAYED = new Set([
  "list_workers",
  "list_devices",
  "get_device_status",
  "release_device",
  "inspect_screen",
  "get_logs",
  "get_crash_logs",
  "list_apps",
  "list_tools",
  "get_test_artifacts",
  "run_scenario",
]);

/**
 * Turns the MCP tool calls of a session into a scenario: lease_device becomes the `device` block,
 * device actions become steps with the same arguments, reads are dropped. `notes` lists what will not
 * replay faithfully (refs from an old screen, external tools), so nobody mistakes it for a perfect copy.
 */
export function scenarioFromToolCalls(calls: RecordedToolCall[], options: { name?: string } = {}): { scenario: Scenario; notes: string[] } {
  const notes: string[] = [];
  const steps: Array<Record<string, unknown>> = [];
  let device: Record<string, unknown> | undefined;
  for (const [i, call] of calls.entries()) {
    const args = { ...(call.arguments ?? {}) };
    if (call.isError) {
      notes.push(`Call ${i + 1} (${call.tool}) failed and was left out.`);
      continue;
    }
    if (call.tool === "lease_device") {
      device = Object.fromEntries(["platform", "device", "os_version", "image_tag"].filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
      continue;
    }
    if (call.tool === "execute_tool") {
      notes.push(`Call ${i + 1} (execute_tool ${String(args["tool"] ?? "")}) is not replayed: scenarios only drive the device.`);
      continue;
    }
    if (NOT_REPLAYED.has(call.tool)) continue;
    if (!Object.hasOwn(STEP_ARGS, call.tool)) {
      notes.push(`Call ${i + 1} (${call.tool}) is not a scenario step and was left out.`);
      continue;
    }
    if (call.tool === "handle_alert" && args["action"] === "get") continue;
    if (call.tool === "take_screenshot") delete args["include_image"];
    if ((call.tool === "tap" && args["ref"] !== undefined) || (call.tool === "type_text" && args["into_ref"] !== undefined)) {
      notes.push(`Step ${steps.length + 1} (${call.tool}) targets a ref (${String(args["ref"] ?? args["into_ref"])}), which belongs to one screen and will not match on replay; change it to text or id.`);
    }
    steps.push({ [call.tool]: args });
  }
  if (steps.length === 0) {
    throw new TapdanceError("USAGE", "None of these tool calls is a step that can be replayed", { hint: "Record device actions such as launch_app, tap, type_text and wait_for." });
  }
  const scenario = validateScenario({ name: options.name ?? "Recorded session", ...(device ? { device } : {}), steps }, "built from tool calls");
  return { scenario, notes };
}
