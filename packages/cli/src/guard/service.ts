import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { TapdanceError, redactSecrets } from "@tapdance/sdk";
import { parseLinger } from "../host/plan.js";

/**
 * Keeps the worker guard running as a login service of the worker account: a LaunchAgent on macOS,
 * a systemd user unit on Linux (H-03: an unprivileged LaunchAgent, never root). The unit and plist
 * text come from pure functions; launchctl and systemctl run only through a `CommandRunner`, so tests
 * can stub them.
 */

export const GUARD_LAUNCHD_LABEL = "dev.tapdance.guard";
export const GUARD_SYSTEMD_UNIT = "tapdance-guard.service";

export type ServicePlatform = "darwin" | "linux";

export interface GuardServiceSpec {
  platform: ServicePlatform;
  /** The Node.js binary that runs the CLI (the installer's `process.execPath`). */
  node: string;
  /** Absolute path of the CLI's `main.js`. */
  cli: string;
  /** Flags passed on to `worker guard start`, e.g. `--allow-admin-account`. */
  startFlags: string[];
  /** macOS: run the guard under `caffeinate -i`, so idle sleep does not take it offline. */
  keepAwake: boolean;
  environment: Record<string, string>;
  home: string;
}

/**
 * The service file and its log. On Linux the log is a file next to the guard's other files
 * (`<TAPDANCE_HOME>/worker/guard.log`), not only the user journal: on some VMs (Google Cloud OS Login
 * accounts) the user journal is not kept or not readable, and `journalctl --user` shows nothing (#95).
 */
export function guardServicePaths(platform: ServicePlatform, home: string, tapdanceHome?: string): { file: string; log: string } {
  return platform === "darwin"
    ? { file: join(home, "Library", "LaunchAgents", `${GUARD_LAUNCHD_LABEL}.plist`), log: join(home, "Library", "Logs", "tapdance-guard.log") }
    : { file: join(home, ".config", "systemd", "user", GUARD_SYSTEMD_UNIT), log: join(tapdanceHome ?? join(home, ".tapdance"), "worker", "guard.log") };
}

/** A log this large is moved to `<log>.1` (replacing an older one) when the service is installed. */
export const GUARD_LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/**
 * The service's environment: a fixed PATH (launchd and systemd start with an almost empty one) with
 * the Android SDK tools and this Node.js first, plus ANDROID_HOME, TAPDANCE_HOME and SIMLOCK_HOME when
 * known. Nothing else is copied: tokens and TAPDANCE_GUARD_PAIR_NONINTERACTIVE never reach a service.
 */
export function guardServiceEnvironment(env: NodeJS.ProcessEnv, node: string, androidSdk?: string): Record<string, string> {
  const sdk = androidSdk ?? env["ANDROID_HOME"] ?? env["ANDROID_SDK_ROOT"];
  const java = env["JAVA_HOME"];
  const path = [
    ...(sdk ? [join(sdk, "platform-tools"), join(sdk, "emulator"), join(sdk, "cmdline-tools", "latest", "bin")] : []),
    dirname(node),
    // Builds (`allow.builds`) run git, gh, xcodebuild and Gradle: the usual install places for them.
    ...(java ? [join(java, "bin")] : []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return {
    PATH: [...new Set(path)].join(":"),
    ...(sdk ? { ANDROID_HOME: sdk } : {}),
    ...(java ? { JAVA_HOME: java } : {}),
    ...(env["TAPDANCE_HOME"] ? { TAPDANCE_HOME: env["TAPDANCE_HOME"] } : {}),
    ...(env["SIMLOCK_HOME"] ? { SIMLOCK_HOME: env["SIMLOCK_HOME"] } : {}),
  };
}

export function guardProgramArguments(spec: GuardServiceSpec): string[] {
  const start = [spec.node, spec.cli, "worker", "guard", "start", ...spec.startFlags];
  return spec.platform === "darwin" && spec.keepAwake ? ["/usr/bin/caffeinate", "-i", ...start] : start;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function launchAgentPlist(spec: GuardServiceSpec): string {
  const { log } = guardServicePaths("darwin", spec.home);
  const args = guardProgramArguments(spec).map((a) => `    <string>${xml(a)}</string>`);
  const env = Object.entries(spec.environment).flatMap(([k, v]) => [`    <key>${xml(k)}</key>`, `    <string>${xml(v)}</string>`]);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${GUARD_LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...args,
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...env,
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xml(spec.home)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>10</integer>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(log!)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(log!)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** systemd unit-file quoting: `%` starts a specifier and `$` a variable, so both are doubled. */
function systemdEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
}

function systemdArg(s: string): string {
  const escaped = systemdEscape(s).replace(/\$/g, "$$$$");
  return s === "" || /[\s"'\\]/.test(s) ? `"${escaped}"` : escaped;
}

export function systemdUnit(spec: GuardServiceSpec): string {
  const { log } = guardServicePaths("linux", spec.home, spec.environment["TAPDANCE_HOME"]);
  return [
    "[Unit]",
    "Description=Tapdance worker guard (device-only API for remote agents)",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${guardProgramArguments(spec).map(systemdArg).join(" ")}`,
    ...Object.entries(spec.environment).map(([k, v]) => `Environment="${systemdEscape(`${k}=${v}`)}"`),
    "WorkingDirectory=%h",
    // Also to a file: the user journal may not be kept for this account (journalctl --user shows nothing).
    `StandardOutput=append:${systemdEscape(log)}`,
    `StandardError=append:${systemdEscape(log)}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

// ------------------------------------------------------------------ side effects

export type CommandRunner = (file: string, args: string[]) => Promise<{ ok: boolean; out: string }>;

/** Runs a fixed executable with an argument array (never a shell) and returns its combined output. */
export const runCommand: CommandRunner = async (file, args) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(file, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message };
  }
};

/** A failed external command, with the command and the tail of its output for the person to read. */
export function commandFailed(command: string[], output: string, message: string, hint?: string): TapdanceError {
  return new TapdanceError("INTERNAL", message, {
    ...(hint ? { hint } : {}),
    details: { command: command.join(" "), output: tail(output) },
  });
}

export function tail(text: string, lines = 15): string {
  return redactSecrets(text).trimEnd().split("\n").slice(-lines).join("\n");
}

export interface ServiceIo {
  run: CommandRunner;
  uid: number;
  write?: (path: string, content: string, mode: number) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

async function defaultWrite(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode });
  await chmod(path, mode);
}

export interface ServiceInstall {
  platform: ServicePlatform;
  file: string;
  log?: string;
  commands: string[];
  /** The same service was already installed and running; nothing was touched. */
  unchanged?: boolean;
}

/** Writes the plist or unit (mode 644; it holds no secret) and (re)loads it. Safe to run again. */
export async function installGuardService(spec: GuardServiceSpec, io: ServiceIo): Promise<ServiceInstall> {
  const { file, log } = guardServicePaths(spec.platform, spec.home, spec.environment["TAPDANCE_HOME"]);
  const write = io.write ?? defaultWrite;
  const commands: string[] = [];
  const attempt = async (cmd: string[]) => {
    commands.push(cmd.join(" "));
    return io.run(cmd[0]!, cmd.slice(1));
  };
  const must = async (cmd: string[], message: string, hint: string, earlier = "") => {
    const r = await attempt(cmd);
    if (!r.ok) throw commandFailed(cmd, `${earlier}${r.out}`, message, hint);
  };
  // Running again with the same file leaves a running guard alone: a restart would forget which
  // client owns which lease (the guard keeps that in memory) and break an agent's current lease.
  const content = spec.platform === "darwin" ? launchAgentPlist(spec) : systemdUnit(spec);
  if (existsSync(file) && readFileSync(file, "utf8") === content && (await guardServiceState(spec.platform, spec.home, io)).running) {
    return { platform: spec.platform, file, ...(log ? { log } : {}), commands, unchanged: true };
  }
  if (spec.platform === "darwin") {
    if (log) await mkdir(dirname(log), { recursive: true });
    await write(file, content, 0o644);
    const domain = `gui/${io.uid}`;
    const done = { platform: "darwin" as const, file, ...(log ? { log } : {}), commands };
    // A loaded copy (an earlier install) must go first, or bootstrap refuses with "already loaded".
    // launchd tears it down asynchronously, so a bootstrap right after can fail once or twice.
    const wasLoaded = (await attempt(["launchctl", "bootout", `${domain}/${GUARD_LAUNCHD_LABEL}`])).ok;
    const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last = "";
    for (let n = 1; n <= (wasLoaded ? 3 : 1); n++) {
      if (wasLoaded) await sleep(1000);
      const r = await attempt(["launchctl", "bootstrap", domain, file]);
      if (r.ok) return done;
      last = r.out;
    }
    await must(
      ["launchctl", "load", "-w", file],
      "launchctl could not load the worker guard LaunchAgent",
      "Run it from a terminal of the logged-in worker account (a LaunchAgent needs a GUI login session; not over plain SSH or sudo).",
      last ? `${last}\n` : "",
    );
    return done;
  }
  await write(file, content, 0o644);
  // systemd appends to the log but does not create its folder; keep one older log.
  if (!io.write) {
    await mkdir(dirname(log), { recursive: true, mode: 0o700 });
    const size = (await stat(log).catch(() => undefined))?.size ?? 0;
    if (size >= GUARD_LOG_ROTATE_BYTES) await rename(log, `${log}.1`).catch(() => undefined);
  }
  const hint = "Check that a systemd user instance runs for this account (`systemctl --user status`); on a headless server enable it with `loginctl enable-linger $USER`.";
  useUserBus(io.uid);
  await must(["systemctl", "--user", "daemon-reload"], "systemctl --user daemon-reload failed", hint);
  await must(["systemctl", "--user", "enable", GUARD_SYSTEMD_UNIT], "systemctl --user enable failed", hint);
  await must(["systemctl", "--user", "restart", GUARD_SYSTEMD_UNIT], "systemctl --user could not start the worker guard", `See ${log}. ${hint}`);
  return { platform: "linux", file, log, commands };
}

/** Stops the service and deletes its file. Not being installed is not an error. */
export async function uninstallGuardService(platform: ServicePlatform, home: string, io: ServiceIo): Promise<{ file: string; removed: boolean; commands: string[] }> {
  const { file } = guardServicePaths(platform, home);
  const remove = io.remove ?? ((p: string) => rm(p, { force: true }));
  const commands: string[] = [];
  const attempt = async (cmd: string[]) => {
    commands.push(cmd.join(" "));
    return io.run(cmd[0]!, cmd.slice(1));
  };
  // Failures are fine here: a service that is not loaded has nothing to stop.
  const existed = existsSync(file);
  if (platform === "darwin") {
    const r = await attempt(["launchctl", "bootout", `gui/${io.uid}/${GUARD_LAUNCHD_LABEL}`]);
    if (!r.ok && existed) await attempt(["launchctl", "unload", "-w", file]);
    await remove(file);
  } else {
    // Over a non-interactive ssh command (host pause, host down) systemctl --user needs the bus (#118).
    useUserBus(io.uid);
    await attempt(["systemctl", "--user", "disable", "--now", GUARD_SYSTEMD_UNIT]);
    await remove(file);
    await attempt(["systemctl", "--user", "daemon-reload"]);
  }
  return { file, removed: existed, commands };
}

export interface ServiceState {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  detail: string;
}

/**
 * Points `systemctl --user` at the account's user manager when it runs but this process has no login
 * session (a command over ssh): sets XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS if they are missing.
 * Starts nothing; prepareLinuxUserServices does that.
 */
export function useUserBus(uid: number, env: NodeJS.ProcessEnv = process.env): void {
  const runtime = `/run/user/${uid}`;
  if (!existsSync(`${runtime}/bus`)) return;
  if (!env["XDG_RUNTIME_DIR"]) env["XDG_RUNTIME_DIR"] = runtime;
  if (!env["DBUS_SESSION_BUS_ADDRESS"]) env["DBUS_SESSION_BUS_ADDRESS"] = `unix:path=${runtime}/bus`;
}

export async function guardServiceState(platform: ServicePlatform, home: string, io: ServiceIo): Promise<ServiceState> {
  const { file } = guardServicePaths(platform, home);
  const installed = existsSync(file);
  if (platform === "linux") useUserBus(io.uid);
  if (platform === "darwin") {
    const r = await io.run("launchctl", ["print", `gui/${io.uid}/${GUARD_LAUNCHD_LABEL}`]);
    const running = r.ok && /^\s*state = running/m.test(r.out);
    return { installed, loaded: r.ok, running, detail: r.ok ? (/^\s*state = (\S+)/m.exec(r.out)?.[1] ?? "loaded") : "not loaded" };
  }
  const r = await io.run("systemctl", ["--user", "is-active", GUARD_SYSTEMD_UNIT]);
  return { installed, loaded: installed, running: r.out.trim() === "active", detail: r.out.trim() || "unknown" };
}

/** Polls the guard's unauthenticated health route until it answers or the time runs out. */
export async function waitForGuard(url: string, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await fetchImpl(`${url}/v1/healthz`, { signal: AbortSignal.timeout(2000) }).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Linux: the worker and guard run as systemd user units. They need the account's systemd user manager,
 * which a non-interactive SSH command (`gcloud compute ssh --command`, a script over ssh) does not start,
 * and they stop at logout or never start at boot unless the account lingers. Turns linger on (as the
 * user, else with passwordless sudo), waits for the user manager's bus, and points this process (and the
 * Simlock and systemctl it runs) at it when XDG_RUNTIME_DIR is not set.
 */
let linuxUserServicesReady = false;
export async function prepareLinuxUserServices(out: { progress: (m: string) => void; warn: (m: string) => void }): Promise<void> {
  // `host up` reaches this from three steps (host up, worker install, guard install): check and report
  // once per run (#78).
  if (linuxUserServicesReady) {
    useUserBus(process.getuid?.() ?? 0);
    return;
  }
  const user = userInfo().username;
  const lingering = async () => parseLinger((await runCommand("loginctl", ["show-user", user, "--property=Linger"])).out) === true;
  if (!(await lingering())) {
    const self = await runCommand("loginctl", ["enable-linger", user]);
    if (!(await lingering())) await runCommand("sudo", ["-n", "loginctl", "enable-linger", user]);
    if (await lingering()) out.progress(`Turned on linger for ${user}: the worker and guard keep running after you log out and start at boot`);
    else if ((await runCommand("systemctl", ["is-enabled", "tapdance-user-manager.service"])).ok) out.progress(`${user} cannot linger (logind cannot look the account up); tapdance-user-manager.service starts its user manager at boot instead`);
    else out.warn(`Could not turn on linger for ${user} (${self.out.split("\n")[0] ?? "loginctl failed"}): the worker and guard stop when you log out. Run \`sudo loginctl enable-linger ${user}\`.`);
  }
  const runtime = `/run/user/${process.getuid?.() ?? 0}`;
  // logind cannot look up some accounts (Google Cloud OS Login): start the user manager directly.
  if (!existsSync(`${runtime}/bus`)) await runCommand("sudo", ["-n", "systemctl", "start", `user@${process.getuid?.() ?? 0}.service`]);
  for (let i = 0; i < 60 && !existsSync(`${runtime}/bus`); i++) await new Promise((r) => setTimeout(r, 250));
  if (!existsSync(`${runtime}/bus`)) {
    throw new TapdanceError("HOST_CHECK_FAILED", `No systemd user manager runs for ${user} (${runtime}/bus is missing), so the worker cannot be installed as a service`, {
      hint: `Run \`sudo loginctl enable-linger ${user}\` (it starts the user manager and keeps it running), then this command again. For an account logind cannot look up (Google Cloud OS Login), scripts/host-setup.sh installs a boot unit that starts it instead.`,
    });
  }
  useUserBus(process.getuid?.() ?? 0);
  linuxUserServicesReady = true;
}

/**
 * The TAPDANCE_HOME an installed guard service runs with, read from its plist or unit text: the
 * value it was installed with, or `defaultHome` when the service sets none.
 */
export function serviceTapdanceHome(serviceText: string, defaultHome: string): string {
  const plist = /<key>TAPDANCE_HOME<\/key>\s*<string>([^<]+)<\/string>/.exec(serviceText)?.[1];
  const unit = /^Environment="?TAPDANCE_HOME=([^"\n]+)"?$/m.exec(serviceText)?.[1];
  return plist ?? unit ?? defaultHome;
}
