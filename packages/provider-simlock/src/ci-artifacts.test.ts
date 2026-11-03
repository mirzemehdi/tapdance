import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "./build.js";
import { checkCiRequest, extractApk, fetchCiApk, githubRepo, type ArtifactSettings } from "./ci-artifacts.js";

const SHA = "c".repeat(40);
const settings: ArtifactSettings = { repos: ["acme/app"], branches: [], maxMB: 5 };

/** A zip file built in memory: stored or deflated entries, with Unix modes (for symlinks). */
function makeZip(entries: Array<{ name: string; data?: Buffer; method?: 0 | 8; mode?: number; date?: number }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name);
    const crc = crc32(data);
    const date = e.date ?? 0x5a21;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const APK = Buffer.from("PK-fake-apk-content-".repeat(200));

interface FakeRun {
  id: number;
  head_branch: string;
  head_sha: string;
  conclusion: string;
  status: string;
  head_repo: string;
}

/** A fake `gh` (mocked): answers the API calls fetchCiApk makes and writes `zip` for a download. */
function fakeGh(opts: { runs?: FakeRun[]; run?: FakeRun; artifacts?: Record<string, Array<{ id: number; name: string; size: number; expired: boolean }>>; zip?: Buffer; defaultBranch?: string; fail?: string }) {
  const calls: string[][] = [];
  const run: CommandRunner = async (command, args, o) => {
    calls.push([command, ...args]);
    if (command !== "gh") return { code: 127, output: "" };
    if (opts.fail) return { code: 1, output: opts.fail };
    const path = args.find((a) => a.startsWith("repos/"))!;
    const json = (v: unknown) => ({ code: 0, output: `${JSON.stringify(v)}\n` });
    if (/\/actions\/artifacts\/\d+\/zip$/.test(path)) {
      await writeFile(o.stdoutPath!, opts.zip ?? Buffer.alloc(0));
      return { code: 0, output: "" };
    }
    if (/\/actions\/runs\/\d+\/artifacts$/.test(path)) return json(opts.artifacts?.[path.split("/")[5]!] ?? []);
    if (/\/actions\/runs\/\d+$/.test(path)) return json(opts.run);
    if (/\/actions\/runs$/.test(path)) return json(opts.runs ?? []);
    return json(opts.defaultBranch ?? "main");
  };
  return { run, calls, downloads: () => calls.filter((c) => c.some((a) => a.endsWith("/zip"))).length };
}

const okRun = (id: number, branch = "main", repo = "acme/app"): FakeRun => ({ id, head_branch: branch, head_sha: SHA, conclusion: "success", status: "completed", head_repo: repo });

describe("install from CI: request checks", () => {
  it("names repositories as owner/repo and refuses anything else", () => {
    expect(githubRepo("acme/app")).toBe("acme/app");
    expect(githubRepo("https://github.com/Acme/App.git")).toBe("acme/app");
    expect(githubRepo("git@github.com:acme/app.git")).toBe("acme/app");
    for (const bad of ["https://gitlab.com/acme/app", "acme/app/extra", "acme", "../etc", "acme/..", "-X/app", "acme/app;id", "acme/app?x=1", "file:///etc/passwd", "https://github.com:8443/acme/app", ""]) {
      expect(() => githubRepo(bad), bad).toThrow();
    }
  });

  it("refuses repositories off the allow-list, injection in every field and unknown fields", () => {
    expect(() => checkCiRequest({ repo: "evil/app", artifact: "apk" }, settings)).toThrow(/not on this host's list/);
    expect(checkCiRequest({ repo: "https://github.com/ACME/app", artifact: "app-debug" }, settings)).toEqual({ repo: "acme/app", artifact: "app-debug" });
    for (const body of [
      { repo: "acme/app", artifact: "../../etc/passwd" },
      { repo: "acme/app", artifact: "apk; rm -rf /" },
      { repo: "acme/app", artifact: "--paginate" },
      { repo: "acme/app", artifact: "apk", run: "123 --method DELETE" },
      { repo: "acme/app", artifact: "apk", run: "-1" },
      { repo: "acme/app", artifact: "apk", run: 123 },
      { repo: "acme/app", artifact: "apk", branch: "main&per_page=100" },
      { repo: "acme/app", artifact: "apk", branch: "--jq" },
      { repo: "acme/app", artifact: "apk", branch: "../main" },
      { repo: "acme/app", artifact: "apk", run: "12", branch: "main" },
      { repo: "acme/app", artifact: "apk", url: "https://evil.example/app.apk" },
      { repo: "acme/app", artifact: "apk", path: "/Users/owner/.ssh/id_ed25519" },
      { repo: "acme/app" },
      [],
    ]) {
      expect(() => checkCiRequest(body, settings), JSON.stringify(body)).toThrow();
    }
    expect(() => checkCiRequest({ repo: "acme/app", artifact: "apk", branch: "feature" }, { ...settings, branches: ["main"] })).toThrow(/only from runs on main/);
  });
});

describe("install from CI: unpacking the artifact", () => {
  const dir = () => mkdtemp(join(tmpdir(), "td-ci-zip-"));
  const extract = async (zip: Buffer) => {
    const d = await dir();
    await writeFile(join(d, "a.zip"), zip);
    const name = await extractApk(join(d, "a.zip"), join(d, "out.apk"), 1024 * 1024);
    return { name, content: await readFile(join(d, "out.apk")), mode: (await stat(join(d, "out.apk"))).mode & 0o777 };
  };

  it("unpacks the newest .apk, deflated or stored, owner-only", async () => {
    const r = await extract(makeZip([{ name: "old/app-debug.apk", data: Buffer.from("old"), date: 0x5a00 }, { name: "app-debug.apk", data: APK, date: 0x5a21 }, { name: "mapping.txt", data: Buffer.from("m"), method: 0 }]));
    expect(r).toEqual({ name: "app-debug.apk", content: APK, mode: 0o600 });
    expect((await extract(makeZip([{ name: "a.apk", data: APK, method: 0 }]))).content).toEqual(APK);
  });

  it("refuses the whole zip when an entry leaves its folder or is a symlink", async () => {
    await expect(extract(makeZip([{ name: "app.apk", data: APK }, { name: "../../.zshrc", data: Buffer.from("evil") }]))).rejects.toThrow(/leaves its folder/);
    await expect(extract(makeZip([{ name: "app.apk", data: APK }, { name: "/etc/passwd", data: Buffer.from("x") }]))).rejects.toThrow(/leaves its folder/);
    await expect(extract(makeZip([{ name: "app.apk", data: APK }, { name: "a\\..\\b", data: Buffer.from("x") }]))).rejects.toThrow(/leaves its folder/);
    await expect(extract(makeZip([{ name: "link.apk", data: Buffer.from("/Users/owner/.ssh/id_ed25519"), mode: 0o120777 }]))).rejects.toThrow(/symbolic link/);
  });

  it("refuses an .aab with a hint, a zip without an .apk, a lying checksum and a non-zip", async () => {
    await expect(extract(makeZip([{ name: "app-release.aab", data: APK }]))).rejects.toMatchObject({ code: "USAGE", hint: expect.stringMatching(/tapdance app install <file.aab>/) });
    await expect(extract(makeZip([{ name: "README.md", data: Buffer.from("x") }]))).rejects.toThrow(/no \.apk/);
    const zip = makeZip([{ name: "app.apk", data: APK, method: 0 }]);
    zip[40] = zip[40]! ^ 0xff; // flip a byte of the stored content
    await expect(extract(zip)).rejects.toThrow(/different content/);
    await expect(extract(Buffer.from("not a zip at all"))).rejects.toThrow(/not a zip/);
  });
});

describe("install from CI: fetching with the host's gh (fake gh, mocked)", () => {
  it("takes the newest successful run on the default branch that has the artifact, then reuses the download", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-ci-cache-"));
    const gh = fakeGh({ runs: [okRun(30), okRun(20)], artifacts: { "20": [{ id: 7, name: "app-debug", size: 1000, expired: false }] }, zip: makeZip([{ name: "app-debug.apk", data: APK }]) });
    const lines: string[] = [];
    const first = await fetchCiApk({ repo: "acme/app", artifact: "app-debug" }, settings, root, (l) => lines.push(l), gh.run);
    expect(first).toMatchObject({ repo: "acme/app", runId: "20", artifactId: "7", sha: SHA, branch: "main", cached: false });
    expect(await readFile(first.apk)).toEqual(APK);
    expect(gh.downloads()).toBe(1);
    // gh is called with argument arrays; the branch and artifact travel as -f fields, never in a URL the agent wrote.
    expect(gh.calls.find((c) => c.includes("repos/acme/app/actions/runs"))).toEqual(expect.arrayContaining(["-X", "GET", "-f", "branch=main", "-f", "status=success"]));
    const again = await fetchCiApk({ repo: "acme/app", artifact: "app-debug" }, settings, root, () => undefined, gh.run);
    expect(again).toMatchObject({ runId: "20", cached: true, apkSha256: first.apkSha256 });
    expect(gh.downloads()).toBe(1);
    const repoDir = (await readdir(root))[0]!;
    expect((await stat(join(root, repoDir))).mode & 0o777).toBe(0o700);
    expect((await stat(first.apk)).mode & 0o777).toBe(0o600);
  });

  it("keeps the newest three downloads per repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-ci-prune-"));
    for (const id of [1, 2, 3, 4]) {
      const gh = fakeGh({ run: okRun(id), artifacts: { [String(id)]: [{ id: 100 + id, name: "apk", size: 10, expired: false }] }, zip: makeZip([{ name: "app.apk", data: APK }]) });
      await fetchCiApk({ repo: "acme/app", artifact: "apk", run: String(id) }, settings, root, () => undefined, gh.run);
      await new Promise((r) => setTimeout(r, 5));
    }
    const repoDir = (await readdir(root))[0]!;
    expect((await readdir(join(root, repoDir))).sort()).toEqual(["2-102", "3-103", "4-104"]);
  });

  it("refuses an oversized artifact before downloading it, a fork's run, a failed run and a branch off the list", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-ci-refuse-"));
    const big = fakeGh({ run: okRun(5), artifacts: { "5": [{ id: 9, name: "apk", size: 6 * 1024 * 1024, expired: false }] } });
    await expect(fetchCiApk({ repo: "acme/app", artifact: "apk", run: "5" }, settings, root, () => undefined, big.run)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/up to 5 MB/) });
    expect(big.downloads()).toBe(0);
    const fork = fakeGh({ run: okRun(5, "main", "mallory/app"), artifacts: { "5": [{ id: 9, name: "apk", size: 10, expired: false }] } });
    await expect(fetchCiApk({ repo: "acme/app", artifact: "apk", run: "5" }, settings, root, () => undefined, fork.run)).rejects.toThrow(/another repository/);
    const failed = fakeGh({ run: { ...okRun(5), conclusion: "failure" } });
    await expect(fetchCiApk({ repo: "acme/app", artifact: "apk", run: "5" }, settings, root, () => undefined, failed.run)).rejects.toThrow(/has not succeeded/);
    const feature = fakeGh({ run: okRun(5, "feature") });
    await expect(fetchCiApk({ repo: "acme/app", artifact: "apk", run: "5" }, { ...settings, branches: ["main"] }, root, () => undefined, feature.run)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Forks' runs on a branch of the same name are skipped, so none is found.
    const forked = fakeGh({ runs: [okRun(6, "main", "mallory/app")], artifacts: { "6": [{ id: 9, name: "apk", size: 10, expired: false }] } });
    await expect(fetchCiApk({ repo: "acme/app", artifact: "apk" }, settings, root, () => undefined, forked.run)).rejects.toThrow(/No recent successful run on main of acme\/app has an artifact named apk/);
    expect(forked.downloads()).toBe(0);
  });

  it("tells the owner how to sign gh in when it is not", async () => {
    const root = await mkdtemp(join(tmpdir(), "td-ci-auth-"));
    const gh = fakeGh({ fail: "To get started with GitHub CLI, please run:  gh auth login" });
    await expect(fetchCiApk({ repo: "acme/app", artifact: "apk" }, settings, root, () => undefined, gh.run)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", hint: expect.stringMatching(/gh auth login --with-token.*Actions: read/) });
  });
});
