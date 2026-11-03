import { describe, expect, it } from "vitest";
import { EMULATOR_APT_PACKAGES, kvmChecks, missingSharedLibrary } from "./host-checks.js";

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
