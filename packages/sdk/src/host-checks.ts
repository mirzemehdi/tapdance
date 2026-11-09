import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, platform as osPlatform, release } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DoctorCheck } from "@tapdance/core";

const run = promisify(execFile);

async function cmd(file: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await run(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message };
  }
}

/**
 * ANDROID_HOME, ANDROID_SDK_ROOT, then the platform's default: ~/Library/Android/sdk on macOS,
 * ~/Android/Sdk on Linux (where Android Studio and scripts/host-setup.sh install it). The Linux default
 * matters over a non-interactive ssh command, which does not load the shell profile that sets ANDROID_HOME.
 */
export function findAndroidSdk(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = osPlatform(),
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const fallback = platform === "darwin" ? join(home, "Library/Android/sdk") : platform === "linux" ? join(home, "Android/Sdk") : undefined;
  for (const dir of [env["ANDROID_HOME"], env["ANDROID_SDK_ROOT"], fallback]) if (dir && exists(dir)) return dir;
  return undefined;
}

export interface KvmReport {
  cpuFlag: "vmx" | "svm" | null;
  devKvm: boolean;
  devKvmAccess: boolean;
  kvmOk?: string;
  emulatorAccel?: string;
  /** `emulator -version` output when it failed (it starts the emulator's QEMU, which needs system libraries). */
  emulatorRun?: string;
}

/** The Debian/Ubuntu package for each system library the emulator's QEMU loads that minimal cloud images lack. */
const EMULATOR_LIB_PACKAGES: Record<string, string> = {
  "libpulse.so.0": "libpulse0",
  "libxkbfile.so.1": "libxkbfile1",
  "libXi.so.6": "libxi6",
  "libSM.so.6": "libsm6",
  "libICE.so.6": "libice6",
  // Emulator 37.2.13 on Ubuntu 24.04's cloud image (machine create, 2026-11-09).
  "libnss3.so": "libnss3",
};

/** All packages the emulator needs on a minimal Ubuntu: installing them together avoids one lease failure per library. */
export const EMULATOR_APT_PACKAGES = Object.values(EMULATOR_LIB_PACKAGES);

/** The library named in a loader error such as "error while loading shared libraries: libpulse.so.0: cannot open …". */
export function missingSharedLibrary(output: string): string | undefined {
  return /error while loading shared libraries: ([^:\s]+):/.exec(output)?.[1];
}

/** Hardware acceleration facts for a Linux host. Never guesses: each field is measured. */
export async function probeKvm(sdk?: string): Promise<KvmReport> {
  let cpuFlag: KvmReport["cpuFlag"] = null;
  try {
    const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
    cpuFlag = /\bvmx\b/.test(cpuinfo) ? "vmx" : /\bsvm\b/.test(cpuinfo) ? "svm" : null;
  } catch {
    cpuFlag = null;
  }
  const devKvm = existsSync("/dev/kvm");
  let devKvmAccess = false;
  if (devKvm) {
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
      devKvmAccess = true;
    } catch {
      devKvmAccess = false;
    }
  }
  const report: KvmReport = { cpuFlag, devKvm, devKvmAccess };
  const kvmOk = await cmd("kvm-ok", []);
  if (kvmOk.ok || !/ENOENT/.test(kvmOk.out)) report.kvmOk = kvmOk.out.split("\n").slice(-2).join(" ");
  if (sdk && existsSync(join(sdk, "emulator/emulator"))) {
    const accel = await cmd(join(sdk, "emulator/emulator"), ["-accel-check"]);
    report.emulatorAccel = accel.out.split("\n").filter(Boolean).slice(-2).join(" ");
    const run = await cmd(join(sdk, "emulator/emulator"), ["-version"]);
    if (!run.ok) report.emulatorRun = run.out.split("\n").filter(Boolean).slice(-2).join(" ");
  }
  return report;
}

export function kvmChecks(report: KvmReport): DoctorCheck[] {
  const fixVirt =
    "This machine exposes no hardware virtualization. On Google Cloud use an N2 (Intel) VM created with --enable-nested-virtualization; on other hosts enable VT-x/AMD-V in firmware or pick a KVM-capable plan. Or run the emulator on another machine (your laptop or a KVM server) as a Tapdance worker.";
  const checks: DoctorCheck[] = [
    {
      id: "host.kvm.cpu",
      title: "CPU virtualization flags",
      status: report.cpuFlag ? "pass" : "fail",
      detail: report.cpuFlag ? `${report.cpuFlag} present` : "neither vmx nor svm in /proc/cpuinfo",
      ...(report.cpuFlag ? {} : { fix: fixVirt }),
    },
    {
      id: "host.kvm.device",
      title: "/dev/kvm",
      status: report.devKvm ? (report.devKvmAccess ? "pass" : "fail") : "fail",
      detail: report.devKvm ? (report.devKvmAccess ? "present and writable by this user" : "present but not writable by this user") : "missing",
      ...(report.devKvm && !report.devKvmAccess
        ? { fix: "sudo usermod -aG kvm $USER, then log out and back in (or `newgrp kvm`)." }
        : report.devKvm
          ? {}
          : { fix: report.cpuFlag ? "sudo apt-get install -y qemu-kvm && sudo modprobe kvm_intel (or kvm_amd)" : fixVirt }),
    },
  ];
  if (report.kvmOk !== undefined) {
    const ok = /can be used/i.test(report.kvmOk);
    checks.push({ id: "host.kvm.kvmok", title: "kvm-ok", status: ok ? "pass" : "fail", detail: report.kvmOk });
  }
  if (report.emulatorAccel !== undefined) {
    const ok = /is installed and usable|accel.*usable/i.test(report.emulatorAccel);
    checks.push({
      id: "host.kvm.emulator",
      title: "Android Emulator acceleration",
      status: ok ? "pass" : "fail",
      detail: report.emulatorAccel,
      ...(ok ? {} : { fix: "Do not run the emulator without acceleration; fix KVM first." }),
    });
  }
  if (report.emulatorRun !== undefined) {
    const lib = missingSharedLibrary(report.emulatorRun);
    checks.push({
      id: "host.kvm.emulator-libs",
      title: "Android Emulator runs",
      status: "fail",
      detail: lib ? `the emulator cannot start: system library ${lib} is missing` : report.emulatorRun,
      fix: lib
        ? `Install the libraries the emulator needs (minimal cloud images lack them): sudo apt-get install -y ${EMULATOR_APT_PACKAGES.join(" ")} (Fedora: sudo dnf install -y pulseaudio-libs libxkbfile libXi libSM libICE)`
        : "Run `$ANDROID_HOME/emulator/emulator -version` and fix what it reports.",
    });
  }
  return checks;
}

export interface AndroidReport {
  sdk?: string;
  adb: boolean;
  emulator: boolean;
  cmdlineTools: boolean;
  systemImages: string[];
  avds: string[];
  running: string[];
}

export async function probeAndroid(env: NodeJS.ProcessEnv = process.env): Promise<AndroidReport> {
  const sdk = findAndroidSdk(env);
  const report: AndroidReport = { adb: false, emulator: false, cmdlineTools: false, systemImages: [], avds: [], running: [] };
  if (sdk === undefined) return report;
  report.sdk = sdk;
  report.adb = existsSync(join(sdk, "platform-tools/adb"));
  report.emulator = existsSync(join(sdk, "emulator/emulator"));
  report.cmdlineTools = existsSync(join(sdk, "cmdline-tools/latest/bin/sdkmanager"));
  const images = join(sdk, "system-images");
  if (existsSync(images)) {
    for (const api of readdirSync(images)) {
      for (const tag of safeList(join(images, api))) {
        for (const abi of safeList(join(images, api, tag))) report.systemImages.push(`${api};${tag};${abi}`);
      }
    }
  }
  if (report.emulator) {
    const avds = await cmd(join(sdk, "emulator/emulator"), ["-list-avds"]);
    if (avds.ok) report.avds = avds.out.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("INFO"));
  }
  if (report.adb) {
    const devices = await cmd(join(sdk, "platform-tools/adb"), ["devices"]);
    if (devices.ok) report.running = devices.out.split("\n").slice(1).map((l) => l.trim()).filter((l) => l.endsWith("device")).map((l) => l.split(/\s+/)[0]!);
  }
  return report;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

export function androidChecks(report: AndroidReport): DoctorCheck[] {
  if (report.sdk === undefined) {
    return [
      {
        id: "host.android.sdk",
        title: "Android SDK",
        status: "fail",
        detail: `not found in ANDROID_HOME, ANDROID_SDK_ROOT or ${osPlatform() === "darwin" ? "~/Library/Android/sdk" : "~/Android/Sdk"}`,
        fix: "Install Android Studio or the command-line tools and set ANDROID_HOME. See docs/platforms/android.md.",
      },
    ];
  }
  const sdk = report.sdk;
  return [
    { id: "host.android.sdk", title: "Android SDK", status: "pass", detail: sdk },
    tool("host.android.adb", "platform-tools (adb)", report.adb, `sdkmanager --install platform-tools`),
    tool("host.android.emulator", "emulator package", report.emulator, `sdkmanager --install emulator`),
    tool(
      "host.android.cmdline-tools",
      "command-line tools (sdkmanager, avdmanager)",
      report.cmdlineTools,
      `Install "Android SDK Command-line Tools (latest)" from Android Studio's SDK Manager, or unpack the download to ${join(sdk, "cmdline-tools/latest")}. Simlock needs it to create emulators.`,
    ),
    {
      id: "host.android.images",
      title: "System images",
      status: report.systemImages.length > 0 ? "pass" : "warn",
      detail: report.systemImages.length > 0 ? report.systemImages.join(", ") : "none installed",
      ...(report.systemImages.length > 0 ? {} : { fix: `sdkmanager "system-images;android-35;google_apis;${process.arch === "arm64" ? "arm64-v8a" : "x86_64"}"` }),
    },
    {
      id: "host.android.avds",
      title: "Your AVDs (not leased; Simlock creates its own from the images above)",
      status: "pass",
      detail: report.avds.length > 0 ? report.avds.join(", ") : "none",
    },
    { id: "host.android.running", title: "Emulators/devices on your default adb", status: "pass", detail: report.running.join(", ") || "none" },
  ];
}

function tool(id: string, title: string, present: boolean, fix: string): DoctorCheck {
  return { id, title, status: present ? "pass" : "fail", detail: present ? "installed" : "missing", ...(present ? {} : { fix }) };
}

export async function iosChecks(): Promise<DoctorCheck[]> {
  if (osPlatform() !== "darwin") {
    return [{ id: "host.ios", title: "iOS Simulator", status: "skip", detail: "needs a macOS worker with Xcode; not available on this host" }];
  }
  const checks: DoctorCheck[] = [];
  const select = await cmd("xcode-select", ["-p"]);
  const xcodebuild = await cmd("xcodebuild", ["-version"]);
  checks.push({
    id: "host.ios.xcode",
    title: "Xcode",
    status: select.ok && xcodebuild.ok ? "pass" : "fail",
    detail: xcodebuild.ok ? xcodebuild.out.split("\n").join(" ") : xcodebuild.out.split("\n")[0] ?? "not found",
    ...(xcodebuild.ok ? {} : { fix: "Install Xcode, then `sudo xcode-select -s /Applications/Xcode.app`, `sudo xcodebuild -license accept`, `sudo xcodebuild -runFirstLaunch`." }),
  });
  if (xcodebuild.ok) {
    const runtimes = await cmd("xcrun", ["simctl", "list", "runtimes", "--json"]);
    let names: string[] = [];
    try {
      names = (JSON.parse(runtimes.out) as { runtimes: Array<{ name: string; isAvailable: boolean }> }).runtimes.filter((r) => r.isAvailable).map((r) => r.name);
    } catch {
      names = [];
    }
    checks.push({
      id: "host.ios.runtimes",
      title: "Simulator runtimes",
      status: names.some((n) => n.startsWith("iOS")) ? "pass" : "fail",
      detail: names.join(", ") || "none",
      ...(names.length > 0 ? {} : { fix: "xcodebuild -downloadPlatform iOS" }),
    });
  }
  return checks;
}

export async function hostChecks(options: { platforms: { android: boolean; ios: boolean }; env?: NodeJS.ProcessEnv } = { platforms: { android: true, ios: true } }): Promise<DoctorCheck[]> {
  const env = options.env ?? process.env;
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  const checks: DoctorCheck[] = [
    {
      id: "host.node",
      title: "Node.js",
      status: major > 22 || (major === 22 && minor >= 13) ? "pass" : "fail",
      detail: `${process.versions.node} on ${osPlatform()} ${release()} ${process.arch}`,
      ...(major > 22 || (major === 22 && minor >= 13) ? {} : { fix: "Install Node.js 22.13 or later." }),
    },
  ];
  if (osPlatform() === "win32") {
    checks.push({
      id: "host.windows",
      title: "Windows worker",
      status: "fail",
      detail: "Simlock, which runs Tapdance workers, supports macOS and Linux only",
      fix: "Use this machine as a control machine (CLI/MCP) only, or run the worker in a Linux VM with nested virtualization or on another machine.",
    });
  }
  if (options.platforms.android) {
    const android = await probeAndroid(env);
    checks.push(...androidChecks(android));
    if (osPlatform() === "linux") checks.push(...kvmChecks(await probeKvm(android.sdk)));
  }
  if (options.platforms.ios) checks.push(...(await iosChecks()));
  return checks;
}
