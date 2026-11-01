import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { DEVICE_SETTINGS, LocalArtifactStore, createProfile, deleteProfile, editProfile, listProfiles, TapdanceError, parseTarget, runKeepalive, type DeviceKey, type DeviceSettingName, type Platform } from "@tapdance/sdk";
import { renderDevice, run, spawnKeepalive, type GlobalOptions } from "./context.js";
import { bold, dim, green, table } from "./output.js";

function platformArg(value: string | undefined): Platform {
  if (value === "android" || value === "ios") return value;
  throw new TapdanceError("USAGE", `--platform must be android or ios${value ? `, not "${value}"` : ""}`);
}

function intArg(name: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new TapdanceError("USAGE", `${name} must be an integer from ${min} to ${max}`);
  return n;
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

export function registerDeviceCommands(program: Command, globals: () => GlobalOptions): void {
  // ------------------------------------------------------------- discovery
  const devices = program.command("devices").description("List device models you can lease and what is running");
  const listDevices = (cmd: Command) =>
    cmd.option("-p, --platform <platform>", "android or ios").action(async (o: { platform?: string }) =>
      run(globals(), async (t, out) => {
        const inv = await t.devices(o.platform ? platformArg(o.platform) : undefined);
        out.result(inv, () => {
          const lines: string[] = [];
          for (const c of inv.capacity) lines.push(`${bold(c.platform)}: ${c.running}/${c.limit} running, ${c.warm} warm, ${c.leased} leased`);
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
    .action(async (platform: string, version: string) => {
      const { spawnSync } = await import("node:child_process");
      const { simlockBin } = await import("./context.js");
      platformArg(platform);
      if (!/^[A-Za-z0-9._;-]+$/.test(version)) throw new TapdanceError("USAGE", "version looks wrong");
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
    .option("--image-tag <tag>", "Android system image tag, e.g. google_apis_playstore")
    .option("--physical", "lease an enrolled physical device instead")
    .option("--profile <name>", "boot a device profile from this machine (read-only: the lease's changes are discarded)")
    .option("--ttl <minutes>", "lease time to live in minutes")
    .option("--wait <seconds>", "how long to wait in the queue")
    .option("--no-keepalive", "do not renew in the background (the lease expires after its TTL)")
    .option("--hold", "stay in the foreground, renew, and release on Ctrl-C")
    .action(async (o: { platform: string; device?: string; os?: string; imageTag?: string; physical?: boolean; profile?: string; ttl?: string; wait?: string; keepalive: boolean; hold?: boolean }) =>
      run(globals(), async (t, out) => {
        const ttl = intArg("--ttl", o.ttl, 1, 240);
        const wait = intArg("--wait", o.wait, 0, 3600);
        const { summary } = await t.lease({
          platform: platformArg(o.platform),
          ...(o.device ? { device: o.device } : {}),
          ...(o.os ? { osVersion: o.os } : {}),
          ...(o.imageTag ? { imageTag: o.imageTag } : {}),
          ...(o.physical ? { physical: true } : {}),
          ...(o.profile ? { profile: o.profile } : {}),
          ...(ttl !== undefined ? { ttlMinutes: ttl } : {}),
          ...(wait !== undefined ? { waitSeconds: wait } : {}),
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
        out.result({ device: summary, keepalive }, () => `${renderDevice(summary, [["Keepalive", keepalive]])}\n\n${dim("Next: tapdance app install <path> · tapdance ui inspect · tapdance device release")}`);
        if (o.hold) {
          const controller = new AbortController();
          const stop = () => controller.abort();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          out.progress("Holding the lease; press Ctrl-C to release");
          await runKeepalive(t, { maxMs: cfg.maxSessionMinutes * 60_000, signal: controller.signal, log: (m) => out.progress(m) });
          const released = await t.release();
          out.progress(released.released ? "Released" : "Lease already ended");
        }
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

  const profile = device.command("profile").description("Device profiles: an emulator you set up once (signed in, configured) that leases boot from");
  profile
    .command("create <name>")
    .description("Create a profile from an installed system image, then open it to set up (sign in, settings); close the window to save")
    .option("--image-tag <tag>", "system image tag", "google_apis_playstore")
    .option("--os <api>", "Android API level (default: the highest installed with that tag)")
    .option("--device <id>", "avdmanager device id", "pixel_8")
    .option("--no-edit", "only create it; set it up later with `device profile edit`")
    .action(async (name: string, o: { imageTag: string; os?: string; device: string; edit: boolean }) =>
      run(globals(), async (_t, out) => {
        const record = await createProfile(name, { imageTag: o.imageTag, device: o.device, ...(o.os ? { osVersion: o.os } : {}), onProgress: (m) => out.progress(m) });
        const final = o.edit ? await editProfile(name, { onProgress: (m) => out.progress(m) }) : record;
        out.result({ profile: final }, () => `Profile ${name} ready (${final.image}). Lease it: tapdance device lease -p android --profile ${name}`);
      }),
    );
  profile
    .command("edit <name>")
    .description("Open the profile writable with a window; what you do is kept when you close it")
    .action(async (name: string) =>
      run(globals(), async (_t, out) => {
        const record = await editProfile(name, { onProgress: (m) => out.progress(m) });
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
        out.result({ device: d }, () => renderDevice(d));
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
        out.result(r, () => (r.device ? `Released ${r.device.model} (${r.device.leaseId})` : "This session held no device"));
      }),
    );

  device
    .command("setting <name> [value]")
    .description(`Change (or, without a value, read) a device setting: ${DEVICE_SETTINGS.join(", ")}`)
    .option("--app <appId>", "the app a permission or locale applies to")
    .option("--permission <permission>", "for `setting permission <grant|deny|reset>`: camera, microphone, photos, notifications, location…")
    .option("--lat <latitude>", "for `setting location`: move the device here", Number)
    .option("--lon <longitude>", "for `setting location`", Number)
    .action(async (name: string, value: string | undefined, o: { app?: string; permission?: string; lat?: number; lon?: number }) =>
      run(globals(), async (t, out) => {
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
    .description("Copy a file onto the device (Android shared storage or a debuggable app's sandbox; iOS Photos or an app container, local simulators only)")
    .requiredOption("--to <destination>", "downloads, pictures, documents or app_sandbox")
    .option("--app <appId>", "app for app_sandbox (and iOS documents)")
    .option("--name <name>", "file name on the device")
    .action(async (path: string, o: { to: string; app?: string; name?: string }) =>
      run(globals(), async (t, out) => {
        if (!["downloads", "pictures", "documents", "app_sandbox"].includes(o.to)) throw new TapdanceError("USAGE", "--to must be downloads, pictures, documents or app_sandbox");
        const r = await t.device({ kind: "push-file", localPath: path, destination: o.to as "downloads", ...(o.app ? { appId: o.app } : {}), ...(o.name ? { name: o.name } : {}) });
        out.result(r, () => r.message);
      }),
    );
  device
    .command("pull [devicePath]")
    .description("Copy a file from the device into this session's artifacts")
    .option("--app <appId>", "read from this app's sandbox/container")
    .option("--path <relativePath>", "with --app: path inside it, e.g. files/export.json or Documents/export.json")
    .option("-o, --out <file>", "write here instead of the artifacts directory")
    .action(async (devicePath: string | undefined, o: { app?: string; path?: string; out?: string }) =>
      run(globals(), async (t, out) => {
        const r = await t.device({ kind: "pull-file", outPath: o.out ?? "", ...(devicePath ? { devicePath } : {}), ...(o.app ? { appId: o.app } : {}), ...(o.path ? { relativePath: o.path } : {}) });
        out.result(r, () => r.path ?? r.message);
      }),
    );
  device
    .command("notifications <action>")
    .description("list | open | close | post notifications on the device")
    .option("--app <appId>", "filter (list) or the app a push payload goes to (post)")
    .option("--title <title>", "post: title")
    .option("--text <text>", "post: body")
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
        else throw new TapdanceError("USAGE", "action must be list, open, close or post");
        const list = (r.data?.["notifications"] as Array<{ package: string; title?: string; text?: string }> | undefined) ?? undefined;
        out.result(r, () => (list ? (list.map((n) => `${n.package}: ${n.title ?? ""}${n.text ? ` — ${n.text}` : ""}`).join("\n") || "No notifications") : r.message));
      }),
    );
  device
    .command("shell <command...>")
    .description("Android emulators: run a command with `adb shell` inside the leased emulator (not on this machine)")
    .option("--stdin <file>", "pass this file's contents on stdin")
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
    .command("install <path>")
    .description("Upload and install an .apk (Android) or simulator .app (iOS)")
    .option("--app-id <id>", "package / bundle id, when the backend needs it")
    .action(async (path: string, o: { appId?: string }) =>
      run(globals(), async (t, out) => {
        const r = await t.installApp(path, o.appId);
        out.result({ installed: r }, () => `Installed ${r.appId ?? path}`);
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
    .action(async (appId: string, o: { relaunch?: boolean; url?: string; arg?: string[]; intentAction?: string; intentData?: string; intentComponent?: string; intentExtra?: string[] }) =>
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
        const r = await t.launchApp(appId, { ...(o.relaunch ? { relaunch: true } : {}), ...(o.url ? { url: o.url } : {}), ...(o.arg?.length ? { args: o.arg } : {}) });
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
    .command("stop <appId>")
    .description("Force-stop an app")
    .action(async (appId: string) => run(globals(), async (t, out) => out.result(await t.stopApp(appId), () => `Stopped ${appId}`)));
  app
    .command("list")
    .description("List apps the automation backend sees")
    .action(async () => run(globals(), async (t, out) => { const apps = await t.listApps(); out.result({ apps }, () => apps.join("\n") || "none"); }));

  // ------------------------------------------------------------- UI
  const ui = program.command("ui").description("Inspect and drive the leased device's UI");
  ui.command("inspect")
    .description("List on-screen elements with refs, roles and labels")
    .option("--all", "include non-interactive elements")
    .action(async (o: { all?: boolean }) =>
      run(globals(), async (t, out) => {
        const s = await t.inspect({ interactiveOnly: !o.all });
        out.result(s, () =>
          [
            dim(`${s.app ?? "unknown app"}${s.viewport ? ` · ${s.viewport.width}×${s.viewport.height}` : ""} · ${s.elements.length} elements${s.truncated ? " (truncated)" : ""}`),
            ...s.elements.map((e) => `${"  ".repeat(Math.min(e.depth ?? 0, 6))}${bold(e.ref)} [${e.role}]${e.label ? ` "${e.label}"` : ""}${e.value ? ` = "${e.value}"` : ""}${e.identifier ? dim(` #${e.identifier}`) : ""}${e.enabled === false ? dim(" (disabled)") : ""}`),
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
    .action(async (o: { text?: string; id?: string; ref?: string; selector?: string; x?: string; y?: string; settle: boolean }) =>
      run(globals(), async (t, out) => {
        const target = parseTarget({
          ...(o.text !== undefined ? { text: o.text } : {}),
          ...(o.id !== undefined ? { id: o.id } : {}),
          ...(o.ref !== undefined ? { ref: o.ref } : {}),
          ...(o.selector !== undefined ? { selector: o.selector } : {}),
          ...(o.x !== undefined ? { x: numArg("--x", o.x)! } : {}),
          ...(o.y !== undefined ? { y: numArg("--y", o.y)! } : {}),
        });
        const r = await t.tap(target, { settle: o.settle });
        out.result(r, () => [r.message, ...(r.changes ?? []).map((c) => dim(`  ${c}`))].join("\n"));
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
    .action(async (text: string, o: { text?: string; id?: string; ref?: string; selector?: string; x?: string; y?: string }) =>
      run(globals(), async (t, out) => {
        const named = { ...(o.text !== undefined ? { text: o.text } : {}), ...(o.id !== undefined ? { id: o.id } : {}), ...(o.ref !== undefined ? { ref: o.ref } : {}), ...(o.selector !== undefined ? { selector: o.selector } : {}), ...(o.x !== undefined ? { x: numArg("--x", o.x)! } : {}), ...(o.y !== undefined ? { y: numArg("--y", o.y)! } : {}) };
        const r = await t.typeText(text, Object.keys(named).length ? parseTarget(named) : undefined);
        out.result(r, () => r.message);
      }),
    );

  ui.command("wait")
    .description("Wait for text to appear (--text), disappear (--absent), or the UI to settle (--stable)")
    .option("--text <text>")
    .option("--absent <text>")
    .option("--stable")
    .option("--timeout <ms>", "at most 30000", "10000")
    .action(async (o: { text?: string; absent?: string; stable?: boolean; timeout: string }) =>
      run(globals(), async (t, out) => {
        const given = [o.text, o.absent, o.stable].filter((v) => v !== undefined && v !== false).length;
        if (given !== 1) throw new TapdanceError("USAGE", "Give exactly one of --text, --absent, --stable");
        const condition = o.text ? { kind: "text" as const, text: o.text } : o.absent ? { kind: "absent" as const, text: o.absent } : { kind: "stable" as const };
        const r = await t.waitFor(condition, intArg("--timeout", o.timeout, 100, 30_000));
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
    .option("-n, --lines <n>", "how many lines", "200")
    .option("--app <id>", "only this app")
    .option("--crash", "crash buffer / faults only")
    .action(async (o: { lines: string; app?: string; crash?: boolean }) =>
      run(globals(), async (t, out) => {
        const r = await t.logs({ lines: intArg("--lines", o.lines, 1, 5000)!, ...(o.app ? { appId: o.app } : {}), ...(o.crash ? { crash: true } : {}) });
        out.result(r, () => `${r.lines.join("\n")}\n${dim(`— ${r.source}; saved to ${r.artifact?.path}`)}`);
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
