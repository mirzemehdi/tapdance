/**
 * #110: the worker's login service after an update. MOCKED: the service files live in an in-memory
 * map and `exists` is a fake; nothing reads ~/.config, ~/Library or runs systemctl/launchctl.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkWorkerService, describeSimlockPath, hostUpWorkerAction, installedServicePaths, staleServiceLine, workerServiceFile, workerStartArgs } from "./worker-service.js";

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
