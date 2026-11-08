import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TapdanceError, redactSecrets, type CatalogEntry, type DoctorCheck } from "@tapdance/sdk";

/**
 * The pure parts of `tapdance host up/status/down` and `tapdance connect`: parsing, decisions and
 * rendering. Nothing here runs a program or touches the network, so all of it is unit-tested.
 */

/** Simlock workers run on macOS and Linux only; Windows is a control machine. */
export function assertHostPlatform(platform: NodeJS.Platform): "darwin" | "linux" {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new TapdanceError("NOT_SUPPORTED", `This machine (${platform}) cannot host devices: Simlock workers run on macOS and Linux only`, {
    hint:
      platform === "win32"
        ? "Use Windows as the control machine: `tapdance connect <endpoint> < token-file` against a Mac or Linux host. To host Android emulators on this PC, run scripts/host-setup.sh inside WSL2 or a Linux VM with nested virtualization."
        : "Run `tapdance host up` on a Mac or a Linux machine with KVM, and use this machine as the control machine (`tapdance connect`).",
  });
}

// ------------------------------------------------------------------ prerequisites

export interface Prerequisites {
  android: boolean;
  ios: boolean;
  /** Checks that failed or warned, with their fixes, for the person to act on. */
  problems: DoctorCheck[];
}

const passed = (checks: DoctorCheck[], id: string) => checks.some((c) => c.id === id && c.status === "pass");

/** Which platforms this machine can serve, from `hostChecks` (plus the JDK and cloud checks). */
export function summarizePrerequisites(checks: DoctorCheck[]): Prerequisites {
  const android =
    ["host.android.sdk", "host.android.adb", "host.android.emulator", "host.android.cmdline-tools", "host.android.images"].every((id) => passed(checks, id)) &&
    !checks.some((c) => (c.id.startsWith("host.kvm") || c.id === "host.cloud") && c.status === "fail");
  const ios = passed(checks, "host.ios.xcode") && passed(checks, "host.ios.runtimes");
  return { android, ios, problems: checks.filter((c) => c.status === "fail" || c.status === "warn") };
}

/**
 * Install suggestions for what is missing. Tapdance never installs SDKs itself (they are gigabytes and
 * need licence acceptance); it prints the commands.
 */
export function installInstructions(checks: DoctorCheck[], platform: "darwin" | "linux", arch: string): string[] {
  const failing = (prefix: string) => checks.some((c) => c.id.startsWith(prefix) && c.status !== "pass" && c.status !== "skip");
  const lines: string[] = [];
  for (const c of checks) if ((c.status === "fail" || c.status === "warn") && c.fix) lines.push(`${c.title}: ${c.fix}`);
  const abi = arch === "arm64" ? "arm64-v8a" : "x86_64";
  if (platform === "darwin" && (failing("host.android") || failing("host.jdk"))) {
    lines.push(
      "With Homebrew (suggested; not run by Tapdance):",
      "  brew install openjdk@17",
      '  export JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"',
      "  brew install --cask android-commandlinetools",
      '  export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"',
      `  sdkmanager --install emulator platform-tools "system-images;android-35;google_apis;${abi}"`,
      "  sdkmanager --licenses",
    );
  }
  if (platform === "darwin" && failing("host.ios")) lines.push("For iOS: install Xcode, then `xcodebuild -runFirstLaunch` and `xcodebuild -downloadPlatform iOS`.");
  return lines;
}

// ------------------------------------------------------------------ cloud VMs

export interface DmiInfo {
  sysVendor?: string;
  productName?: string;
  biosVendor?: string;
  chassisAssetTag?: string;
}

const CLOUDS: Array<[RegExp, string]> = [
  [/google/i, "Google Cloud"],
  [/amazon|\bec2\b/i, "AWS EC2"],
  [/microsoft corporation|7783-7084-3265-9085-8269-3286-77/i, "Microsoft Azure / Hyper-V"],
  [/digitalocean/i, "DigitalOcean"],
  [/hetzner/i, "Hetzner"],
  [/openstack/i, "an OpenStack cloud (OVH and others)"],
  [/\bovh/i, "OVHcloud"],
  [/scaleway/i, "Scaleway"],
  [/vultr/i, "Vultr"],
  [/linode|akamai/i, "Akamai/Linode"],
  [/oracle/i, "Oracle Cloud"],
  [/alibaba/i, "Alibaba Cloud"],
  [/tencent/i, "Tencent Cloud"],
  [/upcloud/i, "UpCloud"],
  [/qemu|kvm|bochs|virtualbox|vmware|xen/i, "a virtual machine"],
];

/** Names the cloud or hypervisor from the DMI strings Linux exposes in /sys/class/dmi/id, if any. */
export function detectCloudVm(dmi: DmiInfo): string | undefined {
  const text = [dmi.sysVendor, dmi.productName, dmi.biosVendor, dmi.chassisAssetTag].filter(Boolean).join(" | ");
  if (!text) return undefined;
  return CLOUDS.find(([pattern]) => pattern.test(text))?.[1];
}

/** A cloud/VM check for Linux: a VM without /dev/kvm has no nested virtualization and cannot run emulators. */
export function cloudCheck(vm: string | undefined, devKvm: boolean): DoctorCheck | undefined {
  if (vm === undefined) return undefined;
  if (devKvm) return { id: "host.cloud", title: "Virtual machine", status: "pass", detail: `${vm}, with /dev/kvm (nested virtualization is on)` };
  return {
    id: "host.cloud",
    title: "Virtual machine",
    status: "fail",
    detail: `${vm} without /dev/kvm: nested virtualization is off, so this machine cannot host Android emulators`,
    fix: "Use a VM type with nested virtualization (Google Cloud N2 with --enable-nested-virtualization, a KVM-capable VPS plan, bare metal), or host the devices on your Mac and use this machine as the control machine (`tapdance connect`).",
  };
}

/** Where to read how to delete a host VM so nothing is left billing. */
export const TEARDOWN_DOCS = {
  google: "docs/deployment/google-cloud-n2.md#tear-down",
  other: "docs/deployment/self-hosted-overview.md#when-you-are-done-with-a-rented-machine",
} as const;

/**
 * The plain cost line `host up` and `host status` show on a detected VM: people who rent a VM for a
 * test may not know that it bills while running and that its disk bills even when stopped. A bare
 * hypervisor name may be a local VM, so that wording is conditional. Undefined when not a VM.
 */
export function cloudCostNote(vm: string | undefined): string | undefined {
  if (vm === undefined) return undefined;
  if (vm === "a virtual machine") {
    return `if this VM is rented from a cloud, it is billed while running and its disk usually bills even when stopped. Delete it when you are done: see ${TEARDOWN_DOCS.other}`;
  }
  const docs = vm === "Google Cloud" ? TEARDOWN_DOCS.google : TEARDOWN_DOCS.other;
  return `${vm}, billed while running; its disk bills even when stopped. Delete it when you are done: see ${docs}`;
}

// ------------------------------------------------------------------ Linux hosts

/**
 * Simlock settings a Linux host needs for its emulators. Simlock opens an emulator window by default;
 * on a machine with no display (a cloud VM, a server reached over SSH) that window cannot open and the
 * emulator never boots, so it runs headless (`-no-window`).
 */
export function linuxEmulatorSettings(platform: string, env: Record<string, string | undefined>): Array<[string, string]> {
  if (platform !== "linux" || env["DISPLAY"] || env["WAYLAND_DISPLAY"]) return [];
  // Measured on a Google Cloud N2 VM (no GPU): with `-gpu auto` the idle emulator used 136–165% CPU and
  // screen-changing taps took 3.4–7.9 s; with swiftshader_indirect it idled near 0% and taps took 2.2–2.6 s.
  return [
    ["android.emulator.headless", "true"],
    ["android.emulator.gpu", "swiftshader_indirect"],
  ];
}

/** Reads `loginctl show-user <user> --property=Linger`: undefined when the output is not that line. */
export function parseLinger(raw: string): boolean | undefined {
  const m = /^Linger=(yes|no)$/m.exec(raw);
  return m ? m[1] === "yes" : undefined;
}

/** `tailscale serve` as a user who is not the tailnet's operator on Linux: tailscaled refuses it. */
export function serveNeedsOperator(platform: string, output: string): boolean {
  return platform === "linux" && /access denied|permission denied|--operator/i.test(output);
}

// ------------------------------------------------------------------ Tailscale

/**
 * Why `tailscale set --ssh` failed and what the owner runs instead (#126). Tailscale SSH needs the
 * open-source tailscaled (the macOS app cannot serve SSH), and changing prefs may need root.
 */
export function tailscaleSshFix(platform: string, bin: string, output: string): string {
  if (platform === "darwin" && bin.includes("Tailscale.app")) {
    return "The Tailscale app cannot serve SSH; Tailscale SSH needs the open-source tailscaled (scripts/host-setup.sh installs it from MacPorts or Homebrew on a Mac without the app).";
  }
  if (/access denied|permission denied|--operator|must be root|sudo/i.test(output)) {
    return `Turn it on once as root: \`sudo ${bin} set --ssh\`${platform === "linux" ? " (or make this user the operator: `sudo tailscale set --operator=$USER`, then run host up again)" : ""}.`;
  }
  return `Check \`${bin} set --ssh\` by hand; see https://tailscale.com/kb/1193/tailscale-ssh.`;
}

/**
 * What `--tailscale-ssh` leaves to the tailnet's owner: the policy decides who may connect (#126). A
 * shell over Tailscale SSH bypasses the worker guard, so the agent's own machine should not be let in.
 */
export function tailscaleSshNext(dnsName: string | undefined, user: string, bin = "tailscale"): string {
  const target = `${user}@${dnsName ?? "<this machine's tailnet name>"}`;
  return [
    `Tailscale SSH is on: from a machine in this tailnet, \`ssh ${target}\` (or \`tailscale ssh ${target}\`), no key to copy.`,
    "Who may connect is the tailnet policy's \"ssh\" section (https://login.tailscale.com/admin/acls): the default lets a device's owner in, in check mode (a browser approval about every 12 hours).",
    "A shell here is outside the worker guard: anything running on a machine the policy lets in, the agent's own machine too, can act as this account. Limit the rule's src to your own devices and its users to this account (no root).",
    `Turn it off with \`sudo ${bin} set --ssh=false\`.`,
  ].join(" ");
}

/** Where a tailnet admin turns on MagicDNS and HTTPS Certificates. */
export const TAILSCALE_DNS_ADMIN = "https://login.tailscale.com/admin/dns";

export interface TailscaleState {
  /** BackendState is "Running": logged in and connected. */
  loggedIn: boolean;
  backendState: string;
  /** This machine's MagicDNS name without the trailing dot, e.g. mac.tailnet.ts.net. */
  dnsName?: string;
  /** The tailnet can issue HTTPS certificates (`CertDomains` is non-empty). Off by default on many tailnets. */
  https: boolean;
}

/** How `tailscale serve` exposes the guard: HTTPS when the tailnet has certificates, else plain HTTP
 *  inside the tailnet (WireGuard already encrypts it; `connect` accepts http on *.ts.net and 100.64/10). */
export type ServeMode = "https" | "http";

/** Reads `tailscale status --json`. Unknown or malformed input means "not usable", never a guess. */
export function parseTailscaleStatus(raw: string): TailscaleState {
  let data: { BackendState?: unknown; Self?: { DNSName?: unknown }; CertDomains?: unknown };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    return { loggedIn: false, backendState: "unreadable", https: false };
  }
  const backendState = typeof data.BackendState === "string" ? data.BackendState : "unknown";
  const dns = typeof data.Self?.DNSName === "string" ? data.Self.DNSName.replace(/\.$/, "") : "";
  const https = Array.isArray(data.CertDomains) && data.CertDomains.length > 0;
  return { loggedIn: backendState === "Running", backendState, https, ...(dns ? { dnsName: dns } : {}) };
}

/** True when `tailscale serve status --json` shows an HTTPS listener on this port. */
export function serveHasPort(raw: string, port: number): boolean {
  let data: { TCP?: Record<string, unknown>; Web?: Record<string, unknown> };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    return false;
  }
  if (data.TCP && String(port) in data.TCP) return true;
  return Object.keys(data.Web ?? {}).some((host) => host.endsWith(`:${port}`));
}

export function tailscaleServeArgs(port: number, mode: ServeMode = "https"): string[] {
  return ["serve", "--bg", `--${mode}=${port}`, `http://127.0.0.1:${port}`];
}

/** Turns off whichever mode serves the port (each call is harmless when that mode is not set). */
export function tailscaleServeOffArgs(port: number, mode: ServeMode = "https"): string[] {
  return ["serve", `--${mode}=${port}`, "off"];
}

export function hostEndpoint(dnsName: string | undefined, port: number, mode: ServeMode = "https"): string {
  return dnsName ? `${mode}://${dnsName}:${port}` : `http://127.0.0.1:${port}`;
}

/** Which mode `tailscale serve status --json` shows for this port, if any. */
export function serveModeOf(raw: string, port: number): ServeMode | undefined {
  let data: { TCP?: Record<string, { HTTPS?: unknown; HTTP?: unknown }> };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    return undefined;
  }
  const tcp = data.TCP?.[String(port)];
  if (!tcp) return undefined;
  return tcp.HTTPS ? "https" : "http";
}

// ------------------------------------------------------------------ cost guard (hostStop)

/** Idle minutes `host up` sets on a detected cloud VM when neither the flag nor the policy says. */
export const CLOUD_IDLE_STOP_MINUTES = 30;

function parseLimit(flag: string, value: string, unit: string, max: number): number {
  const v = value.trim().toLowerCase();
  if (v === "off" || v === "0") return 0;
  if (/^\d{1,4}$/.test(v) && Number(v) >= 1 && Number(v) <= max) return Number(v);
  throw new TapdanceError("USAGE", `${flag} "${value}" is not a number of ${unit} from 1 to ${max}, or off`, { hint: `Use ${flag} 30 (${unit}) or ${flag} off.` });
}

/** `--idle-stop <minutes|off>`: 0 is off. */
export function parseIdleStop(value: string): number {
  return parseLimit("--idle-stop", value, "minutes", 1440);
}

/** `--max-uptime <hours|off>`: 0 is off. */
export function parseMaxUptime(value: string): number {
  return parseLimit("--max-uptime", value, "hours", 720);
}

export interface HostStopChoice {
  idleMinutes: number;
  maxUptimeHours: number;
  /** Where the idle setting came from. */
  idleSource: "flag" | "policy" | "cloud default" | "off";
  /** The policy file should record this choice (a flag was given, or the cloud default applies). */
  write: boolean;
  /** It differs from what the policy holds now, so a running guard needs a restart. */
  changed: boolean;
}

/**
 * What `host up` sets in `policy.hostStop`: a flag wins, then what the policy already holds, then on a
 * detected cloud VM an idle stop of 30 minutes; elsewhere off. A Mac never powers itself off: turning
 * either limit on there is refused.
 */
export function resolveHostStop(input: { idleStop?: string; maxUptime?: string; current?: { idleMinutes: number; maxUptimeHours: number }; cloudVm?: string; platform: "darwin" | "linux" }): HostStopChoice {
  const idleFlag = input.idleStop === undefined ? undefined : parseIdleStop(input.idleStop);
  const uptimeFlag = input.maxUptime === undefined ? undefined : parseMaxUptime(input.maxUptime);
  const current = { idleMinutes: input.current?.idleMinutes ?? 0, maxUptimeHours: input.current?.maxUptimeHours ?? 0 };
  if (input.platform === "darwin") {
    if ((idleFlag ?? 0) > 0 || (uptimeFlag ?? 0) > 0) {
      throw new TapdanceError("USAGE", "--idle-stop and --max-uptime power the machine off, which Tapdance never does to a Mac", {
        hint: "They are for Linux cloud VMs. On a Mac, stop hosting with `tapdance host pause` instead.",
      });
    }
    return { ...current, idleSource: input.current ? "policy" : "off", write: false, changed: false };
  }
  let idleMinutes: number;
  let idleSource: HostStopChoice["idleSource"];
  if (idleFlag !== undefined) [idleMinutes, idleSource] = [idleFlag, "flag"];
  else if (input.current !== undefined) [idleMinutes, idleSource] = [current.idleMinutes, "policy"];
  else if (input.cloudVm !== undefined) [idleMinutes, idleSource] = [CLOUD_IDLE_STOP_MINUTES, "cloud default"];
  else [idleMinutes, idleSource] = [0, "off"];
  const maxUptimeHours = uptimeFlag ?? current.maxUptimeHours;
  const write = idleFlag !== undefined || uptimeFlag !== undefined || idleSource === "cloud default";
  const changed = write && (idleMinutes !== current.idleMinutes || maxUptimeHours !== current.maxUptimeHours);
  return { idleMinutes, maxUptimeHours, idleSource, write, changed };
}

/**
 * "idle 1 min, powers off in about 9 min (around 15:43 UTC)" from the guard's last check
 * (host-stop.json, which also carries the idle limit), when that check is recent. The guard checks once
 * a minute and the guest then needs a minute or two to shut down, so the stop lands a little later.
 */
export function describeIdle(state: { checkedAt?: unknown; lastActivityAt?: unknown; leases?: unknown; idleMinutes?: unknown } | undefined, now: number): string | undefined {
  if (!state || typeof state.checkedAt !== "string" || typeof state.lastActivityAt !== "string") return undefined;
  const checked = Date.parse(state.checkedAt);
  const last = Date.parse(state.lastActivityAt);
  if (!Number.isFinite(checked) || !Number.isFinite(last) || now - checked > 5 * 60_000) return undefined;
  if (typeof state.leases === "number" && state.leases > 0) return `in use (${state.leases} lease(s))`;
  const idle = `idle ${Math.max(0, Math.floor((checked - last) / 60_000))} min`;
  if (typeof state.idleMinutes !== "number" || !(state.idleMinutes > 0)) return idle;
  const stopAt = last + state.idleMinutes * 60_000;
  const left = Math.ceil((stopAt - now) / 60_000);
  const at = new Date(Math.max(stopAt, now)).toISOString().slice(11, 16);
  return left <= 0 ? `${idle}, powers off at the guard's next check (within a minute)` : `${idle}, powers off in about ${left} min (around ${at} UTC)`;
}

// ------------------------------------------------------------------ pairing

export function defaultLabel(hostname: string): string {
  return sanitizeLabel(hostname.replace(/\.local$/i, "")) || "host";
}

export function sanitizeLabel(label: string): string {
  return label.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 64);
}

/**
 * Which pairing `host up` works on. `--label` wins. Without it: the hostname's label when that pairing
 * exists, else the host's only active pairing (so `host up --idle-stop 10` keeps the pairing in use
 * instead of pairing a new machine as the hostname, #93), else the hostname. Several active pairings
 * and none named: refused, before anything changes.
 */
export function choosePairingLabel(input: { flag?: string; hostnameLabel: string; active: string[] }): { label: string; source: "flag" | "hostname" | "only pairing" } {
  if (input.flag !== undefined) return { label: sanitizeLabel(input.flag) || "host", source: "flag" };
  if (input.active.length === 0 || input.active.includes(input.hostnameLabel)) return { label: input.hostnameLabel, source: "hostname" };
  if (input.active.length === 1) return { label: input.active[0]!, source: "only pairing" };
  throw new TapdanceError("USAGE", `This host has several pairings (${input.active.map((l) => `"${l}"`).join(", ")}); say which one`, {
    hint: `Pass --label with one of them, e.g. tapdance host up --label ${input.active[0]} (a new name pairs another control machine).`,
  });
}

/**
 * The refusal when `host up` would issue a new pairing without a terminal to approve it. Names the
 * pairings this host already has, so the fix is the right --label rather than a second pairing.
 */
export function pairingApprovalRefusal(o: HostUpOptions, label: string, active: string[]): TapdanceError {
  const others = active.filter((l) => l !== label);
  if (others.length > 0) {
    return new TapdanceError("FORBIDDEN", `"${label}" is not paired, and pairing it must be approved at this machine's terminal; this host is paired as ${others.map((l) => `"${l}"`).join(", ")}`, {
      hint: `To keep that pairing: ${hostUpCommand({ ...o, label: others[0]! })}. To pair a new control machine as "${label}", run it in a local terminal or add --yes if you are the owner: ${hostUpCommand({ ...o, label }, { yes: true })}`,
    });
  }
  return new TapdanceError("FORBIDDEN", "Pairing must be approved at this machine's terminal", {
    hint: `Run it in a local terminal, or pass --yes if you are the owner running it here: ${hostUpCommand({ ...o, label }, { yes: true })}`,
  });
}

/** Where `host up` writes the pairing token for a label (mode 600, next to the guard's own files). */
export function pairingTokenPath(guardDir: string, label: string): string {
  return join(guardDir, `pairing-${sanitizeLabel(label)}.token`);
}

// ------------------------------------------------------------------ rendering

export interface HostUpOptions {
  label?: string;
  allowAdminAccount?: boolean;
  tailscale?: boolean;
  keepAwake?: boolean;
  yes?: boolean;
  skipSelfTest?: boolean;
  repair?: boolean;
  /** `--warm android=1,ios=0`: booted spare devices per platform. */
  warm?: string;
  /** `--scope interaction,inspection`: the pairing token's policy areas. */
  scope?: string;
  /** `--idle-stop 30` or `off`: power a cloud VM off after this many idle minutes. */
  idleStop?: string;
  /** `--max-uptime 12` or `off`: stop taking leases after this many hours up, then power off. */
  maxUptime?: string;
  /** `--tailscale-ssh`: turn on Tailscale SSH, so tailnet machines reach this one without ssh keys (#126). */
  tailscaleSsh?: boolean;
}

const shellWord = (s: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The exact `tapdance host up` command to run again, with the flags given plus any added ones. */
export function hostUpCommand(o: HostUpOptions, add: Partial<HostUpOptions> = {}): string {
  const m = { ...o, ...add };
  return [
    "tapdance host up",
    ...(m.label ? [`--label ${shellWord(m.label)}`] : []),
    ...(m.allowAdminAccount ? ["--allow-admin-account"] : []),
    ...(m.tailscale === false ? ["--no-tailscale"] : []),
    ...(m.keepAwake ? ["--keep-awake"] : []),
    ...(m.tailscaleSsh ? ["--tailscale-ssh"] : []),
    ...(m.repair ? ["--repair"] : []),
    ...(m.skipSelfTest ? ["--skip-self-test"] : []),
    ...(m.warm ? [`--warm ${shellWord(m.warm)}`] : []),
    ...(m.scope ? [`--scope ${shellWord(m.scope)}`] : []),
    ...(m.idleStop ? [`--idle-stop ${shellWord(m.idleStop)}`] : []),
    ...(m.maxUptime ? [`--max-uptime ${shellWord(m.maxUptime)}`] : []),
    ...(m.yes ? ["--yes"] : []),
  ].join(" ");
}

/** "android 34 (google_apis_playstore), ios 26.5" from the worker's catalog. */
export function describeCatalog(catalog: CatalogEntry[]): string {
  const parts = catalog
    .filter((e) => e.osVersions.length > 0 || e.defaultOsVersion)
    .map((e) => {
      const version = e.defaultOsVersion ?? e.osVersions.at(-1) ?? "";
      const tag = e.platform === "android" && e.imageTags && e.imageTags.length > 0 ? ` (${e.imageTags.join(", ")})` : "";
      return `${e.platform} ${version}${tag}`.trim();
    });
  return parts.join(", ") || "none";
}

export interface ReadyBlock {
  endpoint: string;
  tokenPath: string;
  devices: string;
  selfTest: string;
  /** The cost guard, e.g. "idle stop after 30 min, uptime cap off". Shown when given. */
  costGuard?: string;
  /** On a detected VM: what still bills and where to read how to delete it (cloudCostNote). */
  cloudCost?: string;
}

export type WarmCounts = { android?: number; ios?: number };

/** Parses `--warm android=1,ios=0`. */
export function parseWarm(spec: string): WarmCounts {
  const out: WarmCounts = {};
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(android|ios)=(\d{1,2})$/.exec(part);
    if (!m) throw new TapdanceError("USAGE", `"${part}" is not a warm count`, { hint: "Use --warm android=1,ios=0 (a number of booted spares per platform; 0 turns them off)." });
    out[m[1] as "android" | "ios"] = Number(m[2]);
  }
  return out;
}

/**
 * Simlock settings for a warm-spare count per platform. Simlock keeps booted spares of the device kinds
 * it has served; `warmPool.reserveRunning.<platform>` holds running slots back from them, so
 * reserving `limit - count` leaves room for `count` spares (0 spares: reserve every slot). With no
 * spares anywhere the pool is off and idle devices shut down (`idle.shutdownAfterMs`).
 */
export function warmSettings(warm: WarmCounts, limits: { android: number; ios: number }): Array<[string, string]> {
  const want = { android: warm.android ?? 1, ios: warm.ios ?? 1 };
  if (want.android === 0 && want.ios === 0) return [["warmPool.enabled", "false"]];
  return [
    ["warmPool.enabled", "true"],
    ["warmPool.reserveRunning.android", String(Math.max(0, limits.android - want.android))],
    ["warmPool.reserveRunning.ios", String(Math.max(0, limits.ios - want.ios))],
  ];
}

/** The warm-pool keys `warmSettings` writes; `host warm default` removes exactly these (#91). */
export const WARM_KEYS = ["warmPool.enabled", "warmPool.reserveRunning.android", "warmPool.reserveRunning.ios"] as const;

/**
 * Simlock's config without the warm-pool keys Tapdance writes, so Simlock's own default applies
 * again: one booted spare per device kind leases used (learned). Objects left empty are dropped;
 * any other key stays as it is. Returns the keys that were present.
 */
export function withoutWarmSettings(config: Record<string, unknown>): { config: Record<string, unknown>; removed: string[] } {
  const copy = structuredClone(config);
  const removed: string[] = [];
  for (const key of WARM_KEYS) {
    const path = key.split(".");
    const parents: Array<Record<string, unknown>> = [copy];
    for (const segment of path.slice(0, -1)) {
      const next = parents.at(-1)![segment];
      if (next === null || typeof next !== "object" || Array.isArray(next)) break;
      parents.push(next as Record<string, unknown>);
    }
    if (parents.length !== path.length) continue;
    const last = path.at(-1)!;
    if (!(last in parents.at(-1)!)) continue;
    delete parents.at(-1)![last];
    removed.push(key);
    // Drop objects the removal left empty (reserveRunning, then warmPool), innermost first.
    for (let i = parents.length - 1; i > 0; i--) {
      if (Object.keys(parents[i]!).length > 0) break;
      delete parents[i - 1]![path[i - 1]!];
    }
  }
  return { config: copy, removed };
}

/** How the worker's warm spares are set, for `host warm` with no counts (#91). */
export function describeWarm(
  config: Record<string, unknown> | undefined,
  pool: { enabled?: boolean; targets?: Array<{ platform?: string; model?: string; osVersion?: string; imageTag?: string; origin?: string; ready?: number; booting?: number }> } | undefined,
): string {
  const warm = (config?.["warmPool"] ?? {}) as { enabled?: unknown; reserveRunning?: Record<string, unknown> };
  const set = WARM_KEYS.filter((k) => withoutWarmSettings(config ?? {}).removed.includes(k));
  const lines: string[] = [];
  if (warm.enabled === false) lines.push("Warm spares: off (tapdance host warm android=0,ios=0); idle devices shut down.");
  else if (set.length === 0) lines.push("Warm spares: Simlock's default: one booted spare of each device kind a lease used (learned from leases).");
  else lines.push(`Warm spares: set by tapdance host warm (reserved running slots: android ${String(warm.reserveRunning?.["android"] ?? 0)}, ios ${String(warm.reserveRunning?.["ios"] ?? 0)}); spares are still the device kinds leases used.`);
  const targets = pool?.targets ?? [];
  if (pool === undefined) lines.push("The worker is not running, so there is no spare right now.");
  else if (targets.length === 0) lines.push(pool.enabled === false ? "No spares." : "No spare yet: the next lease boots a device, and the worker keeps one of that kind ready afterwards.");
  // The image tag tells two kinds of one model apart (#112); an untagged kind is whatever image it was made from.
  for (const t of targets) lines.push(`  ${t.platform ?? "?"} ${t.model ?? "?"}${t.osVersion ? ` / ${t.osVersion}` : ""}${t.platform === "android" ? ` ${t.imageTag ?? "(no image tag)"}` : t.imageTag ? ` ${t.imageTag}` : ""} (${t.origin ?? "?"}): ready ${t.ready ?? 0}${t.booting ? `, booting ${t.booting}` : ""}`);
  lines.push("Change: tapdance host warm android=1,ios=0 · off: tapdance host warm android=0,ios=0 · back to the default: tapdance host warm default");
  return lines.join("\n");
}

/** A short, safe-to-show tag for a token: the first 6 hex characters of its SHA-256. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex").slice(0, 6);
}

/** The clipboard command for this platform, as an argument array (stdin carries the text). */
export function clipboardCommand(platform: NodeJS.Platform, has: (bin: string) => boolean): string[] | undefined {
  if (platform === "darwin") return ["pbcopy"];
  if (platform === "win32") return ["clip"];
  if (has("wl-copy")) return ["wl-copy"];
  if (has("xclip")) return ["xclip", "-selection", "clipboard"];
  if (has("xsel")) return ["xsel", "--clipboard", "--input"];
  return undefined;
}

/**
 * Whether `host up` offers to copy the token to the clipboard. Not on Linux without a display (a server
 * over ssh has no clipboard to paste from) or without a clipboard tool: then it points at
 * `tapdance host token --show` instead of asking a question whose only answer is "no tool found".
 */
export function offerClipboard(platform: NodeJS.Platform, env: Record<string, string | undefined>, has: (bin: string) => boolean): boolean {
  if (platform === "linux" && !env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) return false;
  // Over ssh the clipboard is the host's, not the person's (a rented Mac mini reached with `ssh -t`).
  if (env["SSH_CONNECTION"] || env["SSH_TTY"]) return false;
  return clipboardCommand(platform, has) !== undefined;
}

/** The security note under the ready block. The iOS sentence only where iOS simulators run (macOS). */
export function hostSecurityNote(platform: NodeJS.Platform, user: string, scope?: string): string {
  return [
    `Security: whoever holds this token can drive the devices${scope ? ` (scopes: ${scope})` : ", install apps"} and run a shell inside the emulators.`,
    ...(platform === "darwin" ? [`An iOS simulator app is not sandboxed from this Mac: installing one runs code as ${user}, with this account's files.`] : []),
    `Prefer a dedicated standard account for hosting, or a token without install (--scope interaction,inspection,screenshots,streaming,input). See docs/security/threat-model.md.`,
  ].join(" ");
}

/** The Tailscale ACL suggestion under the ready block. */
export function tailscaleAclHint(platform: NodeJS.Platform, port: number): string {
  const self = platform === "darwin" ? "this Mac" : "this machine";
  return `Tailscale ACL (recommended): let only the agent's machine reach this port, e.g. {"action": "accept", "src": ["<agent machine's 100.x address or tag>"], "dst": ["<${self}'s 100.x address or tag>:${port}"]} in https://login.tailscale.com/admin/acls (\`tailscale ip -4\` prints the address).`;
}

/** The prerequisites row of `host status`: iOS on Linux "needs a Mac", like `host up` says. */
export function describePlatforms(p: { android: boolean; ios: boolean }, platform: "darwin" | "linux"): string {
  return `android ${p.android ? "ready" : "not available"}, ios ${p.ios ? "ready" : platform === "darwin" ? "not available" : "needs a Mac"}`;
}

/**
 * The devices part of the worker row in `host status`, from `simlock --local status --json`. Simlock 0.4
 * reports the RAM budget under `capacity.ramBudget` (older builds at the top level), and only under a
 * capacity strategy that keeps one: without it the budget part is left out.
 */
export function describeWorkerDevices(status: unknown): string {
  const s = (status ?? {}) as { capacity?: Record<string, unknown>; ramBudget?: unknown };
  const capacity = s.capacity ?? {};
  const counts = (p: string) => {
    const c = (capacity[p] ?? {}) as { running?: unknown; warm?: unknown };
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    return `${p} ${n(c.running)} running (${n(c.warm)} warm spare)`;
  };
  const budget = (capacity["ramBudget"] ?? s.ramBudget ?? {}) as { usedBytes?: unknown; limitBytes?: unknown };
  const gb = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? (v / 1024 ** 3).toFixed(1) : undefined);
  const used = gb(budget.usedBytes);
  const limit = gb(budget.limitBytes);
  return `${counts("android")}, ${counts("ios")}${used !== undefined && limit !== undefined ? `; devices use ${used} of ${limit} GB budget` : ""}`;
}

export function renderReadyBlock(r: ReadyBlock & { fingerprint?: string; label?: string }): string {
  const file = r.tokenPath.split(/[\\/]/).at(-1) ?? "token-file";
  return [
    "TAPDANCE HOST READY",
    `endpoint:  ${r.endpoint}`,
    `token:     saved to ${r.tokenPath} (mode 600)${r.fingerprint ? `, fingerprint ${r.fingerprint}` : ""}. Copy it: tapdance host token${r.label ? ` --label ${r.label}` : ""} (over ssh: scp the file)`,
    `devices:   ${r.devices}`,
    `self-test: ${r.selfTest}`,
    ...(r.costGuard ? [`cost guard: ${r.costGuard}`] : []),
    ...(r.cloudCost ? [`cloud VM:  ${r.cloudCost}`] : []),
    `on the agent machine:  tapdance connect ${r.endpoint} < ${file}`,
  ].join("\n");
}

export interface StepRef {
  index: number;
  total: number;
  title: string;
}

/** A failed step: which one, the command it ran, the end of that command's output, and the fix. */
export function formatStepFailure(step: StepRef, error: TapdanceError): string {
  const details = error.details ?? {};
  const command = typeof details["command"] === "string" ? details["command"] : undefined;
  const output = typeof details["output"] === "string" ? details["output"] : undefined;
  return [
    `✗ step ${step.index}/${step.total} (${step.title}) failed: ${redactSecrets(error.message)}`,
    ...(command ? [`  command: ${redactSecrets(command)}`] : []),
    ...(output ? ["  output:", ...redactSecrets(output).split("\n").map((l) => `    ${l}`)] : []),
    ...(error.hint ? [`  fix: ${redactSecrets(error.hint)}`] : []),
  ].join("\n");
}

// ------------------------------------------------------------------ connect

const jsonArgs = (args: string[]) => args.map((a) => JSON.stringify(a)).join(", ");

/** MCP client configuration for Claude Code, Codex and Cursor, running `command` (e.g. ["tapdance", "mcp"]). */
export function mcpSnippets(command: string[]): string {
  const [bin, ...args] = command as [string, ...string[]];
  const line = command.map(shellWord).join(" ");
  return [
    "Claude Code:",
    `  claude mcp add tapdance -- ${line}`,
    "",
    "Codex (~/.codex/config.toml):",
    "  [mcp_servers.tapdance]",
    `  command = ${JSON.stringify(bin)}`,
    `  args = [${jsonArgs(args)}]`,
    "  tool_timeout_sec = 600",
    "",
    "Cursor (.cursor/mcp.json):",
    `  { "mcpServers": { "tapdance": { "type": "stdio", "command": ${JSON.stringify(bin)}, "args": [${jsonArgs(args)}] } } }`,
  ].join("\n");
}

/** The tailscale CLI: on PATH, else (macOS) the app's or the open-source tailscaled's from MacPorts or Homebrew, which a non-interactive ssh session's PATH does not include. */
export function findTailscale(pathEnv = process.env["PATH"] ?? "", exists: (p: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform): string | undefined {
  const mac = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];
  return findOnPath("tailscale", pathEnv, exists, platform) ?? (platform === "darwin" ? mac.find((p) => exists(p)) : undefined);
}

/** Finds an executable on a PATH string without running anything. */
export function findOnPath(name: string, pathEnv: string, exists: (p: string) => boolean, platform: NodeJS.Platform = process.platform): string | undefined {
  const sep = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? [name, `${name}.cmd`, `${name}.exe`] : [name];
  for (const dir of pathEnv.split(sep).filter(Boolean)) {
    for (const n of names) {
      const full = join(dir, n);
      if (exists(full)) return full;
    }
  }
  return undefined;
}
