import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCacheDir, checkBuildRequest, deployKeyFor, FailureDigest, gitAuthHint, gitEnv, hostNetworkHint, hostSimulatorArch, isNotableBuildLine, missingSdkHint, normalizeRepo, runBuild, type BuildSettings, type CommandRunner } from "./build.js";
import { addBuildFile, BUILD_FILE_MAX_BYTES, BUILD_FILES_MAX, buildFilesDigest, checkBuildFilePath, listAllBuildFiles, readBuildFiles, removeBuildFile, repoKeyPath, repoSlug } from "./build-files.js";

const SHA = "a".repeat(40);
const settings: BuildSettings = { repos: ["https://github.com/acme/pianolune.git"], protectedRefs: [], gitAuth: "none", timeoutMinutes: 5 };

/** A fake git + xcodebuild + gradle (mocked): records commands and lays out what each would leave on disk. */
function fakeRunner(
  root: string,
  opts: { onMain?: boolean; xcodeFails?: string[]; fetchFails?: boolean; cloneFails?: string; sha?: string; onClone?: (src: string) => Promise<void>; onBuild?: (cwd: string) => Promise<void> } = {},
): { run: CommandRunner; calls: string[]; envs: NodeJS.ProcessEnv[] } {
  const calls: string[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const sha = opts.sha ?? SHA;
  const run: CommandRunner = async (command, args, o) => {
    calls.push([command.split("/").pop(), ...args.filter((a) => !a.startsWith(root))].join(" "));
    envs.push(o.env);
    if (command === "git" && args[0] === "clone" && opts.cloneFails) {
      o.onLine(opts.cloneFails);
      return { code: 128, output: opts.cloneFails };
    }
    if (command === "git" && args[0] === "clone") {
      const src = args.at(-1)!;
      await mkdir(join(src, ".git"), { recursive: true });
      await mkdir(join(src, "iosApp", "iosApp.xcodeproj"), { recursive: true });
      await writeFile(join(src, "gradlew"), "#!/bin/sh\n");
      await opts.onClone?.(src);
    }
    if (command === "git" && args.includes("fetch") && opts.fetchFails) {
      o.onLine("fatal: unable to access 'https://github.com/acme/pianolune/': Could not resolve host: github.com");
      return { code: 128, output: "fatal: unable to access 'https://github.com/acme/pianolune/': Could not resolve host: github.com" };
    }
    if (command === "git" && args.includes("rev-parse")) return { code: args.some((a) => a.startsWith("origin/main") || a.startsWith(sha.slice(0, 7))) ? 0 : 1, output: `${sha}\n` };
    if (command === "git" && args.includes("merge-base")) return { code: opts.onMain === false ? 1 : 0, output: "" };
    if (command === "xcodebuild" && opts.xcodeFails) {
      for (const l of opts.xcodeFails) o.onLine(l);
      return { code: 65, output: opts.xcodeFails.slice(-3).join("\n") };
    }
    if (command === "xcodebuild") {
      await opts.onBuild?.(o.cwd!);
      const derived = args[args.indexOf("-derivedDataPath") + 1]!;
      await mkdir(join(derived, "Build", "Products", "Debug-iphonesimulator", "iosApp.app"), { recursive: true });
      o.onLine("** BUILD SUCCEEDED **");
    }
    if (command.endsWith("gradlew")) {
      await opts.onBuild?.(o.cwd!);
      const out = join(o.cwd!, "androidApp", "build", "outputs", "apk", "debug");
      await mkdir(out, { recursive: true });
      await writeFile(join(out, "androidApp-debug.apk"), "APK");
    }
    return { code: 0, output: "" };
  };
  return { run, calls, envs };
}

describe("builds on the host (#45)", () => {
  it("accepts only allow-listed repositories and safe values", () => {
    expect(normalizeRepo("git@github.com:Acme/pianolune.git")).toBe("ssh://git@github.com/Acme/pianolune");
    expect(normalizeRepo("https://GitHub.com/acme/pianolune/")).toBe("https://github.com/acme/pianolune");
    expect(checkBuildRequest({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "ios" }, settings)).toMatchObject({ ref: "main" });
    expect(() => checkBuildRequest({ repo: "https://github.com/evil/x", ref: "main", platform: "ios" }, settings)).toThrow(/allow-list/);
    for (const ref of ["--upload-pack=x", "a..b", "main;rm -rf /", ""]) {
      expect(() => checkBuildRequest({ repo: "https://github.com/acme/pianolune", ref, platform: "ios" }, settings), ref).toThrow();
    }
    expect(() => checkBuildRequest({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "ios", project: "../../x.xcodeproj" }, settings)).toThrow(/project/);
    expect(() => checkBuildRequest({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "android", gradleTask: "assemble; id" }, settings)).toThrow(/gradleTask/);
    expect(() => checkBuildRequest({ repo: "file:///etc", ref: "main", platform: "ios" }, settings)).toThrow(/https/);
  });

  it("clones, checks out the exact commit and builds the iOS app for the simulator", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-build-"));
    const { run, calls } = fakeRunner(root);
    const lines: string[] = [];
    const r = await runBuild({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "ios" }, settings, root, (l) => lines.push(l), run);
    expect(r.sha).toBe(SHA);
    // Built into DerivedData, then kept outside it (the next build overwrites DerivedData).
    expect(r.artifact.startsWith(join(buildCacheDir(root, "https://github.com/acme/pianolune"), "kept"))).toBe(true);
    expect(r.artifact.endsWith(join("iosApp.app"))).toBe(true);
    expect(calls[0]).toMatch(/^git clone --no-checkout --filter=blob:none https:\/\/github.com\/acme\/pianolune/);
    expect(calls).toContain(`git -C checkout --force --detach ${SHA}`);
    const xcode = calls.find((c) => c.startsWith("xcodebuild"))!;
    expect(xcode).toContain("-scheme iosApp");
    expect(xcode).toContain("-sdk iphonesimulator");
    expect(xcode).toContain("CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO");
    expect(xcode).not.toContain("CODE_SIGNING_ALLOWED=NO");
    expect(lines).toContain(`Building https://github.com/acme/pianolune at ${SHA} (main)`);
    // A second build fetches instead of cloning again.
    const second = fakeRunner(root);
    await runBuild({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "ios" }, settings, root, () => undefined, second.run);
    expect(second.calls.some((c) => c.startsWith("git -C fetch"))).toBe(true);
    expect(second.calls.some((c) => c.startsWith("git clone"))).toBe(false);
  });

  it("builds Android with Gradle and finds the new APK", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-build-"));
    const { run, calls } = fakeRunner(root);
    const r = await runBuild({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "android" }, settings, root, () => undefined, run);
    expect(r.artifact.includes(join("kept"))).toBe(true);
    expect(r.artifact.endsWith("androidApp-debug.apk")).toBe(true);
    expect(calls.some((c) => c.startsWith("gradlew assembleDebug --console=plain"))).toBe(true);
  });

  it("refuses a commit that is not on a protected branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-build-"));
    const { run, calls } = fakeRunner(root, { onMain: false });
    await expect(runBuild({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "ios" }, { ...settings, protectedRefs: ["main"] }, root, () => undefined, run)).rejects.toThrow(/not on a protected branch/);
    expect(calls.some((c) => c.startsWith("xcodebuild"))).toBe(false);
  });

  it("builds only this Mac's simulator arch, and lets the caller's allowed settings win (#53)", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-build-"));
    const { run, calls } = fakeRunner(root);
    await runBuild({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "ios" }, settings, root, () => undefined, run);
    const xcode = calls.find((c) => c.startsWith("xcodebuild"))!;
    expect(xcode).toContain(`ARCHS=${hostSimulatorArch()} ONLY_ACTIVE_ARCH=YES`);
    expect(hostSimulatorArch("x64")).toBe("x86_64");
    expect(hostSimulatorArch("arm64")).toBe("arm64");

    const req = checkBuildRequest({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "ios", xcodeSettings: ["ARCHS=x86_64", "EXCLUDED_ARCHS="] }, settings);
    const second = fakeRunner(root);
    await runBuild(req, settings, root, () => undefined, second.run);
    const args = second.calls.find((c) => c.startsWith("xcodebuild"))!;
    expect(args).toContain("ARCHS=x86_64");
    expect(args).not.toContain("ARCHS=arm64");
    expect(args).toContain("CODE_SIGNING_REQUIRED=NO ONLY_ACTIVE_ARCH=YES ARCHS=x86_64 EXCLUDED_ARCHS= build");
    for (const bad of ["SWIFT_EXEC=/bin/sh", "CC=clang", "OTHER_SWIFT_FLAGS=-x", "ARCHS=$(id)", "ARCHS=a/b", "archs=arm64"]) {
      expect(() => checkBuildRequest({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "ios", xcodeSettings: [bad] }, settings), bad).toThrow();
    }
  });

  it("names the cause of a failed build in the error, however far above the end it was (#53)", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-build-"));
    const noise = Array.from({ length: 2000 }, (_, i) => `builtin-copy line ${i}`);
    const log = [
      ...noise,
      "> Task :shared:embedAndSignAppleFrameworkForXcode FAILED",
      "* What went wrong:",
      "Xcode requested target architectures that are not configured in your Gradle build: ios_x64.",
      "The framework 'shared' cannot be built for these target architectures.",
      "",
      "* Try:",
      "> Run with --stacktrace option to get the stack trace.",
      ...noise,
      "The following build commands failed:",
      "\tPhaseScriptExecution Compile\\ Kotlin\\ Framework /x/Script.sh (in target 'iosApp' from project 'iosApp')",
      "(1 failure)",
      "** BUILD FAILED **",
    ];
    const { run } = fakeRunner(root, { xcodeFails: log });
    const error = (await runBuild({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "ios" }, settings, root, () => undefined, run).catch((e: unknown) => e)) as Error & { details?: Record<string, unknown> };
    expect(error.message).toMatch(/^xcodebuild failed \(exit 65\):\n/);
    expect(error.message).toContain("Xcode requested target architectures that are not configured in your Gradle build: ios_x64.");
    expect(error.message).toContain("> Task :shared:embedAndSignAppleFrameworkForXcode FAILED");
    expect(error.message).toContain("PhaseScriptExecution Compile");
    expect(error.message).not.toContain("builtin-copy");
    expect(error.message).not.toContain("--stacktrace");
    expect(error.details?.["digest"]).toBeInstanceOf(Array);
  });

  it("keeps the digest bounded and the quiet log to steps, errors and the outcome", () => {
    const d = new FailureDigest();
    for (let i = 0; i < 100; i++) d.add(`/x/a.swift:${i}:1: error: bad ${i}`);
    expect(d.lines()).toHaveLength(12);
    expect(isNotableBuildLine("$ xcodebuild -project x")).toBe(true);
    expect(isNotableBuildLine("** BUILD FAILED **")).toBe(true);
    expect(isNotableBuildLine("e: file:///x/Main.kt:3:1 Unresolved reference")).toBe(true);
    expect(isNotableBuildLine("    builtin-copy -exclude .DS_Store")).toBe(false);
    expect(isNotableBuildLine("export PATH=/usr/bin")).toBe(false);
  });

  it("names the SDK package a Gradle build is missing on the host", () => {
    expect(missingSdkHint("> [CXX1300] CMake '3.31.6' was not found in SDK, PATH, or by cmake.dir property.")).toContain('sdkmanager "cmake;3.31.6"');
    expect(missingSdkHint("No version of NDK matched the requested version 27.0.12077973")).toContain('sdkmanager "ndk;27.0.12077973"');
    expect(missingSdkHint("Failed to find target with hash string 'android-35'")).toContain('sdkmanager "platforms;android-35"');
    expect(missingSdkHint("e: Unresolved reference")).toBeUndefined();
  });

  it("names a host network failure, builds a known commit from the cache, and reuses a build (#61)", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-build-"));
    // First build: clone and build; the result is kept.
    const first = fakeRunner(root);
    const built = await runBuild({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "ios" }, settings, root, () => undefined, first.run);
    expect(built.reused).toBeUndefined();
    expect(built.artifact).toContain(join("kept"));
    // Same commit and settings: reused, no xcodebuild.
    const again = fakeRunner(root);
    const lines: string[] = [];
    const reused = await runBuild({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "ios" }, settings, root, (l) => lines.push(l), again.run);
    expect(reused).toMatchObject({ sha: SHA, reused: true, artifact: built.artifact });
    expect(again.calls.some((c) => c.startsWith("xcodebuild"))).toBe(false);
    expect(lines.some((l) => l.startsWith("Reusing the build of"))).toBe(true);
    // The host is offline: a branch cannot be trusted from the cache, and the error says whose network.
    const offline = fakeRunner(root, { fetchFails: true });
    const error = (await runBuild({ repo: "https://github.com/acme/pianolune", ref: "main", platform: "ios" }, settings, root, () => undefined, offline.run).catch((e: unknown) => e)) as Error & { hint?: string; details?: Record<string, unknown> };
    expect(error.message).toContain("fatal: unable to access");
    expect(error.message).toContain("Could not resolve host: github.com");
    expect(error.hint).toMatch(/host's network, not yours/);
    expect(error.details?.["reason"]).toBe("HOST_NETWORK");
    // …but a commit id it already has still builds (here: reused) with a warning.
    const warned: string[] = [];
    const bySha = await runBuild({ repo: "https://github.com/acme/pianolune", ref: SHA, platform: "ios" }, settings, root, (l) => warned.push(l), fakeRunner(root, { fetchFails: true }).run);
    expect(bySha.sha).toBe(SHA);
    expect(warned.some((l) => l.startsWith("warning: git fetch failed"))).toBe(true);
    expect(hostNetworkHint("BUILD FAILED: Could not GET 'https://dl.google.com/x.pom'")).toBeDefined();
    expect(hostNetworkHint("e: Unresolved reference")).toBeUndefined();
  });
});

describe("private repositories: per-repository deploy keys and host build files", () => {
  const REPO = "https://github.com/acme/pianolune";
  const SSH = "git" + "@github.com:Acme/pianolune.git";

  it("derives one safe, collision-resistant slug per repository", () => {
    const slug = repoSlug(REPO);
    expect(slug).toMatch(/^github\.com-acme-pianolune-[0-9a-f]{10}$/);
    // The https and ssh URLs, case, .git and a trailing slash name the same repository.
    for (const same of [SSH, "https://GitHub.com/acme/pianolune.git", "ssh://git@github.com/acme/pianolune/", "https://user@github.com/acme/pianolune"]) expect(repoSlug(same), same).toBe(slug);
    // Repositories whose readable parts sanitize to the same text still get different slugs.
    expect(repoSlug("https://github.com/acme/a+b")).not.toBe(repoSlug("https://github.com/acme/a-b"));
    expect(repoSlug("https://github.com/acme/pianolune2")).not.toBe(slug);
    expect(repoSlug("https://gitlab.com/acme/pianolune")).not.toBe(slug);
    for (const odd of ["https://github.com/../../etc/passwd", "https://github.com/a/.hidden", "https://h.example/$(id)/`x`"]) {
      expect(repoSlug(odd), odd).toMatch(/^[a-z0-9][a-z0-9._-]*-[0-9a-f]{10}$/);
      expect(repoSlug(odd)).not.toContain("..");
    }
    expect(repoSlug(`https://github.com/acme/${"x".repeat(500)}`).length).toBeLessThanOrEqual(91);
    expect(() => repoSlug("file:///etc")).toThrow(/https/);
  });

  it("uses a repository's own deploy key, else the legacy single key with deploy-key auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-build-"));
    const legacy = join(root, "deploy_key");
    await writeFile(legacy, "KEY");
    const deployKey: BuildSettings = { ...settings, gitAuth: "deploy-key", deployKeyPath: legacy };
    expect(deployKeyFor(root, SSH, deployKey)).toBe(legacy);
    expect(deployKeyFor(root, SSH, { ...settings, gitAuth: "none" })).toBeUndefined();
    await mkdir(join(root, "keys"), { recursive: true });
    await writeFile(repoKeyPath(root, SSH), "OWN");
    // The repository's own key wins, whatever the URL form and whatever gitAuth says.
    expect(deployKeyFor(root, REPO, deployKey)).toBe(repoKeyPath(root, SSH));
    expect(deployKeyFor(root, SSH, { ...settings, gitAuth: "gh" })).toBe(repoKeyPath(root, SSH));
    expect(deployKeyFor(root, "https://github.com/acme/other", deployKey)).toBe(legacy);
    expect(gitEnv(settings, repoKeyPath(root, SSH))["GIT_SSH_COMMAND"]).toBe(`ssh -i '${repoKeyPath(root, SSH)}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`);
    expect(gitEnv(settings)["GIT_SSH_COMMAND"]).toBeUndefined();
    const gh = gitEnv({ ...settings, gitAuth: "gh" }, repoKeyPath(root, SSH));
    expect(gh["GIT_CONFIG_VALUE_1"]).toBe("!gh auth git-credential");
    expect(gh["GIT_SSH_COMMAND"]).toContain("IdentitiesOnly=yes");

    // runBuild (fake git, mocked) hands git the repository's own key.
    const { run, envs } = fakeRunner(root);
    await runBuild({ repo: SSH, ref: "main", platform: "ios" }, deployKey, root, () => undefined, run);
    expect(envs[0]!["GIT_SSH_COMMAND"]).toContain(repoKeyPath(root, SSH));
    expect(envs[0]!["GIT_SSH_COMMAND"]).not.toContain(`'${legacy}'`);
  });

  it("names the three ways out when the clone cannot sign in (fake git, mocked)", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-build-"));
    const { run } = fakeRunner(root, { cloneFails: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository." });
    const error = (await runBuild({ repo: SSH, ref: "main", platform: "ios" }, settings, root, () => undefined, run).catch((e: unknown) => e)) as Error & { hint?: string; details?: Record<string, unknown> };
    expect(error.message).toMatch(/^git clone failed/);
    expect(error.hint).toContain("gh auth login --with-token");
    expect(error.hint).toContain("fine-grained, read-only token");
    expect(error.hint).toContain("tapdance host builds key --repo <url>");
    expect(error.hint).toContain("tapdance app install <path>");
    expect(error.details?.["reason"]).toBe("GIT_AUTH");
    for (const text of ["remote: Repository not found.", "fatal: could not read Username for 'https://github.com': terminal prompts disabled", "The requested URL returned error: 403"]) expect(gitAuthHint(text, REPO), text).toBeDefined();
    expect(gitAuthHint("error: pathspec 'x' did not match", REPO)).toBeUndefined();
    // A network failure stays a network failure.
    const offline = fakeRunner(root, { cloneFails: "ssh: Could not resolve hostname github.com: nodename nor servname provided\nfatal: Could not read from remote repository." });
    const net = (await runBuild({ repo: SSH, ref: "main", platform: "ios" }, settings, root, () => undefined, offline.run).catch((e: unknown) => e)) as Error & { details?: Record<string, unknown> };
    expect(net.details?.["reason"]).toBe("HOST_NETWORK");
  });

  it("refuses build file paths outside the repository or in git's own files", () => {
    expect(checkBuildFilePath("androidApp/google-services.json")).toBe("androidApp/google-services.json");
    expect(checkBuildFilePath(".env")).toBe(".env");
    expect(checkBuildFilePath("local.properties")).toBe("local.properties");
    for (const bad of ["/etc/passwd", "~/x", "C:/x", "\\\\x", "../x", "a/../../x", "a/..", ".git", ".git/config", ".GIT/hooks/pre-commit", ".gitmodules", "sub/.git/config", "a//b", "./a", "a/b\\c", "a/$(id)", ""]) {
      expect(() => checkBuildFilePath(bad), bad).toThrow();
    }
  });

  it("caps a build file at 1 MB and a repository at 50 files; stores them owner-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-build-"));
    await expect(addBuildFile(root, REPO, "big.bin", Buffer.alloc(BUILD_FILE_MAX_BYTES + 1))).rejects.toThrow(/at most/);
    await addBuildFile(root, REPO, "max.bin", Buffer.alloc(BUILD_FILE_MAX_BYTES));
    for (let i = 1; i < BUILD_FILES_MAX; i++) await addBuildFile(root, REPO, `f${i}.txt`, Buffer.from(`v${i}`));
    await expect(addBuildFile(root, REPO, "one-more.txt", Buffer.from("x"))).rejects.toThrow(/50 build files/);
    // Replacing a file that is already there is not one more.
    await addBuildFile(root, REPO, "f1.txt", Buffer.from("changed"));
    expect((await readBuildFiles(root, SSH)).length).toBe(BUILD_FILES_MAX);
    const dir = join(root, "files", repoSlug(REPO));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "index.json"))).mode & 0o777).toBe(0o600);
    const blobs = await readdir(join(dir, "blobs"));
    expect(blobs.length).toBe(BUILD_FILES_MAX); // the replaced content's blob is gone
    for (const b of blobs) expect((await stat(join(dir, "blobs", b))).mode & 0o777).toBe(0o600);
    const listed = await listAllBuildFiles(root);
    expect(listed).toHaveLength(1);
    await removeBuildFile(root, REPO, "f1.txt");
    await expect(removeBuildFile(root, REPO, "f1.txt")).rejects.toThrow(/no build file/);
  });

  it("copies build files into the checkout for the build, logs only path and hash, and takes them out after (fake git and Xcode, mocked)", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-build-"));
    await addBuildFile(root, REPO, "iosApp/GoogleService-Info.plist", Buffer.from("SECRET-PLIST"));
    await addBuildFile(root, REPO, "config/.env", Buffer.from("API_KEY=SECRET-ENV"));
    const seen: Record<string, string> = {};
    const { run } = fakeRunner(root, {
      onBuild: async (src) => {
        seen["plist"] = await readFile(join(src, "iosApp", "GoogleService-Info.plist"), "utf8");
        seen["env"] = await readFile(join(src, "config", ".env"), "utf8");
      },
    });
    const lines: string[] = [];
    await runBuild({ repo: REPO, ref: "main", platform: "ios" }, settings, root, (l) => lines.push(l), run);
    expect(seen).toEqual({ plist: "SECRET-PLIST", env: "API_KEY=SECRET-ENV" });
    const sha = (await readBuildFiles(root, REPO)).find((f) => f.path === "config/.env")!.sha256;
    expect(lines).toContain(`using host build file config/.env (sha256 ${sha.slice(0, 8)})`);
    expect(lines.some((l) => l.includes("SECRET"))).toBe(false);
    expect(isNotableBuildLine(`using host build file config/.env (sha256 ${sha.slice(0, 8)})`)).toBe(true);
    const src = join(buildCacheDir(root, REPO), "src");
    expect(existsSync(join(src, "iosApp", "GoogleService-Info.plist"))).toBe(false);
    expect(existsSync(join(src, "config", ".env"))).toBe(false);
  });

  it("builds again when a build file changes, and a removed file does not linger for the next commit (fake git and Xcode, mocked)", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-build-"));
    const req = { repo: REPO, ref: "main", platform: "ios" as const };
    const first = await runBuild(req, settings, root, () => undefined, fakeRunner(root).run);
    // Same commit, settings and (no) files: reused.
    expect((await runBuild(req, settings, root, () => undefined, fakeRunner(root).run)).reused).toBe(true);
    // A build file appears: the reuse key changes, so it builds again.
    await addBuildFile(root, REPO, "local.properties", Buffer.from("sdk.dir=/a"));
    const withFile = fakeRunner(root);
    const second = await runBuild(req, settings, root, () => undefined, withFile.run);
    expect(second.reused).toBeUndefined();
    expect(second.artifact).not.toBe(first.artifact);
    expect(withFile.calls.some((c) => c.startsWith("xcodebuild"))).toBe(true);
    expect((await runBuild(req, settings, root, () => undefined, fakeRunner(root).run)).reused).toBe(true);
    // The file's content changes: builds again.
    const before = buildFilesDigest(await readBuildFiles(root, REPO));
    await addBuildFile(root, REPO, "local.properties", Buffer.from("sdk.dir=/b"));
    expect(buildFilesDigest(await readBuildFiles(root, REPO))).not.toBe(before);
    expect(buildFilesDigest([])).toBe("");
    const changed = fakeRunner(root);
    expect((await runBuild(req, settings, root, () => undefined, changed.run)).reused).toBeUndefined();
    // The owner removes it; the next commit builds without it, even though a build that died left a copy.
    await removeBuildFile(root, REPO, "local.properties");
    const cache = buildCacheDir(root, REPO);
    const src = join(cache, "src");
    await writeFile(join(src, "local.properties"), "sdk.dir=/b");
    await writeFile(join(cache, "placed-files.json"), JSON.stringify(["local.properties"]));
    let present = true;
    const next = fakeRunner(root, { sha: "c".repeat(40), onBuild: async (cwd) => void (present = existsSync(join(cwd, "local.properties"))) });
    await runBuild(req, settings, root, () => undefined, next.run);
    expect(present).toBe(false);
    // Removed before git checks out the next commit.
    expect(next.calls.findIndex((c) => c.startsWith("git -C checkout"))).toBeGreaterThan(-1);
    expect(existsSync(join(cache, "placed-files.json"))).toBe(false);
  });

  it("refuses a build file whose folder is a symlink out of the checkout, writing nothing there (fake git, mocked)", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-build-"));
    const outside = await mkdtemp(join(tmpdir(), "td-outside-"));
    await addBuildFile(root, REPO, "app/google-services.json", Buffer.from("{}"));
    const { run, calls } = fakeRunner(root, { onClone: (src) => symlink(outside, join(src, "app")) });
    const error = (await runBuild({ repo: REPO, ref: "main", platform: "ios" }, settings, root, () => undefined, run).catch((e: unknown) => e)) as Error & { code?: string };
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain("app/google-services.json");
    expect(error.message).toMatch(/symlink that leads outside the checkout/);
    expect(await readdir(outside)).toEqual([]);
    expect(calls.some((c) => c.startsWith("xcodebuild"))).toBe(false);

    // A symlink at the file's own path is refused too (writing would follow it).
    const root2 = await mkdtemp(join(tmpdir(), "td-build-"));
    await addBuildFile(root2, REPO, ".env", Buffer.from("A=1"));
    const victim = join(outside, "victim.txt");
    await writeFile(victim, "untouched");
    const second = fakeRunner(root2, { onClone: (src) => symlink(victim, join(src, ".env")) });
    await expect(runBuild({ repo: REPO, ref: "main", platform: "ios" }, settings, root2, () => undefined, second.run)).rejects.toThrow(/\.env in the repository is a symlink/);
    expect(await readFile(victim, "utf8")).toBe("untouched");

    // A symlink to a folder inside the checkout is fine.
    const root3 = await mkdtemp(join(tmpdir(), "td-build-"));
    await addBuildFile(root3, REPO, "link/google-services.json", Buffer.from("{}"));
    let copied = "";
    const third = fakeRunner(root3, {
      onClone: async (src) => {
        await mkdir(join(src, "real"));
        await symlink(join(src, "real"), join(src, "link"));
      },
      onBuild: async (src) => void (copied = await readFile(join(src, "real", "google-services.json"), "utf8")),
    });
    await runBuild({ repo: REPO, ref: "main", platform: "ios" }, settings, root3, () => undefined, third.run);
    expect(copied).toBe("{}");
  });
});
