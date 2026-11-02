import { createHash } from "node:crypto";
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

// ------------------------------------------------------------------ Tailscale

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

// ------------------------------------------------------------------ pairing

export function defaultLabel(hostname: string): string {
  return sanitizeLabel(hostname.replace(/\.local$/i, "")) || "host";
}

export function sanitizeLabel(label: string): string {
  return label.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 64);
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
    ...(m.repair ? ["--repair"] : []),
    ...(m.skipSelfTest ? ["--skip-self-test"] : []),
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

export function renderReadyBlock(r: ReadyBlock & { fingerprint?: string; label?: string }): string {
  const file = r.tokenPath.split(/[\\/]/).at(-1) ?? "token-file";
  return [
    "TAPDANCE HOST READY",
    `endpoint:  ${r.endpoint}`,
    `token:     saved to ${r.tokenPath} (mode 600)${r.fingerprint ? `, fingerprint ${r.fingerprint}` : ""}. Copy it: tapdance host token${r.label ? ` --label ${r.label}` : ""}`,
    `devices:   ${r.devices}`,
    `self-test: ${r.selfTest}`,
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
