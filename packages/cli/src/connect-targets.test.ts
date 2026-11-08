import { describe, expect, it } from "vitest";
import { currentTargets, parsePlatforms, removeTarget, upsertTarget } from "./connect-targets.js";
import { renderChecks } from "./output.js";

const N2 = "https://n2-host.tail1.ts.net";
const MAC = "https://mac-mini.tail1.ts.net";

describe("connect targets in the user config", () => {
  it("turns an older single endpoint into the first target when a second host connects", () => {
    const before = { provider: "self-hosted" as const, endpoint: N2, session: { defaultTtlMinutes: 45 } as never };
    const { config, target, added, migrated } = upsertTarget(before, { endpoint: MAC, name: "mac" });
    expect(migrated).toBe(N2);
    expect(added).toBe(true);
    expect(target).toEqual({ name: "mac", endpoint: MAC });
    expect(config).toEqual({ provider: "self-hosted", session: { defaultTtlMinutes: 45 }, targets: [{ name: "n2-host", endpoint: N2 }, { name: "mac", endpoint: MAC }] });
    expect("endpoint" in config).toBe(false);
  });

  it("re-connecting the same origin updates that target instead of adding one", () => {
    const start = { provider: "self-hosted" as const, targets: [{ name: "n2", endpoint: N2, platforms: ["android" as const] }] };
    const { config, added } = upsertTarget(start, { endpoint: `${N2}/` });
    expect(added).toBe(false);
    expect(config.targets).toEqual([{ name: "n2", endpoint: `${N2}/`, platforms: ["android"] }]);
    expect(upsertTarget(start, { endpoint: N2, name: "android-host" }).config.targets![0]!.name).toBe("android-host");
  });

  it("an existing --name with a new endpoint moves that target there, keeping its place and platforms", () => {
    const TUNNEL = "http://127.0.0.1:14720";
    const start = { provider: "self-hosted" as const, targets: [{ name: "n2", endpoint: N2 }, { name: "mac", endpoint: TUNNEL, platforms: ["ios" as const] }] };
    const { config, target, added, replaced } = upsertTarget(start, { endpoint: MAC, name: "mac" });
    expect(added).toBe(false);
    expect(replaced).toBe(TUNNEL);
    expect(target).toEqual({ name: "mac", endpoint: MAC, platforms: ["ios"] });
    expect(config.targets).toEqual([{ name: "n2", endpoint: N2 }, { name: "mac", endpoint: MAC, platforms: ["ios"] }]);
    // Same origin again: a plain update, nothing replaced.
    expect(upsertTarget(config, { endpoint: MAC, name: "mac" }).replaced).toBeUndefined();
  });

  it("refuses a name another target has when the endpoint is a third target, or an invalid name", () => {
    const start = { provider: "self-hosted" as const, targets: [{ name: "n2", endpoint: N2 }, { name: "mac", endpoint: MAC }] };
    expect(() => upsertTarget(start, { endpoint: MAC, name: "n2" })).toThrow(/already target mac, and another target is called "n2"/);
    try {
      upsertTarget(start, { endpoint: MAC, name: "n2" });
    } catch (error) {
      expect((error as { hint?: string }).hint).toMatch(/tapdance disconnect n2/);
    }
    expect(() => upsertTarget(start, { endpoint: MAC, name: "Mac Mini" })).toThrow(/not a valid target name/);
  });

  it("starts from a local config too, and names the target after the host", () => {
    const { config } = upsertTarget({ provider: "local" }, { endpoint: MAC, platforms: ["ios"] });
    expect(config).toEqual({ provider: "self-hosted", targets: [{ name: "mac-mini", endpoint: MAC, platforms: ["ios"] }] });
    expect(currentTargets({ provider: "local", endpoint: N2 }).targets).toEqual([]);
  });

  it("removes a target by name or endpoint", () => {
    const start = { provider: "self-hosted" as const, targets: [{ name: "n2", endpoint: N2 }, { name: "mac", endpoint: MAC }] };
    expect(removeTarget(start, "mac").config.targets).toEqual([{ name: "n2", endpoint: N2 }]);
    expect(removeTarget(start, `${N2}/`).removed.name).toBe("n2");
    expect("targets" in removeTarget({ provider: "self-hosted", targets: [{ name: "n2", endpoint: N2 }] }, "n2").config).toBe(false);
    expect(() => removeTarget(start, "nope")).toThrow(/No connect target "nope"/);
    // An older single endpoint can be removed too.
    expect(removeTarget({ provider: "self-hosted", endpoint: N2 }, N2)).toMatchObject({ migrated: N2, removed: { endpoint: N2 } });
  });

  it("parses --platform lists", () => {
    expect(parsePlatforms(["android,ios", "ios"])).toEqual(["android", "ios"]);
    expect(parsePlatforms(undefined)).toBeUndefined();
    expect(() => parsePlatforms(["windows"])).toThrow(/android, ios or any/);
    // `any` clears a limit set before (review).
    expect(parsePlatforms(["any"])).toEqual([]);
    const limited = { provider: "self-hosted" as const, targets: [{ name: "mac", endpoint: MAC, platforms: ["ios" as const] }] };
    expect(upsertTarget(limited, { endpoint: MAC, platforms: [] }).target.platforms).toBeUndefined();
    expect(upsertTarget(limited, { endpoint: MAC }).target.platforms).toEqual(["ios"]);
  });
});

describe("doctor rendering with several hosts", () => {
  it("prints one indented section per target", () => {
    const text = renderChecks([
      { id: "targets", title: "Connect targets", status: "warn", detail: "n2: Android; mac: down" },
      { id: "target.n2", title: "Target n2", status: "pass", detail: `${N2}: up`, target: "n2" },
      { id: "target.n2.simlock.auth", title: "Token accepted", status: "pass", detail: "role agent", target: "n2" },
      { id: "target.mac", title: "Target mac", status: "warn", detail: `${MAC}: down`, target: "mac" },
      { id: "target.mac.simlock.reachable", title: "Simlock reachable", status: "warn", detail: "ECONNREFUSED", fix: "Check the host", target: "mac" },
      { id: "lease", title: "Device lease", status: "pass", detail: "none" },
    ]);
    const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/\n\n✓ Target n2 — https:\/\/n2-host\.tail1\.ts\.net: up\n  ✓ Token accepted/);
    expect(plain).toMatch(/\n\n! Target mac — .*\n  ! Simlock reachable — ECONNREFUSED\n      fix: Check the host/);
    expect(plain).toMatch(/\n\n✓ Device lease/);
    expect(plain).toContain("OK with 3 warning(s)");
  });
});
