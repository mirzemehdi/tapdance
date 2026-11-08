/**
 * Tapdance's patch to Simlock 0.6.0 (`patches/simlock@0.6.0.patch`), tested against the installed,
 * patched Simlock modules. MOCKED: the registry, the drivers' view of the host, adb, the emulator
 * process, the filesystem and the clock are all fakes. Nothing here starts Simlock, adb or an
 * emulator, so none of it proves the behaviour on a real host.
 *
 * #94: a `ready` Android record whose emulator is gone becomes `shutdown` on reconcile (the daemon's
 *      startup pass and `doctor` without `--fix`), so the warm pool boots it again and no lease is
 *      granted a dead serial.
 * #103: when Simlock saves an Android boot snapshot (a seed's, made once per device kind, or a saved
 *      baseline's), it logs one info line with the guest CPU at that moment (one /proc/stat sample
 *      pair, 1 s). In 0.6.0 every Android device is a copy booted from that snapshot. The save
 *      itself is upstream's: the #79 settle wait and the #101 dexopt step (patched into 0.5.0's
 *      baseline capture) were removed after the N2 field run measured no benefit.
 */
import { readFile } from "node:fs/promises";
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
// #103: the guest CPU reading on its own

describe("simlock patch #103 (fake clock and CPU reads): the baseline CPU sample", () => {
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
    const { parseProcStatCpu } = await load("drivers/android/baseline-cpu.js");
    expect(parseProcStatCpu("cpu  100 0 50 800 25 5 5 15 0 0\ncpu0 1 2 3 4\n")).toEqual({ idle: 800, total: 1000 });
    expect(parseProcStatCpu("garbage")).toBeUndefined();
  });

  it("takes one sample pair 1 s apart and rounds the busy share", async () => {
    const { sampleGuestBusy, BASELINE_CPU_SAMPLE_MS } = await load("drivers/android/baseline-cpu.js");
    expect(BASELINE_CPU_SAMPLE_MS).toBe(1_000);
    const c = clock();
    let reads = 0;
    const read = cpu([0.5, 0.953]);
    const busy = await sampleGuestBusy({ ...c, readCpu: async () => (reads++, read()) });
    expect(busy).toBe(0.95);
    expect(reads).toBe(2);
    expect(c.now()).toBe(1_000);
  });

  it("answers undefined, without waiting or throwing, when /proc/stat cannot be read", async () => {
    const { sampleGuestBusy } = await load("drivers/android/baseline-cpu.js");
    const c = clock();
    expect(await sampleGuestBusy({ ...c, readCpu: async () => undefined })).toBeUndefined();
    expect(c.now()).toBe(0);
    expect(await sampleGuestBusy({ ...c, readCpu: async () => Promise.reject(new Error("adb gone")) })).toBeUndefined();
  });

  it("no longer ships the settle wait or the dexopt step (#79, #101 removed after the N2 measurements)", async () => {
    await expect(load("drivers/android/guest-settle.js")).rejects.toThrow();
    const baseline = await load("drivers/android/baseline-cpu.js");
    expect(baseline.waitForGuestSettled).toBeUndefined();
    expect(baseline.settleBeforeBaseline).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------------------------------
// #103: the patched Seeds part saves each boot snapshot, with a scripted adb and emulator

/**
 * Simlock 0.6.0's Seeds part with fakes for every port: adb and the emulator answer from a script,
 * the filesystem is a no-op, the clock moves only when something waits. The sources table is
 * Simlock's own, on an in-memory SQLite database (its `memoryAndroidSourceDatabase` helper).
 * `head -n 1 /proc/stat` answers from `busyShares` (one share per read, the last one repeated;
 * NaN makes the read fail).
 */
async function seedsFor(busyShares: number[]) {
  const { Seeds } = await load("drivers/android/seeds.js");
  const { memoryAndroidSourceDatabase } = await load("drivers/android/testing.js");
  const log: string[] = [];
  const infos: Array<{ message: string; detail: Record<string, unknown> }> = [];
  let t = 0;
  let cpuReads = 0;
  let total = 0;
  let idle = 0;
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const run = async (_command: string, args: string[]) => {
    const line = args.join(" ");
    if (line.endsWith("head -n 1 /proc/stat")) {
      const busy = busyShares[Math.min(cpuReads++, busyShares.length - 1)]!;
      if (Number.isNaN(busy)) return { code: 1, stdout: "", stderr: "error: device offline" };
      total += 400;
      idle += Math.round(400 * (1 - busy));
      log.push(`cpu ${Math.round(busy * 100)}%`);
      return ok(`cpu  ${total - idle} 0 0 ${idle} 0 0 0 0 0 0\n`);
    }
    log.push(line);
    if (line.endsWith("emu avd snapshot list")) return ok("simlock_boot\n");
    return ok();
  };
  const handle = () => ({ kill: () => undefined, wait: async () => ok(), unref: () => undefined });
  const image = { apiLevel: "34", tag: "google_apis", abi: "arm64-v8a", path: "/sdk/system-images/android-34/google_apis/arm64-v8a", version: "1" };
  const logger = {
    info: (message: string, detail: Record<string, unknown>) => void infos.push({ message, detail }),
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  let ids = 0;
  const seeds = new Seeds({
    adb: "adb",
    adbTools: {
      env: () => ({}),
      delay: async (ms: number) => void (t += ms),
      emulatorVersion: async () => "37.2.13",
      runOrThrow: async (command: string, args: string[]) => {
        const result = await run(command, args);
        if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
        return result;
      },
    },
    avdConfig: { currentConfigHash: async () => "hash" },
    avdmanager: "avdmanager",
    catalog: { profileFor: async () => ({ kind: "builtin", avdmanagerId: "pixel_8" }) },
    clock: { now: () => t },
    consolePorts: {
      withReservedPort: async (seed: object, state: { port?: number }) => {
        state.port = 5554;
        return { ...seed, port: 5554, serial: "emulator-5554" };
      },
      release: () => undefined,
    },
    database: await memoryAndroidSourceDatabase(),
    deviceRoot: "/simlock/android",
    deviceTable: { withLock: async (_key: string, fn: () => Promise<unknown>) => fn(), set: () => undefined },
    emulator: {
      start: async (_device: unknown, args: string[]) => {
        log.push(`start ${args.join(" ")}`);
        return handle();
      },
      shutdown: async () => void log.push("shutdown"),
      waitForExit: async () => true,
      stopUnowned: async () => undefined,
    },
    filesystem: {
      mkdirp: async () => undefined,
      rm: async () => undefined,
      copyTree: async () => undefined,
      directorySize: async () => 1,
      readFile: async () => "path=/somewhere\n",
      writeFileAtomic: async () => undefined,
      readdir: async () => [],
    },
    idGenerator: { generate: () => String(++ids) },
    logger,
    ownership: { serialIsOwn: async () => true },
    processRunner: { run },
    systemImages: { requireImage: async () => image, installedImages: async () => [image] },
  });
  const spec = { platform: "android", model: "Pixel 8", osVersion: "34", imageTag: "google_apis" };
  return { seeds, spec, log, infos, now: () => t, cpuReads: () => cpuReads };
}

const SAVE = "-s emulator-5554 emu avd snapshot save simlock_boot";

describe("simlock patch #103 (scripted adb and emulator, fake clock, in-memory sources table): Seeds logs the guest CPU when it saves a boot snapshot and does not wait for it", () => {
  it("making a seed on a busy guest: one sample pair on the snapshot boot, one info line, then the save at once", async () => {
    const { seeds, spec, log, infos, now } = await seedsFor([0.97]);
    await seeds.provision(spec);
    const save = log.indexOf(SAVE);
    expect(save).toBeGreaterThan(0);
    // Two cold boots (the second from a cleanly powered-off disk); the CPU is read on the second only.
    expect(log.filter((l) => l.startsWith("start "))).toEqual(["start -no-snapshot-load", "start -no-snapshot-load"]);
    const secondBoot = log.lastIndexOf("start -no-snapshot-load");
    expect(log.slice(0, secondBoot).some((l) => l.startsWith("cpu "))).toBe(false);
    expect(log.slice(secondBoot, save)).toEqual(["start -no-snapshot-load", "cpu 97%", "cpu 97%"]);
    expect(infos).toEqual([{ message: "Saving the Android boot snapshot", detail: { sourceId: "seed_2", busy: 0.97 } }]);
    expect(log.some((l) => l.includes("bg-dexopt-job"))).toBe(false);
    // Nothing near the old 120 s bound: the sample pair is the only wait.
    expect(now()).toBe(1_000);
  });

  it("logs busy null when /proc/stat cannot be read, and still saves the snapshot", async () => {
    const { seeds, spec, log, infos } = await seedsFor([Number.NaN]);
    await seeds.provision(spec);
    expect(log).toContain(SAVE);
    expect(infos).toEqual([{ message: "Saving the Android boot snapshot", detail: { sourceId: "seed_2", busy: null } }]);
  });

  it("a device copied from a ready seed reads no CPU, saves nothing and logs nothing", async () => {
    const { seeds, spec, log, infos, cpuReads } = await seedsFor([0.05]);
    await seeds.provision(spec);
    const readsBefore = cpuReads();
    const logBefore = log.length;
    await seeds.provision(spec);
    expect(log.slice(logBefore).some((l) => l.startsWith("start ") || l.includes("snapshot save"))).toBe(false);
    expect(cpuReads()).toBe(readsBefore);
    expect(infos).toHaveLength(1);
  });

  it("the patched AndroidDriver hands its logger to Seeds", async () => {
    const source = await readFile(join(simlockDist, "drivers/android/index.js"), "utf8");
    const seedsCall = source.slice(source.indexOf("this.#seeds = new Seeds({"));
    expect(seedsCall.slice(0, seedsCall.indexOf("});"))).toContain("{ logger: options.logger }");
  });
});
