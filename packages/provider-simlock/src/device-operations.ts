import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentDeviceClient } from "agent-device";
import { TapdanceError, type DeviceNotification, type DeviceOperation, type DeviceOperationResult, type LeaseHandle } from "@tapdance/core";
import { fromAgentDeviceError } from "./agent-device-errors.js";
import { android, ios, MAX_PUSH_BYTES, type DeviceCommand } from "./device-commands.js";
import type { ExecResult } from "./http.js";

/** What the provider lends this module: the lease's agent-device client and Simlock's lease exec. */
export interface DeviceOperationContext {
  client: AgentDeviceClient;
  /** Lease scope and device selection fields agent-device expects on every call. */
  scope: Record<string, unknown>;
  exec: (command: DeviceCommand, timeoutMs?: number) => Promise<ExecResult>;
  /** True when the device runs on this machine (local worker), so host paths are meaningful. */
  local: boolean;
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
      if (!isAndroid) throw notSupported("Opening Notification Center is not automated on iOS", "Swipe down from the top-left edge with swipe (points), then inspect_screen.");
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
    case "perf": {
      const options = op.metric === "frames" ? { area: "frames" } : { area: "memory", subject: "sample" };
      const r = await agentDevice(`perf ${op.metric}`, () => ctx.client.observability.perf({ ...options, ...(op.appId ? { app: op.appId } : {}), ...scope } as never));
      return { ok: true, message: `Collected ${op.metric} data`, data: { [op.metric]: r as unknown } };
    }
    case "audio": {
      const r = await agentDevice(`audio probe ${op.action}`, () =>
        ctx.client.observability.audio({ action: "probe", probeAction: op.action, ...(op.durationMs ? { durationMs: op.durationMs } : {}), ...scope } as never),
      );
      return { ok: true, message: `Audio probe ${op.action}`, data: { audio: r as unknown } };
    }
  }
}

async function setting(ctx: DeviceOperationContext, handle: LeaseHandle, change: { name: string; value?: string; appId?: string; permission?: string; latitude?: number; longitude?: number }): Promise<DeviceOperationResult> {
  const isAndroid = handle.platform === "android";
  const { name, value } = change;
  const scope = ctx.scope;
  const update = (options: Record<string, unknown>) => agentDevice(`setting ${name}`, () => ctx.client.settings.update({ ...options, ...scope } as never));
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
      if (!value) throw new TapdanceError("USAGE", "orientation needs a value: portrait, landscape-left, landscape-right or portrait-upside-down");
      const command = ctx.client.command as unknown as { orientation: (o: unknown) => Promise<unknown> };
      // agent-device confirms the rotation within a short budget that a busy emulator can miss once.
      await agentDevice("orientation", () => command.orientation({ orientation: value, ...scope })).catch(async (error: unknown) => {
        if (!(error instanceof TapdanceError) || !/timed out/i.test(error.message)) throw error;
        await new Promise((r) => setTimeout(r, 1500));
        await agentDevice("orientation", () => command.orientation({ orientation: value, ...scope }));
      });
      return { ok: true, message: `Rotated to ${value}` };
    }
    case "density":
      if (!isAndroid) throw notSupported("Display density is Android only", "Lease a different simulator model for another screen size.");
      await run(ctx, android.density(value === "reset" || value === undefined ? "reset" : Number(value)), "set density");
      return { ok: true, message: value && value !== "reset" ? `Density ${value} dpi` : "Density reset" };
    case "locale":
      if (!isAndroid) throw notSupported("The iOS simulator's language is set per launch", 'Relaunch with launch_app args ["-AppleLanguages", "(de)", "-AppleLocale", "de_DE"].');
      await run(ctx, android.appLocale(needApp(change.appId, "locale"), value ?? ""), "set app locale");
      return { ok: true, message: `${change.appId} locale → ${value} (relaunch the app to see it)` };
    case "time-zone":
      if (!isAndroid) throw notSupported("The iOS simulator uses the Mac's time zone", "Use status-bar-time to fix the displayed clock for screenshots.");
      await run(ctx, android.autoTimeZone(false), "turn off automatic time zone");
      await run(ctx, android.timeZone(value ?? ""), "set time zone");
      return { ok: true, message: `Time zone → ${value}` };
    case "status-bar-time":
      if (isAndroid) throw notSupported("status-bar-time is iOS only");
      await run(ctx, value === "clear" || value === undefined ? ios.statusBarClear() : ios.statusBarTime(value), "status bar");
      return { ok: true, message: value && value !== "clear" ? `Status bar shows ${value}` : "Status bar restored" };
  }
  throw new TapdanceError("USAGE", `Unknown setting "${name}"`);
}

async function pushFile(ctx: DeviceOperationContext, handle: LeaseHandle, op: Extract<DeviceOperation, { kind: "push-file" }>): Promise<DeviceOperationResult> {
  const local = resolve(op.localPath);
  const info = await stat(local).catch(() => undefined);
  if (!info?.isFile()) throw new TapdanceError("USAGE", `${op.localPath} is not a file`);
  const name = op.name ?? basename(local);
  if (handle.platform === "android") {
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
    throw notSupported("Pushing files to a remote iOS simulator is not supported", "simctl needs the file on the Mac that runs the simulator; run Tapdance on that Mac, or have the app download it.");
  }
  if (op.destination === "pictures") {
    await run(ctx, { tool: "simctl", args: ["addmedia", local] }, "add media");
    return { ok: true, message: `Added ${name} to Photos`, devicePath: "Photos" };
  }
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
  if (!ctx.local) throw notSupported("Pulling files from a remote iOS simulator is not supported", "Run Tapdance on the Mac that runs the simulator.");
  const container = await appContainer(ctx, needApp(op.appId, "pull_file on iOS"));
  const source = resolve(container, op.relativePath ?? "");
  if (!source.startsWith(`${container}/`)) throw new TapdanceError("USAGE", "relative_path must stay inside the app's container (for example Documents/export.json)");
  await mkdir(dirname(op.outPath), { recursive: true });
  await copyFile(source, op.outPath);
  return { ok: true, message: `Pulled ${basename(source)}`, path: op.outPath };
}

async function appContainer(ctx: DeviceOperationContext, appId: string): Promise<string> {
  const r = await run(ctx, { tool: "simctl", args: ["get_app_container", appId, "data"] }, `find ${appId}'s container`);
  const path = r.stdout.trim().split("\n").pop() ?? "";
  if (!path.startsWith("/")) throw new TapdanceError("APP_NOT_INSTALLED", `${appId} has no data container on this simulator`);
  return resolve(path);
}
