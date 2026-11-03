import { TapdanceError } from "@tapdance/sdk";

/**
 * The cost guard of a device host on a cloud VM: power the machine off when nothing has used it for
 * a while (`hostStop.idleMinutes`) or once it has run for too long (`hostStop.maxUptimeHours`), so a VM
 * with emulators on it never bills on and on. Pure decisions only; the guard runs the timer.
 *
 * The stop command is fixed here. It is never read from a policy, a repository or a request: nothing
 * a client or project sends may choose what runs as root.
 */

export interface HostStopSettings {
  /** Power off after this many minutes without a lease, a guard request or a build. 0: off. */
  idleMinutes: number;
  /** Refuse new leases once the machine has been up this long, and power off when none runs. 0: off. */
  maxUptimeHours: number;
}

/** What powers the host off: systemd's poweroff through a passwordless sudo rule for exactly this. */
export const HOST_STOP_COMMAND: readonly [string, ...string[]] = ["sudo", "-n", "/usr/bin/systemctl", "poweroff"];

/** Asks sudo, without a password prompt, whether HOST_STOP_COMMAND is allowed (exit 0: yes). */
export const HOST_STOP_SUDO_CHECK: readonly string[] = ["-n", "-l", "/usr/bin/systemctl", "poweroff"];

export const SUDOERS_FILE = "/etc/sudoers.d/tapdance-poweroff";

/**
 * Whether the cost guard acts on this platform. Only Linux: on macOS the host is usually someone's own
 * Mac, which Tapdance never powers off.
 */
export function hostStopApplies(settings: HostStopSettings | undefined, platform: NodeJS.Platform): settings is HostStopSettings {
  return platform === "linux" && settings !== undefined && (settings.idleMinutes > 0 || settings.maxUptimeHours > 0);
}

export interface HostStopState {
  now: number;
  /** When the host was last used: a lease, a guard request or a build. */
  lastActivity: number;
  /** A lease is running, a build runs or a guard request is in flight. */
  busy: boolean;
  /** Seconds since boot, when known. */
  uptimeSeconds?: number;
}

export type HostStopDecision = { stop: false } | { stop: true; reason: "idle" | "uptime"; message: string };

/** The machine has run past its uptime cap (always false when the cap is off or uptime is unknown). */
export function uptimeCapReached(settings: HostStopSettings, uptimeSeconds: number | undefined): boolean {
  return settings.maxUptimeHours > 0 && uptimeSeconds !== undefined && uptimeSeconds >= settings.maxUptimeHours * 3600;
}

/** Whether to power off now. Never while a lease, a build or a request is running. */
export function hostStopDecision(settings: HostStopSettings, state: HostStopState): HostStopDecision {
  if (state.busy) return { stop: false };
  if (uptimeCapReached(settings, state.uptimeSeconds)) {
    return { stop: true, reason: "uptime", message: `uptime ${Math.floor((state.uptimeSeconds ?? 0) / 3600)} h passed the cap of ${settings.maxUptimeHours} h and no lease runs` };
  }
  const idleMs = state.now - state.lastActivity;
  if (settings.idleMinutes > 0 && idleMs >= settings.idleMinutes * 60_000) {
    return { stop: true, reason: "idle", message: `idle for ${Math.floor(idleMs / 60_000)} min (limit ${settings.idleMinutes} min)` };
  }
  return { stop: false };
}

/** Seconds since boot from the text of /proc/uptime ("12345.67 54321.00"). */
export function parseProcUptime(text: string): number | undefined {
  const value = Number.parseFloat(text.trim().split(/\s+/)[0] ?? "");
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The refusal of a new lease once the uptime cap has passed. */
export function uptimeCapRefusal(settings: HostStopSettings): { code: "NO_CAPACITY"; message: string; hint: string } {
  return {
    code: "NO_CAPACITY",
    message: `This host has run longer than its uptime cap (${settings.maxUptimeHours} h) and takes no new leases; it powers off once the running leases end`,
    hint: "The host's owner set an uptime cap to bound its cost (hostStop.maxUptimeHours in ~/.tapdance/worker/policy.json, or tapdance host up --max-uptime). Start the machine again to reset it, or ask the owner to raise or turn off the cap.",
  };
}

const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;

/** The one sudoers line that lets `user` run HOST_STOP_COMMAND without a password, and nothing else. */
export function sudoersRule(user: string): string {
  if (!USER.test(user) || user === "ALL") throw new TapdanceError("USAGE", `"${user}" is not a user name a sudoers rule can name`);
  return `${user} ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff`;
}

/** One shell line that installs the rule and checks it with visudo. */
export function sudoersInstallCommand(user: string): string {
  return `echo '${sudoersRule(user)}' | sudo tee ${SUDOERS_FILE} && sudo chmod 440 ${SUDOERS_FILE} && sudo visudo -cf ${SUDOERS_FILE}`;
}

/** "idle stop after 30 min, uptime cap off", for host up and host status. */
export function describeHostStop(settings: HostStopSettings | undefined, platform: NodeJS.Platform): string {
  if (platform === "darwin") return "off (a Mac host never powers itself off)";
  if (!settings || (settings.idleMinutes === 0 && settings.maxUptimeHours === 0)) return "off";
  return [
    settings.idleMinutes > 0 ? `idle stop after ${settings.idleMinutes} min` : "idle stop off",
    settings.maxUptimeHours > 0 ? `uptime cap ${settings.maxUptimeHours} h` : "uptime cap off",
  ].join(", ");
}
