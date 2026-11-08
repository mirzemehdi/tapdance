import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { TapdanceError, redactSecrets } from "@tapdance/core";
import { buildFilesDigest, isSshUrl, keyFingerprint, normalizeRepo, placeBuildFiles, readBuildFiles, removePlacedBuildFiles, repoDisplay, repoKeyPath } from "./build-files.js";

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
  /**
   * The single key `host builds key` (without --repo) created, for gitAuth deploy-key. A repository's
   * own key (`host builds key --repo <url>`, under the builds folder) wins over it.
   */
  deployKeyPath?: string;
  /**
   * Android: minutes an idle Gradle (and Kotlin) daemon of a host build stays alive (#90). 0 builds
   * with --no-daemon and compiles Kotlin in Gradle's own process. Default 10.
   */
  gradleDaemonIdleMinutes?: number;
}

export interface BuildResult {
  sha: string;
  /** The built .app or .apk on this machine. */
  artifact: string;
  seconds: number;
  /** The same commit and settings were built before: that build was installed again (#61). */
  reused?: boolean;
  /** With `reused`: when that earlier build was made (ISO time). */
  builtAt?: string;
}

/** Runs one command; resolves with its exit code and output (lines also go to `onLine`). */
export type CommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    onLine: (line: string) => void;
    /**
     * Writes stdout (binary) to this file (mode 600) instead of reading it as lines; only stderr reaches
     * `onLine` and `output`. Downloads a CI artifact without a shell redirect.
     */
    stdoutPath?: string;
    /** With `stdoutPath`: stops the command once stdout passes this many bytes (`truncated` in the reply). */
    maxStdoutBytes?: number;
  },
) => Promise<{ code: number; output: string; truncated?: boolean; timedOut?: boolean }>;

const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const PROJECT = /^(?![/~])(?!.*\.\.)[A-Za-z0-9 _./-]{1,300}\.(xcodeproj|xcworkspace)$/;
const NAME = /^(?!-)[A-Za-z0-9 _.-]{1,100}$/;
const GRADLE_TASK = /^(?!-)[A-Za-z0-9:_-]{1,200}$/;
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

export { normalizeRepo };

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
    throw new TapdanceError("FORBIDDEN", `${repo} is not on this host's build allow-list`, { hint: `The host owner adds it: tapdance host builds enable --repo ${repo}` });
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
  const auth = gitAuthContext(root, req.repo, settings);
  const env = gitEnv(settings, auth.key);
  const step = async (command: string, args: string[], what: string, cwd?: string, extraEnv: NodeJS.ProcessEnv = {}) => {
    onLine(`$ ${command} ${args.join(" ")}`);
    const digest = new FailureDigest();
    const r = await run(command, args, { ...(cwd ? { cwd } : {}), env: { ...env, ...extraEnv }, timeoutMs: left(), onLine: (l) => (digest.add(l), onLine(l)) });
    if (r.timedOut) throw new TapdanceError("TIMEOUT", `The build took longer than ${settings.timeoutMinutes} min (stopped during ${what})`, { hint: "The host owner can raise builds.timeoutMinutes in ~/.tapdance/worker/policy.json." });
    if (r.code !== 0) {
      // The cause is often hundreds of lines above the end (#53): name it in the message itself.
      const cause = digest.lines();
      // git's own output is short and its ssh errors carry no "fatal:" prefix: read all of it.
      const gitText = what.startsWith("git") ? `${cause.join("\n")}\n${r.output}` : undefined;
      const offline = hostNetworkHint(gitText ?? cause.join("\n"));
      const signIn = offline || gitText === undefined ? undefined : gitAuthHint(gitText, req.repo, auth);
      const fix = offline ?? signIn ?? missingSdkHint(cause.join("\n"));
      // A host that cannot sign in to the repository is the owner's credential problem, not a device
      // failure: AUTH_FAILED, so an agent asks instead of retrying or leasing again (#85).
      throw new TapdanceError(signIn ? "AUTH_FAILED" : "DEVICE_ERROR", `${what} failed (exit ${r.code})${cause.length > 0 ? `:\n  ${cause.join("\n  ")}` : ""}`, {
        ...(fix ? { hint: fix } : {}),
        details: {
          digest: cause,
          tail: r.output.split("\n").slice(-30).join("\n"),
          ...(offline ? { reason: "HOST_NETWORK" } : signIn ? { reason: "GIT_AUTH", gitAuth: auth.mode, ...(auth.fingerprint ? { keyFingerprint: auth.fingerprint } : {}) } : {}),
        },
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
    try {
      await git(["fetch", "--prune", "--tags", "origin", "+refs/heads/*:refs/remotes/origin/*"], "git fetch");
    } catch (error) {
      // The host cannot reach the remote (#61). A commit id it already has can still be built: a
      // branch name cannot, because the cached branch may be behind the remote.
      if (!/^[0-9a-f]{7,40}$/i.test(req.ref) || !(await resolveRef(src, req.ref, env, run, left))) throw error;
      onLine(`warning: git fetch failed (${(error as Error).message.split("\n").slice(-1)[0]!.trim()}); building ${req.ref} from this host's cache`);
    }
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
  // The same commit and settings built before: install that build again (every lease is a fresh device,
  // so an agent rebuilds the same commit often; #61).
  // Files the owner keeps out of git for this repository: part of what makes two builds the same, so
  // changing one builds again instead of reusing a build made with the old one.
  const files = await readBuildFiles(root, req.repo);
  const key = buildKey(sha, req, buildFilesDigest(files));
  const kept = await keptBuild(cache, key);
  if (kept) {
    onLine(`Reusing the build of ${sha.slice(0, 12)} made ${kept.builtAt} (same commit and settings)`);
    return { sha, artifact: kept.artifact, seconds: Math.round((Date.now() - started) / 1000), reused: true, builtAt: kept.builtAt };
  }
  // Build files a build that died left in the checkout: out before git looks at the tree.
  await removePlacedBuildFiles(src, cache);
  await git(["checkout", "--force", "--detach", sha], "git checkout");
  await git(["clean", "-ffd"], "git clean");
  if (existsSync(join(src, ".gitmodules"))) {
    // A submodule the host cannot fetch (another account, ssh without a key) is often docs or tooling
    // the app does not need: warn and build; the build fails on its own if it did need it.
    // With gh the host has no ssh key: fetch github.com submodules listed with ssh URLs over https,
    // where gh signs in (#86).
    const submoduleEnv = settings.gitAuth === "gh" ? githubOverHttps(env) : {};
    await step("git", ["-C", src, "submodule", "update", "--init", "--recursive"], "git submodule update", undefined, submoduleEnv).catch((error: unknown) =>
      onLine(`warning: some submodules could not be fetched (${(error as Error).message}); building without them`),
    );
  }

  // Copied in after checkout and taken out again after the build, so the next checkout of another
  // commit starts from git's own tree and a removed build file never lingers (an ignored path would
  // survive `git clean`).
  let built: string;
  try {
    await placeBuildFiles(root, req.repo, files, src, cache, onLine);
    built = req.platform === "ios" ? await buildIos(req, src, cache, step) : await buildAndroid(req, src, step, settings.gradleDaemonIdleMinutes);
  } finally {
    await removePlacedBuildFiles(src, cache);
  }
  onLine(`Built ${relative(cache, built)}`);
  const artifact = await keepBuild(cache, key, built).catch(() => built);
  return { sha, artifact, seconds: Math.round((Date.now() - started) / 1000) };
}

/**
 * What makes two builds the same: the commit and every input that changes the result, including the
 * host's build files for the repository (`filesDigest`, empty when it has none).
 */
export function buildKey(sha: string, req: BuildRequest, filesDigest = ""): string {
  // The effective settings, not the request's shape: the CLI sends its defaults (configuration Debug,
  // gradleTask assembleDebug) and the other platform's options, MCP sends only what it was given, and
  // both must land on one key (#104).
  const inputs =
    req.platform === "ios"
      ? [sha, req.platform, req.project ?? "", req.scheme ?? "", req.configuration ?? "Debug", JSON.stringify(req.xcodeSettings ?? [])]
      : [sha, req.platform, req.gradleTask ?? "assembleDebug", normalDir(req.dir)];
  if (filesDigest) inputs.push(`files:${filesDigest}`);
  return createHash("sha256").update(inputs.join("\u0000")).digest("hex").slice(0, 16);
}

/** `dir` as one spelling: "", ".", "./" and a trailing slash name the same folder. */
function normalDir(dir: string | undefined): string {
  return (dir ?? "").replace(/^(\.\/)+/, "").replace(/\/+$/, "").replace(/^\.$/, "");
}

/** The kept build for `key`, if its artifact is still there. */
async function keptBuild(cache: string, key: string): Promise<{ artifact: string; builtAt: string } | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(cache, "kept", "builds.json"), "utf8")) as Record<string, { artifact: string; builtAt: string }>;
    const entry = manifest[key];
    return entry && existsSync(entry.artifact) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copies a finished build out of DerivedData / Gradle's outputs (the next build overwrites those) and
 * records it. Keeps the newest few, so a host does not fill up with old builds.
 */
async function keepBuild(cache: string, key: string, built: string, keep = 3): Promise<string> {
  const dir = join(cache, "kept");
  const target = join(dir, key, basename(built));
  await rm(join(dir, key), { recursive: true, force: true });
  await mkdir(join(dir, key), { recursive: true, mode: 0o700 });
  await cp(built, target, { recursive: true, verbatimSymlinks: true });
  const path = join(dir, "builds.json");
  const manifest = (await readFile(path, "utf8").then((t) => JSON.parse(t) as Record<string, { artifact: string; builtAt: string }>).catch(() => ({}))) as Record<string, { artifact: string; builtAt: string }>;
  manifest[key] = { artifact: target, builtAt: new Date().toISOString() };
  const stale = Object.entries(manifest)
    .sort((a, b) => b[1].builtAt.localeCompare(a[1].builtAt))
    .slice(keep);
  for (const [k] of stale) {
    delete manifest[k];
    await rm(join(dir, k), { recursive: true, force: true });
  }
  await writeFile(path, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return target;
}

/** A step failed because this host cannot reach the network (#61): say whose problem it is. */
export function hostNetworkHint(text: string): string | undefined {
  if (!/Could not resolve host|Failed to connect|Connection (timed out|refused)|Network is unreachable|Temporary failure in name resolution|Could not resolve hostname|unable to access .*: (SSL|OpenSSL)|Could not GET|Connect timed out|UnknownHostException/i.test(text)) return undefined;
  return "The host that builds cannot reach the network for this (DNS or connection to the git server or package repository). This is the host's network, not yours: only the host owner can fix it, e.g. check on the host `dscacheutil -q host -a name github.com`. A commit id the host built or fetched before still builds from its cache: pass --ref <full sha>.";
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
    } else if (/(^|\s)(fatal )?error: /i.test(line) || /^fatal: /.test(line) || /^e: /.test(line) || /^> Task \S+ FAILED/.test(line) || GIT_SIGN_IN_LINE.test(line)) {
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
  // A Kotlin Multiplatform app's Gradle configures its Android modules even for the iOS framework, so an
  // iOS-only host (host-setup.sh --ios-only) without an SDK fails here (Pianolune on a rented Mac).
  if (/SDK location not found/.test(text)) {
    return ownerMust(
      "This app's Gradle build needs an Android SDK, even for iOS (Kotlin Multiplatform configures its Android modules)",
      "scripts/host-setup.sh --ios-only --android-build-sdk",
    );
  }
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

/**
 * git's and ssh's own lines that say why a fetch could not sign in (#85). They carry no "fatal:" or
 * "error:" prefix, so the digest and the quiet view would otherwise drop the one line naming the cause.
 */
const GIT_SIGN_IN_LINE = /Permission denied \(publickey|^(remote: )?(ERROR: )?Repository not found|Host key verification failed|^remote: (Invalid username|Support for password authentication|Write access to repository not granted)|^ERROR: (The key you are authenticating with|Permission to)|Deploy keys are disabled|terminal prompts disabled|Authentication failed for/i;

/** Whether a build log line belongs in the quiet default view: steps, errors and the outcome (#53). */
export function isNotableBuildLine(line: string): boolean {
  return (
    /^\$ /.test(line) ||
    /^(Building|Built) /.test(line) ||
    /^warning: (some submodules|git fetch failed)/.test(line) ||
    /^Reusing the build of /.test(line) ||
    /^using host build file /.test(line) ||
    /^fatal: /.test(line) ||
    GIT_SIGN_IN_LINE.test(line) ||
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

/**
 * Gradle arguments that keep a host build's daemons from holding memory next to the devices (#90).
 * A short idle timeout rather than `gradlew --stop` after each build: an agent that rebuilds within
 * minutes keeps a warm daemon (tens of seconds per build on a Kotlin Multiplatform app), the memory
 * comes back minutes after the last build, and nothing touches the owner's own daemons (`--stop` stops
 * every daemon of that Gradle version on the account, an IDE's included, and leaves Kotlin's running).
 * 0 means no daemon at all: --no-daemon, and Kotlin compiles inside that one Gradle process.
 */
export function gradleDaemonArgs(idleMinutes = 10): string[] {
  if (idleMinutes <= 0) return ["--no-daemon", "-Pkotlin.compiler.execution.strategy=in-process"];
  return [`-Dorg.gradle.daemon.idletimeout=${idleMinutes * 60_000}`, `-Dkotlin.daemon.options=autoshutdownIdleSeconds=${idleMinutes * 60}`];
}

async function buildAndroid(req: BuildRequest, src: string, step: Step, daemonIdleMinutes?: number): Promise<string> {
  const dir = req.dir ? resolve(src, req.dir) : src;
  if (!(dir === src || dir.startsWith(src + sep))) throw new TapdanceError("USAGE", "dir must be inside the repository");
  const gradlew = join(dir, "gradlew");
  if (!existsSync(gradlew)) throw new TapdanceError("USAGE", `No gradlew in ${req.dir ?? "the repository root"}`, { hint: "Pass dir: the folder that holds gradlew." });
  await chmod(gradlew, 0o755);
  const startedAt = Date.now();
  await step(gradlew, [req.gradleTask ?? "assembleDebug", "--console=plain", ...gradleDaemonArgs(daemonIdleMinutes)], "gradle", dir);
  // A Gradle run that found everything up to date writes no new APK (#66): the newest one on disk is
  // the build of this commit, since the checkout just ran.
  const apk = (await newestApk(dir, startedAt - 5_000)) ?? (await newestApk(dir, 0));
  if (!apk) throw new TapdanceError("DEVICE_ERROR", "Gradle finished but no .apk was found under build/outputs/apk", { hint: "Pass the Gradle task that assembles an APK (--gradle-task :app:assembleDebug) and the folder with gradlew (--dir)." });
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

/**
 * The ssh key git uses for `repo`: the repository's own deploy key when the owner created one
 * (`host builds key --repo`; GitHub accepts a deploy key on one repository only), else the single
 * legacy key with gitAuth deploy-key, else none. Only for ssh URLs: an https clone never uses an ssh
 * key (#87).
 */
export function deployKeyFor(buildsRoot: string, repo: string, settings: BuildSettings): string | undefined {
  if (!isSshUrl(repo)) return undefined;
  const own = repoKeyPath(buildsRoot, repo);
  if (existsSync(own)) return own;
  return settings.gitAuth === "deploy-key" ? settings.deployKeyPath : undefined;
}

/** What signs git in for one repository on this host, for hints and the access check (#85, #86). */
export interface GitAuthContext {
  /** Its own deploy key, the shared deploy_key, the host's gh, or nothing (public, or the account's own ssh keys). */
  mode: "repo-key" | "shared-key" | "gh" | "none";
  /** The private key ssh uses, for an ssh URL with a deploy key. */
  key?: string;
  /** That key's SHA256 fingerprint, as GitHub's deploy keys page shows it. */
  fingerprint?: string;
  /** The URL is ssh (a deploy key applies) rather than https (gh applies). */
  ssh: boolean;
  /** An https URL although the repository has a deploy key, or the host uses deploy keys: the key goes unused. */
  keyUnusedOverHttps?: boolean;
}

export function gitAuthContext(buildsRoot: string, repo: string, settings: BuildSettings): GitAuthContext {
  const ssh = isSshUrl(repo);
  const key = deployKeyFor(buildsRoot, repo, settings);
  const fingerprint = key ? keyFingerprint(key) : undefined;
  let ownKey = false;
  try {
    ownKey = existsSync(repoKeyPath(buildsRoot, repo));
  } catch {
    // Not a URL a key could be for.
  }
  const mode: GitAuthContext["mode"] = key ? (key === repoKeyPath(buildsRoot, repo) ? "repo-key" : "shared-key") : settings.gitAuth === "gh" ? "gh" : "none";
  return {
    mode,
    ssh,
    ...(key ? { key } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(!ssh && mode !== "gh" && (ownKey || settings.gitAuth === "deploy-key") ? { keyUnusedOverHttps: true } : {}),
  };
}

/** How `ctx` signs in, in a few words. */
export function describeGitAuth(ctx: GitAuthContext): string {
  if (ctx.mode === "repo-key") return `its own deploy key${ctx.fingerprint ? ` ${ctx.fingerprint}` : ""}`;
  if (ctx.mode === "shared-key") return `the shared deploy key${ctx.fingerprint ? ` ${ctx.fingerprint}` : ""}`;
  if (ctx.mode === "gh") return ctx.ssh ? "no deploy key (gh signs in over https only)" : "gh";
  return ctx.ssh ? "this account's own ssh keys (no deploy key)" : "no credentials";
}

/**
 * git's environment for the configured auth; credentials never leave this machine. `batch` makes ssh
 * fail instead of asking for anything (the access check runs from a terminal; the guard never has one).
 */
export function gitEnv(settings: BuildSettings, sshKey?: string, options: { batch?: boolean } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (settings.gitAuth === "gh") {
    // git -c through the environment: the host's `gh auth` answers credential requests for github.com.
    Object.assign(env, { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "!gh auth git-credential" });
  }
  if (sshKey) {
    // Only this key, never the account's own keys or agent: a deploy key reaches one repository, read-only.
    env["GIT_SSH_COMMAND"] = `ssh -i '${sshKey.replace(/'/g, "")}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;
  } else if (options.batch) {
    env["GIT_SSH_COMMAND"] = "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes";
  }
  return env;
}

/**
 * Extra git config (through the environment) that fetches github.com URLs written for ssh over https,
 * where gh signs in: submodules listed as git@github.com:owner/repo.git in gh mode (#86).
 */
export function githubOverHttps(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const n = Number(env["GIT_CONFIG_COUNT"] ?? 0) || 0;
  return {
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: "url.https://github.com/.insteadOf",
    [`GIT_CONFIG_VALUE_${n}`]: "git@github.com:",
    [`GIT_CONFIG_KEY_${n + 1}`]: "url.https://github.com/.insteadOf",
    [`GIT_CONFIG_VALUE_${n + 1}`]: "ssh://git@github.com/",
  };
}

const SIGN_IN_FAILED = /Permission denied \(publickey|Repository not found|could not read (Username|Password)|Authentication failed|terminal prompts disabled|returned error: 40[13]|Invalid username or (password|token)|Could not read from remote repository|Write access to repository not granted|no such identity|Deploy keys are disabled|Host key verification failed/i;

const OWNER_ONLY = "Only the host's owner can fix this (an agent cannot)";
const GH_WAY = "use gh: on the host `tapdance host gh-login` with a fine-grained, read-only token (Contents: read, this repository only), then `tapdance host builds enable --repo <https url> --git-auth gh`";
const ELSEWHERE = "Or build the app elsewhere and install it with `tapdance app install <path>` (MCP install_app).";

function shownRepo(repo: string): string {
  try {
    return repoDisplay(repo);
  } catch {
    return repo;
  }
}

/**
 * A git step failed because the host could not sign in to the repository: say what to check for the
 * auth this host used (`ctx`: its own deploy key, the shared one, gh), so an agent asks the owner
 * instead of retrying, and the owner knows where to look (#85).
 */
export function gitAuthHint(text: string, repo: string, ctx?: GitAuthContext): string | undefined {
  if (!SIGN_IN_FAILED.test(text)) return undefined;
  const shown = shownRepo(repo);
  if (ctx?.key && ctx.ssh) {
    const which = ctx.mode === "repo-key" ? "its own deploy key" : "the shared deploy key (builds/deploy_key)";
    const disabled = /Deploy keys are disabled/i.test(text) ? " The server says deploy keys are disabled for it." : "";
    return [
      `This host signs in to ${shown} with ${which}${ctx.fingerprint ? ` (${ctx.fingerprint})` : ""}, and the git server refuses it.${disabled}`,
      `${OWNER_ONLY}: add that public key read-only to this repository (GitHub: the repository's Settings › Deploy keys; on the host \`tapdance host builds key --repo <url>\` prints it again),`,
      'and check that the organization allows deploy keys (GitHub: organization Settings › Member privileges › Deploy keys; when they are off, adding one fails with "Deploy keys are disabled").',
      `If deploy keys cannot be used, ${GH_WAY}, and build with the https URL. ${ELSEWHERE}`,
    ].join(" ");
  }
  if (ctx && !ctx.ssh && ctx.mode === "gh") {
    return `The host's gh could not read ${shown}. ${OWNER_ONLY}: the token gh uses on the host must reach this repository (a fine-grained token with Contents: read and this repository selected); check on the host with \`gh auth status\` and \`git ls-remote <https url>\`, or sign in again with \`tapdance host gh-login\`. ${ELSEWHERE}`;
  }
  if (ctx?.keyUnusedOverHttps) {
    return `This build used the https URL of ${shown}, but a deploy key works only over ssh. Build with the ssh URL (git@host:owner/repo.git; the host's owner allows it with \`tapdance host builds enable --repo <ssh url>\`), or the owner can ${GH_WAY}. ${ELSEWHERE}`;
  }
  if (ctx?.ssh && !ctx.key) {
    return [
      `This host has no deploy key for ${shown}, so ssh had only this account's own keys, and they do not reach it. ${OWNER_ONLY}:`,
      "on the host `tapdance host builds key --repo <url>`, then add the printed public key read-only to this repository (GitHub: Settings › Deploy keys; organizations can turn deploy keys off);",
      `or ${GH_WAY}, and build with the https URL. ${ELSEWHERE}`,
    ].join(" ");
  }
  return [
    `This host could not sign in to ${shown} (a private repository, or its git credentials do not reach it). ${OWNER_ONLY}, in one of three ways:`,
    "(1) gh with a fine-grained, read-only token (Contents: read, this repository only): on the host `tapdance host gh-login`, then `tapdance host builds enable --repo <https url> --git-auth gh`;",
    "(2) a deploy key for this repository: on the host `tapdance host builds key --repo <url>`, add the printed public key as a read-only deploy key (GitHub: the repository's Settings › Deploy keys; organizations can turn deploy keys off), and build with the ssh URL (git@github.com:owner/repo.git);",
    "(3) no build on the host: build the app elsewhere and install it with `tapdance app install <path>` (MCP install_app).",
  ].join(" ");
}

/** The outcome of checking that this host can read a repository with the auth its builds will use. */
export interface GitAccess {
  repo: string;
  ok: boolean;
  /** How the host signs in for this repository (`describeGitAuth`). */
  auth: string;
  /** git's own words when it failed (the lines that name the cause). */
  detail?: string;
  hint?: string;
  reason?: "GIT_AUTH" | "HOST_NETWORK" | "OTHER";
}

/**
 * Checks that this host can read `repo` with the auth a build would use (`git ls-remote <repo> HEAD`
 * with the same key or gh helper), without fetching anything (#86). Never throws: the caller warns.
 */
export async function gitAccessProbe(repo: string, settings: BuildSettings, buildsRoot: string, run: CommandRunner = spawnRunner, timeoutMs = 30_000): Promise<GitAccess> {
  if (!/^(https:\/\/|ssh:\/\/|git@)/.test(repo)) return { repo, ok: false, auth: "none", detail: "not an https:// or ssh git URL", reason: "OTHER" };
  const ctx = gitAuthContext(buildsRoot, repo, settings);
  const auth = describeGitAuth(ctx);
  let r: { code: number; output: string };
  try {
    r = await run("git", ["ls-remote", repo, "HEAD"], { env: gitEnv(settings, ctx.key, { batch: true }), timeoutMs, onLine: () => undefined });
  } catch (error) {
    return { repo, ok: false, auth, detail: `git could not run: ${(error as Error).message}`, reason: "OTHER" };
  }
  if (r.code === 0) return { repo, ok: true, auth };
  const lines = r.output.split("\n").map((l) => l.trim()).filter(Boolean);
  const named = lines.filter((l) => GIT_SIGN_IN_LINE.test(l) || /^fatal: /.test(l));
  const detail = redactSecrets((named.length > 0 ? named : lines).slice(-3).join(" ").slice(0, 400)) || `git ls-remote exited ${r.code}`;
  const offline = hostNetworkHint(r.output);
  if (offline) return { repo, ok: false, auth, detail, reason: "HOST_NETWORK", hint: "This machine cannot reach the git server right now; builds need it." };
  const hint = gitAuthHint(r.output, repo, ctx);
  return { repo, ok: false, auth, detail, ...(hint ? { hint, reason: "GIT_AUTH" as const } : { reason: "OTHER" as const }) };
}

/** Runs a command with an argument array (no shell), streaming lines and keeping the output's tail. */
export const spawnRunner: CommandRunner = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    let partial = "";
    let truncated = false;
    const take = (chunk: Buffer) => {
      const text = partial + chunk.toString("utf8");
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) options.onLine(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
      tail = (tail + chunk.toString("utf8")).slice(-64_000);
    };
    let file: ReturnType<typeof createWriteStream> | undefined;
    if (options.stdoutPath) {
      // Binary stdout to a file, counted, so a download larger than the cap stops instead of filling the disk.
      const sink = createWriteStream(options.stdoutPath, { mode: 0o600 });
      file = sink;
      sink.on("error", (error) => {
        child.kill("SIGTERM");
        tail += `\nwriting ${options.stdoutPath} failed: ${error.message}`;
      });
      let written = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        written += chunk.length;
        if (options.maxStdoutBytes !== undefined && written > options.maxStdoutBytes) {
          if (!truncated) child.kill("SIGTERM");
          truncated = true;
          return;
        }
        sink.write(chunk);
      });
    } else child.stdout.on("data", take);
    child.stderr.on("data", take);
    // Past the time limit: SIGTERM, then SIGKILL for a child that ignores it, and the reply says so.
    let timedOut = false;
    let kill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
      kill.unref();
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      file?.destroy();
      reject(new TapdanceError("PROVIDER_UNAVAILABLE", `${command} could not start: ${error.message}`, { hint: command === "xcodebuild" ? "Install Xcode on the host." : undefined }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(kill);
      if (partial) options.onLine(partial);
      const done = () => resolvePromise({ code: code ?? 1, output: tail, ...(truncated ? { truncated: true } : {}), ...(timedOut ? { timedOut: true } : {}) });
      if (file) file.end(done);
      else done();
    });
  });
