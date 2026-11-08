import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import { TapdanceError, hostChecks, isPrivateHost, redactSecrets, saveCredentials, tapdanceHome, userConfigPath, writeConfigFile, type DoctorCheck, type TapdanceConfig } from "@tapdance/sdk";
import { releaseStaleDeviceClaims, type StaleClaimReport } from "@tapdance/provider-simlock";
import { agentDeviceBin, output, simlockBin, type GlobalOptions } from "./context.js";
import { bold, dim, renderChecks, yellow } from "./output.js";
import { readSecret } from "./commands-setup.js";
import { registerGuardCommands } from "./commands-guard.js";
import { describeWarm, linuxEmulatorSettings, warmSettings, withoutWarmSettings, type WarmCounts } from "./host/plan.js";
import { prepareLinuxUserServices, runCommand, useUserBus } from "./guard/service.js";
import { DEFAULT_WORKER_LOG_LINES, MAX_WORKER_LOG_LINES, parseSince, readDaemonLogs, selectDaemonLogLines } from "./host/daemon-log.js";
import {
  MISSING_SERVICE_FILE,
  checkWorkerService,
  installServiceOrReport,
  missingServiceWarning,
  parseMissingServiceRecord,
  precheckServiceRefresh,
  staleServiceLine,
  workerServiceFile,
  workerStartArgs,
  type MissingServiceRecord,
  type ServiceRefreshIo,
  type WorkerServiceCheck,
} from "./host/worker-service.js";

const exec = promisify(execFile);
/** The port Simlock runs its own adb server on (5037 is the developer's). */
const SIMLOCK_ADB_PORT = 5038;

/** Runs the bundled Simlock CLI. Its output is returned, never printed raw (it can contain secrets). */
async function simlock(args: string[], timeoutMs = 180_000): Promise<string> {
  // Simlock's daemon start/stop/install/uninstall run `systemctl --user`; over a non-interactive ssh
  // command (no XDG_RUNTIME_DIR) that needs the user manager's bus pointed at first (#118).
  if (osPlatform() === "linux") useUserBus(process.getuid?.() ?? 0);
  try {
    const { stdout, stderr } = await exec(process.execPath, [simlockBin(), ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    const text = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message;
    throw new TapdanceError("PROVIDER_UNAVAILABLE", `simlock ${args.filter((a) => !a.startsWith("{")).join(" ")} failed: ${text.split("\n").slice(-3).join(" ")}`);
  }
}

/**
 * Some installers (pnpm's store, zip extraction) drop the execute bit on Simlock's bundled capture
 * helpers, and the stream then fails with EACCES. Put it back before the daemon starts.
 */
async function ensureSimlockHelpersExecutable(out: ReturnType<typeof output>): Promise<void> {
  const binDir = join(dirname(simlockBin()), "..", "bin");
  if (!existsSync(binDir)) return;
  for (const name of await readdir(binDir)) {
    const file = join(binDir, name);
    const mode = (await stat(file)).mode;
    if ((mode & 0o111) === 0) {
      await chmod(file, mode | 0o755);
      out.progress(`Made ${name} executable`);
    }
  }
}

async function restart(gateway: boolean, out: ReturnType<typeof output>, options: { warnMissingService?: boolean } = {}): Promise<void> {
  const flag = gateway ? ["--gateway"] : ["--local"];
  out.progress(`Restarting the ${gateway ? "gateway" : "worker"} daemon`);
  // A login service written by an earlier Tapdance starts that one's Simlock: install it again (#110).
  // Check first that it can be installed here, before anything is stopped or removed (#118).
  const service = gateway ? undefined : await workerServiceCheck();
  if (service?.state === "stale") {
    out.progress(staleServiceLine(service));
    await precheckServiceRefresh(service, serviceRefreshIo(out));
  }
  await ensureSimlockHelpersExecutable(out);
  await simlock([...flag, "daemon", "stop"]).catch(() => "");
  // `daemon stop` returns while the old daemon is still draining; a start before it has gone loses
  // its connection (DAEMON_CONNECTION_LOST). Wait until status says stopped.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const status = await simlock([...flag, "daemon", "status"]).catch((e: Error) => e.message);
    if (/stopped|not running/i.test(status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  // "stopped" comes as soon as the HTTP side closes; the old daemon can need another minute to finish
  // (shutting emulators down) before it releases its socket. A start before that loses its connection.
  while (Date.now() < deadline && existsSync(join(gateway ? join(simlockHome(), "gateway") : simlockHome(), "daemon.sock"))) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!gateway) {
    await killStaleAdbServer(out);
    await syncAgentDeviceCommand(out);
  }
  const retried = async (args: string[]) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await simlock([...flag, ...args]);
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  };
  if (service?.state === "stale") {
    // On failure this starts the worker without the service, records it and throws with the fix.
    await installServiceOrReport(service, { ...serviceRefreshIo(out), install: () => retried(["daemon", "install"]) });
    await reconcileDevices(out, { resetIfDoctorFails: false });
    return;
  }
  await retried(["daemon", "start"]);
  if (!gateway) {
    await reconcileDevices(out);
    if (options.warnMissingService !== false) await warnIfServiceMissing(out, service);
  }
}

/** Where a failed service refresh is recorded (#118). */
function missingServicePath(): string {
  return join(tapdanceHome(), MISSING_SERVICE_FILE);
}

/** The effects of a login-service refresh (#118), for `installServiceOrReport` and its precheck. */
function serviceRefreshIo(out: Pick<ReturnType<typeof output>, "progress" | "warn">): ServiceRefreshIo {
  return {
    platform: osPlatform(),
    prepareUserServices: () => prepareLinuxUserServices(out),
    userManagerReachable: () => runCommand("systemctl", ["--user", "show-environment"]),
    install: () => simlock(["--local", "daemon", "install"]),
    start: () => simlock(["--local", "daemon", "start"]),
    serviceFileExists: async () => {
      const file = workerServiceFile({ platform: osPlatform(), home: homedir(), simlockHome: simlockHome(), env: process.env });
      return file !== undefined && existsSync(file.path);
    },
    recordMissing: async (record: MissingServiceRecord) => {
      await mkdir(tapdanceHome(), { recursive: true, mode: 0o700 });
      await writeFile(missingServicePath(), `${JSON.stringify({ ...record, reason: redactSecrets(record.reason) }, null, 2)}\n`, { mode: 0o600 });
    },
    clearMissing: () => rm(missingServicePath(), { force: true }),
  };
}

/**
 * Warns when the worker runs without the login service an earlier refresh failed to install (#118),
 * and forgets that record once a service is back. Returns the warning.
 */
export async function warnIfServiceMissing(out: Pick<ReturnType<typeof output>, "warn">, check?: WorkerServiceCheck): Promise<string | undefined> {
  const record = parseMissingServiceRecord(await readFile(missingServicePath(), "utf8").catch(() => undefined));
  if (record === undefined) return undefined;
  const now = check ?? (await workerServiceCheck());
  if (now.state !== "none") {
    await rm(missingServicePath(), { force: true }).catch(() => undefined);
    return undefined;
  }
  const warning = missingServiceWarning(record, now);
  if (warning) out.warn(warning);
  return warning;
}

/** Forgets a recorded missing service after a successful `daemon install` (#118). */
async function clearMissingService(): Promise<void> {
  await rm(missingServicePath(), { force: true }).catch(() => undefined);
}

/**
 * Devices stopped outside Simlock (a crash, a reboot, someone quitting an emulator) stay "ready" in its
 * records, and the next lease fails with "No Android device with serial …". Right after a start,
 * Simlock's `doctor --fix` marks such devices shut down (it never touches a leased one) and keeps
 * what the warm pool learned, so the learned spare boots again at once (#91). Only when the doctor
 * cannot run, and no lease is active, does `nuke` (without `--delete-devices`: it deletes nothing)
 * reset the records instead; that also forgets the learned spares.
 */
async function reconcileDevices(out: ReturnType<typeof output>, options: { resetIfDoctorFails?: boolean } = {}): Promise<void> {
  await cleanupClaims(out).catch(() => undefined);
  const fixed = await simlock(["--local", "doctor", "--fix"]).then(
    () => true,
    () => false,
  );
  if (fixed) {
    out.progress("Checked Simlock's device records against the running devices (warm spares it learned are kept)");
    return;
  }
  // After a service reinstall (#110) the records are kept as they are rather than reset, so the
  // learned spares survive; Simlock's own startup reconcile still runs.
  if (options.resetIfDoctorFails === false) return;
  const status = safeJson(await simlock(["--local", "status", "--json"]).catch(() => "{}")) as { leases?: unknown[] } | undefined;
  if (!status || (Array.isArray(status.leases) && status.leases.length > 0)) return;
  await simlock(["--local", "nuke", "--yes"]).then(() => out.progress("Reset Simlock's device records (no lease was active; the next lease teaches the warm pool again)"), () => undefined);
}

/** Releases device claims left by dead agent-device processes and reports what happened. */
async function cleanupClaims(out: ReturnType<typeof output>): Promise<StaleClaimReport> {
  const r = await releaseStaleDeviceClaims({ simlockHome: simlockHome() });
  if (r.released.length > 0) out.progress(`Released stale device claims: ${r.released.join(", ")}`);
  for (const k of r.retained) out.warn(`A stale claim on ${k.device} was kept (${k.reason})`);
  return r;
}

/**
 * Stops the worker for good: ends Simlock's leases, stops the daemon, shuts down the emulators and
 * simulators Simlock created (named simlock_* / simlock-*; never the developer's own), stops its adb
 * server, and optionally removes its login service. Simlock itself leaves its warm devices running
 * when it stops; killing them afterwards by hand leaves its records stale.
 */
export async function stopWorkerCompletely(out: ReturnType<typeof output>, options: { uninstallService: boolean }): Promise<{ stoppedDevices: string[]; serviceRemoved: boolean }> {
  const running = await workerRunning();
  if (running) {
    await simlock(["--local", "nuke", "--yes"]).catch(() => "");
    await simlock(["--local", "daemon", "stop"]).catch(() => "");
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && existsSync(join(simlockHome(), "daemon.sock"))) await new Promise((r) => setTimeout(r, 1000));
  }
  let serviceRemoved = false;
  if (options.uninstallService) {
    serviceRemoved = await simlock(["--local", "daemon", "uninstall"]).then(() => true, () => false);
  }
  const stoppedDevices: string[] = [];
  const sdk = process.env["ANDROID_HOME"] ?? process.env["ANDROID_SDK_ROOT"] ?? join(homedir(), osPlatform() === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
  const adb = existsSync(join(sdk, "platform-tools", "adb")) ? join(sdk, "platform-tools", "adb") : "adb";
  let port: number | undefined;
  try {
    const p = (JSON.parse(await readFile(join(simlockHome(), "adb-server.json"), "utf8")) as { port?: unknown }).port;
    if (typeof p === "number") port = p;
  } catch {
    // No Simlock adb server recorded.
  }
  for (const server of [...(port ? [String(port)] : []), "5037"]) {
    const list = await exec(adb, ["-P", server, "devices"], { timeout: 15_000 }).then((r) => r.stdout, () => "");
    for (const serial of [...list.matchAll(/^(emulator-\d+)\s+device/gm)].map((m) => m[1]!)) {
      const name = await exec(adb, ["-P", server, "-s", serial, "emu", "avd", "name"], { timeout: 10_000 }).then((r) => r.stdout.split("\n")[0]?.trim() ?? "", () => "");
      // Only Simlock's own emulators; a developer's AVD keeps running.
      if (!name.startsWith("simlock_")) continue;
      await exec(adb, ["-P", server, "-s", serial, "emu", "kill"], { timeout: 15_000 }).catch(() => undefined);
      stoppedDevices.push(`${serial} (${name})`);
    }
  }
  if (osPlatform() === "darwin") {
    for (const set of [[], ["--set", join(simlockHome(), "devices", "ios")]]) {
      const raw = await exec("xcrun", ["simctl", ...set, "list", "devices", "booted", "--json"], { timeout: 30_000 }).then((r) => r.stdout, () => "{}");
      const devices = Object.values((safeJson(raw) as { devices?: Record<string, Array<{ udid: string; name: string }>> } | undefined)?.devices ?? {}).flat();
      for (const d of devices.filter((x) => x.name.startsWith("simlock-"))) {
        await exec("xcrun", ["simctl", ...set, "shutdown", d.udid], { timeout: 60_000 }).catch(() => undefined);
        stoppedDevices.push(`${d.name} (${d.udid})`);
      }
    }
  }
  await killStaleAdbServer(out);
  return { stoppedDevices, serviceRemoved };
}

/**
 * Simlock runs its own adb server on a private port and records it in adb-server.json. If that server
 * outlives the daemon, the next start finds the port "occupied" and Android stays off. Stop it.
 */
async function killStaleAdbServer(out: ReturnType<typeof output>): Promise<void> {
  // A stopped worker removes adb-server.json, but a server can still sit on its port (one Simlock
  // left behind, or an `adb -P <port>` run by hand starting a new one). Simlock then refuses to
  // attach and skips Android altogether ("adb server unavailable … occupied").
  let port: unknown = SIMLOCK_ADB_PORT;
  try {
    port = (JSON.parse(await readFile(join(simlockHome(), "adb-server.json"), "utf8")) as { port?: unknown }).port;
  } catch {
    // No record: try Simlock's default port.
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port === 5037) return;
  const sdk = process.env["ANDROID_HOME"] ?? process.env["ANDROID_SDK_ROOT"] ?? join(homedir(), osPlatform() === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
  const adb = existsSync(join(sdk, "platform-tools", "adb")) ? join(sdk, "platform-tools", "adb") : "adb";
  await exec(adb, ["-P", String(port), "kill-server"], { timeout: 15_000 }).then(
    () => out.progress(`Stopped Simlock's leftover adb server on port ${port}`),
    () => undefined,
  );
}

/**
 * Switching Simlock's iOS device set while its own set still holds simulators leaves iOS disabled
 * (`device-set-changed`). Refuse up front and give Simlock's documented migration.
 */
async function checkDeviceSetSwitch(): Promise<void> {
  let current = "simlock";
  try {
    const config = JSON.parse(await readFile(join(simlockHome(), "config.json"), "utf8")) as { drivers?: { ios?: { deviceSet?: unknown } } };
    if (typeof config.drivers?.ios?.deviceSet === "string") current = config.drivers.ios.deviceSet;
  } catch {
    // No config yet: Simlock's default is its own set.
  }
  if (current === "default") return;
  const own = await readdir(join(simlockHome(), "devices", "ios")).catch(() => [] as string[]);
  if (own.filter((n) => !n.startsWith(".")).length === 0) return;
  throw new TapdanceError("USAGE", `Simlock still has ${own.length} simulator(s) in its own device set; switching to AXe now would turn iOS off`, {
    hint: [
      "Move them first (this ends every lease on this worker and deletes only Simlock's simulators, never yours):",
      "  tapdance simlock --local nuke --delete-devices",
      "  tapdance simlock --local doctor --purge-orphans",
      "then run `tapdance worker install --ios-backend axe` again. See docs/ios/simulator-management.md.",
    ].join("\n"),
  });
}

export async function readUserConfig(): Promise<Partial<TapdanceConfig>> {
  try {
    return JSON.parse(await readFile(userConfigPath(), "utf8")) as Partial<TapdanceConfig>;
  } catch {
    return {};
  }
}

function simlockHome(): string {
  return process.env["SIMLOCK_HOME"] ?? join(homedir(), ".simlock");
}

/** Whether the worker's login service starts this Tapdance's Simlock (#110). */
export async function workerServiceCheck(): Promise<WorkerServiceCheck> {
  return checkWorkerService(
    {
      platform: osPlatform(),
      home: homedir(),
      simlockHome: simlockHome(),
      env: process.env,
      wanted: { node: process.execPath, main: resolve(dirname(simlockBin()), "..", "daemon", "main.js") },
    },
    { readFile: (path) => readFile(path, "utf8"), exists: async (path) => existsSync(path) },
  ).catch((): WorkerServiceCheck => ({ state: "none" }));
}

/**
 * Starts a stopped worker daemon: `daemon start`, or `daemon install` when the login service is stale
 * (said on stderr, #110), checked first and reported when it fails (#118). Returns Simlock's output.
 */
async function startStoppedWorker(out: Pick<ReturnType<typeof output>, "progress" | "warn">): Promise<string> {
  const check = await workerServiceCheck();
  if (workerStartArgs(check)[1] !== "install") return simlock(["--local", "daemon", "start"]);
  out.progress(staleServiceLine(check));
  const io = serviceRefreshIo(out);
  await precheckServiceRefresh(check, io);
  let text = "";
  await installServiceOrReport(check, {
    ...io,
    install: async () => {
      text = await simlock(["--local", "daemon", "install"]);
    },
  });
  return text;
}

/** Restarts the local worker daemon (installing a stale login service again, #110). */
export async function restartWorker(out: ReturnType<typeof output>): Promise<void> {
  await restart(false, out);
}

function checkGatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TapdanceError("USAGE", `"${raw}" is not a URL`, { hint: "Use wss://gateway.example.com (or ws://100.x.y.z:4700 on a private network)." });
  }
  if (url.protocol === "https:" || url.protocol === "http:") url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new TapdanceError("USAGE", "The gateway URL must start with wss:// (or ws:// on a private network)");
  if (url.protocol === "ws:" && !isPrivateHost(url.hostname)) {
    throw new TapdanceError("USAGE", `Refusing ws:// to public host ${url.hostname}: the join token would travel in plain text`, {
      hint: "Put TLS in front of the gateway and use wss://, or join over a private network such as Tailscale.",
    });
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * `worker install`: points the bundled Simlock at the bundled agent-device, sets streaming and input,
 * restarts the worker and (with `service`) installs Simlock's login service. `host up` runs it too.
 */
export async function installWorker(
  o: { stream: boolean; iosBackend: string; service?: boolean; checks?: DoctorCheck[]; warm?: WarmCounts },
  out: ReturnType<typeof output>,
): Promise<{ settings: string[]; checks: DoctorCheck[]; status: unknown }> {
  if (osPlatform() === "win32") {
    throw new TapdanceError("NOT_SUPPORTED", "Windows cannot run a Tapdance worker yet: Simlock supports macOS and Linux only", {
      hint: "Use Windows as a control machine (CLI/MCP), or run the worker on a Mac, a Linux box, or a Linux VM with nested virtualization.",
    });
  }
  let checks = o.checks;
  if (checks === undefined) {
    out.progress("Checking this machine");
    checks = await hostChecks({ platforms: { android: true, ios: osPlatform() === "darwin" } });
  }
  const kvmFail = checks.filter((c) => c.id.startsWith("host.kvm") && c.status === "fail");
  if (kvmFail.length > 0) {
    out.warn("Hardware acceleration is not available; Android emulators will not be provisioned here (no software fallback).");
  }
  if (!["agent-device", "axe"].includes(o.iosBackend)) throw new TapdanceError("USAGE", "--ios-backend must be agent-device or axe");
  const settings: Array<[string, string]> = [
    ["capabilities.agent-device.enabled", "true"],
    ["capabilities.agent-device.command", agentDeviceBin()],
    ["capabilities.stream.enabled", o.stream ? "true" : "false"],
    ["capabilities.input.enabled", o.stream ? "true" : "false"],
    ...linuxEmulatorSettings(osPlatform(), process.env),
  ];
  if (o.iosBackend === "axe") {
    // AXe only sees Xcode's default device set (it hardcodes deviceSetPath nil).
    await checkDeviceSetSwitch();
    settings.push(["drivers.ios.deviceSet", "default"]);
    await writeConfigFile(userConfigPath(), { ...(await readUserConfig()), ios: { uiBackend: "axe" } });
  }
  for (const [key, value] of settings) {
    out.progress(`simlock config set ${key} ${key.endsWith("command") ? dim(value) : value}`);
    await simlock(["--local", "config", "set", key, value]);
  }
  // With --service a missing login service is installed below: no warning about it first.
  await restart(false, out, { warnMissingService: !o.service });
  if (o.warm) await applyWarm(out, o.warm);
  if (o.service) {
    if (osPlatform() === "linux") await prepareLinuxUserServices(out);
    // The restart above already installed a stale service again (#110); a second `daemon install`
    // would stop and start the worker once more for nothing.
    if ((await workerServiceInstalled()) && (await workerServiceCheck()).state === "current") {
      out.progress("The login service is installed and starts this Tapdance's Simlock; left as is");
      await clearMissingService();
    } else {
      out.progress("Installing the login service");
      await simlock(["--local", "daemon", "install"]);
      await clearMissingService();
      await reconcileDevices(out, { resetIfDoctorFails: false });
    }
  }
  const status = await simlock(["--local", "status", "--json"]).catch(() => "{}");
  return { settings: settings.map(([k]) => k), checks, status: safeJson(status) };
}

/** The local worker daemon's own status, or undefined when it does not answer. */
/** Applies a warm-spare count per platform to the local worker, restarting it when anything changed. */
/**
 * Saves the warm-spare counts in Simlock's config. Simlock reads them at start, so the worker restarts
 * (`restart`, default "always"); "if-idle" skips that while a lease runs, since a restart ends leases.
 */
export async function applyWarm(
  out: ReturnType<typeof output>,
  warm: WarmCounts,
  options: { restart?: "always" | "if-idle" | "never" } = {},
): Promise<{ settings: Array<[string, string]>; restarted: boolean; activeLeases: number }> {
  const status = (await localWorkerStatus()) as { capacity?: Record<string, { limit?: number } | undefined>; leases?: unknown[] } | undefined;
  const limits = { android: status?.capacity?.["android"]?.limit ?? 2, ios: status?.capacity?.["ios"]?.limit ?? 5 };
  const settings = warmSettings(warm, limits);
  for (const [key, value] of settings) {
    out.progress(`simlock config set ${key} ${value}`);
    await simlock(["--local", "config", "set", key, value]);
  }
  const activeLeases = Array.isArray(status?.leases) ? status.leases.length : 0;
  const when = options.restart ?? "always";
  if (when === "never" || (when === "if-idle" && activeLeases > 0)) return { settings, restarted: false, activeLeases };
  await restart(false, out);
  return { settings, restarted: true, activeLeases };
}

/**
 * Removes the warm-pool keys `applyWarm` wrote from Simlock's config, so Simlock's default (one
 * learned spare per device kind used) applies again (#91). Simlock has no `config unset`; the file is
 * rewritten the way Simlock writes it (owner-only, atomic rename). Restarts like `applyWarm`.
 */
export async function resetWarm(
  out: ReturnType<typeof output>,
  options: { restart?: "always" | "if-idle" | "never" } = {},
): Promise<{ removed: string[]; restarted: boolean; activeLeases: number }> {
  const file = join(simlockHome(), "config.json");
  const current = existsSync(file) ? (safeJson(await readFile(file, "utf8")) as Record<string, unknown> | undefined) : {};
  if (current === undefined) throw new TapdanceError("USAGE", `${file} is not valid JSON; fix it by hand, then run this again`);
  const { config, removed } = withoutWarmSettings(current);
  if (removed.length > 0) {
    out.progress(`Removing ${removed.join(", ")} from ${file}`);
    const temp = `${file}.tapdance-${process.pid}`;
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  }
  const status = (await localWorkerStatus()) as { leases?: unknown[] } | undefined;
  const activeLeases = Array.isArray(status?.leases) ? status.leases.length : 0;
  const when = options.restart ?? "always";
  if (removed.length === 0 || when === "never" || (when === "if-idle" && activeLeases > 0)) return { removed, restarted: false, activeLeases };
  await restart(false, out);
  return { removed, restarted: true, activeLeases };
}

/** The warm-spare setting and the spares the worker keeps now, in words (#91). */
export async function warmReport(): Promise<{ text: string; config?: Record<string, unknown>; warmPool?: unknown }> {
  const file = join(simlockHome(), "config.json");
  const config = existsSync(file) ? (safeJson(await readFile(file, "utf8").catch(() => "")) as Record<string, unknown> | undefined) : undefined;
  const status = (await localWorkerStatus()) as { warmPool?: Parameters<typeof describeWarm>[1] } | undefined;
  const pool = status ? (status.warmPool ?? { targets: [] }) : undefined;
  const warmConfig = config?.["warmPool"] as Record<string, unknown> | undefined;
  return { text: describeWarm(config, pool), ...(warmConfig ? { config: warmConfig } : {}), ...(pool ? { warmPool: pool } : {}) };
}

/** Ends every lease on the local worker (Simlock's nuke without --delete-devices: deletes nothing). */
export async function simlockNuke(): Promise<void> {
  await simlock(["--local", "nuke", "--yes"]).catch(() => "");
}

/** Whether the local Simlock daemon runs (its socket file can outlive a crash, so ask it). */
export async function workerRunning(): Promise<boolean> {
  return /running/i.test(await simlock(["--local", "daemon", "status"], 20_000).catch(() => "stopped"));
}

/** Simlock's own login service: `daemon install` adds it (and starts the daemon), `uninstall` removes it. */
export async function workerServiceInstalled(): Promise<boolean> {
  return /Service: installed/i.test(await simlock(["--local", "daemon", "status"], 20_000).catch(() => ""));
}

export async function setWorkerService(on: boolean, out?: Pick<ReturnType<typeof output>, "progress" | "warn">): Promise<void> {
  // Installing needs the user manager on Linux; check it (with its fix) before Simlock tries (#118).
  if (on && out && osPlatform() === "linux") await prepareLinuxUserServices(out);
  await simlock(["--local", "daemon", on ? "install" : "uninstall"]);
  if (on) await clearMissingService();
}

/** Starts the worker after a pause and resets stale device records when nothing is leased. */
/**
 * Points Simlock at the agent-device this Tapdance ships. `worker install` stores its absolute path,
 * and a `pnpm install` that changes it (a version or a patch: the folder name changes) left the
 * worker running the old copy, e.g. without the landscape tap fix (#56).
 */
export async function syncAgentDeviceCommand(
  out: Pick<ReturnType<typeof output>, "progress">,
  home: string = simlockHome(),
  set: (path: string) => Promise<unknown> = (path) => simlock(["--local", "config", "set", "capabilities.agent-device.command", path]),
): Promise<boolean> {
  let current: unknown;
  try {
    current = (JSON.parse(await readFile(join(home, "config.json"), "utf8")) as { capabilities?: Record<string, { command?: unknown }> }).capabilities?.["agent-device"]?.command;
  } catch {
    return false;
  }
  const wanted = agentDeviceBin();
  if (typeof current !== "string" || current === wanted) return false;
  await set(wanted);
  out.progress(`Pointed the worker at this Tapdance's agent-device (${wanted.split("/node_modules/.pnpm/")[1]?.split("/")[0] ?? wanted})`);
  return true;
}

export async function startWorker(out: ReturnType<typeof output>): Promise<void> {
  await ensureSimlockHelpersExecutable(out);
  if (!(await workerRunning())) {
    await killStaleAdbServer(out);
    await syncAgentDeviceCommand(out);
    // A failed start is seen below as a worker that does not run; a failed service refresh says
    // itself what is missing and how to fix it (#118).
    await startStoppedWorker(out).catch((error: unknown) => {
      if (error instanceof TapdanceError && error.code === "HOST_CHECK_FAILED") throw error;
      return "";
    });
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !(await workerRunning())) await new Promise((r) => setTimeout(r, 1000));
  await reconcileDevices(out);
  await warnIfServiceMissing(out);
}

export async function localWorkerStatus(): Promise<unknown> {
  return simlock(["--local", "status", "--json"], 20_000).then(safeJson, () => undefined);
}

export function registerWorkerCommands(program: Command, globals: () => GlobalOptions): void {
  const worker = program.command("worker").description("Run this machine as a device worker (your laptop, a Mac, a KVM server)");

  registerGuardCommands(worker, globals);

  worker
    .command("check")
    .description("Check this machine can run emulators/simulators: SDKs, images, KVM, Xcode")
    .option("--android-only", "skip iOS checks")
    .action(async (o: { androidOnly?: boolean }) => {
      const out = output(globals());
      try {
        const checks = await hostChecks({ platforms: { android: true, ios: !o.androidOnly } });
        out.result({ checks }, () => renderChecks(checks));
        if (checks.some((c) => c.status === "fail" && c.id.startsWith("host.kvm"))) process.exitCode = 10;
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  worker
    .command("install")
    .description("Configure the bundled Simlock worker: agent-device, live streaming and input on; then start it")
    .option("--no-stream", "leave screen streaming and input off")
    .option("--ios-backend <backend>", "agent-device (default; works through gateways) or axe (Tapdance on this Mac only)", "agent-device")
    .option("--service", "also install it as a login service (launchd / systemd --user)")
    .action(async (o: { stream: boolean; iosBackend: string; service?: boolean }) => {
      const out = output(globals());
      try {
        const { settings, checks, status } = await installWorker(o, out);
        out.result({ configured: settings, checks, status }, () =>
          [renderChecks(checks), "", bold("Worker is running."), dim("This machine now serves devices to agents on it (provider: local)."), "To serve a remote agent from a personal Mac, use device-only mode: tapdance worker guard start (see docs/security/device-only-mode.md).", "On a dedicated worker machine: tapdance worker login --accept-gateway-exec --gateway wss://<gateway> --label <name>"].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  worker
    .command("login")
    .description("Join a gateway: the worker dials out over an authenticated WebSocket; no inbound port is opened")
    .requiredOption("--gateway <url>", "gateway address, e.g. wss://gateway.example.com")
    .option("--label <name>", "name shown in `tapdance workers list`")
    .option("--token-stdin", "read the join token from stdin (default when stdin is piped)")
    .option("--no-viewer", "leave live streaming and remote input off")
    .option("--accept-gateway-exec", "acknowledge that a joined gateway (and its agent tokens) can run programs on this machine")
    .action(async (o: { gateway: string; label?: string; viewer: boolean; acceptGatewayExec?: boolean }) => {
      const out = output(globals());
      try {
        if (!o.acceptGatewayExec) {
          throw new TapdanceError("FORBIDDEN", "Joining a gateway gives it, and every agent token it issues, command execution on this machine (Simlock's exec: `simctl spawn` starts any program)", {
            hint: "On a personal Mac use device-only mode instead: `tapdance worker guard start` (see docs/security/device-only-mode.md). For a dedicated worker machine, re-run with --accept-gateway-exec.",
          });
        }
        const url = checkGatewayUrl(o.gateway);
        const token = process.env["TAPDANCE_WORKER_TOKEN"] ?? (await readSecret("Worker join token (from `tapdance gateway token --role worker`):"));
        if (!token) throw new TapdanceError("USAGE", "No join token given");
        const value = JSON.stringify({ url, token, ...(o.label ? { label: o.label } : {}) });
        out.progress(`Joining ${url}`);
        await simlock(["--local", "config", "set", "http.enabled", "false"]);
        for (const cap of ["agent-device", ...(o.viewer ? ["stream", "input"] : [])]) {
          await simlock(["--local", "config", "set", `capabilities.${cap}.enabled`, "true"]);
        }
        await simlock(["--local", "config", "set", "capabilities.agent-device.command", agentDeviceBin()]);
        await simlock(["--local", "config", "set", "gateway", value]);
        await restart(false, out);
        out.result({ joined: url, label: o.label ?? null, viewer: o.viewer }, () =>
          [
            `Joined ${url}${o.label ? ` as "${o.label}"` : ""}.`,
            "The gateway now has operator rights on this machine's devices; agents with gateway tokens can run commands here as this user.",
            "The worker reconnects on its own (1 s, doubling to 30 s) after network drops.",
            "On the gateway machine check it with: tapdance workers list",
            yellow("While joined, this machine's own HTTP API is off: agents on this machine must use the gateway too"),
            yellow(`(tapdance init --mode self-hosted --endpoint ${url.replace(/^ws/, "http")}).`),
            process.platform === "darwin" ? "Keep it awake while agents work: caffeinate -is (a closed lid or sleep takes the worker offline)." : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  worker
    .command("logout")
    .description("Leave the gateway and serve local agents only")
    .action(async () => {
      const out = output(globals());
      try {
        const file = join(simlockHome(), "config.json");
        if (existsSync(file)) {
          const data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
          delete data["gateway"];
          if (typeof data["http"] === "object" && data["http"] !== null) (data["http"] as Record<string, unknown>)["enabled"] = true;
          await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        }
        await restart(false, out);
        out.result({ left: true }, () => "Left the gateway. Revoke this worker's join token on the gateway: `tapdance simlock -- --gateway token list`, then `tapdance simlock -- --gateway token revoke <id>`.");
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  for (const [name, args, help] of [
    ["start", ["daemon", "start"], "Start the worker daemon"],
    ["stop", ["daemon", "stop"], "Stop the worker: end its leases, stop the daemon and shut down the emulators and simulators it created"],
    ["status", ["status"], "Show the worker's devices, leases and capabilities"],
  ] as const) {
    worker
      .command(name)
      .description(help)
      .action(async () => {
        const out = output(globals());
        try {
          if (name === "stop") {
            const r = await stopWorkerCompletely(out, { uninstallService: false });
            out.result({ stopped: true, ...r }, () => `Stopped the worker${r.stoppedDevices.length ? ` and ${r.stoppedDevices.length} device(s): ${r.stoppedDevices.join(", ")}` : ""}.`);
            return;
          }
          let text: string;
          if (name === "start") {
            await ensureSimlockHelpersExecutable(out);
            if (!(await workerRunning())) {
              await killStaleAdbServer(out);
              text = await startStoppedWorker(out);
            } else text = await simlock(["--local", ...args]);
            await reconcileDevices(out);
            await warnIfServiceMissing(out);
          } else text = await simlock(["--local", ...args, ...(name === "status" && globals().json ? ["--json"] : [])]);
          out.result(safeJson(text) ?? { output: text }, () => text);
        } catch (error) {
          process.exitCode = out.error(error);
        }
      });
  }
  worker
    .command("logs")
    .description(`Print the worker daemon log (the last ${DEFAULT_WORKER_LOG_LINES} lines unless -n says otherwise), optionally filtered`)
    .option("-n, --lines <n>", `how many lines (at most ${MAX_WORKER_LOG_LINES}); with a filter, how many matching lines`, String(DEFAULT_WORKER_LOG_LINES))
    .option("--contains <text>", 'only lines containing this text (case-insensitive), e.g. "clean baseline"')
    .option("--since <when>", "only lines from the last 30s, 10m, 2h or 1d, or since an ISO time such as 2026-11-04T21:54:00Z")
    .action(async (o: { lines: string; contains?: string; since?: string }) => {
      const out = output(globals());
      try {
        if (!/^\d{1,5}$/.test(o.lines) || Number(o.lines) < 1 || Number(o.lines) > MAX_WORKER_LOG_LINES) throw new TapdanceError("USAGE", `--lines must be a whole number from 1 to ${MAX_WORKER_LOG_LINES}`);
        if (o.contains !== undefined && (o.contains.length < 1 || o.contains.length > 200)) throw new TapdanceError("USAGE", "--contains takes 1 to 200 characters");
        const sinceMs = o.since === undefined ? undefined : parseSince(o.since, Date.now());
        const { files, path } = await readDaemonLogs(simlockHome());
        const lines = selectDaemonLogLines(files, { lines: Number(o.lines), ...(o.contains !== undefined ? { contains: o.contains } : {}), ...(sinceMs !== undefined ? { sinceMs } : {}) });
        const empty = files.every((f) => f.trim() === "");
        out.result({ path, lines }, () =>
          empty ? dim(`No worker log yet (${path}); the worker has not run on this machine.`) : lines.length === 0 ? dim(`no matching lines in ${path}`) : lines.join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
  worker
    .command("cleanup")
    .description("Release device claims left by agent-device processes that have gone (a worker restart, the machine going offline mid-lease); live owners are never touched")
    .action(async () => {
      const out = output(globals());
      try {
        const r = await cleanupClaims(out);
        out.result(r, () =>
          r.released.length === 0 && r.retained.length === 0
            ? "No stale device claims."
            : `Released ${r.released.length} stale claim(s)${r.abandonedRecordings.length ? `, set aside ${r.abandonedRecordings.length} unfinished recording(s) of dead sessions` : ""}${r.retained.length ? `; kept ${r.retained.length}` : ""}.`,
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
  worker
    .command("restart")
    .description("Restart the worker daemon (ends agent-device sessions on it; a login service left from an older Tapdance is installed again); refuses while leases run unless --force")
    .option("--force", "restart even while devices are leased (their agents lose them)")
    .action(async (o: { force?: boolean }) => {
      const out = output(globals());
      try {
        // A restart drops agent-device's tie between a lease and its device while the lease record
        // lives on, so a running agent's every command is refused afterwards (self-test C1).
        const running = (safeJson(await simlock(["--local", "status", "--json"]).catch(() => "{}")) as { leases?: Array<{ id?: string }> } | undefined)?.leases ?? [];
        if (running.length > 0 && !o.force) {
          throw new TapdanceError("DEVICE_UNAVAILABLE", `${running.length} lease(s) are running on this worker (${running.map((l) => String(l.id ?? "?").slice(0, 12)).join(", ")}); a restart takes their devices away from the agents using them`, {
            hint: "Wait until they are released (tapdance worker status), or pass --force.",
          });
        }
        await restart(false, out);
        out.result({ restarted: true }, () => "Restarted");
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  // ------------------------------------------------------------------ escape hatch
  program
    .command("simlock")
    .description("Run the Simlock CLI bundled with Tapdance (for operators; agents should not need it)")
    .allowUnknownOption()
    .argument("[args...]")
    .action(async (args: string[]) => {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync(process.execPath, [simlockBin(), ...args], { stdio: "inherit" });
      process.exitCode = r.status ?? 1;
    });

  // ------------------------------------------------------------------ gateway
  const gateway = program.command("gateway").description("Run a gateway on this machine (an ordinary VPS is fine: it needs no KVM)");

  gateway
    .command("setup")
    .description("Start a Simlock gateway, enable agent-device + streaming, mint tokens, and point this machine's Tapdance at it")
    .option("--worker-label <name>", "label for the first worker's join token", "worker-1")
    .option("--agent-label <name>", "label for this machine's agent token", "tapdance-agent")
    .option("--public-url <url>", "the https:// address workers and remote agents will use (after you add TLS)")
    .option("--no-configure-here", "do not write ~/.tapdance config/credentials for this machine")
    .action(async (o: { workerLabel: string; agentLabel: string; publicUrl?: string; configureHere: boolean }) => {
      const out = output(globals());
      try {
        out.progress("Starting the gateway daemon");
        await simlock(["--gateway", "daemon", "start"]);
        for (const cap of ["agent-device", "stream", "input"]) {
          await simlock(["--gateway", "config", "set", `capabilities.${cap}.enabled`, "true"]);
        }
        await restart(true, out);
        const mint = async (role: string, label: string) => {
          const text = await simlock(["--gateway", "token", "create", "--role", role, "--label", label]);
          const parsed = safeJson(text) as { secret?: string; token?: { id?: string } } | undefined;
          if (!parsed?.secret) throw new TapdanceError("PROVIDER_UNAVAILABLE", `Could not create a ${role} token`);
          return { secret: parsed.secret, id: parsed.token?.id ?? "?" };
        };
        const workerToken = await mint("worker", o.workerLabel);
        const agentToken = await mint("agent", o.agentLabel);
        const operatorToken = await mint("operator", `${o.agentLabel}-operator`);
        if (o.configureHere) {
          await saveCredentials({ token: agentToken.secret, operatorToken: operatorToken.secret });
          await writeConfigFile(userConfigPath(), { provider: "self-hosted", endpoint: "http://127.0.0.1:4700" });
        }
        const publicWs = o.publicUrl ? o.publicUrl.replace(/^http/, "ws") : "wss://<your-gateway-host>";
        // The worker join secret is printed once, to stdout, for the person setting up the worker.
        out.secretResult(
          { gateway: "http://127.0.0.1:4700", workerJoinToken: workerToken.secret, workerTokenId: workerToken.id, agentTokenId: agentToken.id, configuredHere: o.configureHere },
          () =>
            [
              bold("Gateway running on 127.0.0.1:4700 (not reachable from other machines yet)."),
              o.configureHere ? `This machine's Tapdance now uses it (agent + operator tokens saved to ~/.tapdance/credentials.json).` : "",
              "",
              bold("1. Make it reachable over TLS or a private network (pick one):"),
              "   • Caddy:     gateway.example.com { reverse_proxy 127.0.0.1:4700 { flush_interval -1 } }",
              "   • Tailscale: tailscale serve --bg --https=443 http://127.0.0.1:4700",
              "",
              bold("2. On the worker machine (laptop, Mac, KVM server):"),
              "   install Tapdance from source (docs/installation.md), then: tapdance worker install",
              `   echo '<join token>' | tapdance worker login --gateway ${publicWs} --label ${o.workerLabel} --accept-gateway-exec`,
              "   (a joined worker gives this gateway command execution on it; for a personal Mac prefer device-only mode: docs/security/device-only-mode.md)",
              "",
              bold("Worker join token (shown once; give it only to that worker):"),
              `   ${workerToken.secret}`,
              "",
              "3. Check: tapdance workers list && tapdance devices",
            ]
              .filter((l) => l !== "")
              .join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  gateway
    .command("token")
    .description("Mint a token on this machine's gateway (printed once)")
    .requiredOption("--role <role>", "worker (to join a worker), agent (one per agent), or operator")
    .requiredOption("--label <name>", "who it is for")
    .action(async (o: { role: string; label: string }) => {
      const out = output(globals());
      try {
        if (!["worker", "agent", "operator"].includes(o.role)) throw new TapdanceError("USAGE", "--role must be worker, agent or operator");
        const text = await simlock(["--gateway", "token", "create", "--role", o.role, "--label", o.label]);
        const parsed = safeJson(text) as { secret?: string; token?: unknown } | undefined;
        // This one command exists to hand a secret to a person, so it prints it.
        process.stdout.write(`${globals().json ? JSON.stringify(parsed, null, 2) : `${parsed?.secret}\n${dim("Shown once. Revoke with: tapdance simlock -- --gateway token revoke <id>")}`}\n`);
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  gateway
    .command("status")
    .description("Show the gateway's workers, devices and queue")
    .action(async () => {
      const out = output(globals());
      try {
        const workers = await simlock(["--gateway", "worker", "list"]);
        out.result({ workers: workers.split("\n") }, () => workers);
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
}

function safeJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
}

export type { DoctorCheck };
