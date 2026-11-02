import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentDeviceClient } from "agent-device";
import { TapdanceError, type DeviceNotification, type DeviceOperation, type DeviceOperationResult, type LeaseHandle } from "@tapdance/core";
import { fromAgentDeviceError } from "./agent-device-errors.js";
import { android, FILES_GROUP, ios, MAX_PUSH_BYTES, parseGroupContainer, type DeviceCommand } from "./device-commands.js";
import type { ExecResult } from "./http.js";

/** What the provider lends this module: the lease's agent-device client and Simlock's lease exec. */
export interface DeviceOperationContext {
  client: AgentDeviceClient;
  /** Lease scope and device selection fields agent-device expects on every call. */
  scope: Record<string, unknown>;
  exec: (command: DeviceCommand, timeoutMs?: number) => Promise<ExecResult>;
  /** True when the device runs on this machine (local worker), so host paths are meaningful. */
  local: boolean;
  /** Remote iOS files through a worker guard's files route (the guard resolves every path itself). */
  remoteFiles?: {
    put: (query: Record<string, string>, bytes: Buffer) => Promise<{ devicePath: string }>;
    get: (query: Record<string, string>) => Promise<Buffer>;
  };
}

const SHARED_DIR: Record<string, string> = { downloads: "Download", pictures: "Pictures", documents: "Documents" };
const AGENT_DEVICE_SETTINGS = new Set(["wifi", "bluetooth", "airplane", "mobile-data", "location", "animations", "appearance", "text-size", "faceid", "touchid", "fingerprint"]);

const notSupported = (message: string, hint?: string) => new TapdanceError("NOT_SUPPORTED", message, hint ? { hint } : {});

function needApp(appId: string | undefined, what: string): string {
  if (!appId) throw new TapdanceError("USAGE", `${what} needs app_id`);
  return appId;
}

async function run(ctx: DeviceOperationContext, command: DeviceCommand, action: string, timeoutMs?: number): Promise<ExecResult> {
  const result = await ctx.exec(command, timeoutMs);
  if (result.exitCode !== 0) {
    const text = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
    if (/run-as: package not debuggable|is not debuggable/i.test(text)) {
      throw new TapdanceError("FORBIDDEN", `${action} failed: the app is not debuggable`, { hint: "App sandbox access needs a debug build (android:debuggable). Use a shared folder (downloads, pictures, documents) instead." });
    }
    if (/No such file|does not exist/i.test(text)) throw new TapdanceError("USAGE", `${action} failed: ${text}`);
    throw new TapdanceError("DEVICE_ERROR", `${action} failed: ${text || `exit ${result.exitCode}`}`);
  }
  return result;
}

async function agentDevice<T>(action: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw fromAgentDeviceError(error, action);
  }
}

/** Parses `dumpsys notification --noredact` into the posted notifications (Android). */
export function parseNotifications(dump: string): DeviceNotification[] {
  const out: DeviceNotification[] = [];
  const blocks = dump.split(/\n\s*NotificationRecord\(/).slice(1);
  for (const block of blocks) {
    const pkg = /pkg=([A-Za-z0-9_.]+)/.exec(block)?.[1];
    if (!pkg) continue;
    const n: DeviceNotification = { package: pkg };
    const key = /key=([^\s:]+)/.exec(block)?.[1];
    if (key) n.key = key;
    const extra = (name: string) => new RegExp(`android\\.${name}=(?:String|SpannableString)?\\s*\\((.*)\\)\\s*$`, "m").exec(block)?.[1];
    const title = extra("title");
    const text = extra("text");
    if (title) n.title = title;
    if (text) n.text = text;
    const when = /\bwhen=(\d{10,13})/.exec(block)?.[1];
    if (when) n.postedAt = new Date(Number(when)).toISOString();
    if (!out.some((o) => o.key !== undefined && o.key === n.key)) out.push(n);
  }
  return out;
}

export async function runDeviceOperation(ctx: DeviceOperationContext, handle: LeaseHandle, op: DeviceOperation): Promise<DeviceOperationResult> {
  const isAndroid = handle.platform === "android";
  const scope = ctx.scope;
  switch (op.kind) {
    case "uninstall": {
      if (!isAndroid && op.appId.startsWith("com.apple.")) throw notSupported(`${op.appId} is a system app; system apps cannot be removed from a simulator`);
      const r = (await agentDevice(`uninstall ${op.appId}`, () => ctx.client.apps.uninstall({ app: op.appId, ...scope } as never))) as { wasInstalled?: boolean };
      return { ok: true, message: r?.wasInstalled === false ? `${op.appId} was not installed` : `Uninstalled ${op.appId}`, data: { wasInstalled: r?.wasInstalled ?? true } };
    }
    case "clear-app-data": {
      await agentDevice(`clear data of ${op.appId}`, () => ctx.client.settings.update({ setting: "clear-app-state", state: "clear", app: op.appId, ...scope } as never));
      return {
        ok: true,
        message: `Cleared the data of ${op.appId}`,
        ...(isAndroid ? {} : { data: { note: "The iOS keychain is shared by every app on the simulator; reset it with set_device_setting reset-keychain for a signed-out first run." } }),
      };
    }
    case "kill-app":
      return killApp(ctx, handle, op.appId);
    case "clipboard": {
      const command = ctx.client.command as unknown as { clipboard: (o: unknown) => Promise<{ text?: string; textLength?: number }> };
      if (op.action === "get") {
        const r = await agentDevice("read the clipboard", () => command.clipboard({ action: "read", ...scope }));
        return { ok: true, message: r?.text ? `Clipboard: ${r.text.slice(0, 200)}` : "The clipboard is empty", data: { text: r?.text ?? "" } };
      }
      if (op.text.length > 64 * 1024) throw new TapdanceError("USAGE", "Clipboard text is limited to 64 KB");
      await agentDevice("write the clipboard", () => command.clipboard({ action: "write", text: op.text, ...scope }));
      return { ok: true, message: `Copied ${op.text.length} character(s) to the clipboard` };
    }
    case "app-locale": {
      if (!isAndroid) throw notSupported("Per-app locale through a setting is Android only", "On iOS pass locale to launch_app (it sets -AppleLanguages and -AppleLocale).");
      const r = await run(ctx, android.appLocale(op.appId, op.locale), `set ${op.appId}'s locale`);
      if (/Unknown command|Error/i.test(r.stdout)) throw notSupported(`This Android version cannot set an app's locale (${r.stdout.trim().slice(0, 120)})`, "Per-app locales need Android 13 (API 33) or newer.");
      return { ok: true, message: `${op.appId} now runs in ${op.locale} (relaunch it)` };
    }
    case "tap-sequence": {
      if (!isAndroid) throw notSupported("Timed tap sequences are Android only", "On iOS, tap one at a time.");
      const cmd = android.tapSequence(op.steps);
      const last = op.steps.at(-1)!;
      const r = await run(ctx, cmd, "tap sequence", last.t + (last.hold ?? 0) + 20_000);
      // Lines "<index> <µs since start>": when each tap was started on the device.
      const started = new Map<number, number>();
      for (const line of r.stdout.split("\n")) {
        const m = /^(\d+) (-?\d+)$/.exec(line.trim());
        if (m) started.set(Number(m[1]), Number(m[2]) / 1000);
      }
      const steps = op.steps.map((s, i) => ({ ...s, ...(started.has(i) ? { actualMs: Math.round(started.get(i)! * 10) / 10, driftMs: Math.round((started.get(i)! - s.t) * 10) / 10 } : {}) }));
      const drifts = steps.map((s) => Math.abs(s.driftMs ?? 0));
      return {
        ok: started.size === op.steps.length,
        message: `Ran ${started.size}/${op.steps.length} taps on the device; largest start drift ${Math.max(0, ...drifts).toFixed(1)} ms`,
        data: {
          steps,
          maxDriftMs: Math.max(0, ...drifts),
          note: "actualMs is when each tap was started inside the emulator; Android's input command then takes a few tens of ms to deliver it.",
        },
      };
    }
    case "setting":
      return setting(ctx, handle, op.change);
    case "intent": {
      if (!isAndroid) throw notSupported("Intents are Android only", "On iOS, open a deep link with launch_app url, or pass launch arguments with args.");
      const r = await run(ctx, android.startIntent(op.intent), "start intent", 60_000);
      if (/Error:|Exception/.test(r.stdout)) throw new TapdanceError("DEVICE_ERROR", `The intent was refused: ${r.stdout.trim().split("\n").find((l) => /Error|Exception/.test(l))}`);
      return { ok: true, message: "Started the intent", data: { output: r.stdout.trim().slice(0, 2000) } };
    }
    case "push-file":
      return pushFile(ctx, handle, op);
    case "pull-file":
      return pullFile(ctx, handle, op);
    case "notifications": {
      if (op.action === "list") {
        if (!isAndroid) throw notSupported("The iOS simulator has no notification list API", "Use notifications action open, then inspect_screen to read Notification Center.");
        const r = await run(ctx, android.notifications(), "read notifications");
        const all = parseNotifications(r.stdout);
        const list = op.appId ? all.filter((n) => n.package === op.appId) : all;
        return { ok: true, message: `${list.length} notification(s)`, data: { notifications: list } };
      }
      if (!isAndroid) return notificationCenter(ctx, op.action === "open");
      await run(ctx, android.shade(op.action === "open"), `${op.action} the notification shade`);
      return { ok: true, message: op.action === "open" ? "Opened the notification shade; inspect_screen to read or tap it" : "Closed the notification shade" };
    }
    case "post-notification": {
      if (op.payload !== undefined || !isAndroid) {
        const app = needApp(op.appId, "A push notification");
        const payload = op.payload ?? { aps: { alert: { title: op.title ?? "Tapdance", body: op.text ?? "" } } };
        await agentDevice("push notification", () => ctx.client.apps.push({ app, payload: payload as never, ...scope } as never));
        return { ok: true, message: `Delivered a push payload to ${app}` };
      }
      await run(ctx, android.postNotification(op.title ?? "Tapdance", op.text ?? "Test notification"), "post notification");
      return { ok: true, message: "Posted a test notification from the shell (package com.android.shell)" };
    }
    case "shell": {
      if (!isAndroid) {
        throw notSupported("device_shell is Android only", "iOS simulator processes run on the Mac itself, so a simulator shell would be a Mac shell. Use the other device tools.");
      }
      if (handle.physical) throw new TapdanceError("FORBIDDEN", "device_shell runs on emulators only", { hint: "A physical phone holds its owner's data." });
      const command = op.command.trim();
      if (command === "" || command.includes("\u0000")) throw new TapdanceError("USAGE", "device_shell needs a command");
      // One argument: adb hands it to the emulator's own shell, which parses it (pipes, redirects).
      const r = await ctx.exec({ tool: "adb", args: ["shell", command], ...(op.stdin !== undefined ? { stdin: op.stdin } : {}) }, op.timeoutMs ?? 120_000);
      const cut = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);
      return { ok: r.exitCode === 0, message: `exit ${r.exitCode}`, data: { exitCode: r.exitCode, stdout: cut(r.stdout, 32_000), stderr: cut(r.stderr, 8_000), truncated: r.stdout.length > 32_000 || r.stderr.length > 8_000 } };
    }
    case "perf": {
      const options = op.metric === "frames" ? { area: "frames" } : { area: "memory", subject: "sample" };
      const r = await agentDevice(`perf ${op.metric}`, () => ctx.client.observability.perf({ ...options, ...(op.appId ? { app: op.appId } : {}), ...scope } as never));
      return { ok: true, message: `Collected ${op.metric} data`, data: { [op.metric]: r as unknown } };
    }
  }
}

async function setting(ctx: DeviceOperationContext, handle: LeaseHandle, change: { name: string; value?: string; appId?: string; permission?: string; latitude?: number; longitude?: number }): Promise<DeviceOperationResult> {
  const isAndroid = handle.platform === "android";
  const { name } = change;
  let value = change.value;
  const scope = ctx.scope;
  const update = (options: Record<string, unknown>) => agentDevice(`setting ${name}`, () => ctx.client.settings.update({ ...options, ...scope } as never));
  // The simulator shares the Mac's network: agent-device only redraws the status bar for these, and
  // that also drops a status-bar time override. Saying "offline" would mislead a test (#48).
  if (!isAndroid && (name === "wifi" || name === "airplane") && value !== undefined) {
    throw notSupported(
      `The iOS simulator cannot go offline: it uses the Mac's network, so ${name} ${value} would only change the status bar`,
      "Test offline paths on Android (airplane on works there), or make the app's server unreachable in a test build. For a screenshot, status-bar-time keeps the clock.",
    );
  }
  if (AGENT_DEVICE_SETTINGS.has(name)) {
    if (name === "location" && change.latitude !== undefined && change.longitude !== undefined) {
      const r = await update({ setting: "location", state: "set", latitude: change.latitude, longitude: change.longitude, ...(change.appId ? { app: change.appId } : {}) });
      return { ok: true, message: `Location set to ${change.latitude}, ${change.longitude}`, data: { result: r as unknown } };
    }
    const r = await update({ setting: name, ...(value !== undefined ? { state: value } : {}), ...(change.appId ? { app: change.appId } : {}) });
    return { ok: true, message: value === undefined ? `Read ${name}` : `${name} → ${value}`, data: { result: r as unknown } };
  }
  switch (name) {
    case "permission": {
      if (!change.permission) throw new TapdanceError("USAGE", "permission needs permission (camera, microphone, photos, notifications, location…)");
      const r = await update({ setting: "permission", state: value ?? "grant", permission: change.permission, app: needApp(change.appId, "permission") });
      return { ok: true, message: `${change.permission} → ${value ?? "grant"} for ${change.appId}`, data: { result: r as unknown } };
    }
    case "reset-keychain":
      if (isAndroid) throw notSupported("reset-keychain is iOS only", "On Android, clear_app_data removes an app's stored credentials.");
      await update({ setting: "reset-keychain", state: "clear" });
      return { ok: true, message: "Reset the simulator keychain (every app)" };
    case "orientation": {
      if (!value) {
        // Read: the screen's shape says portrait or landscape (not which way it turned).
        const snap = (await agentDevice("read the orientation", () => ctx.client.capture.snapshot({ interactiveOnly: true, ...scope } as never))) as { viewport?: { width?: number; height?: number } };
        const w = snap?.viewport?.width;
        const h = snap?.viewport?.height;
        if (!w || !h) throw new TapdanceError("DEVICE_ERROR", "The screen size was not reported, so the orientation is unknown");
        const orientation = w > h ? "landscape" : "portrait";
        return { ok: true, message: `The screen is ${orientation} (${w}×${h})`, data: { orientation, width: w, height: h } };
      }
      if (value === "landscape") value = "landscape-left";
      const command = ctx.client.command as unknown as { orientation: (o: unknown) => Promise<unknown> };
      // agent-device confirms the rotation within a short budget that a busy emulator can miss once.
      await agentDevice("orientation", () => command.orientation({ orientation: value, ...scope })).catch(async (error: unknown) => {
        if (!(error instanceof TapdanceError) || !/timed out/i.test(error.message)) throw error;
        await new Promise((r) => setTimeout(r, 1500));
        await agentDevice("orientation", () => command.orientation({ orientation: value, ...scope }));
      });
      return { ok: true, message: `Rotated to ${value}` };
    }
    case "browser-first-run": {
      if (!isAndroid) throw notSupported("browser-first-run is Android only (Safari has no first-run screens on the simulator)");
      if (value !== "off") throw new TapdanceError("USAGE", "browser-first-run takes off (Chrome skips its welcome, sign-in and default-browser screens)");
      await run(ctx, android.chromeFlags(), "write Chrome's command line");
      await run(ctx, android.chromeDebugApp(), "let Chrome read its command line");
      // Android 13+: with the permission already granted, Chrome skips its notifications promo sheet.
      await ctx.exec(android.chromeNotifications());
      await ctx.exec({ tool: "adb", args: ["shell", "am", "force-stop", "com.android.chrome"] });
      return { ok: true, message: "Chrome now starts without its first-run screens (until the lease ends)" };
    }
    case "status-bar-time": {
      if (isAndroid) throw notSupported("status-bar-time is iOS only");
      if (value === undefined) {
        const r = await run(ctx, ios.statusBarList(), "read the status bar");
        const time = /Time:\s*(\S+)/.exec(r.stdout)?.[1];
        return { ok: true, message: time ? `Status bar time is overridden to ${time}` : "The status bar shows the real time", data: { time: time ?? null } };
      }
      if (value === "clear") {
        await run(ctx, ios.statusBarClear(), "status bar");
        return { ok: true, message: "Status bar restored" };
      }
      const time = /^\d:\d\d$/.test(value) ? `0${value}` : value;
      await run(ctx, ios.statusBarTime(time), "status bar");
      return { ok: true, message: `Status bar shows ${time}` };
    }
  }
  throw new TapdanceError("USAGE", `Unknown setting "${name}"`);
}

async function pushFile(ctx: DeviceOperationContext, handle: LeaseHandle, op: Extract<DeviceOperation, { kind: "push-file" }>): Promise<DeviceOperationResult> {
  const local = resolve(op.localPath);
  const info = await stat(local).catch(() => undefined);
  if (!info?.isFile()) throw new TapdanceError("USAGE", `${op.localPath} is not a file`);
  const name = op.name ?? basename(local);
  if (handle.platform === "android") {
    if (op.destination === "files") throw notSupported("files is the iOS Files app", "On Android use downloads or documents: shared storage the system file picker shows.");
    if (info.size > MAX_PUSH_BYTES) throw new TapdanceError("USAGE", `Files are limited to ${MAX_PUSH_BYTES / 1024 / 1024} MB`);
    const base64 = (await readFile(local)).toString("base64");
    if (op.destination === "app_sandbox") {
      const relative = name.includes("/") ? name : `files/${name}`;
      await run(ctx, android.pushSandbox(needApp(op.appId, "app_sandbox"), relative, base64), "push file", 300_000);
      return { ok: true, message: `Pushed ${name} into ${op.appId}'s ${relative}`, devicePath: relative };
    }
    const devicePath = `/sdcard/${SHARED_DIR[op.destination]}/${name}`;
    await run(ctx, android.pushShared(devicePath, base64), "push file", 300_000);
    // Let the media store (and so the system file picker and gallery) see it.
    await run(ctx, android.mediaScan(devicePath), "media scan").catch(() => undefined);
    return { ok: true, message: `Pushed ${name} to ${devicePath}`, devicePath };
  }
  if (!ctx.local) {
    if (!ctx.remoteFiles) throw notSupported("Pushing files to a remote iOS simulator needs a worker guard", "Use a worker in device-only mode, or run Tapdance on the Mac that runs the simulator.");
    if (info.size > MAX_PUSH_BYTES * 4) throw new TapdanceError("USAGE", `Files are limited to ${MAX_PUSH_BYTES * 4 / 1024 / 1024} MB`);
    const bytes = await readFile(local);
    if (op.destination === "pictures") return { ok: true, message: `Added ${name} to Photos`, ...(await ctx.remoteFiles.put({ destination: "photos", name }, bytes)) };
    if (op.destination === "downloads") throw notSupported("iOS has no shared Downloads folder", "Use files (the Files app's On My iPhone, seen by document pickers), pictures, or documents with app_id.");
    if (op.destination === "files") return { ok: true, message: `Put ${name} in Files › On My iPhone`, ...(await ctx.remoteFiles.put({ destination: "files", name }, bytes)) };
    const r = await ctx.remoteFiles.put({ destination: "documents", app: needApp(op.appId, "documents on iOS (or use files for the Files app)"), name }, bytes);
    return { ok: true, message: `Copied ${name} into ${op.appId}'s Documents`, ...r };
  }
  if (op.destination === "pictures") {
    await run(ctx, { tool: "simctl", args: ["addmedia", local] }, "add media");
    return { ok: true, message: `Added ${name} to Photos`, devicePath: "Photos" };
  }
  if (op.destination === "files") {
    if (!PLAIN_NAME.test(name)) throw new TapdanceError("USAGE", "name must be a plain file name");
    const root = await filesStorage(ctx);
    await mkdir(root, { recursive: true });
    await copyFile(local, join(root, name));
    return { ok: true, message: `Put ${name} in Files › On My iPhone`, devicePath: `On My iPhone/${name}` };
  }
  if (op.destination === "downloads") throw notSupported("iOS has no shared Downloads folder", "Use files (the Files app's On My iPhone, seen by document pickers), pictures, or documents with app_id.");
  const container = await appContainer(ctx, needApp(op.appId, "Files on iOS"));
  const target = join(container, op.destination === "app_sandbox" && name.includes("/") ? name : join("Documents", name));
  if (!resolve(target).startsWith(container)) throw new TapdanceError("USAGE", "The path must stay inside the app's container");
  await mkdir(dirname(target), { recursive: true });
  await copyFile(local, target);
  return { ok: true, message: `Copied ${name} into ${op.appId}'s container`, devicePath: target.slice(container.length + 1) };
}

async function pullFile(ctx: DeviceOperationContext, handle: LeaseHandle, op: Extract<DeviceOperation, { kind: "pull-file" }>): Promise<DeviceOperationResult> {
  if (handle.platform === "android") {
    const command = op.devicePath ? android.pullShared(op.devicePath) : android.pullSandbox(needApp(op.appId, "pull_file"), op.relativePath ?? "");
    const r = await run(ctx, command, "pull file", 300_000);
    const bytes = Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
    await mkdir(dirname(op.outPath), { recursive: true });
    await writeFile(op.outPath, bytes, { mode: 0o600 });
    return { ok: true, message: `Pulled ${bytes.length} bytes`, path: op.outPath };
  }
  if (!ctx.local) {
    if (!ctx.remoteFiles) throw notSupported("Pulling files from a remote iOS simulator needs a worker guard", "Use a worker in device-only mode, or run Tapdance on the Mac that runs the simulator.");
    const bytes = op.filesName
      ? await ctx.remoteFiles.get({ area: "files", path: op.filesName })
      : await ctx.remoteFiles.get({ app: needApp(op.appId, "pull_file on iOS"), path: op.relativePath ?? "" });
    await mkdir(dirname(op.outPath), { recursive: true });
    await writeFile(op.outPath, bytes, { mode: 0o600 });
    return { ok: true, message: `Pulled ${bytes.length} bytes`, path: op.outPath };
  }
  if (op.filesName) {
    if (!PLAIN_NAME.test(op.filesName)) throw new TapdanceError("USAGE", "files_name must be a plain file name");
    await mkdir(dirname(op.outPath), { recursive: true });
    await copyFile(join(await filesStorage(ctx), op.filesName), op.outPath);
    return { ok: true, message: `Pulled ${op.filesName} from Files › On My iPhone`, path: op.outPath };
  }
  const container = await appContainer(ctx, needApp(op.appId, "pull_file on iOS"));
  const source = resolve(container, op.relativePath ?? "");
  if (!source.startsWith(`${container}/`)) throw new TapdanceError("USAGE", "relative_path must stay inside the app's container (for example Documents/export.json)");
  await mkdir(dirname(op.outPath), { recursive: true });
  await copyFile(source, op.outPath);
  return { ok: true, message: `Pulled ${basename(source)}`, path: op.outPath };
}

const PLAIN_NAME = /^(?!\.)[A-Za-z0-9 _.()+-]{1,128}$/;

/** The simulator's File Provider local storage: the Files app's "On My iPhone" (#47). */
async function filesStorage(ctx: DeviceOperationContext): Promise<string> {
  const r = await run(ctx, ios.filesGroups(), "find the Files app's storage");
  const group = parseGroupContainer(r.stdout, FILES_GROUP);
  if (!group) throw new TapdanceError("DEVICE_ERROR", "The Files app's local storage was not found on this simulator");
  return join(group, "File Provider Storage");
}

async function appContainer(ctx: DeviceOperationContext, appId: string): Promise<string> {
  const r = await run(ctx, { tool: "simctl", args: ["get_app_container", appId, "data"] }, `find ${appId}'s container`);
  const path = r.stdout.trim().split("\n").pop() ?? "";
  if (!path.startsWith("/")) throw new TapdanceError("APP_NOT_INSTALLED", `${appId} has no data container on this simulator`);
  return resolve(path);
}

/**
 * Ends an app the way a user does, then checks its process is gone. Android: Home, then `am stop-app`
 * (Android 14+; keeps alarms and jobs, unlike force-stop), else a memory trim and `am kill` of the now
 * cached process. A process that survives (a foreground service) is reported, not hidden. iOS: the
 * simulator's terminate is what swiping an app away does.
 */
async function killApp(ctx: DeviceOperationContext, handle: LeaseHandle, appId: string): Promise<DeviceOperationResult> {
  if (handle.platform !== "android") {
    await run(ctx, { tool: "simctl", args: ["terminate", appId] }, `end ${appId}`).catch((error: unknown) => {
      // simctl answers an error when the app was not running.
      if (!/found nothing to terminate|not running/i.test((error as Error).message)) throw error;
    });
    return { ok: true, message: `Ended ${appId}`, data: { method: "simctl terminate" } };
  }
  const pid = async () => (await ctx.exec(android.pidOf(appId))).stdout.trim() || undefined;
  const before = await pid();
  if (!before) return { ok: true, message: `${appId} was not running`, data: { running: false } };
  await run(ctx, android.home(), "press Home");
  let method = "am stop-app";
  const stop = await ctx.exec(android.stopApp(appId));
  if (stop.exitCode !== 0 || /Unknown command|Error/i.test(`${stop.stdout}${stop.stderr}`)) {
    method = "am send-trim-memory + am kill";
    await ctx.exec(android.trimMemory(appId));
    await ctx.exec(android.killBackground(appId));
  }
  let after = await pid();
  for (let i = 0; i < 6 && after; i++) {
    await new Promise((r) => setTimeout(r, 500));
    after = await pid();
  }
  if (after) {
    return {
      ok: false,
      message: `${appId} is still running (pid ${after}) after ${method}; something keeps it alive (a foreground service?)`,
      data: { method, pidBefore: before, pidAfter: after, hint: "`app stop` force-stops it, which also cancels its alarms and jobs." },
    };
  }
  return { ok: true, message: `Ended ${appId} like a user (pid ${before} gone; alarms and jobs kept)`, data: { method, pidBefore: before } };
}

/**
 * iOS Notification Center: a swipe down from the top-left edge opens it, a swipe up from the bottom
 * closes it (the simulator has no API for either).
 */
async function notificationCenter(ctx: DeviceOperationContext, open: boolean): Promise<DeviceOperationResult> {
  // The size comes from a snapshot of the session's app; with no app running (#49) use a phone's.
  const snap = (await ctx.client.capture.snapshot({ interactiveOnly: true, ...ctx.scope } as never).catch(() => undefined)) as { viewport?: { width?: number; height?: number } } | undefined;
  const w = snap?.viewport?.width ?? 402;
  const h = snap?.viewport?.height ?? 874;
  const x = Math.round(w * 0.25);
  const [from, to] = open ? [{ x, y: 2 }, { x, y: Math.round(h * 0.7) }] : [{ x: Math.round(w / 2), y: h - 2 }, { x: Math.round(w / 2), y: Math.round(h * 0.3) }];
  await agentDevice(`${open ? "open" : "close"} Notification Center`, () => ctx.client.interactions.swipe({ from, to, ...ctx.scope } as never));
  return { ok: true, message: open ? "Opened Notification Center; inspect_screen (all) to read it" : "Closed Notification Center" };
}
