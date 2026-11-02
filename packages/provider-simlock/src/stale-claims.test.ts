import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseStaleDeviceClaims } from "./stale-claims.js";

const SESSION = "tok_test:td-aaaaaaaaaaaa-bbbbbbbbbbbb";

/** A Simlock home holding claims of a dead daemon (pid 999999), as a worker restart leaves them. */
async function fakeHome(withRecording: boolean): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "td-claims-"));
  const state = join(home, "agent-device");
  const claims = join(state, "device-claims");
  const sessionDir = join(state, "sessions", SESSION.replace(/:/g, "_"));
  await mkdir(claims, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  for (const serial of ["emulator-5588", "emulator-5586"]) {
    await writeFile(
      // agent-device names a claim file after the SHA-256 of its device key.
      join(claims, `${createHash("sha256").update(`local:android:none:${serial}`).digest("hex")}.json`),
      JSON.stringify({
        schemaVersion: 3,
        deviceKey: `local:android:none:${serial}`,
        session: SESSION,
        workspace: "/",
        stateDir: state,
        device: { id: serial, family: "android", kind: "emulator", target: "mobile", name: "simlock test" },
        ownerPid: 999_999,
        ownerStartTime: "Mon Nov  2 01:14:16 2026",
        ownerToken: "owner-token-test",
        createdAtMs: 1,
        updatedAtMs: 2,
        claimOwnerKind: "open-session",
      }),
    );
  }
  if (withRecording) {
    await writeFile(
      join(sessionDir, "screen-recording.resource.json"),
      JSON.stringify({
        envelopeVersion: 1,
        resourceKind: "screen-recording",
        sessionId: SESSION,
        device: { id: "emulator-5588", family: "android", kind: "emulator", target: "mobile" },
        owner: { kind: "local-family", family: "android" },
        fence: { token: "fence-test", generation: 1 },
        lifecycle: "open",
        descriptor: { version: 1, body: { backend: "adb-screenrecord", manifestPath: "/sdcard/x.json", outputPath: join(sessionDir, "r.mp4"), scope: "app", showTouches: true, recordOnlySession: false, transportMode: "local" } },
        metadata: { phase: "completing" },
      }),
    );
  }
  return home;
}

describe("releaseStaleDeviceClaims", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    // No adb reachable: the test must never touch this machine's devices.
    process.env["PATH"] = "/usr/bin:/bin";
    process.env["ANDROID_HOME"] = "/nonexistent";
    process.env["ANDROID_SDK_ROOT"] = "/nonexistent";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("does nothing without claims", async () => {
    const home = await mkdtemp(join(tmpdir(), "td-claims-"));
    expect(await releaseStaleDeviceClaims({ simlockHome: home })).toEqual({ released: [], retained: [], abandonedRecordings: [] });
  });

  it("releases claims of a dead daemon", async () => {
    const home = await fakeHome(false);
    const r = await releaseStaleDeviceClaims({ simlockHome: home });
    expect(r.released.sort()).toEqual(["local:android:none:emulator-5586", "local:android:none:emulator-5588"]);
    expect(await readdir(join(home, "agent-device", "device-claims"))).toEqual([]);
  });

  it("sets aside a dead session's unfinished recording so its claims can go", async () => {
    const home = await fakeHome(true);
    const r = await releaseStaleDeviceClaims({ simlockHome: home });
    expect(r.abandonedRecordings).toEqual([SESSION]);
    expect(r.released).toHaveLength(2);
    expect(r.retained).toEqual([]);
    const sessionDir = join(home, "agent-device", "sessions", SESSION.replace(/:/g, "_"));
    expect(existsSync(join(sessionDir, "screen-recording.resource.json"))).toBe(false);
    expect((await readdir(sessionDir)).some((f) => f.startsWith("screen-recording.resource.json.abandoned-"))).toBe(true);
  });
});
