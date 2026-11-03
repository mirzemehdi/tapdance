import { describe, expect, it } from "vitest";
import { HOST_STOP_COMMAND, describeHostStop, hostStopApplies, hostStopDecision, parseProcUptime, sudoersInstallCommand, sudoersRule, uptimeCapReached, uptimeCapRefusal } from "./host-stop.js";

/** Pure decisions of the cost guard. Nothing here runs sudo or powers anything off. */

const MIN = 60_000;
const idle30 = { idleMinutes: 30, maxUptimeHours: 0 };

describe("cost guard decisions", () => {
  it("stops after the idle limit and not a minute before", () => {
    expect(hostStopDecision(idle30, { now: 29 * MIN, lastActivity: 0, busy: false })).toEqual({ stop: false });
    expect(hostStopDecision(idle30, { now: 30 * MIN, lastActivity: 0, busy: false })).toMatchObject({ stop: true, reason: "idle" });
  });

  it("never stops while a lease, a build or a request is running", () => {
    expect(hostStopDecision(idle30, { now: 999 * MIN, lastActivity: 0, busy: true })).toEqual({ stop: false });
    expect(hostStopDecision({ idleMinutes: 0, maxUptimeHours: 1 }, { now: 0, lastActivity: 0, busy: true, uptimeSeconds: 99 * 3600 })).toEqual({ stop: false });
  });

  it("stops past the uptime cap once nothing runs; off when both limits are 0 or uptime is unknown", () => {
    const cap = { idleMinutes: 0, maxUptimeHours: 8 };
    expect(hostStopDecision(cap, { now: 0, lastActivity: 0, busy: false, uptimeSeconds: 8 * 3600 - 1 })).toEqual({ stop: false });
    expect(hostStopDecision(cap, { now: 0, lastActivity: 0, busy: false, uptimeSeconds: 8 * 3600 })).toMatchObject({ stop: true, reason: "uptime" });
    expect(hostStopDecision(cap, { now: 0, lastActivity: 0, busy: false })).toEqual({ stop: false });
    expect(hostStopDecision({ idleMinutes: 0, maxUptimeHours: 0 }, { now: 1e12, lastActivity: 0, busy: false, uptimeSeconds: 1e9 })).toEqual({ stop: false });
    expect(uptimeCapReached({ idleMinutes: 5, maxUptimeHours: 0 }, 1e9)).toBe(false);
  });

  it("applies on Linux only, never on macOS", () => {
    expect(hostStopApplies(idle30, "linux")).toBe(true);
    expect(hostStopApplies(idle30, "darwin")).toBe(false);
    expect(hostStopApplies({ idleMinutes: 0, maxUptimeHours: 0 }, "linux")).toBe(false);
    expect(hostStopApplies(undefined, "linux")).toBe(false);
    expect(describeHostStop(idle30, "darwin")).toMatch(/^off/);
    expect(describeHostStop(idle30, "linux")).toBe("idle stop after 30 min, uptime cap off");
    expect(describeHostStop({ idleMinutes: 0, maxUptimeHours: 12 }, "linux")).toBe("idle stop off, uptime cap 12 h");
    expect(describeHostStop(undefined, "linux")).toBe("off");
  });

  it("reads /proc/uptime", () => {
    expect(parseProcUptime("12345.67 54321.00\n")).toBe(12345.67);
    expect(parseProcUptime("")).toBeUndefined();
    expect(parseProcUptime("garbage")).toBeUndefined();
  });

  it("refuses leases past the cap with NO_CAPACITY and the owner's reason", () => {
    const r = uptimeCapRefusal({ idleMinutes: 0, maxUptimeHours: 8 });
    expect(r.code).toBe("NO_CAPACITY");
    expect(r.message).toContain("8 h");
    expect(r.hint).toContain("owner set an uptime cap");
  });
});

describe("the stop command and its sudoers rule", () => {
  it("is fixed: passwordless sudo of systemd's poweroff, nothing else", () => {
    expect([...HOST_STOP_COMMAND]).toEqual(["sudo", "-n", "/usr/bin/systemctl", "poweroff"]);
  });

  it("allows exactly that command for one user, installed and checked with visudo", () => {
    expect(sudoersRule("tapdance")).toBe("tapdance ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff");
    expect(sudoersInstallCommand("me")).toBe(
      "echo 'me ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff' | sudo tee /etc/sudoers.d/tapdance-poweroff && sudo chmod 440 /etc/sudoers.d/tapdance-poweroff && sudo visudo -cf /etc/sudoers.d/tapdance-poweroff",
    );
    for (const bad of ["me' ALL=(ALL) ALL #", "a b", "", "ALL,root", "ALL"]) expect(() => sudoersRule(bad)).toThrow();
  });
});
