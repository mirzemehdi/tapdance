import { describe, expect, it } from "vitest";
import { EMULATOR_APT_PACKAGES, findAndroidSdk, kvmChecks, missingSharedLibrary } from "./host-checks.js";

describe("findAndroidSdk (a fake file system)", () => {
  const has = (...dirs: string[]) => (p: string) => dirs.includes(p);
  it("prefers ANDROID_HOME, then ANDROID_SDK_ROOT", () => {
    expect(findAndroidSdk({ ANDROID_HOME: "/a", ANDROID_SDK_ROOT: "/b" }, "linux", "/home/w", has("/a", "/b"))).toBe("/a");
    expect(findAndroidSdk({ ANDROID_SDK_ROOT: "/b" }, "linux", "/home/w", has("/b"))).toBe("/b");
  });
  it("finds ~/Android/Sdk on Linux when the environment names none (an ssh command without a profile, #81)", () => {
    expect(findAndroidSdk({}, "linux", "/home/w", has("/home/w/Android/Sdk"))).toBe("/home/w/Android/Sdk");
    expect(findAndroidSdk({ ANDROID_HOME: "/gone" }, "linux", "/home/w", has("/home/w/Android/Sdk"))).toBe("/home/w/Android/Sdk");
    expect(findAndroidSdk({}, "linux", "/home/w", has())).toBeUndefined();
  });
  it("keeps the macOS default", () => {
    expect(findAndroidSdk({}, "darwin", "/Users/w", has("/Users/w/Library/Android/sdk"))).toBe("/Users/w/Library/Android/sdk");
    expect(findAndroidSdk({}, "darwin", "/Users/w", has("/Users/w/Android/Sdk"))).toBeUndefined();
  });
});

/** Pure parts of the Linux host checks; no test here runs the emulator or reads /dev/kvm. */
describe("emulator runtime libraries", () => {
  const loaderError =
    "/home/u/Android/Sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64: error while loading shared libraries: libpulse.so.0: cannot open shared object file: No such file or directory";

  it("names the missing library from the loader's error", () => {
    expect(missingSharedLibrary(loaderError)).toBe("libpulse.so.0");
    expect(missingSharedLibrary("Android emulator version 36.1.9.0")).toBeUndefined();
  });

  it("fails the host check with every package a minimal Ubuntu image lacks, not only the first", () => {
    const checks = kvmChecks({ cpuFlag: "vmx", devKvm: true, devKvmAccess: true, emulatorRun: loaderError });
    const libs = checks.find((c) => c.id === "host.kvm.emulator-libs");
    expect(libs).toMatchObject({ status: "fail", detail: expect.stringContaining("libpulse.so.0") });
    for (const pkg of EMULATOR_APT_PACKAGES) expect(libs?.fix).toContain(pkg);
  });

  it("adds no check when the emulator starts", () => {
    const checks = kvmChecks({ cpuFlag: "vmx", devKvm: true, devKvmAccess: true });
    expect(checks.some((c) => c.id === "host.kvm.emulator-libs")).toBe(false);
  });
});
