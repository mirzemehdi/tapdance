import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCacheDir, checkBuildRequest, FailureDigest, hostSimulatorArch, isNotableBuildLine, normalizeRepo, runBuild, type BuildSettings, type CommandRunner } from "./build.js";

const SHA = "a".repeat(40);
const settings: BuildSettings = { repos: ["https://github.com/acme/pianolune.git"], protectedRefs: [], gitAuth: "none", timeoutMinutes: 5 };

/** A fake git + xcodebuild + gradle: records commands and lays out what each would leave on disk. */
function fakeRunner(root: string, opts: { onMain?: boolean; xcodeFails?: string[] } = {}): { run: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args, o) => {
    calls.push([command.split("/").pop(), ...args.filter((a) => !a.startsWith(root))].join(" "));
    if (command === "git" && args[0] === "clone") {
      const src = args.at(-1)!;
      await mkdir(join(src, ".git"), { recursive: true });
      await mkdir(join(src, "iosApp", "iosApp.xcodeproj"), { recursive: true });
      await writeFile(join(src, "gradlew"), "#!/bin/sh\n");
    }
    if (command === "git" && args.includes("rev-parse")) return { code: args.some((a) => a.startsWith("origin/main")) ? 0 : 1, output: `${SHA}\n` };
    if (command === "git" && args.includes("merge-base")) return { code: opts.onMain === false ? 1 : 0, output: "" };
    if (command === "xcodebuild" && opts.xcodeFails) {
      for (const l of opts.xcodeFails) o.onLine(l);
      return { code: 65, output: opts.xcodeFails.slice(-3).join("\n") };
    }
    if (command === "xcodebuild") {
      const derived = args[args.indexOf("-derivedDataPath") + 1]!;
      await mkdir(join(derived, "Build", "Products", "Debug-iphonesimulator", "iosApp.app"), { recursive: true });
      o.onLine("** BUILD SUCCEEDED **");
    }
    if (command.endsWith("gradlew")) {
      const out = join(o.cwd!, "androidApp", "build", "outputs", "apk", "debug");
      await mkdir(out, { recursive: true });
      await writeFile(join(out, "androidApp-debug.apk"), "APK");
    }
    return { code: 0, output: "" };
  };
  return { run, calls };
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
    expect(r.artifact).toBe(join(buildCacheDir(root, "https://github.com/acme/pianolune"), "DerivedData", "Build", "Products", "Debug-iphonesimulator", "iosApp.app"));
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
    expect(r.artifact.endsWith(join("androidApp", "build", "outputs", "apk", "debug", "androidApp-debug.apk"))).toBe(true);
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
});
