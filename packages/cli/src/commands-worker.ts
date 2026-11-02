import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import { TapdanceError, hostChecks, isPrivateHost, saveCredentials, userConfigPath, writeConfigFile, type DoctorCheck, type TapdanceConfig } from "@tapdance/sdk";
import { releaseStaleDeviceClaims, type StaleClaimReport } from "@tapdance/provider-simlock";
import { agentDeviceBin, output, simlockBin, type GlobalOptions } from "./context.js";
import { bold, dim, renderChecks, yellow } from "./output.js";
import { readSecret } from "./commands-setup.js";
import { registerGuardCommands } from "./commands-guard.js";
import { warmSettings, type WarmCounts } from "./host/plan.js";

const exec = promisify(execFile);
/** The port Simlock runs its own adb server on (5037 is the developer's). */
const SIMLOCK_ADB_PORT = 5038;

/** Runs the bundled Simlock CLI. Its output is returned, never printed raw (it can contain secrets). */
async function simlock(args: string[], timeoutMs = 180_000): Promise<string> {
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

async function restart(gateway: boolean, out: ReturnType<typeof output>): Promise<void> {
  const flag = gateway ? ["--gateway"] : ["--local"];
  out.progress(`Restarting the ${gateway ? "gateway" : "worker"} daemon`);
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
  for (let attempt = 1; ; attempt++) {
    try {
      await simlock([...flag, "daemon", "start"]);
      if (!gateway) await reconcileDevices(out);
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/**
 * Devices stopped outside Simlock (a crash, a reboot, someone quitting an emulator) stay "ready" in its
 * records, and the next lease fails with "No Android device with serial …". Right after a start, when
 * no lease is active (nothing to lose), Simlock's `nuke` without `--delete-devices` resets its device
 * state; it deletes nothing.
 */
async function reconcileDevices(out: ReturnType<typeof output>): Promise<void> {
  await cleanupClaims(out).catch(() => undefined);
  const status = safeJson(await simlock(["--local", "status", "--json"]).catch(() => "{}")) as { leases?: unknown[] } | undefined;
  if (!status || (Array.isArray(status.leases) && status.leases.length > 0)) return;
  await simlock(["--local", "nuke", "--yes"]).then(() => out.progress("Reset Simlock's device records (no lease was active)"), () => undefined);
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
  await restart(false, out);
  if (o.warm) await applyWarm(out, o.warm);
  if (o.service) {
    out.progress("Installing the login service");
    await simlock(["--local", "daemon", "install"]);
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

export async function setWorkerService(on: boolean): Promise<void> {
  await simlock(["--local", "daemon", on ? "install" : "uninstall"]);
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
    await simlock(["--local", "daemon", "start"]).catch(() => "");
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !(await workerRunning())) await new Promise((r) => setTimeout(r, 1000));
  await reconcileDevices(out);
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
          [renderChecks(checks), "", bold("Worker is running."), dim("This machine now serves devices to agents on it (provider: local)."), "To serve a remote agent from a personal Mac, use device-only mode: tapdance worker guard start (see docs/security/personal-mac.md).", "On a dedicated worker machine: tapdance worker login --accept-gateway-exec --gateway wss://<gateway> --label <name>"].join("\n"),
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
            hint: "On a personal Mac use device-only mode instead: `tapdance worker guard start` (see docs/security/personal-mac.md). For a dedicated worker machine, re-run with --accept-gateway-exec.",
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
    ["logs", ["daemon", "logs"], "Print the worker daemon log"],
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
          if (name === "start") {
            await ensureSimlockHelpersExecutable(out);
            if (!(await workerRunning())) await killStaleAdbServer(out);
          }
          const text = await simlock(["--local", ...args, ...(name === "status" && globals().json ? ["--json"] : [])]);
          if (name === "start") await reconcileDevices(out);
          out.result(safeJson(text) ?? { output: text }, () => text);
        } catch (error) {
          process.exitCode = out.error(error);
        }
      });
  }
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
    .description("Restart the worker daemon (ends agent-device sessions on it)")
    .action(async () => {
      const out = output(globals());
      try {
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
              "   (a joined worker gives this gateway command execution on it; for a personal Mac prefer device-only mode: docs/security/personal-mac.md)",
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
