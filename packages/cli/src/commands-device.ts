import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { DEVICE_SETTINGS, LocalArtifactStore, MAX_LOG_LINES, createProfile, deleteProfile, editProfile, findAndroidSdk, listProfiles, TapdanceError, parseTarget, runKeepalive, withInstallHintFor, type DeviceKey, type DeviceSettingName, type Platform } from "@tapdance/sdk";
import { renderDevice, run, spawnKeepalive, type GlobalOptions } from "./context.js";
import { bold, dim, green, red, table, yellow } from "./output.js";

function platformArg(value: string | undefined): Platform {
  if (value === "android" || value === "ios") return value;
  throw new TapdanceError("USAGE", `--platform must be android or ios${value ? `, not "${value}"` : ""}`);
}

/**
 * Settings people (and checklists) ask for that a simulator or emulator cannot do, or that have another
 * name here (#62): why not, and what to use instead.
 */
const SETTING_ALTERNATIVES: Record<string, { why: string; instead: string }> = {
  time: {
    why: "The device clock cannot be set per lease on the iOS simulator: it uses the Mac's clock",
    instead: "Test date rules with a debug date in the app. Android emulator (google_apis image, which has root): `tapdance device shell -- settings put global auto_time 0`, then `tapdance device shell -- su 0 date MMDDhhmmYY`.",
  },
  voiceover: {
    why: "The iOS simulator has no VoiceOver",
    instead: "Check what VoiceOver would meet with `tapdance ui audit` (unlabelled controls, small targets, duplicate labels) and the labels in `tapdance ui inspect`.",
  },
  talkback: {
    why: "TalkBack is not a Tapdance setting; it is on Play images (Google's accessibility suite), not on google_apis",
    instead: "On a Play image: `tapdance device shell -- settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService` and `-- settings put secure accessibility_enabled 1`. On any image, `tapdance ui audit` checks what TalkBack would meet.",
  },
  locale: {
    why: "The device language is the `language` setting (iOS); on Android an app's own locale is set when it starts",
    instead: "iOS: `tapdance device setting language de-DE`. Android 13+: `tapdance app launch <appId> --locale de-DE`.",
  },
};
SETTING_ALTERNATIVES["clock"] = SETTING_ALTERNATIVES["time"]!;
SETTING_ALTERNATIVES["date"] = SETTING_ALTERNATIVES["time"]!;

function intArg(name: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new TapdanceError("USAGE", `${name} must be an integer from ${min} to ${max}`);
  return n;
}

/** `logs --contains/--level`, checked like MCP get_logs checks them (1-200 characters; error|fault). */
export function logFilterArgs(o: { contains?: string; level?: string }): { contains?: string; level?: "error" | "fault" } {
  if (o.contains !== undefined && (o.contains.length < 1 || o.contains.length > 200)) throw new TapdanceError("USAGE", "--contains takes 1 to 200 characters");
  if (o.level !== undefined && o.level !== "error" && o.level !== "fault") {
    throw new TapdanceError("USAGE", `--level must be error or fault, not "${o.level}"`, { hint: "error keeps errors and exceptions; fault keeps faults and crashes." });
  }
  return { ...(o.contains !== undefined ? { contains: o.contains } : {}), ...(o.level !== undefined ? { level: o.level } : {}) };
}

function numArg(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new TapdanceError("USAGE", `${name} must be a non-negative number`);
  return n;
}

function point(name: string, value: string): { x: number; y: number } {
  const m = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(value);
  if (!m) throw new TapdanceError("USAGE", `${name} must look like 120,640`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Android system image tags Tapdance knows, lightest last: Play Store, Google APIs, test images. */
export const ANDROID_IMAGE_TAGS = ["google_apis_playstore", "google_apis", "google_atd", "aosp_atd"] as const;

export function registerDeviceCommands(program: Command, globals: () => GlobalOptions): void {
  // ------------------------------------------------------------- discovery
  const devices = program.command("devices").description("List device models you can lease and what is running");
  const listDevices = (cmd: Command) =>
    cmd.option("-p, --platform <platform>", "android or ios").action(async (o: { platform?: string }) =>
      run(globals(), async (t, out) => {
        const inv = await t.devices(o.platform ? platformArg(o.platform) : undefined);
        out.result(inv, () => {
          const lines: string[] = [];
          for (const c of inv.capacity) lines.push(`${bold(c.platform)}: ${c.running}/${c.limit} running, ${c.leased} leased${c.warm ? `, ${c.warm} warm spare${c.warm > 1 ? "s" : ""} (booted, not in use; kept for a fast next lease)` : ""}`);
          for (const c of inv.catalog) {
            lines.push("", `${bold(c.platform === "ios" ? "iOS" : "Android")} models: ${c.models.slice(0, 25).join(", ")}${c.models.length > 25 ? dim(` … +${c.models.length - 25}`) : ""}`);
            if (c.osVersions.length) lines.push(`  OS versions: ${c.osVersions.join(", ")}${c.defaultOsVersion ? ` (default ${c.defaultOsVersion})` : ""}`);
            if (c.imageTags?.length) lines.push(`  image tags: ${c.imageTags.join(", ")}`);
          }
          if (inv.devices.length) {
            lines.push("", table([["DEVICE", "PLATFORM", "MODEL", "OS", "STATE"], ...inv.devices.map((d) => [d.id, d.platform, d.model, d.osVersion ?? "", d.leased ? "leased" : d.state])]));
          }
          if (inv.queueDepth) lines.push("", `${inv.queueDepth} request(s) waiting`);
          lines.push("", ...inv.notes.map((n) => dim(n)));
          return lines.join("\n");
        });
      }),
    );
  listDevices(devices);
  devices
    .command("install <platform> <version>")
    .description("Install an iOS runtime or Android system image on this worker (several GB; Simlock never downloads on its own)")
    .option("--image-tag <tag>", `Android: another image than google_apis (${ANDROID_IMAGE_TAGS.filter((t) => t !== "google_apis").join(", ")}); installed with the SDK's sdkmanager`)
    .action(async (platform: string, version: string, o: { imageTag?: string }) => {
      const { spawnSync } = await import("node:child_process");
      const { simlockBin } = await import("./context.js");
      const p = platformArg(platform);
      if (!/^[A-Za-z0-9._;-]+$/.test(version)) throw new TapdanceError("USAGE", "version looks wrong");
      if (o.imageTag && o.imageTag !== "google_apis") {
        // Simlock's installer fetches google_apis only; other tags come straight from sdkmanager.
        if (p !== "android") throw new TapdanceError("USAGE", "--image-tag is for Android system images");
        if (!(ANDROID_IMAGE_TAGS as readonly string[]).includes(o.imageTag)) throw new TapdanceError("USAGE", `Unknown image tag "${o.imageTag}"`, { hint: `Use one of: ${ANDROID_IMAGE_TAGS.join(", ")}.` });
        if (!/^\d{2}(\.\d)?$/.test(version)) throw new TapdanceError("USAGE", "Give the Android API level, e.g. 34");
        const sdk = findAndroidSdk();
        const sdkmanager = sdk ? join(sdk, "cmdline-tools", "latest", "bin", "sdkmanager") : undefined;
        if (!sdkmanager || !existsSync(sdkmanager)) throw new TapdanceError("PROVIDER_UNAVAILABLE", "sdkmanager was not found", { hint: "Install the Android command-line tools (scripts/host-setup.sh --prerequisites-only does it)." });
        const abi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
        const r = spawnSync(sdkmanager, ["--install", `system-images;android-${version};${o.imageTag};${abi}`], { stdio: "inherit" });
        process.exitCode = r.status ?? 1;
        return;
      }
      const r = spawnSync(process.execPath, [simlockBin(), "--local", "component", "install", platform, version], { stdio: "inherit" });
      process.exitCode = r.status ?? 1;
    });
  listDevices(devices.command("list").description("Same as `tapdance devices`"));

  program
    .command("workers")
    .description("Machines that run devices (this machine, laptops, cloud VMs) and whether they are online")
    .command("list", { isDefault: true })
    .description("List workers")
    .action(async () =>
      run(globals(), async (t, out) => {
        const workers = await t.workers();
        out.result({ workers }, () =>
          table([
            ["WORKER", "STATE", "ANDROID", "IOS", "LEASES", "HOST", "AGENT-DEVICE", "STREAM"],
            ...workers.map((w) => [
              w.label ? `${w.label} ${dim(w.id.slice(0, 8))}` : w.id,
              w.connection === "connected" || w.connection === "self" ? green(w.connection) : w.connection,
              `${w.platforms.find((p) => p.platform === "android")?.running ?? 0}/${w.platforms.find((p) => p.platform === "android")?.limit ?? 0}`,
              `${w.platforms.find((p) => p.platform === "ios")?.running ?? 0}/${w.platforms.find((p) => p.platform === "ios")?.limit ?? 0}`,
              String(w.leases),
              w.host ?? "",
              w.capabilities["agent-device"] ?? "?",
              w.capabilities["stream"] ?? "?",
            ]),
          ]),
        );
      }, { fleet: true }),
    );

  // ------------------------------------------------------------- lease lifecycle
  const device = program.command("device").description("Lease, inspect and release this session's device");

  device
    .command("lease")
    .description("Lease one emulator or simulator for this session")
    .requiredOption("-p, --platform <platform>", "android or ios")
    .option("-d, --device <model>", 'model, e.g. "Pixel 8" or "iPhone 16"')
    .option("--os <version>", "OS version or range (Android: API level)")
    .option("--image-tag <tag>", "Android system image tag; leave it out for normal testing (google_apis, lighter). google_apis_playstore only when the test needs the Play Store (billing, Play sign-in)")
    .option("--physical", "lease an enrolled physical device instead")
    .option("--profile <name>", "boot a device profile from this machine (read-only: the lease's changes are discarded)")
    .option("--ttl <minutes>", "lease time to live in minutes")
    .option("--wait <seconds>", "how long to wait in the queue")
    .option("--settle <seconds>", "Android emulator: how long to check the guest's CPU after boot before handing it out, 0-300 (0 skips the check)")
    .option("--no-keepalive", "do not renew in the background (the lease expires after its TTL)")
    .option("--hold", "stay in the foreground, renew, and release on Ctrl-C")
    .action(async (o: { platform: string; device?: string; os?: string; imageTag?: string; physical?: boolean; profile?: string; ttl?: string; wait?: string; settle?: string; keepalive: boolean; hold?: boolean }) =>
      run(globals(), async (t, out) => {
        const ttl = intArg("--ttl", o.ttl, 1, 240);
        const wait = intArg("--wait", o.wait, 0, 3600);
        const settle = intArg("--settle", o.settle, 0, 300);
        const { summary, ttlCappedMinutes, notices } = await t.lease({
          platform: platformArg(o.platform),
          ...(o.device ? { device: o.device } : {}),
          ...(o.os ? { osVersion: o.os } : {}),
          ...(o.imageTag ? { imageTag: o.imageTag } : {}),
          ...(o.physical ? { physical: true } : {}),
          ...(o.profile ? { profile: o.profile } : {}),
          ...(ttl !== undefined ? { ttlMinutes: ttl } : {}),
          ...(wait !== undefined ? { waitSeconds: wait } : {}),
          ...(settle !== undefined ? { settleSeconds: settle } : {}),
        });
        const cfg = t.resolved.config.session;
        let keepalive: string;
        if (o.hold) {
          keepalive = "foreground (Ctrl-C releases)";
        } else if (o.keepalive && cfg.keepalive) {
          const pid = spawnKeepalive(t, globals());
          if (pid) await t.store.update(t.sessionId, (r) => ({ ...r, keepalivePid: pid }));
          keepalive = `background, up to ${cfg.maxSessionMinutes} min${cfg.idleReleaseMinutes ? `, released after ${cfg.idleReleaseMinutes} min unused` : ""} (pid ${pid ?? "?"})`;
        } else {
          keepalive = "off — renew with `tapdance device renew`";
        }
        if (ttlCappedMinutes) out.warn(`The worker granted ${ttlCappedMinutes} min, less than the ${ttl ?? t.resolved.config.session.defaultTtlMinutes} min asked (its policy caps leases; the keepalive renews it).`);
        for (const notice of notices ?? []) out.warn(notice);
        out.result({ device: summary, keepalive, ...(ttlCappedMinutes ? { ttlCappedMinutes } : {}), ...(notices ? { notices } : {}) }, () => `${renderDevice(summary, [["Keepalive", keepalive]])}\n\n${dim("Next: tapdance app install <path> · tapdance ui inspect · tapdance device release")}`);
        if (o.hold) {
          const controller = new AbortController();
          const stop = () => controller.abort();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          out.progress("Holding the lease; press Ctrl-C to release");
          await runKeepalive(t, { maxMs: cfg.maxSessionMinutes * 60_000, signal: controller.signal, log: (m) => out.progress(m) });
          const released = await t.release();
          out.progress(released.released ? "Released" : released.unreachable ? "Could not reach the worker; the lease ends there when it expires" : "Lease already ended");
        }
      }),
    );

  device
    .command("request-human")
    .description("Ask a person to do something on the device (sign in, approve a purchase, solve a check); waits until they hand back, or returns at once with --no-wait")
    .option("--reason <text>", "what the person should do; shown in the viewer")
    .option("--wait <seconds>", "how long to wait (10-1800)", "600")
    .option("--no-wait", "open the request and return; `device status` shows whether it was handed back")
    .option("--cancel", "withdraw the open request (a waiting request-human exits 13)")
    .action(async (opts: { reason?: string; wait: string | boolean; cancel?: boolean }) =>
      run(globals(), async (t, out) => {
        if (opts.cancel) {
          const pending = await t.pendingHumanRequest();
          const cancelled = await t.cancelHumanRequest("tapdance device request-human --cancel");
          out.result({ cancelled, ...(pending ? { request: pending } : {}) }, () => (cancelled ? `Cancelled: ${pending?.reason ?? ""}` : "No request was open"));
          return;
        }
        if (!opts.reason || opts.reason.trim().length < 3) throw new TapdanceError("USAGE", "--reason needs a few words (what the person should do)");
        if (opts.wait === false) {
          const request = await t.openHumanRequest(opts.reason);
          out.result({ request }, () => `Asked: ${request.reason}. \`tapdance device status\` shows when it is handed back; \`device request-human --cancel\` withdraws it.`);
          return;
        }
        const seconds = Number(opts.wait);
        if (!Number.isInteger(seconds) || seconds < 10 || seconds > 1800) throw new TapdanceError("USAGE", "--wait takes whole seconds from 10 to 1800");
        // Ctrl-C ends the wait cleanly, so the viewer stops showing the request.
        const stop = new AbortController();
        const onInt = () => stop.abort();
        process.once("SIGINT", onInt);
        process.once("SIGTERM", onInt);
        // A short counter once a minute; the reason was printed once at the start.
        const r = await t.requestHuman(opts.reason, seconds * 1000, stop.signal, { noteEveryMs: 60_000 }).finally(() => {
          process.off("SIGINT", onInt);
          process.off("SIGTERM", onInt);
        });
        if (stop.signal.aborted) throw new TapdanceError("CANCELLED", "Stopped waiting (interrupted); the request was withdrawn");
        if (r.cancelled) throw new TapdanceError("CANCELLED", `The request was cancelled (${r.how ?? "cancel"}) after ${Math.round(r.waitedMs / 1000)} s`);
        if (!r.completed) throw new TapdanceError("TIMEOUT", `Nobody handed back within ${seconds} s`, { ...(r.hint ? { hint: r.hint } : {}), details: { waitedMs: r.waitedMs } });
        out.result(r, () => `Handed back after ${Math.round(r.waitedMs / 1000)} s (${r.how ?? "done"})`);
      }),
    );

  device
    .command("clipboard <action> [text]")
    .description("Read (get) or write (set <text>) the device clipboard: paste flows, checking what a Copy button copied")
    .action(async (action: string, text: string | undefined) =>
      run(globals(), async (t, out) => {
        if (action !== "get" && action !== "set") throw new TapdanceError("USAGE", "clipboard takes get or set <text>");
        if (action === "set" && text === undefined) throw new TapdanceError("USAGE", "clipboard set needs the text");
        const r = await t.device(action === "get" ? { kind: "clipboard", action: "get" } : { kind: "clipboard", action: "set", text: text! });
        out.result(r, () => (action === "get" ? String((r.data as { text?: string } | undefined)?.text ?? "") : r.message));
      }),
    );

  device
    .command("storekit [action] [file]")
    .description("Not available: StoreKit configuration files need Xcode's scheme; says what to use instead")
    .action(() => {
      throw new TapdanceError("NOT_SUPPORTED", "StoreKit configuration files (.storekit) cannot be loaded into a simulator outside Xcode: Xcode attaches them when it launches the app from a scheme", {
        hint: "Test purchases in the sandbox: the agent asks a person to sign in a Sandbox account with `tapdance device request-human --reason \"Sign in a Sandbox Apple ID: Settings › App Store › Sandbox Account\"`, then buys through the sheet (docs/guides/purchase-testing.md). Android: a license tester on a Play image.",
      });
    });

  device
    .command("links")
    .description("Links apps asked the system to open lately (mailto:, App Store, Settings, web): scheme, URL and whether anything opened it; checks a link-out on a simulator without Mail")
    .option("--minutes <n>", "how far back to look (1-30)", "5")
    .action(async (o: { minutes: string }) =>
      run(globals(), async (t, out) => {
        const r = await t.device({ kind: "links", minutes: intArg("--minutes", o.minutes, 1, 30)! });
        out.result(r, () => r.message);
      }),
    );

  device
    .command("crashes")
    .description("iOS: list the leased simulator's crash reports (.ips) since the lease began, or pull one with a summary of the crashed thread")
    .option("--app <appId>", "only this app's reports")
    .option("--pull <name>", "save this report (a name from the list, or latest)")
    .option("-o, --output <path>", "where to save the pulled report")
    .action(async (o: { app?: string; pull?: string; output?: string }) =>
      run(globals(), async (t, out) => {
        const r = await t.device(
          o.pull ? { kind: "crash-pull", name: o.pull, outPath: o.output ?? "", ...(o.app ? { appId: o.app } : {}) } : { kind: "crash-list", ...(o.app ? { appId: o.app } : {}) },
        );
        out.result(r, () => r.message);
      }),
    );

  device
    .command("done")
    .description("Tell the agent you finished what it asked for (request_human), e.g. after signing in")
    .action(async () =>
      run(globals(), async (t, out) => {
        const pending = await t.pendingHumanRequest();
        const answered = await t.completeHumanRequest("tapdance device done");
        out.result({ answered, ...(pending ? { request: pending } : {}) }, () => (answered ? `Done: ${pending?.reason ?? ""}` : "The agent is not waiting for anything"));
      }),
    );

  /** iOS profile edits end when the owner presses Enter (a simulator has no window close to wait for). */
  const pressEnter = async () => {
    if (!process.stdin.isTTY) throw new TapdanceError("USAGE", "Editing an iOS profile needs a terminal");
    process.stderr.write("Press Enter when you are done setting it up… ");
    await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
    process.stdin.pause();
  };
  const profile = device.command("profile").description("Device profiles: an emulator you set up once (signed in, configured) that leases boot from");
  profile
    .command("create <name>")
    .description("Create a profile (Android emulator or iOS simulator), then open it to set up (sign in, settings) and save")
    .option("-p, --platform <platform>", "android or ios", "android")
    .option("--image-tag <tag>", "Android system image tag", "google_apis_playstore")
    .option("--os <version>", "Android API level or iOS version (default: the newest installed)")
    .option("--device <model>", "avdmanager device id (Android, default pixel_8) or simulator model (iOS, default \"iPhone 16\")")
    .option("--no-edit", "only create it; set it up later with `device profile edit`")
    .action(async (name: string, o: { platform: string; imageTag: string; os?: string; device?: string; edit: boolean }) =>
      run(globals(), async (_t, out) => {
        const platform = platformArg(o.platform);
        const record = await createProfile(name, { platform, imageTag: o.imageTag, ...(o.device ? { device: o.device } : {}), ...(o.os ? { osVersion: o.os } : {}), onProgress: (m) => out.progress(m) });
        const final = o.edit ? await editProfile(name, { onProgress: (m) => out.progress(m), waitUntilDone: pressEnter }) : record;
        out.result({ profile: final }, () => `Profile ${name} ready (${final.image}). Lease it: tapdance device lease -p ${platform} --profile ${name}`);
      }),
    );
  profile
    .command("edit <name>")
    .description("Open the profile writable with a window; what you do is kept when you close it")
    .action(async (name: string) =>
      run(globals(), async (_t, out) => {
        const record = await editProfile(name, { onProgress: (m) => out.progress(m), waitUntilDone: pressEnter });
        out.result({ profile: record }, () => `Saved ${name}`);
      }),
    );
  profile
    .command("list")
    .description("List device profiles on this machine")
    .action(async () =>
      run(globals(), async (_t, out) => {
        const profiles = await listProfiles();
        out.result({ profiles }, () => (profiles.length ? table([["Name", "Image", "Updated"], ...profiles.map((p) => [p.name, p.image, p.updatedAt])]) : "No profiles. Create one: tapdance device profile create <name>"));
      }),
    );
  profile
    .command("delete <name>")
    .description("Delete a profile and its emulator data")
    .action(async (name: string) =>
      run(globals(), async (_t, out) => {
        const deleted = await deleteProfile(name);
        out.result({ deleted }, () => (deleted ? `Deleted ${name}` : `No profile ${name}`));
      }),
    );

  device
    .command("status")
    .description("Show this session's device and lease")
    .action(async () =>
      run(globals(), async (t, out) => {
        const d = await t.status();
        const human = await t.humanRequestState();
        const asked = human
          ? human.cancelled
            ? `cancelled at ${human.doneAt}: ${human.reason}`
            : human.doneAt
              ? `handed back at ${human.doneAt} (${human.doneBy ?? "done"}): ${human.reason}`
              : `waiting for a person since ${human.requestedAt}: ${human.reason}`
          : undefined;
        out.result({ device: d, ...(human ? { humanRequest: human } : {}) }, () => renderDevice(d, asked ? [["person", asked]] : []));
      }),
    );

  device
    .command("renew")
    .description("Extend this session's lease now")
    .option("--ttl <minutes>", "new time to live in minutes")
    .action(async (o: { ttl?: string }) =>
      run(globals(), async (t, out) => {
        const d = await t.renew(intArg("--ttl", o.ttl, 1, 240));
        out.result({ device: d }, () => `Renewed; expires ${d.expiresAt}`);
      }),
    );

  device
    .command("release")
    .description("Release this session's device (it is wiped)")
    .action(async () =>
      run(globals(), async (t, out) => {
        const r = await t.release();
        if (r.unreachable && r.device) {
          // Forgotten here only: the worker still holds the device until the lease runs out.
          out.result(r, () =>
            yellow(
              `Could not reach the worker, so ${r.device!.model} (${r.device!.leaseId}) is not released yet. Run \`tapdance device release\` again once the worker answers; otherwise the worker frees it when the lease expires (${r.device!.expiresAt}).`,
            ),
          );
          process.exitCode = 4;
          return;
        }
        out.result(r, () =>
          r.device ? (r.released ? `Released ${r.device.model} (${r.device.leaseId})` : `${r.device.model} (${r.device.leaseId}) had already ended on the worker`) : "This session held no device",
        );
      }),
    );

  device
    .command("setting <name> [value]")
    .description(
      `Change (or, without a value, read) a device setting: ${DEVICE_SETTINGS.join(", ")}. Values: on|off for the switches; appearance light|dark|toggle; orientation portrait|landscape|landscape-left|landscape-right|portrait-upside-down; browser-first-run off. The iOS simulator's clock is the Mac's and cannot be set`,
    )
    .option("--app <appId>", "the app a permission or locale applies to")
    .option("--permission <permission>", "for `setting permission <grant|deny|reset>`: camera, microphone, photos, notifications, location…")
    .option("--lat <latitude>", "for `setting location`: move the device here", Number)
    .option("--lon <longitude>", "for `setting location`", Number)
    .action(async (name: string, value: string | undefined, o: { app?: string; permission?: string; lat?: number; lon?: number }) =>
      run(globals(), async (t, out) => {
        const instead = SETTING_ALTERNATIVES[name.toLowerCase()];
        if (instead) throw new TapdanceError("NOT_SUPPORTED", instead.why, { hint: instead.instead });
        if (!(DEVICE_SETTINGS as readonly string[]).includes(name)) throw new TapdanceError("USAGE", `Unknown setting "${name}"`, { hint: `One of: ${DEVICE_SETTINGS.join(", ")}` });
        const r = await t.device({
          kind: "setting",
          change: {
            name: name as DeviceSettingName,
            ...(value !== undefined ? { value } : {}),
            ...(o.app ? { appId: o.app } : {}),
            ...(o.permission ? { permission: o.permission } : {}),
            ...(o.lat !== undefined ? { latitude: o.lat } : {}),
            ...(o.lon !== undefined ? { longitude: o.lon } : {}),
          },
        });
        out.result(r, () => r.message);
      }),
    );
  device
    .command("push <path>")
    .description("Copy a file onto the device (Android shared storage or a debuggable app's sandbox; iOS Photos, the Files app, or an app's Documents)")
    .requiredOption("--to <destination>", "downloads, pictures, documents, app_sandbox, or files (iOS: Files › On My iPhone, seen by document pickers)")
    .option("--app <appId>", "app for app_sandbox (and iOS documents)")
    .option("--name <name>", "file name on the device")
    .action(async (path: string, o: { to: string; app?: string; name?: string }) =>
      run(globals(), async (t, out) => {
        if (!["downloads", "pictures", "documents", "app_sandbox", "files"].includes(o.to)) throw new TapdanceError("USAGE", "--to must be downloads, pictures, documents, app_sandbox or files");
        const r = await t.device({ kind: "push-file", localPath: path, destination: o.to as "downloads", ...(o.app ? { appId: o.app } : {}), ...(o.name ? { name: o.name } : {}) });
        out.result(r, () => r.message);
      }),
    );
  device
    .command("pull [devicePath]")
    .description("Copy a file from the device into this session's artifacts")
    .option("--app <appId>", "read from this app's sandbox/container")
    .option("--path <relativePath>", "with --app: path inside it, e.g. files/export.json or Documents/export.json")
    .option("--files <name>", "iOS: a file in Files › On My iPhone")
    .option("-o, --out <file>", "write here instead of the artifacts directory")
    .action(async (devicePath: string | undefined, o: { app?: string; path?: string; files?: string; out?: string }) =>
      run(globals(), async (t, out) => {
        const r = await t.device({ kind: "pull-file", outPath: o.out ?? "", ...(devicePath ? { devicePath } : {}), ...(o.app ? { appId: o.app } : {}), ...(o.path ? { relativePath: o.path } : {}), ...(o.files ? { filesName: o.files } : {}) });
        out.result(r, () => r.path ?? r.message);
      }),
    );
  device
    .command("notifications <action>")
    .description("list | open | close | post | tap notifications on the device (tap --text opens one the way a person does)")
    .option("--app <appId>", "filter (list) or the app a push payload goes to (post)")
    .option("--title <title>", "post: title")
    .option("--text <text>", "post: body; tap: text of the notification to open")
    .option("--payload <json>", "post: a push payload (APNs-style JSON) delivered to --app")
    .action(async (action: string, o: { app?: string; title?: string; text?: string; payload?: string }) =>
      run(globals(), async (t, out) => {
        const app = o.app ? { appId: o.app } : {};
        let r;
        if (action === "post") {
          let payload: Record<string, unknown> | undefined;
          if (o.payload) {
            try {
              payload = JSON.parse(o.payload) as Record<string, unknown>;
            } catch {
              throw new TapdanceError("USAGE", "--payload must be JSON");
            }
          }
          r = await t.device({ kind: "post-notification", ...app, ...(o.title ? { title: o.title } : {}), ...(o.text ? { text: o.text } : {}), ...(payload ? { payload } : {}) });
        } else if (action === "list" || action === "open" || action === "close") r = await t.device({ kind: "notifications", action, ...app });
        else if (action === "tap") r = await t.device({ kind: "notifications", action: "tap", text: o.text ?? "" });
        else throw new TapdanceError("USAGE", "action must be list, open, close, post or tap");
        const list = (r.data?.["notifications"] as Array<{ package: string; title?: string; text?: string }> | undefined) ?? undefined;
        out.result(r, () => (list ? (list.map((n) => `${n.package}: ${n.title ?? ""}${n.text ? ` — ${n.text}` : ""}`).join("\n") || "No notifications") : r.message));
      }),
    );
  device
    .command("shell <command...>")
    .description("Android emulators: run a command with `adb shell` inside the leased emulator (not on this machine)")
    .option("--stdin <file>", "pass this text file on stdin (binary: base64 it and decode on the device with `base64 -d`)")
    .option("--timeout <seconds>", "default 120", Number)
    .action(async (command: string[], o: { stdin?: string; timeout?: number }) =>
      run(globals(), async (t, out) => {
        const stdin = o.stdin ? await readFile(o.stdin, "utf8") : undefined;
        const r = await t.device({ kind: "shell", command: command.join(" "), ...(stdin !== undefined ? { stdin } : {}), ...(o.timeout ? { timeoutMs: o.timeout * 1000 } : {}) });
        const d = r.data as { exitCode: number; stdout: string; stderr: string };
        out.result(r, () => [d.stdout.trimEnd(), d.stderr.trim() ? `stderr: ${d.stderr.trim()}` : ""].filter(Boolean).join("\n"));
        if (d.exitCode !== 0) process.exitCode = 1;
      }),
    );
  device
    .command("perf <metric>")
    .description("Measure frames (frame health since the last reading) or memory")
    .option("--app <appId>", "app to measure (default: the foreground app)")
    .action(async (metric: string, o: { app?: string }) =>
      run(globals(), async (t, out) => {
        if (metric !== "frames" && metric !== "memory") throw new TapdanceError("USAGE", "metric must be frames or memory");
        const r = await t.device({ kind: "perf", metric, ...(o.app ? { appId: o.app } : {}) });
        out.result(r, () => JSON.stringify(r.data, null, 2));
      }),
    );
  // Hidden: the detached renewer `device lease` starts.
  program
    .command("__keepalive", { hidden: true })
    .action(async () =>
      run({ ...globals(), quiet: true }, async (t) => {
        await runKeepalive(t, { maxMs: t.resolved.config.session.maxSessionMinutes * 60_000, idleMs: t.resolved.config.session.idleReleaseMinutes * 60_000 });
      }),
    );

  // ------------------------------------------------------------- apps
  const app = program.command("app").description("Install, launch and stop apps on the leased device");
  app
    .command("install [path]")
    .description(
      "Upload and install an app: Android .apk or .aab (an .aab becomes a universal APK with bundletool on this machine); iOS simulator .app bundle, or a .zip or .tar holding one (.ipa on a physical iPhone only). With --from-ci instead of a path: the device's host downloads an Android APK from a GitHub Actions artifact with its own credentials and installs it",
    )
    .option("--app-id <id>", "package / bundle id, when the backend needs it")
    .option("--from-ci <repo>", "Android: install from the user's CI instead of a path: a GitHub repository (owner/repo or URL) on the host's allow-list (`tapdance host artifacts enable`)")
    .option("--artifact <name>", "with --from-ci: the artifact's name (actions/upload-artifact name)")
    .option("--run <id>", "with --from-ci: the workflow run id (default: the newest successful run on --branch)")
    .option("--branch <name>", "with --from-ci: take the newest successful run on this branch (default: the repository's default branch)")
    .option("--launch <appId>", "launch this app once it is installed")
    .action(async (path: string | undefined, o: { appId?: string; fromCi?: string; artifact?: string; run?: string; branch?: string; launch?: string }) =>
      run(globals(), async (t, out) => {
        const ci = checkInstallArgs(path, o);
        try {
          if (ci) {
            const r = await t.installFromCi(ci);
            if (o.launch) await t.launchApp(o.launch, { relaunch: true });
            out.result({ installed: r, ...(o.launch ? { launched: o.launch } : {}) }, () =>
              [
                `Installed ${r.appId ? `${r.appId}${r.versionCode !== undefined ? ` (versionCode ${r.versionCode})` : ""}, ` : ""}${r.artifact} from ${r.repo} run ${r.runId} (${r.branch} at ${r.sha.slice(0, 12)}, apk sha256 ${r.apkSha256}${r.cached ? ", the host's earlier download" : ""})${o.launch ? `; launched ${o.launch}` : ""}`,
                ...launchMismatch(r.appId, o.launch),
              ].join("\n"),
            );
            return;
          }
          const r = await t.installApp(path!, o.appId);
          if (o.launch) await t.launchApp(o.launch, { relaunch: true });
          out.result({ installed: r, ...(o.launch ? { launched: o.launch } : {}) }, () => `Installed ${r.appId ?? path}${o.launch ? `; launched ${o.launch}` : ""}`);
        } catch (error) {
          // Install refusals name the package and only CLI syntax here (#89).
          throw withInstallHintFor(error, "cli");
        }
      }),
    );
  app
    .command("launch <appId>")
    .description("Launch an installed app")
    .option("--relaunch", "kill and restart it")
    .option("--url <url>", "deep link to open")
    .option("--arg <arg>", "launch argument passed to the app (repeatable; implies --relaunch)", (v: string, prev: string[] = []) => [...prev, v])
    .option("--intent-action <action>", "Android: start an explicit intent with this action")
    .option("--intent-data <uri>", "Android: intent data URI")
    .option("--intent-component <component>", "Android: component, e.g. com.example/.MainActivity")
    .option("--intent-extra <key=value>", "Android: string extra (repeatable)", (v: string, prev: string[] = []) => [...prev, v])
    .option("--locale <locale>", "run the app in this language, e.g. de-DE (iOS: launch arguments; Android 13+: the app's own locale)")
    .option("--console", "iOS: relaunch with the app's stdout/stderr (print, println) captured; `logs --app` then includes them")
    .action(async (appId: string, o: { relaunch?: boolean; url?: string; arg?: string[]; intentAction?: string; intentData?: string; intentComponent?: string; intentExtra?: string[]; locale?: string; console?: boolean }) =>
      run(globals(), async (t, out) => {
        if (o.intentAction || o.intentData || o.intentComponent) {
          const extras = Object.fromEntries((o.intentExtra ?? []).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
          const r = await t.device({
            kind: "intent",
            intent: { ...(o.intentAction ? { action: o.intentAction } : {}), ...(o.intentData ? { data: o.intentData } : {}), ...(o.intentComponent ? { component: o.intentComponent } : {}), ...(Object.keys(extras).length ? { extras } : {}) },
          });
          out.result(r, () => r.message);
          return;
        }
        const r = await t.launchApp(appId, { ...(o.relaunch ? { relaunch: true } : {}), ...(o.url ? { url: o.url } : {}), ...(o.arg?.length ? { args: o.arg } : {}), ...(o.locale ? { locale: o.locale } : {}), ...(o.console ? { console: true } : {}) });
        out.result(r, () => r.message);
      }),
    );
  app
    .command("uninstall <appId>")
    .description("Remove an installed app")
    .action(async (appId: string) => run(globals(), async (t, out) => {
      const r = await t.device({ kind: "uninstall", appId });
      out.result(r, () => r.message);
    }));
  app
    .command("clear <appId>")
    .description("Clear an app's data (first-launch state); iOS also: device setting reset-keychain")
    .action(async (appId: string) => run(globals(), async (t, out) => {
      const r = await t.device({ kind: "clear-app-data", appId });
      out.result(r, () => r.message);
    }));
  app
    .command("build")
    .description("Build the app on the machine that runs the leased device, from a git repository its owner allow-listed, and install it there (an agent without Xcode can test iOS)")
    .requiredOption("--git <url>", "repository URL (must be on the host's build allow-list)")
    .requiredOption("--ref <ref>", "branch, tag or commit sha; the reply names the exact commit built")
    .option("--project <path>", "iOS: .xcodeproj or .xcworkspace inside the repository (found when there is only one)")
    .option("--scheme <name>", "iOS: Xcode scheme (default: the project's name)")
    .option("--configuration <name>", "iOS: build configuration", "Debug")
    .option("--gradle-task <task>", "Android: Gradle task", "assembleDebug")
    .option("--dir <path>", "Android: folder with gradlew inside the repository")
    .option("--xcode-setting <KEY=VALUE>", "iOS: extra build setting, repeatable (ARCHS, EXCLUDED_ARCHS, ONLY_ACTIVE_ARCH, SWIFT_ACTIVE_COMPILATION_CONDITIONS, KOTLIN_FRAMEWORK_BUILD_TYPE and a few more)", (v: string, all: string[]) => [...all, v], [] as string[])
    .option("--launch <appId>", "launch this app once it is installed")
    .option("--verbose", "show every build log line (default: steps, errors and the outcome)")
    .action(async (o: { git: string; ref: string; project?: string; scheme?: string; configuration: string; xcodeSetting: string[]; gradleTask: string; dir?: string; launch?: string; verbose?: boolean }) =>
      run(globals(), async (t, out) => {
        const r = await t.buildApp(
          {
            repo: o.git,
            ref: o.ref,
            ...(o.project ? { project: o.project } : {}),
            ...(o.scheme ? { scheme: o.scheme } : {}),
            configuration: o.configuration,
            ...(o.xcodeSetting.length > 0 ? { xcodeSettings: o.xcodeSetting } : {}),
            gradleTask: o.gradleTask,
            ...(o.dir ? { dir: o.dir } : {}),
          },
          { verbose: o.verbose === true },
        ).catch((error: unknown) => {
          throw withInstallHintFor(error, "cli");
        });
        if (o.launch) await t.launchApp(o.launch, { relaunch: true });
        out.result({ ...r, ...(o.launch ? { launched: o.launch } : {}) }, () =>
          [
            `${r.reused ? `Reused the earlier build (made ${r.builtAt ?? "before"})` : "Built"} ${r.artifact} from ${r.sha.slice(0, 12)} (${r.ref}) in ${r.seconds} s and installed it${r.appId ? ` as ${r.appId}` : ""}${o.launch ? `; launched ${o.launch}` : ""}`,
            ...launchMismatch(r.appId, o.launch),
          ].join("\n"),
        );
      }),
    );
  app
    .command("kill <appId>")
    .description("End an app the way a user does (Home, then gone; alarms and jobs kept, unlike stop) and check its process is gone")
    .action(async (appId: string) => run(globals(), async (t, out) => {
      const r = await t.device({ kind: "kill-app", appId });
      out.result(r, () => (r.ok ? r.message : yellow(r.message)));
      if (!r.ok) process.exitCode = 7;
    }));
  app
    .command("stop <appId>")
    .description("Force-stop an app (also cancels its alarms and jobs on Android; `app kill` ends it like a user)")
    .action(async (appId: string) => run(globals(), async (t, out) => out.result(await t.stopApp(appId), () => `Stopped ${appId}`)));
  app
    .command("list")
    .description("List apps the automation backend sees")
    .action(async () => run(globals(), async (t, out) => { const apps = await t.listApps(); out.result({ apps }, () => apps.join("\n") || "none"); }));

  // ------------------------------------------------------------- UI
  const ui = program.command("ui").description("Inspect and drive the leased device's UI");
  ui.command("audit")
    .description("Accessibility audit of the screen: unlabelled controls, small touch targets, controls announced alike, unlabelled images (what VoiceOver or TalkBack would trip over)")
    .option("--app <appId>", "audit this app instead of the session's (switches to it as it is)")
    .action(async (o: { app?: string }) =>
      run(globals(), async (t, out) => {
        const r = await t.audit(o.app ? { appId: o.app } : {});
        out.result(r, () =>
          [
            `${r.app ?? "screen"}: ${r.checked} controls checked, ${r.findings.length} finding(s)${r.partlyHidden.length ? dim(`; not judged, partly off screen or under a bar: ${r.partlyHidden.join(", ")} (scroll them into view to audit them)`) : ""}`,
            ...r.findings.map((f) => `${f.severity === "error" ? red("error") : f.severity === "warning" ? yellow("warn ") : dim("info ")} ${f.rule} ${bold(f.ref)} [${f.role}]${f.label ? ` "${f.label}"` : ""}${f.identifier ? dim(` #${f.identifier}`) : ""}: ${f.detail}`),
          ].join("\n"),
        );
        if (r.findings.some((f) => f.severity === "error")) process.exitCode = 1;
      }),
    );

  ui.command("inspect")
    .description("List on-screen elements with refs, roles and labels")
    .option("--all", "include non-interactive elements")
    .option("--compact", "leave out unlabelled containers (useful with --all on Compose or SwiftUI screens)")
    .option("--bounds", "show each element's position and size in pixels (x,y w×h); --json always includes them as rect")
    .option("--system", "Android: every window as the system sees it (uiautomator), e.g. a Chrome Custom Tab and its URL, or a system picker; refs are not tappable")
    .option("--app <appId>", "switch to this app as it is (no relaunch) and read it, e.g. com.apple.mobilesafari after a link-out; later reads stay on it until you launch yours")
    .action(async (o: { all?: boolean; compact?: boolean; bounds?: boolean; system?: boolean; app?: string }) =>
      run(globals(), async (t, out) => {
        const s = await t.inspect({ interactiveOnly: !o.all, ...(o.compact ? { compact: true } : {}), ...(o.system ? { system: true } : {}), ...(o.app ? { appId: o.app } : {}) });
        out.result(s, () =>
          [
            dim(`${s.app ?? "unknown app"}${s.viewport ? ` · ${s.viewport.width}×${s.viewport.height}` : ""} · ${s.elements.length} elements${s.truncated ? " (truncated)" : ""}`),
            ...s.elements.map((e) => `${"  ".repeat(Math.min(e.depth ?? 0, 6))}${bold(e.ref)} [${e.role}]${e.label ? ` "${e.label}"` : ""}${e.value ? ` = "${e.value}"` : ""}${e.identifier ? dim(` #${e.identifier}`) : ""}${(e.states ?? []).map((st) => ` [${st}]`).join("")}${e.enabled === false ? dim(" (disabled)") : ""}${o.bounds && e.rect ? dim(` (${e.rect.x},${e.rect.y} ${e.rect.width}×${e.rect.height})`) : ""}`),
            ...s.warnings.map((w) => dim(`note: ${w}`)),
          ].join("\n"),
        );
      }),
    );

  const targetOptions = (cmd: Command) =>
    cmd
      .option("--text <text>", "visible text or accessibility label")
      .option("--id <id>", "accessibility identifier / resource id")
      .option("--ref <ref>", "ref from `ui inspect`, e.g. @e7")
      .option("--selector <selector>", "agent-device selector")
      .option("--x <x>", "x coordinate (fallback)")
      .option("--y <y>", "y coordinate (fallback)");

  targetOptions(ui.command("tap").description("Tap one element"))
    .option("--no-settle", "do not wait for the UI to settle")
    .option("--settle-ms <ms>", "also wait up to this long for the UI to come to rest and report whether the screen changed (a tap that auto-advances)", Number)
    .option("--inject", "Android: tap with a raw input event (`input tap`) at the element's centre, for system screens that ignore normal taps")
    .action(async (o: { text?: string; id?: string; ref?: string; selector?: string; x?: string; y?: string; settle: boolean; settleMs?: number; inject?: boolean }) =>
      run(globals(), async (t, out) => {
        const target = parseTarget({
          ...(o.text !== undefined ? { text: o.text } : {}),
          ...(o.id !== undefined ? { id: o.id } : {}),
          ...(o.ref !== undefined ? { ref: o.ref } : {}),
          ...(o.selector !== undefined ? { selector: o.selector } : {}),
          ...(o.x !== undefined ? { x: numArg("--x", o.x)! } : {}),
          ...(o.y !== undefined ? { y: numArg("--y", o.y)! } : {}),
        });
        const r = await t.tap(target, { settle: o.settle, ...(o.settleMs ? { settleMs: o.settleMs } : {}), ...(o.inject ? { inject: true } : {}) });
        out.result(r, () =>
          [
            r.message,
            ...(r.warning ? [yellow(r.warning)] : []),
            ...(r.changes ?? []).map((c) => dim(`  ${c}`)),
            ...(o.settleMs ? [r.screenChanged ? `screen changed: ${(r.screen ?? []).join(" · ") || "(no labels)"}` : "same screen"] : []),
          ].join("\n"),
        );
      }),
    );

  ui.command("swipe")
    .description("Swipe by finger direction (up scrolls content down) or between two points")
    .option("--direction <dir>", "up, down, left or right")
    .option("--amount <fraction>", "0.1–0.8 of the screen")
    .option("--until <text>", "with --direction: keep scrolling until this text is visible")
    .option("--from <x,y>", "start point")
    .option("--to <x,y>", "end point")
    .action(async (o: { direction?: string; amount?: string; until?: string; from?: string; to?: string }) =>
      run(globals(), async (t, out) => {
        let r;
        if (o.direction) {
          if (!["up", "down", "left", "right"].includes(o.direction)) throw new TapdanceError("USAGE", "--direction must be up, down, left or right");
          const amount = numArg("--amount", o.amount);
          r = await t.swipe({ kind: "direction", direction: o.direction as "up", ...(amount !== undefined ? { amount } : {}), ...(o.until ? { untilText: o.until } : {}) });
        } else if (o.from && o.to) {
          r = await t.swipe({ kind: "points", from: point("--from", o.from), to: point("--to", o.to) });
        } else {
          throw new TapdanceError("USAGE", "Give --direction, or --from and --to");
        }
        out.result(r, () => r.message);
      }),
    );

  targetOptions(ui.command("type <text>").description("Type text; with a target, replace that field's content"))
    .option("--delay-ms <ms>", "pause between keystrokes, for fields that drop fast input (a fill that drops characters is retried once at 80 ms on its own)")
    .action(async (text: string, o: { text?: string; id?: string; ref?: string; selector?: string; x?: string; y?: string; delayMs?: string }) =>
      run(globals(), async (t, out) => {
        const named = { ...(o.text !== undefined ? { text: o.text } : {}), ...(o.id !== undefined ? { id: o.id } : {}), ...(o.ref !== undefined ? { ref: o.ref } : {}), ...(o.selector !== undefined ? { selector: o.selector } : {}), ...(o.x !== undefined ? { x: numArg("--x", o.x)! } : {}), ...(o.y !== undefined ? { y: numArg("--y", o.y)! } : {}) };
        const r = await t.typeText(text, Object.keys(named).length ? parseTarget(named) : undefined, o.delayMs !== undefined ? { delayMs: numArg("--delay-ms", o.delayMs)! } : {});
        out.result(r, () => r.message);
      }),
    );

  ui.command("wait")
    .description("Wait for text to appear (--text), disappear (--absent), or the UI to settle (--stable)")
    .option("--text <text>")
    .option("--absent <text>")
    .option("--stable")
    .option("--timeout <ms>", "milliseconds, at most 600000 (10 minutes)", "10000")
    .action(async (o: { text?: string; absent?: string; stable?: boolean; timeout: string }) =>
      run(globals(), async (t, out) => {
        const given = [o.text, o.absent, o.stable].filter((v) => v !== undefined && v !== false).length;
        if (given !== 1) throw new TapdanceError("USAGE", "Give exactly one of --text, --absent, --stable");
        const condition = o.text ? { kind: "text" as const, text: o.text } : o.absent ? { kind: "absent" as const, text: o.absent } : { kind: "stable" as const };
        const r = await t.waitFor(condition, intArg("--timeout", o.timeout, 100, 600_000));
        out.result(r, () => (r.found ? `Found after ${r.waitedMs} ms` : `Not found within ${r.waitedMs} ms`));
        if (!r.found) process.exitCode = 1;
      }),
    );

  ui.command("alert <action>")
    .description("Read (get) or answer (accept, dismiss) a system alert")
    .action(async (action: string) =>
      run(globals(), async (t, out) => {
        if (!["get", "accept", "dismiss"].includes(action)) throw new TapdanceError("USAGE", "action must be get, accept or dismiss");
        const r = await t.alert(action as "get");
        out.result(r, () => (r.present ? [r.title, r.message, r.buttons ? `buttons: ${r.buttons.join(", ")}` : undefined, r.acted ? `pressed: ${r.acted}` : undefined].filter(Boolean).join("\n") : "No alert"));
      }),
    );

  ui.command("sequence <file>")
    .description("Run timed taps (rhythm and timing games): a JSON list of {t, x, y, hold?} with t in ms from the start; Android inside the emulator, iOS through the simulator's touch input on the host")
    .option("--start-on-text <text>", "wait for this text first, then start")
    .option("--offset-ms <ms>", "start this long after the text appeared (or after now)", "0")
    .option("--wait <seconds>", "how long to wait for --start-on-text", "60")
    .option("--orientation <o>", "iOS: which way the device is turned when the app forces landscape (landscape-left, the default for a landscape screen, or landscape-right)")
    .action(async (file: string, o: { startOnText?: string; offsetMs: string; wait: string; orientation?: string }) =>
      run(globals(), async (t, out) => {
        let steps: unknown;
        try {
          steps = JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
          throw new TapdanceError("USAGE", `${file} is not a JSON list of taps: ${(error as Error).message}`);
        }
        if (!Array.isArray(steps)) throw new TapdanceError("USAGE", `${file} must hold a JSON list such as [{"t":0,"x":120,"y":900},{"t":480,"x":240,"y":900,"hold":200}]`);
        const r = await t.tapSequence(steps as never, {
          ...(o.startOnText ? { startOnText: o.startOnText } : {}),
          offsetMs: intArg("--offset-ms", o.offsetMs, 0, 60_000)!,
          waitMs: intArg("--wait", o.wait, 1, 600)! * 1000,
          ...(o.orientation ? { orientation: o.orientation as never } : {}),
        });
        out.result(r, () => r.message);
        if (!r.ok) process.exitCode = 7;
      }),
    );

  ui.command("key <key>")
    .description("Press back, home, enter, dismiss_keyboard or app_switcher")
    .action(async (key: string) =>
      run(globals(), async (t, out) => {
        const keys: DeviceKey[] = ["back", "home", "enter", "dismiss_keyboard", "app_switcher"];
        if (!keys.includes(key as DeviceKey)) throw new TapdanceError("USAGE", `key must be one of ${keys.join(", ")}`);
        const r = await t.pressKey(key as DeviceKey);
        out.result(r, () => r.message);
      }),
    );

  // ------------------------------------------------------------- evidence
  program
    .command("screenshot")
    .description("Save a PNG of the screen (artifacts dir by default)")
    .option("-o, --output <path>", "where to write the PNG")
    .option("--note <text>", "what it shows")
    .action(async (o: { output?: string; note?: string }) =>
      run(globals(), async (t, out) => {
        const ref = await t.screenshot(o.output, o.note);
        out.result({ artifact: ref }, () => ref.path);
      }),
    );

  const record = program.command("record").description("Record the screen to MP4");
  record
    .command("start")
    .option("-o, --output <path>", "where to write the MP4")
    .action(async (o: { output?: string }) => run(globals(), async (t, out) => { const r = await t.startRecording(o.output); out.result(r, () => `Recording to ${r.path}`); }));
  record
    .command("stop")
    .option("-o, --output <path>", "ignored: the path is chosen at start")
    .action(async () =>
      run(globals(), async (t, out) => {
        const r = await t.stopRecording();
        out.result({ artifact: r }, () => [r.path, ...r.extra.map((e) => e.path)].join("\n"));
      }),
    );

  program
    .command("logs")
    .description("Recent device logs (logcat / simulator log), saved as an artifact")
    .option("-n, --lines <n>", `how many lines (at most ${MAX_LOG_LINES}); with a filter, how many matching lines`, "200")
    .option("--app <id>", "only this app")
    .option("--crash", "crash buffer / faults only")
    .option("--contains <text>", "only lines containing this text (case-insensitive); on Android searches the whole logcat buffer")
    .option("--level <level>", "only error lines (error) or faults and crashes (fault)")
    .action(async (o: { lines: string; app?: string; crash?: boolean; contains?: string; level?: string }) =>
      run(globals(), async (t, out) => {
        const filter = logFilterArgs(o);
        const r = await t.logs({ lines: intArg("--lines", o.lines, 1, MAX_LOG_LINES)!, ...(o.app ? { appId: o.app } : {}), ...(o.crash ? { crash: true } : {}), ...filter });
        const none = r.lines.length === 0 && (filter.contains !== undefined || filter.level !== undefined) ? `${dim("no matching lines")}\n` : "";
        out.result(r, () => `${none}${r.lines.join("\n")}\n${dim(`— ${r.source}; saved to ${r.artifact?.path}`)}`);
      }),
    );

  program
    .command("artifacts")
    .description("Screenshots, recordings and logs from this session")
    .action(async () =>
      run(globals(), async (t, out) => {
        const list = await t.listArtifacts();
        out.result({ artifacts: list, directory: t.artifacts.sessionDir(t.sessionId) }, () =>
          list.length ? list.map((a) => `${a.createdAt}  ${LocalArtifactStore.describe(a)}\n  ${dim(a.path)}`).join("\n") : `none yet (${t.artifacts.sessionDir(t.sessionId)})`,
        );
      }),
    );
}

/** A warning line when --launch names another app than the one just installed. */
function launchMismatch(installed: string | undefined, launched: string | undefined): string[] {
  return installed && launched && installed !== launched ? [yellow(`warning: the installed package is ${installed}, but ${launched} was launched`)] : [];
}

/**
 * `app install`: exactly one of a path and --from-ci; the CI flags only with --from-ci. Returns the CI
 * request, or undefined for an install from a path.
 */
export function checkInstallArgs(
  path: string | undefined,
  o: { appId?: string; fromCi?: string; artifact?: string; run?: string; branch?: string },
): { repo: string; artifact: string; run?: string; branch?: string } | undefined {
  const usage = (message: string) =>
    new TapdanceError("USAGE", message, { hint: "tapdance app install <path>, or tapdance app install --from-ci <owner/repo> --artifact <name> [--run <id> | --branch <name>]" });
  if (o.fromCi === undefined) {
    if (!path) throw usage("Give the app's path, or --from-ci with --artifact");
    if (o.artifact !== undefined || o.run !== undefined || o.branch !== undefined) throw usage("--artifact, --run and --branch go with --from-ci");
    return undefined;
  }
  if (path) throw usage("Give a path or --from-ci, not both");
  if (o.appId !== undefined) throw usage("--app-id goes with a path, not --from-ci");
  if (!o.artifact) throw usage("--from-ci needs --artifact <name>");
  if (o.run !== undefined && o.branch !== undefined) throw usage("Pass --run or --branch, not both");
  if (o.run !== undefined && !/^[1-9][0-9]{0,19}$/.test(o.run)) throw usage("--run must be a workflow run id (digits only)");
  return { repo: o.fromCi, artifact: o.artifact, ...(o.run !== undefined ? { run: o.run } : {}), ...(o.branch !== undefined ? { branch: o.branch } : {}) };
}
