import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { TapdanceError, redactSecrets } from "@tapdance/core";

/**
 * Integration metadata for external CLIs Tapdance makes available. This is deliberately *not* a
 * catalogue of their commands: arguments are forwarded unchanged, so a subcommand added upstream works
 * as soon as the installed executable has it. Agents discover commands with the tool's own help.
 */
export interface ToolSpec {
  name: string;
  description: string;
  executable: string;
  homepage: string;
  license: string;
  /** Where it can run. */
  os: Array<"darwin" | "linux" | "win32">;
  /** Where Tapdance should run it. `lease` tools act on the leased device and get its id injected. */
  location: "control" | "mac" | "lease";
  versionArgs: string[];
  /** How an agent finds commands: the tool's own discovery entry points. */
  discovery: string[];
  install: string;
  /** Environment variables passed through besides the base set. Prefix entries end with `*`. */
  env: string[];
  /** The tool's own read-only switch, applied to agent (MCP) calls unless mutation is authorized. */
  readOnlyEnv?: { name: string; value: string };
  /** For `lease` tools: how to name the leased device, and flags the caller may not pass. */
  deviceArgs?: (deviceId: string) => string[];
  /** For `lease` tools that pick the device from the environment (adb-based tools). */
  deviceEnv?: (deviceId: string, ctx: { adbServerPort?: number }) => Record<string, string>;
  /** Which platforms a `lease` tool can act on. */
  platforms?: Array<"android" | "ios">;
  refusedArgs?: RegExp;
  notes?: string;
}

export const TOOLS: ToolSpec[] = [
  {
    name: "asc",
    description: "Official App Store Connect CLI: apps, TestFlight, builds, metadata, screenshots, subscriptions, analytics, signing, Xcode Cloud and more",
    executable: "asc",
    homepage: "https://github.com/rorkai/App-Store-Connect-CLI",
    license: "MIT (Rudrank Riyam)",
    os: ["darwin", "linux", "win32"],
    location: "control",
    versionArgs: ["--version"],
    discovery: ["asc --help", "asc search \"<what you want to do>\" --output json", "asc <command> --help", "asc docs", "asc install-skills"],
    install: "brew install asc  (or see https://asccli.sh/ for other platforms)",
    env: ["ASC_*"],
    readOnlyEnv: { name: "ASC_READ_ONLY", value: "1" },
    notes: "Commands that build, archive or sign need Xcode and therefore a Mac.",
  },
  {
    name: "android",
    description: "Google's official Android CLI for agents: project setup, SDK and emulators, builds, install/run, layout, input, annotated screenshots, profiling, docs and skills",
    executable: "android",
    homepage: "https://developer.android.com/cli",
    license: "Google (see the Android CLI terms)",
    os: ["darwin", "linux", "win32"],
    location: "lease",
    platforms: ["android"],
    versionArgs: ["--version"],
    discovery: ["android --help", "android <command> --help"],
    install: "See https://developer.android.com/tools/agents/android-cli/download",
    env: ["ANDROID_*", "JAVA_HOME", "GRADLE_*"],
    // Simlock runs its emulators on its own adb server; point adb-based tools at it and at the lease.
    deviceEnv: (serial, ctx) => ({ ANDROID_SERIAL: serial, ...(ctx.adbServerPort ? { ANDROID_ADB_SERVER_PORT: String(ctx.adbServerPort) } : {}) }),
    notes: "Device targeting uses adb's ANDROID_SERIAL and ANDROID_ADB_SERVER_PORT; not yet verified against a real Android CLI install. Commands that do not touch a device (docs, project setup) also work without a lease.",
  },
  {
    name: "fastlane",
    description: "fastlane (supply for Google Play: uploads, metadata, screenshots, tracks; deliver/pilot for Apple)",
    executable: "fastlane",
    homepage: "https://github.com/fastlane/fastlane",
    license: "MIT",
    os: ["darwin", "linux"],
    location: "control",
    versionArgs: ["--version"],
    discovery: ["fastlane actions", "fastlane action supply", "fastlane supply --help"],
    install: "brew install fastlane  (or gem install fastlane)",
    env: ["FASTLANE_*", "SUPPLY_*", "LC_ALL", "GEM_*", "BUNDLE_*"],
    notes: "Has no read-only mode: agents can run it only when the user lists it in tools.allowMutation.",
  },
  {
    name: "axe",
    description: "AXe: iOS Simulator accessibility, taps, gestures, typing, screenshots and video, driven on the Mac hosting the simulator",
    executable: "axe",
    homepage: "https://github.com/cameroncooke/AXe",
    license: "MIT (Cameron Cooke); bundles Meta IDB (MIT)",
    os: ["darwin"],
    location: "lease",
    platforms: ["ios"],
    versionArgs: ["--version"],
    discovery: ["axe --help", "axe <command> --help"],
    install: "brew install cameroncooke/axe/axe",
    env: [],
    deviceArgs: (udid) => ["--udid", udid],
    refusedArgs: /^--udid(=|$)/,
    notes: "Runs only on the Mac that hosts the leased simulator (local mode). Tapdance appends --udid of the leased simulator.",
  },
  {
    name: "maestro",
    description: "Maestro: declarative end-to-end UI flows for Android and iOS",
    executable: "maestro",
    homepage: "https://github.com/mobile-dev-inc/maestro",
    license: "Apache-2.0",
    os: ["darwin", "linux", "win32"],
    location: "lease",
    platforms: ["android", "ios"],
    versionArgs: ["--version"],
    discovery: ["maestro --help", "maestro test --help"],
    install: "curl -fsSL https://get.maestro.mobile.dev | bash",
    env: ["MAESTRO_*", "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT"],
    deviceArgs: (id) => ["--device", id],
    refusedArgs: /^--(device|udid)(=|$)/,
    notes: "Needs direct adb/simctl access to the device, so it works where the device runs (local mode). Tapdance appends --device of the leased device.",
  },
  {
    name: "xcodebuild",
    description: "Apple's build tool: build, test, archive and export iOS apps",
    executable: "xcodebuild",
    homepage: "https://developer.apple.com/xcode/",
    license: "Apple Xcode license",
    os: ["darwin"],
    location: "mac",
    versionArgs: ["-version"],
    discovery: ["xcodebuild -help", "xcodebuild -list"],
    install: "Install Xcode from the App Store or developer.apple.com, then `sudo xcode-select -s /Applications/Xcode.app`",
    env: ["DEVELOPER_DIR"],
  },
];

const BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TERM", "TZ"];
const MAX_CAPTURE = 64 * 1024;

export function findTool(name: string): ToolSpec {
  const spec = TOOLS.find((t) => t.name === name);
  if (!spec) {
    throw new TapdanceError("USAGE", `Unknown tool "${name}"`, { hint: `Known tools: ${TOOLS.map((t) => t.name).join(", ")}. See \`tapdance tools list\`.` });
  }
  return spec;
}

/** Resolves an executable on PATH (or an absolute override) without running a shell. */
export function locate(executable: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isAbsolute(executable)) return existsSync(executable) ? executable : undefined;
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    const candidate = join(dir, executable);
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function toolEnv(spec: ToolSpec, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  const allowed = [...BASE_ENV, ...spec.env];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (allowed.some((a) => (a.endsWith("*") ? key.startsWith(a.slice(0, -1)) : key === a))) out[key] = value;
  }
  return out;
}

export interface ToolRun {
  tool: string;
  executable: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** True when stdout/stderr above were cut; the full output is in the files. */
  truncated: boolean;
  stdoutPath?: string;
  stderrPath?: string;
  readOnly: boolean;
  timedOut: boolean;
}

export interface RunToolOptions {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Apply the tool's own read-only switch (agent calls without authorization). */
  readOnly?: boolean;
  /** Device id for `lease` tools; omit to run a lease tool's device-free commands. */
  deviceId?: string;
  adbServerPort?: number;
  /** Write full output here (artifact files). */
  outputPrefix?: string;
  /** Stream to the terminal instead of capturing (CLI pass-through). */
  inherit?: boolean;
  signal?: AbortSignal;
  executableOverride?: string;
}

/** Runs the real executable with an argument array (never a shell) and preserves its result. */
export async function runTool(spec: ToolSpec, options: RunToolOptions): Promise<ToolRun> {
  const env = options.env ?? process.env;
  if (!spec.os.includes(process.platform as "darwin")) {
    throw new TapdanceError("NOT_SUPPORTED", `${spec.name} does not run on ${process.platform}`, {
      hint: spec.location === "mac" || spec.os.length === 1 ? "Run it on a Mac. Remote Mac execution targets are not implemented yet; see STATUS.md." : undefined,
    });
  }
  const executable = locate(options.executableOverride ?? spec.executable, env);
  if (!executable) {
    throw new TapdanceError("PROVIDER_UNAVAILABLE", `${spec.name} is not installed on this machine`, { hint: `Install: ${spec.install}` });
  }
  for (const arg of options.args) {
    if (typeof arg !== "string" || arg.includes("\u0000")) throw new TapdanceError("USAGE", "Arguments must be plain strings");
    if (spec.refusedArgs?.test(arg)) {
      throw new TapdanceError("FORBIDDEN", `${spec.name} acts on the leased device; do not pass ${arg}`, { hint: "Tapdance adds the leased device itself." });
    }
  }
  const args = [...options.args, ...(spec.location === "lease" && options.deviceId && spec.deviceArgs ? spec.deviceArgs(options.deviceId) : [])];
  if (spec.location === "lease" && !options.deviceId && spec.deviceArgs) {
    throw new TapdanceError("NO_ACTIVE_LEASE", `${spec.name} acts on the session's device; lease one first`);
  }
  const childEnv = toolEnv(spec, env);
  if (spec.location === "lease") {
    // Never let an inherited selector point the tool at a device outside the lease.
    for (const key of ["ANDROID_SERIAL", "ANDROID_ADB_SERVER_PORT", "ANDROID_ADB_SERVER_ADDRESS"]) delete childEnv[key];
    if (options.deviceId && spec.deviceEnv) Object.assign(childEnv, spec.deviceEnv(options.deviceId, { ...(options.adbServerPort ? { adbServerPort: options.adbServerPort } : {}) }));
  }
  const readOnly = Boolean(options.readOnly && spec.readOnlyEnv);
  if (readOnly && spec.readOnlyEnv) childEnv[spec.readOnlyEnv.name] = spec.readOnlyEnv.value;

  const started = Date.now();
  const child = spawn(executable, args, {
    cwd: options.cwd ?? process.cwd(),
    env: childEnv,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    ...(options.signal ? { signal: options.signal } : {}),
  });
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const files = options.outputPrefix && !options.inherit
    ? { out: createWriteStream(`${options.outputPrefix}.stdout.txt`, { mode: 0o600 }), err: createWriteStream(`${options.outputPrefix}.stderr.txt`, { mode: 0o600 }) }
    : undefined;
  const keep = (current: string, chunk: string) => {
    const next = current + chunk;
    if (next.length > MAX_CAPTURE) {
      truncated = true;
      return next.slice(-MAX_CAPTURE);
    }
    return next;
  };
  child.stdout?.on("data", (d: Buffer) => {
    stdout = keep(stdout, d.toString("utf8"));
    files?.out.write(d);
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr = keep(stderr, d.toString("utf8"));
    files?.err.write(d);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, options.timeoutMs ?? 10 * 60_000);
  const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, sig) => resolve([code, sig]));
  }).finally(() => clearTimeout(timer));
  await Promise.all([files?.out, files?.err].map((s) => (s ? new Promise((r) => s.end(r)) : undefined)));
  return {
    tool: spec.name,
    executable,
    args,
    exitCode,
    signal,
    durationMs: Date.now() - started,
    stdout: redactSecrets(stdout),
    stderr: redactSecrets(stderr),
    truncated,
    ...(files ? { stdoutPath: `${options.outputPrefix}.stdout.txt`, stderrPath: `${options.outputPrefix}.stderr.txt` } : {}),
    readOnly,
    timedOut,
  };
}

export interface ToolStatus {
  name: string;
  description: string;
  installed: boolean;
  path?: string;
  version?: string;
  supportedHere: boolean;
  location: ToolSpec["location"];
  license: string;
  homepage: string;
  install: string;
  discovery: string[];
  notes?: string;
}

export async function toolStatus(spec: ToolSpec, env: NodeJS.ProcessEnv = process.env): Promise<ToolStatus> {
  const path = locate(spec.executable, env);
  let version: string | undefined;
  if (path) {
    try {
      const r = await runTool(spec, { args: spec.versionArgs, env, timeoutMs: 15_000 });
      version = `${r.stdout}${r.stderr}`.trim().split("\n")[0];
    } catch {
      version = undefined;
    }
  }
  return {
    name: spec.name,
    description: spec.description,
    installed: path !== undefined,
    ...(path ? { path } : {}),
    ...(version ? { version } : {}),
    supportedHere: spec.os.includes(process.platform as "darwin"),
    location: spec.location,
    license: spec.license,
    homepage: spec.homepage,
    install: spec.install,
    discovery: spec.discovery,
    ...(spec.notes ? { notes: spec.notes } : {}),
  };
}
