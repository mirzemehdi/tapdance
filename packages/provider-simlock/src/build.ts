import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { TapdanceError } from "@tapdance/core";

/**
 * Builds an app on the machine that runs the devices, from an allow-listed git repository, so an
 * agent on another machine (a Linux VPS with no Xcode) can test an iOS app (#45). The worker guard
 * runs it; nothing here is reachable without `allow.builds`.
 *
 * Building runs the project's own scripts (Xcode run-script phases, Gradle), so it is code execution
 * on this machine as this account by design. The guard limits *which* code: repositories on the
 * owner's allow-list, optionally only commits already on protected branches.
 */

export interface BuildRequest {
  repo: string;
  ref: string;
  platform: "ios" | "android";
  /** iOS: a .xcodeproj or .xcworkspace inside the repository (found when there is only one). */
  project?: string;
  scheme?: string;
  configuration?: string;
  /** iOS: extra build settings, KEY=VALUE, from XCODE_SETTING_KEYS only (#53). */
  xcodeSettings?: string[];
  /** Android: the Gradle task (default assembleDebug); `dir` is the folder with gradlew. */
  gradleTask?: string;
  dir?: string;
}

export interface BuildSettings {
  repos: string[];
  protectedRefs: string[];
  gitAuth: "none" | "gh" | "deploy-key";
  timeoutMinutes: number;
  /** The private key `host builds key` created, for gitAuth deploy-key. */
  deployKeyPath?: string;
}

export interface BuildResult {
  sha: string;
  /** The built .app or .apk on this machine. */
  artifact: string;
  seconds: number;
}

/** Runs one command; resolves with its exit code and output (lines also go to `onLine`). */
export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; onLine: (line: string) => void },
) => Promise<{ code: number; output: string }>;

const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const PROJECT = /^(?![/~])(?!.*\.\.)[A-Za-z0-9 _./-]{1,300}\.(xcodeproj|xcworkspace)$/;
const NAME = /^[A-Za-z0-9 _.-]{1,100}$/;
const GRADLE_TASK = /^[A-Za-z0-9:_-]{1,200}$/;
const DIR = /^(?![/~])(?!.*\.\.)[A-Za-z0-9 _./-]{1,300}$/;
const SETTING_VALUE = /^[A-Za-z0-9 _.,=-]{0,200}$/;

/**
 * Build settings a caller may pass (#53). A short list on purpose: settings that name tools or paths
 * (CC, SWIFT_EXEC, OTHER_SWIFT_FLAGS…) would let a caller run code the owner never reviewed.
 */
export const XCODE_SETTING_KEYS = [
  "ARCHS",
  "EXCLUDED_ARCHS",
  "ONLY_ACTIVE_ARCH",
  "SWIFT_ACTIVE_COMPILATION_CONDITIONS",
  "GCC_PREPROCESSOR_DEFINITIONS",
  "SWIFT_OPTIMIZATION_LEVEL",
  "GCC_OPTIMIZATION_LEVEL",
  "SWIFT_COMPILATION_MODE",
  "ENABLE_TESTABILITY",
  "DEBUG_INFORMATION_FORMAT",
  "COMPILER_INDEX_STORE_ENABLE",
  "IPHONEOS_DEPLOYMENT_TARGET",
  "KOTLIN_FRAMEWORK_BUILD_TYPE",
  "PRODUCT_BUNDLE_IDENTIFIER",
  "MARKETING_VERSION",
  "CURRENT_PROJECT_VERSION",
] as const;

/** A repository URL as compared with the allow-list: lower-case host, no trailing slash or .git. */
export function normalizeRepo(url: string): string {
  let u = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const ssh = /^git@([^:]+):(.+)$/.exec(u);
  if (ssh) u = `ssh://git@${ssh[1]}/${ssh[2]}`;
  return u.replace(/^([a-z+]+:\/\/)([^/]+)/i, (_m, scheme: string, host: string) => `${scheme.toLowerCase()}${host.toLowerCase()}`);
}

/** Checks a build request against the owner's settings; throws a TapdanceError naming what to fix. */
export function checkBuildRequest(body: unknown, settings: BuildSettings): BuildRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
  const repo = str("repo");
  const ref = str("ref");
  const platform = str("platform");
  if (!repo || !ref || (platform !== "ios" && platform !== "android")) throw new TapdanceError("USAGE", "A build needs repo, ref and platform (ios or android)");
  if (!/^(https:\/\/|ssh:\/\/|git@)/.test(repo)) throw new TapdanceError("USAGE", "repo must be an https:// or ssh git URL");
  if (!settings.repos.map(normalizeRepo).includes(normalizeRepo(repo))) {
    throw new TapdanceError("FORBIDDEN", `${repo} is not on this host's build allow-list`, { hint: "The host owner adds it: tapdance host builds enable --repo <url>" });
  }
  if (!REF.test(ref)) throw new TapdanceError("USAGE", "ref must be a branch, tag or commit sha");
  const req: BuildRequest = { repo, ref, platform };
  const project = str("project");
  if (project !== undefined) {
    if (!PROJECT.test(project)) throw new TapdanceError("USAGE", "project must be a .xcodeproj or .xcworkspace path inside the repository");
    req.project = project;
  }
  for (const key of ["scheme", "configuration"] as const) {
    const v = str(key);
    if (v !== undefined) {
      if (!NAME.test(v)) throw new TapdanceError("USAGE", `${key} has characters that are not allowed`);
      req[key] = v;
    }
  }
  const task = str("gradleTask");
  if (task !== undefined) {
    if (!GRADLE_TASK.test(task)) throw new TapdanceError("USAGE", "gradleTask must be a Gradle task path such as :androidApp:assembleDebug");
    req.gradleTask = task;
  }
  const settingsAsked = b["xcodeSettings"];
  if (settingsAsked !== undefined) {
    if (!Array.isArray(settingsAsked) || settingsAsked.length > 20) throw new TapdanceError("USAGE", "xcodeSettings must be a list of up to 20 KEY=VALUE strings");
    req.xcodeSettings = settingsAsked.map((entry) => {
      const m = typeof entry === "string" ? /^([A-Z0-9_]+)=(.*)$/.exec(entry) : null;
      if (!m || !(XCODE_SETTING_KEYS as readonly string[]).includes(m[1]!)) {
        throw new TapdanceError("USAGE", `xcode setting ${String(entry)} is not allowed`, { hint: `Allowed keys: ${XCODE_SETTING_KEYS.join(", ")}.` });
      }
      if (!SETTING_VALUE.test(m[2]!)) throw new TapdanceError("USAGE", `${m[1]} has characters that are not allowed (letters, digits, space and _ . , = - only)`);
      return `${m[1]}=${m[2]}`;
    });
  }
  const dir = str("dir");
  if (dir !== undefined) {
    if (!DIR.test(dir)) throw new TapdanceError("USAGE", "dir must be a folder inside the repository");
    req.dir = dir;
  }
  return req;
}

/** Where a repository's clone and build caches live under `root`. */
export function buildCacheDir(root: string, repo: string): string {
  return join(root, createHash("sha256").update(normalizeRepo(repo)).digest("hex").slice(0, 16));
}

/** Fetches, checks out and builds `req`; returns the commit and the built artifact. */
export async function runBuild(req: BuildRequest, settings: BuildSettings, root: string, onLine: (line: string) => void, run: CommandRunner = spawnRunner): Promise<BuildResult> {
  const started = Date.now();
  const deadline = started + settings.timeoutMinutes * 60_000;
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new TapdanceError("TIMEOUT", `The build took longer than ${settings.timeoutMinutes} min`, { hint: "The host owner can raise builds.timeoutMinutes in ~/.tapdance/worker/policy.json." });
    return ms;
  };
  const cache = buildCacheDir(root, req.repo);
  const src = join(cache, "src");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const env = gitEnv(settings);
  const step = async (command: string, args: string[], what: string, cwd?: string, extraEnv: NodeJS.ProcessEnv = {}) => {
    onLine(`$ ${command} ${args.join(" ")}`);
    const digest = new FailureDigest();
    const r = await run(command, args, { ...(cwd ? { cwd } : {}), env: { ...env, ...extraEnv }, timeoutMs: left(), onLine: (l) => (digest.add(l), onLine(l)) });
    if (r.code !== 0) {
      // The cause is often hundreds of lines above the end (#53): name it in the message itself.
      const cause = digest.lines();
      const fix = missingSdkHint(cause.join("\n"));
      throw new TapdanceError("DEVICE_ERROR", `${what} failed (exit ${r.code})${cause.length > 0 ? `:\n  ${cause.join("\n  ")}` : ""}`, {
        ...(fix ? { hint: fix } : {}),
        details: { digest: cause, tail: r.output.split("\n").slice(-30).join("\n") },
      });
    }
    return r.output;
  };
  const git = (args: string[], what: string) => step("git", ["-C", src, ...args], what);

  // 1. Clone once; later builds fetch only what changed.
  if (!existsSync(join(src, ".git"))) {
    await step("git", ["clone", "--no-checkout", "--filter=blob:none", req.repo, src], "git clone");
  } else {
    await git(["remote", "set-url", "origin", req.repo], "git remote set-url");
    await git(["fetch", "--prune", "--tags", "origin", "+refs/heads/*:refs/remotes/origin/*"], "git fetch");
  }
  // 2. The exact commit: a branch on the remote first, else a tag or a sha.
  const sha = await resolveRef(src, req.ref, env, run, left);
  if (!sha) throw new TapdanceError("USAGE", `ref ${req.ref} was not found in ${req.repo}`);
  onLine(`Building ${req.repo} at ${sha} (${req.ref})`);
  // 3. Protected refs: only commits already on one of them.
  if (settings.protectedRefs.length > 0) {
    let onProtected = false;
    for (const p of settings.protectedRefs) {
      const r = await run("git", ["-C", src, "merge-base", "--is-ancestor", sha, `origin/${p}`], { env, timeoutMs: left(), onLine: () => undefined });
      if (r.code === 0) onProtected = true;
    }
    if (!onProtected) {
      throw new TapdanceError("FORBIDDEN", `${sha.slice(0, 12)} is not on a protected branch (${settings.protectedRefs.join(", ")})`, {
        hint: "This host builds only reviewed commits: merge the change first, or ask the host owner to change builds.protectedRefs.",
      });
    }
  }
  await git(["checkout", "--force", "--detach", sha], "git checkout");
  await git(["clean", "-ffd"], "git clean");
  if (existsSync(join(src, ".gitmodules"))) {
    // A submodule the host cannot fetch (another account, ssh without a key) is often docs or tooling
    // the app does not need: warn and build; the build fails on its own if it did need it.
    await git(["submodule", "update", "--init", "--recursive"], "git submodule update").catch((error: unknown) =>
      onLine(`warning: some submodules could not be fetched (${(error as Error).message}); building without them`),
    );
  }

  const artifact = req.platform === "ios" ? await buildIos(req, src, cache, step) : await buildAndroid(req, src, step);
  onLine(`Built ${relative(cache, artifact)}`);
  return { sha, artifact, seconds: Math.round((Date.now() - started) / 1000) };
}

async function resolveRef(src: string, ref: string, env: NodeJS.ProcessEnv, run: CommandRunner, left: () => number): Promise<string | undefined> {
  for (const candidate of [`origin/${ref}`, ref]) {
    const r = await run("git", ["-C", src, "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { env, timeoutMs: left(), onLine: () => undefined });
    const sha = r.output.trim().split("\n").pop()?.trim();
    if (r.code === 0 && sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return undefined;
}

type Step = (command: string, args: string[], what: string, cwd?: string, extraEnv?: NodeJS.ProcessEnv) => Promise<string>;

async function buildIos(req: BuildRequest, src: string, cache: string, step: Step): Promise<string> {
  const project = req.project ?? (await findXcodeProject(src));
  const full = resolve(src, project);
  if (!full.startsWith(src + sep) || !existsSync(full)) throw new TapdanceError("USAGE", `${project} is not in the repository`);
  const scheme = req.scheme ?? project.split("/").pop()!.replace(/\.(xcodeproj|xcworkspace)$/, "");
  const configuration = req.configuration ?? "Debug";
  const derived = join(cache, "DerivedData");
  // The generic simulator destination builds every simulator arch (arm64 and x86_64), and Kotlin
  // Multiplatform apps usually declare only iosSimulatorArm64 (#53). Build this Mac's arch, as Xcode's
  // Run does; the caller's own ARCHS/ONLY_ACTIVE_ARCH win.
  const extra = req.xcodeSettings ?? [];
  const given = new Set(extra.map((s) => s.split("=")[0]));
  const defaults = [`ARCHS=${hostSimulatorArch()}`, "ONLY_ACTIVE_ARCH=YES"].filter((s) => !given.has(s.split("=")[0]));
  await step(
    "xcodebuild",
    [
      project.endsWith(".xcworkspace") ? "-workspace" : "-project",
      full,
      "-scheme",
      scheme,
      "-configuration",
      configuration,
      "-sdk",
      "iphonesimulator",
      "-destination",
      "generic/platform=iOS Simulator",
      "-derivedDataPath",
      derived,
      // Ad-hoc signing, as Xcode's Run does for a simulator: no team needed, and the app keeps its
      // entitlements (application-identifier, keychain groups), which Keychain needs (#57).
      "CODE_SIGN_IDENTITY=-",
      "CODE_SIGNING_REQUIRED=NO",
      ...defaults,
      ...extra,
      "build",
    ],
    "xcodebuild",
    src,
  );
  const products = join(derived, "Build", "Products", `${configuration}-iphonesimulator`);
  const apps = (await readdir(products).catch(() => [] as string[])).filter((n) => n.endsWith(".app"));
  const app = apps.find((n) => n === `${scheme}.app`) ?? apps[0];
  if (!app) throw new TapdanceError("DEVICE_ERROR", `xcodebuild finished but left no .app in ${products}`);
  return join(products, app);
}

/** The simulator arch this Mac runs natively. */
export function hostSimulatorArch(arch: string = process.arch): string {
  return arch === "x64" ? "x86_64" : "arm64";
}

/**
 * Collects the lines that say why a build failed (#53): compiler errors, Gradle's "What went wrong"
 * block and xcodebuild's list of failed commands. Bounded, so a 25,000-line log costs nothing.
 */
export class FailureDigest {
  private readonly errors: string[] = [];
  private readonly blocks: string[] = [];
  private capture: { end: (line: string) => boolean; left: number } | undefined;

  add(raw: string): void {
    const line = raw.replace(/\s+$/, "");
    if (this.capture) {
      if (this.capture.end(line) || this.capture.left-- <= 0) this.capture = undefined;
      else if (line.trim()) {
        this.push(this.blocks, line.trim(), 30);
        return;
      }
    }
    if (/^\* What went wrong:/.test(line)) {
      this.push(this.blocks, "What went wrong:", 30);
      this.capture = { end: (l) => /^\* (Try|Exception is|Get more help)/.test(l), left: 15 };
    } else if (/^The following build commands failed:/.test(line)) {
      this.push(this.blocks, line, 30);
      this.capture = { end: (l) => l.trim() === "" || /^\(\d+ failures?\)/.test(l.trim()), left: 10 };
    } else if (/(^|\s)(fatal )?error: /i.test(line) || /^e: /.test(line) || /^> Task \S+ FAILED/.test(line)) {
      this.push(this.errors, line.trim(), 12);
    }
  }

  lines(): string[] {
    return [...this.errors, ...this.blocks].slice(0, 40).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l));
  }

  private push(into: string[], line: string, max: number): void {
    if (into.length < max && !into.includes(line)) into.push(line);
  }
}

/**
 * The host's install command when a Gradle build stops on an Android SDK package the host lacks
 * (CMake, an NDK, a platform). Gradle does not fetch these itself; the host owner installs them once.
 */
export function missingSdkHint(text: string): string | undefined {
  const sdkmanager = "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager";
  const cmake = /CMake '([0-9.]+)' was not found/.exec(text);
  if (cmake) return ownerMust(`The host's Android SDK has no CMake ${cmake[1]}`, `${sdkmanager} "cmake;${cmake[1]}"`);
  const ndk = /No version of NDK matched the requested version ([0-9.]+)|NDK (?:at \S+ )?did not have a source\.properties file|ndk;([0-9.]+)/.exec(text);
  if (ndk && (ndk[1] ?? ndk[2])) return ownerMust(`The host's Android SDK has no NDK ${ndk[1] ?? ndk[2]}`, `${sdkmanager} "ndk;${ndk[1] ?? ndk[2]}"`);
  const platform = /Failed to find target with hash string\s+'android-([0-9]+)'|platforms;android-([0-9]+)/.exec(text);
  const api = platform?.[1] ?? platform?.[2];
  if (api) return ownerMust(`The host's Android SDK has no platform android-${api}`, `${sdkmanager} "platforms;android-${api}"`);
  return undefined;
}

/** A fix only the host's owner can make: said so plainly, so an agent asks instead of retrying. */
function ownerMust(what: string, command: string): string {
  return `${what}. Only the host's owner can fix this (an agent cannot install software on the host through Tapdance): ask them to run on the host \`${command}\`, e.g. with request_human / \`tapdance device request-human --reason …\`, then build again.`;
}

/** Whether a build log line belongs in the quiet default view: steps, errors and the outcome (#53). */
export function isNotableBuildLine(line: string): boolean {
  return (
    /^\$ /.test(line) ||
    /^(Building|Built) /.test(line) ||
    /^warning: some submodules/.test(line) ||
    /(^|\s)(fatal )?error: /i.test(line) ||
    /^e: /.test(line) ||
    /\*\* (BUILD|ARCHIVE) (SUCCEEDED|FAILED) \*\*/.test(line) ||
    /^BUILD (SUCCESSFUL|FAILED)/.test(line) ||
    /^> Task \S+ FAILED/.test(line) ||
    /^\* What went wrong:/.test(line)
  );
}

/** The repository's one Xcode workspace (or else project), up to two folders deep. */
async function findXcodeProject(src: string): Promise<string> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name.startsWith(".") || name === "node_modules" || name === "Pods" || name === "build") continue;
      const path = join(dir, name);
      if (/\.(xcodeproj|xcworkspace)$/.test(name)) found.push(relative(src, path));
      else if (depth < 2 && (await stat(path).catch(() => undefined))?.isDirectory()) await walk(path, depth + 1);
    }
  };
  await walk(src, 0);
  const workspaces = found.filter((p) => p.endsWith(".xcworkspace"));
  const pick = workspaces.length > 0 ? workspaces : found;
  if (pick.length !== 1) {
    throw new TapdanceError("USAGE", pick.length === 0 ? "No Xcode project was found in the repository" : `Several Xcode projects were found: ${pick.join(", ")}`, {
      hint: "Pass project (a .xcodeproj or .xcworkspace path inside the repository) and scheme.",
    });
  }
  return pick[0]!;
}

async function buildAndroid(req: BuildRequest, src: string, step: Step): Promise<string> {
  const dir = req.dir ? resolve(src, req.dir) : src;
  if (!(dir === src || dir.startsWith(src + sep))) throw new TapdanceError("USAGE", "dir must be inside the repository");
  const gradlew = join(dir, "gradlew");
  if (!existsSync(gradlew)) throw new TapdanceError("USAGE", `No gradlew in ${req.dir ?? "the repository root"}`, { hint: "Pass dir: the folder that holds gradlew." });
  await chmod(gradlew, 0o755);
  const startedAt = Date.now();
  await step(gradlew, [req.gradleTask ?? "assembleDebug", "--console=plain"], "gradle", dir);
  const apk = await newestApk(dir, startedAt - 5_000);
  if (!apk) throw new TapdanceError("DEVICE_ERROR", "Gradle finished but no new .apk was found under build/outputs/apk");
  return apk;
}

/** The newest .apk under any build/outputs/apk folder, written after `since`. */
async function newestApk(dir: string, since: number): Promise<string | undefined> {
  let best: { path: string; mtime: number } | undefined;
  const walk = async (d: string, depth: number) => {
    for (const name of await readdir(d).catch(() => [] as string[])) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const path = join(d, name);
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      if (info.isDirectory() && depth < 8) await walk(path, depth + 1);
      else if (name.endsWith(".apk") && path.includes(`${sep}outputs${sep}apk${sep}`) && info.mtimeMs >= since && (!best || info.mtimeMs > best.mtime)) best = { path, mtime: info.mtimeMs };
    }
  };
  await walk(dir, 0);
  return best?.path;
}

/** git's environment for the configured auth; credentials never leave this machine. */
function gitEnv(settings: BuildSettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (settings.gitAuth === "gh") {
    // git -c through the environment: the host's `gh auth` answers credential requests for github.com.
    Object.assign(env, { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "!gh auth git-credential" });
  } else if (settings.gitAuth === "deploy-key" && settings.deployKeyPath) {
    env["GIT_SSH_COMMAND"] = `ssh -i '${settings.deployKeyPath.replace(/'/g, "")}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  }
  return env;
}

/** Runs a command with an argument array (no shell), streaming lines and keeping the output's tail. */
export const spawnRunner: CommandRunner = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    let partial = "";
    const take = (chunk: Buffer) => {
      const text = partial + chunk.toString("utf8");
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) options.onLine(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
      tail = (tail + chunk.toString("utf8")).slice(-64_000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new TapdanceError("PROVIDER_UNAVAILABLE", `${command} could not start: ${error.message}`, { hint: command === "xcodebuild" ? "Install Xcode on the host." : undefined }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (partial) options.onLine(partial);
      resolvePromise({ code: code ?? 1, output: tail });
    });
  });
