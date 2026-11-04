import { describe, expect, it } from "vitest";
import { TapdanceError, type DoctorCheck } from "@tapdance/sdk";
import {
  assertHostPlatform,
  cloudCheck,
  cloudCostNote,
  defaultLabel,
  describeCatalog,
  detectCloudVm,
  findOnPath,
  formatStepFailure,
  hostEndpoint,
  hostUpCommand,
  installInstructions,
  mcpSnippets,
  pairingTokenPath,
  parseTailscaleStatus,
  renderReadyBlock,
  serveHasPort,
  summarizePrerequisites,
  serveModeOf,
  tailscaleServeArgs,
  tailscaleServeOffArgs,
  tokenFingerprint,
  clipboardCommand,
  parseWarm,
  warmSettings,
  withoutWarmSettings,
  describeWarm,
  linuxEmulatorSettings,
  parseLinger,
  serveNeedsOperator,
  parseIdleStop,
  parseMaxUptime,
  resolveHostStop,
  describeIdle,
  choosePairingLabel,
  pairingApprovalRefusal,
  offerClipboard,
  hostSecurityNote,
  tailscaleAclHint,
  describePlatforms,
  describeWorkerDevices,
} from "./plan.js";

/** Pure parts of `host up/status/down` and `connect`. No test here runs tailscale, launchctl, Simlock or a device. */

const check = (id: string, status: DoctorCheck["status"], fix?: string): DoctorCheck => ({ id, title: id, status, detail: "", ...(fix ? { fix } : {}) });
const android = ["host.android.sdk", "host.android.adb", "host.android.emulator", "host.android.cmdline-tools", "host.android.images"];

describe("platform refusal", () => {
  it("refuses Windows with NOT_SUPPORTED and points at `tapdance connect`", () => {
    const e = (() => {
      try {
        assertHostPlatform("win32");
      } catch (error) {
        return error as TapdanceError;
      }
      return undefined;
    })();
    expect(e).toBeInstanceOf(TapdanceError);
    expect(e?.code).toBe("NOT_SUPPORTED");
    expect(e?.exitCode).toBe(8);
    expect(e?.message).toContain("macOS and Linux only");
    expect(e?.hint).toContain("tapdance connect");
    expect(e?.hint).toContain("WSL2");
  });

  it("accepts macOS and Linux", () => {
    expect(assertHostPlatform("darwin")).toBe("darwin");
    expect(assertHostPlatform("linux")).toBe("linux");
    expect(() => assertHostPlatform("freebsd")).toThrow(/cannot host devices/);
  });
});

describe("prerequisites", () => {
  it("needs every Android piece and no failed KVM or cloud check for Android", () => {
    const all = [check("host.node", "pass"), ...android.map((id) => check(id, "pass"))];
    expect(summarizePrerequisites(all)).toMatchObject({ android: true, ios: false });
    expect(summarizePrerequisites([...all, check("host.kvm.device", "fail")]).android).toBe(false);
    expect(summarizePrerequisites([...all, check("host.cloud", "fail")]).android).toBe(false);
    expect(summarizePrerequisites(all.map((c) => (c.id === "host.android.images" ? { ...c, status: "warn" as const } : c))).android).toBe(false);
  });

  it("needs Xcode and a runtime for iOS, and lists problems", () => {
    const r = summarizePrerequisites([check("host.ios.xcode", "pass"), check("host.ios.runtimes", "pass"), check("host.jdk", "warn", "Install a JDK")]);
    expect(r.ios).toBe(true);
    expect(r.problems.map((c) => c.id)).toEqual(["host.jdk"]);
  });

  it("prints install commands, with brew lines on macOS only and the right image ABI", () => {
    const checks = [check("host.android.cmdline-tools", "fail", "Install the command-line tools")];
    const mac = installInstructions(checks, "darwin", "arm64");
    expect(mac[0]).toBe("host.android.cmdline-tools: Install the command-line tools");
    expect(mac.join("\n")).toContain("brew install --cask android-commandlinetools");
    expect(mac.join("\n")).toContain("google_apis;arm64-v8a");
    const linux = installInstructions(checks, "linux", "x64");
    expect(linux.join("\n")).not.toContain("brew");
  });
});

describe("cloud VM detection", () => {
  it("names common clouds from DMI strings", () => {
    expect(detectCloudVm({ sysVendor: "Google", productName: "Google Compute Engine" })).toBe("Google Cloud");
    expect(detectCloudVm({ sysVendor: "Amazon EC2", productName: "t3.large" })).toBe("AWS EC2");
    expect(detectCloudVm({ sysVendor: "Hetzner", productName: "vServer" })).toBe("Hetzner");
    expect(detectCloudVm({ sysVendor: "OpenStack Foundation", productName: "OpenStack Nova" })).toMatch(/OpenStack/);
    expect(detectCloudVm({ sysVendor: "QEMU", productName: "Standard PC (Q35 + ICH9, 2009)" })).toBe("a virtual machine");
    expect(detectCloudVm({ sysVendor: "Dell Inc.", productName: "PowerEdge R650" })).toBeUndefined();
    expect(detectCloudVm({})).toBeUndefined();
  });

  it("says clearly that a VM without /dev/kvm cannot host Android emulators", () => {
    expect(cloudCheck("Hetzner", false)).toMatchObject({ status: "fail", detail: expect.stringContaining("cannot host Android emulators") });
    expect(cloudCheck("Google Cloud", true)?.status).toBe("pass");
    expect(cloudCheck(undefined, false)).toBeUndefined();
  });

  it("tells the person on a cloud VM that it bills, that a stopped disk still bills, and where tear-down is", () => {
    const google = cloudCostNote("Google Cloud");
    expect(google).toBe(
      "Google Cloud, billed while running; its disk bills even when stopped. Delete it when you are done: see docs/deployment/google-cloud-n2.md#tear-down",
    );
    expect(cloudCostNote("AWS EC2")).toContain("AWS EC2, billed while running; its disk bills even when stopped");
    expect(cloudCostNote("AWS EC2")).toContain("docs/deployment/self-hosted-overview.md#when-you-are-done-with-a-rented-machine");
    // A bare hypervisor may be a VM on someone's own computer: the wording is conditional.
    expect(cloudCostNote("a virtual machine")).toMatch(/^if this VM is rented from a cloud/);
    expect(cloudCostNote(undefined)).toBeUndefined();
  });
});

describe("linux hosts", () => {
  it("runs emulators headless with software GPU rendering on Linux without a display, and leaves desktops and macOS alone", () => {
    expect(linuxEmulatorSettings("linux", {})).toEqual([
      ["android.emulator.headless", "true"],
      ["android.emulator.gpu", "swiftshader_indirect"],
    ]);
    expect(linuxEmulatorSettings("linux", { DISPLAY: ":0" })).toEqual([]);
    expect(linuxEmulatorSettings("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual([]);
    expect(linuxEmulatorSettings("darwin", {})).toEqual([]);
  });

  it("reads loginctl's Linger property and nothing else", () => {
    expect(parseLinger("Linger=yes\n")).toBe(true);
    expect(parseLinger("Linger=no")).toBe(false);
    expect(parseLinger("Failed to get user: No such user")).toBeUndefined();
    expect(parseLinger("")).toBeUndefined();
  });

  it("recognises tailscaled refusing serve to a non-operator on Linux only", () => {
    expect(serveNeedsOperator("linux", "Access denied: serve config denied\nUse 'sudo tailscale serve' or 'tailscale set --operator=$USER'")).toBe(true);
    expect(serveNeedsOperator("darwin", "Access denied")).toBe(false);
    expect(serveNeedsOperator("linux", "serve: HTTPS is not enabled for this tailnet")).toBe(false);
  });
});

describe("tailscale", () => {
  it("reads the MagicDNS name and login state from `tailscale status --json`", () => {
    const running = JSON.stringify({ BackendState: "Running", Self: { DNSName: "my-mac.tail1234.ts.net.", HostName: "my-mac" } });
    expect(parseTailscaleStatus(running)).toEqual({ loggedIn: true, backendState: "Running", dnsName: "my-mac.tail1234.ts.net", https: false });
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: { DNSName: "" } }))).toEqual({ loggedIn: false, backendState: "NeedsLogin", https: false });
    expect(parseTailscaleStatus("not json")).toEqual({ loggedIn: false, backendState: "unreadable", https: false });
    expect(parseTailscaleStatus("{}")).toEqual({ loggedIn: false, backendState: "unknown", https: false });
  });

  it("tells a tailnet with HTTPS certificates from one without (#21)", () => {
    const base = { BackendState: "Running", Self: { DNSName: "my-mac.tail1234.ts.net." } };
    expect(parseTailscaleStatus(JSON.stringify({ ...base, CertDomains: ["my-mac.tail1234.ts.net"] })).https).toBe(true);
    expect(parseTailscaleStatus(JSON.stringify({ ...base, CertDomains: null })).https).toBe(false);
    expect(parseTailscaleStatus(JSON.stringify({ ...base, CertDomains: [] })).https).toBe(false);
    // Without certificates the guard is served over HTTP inside the tailnet, and the endpoint says so.
    expect(tailscaleServeArgs(4720, "http")).toEqual(["serve", "--bg", "--http=4720", "http://127.0.0.1:4720"]);
    expect(tailscaleServeOffArgs(4720, "http")).toEqual(["serve", "--http=4720", "off"]);
    expect(hostEndpoint("my-mac.tail1234.ts.net", 4720, "http")).toBe("http://my-mac.tail1234.ts.net:4720");
    expect(serveModeOf(JSON.stringify({ TCP: { "4720": { HTTP: true } } }), 4720)).toBe("http");
    expect(serveModeOf(JSON.stringify({ TCP: { "4720": { HTTPS: true } } }), 4720)).toBe("https");
    expect(serveModeOf(JSON.stringify({ TCP: {} }), 4720)).toBeUndefined();
  });

  it("finds the guard port in `tailscale serve status --json`", () => {
    expect(serveHasPort(JSON.stringify({ TCP: { "4720": { HTTPS: true } } }), 4720)).toBe(true);
    expect(serveHasPort(JSON.stringify({ Web: { "my-mac.tail1234.ts.net:4720": {} } }), 4720)).toBe(true);
    expect(serveHasPort(JSON.stringify({ TCP: { "443": { HTTPS: true } } }), 4720)).toBe(false);
    expect(serveHasPort("", 4720)).toBe(false);
  });

  it("uses fixed argument arrays and the right endpoint", () => {
    expect(tailscaleServeArgs(4720)).toEqual(["serve", "--bg", "--https=4720", "http://127.0.0.1:4720"]);
    expect(tailscaleServeOffArgs(4720)).toEqual(["serve", "--https=4720", "off"]);
    expect(hostEndpoint("my-mac.tail1234.ts.net", 4720)).toBe("https://my-mac.tail1234.ts.net:4720");
    expect(hostEndpoint(undefined, 4720)).toBe("http://127.0.0.1:4720");
  });
});

describe("pairing and rerun commands", () => {
  it("derives a safe label and token path", () => {
    expect(defaultLabel("Dana's MacBook Pro.local")).toBe("Dana-s-MacBook-Pro");
    expect(pairingTokenPath("/u/.tapdance/worker", "../../etc/passwd")).toBe("/u/.tapdance/worker/pairing-etc-passwd.token");
  });

  it("prints the exact command to run again with the added flag", () => {
    expect(hostUpCommand({ label: "vps", keepAwake: true }, { allowAdminAccount: true })).toBe("tapdance host up --label vps --allow-admin-account --keep-awake");
    expect(hostUpCommand({ tailscale: false, label: "my vps" }, { repair: true })).toBe("tapdance host up --label 'my vps' --no-tailscale --repair");
    // The "run this again" hint keeps --warm (it used to drop it).
    expect(hostUpCommand({ warm: "android=0" }, { allowAdminAccount: true })).toBe("tapdance host up --allow-admin-account --warm android=0");
    expect(hostUpCommand({})).toBe("tapdance host up");
    expect(hostUpCommand({ idleStop: "off", maxUptime: "12" })).toBe("tapdance host up --idle-stop off --max-uptime 12");
  });
});

describe("cost guard options", () => {
  const usage = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e as TapdanceError;
    }
    throw new Error("did not throw");
  };

  it("parses --idle-stop and --max-uptime: off, 0, numbers in range; refuses the rest with USAGE", () => {
    expect(parseIdleStop("off")).toBe(0);
    expect(parseIdleStop("OFF")).toBe(0);
    expect(parseIdleStop("0")).toBe(0);
    expect(parseIdleStop("30")).toBe(30);
    expect(parseIdleStop("1440")).toBe(1440);
    expect(parseMaxUptime("12")).toBe(12);
    expect(parseMaxUptime("off")).toBe(0);
    for (const bad of ["1441", "-5", "30m", "1.5", "", "never", "99999"]) expect(usage(() => parseIdleStop(bad)).code).toBe("USAGE");
    for (const bad of ["721", "8h", "-1"]) expect(usage(() => parseMaxUptime(bad)).code).toBe("USAGE");
  });

  it("defaults idle stop to 30 min on a detected cloud VM only, and records it", () => {
    expect(resolveHostStop({ platform: "linux", cloudVm: "Google Cloud" })).toEqual({ idleMinutes: 30, maxUptimeHours: 0, idleSource: "cloud default", write: true, changed: true });
    expect(resolveHostStop({ platform: "linux" })).toEqual({ idleMinutes: 0, maxUptimeHours: 0, idleSource: "off", write: false, changed: false });
  });

  it("keeps what the policy holds, and a flag wins over both", () => {
    const current = { idleMinutes: 0, maxUptimeHours: 6 };
    expect(resolveHostStop({ platform: "linux", cloudVm: "Google Cloud", current })).toMatchObject({ idleMinutes: 0, maxUptimeHours: 6, idleSource: "policy", write: false, changed: false });
    expect(resolveHostStop({ platform: "linux", cloudVm: "Google Cloud", idleStop: "off" })).toMatchObject({ idleMinutes: 0, idleSource: "flag", write: true, changed: false });
    expect(resolveHostStop({ platform: "linux", current, idleStop: "45", maxUptime: "off" })).toMatchObject({ idleMinutes: 45, maxUptimeHours: 0, write: true, changed: true });
    expect(resolveHostStop({ platform: "linux", current: { idleMinutes: 45, maxUptimeHours: 0 }, idleStop: "45" })).toMatchObject({ write: true, changed: false });
  });

  it("refuses to turn either limit on for a Mac (it never powers off); off is accepted", () => {
    const e = usage(() => resolveHostStop({ platform: "darwin", idleStop: "30" }));
    expect(e.code).toBe("USAGE");
    expect(e.message).toContain("never does to a Mac");
    expect(usage(() => resolveHostStop({ platform: "darwin", maxUptime: "8" })).code).toBe("USAGE");
    expect(resolveHostStop({ platform: "darwin", idleStop: "off", cloudVm: "a virtual machine" })).toMatchObject({ idleMinutes: 0, write: false });
  });

  it("says how long the host has been idle from the guard's last check, if recent", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    expect(describeIdle({ checkedAt: "2026-11-03T11:59:30Z", lastActivityAt: "2026-11-03T11:47:00Z", leases: 0 }, now)).toBe("idle 12 min");
    expect(describeIdle({ checkedAt: "2026-11-03T11:59:30Z", lastActivityAt: "2026-11-03T11:59:30Z", leases: 2 }, now)).toBe("in use (2 lease(s))");
    expect(describeIdle({ checkedAt: "2026-11-03T11:00:00Z", lastActivityAt: "2026-11-03T10:00:00Z" }, now)).toBeUndefined();
    expect(describeIdle(undefined, now)).toBeUndefined();
  });

  it("says when an idle host powers off, from the limit in host-stop.json (#95)", () => {
    const now = Date.parse("2026-11-04T15:34:10Z");
    const seen = { checkedAt: "2026-11-04T15:34:05Z", lastActivityAt: "2026-11-04T15:33:03Z", leases: 0, idleMinutes: 10 };
    expect(describeIdle(seen, now)).toBe("idle 1 min, powers off in about 9 min (around 15:43 UTC)");
    expect(describeIdle({ ...seen, lastActivityAt: "2026-11-04T15:20:00Z" }, now)).toBe("idle 14 min, powers off at the guard's next check (within a minute)");
    expect(describeIdle({ ...seen, leases: 1 }, now)).toBe("in use (1 lease(s))");
    expect(describeIdle({ ...seen, idleMinutes: 0 }, now)).toBe("idle 1 min");
  });
});

describe("pairing label for host up (#93)", () => {
  const refusal = (f: () => unknown) => {
    try {
      f();
    } catch (error) {
      return error as TapdanceError;
    }
    throw new Error("expected a refusal");
  };
  it("keeps the host's only pairing when no --label is given, instead of pairing the hostname", () => {
    expect(choosePairingLabel({ hostnameLabel: "tapdance-n2", active: ["vps-n2"] })).toEqual({ label: "vps-n2", source: "only pairing" });
    expect(choosePairingLabel({ hostnameLabel: "tapdance-n2", active: [] })).toEqual({ label: "tapdance-n2", source: "hostname" });
    expect(choosePairingLabel({ hostnameLabel: "tapdance-n2", active: ["vps-n2", "tapdance-n2"] })).toEqual({ label: "tapdance-n2", source: "hostname" });
    expect(choosePairingLabel({ flag: "new vps", hostnameLabel: "tapdance-n2", active: ["vps-n2"] })).toEqual({ label: "new-vps", source: "flag" });
  });
  it("refuses to guess between several pairings", () => {
    const e = refusal(() => choosePairingLabel({ hostnameLabel: "h", active: ["a", "b"] }));
    expect(e.code).toBe("USAGE");
    expect(e.message).toContain('"a", "b"');
    expect(e.hint).toContain("tapdance host up --label a");
  });
  it("names the existing pairing in the approval refusal instead of suggesting a second pairing", () => {
    const e = pairingApprovalRefusal({ idleStop: "10" }, "tapdance-n2", ["vps-n2"]);
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toContain('this host is paired as "vps-n2"');
    expect(e.hint).toContain("tapdance host up --label vps-n2 --idle-stop 10");
    const first = pairingApprovalRefusal({}, "my-vps", []);
    expect(first.message).toBe("Pairing must be approved at this machine's terminal");
    expect(first.hint).toContain("tapdance host up --label my-vps --yes");
  });
});

describe("host up and host status wording on Linux (#78, #81)", () => {
  it("offers the clipboard only with a display and a clipboard tool", () => {
    expect(offerClipboard("linux", {}, () => true)).toBe(false);
    expect(offerClipboard("linux", { DISPLAY: ":0" }, () => false)).toBe(false);
    expect(offerClipboard("linux", { WAYLAND_DISPLAY: "wayland-0" }, (b) => b === "wl-copy")).toBe(true);
    expect(offerClipboard("darwin", {}, () => false)).toBe(true);
  });
  it("mentions iOS simulators and 'this Mac' only on macOS", () => {
    expect(hostSecurityNote("linux", "w")).not.toMatch(/iOS|Mac/);
    expect(hostSecurityNote("darwin", "w")).toContain("An iOS simulator app is not sandboxed from this Mac");
    expect(hostSecurityNote("linux", "w", "interaction")).toContain("(scopes: interaction)");
    expect(tailscaleAclHint("linux", 4720)).toContain("<this machine's 100.x address or tag>:4720");
    expect(tailscaleAclHint("darwin", 4720)).toContain("<this Mac's 100.x address or tag>:4720");
  });
  it("says iOS needs a Mac on Linux", () => {
    expect(describePlatforms({ android: true, ios: false }, "linux")).toBe("android ready, ios needs a Mac");
    expect(describePlatforms({ android: false, ios: false }, "darwin")).toBe("android not available, ios not available");
  });
  it("reads the RAM budget from capacity.ramBudget (Simlock 0.4) and leaves it out when absent", () => {
    const gib = 1024 ** 3;
    const status = { capacity: { android: { running: 1, warm: 1 }, ios: { running: 0, warm: 0 }, ramBudget: { usedBytes: 4.2 * gib, limitBytes: 12 * gib, overLimit: false } } };
    expect(describeWorkerDevices(status)).toBe("android 1 running (1 warm spare), ios 0 running (0 warm spare); devices use 4.2 of 12.0 GB budget");
    expect(describeWorkerDevices({ capacity: { android: { running: 2 } }, ramBudget: { usedBytes: gib, limitBytes: 2 * gib } })).toContain("devices use 1.0 of 2.0 GB budget");
    expect(describeWorkerDevices({ capacity: { android: { running: 1 } } })).toBe("android 1 running (0 warm spare), ios 0 running (0 warm spare)");
  });
});

describe("rendering", () => {
  it("renders the ready block in the agreed form, without the token", () => {
    const block = renderReadyBlock({
      endpoint: "https://my-mac.tail1234.ts.net:4720",
      tokenPath: "/Users/w/.tapdance/worker/pairing-vps.token",
      devices: "android 34 (google_apis_playstore), ios 26.5",
      selfTest: "PASS (screenshot ok)",
      fingerprint: "a1b2c3",
      label: "vps",
    });
    expect(block.split("\n")).toEqual([
      "TAPDANCE HOST READY",
      "endpoint:  https://my-mac.tail1234.ts.net:4720",
      "token:     saved to /Users/w/.tapdance/worker/pairing-vps.token (mode 600), fingerprint a1b2c3. Copy it: tapdance host token --label vps",
      "devices:   android 34 (google_apis_playstore), ios 26.5",
      "self-test: PASS (screenshot ok)",
      "on the agent machine:  tapdance connect https://my-mac.tail1234.ts.net:4720 < pairing-vps.token",
    ]);
    const withCost = renderReadyBlock({ endpoint: "http://127.0.0.1:4720", tokenPath: "/h/p.token", devices: "android 34", selfTest: "PASS", costGuard: "idle stop after 30 min, uptime cap off" });
    expect(withCost.split("\n")).toContain("cost guard: idle stop after 30 min, uptime cap off");
    expect(withCost).not.toContain("cloud VM:");
    const onCloud = renderReadyBlock({ endpoint: "http://127.0.0.1:4720", tokenPath: "/h/p.token", devices: "android 34", selfTest: "PASS", costGuard: "idle stop after 30 min, uptime cap off", cloudCost: cloudCostNote("Google Cloud")! });
    const lines = onCloud.split("\n");
    expect(lines).toContain(`cloud VM:  ${cloudCostNote("Google Cloud")}`);
    // Right after the cost guard, before the connect line.
    expect(lines.indexOf(`cloud VM:  ${cloudCostNote("Google Cloud")}`)).toBe(lines.indexOf("cost guard: idle stop after 30 min, uptime cap off") + 1);
  });

  it("tags a token with a short fingerprint and finds a clipboard tool (#22)", () => {
    expect(tokenFingerprint("tdg_example")).toMatch(/^[0-9a-f]{6}$/);
    expect(tokenFingerprint("tdg_example\n")).toBe(tokenFingerprint("tdg_example"));
    expect(tokenFingerprint("tdg_other")).not.toBe(tokenFingerprint("tdg_example"));
    expect(clipboardCommand("darwin", () => false)).toEqual(["pbcopy"]);
    expect(clipboardCommand("linux", (b) => b === "xclip")).toEqual(["xclip", "-selection", "clipboard"]);
    expect(clipboardCommand("linux", (b) => b === "wl-copy" || b === "xclip")).toEqual(["wl-copy"]);
    expect(clipboardCommand("linux", () => false)).toBeUndefined();
  });

  it("turns --warm into Simlock warm-pool settings (#25)", () => {
    expect(parseWarm("android=1,ios=0")).toEqual({ android: 1, ios: 0 });
    expect(() => parseWarm("android=lots")).toThrow(/warm count/);
    const limits = { android: 2, ios: 5 };
    expect(warmSettings({ android: 0, ios: 0 }, limits)).toEqual([["warmPool.enabled", "false"]]);
    expect(warmSettings({ android: 1, ios: 0 }, limits)).toEqual([
      ["warmPool.enabled", "true"],
      ["warmPool.reserveRunning.android", "1"],
      ["warmPool.reserveRunning.ios", "5"],
    ]);
    // An omitted platform keeps one spare; more spares than slots reserve nothing.
    expect(warmSettings({ android: 5 }, limits)).toContainEqual(["warmPool.reserveRunning.android", "0"]);
    expect(warmSettings({ android: 5 }, limits)).toContainEqual(["warmPool.reserveRunning.ios", "4"]);
  });

  it("goes back to Simlock's default spares by removing only the keys host warm wrote (#91)", () => {
    const written = { http: { port: 4701 }, warmPool: { enabled: true, reserveRunning: { android: 1, ios: 5 }, quarantine: { maxRetries: 2 } } };
    const { config, removed } = withoutWarmSettings(written);
    expect(removed).toEqual(["warmPool.enabled", "warmPool.reserveRunning.android", "warmPool.reserveRunning.ios"]);
    // Another warmPool key stays; the emptied reserveRunning goes; the input is not changed.
    expect(config).toEqual({ http: { port: 4701 }, warmPool: { quarantine: { maxRetries: 2 } } });
    expect(written.warmPool.enabled).toBe(true);
    expect(withoutWarmSettings({ warmPool: { enabled: false } }).config).toEqual({});
    expect(withoutWarmSettings({ android: { emulator: {} } })).toEqual({ config: { android: { emulator: {} } }, removed: [] });
    expect(withoutWarmSettings({ warmPool: "odd" }).removed).toEqual([]);
  });

  it("says how the warm spares are set and which are ready (#91)", () => {
    const learned = { enabled: true, targets: [{ platform: "android", model: "Pixel 8", osVersion: "34", origin: "learned", ready: 1, booting: 0 }] };
    expect(describeWarm({}, learned)).toMatch(/Simlock's default[\s\S]*android Pixel 8 \/ 34 \(learned\): ready 1/);
    expect(describeWarm({ warmPool: { enabled: true, reserveRunning: { android: 0, ios: 4 } } }, learned)).toMatch(/set by tapdance host warm \(reserved running slots: android 0, ios 4\)/);
    expect(describeWarm({ warmPool: { enabled: false } }, { enabled: false, targets: [] })).toMatch(/off[\s\S]*No spares\./);
    // Before the first lease, or after a reset that forgot the learned kind.
    expect(describeWarm({}, { enabled: true, targets: [] })).toMatch(/No spare yet: the next lease boots a device/);
    expect(describeWarm(undefined, undefined)).toMatch(/not running/);
    expect(describeWarm({}, learned)).toMatch(/tapdance host warm default/);
  });

  it("describes the catalog per platform", () => {
    expect(
      describeCatalog([
        { platform: "android", models: ["Pixel 8"], osVersions: ["34"], imageTags: ["google_apis_playstore"] },
        { platform: "ios", models: ["iPhone 16"], osVersions: ["18.5", "26.5"], defaultOsVersion: "26.5" },
      ]),
    ).toBe("android 34 (google_apis_playstore), ios 26.5");
    expect(describeCatalog([{ platform: "ios", models: [], osVersions: [] }])).toBe("none");
  });

  it("formats a failed step with its command, output tail and fix, redacting secrets", () => {
    const error = new TapdanceError("INTERNAL", "launchctl could not load the worker guard LaunchAgent", {
      hint: "Run it from the logged-in account.",
      details: { command: "launchctl bootstrap gui/501 /Users/w/Library/LaunchAgents/dev.tapdance.guard.plist", output: "line 1\nBootstrap failed: 5\ntoken tdg_abcdefghijklmnopqrstuvwxyz" },
    });
    const text = formatStepFailure({ index: 4, total: 8, title: "guard service" }, error);
    expect(text).toContain("✗ step 4/8 (guard service) failed: launchctl could not load");
    expect(text).toContain("  command: launchctl bootstrap gui/501");
    expect(text).toContain("    Bootstrap failed: 5");
    expect(text).toContain("  fix: Run it from the logged-in account.");
    expect(text).not.toContain("tdg_abcdefghijklmnopqrstuvwxyz");
    expect(formatStepFailure({ index: 1, total: 8, title: "prerequisites" }, new TapdanceError("HOST_CHECK_FAILED", "missing"))).toBe("✗ step 1/8 (prerequisites) failed: missing");
  });

  it("prints MCP snippets for Claude Code, Codex and Cursor", () => {
    const text = mcpSnippets(["tapdance", "mcp"]);
    expect(text).toContain("claude mcp add tapdance -- tapdance mcp");
    expect(text).toContain('command = "tapdance"\n  args = ["mcp"]');
    expect(text).toContain('"command": "tapdance", "args": ["mcp"]');
    expect(mcpSnippets(["/Apps/My Node/node", "/td/main.js", "mcp"])).toContain("-- '/Apps/My Node/node' /td/main.js mcp");
  });

  it("looks up executables on PATH without running them", () => {
    const exists = (p: string) => p === "/b/tapdance";
    expect(findOnPath("tapdance", "/a:/b", exists, "linux")).toBe("/b/tapdance");
    expect(findOnPath("tapdance", "/a", exists, "linux")).toBeUndefined();
  });
});
