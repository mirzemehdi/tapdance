import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findTool, runTool } from "./tools.js";

/** A stand-in executable on a temp PATH; `script` is its shell body. */
async function fakeTool(name: string, script: string): Promise<{ env: NodeJS.ProcessEnv; dir: string }> {
  const bin = await mkdtemp(join(tmpdir(), "td-tools-bin-"));
  await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`);
  await chmod(join(bin, name), 0o755);
  return { env: { PATH: `${bin}:/usr/bin:/bin` }, dir: await mkdtemp(join(tmpdir(), "td-tools-out-")) };
}

describe("runTool output redaction", () => {
  it("keeps a private key out of the run's output files", async () => {
    const { env, dir } = await fakeTool(
      "asc",
      'echo "before"\necho "-----BEGIN PRIVATE KEY-----"\necho "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCSECRETBODY"\necho "-----END PRIVATE KEY-----"\necho "ASC_PRIVATE_KEY_B64=LS0tLS1CRUdJTiBQUklWQVRF" >&2',
    );
    const prefix = join(dir, "run");
    const result = await runTool(findTool("asc"), { args: ["auth", "status"], env, outputPrefix: prefix });
    expect(result.stdout).toContain("before");
    expect(result.stdout).not.toContain("SECRETBODY");
    const out = await readFile(`${prefix}.stdout.txt`, "utf8");
    const err = await readFile(`${prefix}.stderr.txt`, "utf8");
    expect(out).toContain("before");
    expect(out).not.toContain("MIIEvQIBADANBg");
    expect(out).not.toContain("SECRETBODY");
    expect(err).not.toContain("LS0tLS1CRUdJTi");
  });

  it("redacts a key that a truncated capture would cut in half", async () => {
    const { env } = await fakeTool(
      "asc",
      'head -c 70000 /dev/zero | tr "\\000" x\necho\necho "-----BEGIN PRIVATE KEY-----"\nhead -c 65000 /dev/zero | tr "\\000" A\necho "SECRETBODY"\necho "-----END PRIVATE KEY-----"',
    );
    const result = await runTool(findTool("asc"), { args: [], env });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.stdout).not.toContain("SECRETBODY");
    expect(result.stdout).not.toMatch(/A{1000}/);
  });
});

describe("runTool executable overrides", () => {
  it("refuses an override that is not the tool's own program", async () => {
    const { env, dir } = await fakeTool("asc", "touch ran");
    const prefix = join(dir, "run");
    await expect(runTool(findTool("asc"), { args: ["--help"], env, cwd: dir, outputPrefix: prefix, executableOverride: "/bin/sh" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/tools\.paths\.asc must point to the asc program/),
    });
    // Nothing was spawned: no output files were opened and the fake asc never ran.
    await expect(readFile(`${prefix}.stdout.txt`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, "ran"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts an override whose name is the tool's", async () => {
    const { env } = await fakeTool("asc", 'echo "real asc"');
    const path = join(env["PATH"]!.split(":")[0]!, "asc");
    expect((await runTool(findTool("asc"), { args: [], env, executableOverride: path })).stdout).toContain("real asc");
  });
});

describe("runTool device option for the Android CLI", () => {
  // A picocli-like fake: `layout --help` lists --device, `docs --help` does not; a real run echoes its args.
  const script = [
    'case "$*" in',
    '  "layout --help") echo "Usage: android layout [--device=PARAM] [--flat]";;',
    '  "docs --help") echo "Usage: android docs [QUERY]";;',
    '  *) echo "ARGS: $*"; echo "SERIAL: $ANDROID_SERIAL";;',
    "esac",
  ].join("\n");

  it("appends --device=<serial> when the subcommand takes it", async () => {
    const { env } = await fakeTool("android", script);
    const result = await runTool(findTool("android"), { args: ["layout", "--flat"], env, deviceId: "emulator-5554" });
    expect(result.stdout).toContain("ARGS: layout --flat --device=emulator-5554");
    expect(result.stdout).toContain("SERIAL: emulator-5554");
  });

  it("leaves subcommands without a device option alone", async () => {
    const { env } = await fakeTool("android", script);
    const result = await runTool(findTool("android"), { args: ["docs", "compose"], env, deviceId: "emulator-5554" });
    expect(result.stdout).toContain("ARGS: docs compose\n");
  });

  it("refuses a caller-chosen --device", async () => {
    const { env } = await fakeTool("android", script);
    await expect(runTool(findTool("android"), { args: ["layout", "--device=emulator-5556"], env, deviceId: "emulator-5554" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
