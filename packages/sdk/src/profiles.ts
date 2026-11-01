import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { TapdanceError } from "@tapdance/core";
import { PROFILE_NAME, androidSdk, avdName, profileAvdHome, readProfiles, writeProfiles, type ProfileRecord } from "@tapdance/provider-simlock";

export interface ProfileCreateOptions {
  /** android (default) or ios. */
  platform?: "android" | "ios";
  /** System image tag; google_apis_playstore by default (Play Store and Play Billing). */
  imageTag?: string;
  /** Android API level; the highest installed image with that tag by default. */
  osVersion?: string;
  /** Android: avdmanager device id, pixel_8 by default. iOS: a simulator model, "iPhone 16" by default. */
  device?: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: (message: string) => void;
}

/** Installed system images as sdkmanager packages, e.g. system-images;android-34;google_apis_playstore;arm64-v8a. */
export async function installedImages(env: NodeJS.ProcessEnv = process.env): Promise<Array<{ api: string; tag: string; abi: string; pkg: string }>> {
  const root = join(androidSdk(env), "system-images");
  const out: Array<{ api: string; tag: string; abi: string; pkg: string }> = [];
  for (const api of await readdir(root).catch(() => [] as string[])) {
    for (const tag of await readdir(join(root, api)).catch(() => [] as string[])) {
      for (const abi of await readdir(join(root, api, tag)).catch(() => [] as string[])) {
        out.push({ api: api.replace(/^android-/, ""), tag, abi, pkg: `system-images;${api};${tag};${abi}` });
      }
    }
  }
  return out;
}

function checkName(name: string): void {
  if (!PROFILE_NAME.test(name)) throw new TapdanceError("USAGE", `"${name}" is not a profile name`, { hint: "Lowercase letters, digits and dashes, e.g. play-tester." });
}

/** Creates the profile's AVD in Tapdance's own AVD home and records it. */
export async function createProfile(name: string, options: ProfileCreateOptions = {}): Promise<ProfileRecord> {
  checkName(name);
  const env = options.env ?? process.env;
  const profiles = await readProfiles(env);
  if (profiles.some((p) => p.name === name)) throw new TapdanceError("USAGE", `Profile "${name}" already exists`, { hint: "Change it with `tapdance device profile edit`." });
  if (options.platform === "ios") {
    const record = await createIosTemplate(name, options);
    await writeProfiles([...profiles, record], env);
    return record;
  }
  const tag = options.imageTag ?? "google_apis_playstore";
  const abi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
  const images = (await installedImages(env)).filter((i) => i.tag === tag && i.abi === abi && (!options.osVersion || i.api === options.osVersion));
  const image = images.sort((a, b) => Number(b.api) - Number(a.api))[0];
  if (!image) {
    throw new TapdanceError("DEVICE_UNAVAILABLE", `No installed ${tag} system image${options.osVersion ? ` for API ${options.osVersion}` : ""}`, {
      hint: `Install one: sdkmanager "system-images;android-${options.osVersion ?? "34"};${tag};${abi}" (or tapdance devices install android ${options.osVersion ?? "34"}).`,
    });
  }
  const avdmanager = join(androidSdk(env), "cmdline-tools", "latest", "bin", "avdmanager");
  if (!existsSync(avdmanager)) throw new TapdanceError("PROVIDER_UNAVAILABLE", "avdmanager is not installed", { hint: "Install the Android command-line tools (docs/platforms/android.md)." });
  options.onProgress?.(`Creating ${avdName(name)} from ${image.pkg}`);
  // avdmanager fails without a word when the AVD home does not exist yet.
  await mkdir(profileAvdHome(env), { recursive: true, mode: 0o700 });
  const childEnv = { ...env, ANDROID_AVD_HOME: profileAvdHome(env) };
  const child = spawn(avdmanager, ["create", "avd", "-n", avdName(name), "-k", image.pkg, "-d", options.device ?? "pixel_8", "--force"], { env: childEnv, stdio: ["pipe", "ignore", "pipe"] });
  child.stdin.end("no\n"); // "Do you wish to create a custom hardware profile?"
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve());
  });
  if (!existsSync(join(profileAvdHome(env), `${avdName(name)}.avd`))) {
    throw new TapdanceError("DEVICE_ERROR", `avdmanager did not create the AVD: ${stderr.trim().split("\n").slice(-2).join(" ")}`);
  }
  const now = new Date().toISOString();
  const record: ProfileRecord = { name, platform: "android", image: image.pkg, osVersion: image.api, device: options.device ?? "pixel_8", createdAt: now, updatedAt: now };
  await writeProfiles([...profiles, record], env);
  return record;
}

const xcrun = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("xcrun", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => resolve({ code: 1, stdout, stderr: "xcrun not found" }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** iOS: a template simulator named tapdance-profile-<name> in Xcode's default device set. */
async function createIosTemplate(name: string, options: ProfileCreateOptions): Promise<ProfileRecord> {
  if (process.platform !== "darwin") throw new TapdanceError("NOT_SUPPORTED", "iOS profiles need a Mac with Xcode");
  const runtimes = JSON.parse((await xcrun(["simctl", "list", "runtimes", "available", "--json"])).stdout || "{}") as { runtimes?: Array<{ identifier: string; version: string; platform?: string }> };
  const ios = (runtimes.runtimes ?? []).filter((r) => (r.platform ?? "iOS") === "iOS" && (!options.osVersion || r.version === options.osVersion || r.version.startsWith(`${options.osVersion}.`)));
  const runtime = ios.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  if (!runtime) throw new TapdanceError("DEVICE_UNAVAILABLE", `No iOS runtime${options.osVersion ? ` ${options.osVersion}` : ""} is installed`, { hint: "Install one in Xcode (Settings → Components) or with `xcodebuild -downloadPlatform iOS`." });
  const model = options.device ?? "iPhone 16";
  const created = await xcrun(["simctl", "create", `tapdance-profile-${name}`, model, runtime.identifier]);
  const udid = created.stdout.trim();
  if (created.code !== 0 || !/^[0-9A-F-]{36}$/i.test(udid)) throw new TapdanceError("DEVICE_ERROR", `simctl could not create the template: ${created.stderr.trim().slice(0, 300)}`, { hint: 'Check the model name with `xcrun simctl list devicetypes` (e.g. "iPhone 16").' });
  options.onProgress?.(`Created template simulator tapdance-profile-${name} (${model}, iOS ${runtime.version})`);
  const now = new Date().toISOString();
  return { name, platform: "ios", image: runtime.identifier, templateUdid: udid, osVersion: runtime.version, device: model, createdAt: now, updatedAt: now };
}

/**
 * Boots the profile writable, with a window, for the owner to set it up (sign in, settings, updates).
 * Resolves when the owner closes the emulator window; everything done until then is kept.
 */
export async function editProfile(
  name: string,
  options: { env?: NodeJS.ProcessEnv; onProgress?: (m: string) => void; /** iOS: resolves when the owner says they are done. */ waitUntilDone?: () => Promise<void> } = {},
): Promise<ProfileRecord> {
  const env = options.env ?? process.env;
  const profiles = await readProfiles(env);
  const record = profiles.find((p) => p.name === name);
  if (!record) throw new TapdanceError("USAGE", `No profile "${name}"`, { hint: "tapdance device profile list" });
  if (record.platform === "ios") {
    if (!record.templateUdid) throw new TapdanceError("DEVICE_UNAVAILABLE", `Profile "${name}" has no template simulator`);
    if (!options.waitUntilDone) throw new TapdanceError("USAGE", "Editing an iOS profile needs a terminal to say when you are done");
    await xcrun(["simctl", "boot", record.templateUdid]);
    await xcrun(["simctl", "bootstatus", record.templateUdid, "-b"]);
    if (env["TAPDANCE_PROFILE_HEADLESS"] !== "1") await new Promise((r) => spawn("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", record.templateUdid!], { stdio: "ignore" }).on("close", r));
    options.onProgress?.(`tapdance-profile-${name} is running in Simulator. Set it up (sign in, settings), then come back here.`);
    await options.waitUntilDone();
    await xcrun(["simctl", "shutdown", record.templateUdid]);
    const saved = { ...record, updatedAt: new Date().toISOString() };
    await writeProfiles(profiles.map((p) => (p.name === name ? saved : p)), env);
    return saved;
  }
  const emulator = join(androidSdk(env), "emulator", "emulator");
  options.onProgress?.(`Starting ${avdName(name)} with a window. Set it up (sign in, settings, Play Store updates), then close the emulator window to save.`);
  const child = spawn(emulator, ["-avd", avdName(name), "-no-snapshot", "-no-boot-anim", ...(env["TAPDANCE_PROFILE_HEADLESS"] === "1" ? ["-no-window"] : [])], { env: { ...env, ANDROID_AVD_HOME: profileAvdHome(env) }, stdio: "ignore" });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) options.onProgress?.(`The emulator exited with code ${code}; if it closed before you finished, run edit again.`);
  const updated = { ...record, updatedAt: new Date().toISOString() };
  await writeProfiles(profiles.map((p) => (p.name === name ? updated : p)), env);
  return updated;
}

export async function deleteProfile(name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  checkName(name);
  const profiles = await readProfiles(env);
  const record = profiles.find((p) => p.name === name);
  if (!record) return false;
  if (record.platform === "ios" && record.templateUdid) {
    await xcrun(["simctl", "shutdown", record.templateUdid]);
    await xcrun(["simctl", "delete", record.templateUdid]);
  }
  await rm(join(profileAvdHome(env), `${avdName(name)}.avd`), { recursive: true, force: true });
  await rm(join(profileAvdHome(env), `${avdName(name)}.ini`), { force: true });
  await writeProfiles(profiles.filter((p) => p.name !== name), env);
  return true;
}

export { readProfiles as listProfiles };

