/**
 * #110: the worker's login service after an update. MOCKED: the service files live in an in-memory
 * map and `exists` is a fake; nothing reads ~/.config, ~/Library or runs systemctl/launchctl.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, TapdanceError } from "@tapdance/sdk";
import {
  checkWorkerService,
  describeSimlockPath,
  hostUpWorkerAction,
  installServiceOrReport,
  installedServicePaths,
  missingServiceWarning,
  parseMissingServiceRecord,
  precheckServiceRefresh,
  staleServiceLine,
  workerServiceFile,
  workerStartArgs,
  type MissingServiceRecord,
  type ServiceRefreshIo,
} from "./worker-service.js";

const store = "/home/u/tapdance/node_modules/.pnpm";
const OLD = `${store}/simlock@0.5.0_patch_hash=52e37d12aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/node_modules/simlock/dist/daemon/main.js`;
const NEW = `${store}/simlock@0.5.0_patch_hash=c76b69d8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/node_modules/simlock/dist/daemon/main.js`;
const NODE = "/usr/bin/node";

/** A systemd unit as Simlock 0.5.0's `daemon install` writes it. */
const unit = (main: string, node = NODE) => `[Unit]
Description=simlock worker daemon
StartLimitIntervalSec=0

[Service]
ExecStart=${node} ${main}
Environment="SIMLOCK_HOME=/home/u/.simlock"
Restart=on-failure
`;

/** A launchd plist as Simlock 0.5.0's `daemon install` writes it. */
const plist = (main: string, node = NODE) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.callstack.simlock.worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${main.replaceAll("&", "&amp;")}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SIMLOCK_HOME</key>
    <string>/Users/u/.simlock</string>
  </dict>
</dict>
</plist>
`;

function fakeFs(files: Record<string, string>, existing: string[] = [NODE, OLD, NEW]) {
  return {
    readFile: async (path: string) => {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[path]!;
    },
    exists: async (path: string) => existing.includes(path),
  };
}

const linux = { platform: "linux" as const, home: "/home/u", simlockHome: "/home/u/.simlock", env: {}, wanted: { node: NODE, main: NEW } };
const mac = { platform: "darwin" as const, home: "/Users/u", simlockHome: "/Users/u/.simlock", env: {}, wanted: { node: NODE, main: NEW } };
const UNIT = "/home/u/.config/systemd/user/com.callstack.simlock.worker.service";
const PLIST = "/Users/u/Library/LaunchAgents/com.callstack.simlock.worker.plist";

describe("worker login service after an update (#110; MOCKED service files)", () => {
  it("finds the service file where Simlock puts it: systemd, XDG_CONFIG_HOME, launchd, a custom SIMLOCK_HOME", () => {
    expect(workerServiceFile(linux)).toEqual({ manager: "systemd", name: "com.callstack.simlock.worker", path: UNIT });
    expect(workerServiceFile({ ...linux, env: { XDG_CONFIG_HOME: "/cfg" } })?.path).toBe("/cfg/systemd/user/com.callstack.simlock.worker.service");
    expect(workerServiceFile({ ...linux, env: { XDG_CONFIG_HOME: "relative" } })?.path).toBe(UNIT);
    expect(workerServiceFile(mac)).toEqual({ manager: "launchd", name: "com.callstack.simlock.worker", path: PLIST });
    const hash = createHash("sha256").update("/srv/simlock").digest("hex").slice(0, 6);
    expect(workerServiceFile({ ...linux, simlockHome: "/srv/simlock" })?.name).toBe(`com.callstack.simlock.worker.${hash}`);
    expect(workerServiceFile({ ...linux, platform: "win32" })).toBeUndefined();
  });

  it("reads the Node and Simlock paths a unit or plist starts", () => {
    expect(installedServicePaths(unit(OLD), "systemd")).toEqual({ node: NODE, main: OLD });
    expect(installedServicePaths(plist(`${OLD}&x`), "launchd")).toEqual({ node: NODE, main: `${OLD}&x` });
    expect(installedServicePaths("[Service]\n", "systemd")).toEqual({});
    expect(describeSimlockPath(OLD)).toBe("simlock 0.5.0 (patch 52e37d12)");
    expect(describeSimlockPath("/opt/simlock/dist/daemon/main.js")).toBe("/opt/simlock/dist/daemon/main.js");
  });

  it("calls a unit pointing at the old patch folder stale, and the new one current", async () => {
    const stale = await checkWorkerService(linux, fakeFs({ [UNIT]: unit(OLD) }));
    expect(stale).toMatchObject({ state: "stale", path: UNIT, manager: "systemd", installed: { node: NODE, main: OLD } });
    expect(stale.reasons).toEqual(["it starts simlock 0.5.0 (patch 52e37d12), this Tapdance ships simlock 0.5.0 (patch c76b69d8)"]);
    expect(staleServiceLine(stale)).toMatch(/out of date: it starts simlock 0.5.0 \(patch 52e37d12\).*Installing it again.*learned spares are kept/);
    expect(await checkWorkerService(linux, fakeFs({ [UNIT]: unit(NEW) }))).toMatchObject({ state: "current" });
    // launchd the same way.
    expect((await checkWorkerService(mac, fakeFs({ [PLIST]: plist(OLD) }))).state).toBe("stale");
    expect((await checkWorkerService(mac, fakeFs({ [PLIST]: plist(NEW) }))).state).toBe("current");
  });

  it("calls a service stale when its Node or Simlock is gone, but not for another Node that still exists", async () => {
    expect((await checkWorkerService(linux, fakeFs({ [UNIT]: unit(NEW, "/old/node") }, [NODE, NEW]))).reasons).toEqual(["its Node (/old/node) is gone"]);
    expect((await checkWorkerService(linux, fakeFs({ [UNIT]: unit(NEW) }, [NODE]))).reasons).toEqual([`its Simlock (${NEW}) is gone`]);
    expect((await checkWorkerService(linux, fakeFs({ [UNIT]: unit(NEW, "/other/node") }, ["/other/node", NODE, NEW]))).state).toBe("current");
  });

  it("no service file means nothing to rewrite", async () => {
    expect(await checkWorkerService(linux, fakeFs({}))).toEqual({ state: "none" });
    expect(await checkWorkerService({ ...linux, platform: "win32" }, fakeFs({}))).toEqual({ state: "none" });
  });

  it("a stale service is started with `daemon install` (rewrite + reload), a current one with `daemon start`", async () => {
    // The rewrite itself is Simlock's: `daemon install` writes the unit from the running Simlock and
    // reloads systemd/launchd. Here a fake Simlock CLI rewrites the fake unit the same way.
    const files: Record<string, string> = { [UNIT]: unit(OLD) };
    const io = fakeFs(files);
    const simlock = async (args: string[]) => {
      if (args.join(" ") === "daemon install") files[UNIT] = unit(NEW);
      return "";
    };
    const before = await checkWorkerService(linux, io);
    expect(workerStartArgs(before)).toEqual(["daemon", "install"]);
    await simlock(workerStartArgs(before));
    const after = await checkWorkerService(linux, io);
    expect(after.state).toBe("current");
    expect(workerStartArgs(after)).toEqual(["daemon", "start"]);
    expect(workerStartArgs({ state: "none" })).toEqual(["daemon", "start"]);
  });

  it("host up: refreshes a stale service when idle, warns while leases run, leaves a current one, and new warm counts win", () => {
    const stale = { state: "stale" as const, reasons: ["x"] };
    const current = { state: "current" as const };
    expect(hostUpWorkerAction({ warm: false, service: stale, activeLeases: 0 })).toBe("refresh-service");
    expect(hostUpWorkerAction({ warm: false, service: stale, activeLeases: 1 })).toBe("warn-stale-busy");
    expect(hostUpWorkerAction({ warm: false, service: current, activeLeases: 0 })).toBe("leave");
    expect(hostUpWorkerAction({ warm: false, service: { state: "none" }, activeLeases: 0 })).toBe("leave");
    // applyWarm restarts the worker, and that restart installs a stale service again.
    expect(hostUpWorkerAction({ warm: true, service: stale, activeLeases: 0 })).toBe("apply-warm");
  });
});

/**
 * #118: refreshing a stale service over a non-interactive ssh command. MOCKED: systemctl, Simlock's
 * `daemon install`/`start` and the record file are fakes; nothing runs systemctl or touches ~/.tapdance.
 */
describe("login service refresh without a user bus (#118; MOCKED runner and files)", () => {
  const stale = { state: "stale" as const, path: UNIT, manager: "systemd" as const, reasons: ["it starts simlock 0.5.0 (patch 52e37d12), this Tapdance ships simlock 0.5.0 (patch c76b69d8)"] };
  const NO_BUS = 'simlock --local daemon install failed: {"error":{"code":"SERVICE_FAILED","message":"systemctl --user daemon-reload failed: Failed to connect to bus: No medium found"}}';

  /** A fake host: Simlock's install removes the unit first, then fails without a bus (as on the N2 VM). */
  function fakeHost(o: { bus: boolean; platform?: NodeJS.Platform; startFails?: boolean }) {
    const files: Record<string, string> = { [UNIT]: unit(OLD) };
    const calls: string[] = [];
    let record: MissingServiceRecord | undefined;
    const io: ServiceRefreshIo = {
      platform: o.platform ?? "linux",
      prepareUserServices: async () => void calls.push("prepare"),
      userManagerReachable: async () => (calls.push("systemctl --user show-environment"), o.bus ? { ok: true, out: "HOME=/home/u" } : { ok: false, out: "Failed to connect to bus: No medium found" }),
      install: async () => {
        calls.push("daemon install");
        delete files[UNIT];
        if (!o.bus) throw new TapdanceError("PROVIDER_UNAVAILABLE", NO_BUS);
        files[UNIT] = unit(NEW);
      },
      start: async () => {
        calls.push("daemon start");
        if (o.startFails) throw new Error("no");
      },
      serviceFileExists: async () => UNIT in files,
      recordMissing: async (r) => void (record = r),
      clearMissing: async () => void (record = undefined),
      now: () => new Date("2026-11-05T10:00:00Z"),
    };
    return { io, files, calls, record: () => record };
  }

  it("checks that systemctl --user answers before anything is stopped, and changes nothing when it does not", async () => {
    const h = fakeHost({ bus: false });
    const error = await precheckServiceRefresh(stale, h.io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TapdanceError);
    expect(error).toMatchObject({ code: "HOST_CHECK_FAILED", hint: expect.stringContaining("tapdance worker install --service") });
    expect((error as Error).message).toMatch(/cannot reach this account's user manager \(Failed to connect to bus: No medium found\).*Nothing was changed/);
    expect(h.calls).toEqual(["prepare", "systemctl --user show-environment"]);
    expect(h.files[UNIT]).toBe(unit(OLD));
    // With a bus, with nothing stale, or on macOS, the check passes.
    await expect(precheckServiceRefresh(stale, fakeHost({ bus: true }).io)).resolves.toBeUndefined();
    const none = fakeHost({ bus: false });
    await precheckServiceRefresh({ state: "current" }, none.io);
    await precheckServiceRefresh(stale, { ...none.io, platform: "darwin" });
    expect(none.calls).toEqual([]);
  });

  it("a failed install says the login service is now missing, starts the worker without it, records it and exits non-zero", async () => {
    const h = fakeHost({ bus: false });
    const error = (await installServiceOrReport(stale, h.io).catch((e: unknown) => e)) as TapdanceError;
    expect(error).toBeInstanceOf(TapdanceError);
    expect(error.code).toBe("HOST_CHECK_FAILED");
    expect(ERROR_CODES[error.code]).not.toBe(0);
    expect(error.message).toContain(`The login service is now missing (${UNIT} was removed): the worker was started without it`);
    expect(error.hint).toMatch(/^Run `tapdance worker install --service` to install it again/);
    expect(h.calls).toEqual(["daemon install", "daemon start"]);
    expect(h.record()).toEqual({ path: UNIT, failedAt: "2026-11-05T10:00:00.000Z", reason: NO_BUS });
    // A worker that does not start either is said to be stopped.
    const dead = fakeHost({ bus: false, startFails: true });
    await expect(installServiceOrReport(stale, dead.io)).rejects.toThrow(/the worker is stopped/);
  });

  it("a successful install clears an earlier record", async () => {
    const h = fakeHost({ bus: true });
    await h.io.recordMissing({ path: UNIT, failedAt: "x", reason: "y" });
    await installServiceOrReport(stale, h.io);
    expect(h.files[UNIT]).toBe(unit(NEW));
    expect(h.record()).toBeUndefined();
    expect(h.calls).toEqual(["daemon install"]);
  });

  it("a later restart, start or host status warns while the recorded service is still missing", () => {
    const record = parseMissingServiceRecord(JSON.stringify({ path: UNIT, failedAt: "2026-11-05T10:00:00.000Z", reason: NO_BUS }));
    expect(record).toBeDefined();
    const warning = missingServiceWarning(record, { state: "none" });
    expect(warning).toMatch(/^The worker has no login service \(.*com\.callstack\.simlock\.worker\.service\): installing it again failed at 2026-11-05T10:00:00\.000Z/);
    expect(warning).toContain("Run `tapdance worker install --service`.");
    // Once a service is back (current or stale), or without a record, there is nothing to say.
    expect(missingServiceWarning(record, { state: "current" })).toBeUndefined();
    expect(missingServiceWarning(record, stale)).toBeUndefined();
    expect(missingServiceWarning(undefined, { state: "none" })).toBeUndefined();
    expect(parseMissingServiceRecord("not json")).toBeUndefined();
    expect(parseMissingServiceRecord(JSON.stringify({ path: 1 }))).toBeUndefined();
    expect(parseMissingServiceRecord(undefined)).toBeUndefined();
  });
});
