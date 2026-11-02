import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GUARD_LAUNCHD_LABEL,
  guardProgramArguments,
  guardServiceEnvironment,
  guardServicePaths,
  installGuardService,
  launchAgentPlist,
  systemdUnit,
  uninstallGuardService,
  type CommandRunner,
  type GuardServiceSpec,
} from "./service.js";

/**
 * The guard's login service: plist and unit text are checked as strings, and install/uninstall run
 * against a recording fake CommandRunner and a fake file writer. Nothing here calls launchctl or
 * systemctl.
 */

const spec = (over: Partial<GuardServiceSpec> = {}): GuardServiceSpec => ({
  platform: "darwin",
  node: "/opt/node/bin/node",
  cli: "/Users/w/tapdance/packages/cli/dist/main.js",
  startFlags: [],
  keepAwake: false,
  environment: { PATH: "/opt/sdk/platform-tools:/usr/bin:/bin", ANDROID_HOME: "/opt/sdk" },
  home: "/Users/w",
  ...over,
});

function fakeRunner(fail: (file: string, args: string[]) => boolean = () => false) {
  const calls: string[] = [];
  const run: CommandRunner = async (file, args) => {
    calls.push([file, ...args].join(" "));
    return fail(file, args) ? { ok: false, out: "Bootstrap failed: 5: Input/output error" } : { ok: true, out: "" };
  };
  return { calls, run };
}

function fakeFiles() {
  const written = new Map<string, { content: string; mode: number }>();
  return { written, write: async (p: string, content: string, mode: number) => void written.set(p, { content, mode }), remove: async (p: string) => void written.delete(p) };
}

describe("guard service files (pure)", () => {
  it("puts the LaunchAgent and its log where the issue says", () => {
    expect(guardServicePaths("darwin", "/Users/w")).toEqual({
      file: "/Users/w/Library/LaunchAgents/dev.tapdance.guard.plist",
      log: "/Users/w/Library/Logs/tapdance-guard.log",
    });
    expect(guardServicePaths("linux", "/home/w").file).toBe("/home/w/.config/systemd/user/tapdance-guard.service");
  });

  it("runs `worker guard start` with this Node and CLI, passing the user's flags through", () => {
    expect(guardProgramArguments(spec({ startFlags: ["--allow-admin-account"] }))).toEqual([
      "/opt/node/bin/node",
      "/Users/w/tapdance/packages/cli/dist/main.js",
      "worker",
      "guard",
      "start",
      "--allow-admin-account",
    ]);
  });

  it("wraps it in caffeinate -i only on macOS with --keep-awake", () => {
    expect(guardProgramArguments(spec({ keepAwake: true })).slice(0, 3)).toEqual(["/usr/bin/caffeinate", "-i", "/opt/node/bin/node"]);
    expect(guardProgramArguments(spec({ platform: "linux", keepAwake: true }))[0]).toBe("/opt/node/bin/node");
  });

  it("writes a plist with the label, RunAtLoad, KeepAlive, log paths and the environment", () => {
    const plist = launchAgentPlist(spec({ keepAwake: true }));
    expect(plist).toContain(`<key>Label</key>\n  <string>${GUARD_LAUNCHD_LABEL}</string>`);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toContain("<string>/Users/w/Library/Logs/tapdance-guard.log</string>");
    expect(plist.match(/tapdance-guard\.log/g)).toHaveLength(2); // stdout and stderr
    expect(plist).toContain("<string>/usr/bin/caffeinate</string>");
    expect(plist).toContain("<key>ANDROID_HOME</key>\n    <string>/opt/sdk</string>");
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("escapes XML in paths", () => {
    const plist = launchAgentPlist(spec({ cli: "/Users/w/a&b <c>/main.js" }));
    expect(plist).toContain("<string>/Users/w/a&amp;b &lt;c&gt;/main.js</string>");
    expect(plist).not.toContain("a&b");
  });

  it("writes a systemd user unit that restarts on failure, with quoting for spaces, % and $", () => {
    const unit = systemdUnit(spec({ platform: "linux", node: "/home/w/my node/bin/node", cli: "/home/w/td/main.js", environment: { PATH: "/a:/b", TAPDANCE_HOME: "/home/w/100%" } }));
    expect(unit).toContain('ExecStart="/home/w/my node/bin/node" /home/w/td/main.js worker guard start');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain('Environment="PATH=/a:/b"');
    expect(unit).toContain('Environment="TAPDANCE_HOME=/home/w/100%%"');
    expect(systemdUnit(spec({ platform: "linux", startFlags: ["$HOME"] }))).toContain("start $$HOME");
  });

  it("builds a fixed PATH with the Android SDK tools and copies no tokens into the service", () => {
    const env = guardServiceEnvironment(
      { ANDROID_HOME: "/opt/sdk", TAPDANCE_HOME: "/x/td", TAPDANCE_TOKEN: "tdg_secretsecretsecretsecret", TAPDANCE_GUARD_PAIR_NONINTERACTIVE: "1", PATH: "/evil" },
      "/opt/node/bin/node",
    );
    expect(env["PATH"]!.split(":")).toEqual(["/opt/sdk/platform-tools", "/opt/sdk/emulator", "/opt/sdk/cmdline-tools/latest/bin", "/opt/node/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
    expect(env).toEqual({ PATH: env["PATH"], ANDROID_HOME: "/opt/sdk", TAPDANCE_HOME: "/x/td" });
    expect(guardServiceEnvironment({}, "/usr/bin/node")).toEqual({ PATH: "/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin" });
    // Builds need the JDK the owner uses (Kotlin Multiplatform runs Gradle from Xcode).
    const withJava = guardServiceEnvironment({ JAVA_HOME: "/jdk17" }, "/usr/bin/node");
    expect(withJava["JAVA_HOME"]).toBe("/jdk17");
    expect(withJava["PATH"]!.split(":").slice(0, 2)).toEqual(["/usr/bin", "/jdk17/bin"]);
  });
});

describe("guard service install/uninstall (fake launchctl/systemctl)", () => {
  it("macOS: writes the plist with mode 644, boots out an old copy, then bootstraps it", async () => {
    const home = await mkdtemp(join(tmpdir(), "td-svc-"));
    const files = fakeFiles();
    const { calls, run } = fakeRunner((_f, args) => args[0] === "bootout");
    const r = await installGuardService(spec({ home }), { run, uid: 501, write: files.write });
    const plist = join(home, "Library/LaunchAgents/dev.tapdance.guard.plist");
    expect(files.written.get(plist)?.mode).toBe(0o644);
    expect(calls).toEqual([`launchctl bootout gui/501/${GUARD_LAUNCHD_LABEL}`, `launchctl bootstrap gui/501 ${plist}`]);
    expect(r).toMatchObject({ platform: "darwin", file: plist, log: join(home, "Library/Logs/tapdance-guard.log") });
  });

  it("macOS: retries bootstrap after replacing a loaded copy", async () => {
    const home = await mkdtemp(join(tmpdir(), "td-svc-"));
    let bootstraps = 0;
    const { calls, run } = fakeRunner((_f, args) => args[0] === "bootstrap" && ++bootstraps < 2);
    const sleeps: number[] = [];
    await installGuardService(spec({ home }), { run, uid: 501, write: fakeFiles().write, sleep: async (ms) => void sleeps.push(ms) });
    expect(calls.filter((c) => c.startsWith("launchctl bootstrap"))).toHaveLength(2);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("macOS: falls back to `launchctl load -w`, and reports the command and output when both fail", async () => {
    const home = await mkdtemp(join(tmpdir(), "td-svc-"));
    const fallback = fakeRunner((_f, args) => args[0] === "bootstrap" || args[0] === "bootout");
    await installGuardService(spec({ home }), { run: fallback.run, uid: 501, write: fakeFiles().write });
    expect(fallback.calls.at(-1)).toMatch(/^launchctl load -w .*dev\.tapdance\.guard\.plist$/);

    const broken = fakeRunner(() => true);
    const error = await installGuardService(spec({ home }), { run: broken.run, uid: 501, write: fakeFiles().write }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INTERNAL", details: { command: expect.stringMatching(/^launchctl load -w /), output: expect.stringContaining("Bootstrap failed") } });
  });

  it("leaves a running service with the same file alone (a restart would orphan current leases)", async () => {
    const home = await mkdtemp(join(tmpdir(), "td-svc-"));
    const { file } = guardServicePaths("darwin", home);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(file, launchAgentPlist(spec({ home })));
    const calls: string[] = [];
    const run: CommandRunner = async (f, args) => {
      calls.push([f, ...args].join(" "));
      return { ok: true, out: args[0] === "print" ? "\tstate = running\n" : "" };
    };
    expect(await installGuardService(spec({ home }), { run, uid: 501 })).toMatchObject({ unchanged: true });
    expect(calls).toEqual([`launchctl print gui/501/${GUARD_LAUNCHD_LABEL}`]);
    // A changed file (here: --keep-awake) is installed again.
    const changed = await installGuardService(spec({ home, keepAwake: true }), { run, uid: 501, sleep: async () => undefined });
    expect(changed.unchanged).toBeUndefined();
    expect(calls).toContain(`launchctl bootstrap gui/501 ${file}`);
  });

  it("Linux: writes the unit, reloads, enables and restarts it", async () => {
    const files = fakeFiles();
    const { calls, run } = fakeRunner();
    await installGuardService(spec({ platform: "linux", home: "/home/w" }), { run, uid: 1000, write: files.write });
    expect(files.written.get("/home/w/.config/systemd/user/tapdance-guard.service")?.mode).toBe(0o644);
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable tapdance-guard.service",
      "systemctl --user restart tapdance-guard.service",
    ]);
  });

  it("uninstall boots the agent out (or disables the unit) and removes the file", async () => {
    const mac = fakeRunner();
    const files = fakeFiles();
    const r = await uninstallGuardService("darwin", "/Users/nobody-here", { run: mac.run, uid: 501, remove: files.remove });
    expect(mac.calls).toEqual([`launchctl bootout gui/501/${GUARD_LAUNCHD_LABEL}`]);
    expect(r.removed).toBe(false);
    const linux = fakeRunner();
    await uninstallGuardService("linux", "/home/nobody-here", { run: linux.run, uid: 1000, remove: files.remove });
    expect(linux.calls).toEqual(["systemctl --user disable --now tapdance-guard.service", "systemctl --user daemon-reload"]);
  });
});
