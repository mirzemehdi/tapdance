/**
 * Tapdance's patch to Simlock 0.5.0 (`patches/simlock@0.5.0.patch`), tested against the installed,
 * patched Simlock modules. MOCKED: the registry, the drivers' view of the host, adb, the emulator
 * process, the filesystem and the clock are all fakes. Nothing here starts Simlock, adb or an
 * emulator, so none of it proves the behaviour on a real host.
 *
 * #94: a `ready` Android record whose emulator is gone becomes `shutdown` on reconcile (the daemon's
 *      startup pass and `doctor` without `--fix`), so the warm pool boots it again and no lease is
 *      granted a dead serial.
 * #79: before Simlock captures an Android device's clean baseline snapshot (once, on its first boot),
 *      it waits for a calm guest CPU (bounded at 120 s). Other boots and reclaims do not wait.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const simlockDist = dirname(dirname(createRequire(import.meta.url).resolve("simlock/admin")));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = async (path: string): Promise<any> => import(pathToFileURL(join(simlockDist, path)).href);

// ---------------------------------------------------------------------------------------------------
// #94: Doctor.reconcile

interface DeviceRecord {
  id: string;
  driverDeviceId: string;
  spec: { platform: "android" | "ios" };
  state: string;
  leaseIdentity: string;
  foreignStateDetectedAt?: number;
}

/** A fake registry: the snapshot Doctor reads and the calls its ready->shutdown fix makes. */
function fakeRegistry(devices: DeviceRecord[], leases: Array<{ id: string; deviceId: string; ttlDeadline: number }> = []) {
  const transitions: Array<{ deviceId: string; to: string; event: unknown }> = [];
  const registry = {
    get snapshot() {
      return { devices, leases, virtualDevices: devices };
    },
    transitionDevice: async (deviceId: string, to: string, event: unknown) => {
      const device = devices.find((d) => d.id === deviceId)!;
      // The real registry allows ready->shutdown (event device.shutdown) and nothing else here.
      if (!(device.state === "ready" && to === "shutdown")) throw new Error(`illegal ${device.state} -> ${to}`);
      device.state = to;
      transitions.push({ deviceId, to, event });
      return device;
    },
    markForeignStateDetected: async (deviceId: string, at: number) => {
      devices.find((d) => d.id === deviceId)!.foreignStateDetectedAt = at;
    },
    clearForeignStateDetected: async (deviceId: string) => {
      delete devices.find((d) => d.id === deviceId)!.foreignStateDetectedAt;
    },
  };
  return { registry, transitions };
}

/** A driver as Doctor sees it: `listManaged` reports which AVDs are running. */
function fakeDriver(platform: "android" | "ios", runState: Record<string, "running" | "stopped" | "transitioning">) {
  return {
    platform,
    listManaged: async () => ({
      devices: Object.entries(runState).map(([deviceId, state]) => ({ address: "", deviceId, driverData: {}, runState: state })),
      processes: [],
    }),
    estimate: () => 70_000,
  };
}

async function doctorFor(devices: DeviceRecord[], drivers: ReturnType<typeof fakeDriver>[], leases?: Array<{ id: string; deviceId: string; ttlDeadline: number }>) {
  const { Doctor } = await load("core/doctor.js");
  const { SerializedDecision } = await load("core/serialized-decision.js");
  const { registry, transitions } = fakeRegistry(devices, leases);
  const events: string[] = [];
  const doctor = new Doctor({
    clock: { now: () => 1_000 },
    config: { stalledTransition: { minimumThresholdMs: 60_000, thresholdMultiplier: 3 }, warmPool: { enabled: false, targets: [] } },
    decisions: new SerializedDecision(),
    drivers,
    eventBus: { emit: (name: string) => void events.push(name) },
    registry,
  });
  return { doctor, events, transitions };
}

const android = (id: string, state: string): DeviceRecord => ({ driverDeviceId: id, id: `dev-${id}`, leaseIdentity: "reusable", spec: { platform: "android" }, state });

describe("simlock patch #94 (mocked registry and driver): reconcile shuts down a ready Android record whose emulator is gone", () => {
  it("moves a ready record with no running emulator to shutdown without --fix, through doctor's own transition", async () => {
    const devices = [android("avd-gone", "ready"), android("avd-up", "ready")];
    const { doctor, transitions } = await doctorFor(devices, [fakeDriver("android", { "avd-gone": "stopped", "avd-up": "running" })]);
    const report = await doctor.reconcile();
    expect(transitions).toEqual([
      { deviceId: "dev-avd-gone", to: "shutdown", event: { event: "device.shutdown", payload: { deviceId: "dev-avd-gone", initiator: "doctor" } } },
    ]);
    expect(devices.map((d) => d.state)).toEqual(["shutdown", "ready"]);
    // The foreign-state flag is cleared once the record agrees with the host again.
    expect(devices[0]!.foreignStateDetectedAt).toBeUndefined();
    // The report still names what was found, as `doctor --fix` does.
    expect(report.findings.some((f: { kind: string; deviceId?: string }) => f.kind === "foreign-state-change" && f.deviceId === "dev-avd-gone")).toBe(true);
  });

  it("does the same on the daemon's startup pass, which hands doctor the startup read", async () => {
    const devices = [android("avd-gone", "ready")];
    const driver = fakeDriver("android", { "avd-gone": "stopped" });
    const { doctor, transitions } = await doctorFor(devices, [driver]);
    const reality = await driver.listManaged();
    await doctor.reconcile({ read: { reality: (platform: string) => (platform === "android" ? reality : undefined) } });
    expect(transitions.map((t) => t.to)).toEqual(["shutdown"]);
  });

  it("leaves a running emulator, a booting one (transitioning), a leased device and iOS alone", async () => {
    const devices = [
      android("avd-up", "ready"),
      android("avd-booting", "ready"),
      android("avd-leased", "leased"),
      { driverDeviceId: "sim-1", id: "dev-sim-1", leaseIdentity: "reusable", spec: { platform: "ios" as const }, state: "ready" },
    ];
    const { doctor, transitions } = await doctorFor(
      devices,
      [fakeDriver("android", { "avd-up": "running", "avd-booting": "transitioning", "avd-leased": "stopped" }), fakeDriver("ios", { "sim-1": "stopped" })],
      [{ deviceId: "dev-avd-leased", id: "lease-1", ttlDeadline: 10_000 }],
    );
    await doctor.reconcile();
    expect(transitions).toEqual([]);
    expect(devices.map((d) => d.state)).toEqual(["ready", "ready", "leased", "ready"]);
  });
});

// ---------------------------------------------------------------------------------------------------
// #79: the settle wait on its own

describe("simlock patch #79 (fake clock and CPU reads): waitForGuestSettled", () => {
  const cpu = (busyShares: number[]) => {
    let total = 0;
    let idle = 0;
    let i = 0;
    return async () => {
      const busy = busyShares[Math.min(i++, busyShares.length - 1)]!;
      total += 400;
      idle += Math.round(400 * (1 - busy));
      return { idle, total };
    };
  };
  const clock = () => {
    let t = 0;
    return { delay: async (ms: number) => void (t += ms), now: () => t };
  };

  it("parses the cpu line of /proc/stat", async () => {
    const { parseProcStatCpu } = await load("drivers/android/guest-settle.js");
    expect(parseProcStatCpu("cpu  100 0 50 800 25 5 5 15 0 0\ncpu0 1 2 3 4\n")).toEqual({ idle: 800, total: 1000 });
    expect(parseProcStatCpu("garbage")).toBeUndefined();
  });

  it("returns after two calm intervals on a calm guest", async () => {
    const { waitForGuestSettled } = await load("drivers/android/guest-settle.js");
    const c = clock();
    const result = await waitForGuestSettled({ ...c, readCpu: cpu([0.05]) });
    expect(result).toMatchObject({ settled: true, waitedMs: 2_000 });
  });

  it("waits while the guest is busy, and a busy interval restarts the count", async () => {
    const { waitForGuestSettled } = await load("drivers/android/guest-settle.js");
    const c = clock();
    // read 1 is the baseline; intervals: busy x4, calm, busy, calm, calm
    const result = await waitForGuestSettled({ ...c, readCpu: cpu([0.9, 0.95, 0.9, 0.9, 0.9, 0.1, 0.9, 0.1, 0.1]) });
    expect(result).toMatchObject({ settled: true, waitedMs: 8_000 });
  });

  it("gives up at the 120 s bound on a guest that stays busy, without throwing", async () => {
    const { waitForGuestSettled, GUEST_SETTLE_BOUND_MS } = await load("drivers/android/guest-settle.js");
    expect(GUEST_SETTLE_BOUND_MS).toBe(120_000);
    const c = clock();
    const result = await waitForGuestSettled({ ...c, readCpu: cpu([0.98]) });
    expect(result).toMatchObject({ reason: "bound", settled: false, waitedMs: 120_000 });
  });

  it("does not wait when /proc/stat cannot be read", async () => {
    const { waitForGuestSettled } = await load("drivers/android/guest-settle.js");
    const c = clock();
    const result = await waitForGuestSettled({ ...c, readCpu: async () => undefined });
    expect(result).toMatchObject({ reason: "unreadable", settled: false, waitedMs: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------
// #79: the patched AndroidDriver's readiness, with a scripted adb and emulator

/** A clock whose timers fire on the next turn of the event loop, moving time forward to their deadline. */
function autoClock() {
  let t = 0;
  const cancelled = new Set<object>();
  return {
    now: () => t,
    setTimer: (ms: number, callback: () => void) => {
      const handle = {};
      setImmediate(() => {
        if (cancelled.has(handle)) return;
        t += ms;
        callback();
      });
      return handle;
    },
    cancel: (handle: object) => void cancelled.add(handle),
  };
}

function memoryFs() {
  const files = new Map<string, string>();
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return {
    files,
    exists: async (path: string) => files.has(path),
    readFile: async (path: string) => {
      if (!files.has(path)) throw enoent(path);
      return files.get(path)!;
    },
    writeFileAtomic: async (path: string, contents: string) => void files.set(path, contents),
    rm: async (path: string) => void files.delete(path),
    realpath: async (path: string) => path,
    readdir: async () => [],
  };
}

/**
 * A process runner standing in for adb and the emulator: the guest boots at once, and
 * `head -n 1 /proc/stat` answers from `busyShares` (one share per read, the last one repeated).
 */
function scriptedRunner(busyShares: number[], deviceRoot: string, avdName: string) {
  const log: string[] = [];
  let reads = 0;
  let total = 0;
  let idle = 0;
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const run = async (_command: string, args: string[]) => {
    const line = args.join(" ");
    if (line.endsWith("head -n 1 /proc/stat")) {
      const busy = busyShares[Math.min(reads++, busyShares.length - 1)]!;
      total += 400;
      idle += Math.round(400 * (1 - busy));
      log.push(`cpu ${Math.round(busy * 100)}%`);
      return ok(`cpu  ${total - idle} 0 0 ${idle} 0 0 0 0 0 0\n`);
    }
    log.push(line);
    if (line.endsWith("getprop sys.boot_completed")) return ok("1\n");
    if (line.endsWith("getprop init.svc.bootanim")) return ok("stopped\n");
    if (line.endsWith("emu avd path")) return ok(`${deviceRoot}/${avdName}.avd\nOK\n`);
    if (line.endsWith("pm path android")) return ok("package:/system/framework/framework-res.apk\n");
    if (line.endsWith("emu avd snapshot list")) return ok("simlock_clean_baseline\n");
    return ok();
  };
  const spawn = (command: string, args: string[]) => {
    log.push(`spawn ${command} ${args.join(" ")}`);
    const result = ok(args.includes("load") ? "OK\n" : "");
    return { unref: () => undefined, kill: () => undefined, wait: async () => result };
  };
  return { log, processRunner: { run, spawn }, cpuReads: () => reads };
}

async function androidDriver(busyShares: number[]) {
  const { AndroidDriver } = await load("drivers/android/index.js");
  const deviceRoot = "/simlock/android";
  const avdName = "avd1";
  const clock = autoClock();
  const runner = scriptedRunner(busyShares, deviceRoot, avdName);
  const warnings: Array<{ message: string; detail: Record<string, unknown> }> = [];
  const logger = {
    warn: (message: string, detail: Record<string, unknown>) => void warnings.push({ message, detail }),
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
  };
  const options = {
    clock,
    env: {},
    filesystem: memoryFs(),
    homeDirectory: "/home/test",
    logger,
    processRunner: runner.processRunner,
    tcpProbe: { isListening: async () => false },
  };
  const sdk = { adb: "adb", avdmanager: "avdmanager", emulator: "emulator", root: "/sdk" };
  const driver = new AndroidDriver(options, sdk, deviceRoot, {}, {}, 5038);
  const device = { address: "", deviceId: avdName, driverData: { avdName, configHash: "x", imageIdentity: "img", port: 0, serial: "" } };
  return { clock, device, driver, runner, warnings };
}

describe("simlock patch #79 (scripted adb and emulator, fake clock): AndroidDriver waits for a calm guest only before the baseline capture", () => {
  it("first boot: the clean baseline is saved only after the guest CPU calms down; the boot from it does not wait", async () => {
    // 6 busy reads, then calm.
    const { clock, device, driver, runner, warnings } = await androidDriver([0.97, 0.97, 0.97, 0.97, 0.97, 0.97, 0.05]);
    const ready = await driver.makeReady(device, { purpose: "prepare" });
    expect(ready.address).toBe("emulator-5586");
    const save = runner.log.indexOf("-s emulator-5586 emu avd snapshot save simlock_clean_baseline");
    expect(save).toBeGreaterThan(0);
    // The baseline is saved after the busy reads and the two calm ones that settled the guest.
    const beforeSave = runner.log.slice(0, save).filter((l) => l.startsWith("cpu "));
    expect(beforeSave).toEqual(["cpu 97%", "cpu 97%", "cpu 97%", "cpu 97%", "cpu 97%", "cpu 97%", "cpu 5%", "cpu 5%"]);
    // The restart from the new baseline is marked ready as upstream does it: no CPU reads after the save.
    expect(runner.log.slice(save).filter((l) => l.startsWith("cpu "))).toEqual([]);
    expect(clock.now()).toBeGreaterThanOrEqual(7_000);
    expect(warnings.filter((w) => w.message.includes("still busy"))).toEqual([]);
  });

  it("gives up at the 120 s bound on a guest that stays busy and captures the baseline as before", async () => {
    const { clock, device, driver, runner, warnings } = await androidDriver([0.98]);
    const ready = await driver.makeReady(device, { purpose: "prepare" });
    expect(ready.address).toBe("emulator-5586");
    const busy = warnings.filter((w) => w.message.includes("still busy"));
    expect(busy.map((w) => w.detail["reason"])).toEqual(["bound"]);
    expect(runner.log).toContain("-s emulator-5586 emu avd snapshot save simlock_clean_baseline");
    expect(clock.now()).toBeGreaterThanOrEqual(120_000);
    expect(clock.now()).toBeLessThan(130_000);
  });

  it("a boot from an existing baseline does not wait, however busy the guest", async () => {
    const { device, driver, runner, warnings } = await androidDriver([0.05, 0.05, 0.05, 0.98]);
    const ready = await driver.makeReady(device, { purpose: "prepare" });
    await driver.shutdown({ ...device, address: ready.address, driverData: ready.driverData });
    const readsBefore = runner.cpuReads();
    const logBefore = runner.log.length;
    await driver.makeReady({ ...device, driverData: ready.driverData }, { purpose: "prepare" });
    expect(runner.log.slice(logBefore).some((l) => l.includes("-snapshot simlock_clean_baseline"))).toBe(true);
    expect(runner.log.slice(logBefore).some((l) => l.includes("snapshot save"))).toBe(false);
    expect(runner.cpuReads()).toBe(readsBefore);
    expect(warnings).toEqual([]);
  });

  it("a reclaim's snapshot load does not wait", async () => {
    const { device, driver, runner } = await androidDriver([0.05, 0.05, 0.05, 0.98]);
    const ready = await driver.makeReady(device, { purpose: "prepare" });
    const readsBefore = runner.cpuReads();
    const result = await driver.reclaim({ ...device, address: ready.address, driverData: ready.driverData }, { clean: "standard" });
    expect(result).toEqual({ state: "ready", strategy: "snapshot" });
    expect(runner.log.some((l) => l.includes("emu avd snapshot load simlock_clean_baseline"))).toBe(true);
    expect(runner.cpuReads()).toBe(readsBefore);
  });
});
