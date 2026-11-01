import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { TapdanceError } from "@tapdance/core";
import { PROFILE_NAME, androidSdk, avdName, profileAvdHome, readProfiles, writeProfiles, type ProfileRecord } from "@tapdance/provider-simlock";

export interface ProfileCreateOptions {
  /** System image tag; google_apis_playstore by default (Play Store and Play Billing). */
  imageTag?: string;
  /** Android API level; the highest installed image with that tag by default. */
  osVersion?: string;
  /** avdmanager device id, pixel_8 by default. */
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

/**
 * Boots the profile writable, with a window, for the owner to set it up (sign in, settings, updates).
 * Resolves when the owner closes the emulator window; everything done until then is kept.
 */
export async function editProfile(name: string, options: { env?: NodeJS.ProcessEnv; onProgress?: (m: string) => void } = {}): Promise<ProfileRecord> {
  const env = options.env ?? process.env;
  const profiles = await readProfiles(env);
  const record = profiles.find((p) => p.name === name);
  if (!record) throw new TapdanceError("USAGE", `No profile "${name}"`, { hint: "tapdance device profile list" });
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
  if (!profiles.some((p) => p.name === name)) return false;
  await rm(join(profileAvdHome(env), `${avdName(name)}.avd`), { recursive: true, force: true });
  await rm(join(profileAvdHome(env), `${avdName(name)}.ini`), { force: true });
  await writeProfiles(profiles.filter((p) => p.name !== name), env);
  return true;
}

export { readProfiles as listProfiles };

