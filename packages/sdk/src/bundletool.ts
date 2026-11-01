import { execFile } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { TapdanceError } from "@tapdance/core";
import { locate } from "./tools.js";

const run = promisify(execFile);

export interface AabOptions {
  env?: NodeJS.ProcessEnv;
  /** `tools.paths.bundletool`: the bundletool executable or its .jar. */
  bundletool?: string;
  onProgress?: (message: string) => void;
}

/**
 * Turns an Android App Bundle into one universal APK with Google's bundletool, on this machine, so
 * the upload that follows is an ordinary APK (gateways and the worker guard see nothing new).
 * bundletool signs with the Android debug keystore (~/.android/debug.keystore) when none is given.
 */
export async function aabToApk(aabPath: string, options: AabOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const info = await stat(aabPath).catch(() => undefined);
  if (!info?.isFile()) throw new TapdanceError("APP_PATH_INVALID", `${aabPath} is not a file`);
  const configured = options.bundletool ?? env["TAPDANCE_BUNDLETOOL"];
  let command: string;
  let prefix: string[] = [];
  if (configured?.endsWith(".jar")) {
    const java = env["JAVA_HOME"] ? join(env["JAVA_HOME"], "bin", "java") : locate("java", env);
    if (!java) throw new TapdanceError("PROVIDER_UNAVAILABLE", "bundletool is a .jar and no java was found", { hint: "Install a JDK 17+ or set JAVA_HOME." });
    command = java;
    prefix = ["-jar", configured];
  } else {
    const found = configured ?? locate("bundletool", env);
    if (!found) {
      throw new TapdanceError("APP_PATH_INVALID", "App bundles (.aab) need bundletool to become an installable APK", {
        hint: "Install it (`brew install bundletool`, or download the jar from github.com/google/bundletool/releases and set tools.paths.bundletool or TAPDANCE_BUNDLETOOL), or build an APK (`./gradlew assembleDebug`).",
      });
    }
    command = found;
  }
  const dir = await mkdtemp(join(tmpdir(), "tapdance-aab-"));
  const apks = join(dir, `${basename(aabPath, ".aab")}.apks`);
  options.onProgress?.(`Building a universal APK from ${basename(aabPath)} with bundletool`);
  try {
    await run(command, [...prefix, "build-apks", "--mode=universal", `--bundle=${aabPath}`, `--output=${apks}`], { env, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new TapdanceError("APP_PATH_INVALID", `bundletool could not convert ${basename(aabPath)}: ${(e.stderr ?? e.message).trim().split("\n").slice(-2).join(" ")}`);
  }
  // A universal .apks archive holds universal.apk at its root.
  try {
    await run("unzip", ["-o", "-q", apks, "universal.apk", "-d", dir], { timeout: 120_000 });
  } catch (error) {
    throw new TapdanceError("APP_PATH_INVALID", `Could not extract universal.apk: ${(error as Error).message}`, { hint: "Needs the `unzip` command." });
  }
  return join(dir, "universal.apk");
}
