import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, crc32 } from "node:zlib";
import { TapdanceError } from "@tapdance/core";
import { hostNetworkHint, spawnRunner, type CommandRunner } from "./build.js";
import { repoDisplay, repoSlug } from "./build-files.js";

/**
 * Installs an Android APK that the user's own CI built (a GitHub Actions artifact) on a lease. The
 * host downloads it with its own `gh auth` (a fine-grained, read-only token), so the agent never holds
 * a GitHub credential and the APK never crosses the agent's link to the host. The worker guard runs
 * it; nothing here is reachable without `allow.artifacts`.
 *
 * Unlike a build on the host, nothing from the repository runs on this machine: the host only reads
 * the GitHub API, unpacks one .apk from the artifact's zip (without a zip tool) and installs it with adb.
 */

export interface CiInstallRequest {
  /** owner/repo, or a github.com URL of the repository. */
  repo: string;
  /** The artifact's name, as actions/upload-artifact gave it. */
  artifact: string;
  /** A workflow run id; else the newest successful run on `branch` (default: the repository's default branch). */
  run?: string;
  branch?: string;
}

export interface ArtifactSettings {
  /** Repositories (owner/repo or github.com URLs) whose CI artifacts may be installed. */
  repos: string[];
  /** When set, only runs whose head branch is listed. */
  branches: string[];
  /** The largest artifact (zip) and APK, in MB. */
  maxMB: number;
}

export interface CiApk {
  /** owner/repo, as GitHub's API names it. */
  repo: string;
  runId: string;
  sha: string;
  branch: string;
  artifact: string;
  artifactId: string;
  /** The APK on this machine. */
  apk: string;
  apkSha256: string;
  /** The same run's artifact was downloaded before: that copy was used. */
  cached: boolean;
}

export const ARTIFACT_NAME = /^(?![-.])[A-Za-z0-9._-]{1,100}$/;
export const RUN_ID = /^[1-9][0-9]{0,19}$/;
/** A branch name git accepts, without the forms that look like options, ranges or paths out. */
export const BRANCH_NAME = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*[/.]$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/**
 * A GitHub repository as `owner/repo`: from `owner/repo`, https://github.com/owner/repo(.git) or
 * git@github.com:owner/repo.git. Other hosts and anything with more path are refused.
 */
export function githubRepo(input: string): string {
  const refuse = (why: string): never => {
    throw new TapdanceError("USAGE", `${JSON.stringify(String(input).slice(0, 200))} ${why}`, { hint: "Name the repository as owner/repo, e.g. acme/app, or its https://github.com/owner/repo URL." });
  };
  if (typeof input !== "string" || input.length === 0 || input.length > 300) return refuse("is not a GitHub repository");
  let path = input.trim();
  if (/^(https:\/\/|ssh:\/\/|git@)/.test(path)) {
    let identity: string;
    try {
      identity = repoDisplay(path);
    } catch {
      return refuse("is not a GitHub repository URL");
    }
    if (!identity.startsWith("github.com/")) return refuse("is not on github.com (only GitHub Actions artifacts are supported)");
    path = identity.slice("github.com/".length);
  } else if (/[:@\\?#\s]/.test(path)) return refuse("is not a GitHub repository");
  const parts = path.split("/");
  if (parts.length !== 2 || !OWNER.test(parts[0]!) || !NAME.test(parts[1]!)) return refuse("is not owner/repo");
  return `${parts[0]}/${parts[1]}`;
}

/** Checks a request against the owner's settings; throws a TapdanceError naming what to fix. */
export function checkCiRequest(body: unknown, settings: ArtifactSettings): CiInstallRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new TapdanceError("USAGE", "The request must be a JSON object with repo and artifact");
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !["repo", "artifact", "run", "branch"].includes(k));
  if (unknown.length > 0) throw new TapdanceError("USAGE", `Unknown field ${unknown[0]}: an install from CI takes repo, artifact, and run or branch`);
  if (typeof b["repo"] !== "string" || typeof b["artifact"] !== "string") throw new TapdanceError("USAGE", "An install from CI needs repo (owner/repo) and artifact (its name)");
  const repo = githubRepo(b["repo"]);
  const allowed = settings.repos.map((r) => {
    try {
      return githubRepo(r).toLowerCase();
    } catch {
      return undefined;
    }
  });
  if (!allowed.includes(repo.toLowerCase())) {
    throw new TapdanceError("FORBIDDEN", `${repo} is not on this host's list of repositories it installs CI artifacts from`, { hint: `The host owner adds it on the host: tapdance host artifacts enable --repo ${repo}` });
  }
  const artifact = b["artifact"];
  if (!ARTIFACT_NAME.test(artifact)) throw new TapdanceError("USAGE", "artifact must be the artifact's name: 1 to 100 letters, digits and . _ - (not starting with - or .)");
  const req: CiInstallRequest = { repo, artifact };
  if (b["run"] !== undefined) {
    if (typeof b["run"] !== "string" || !RUN_ID.test(b["run"])) throw new TapdanceError("USAGE", "run must be a workflow run id (digits only)");
    req.run = b["run"];
  }
  if (b["branch"] !== undefined) {
    if (typeof b["branch"] !== "string" || !BRANCH_NAME.test(b["branch"])) throw new TapdanceError("USAGE", "branch must be a git branch name");
    if (req.run) throw new TapdanceError("USAGE", "Pass run or branch, not both");
    branchAllowed(b["branch"], settings, repo);
    req.branch = b["branch"];
  }
  return req;
}

function branchAllowed(branch: string, settings: ArtifactSettings, repo: string): void {
  if (settings.branches.length === 0 || settings.branches.includes(branch)) return;
  throw new TapdanceError("FORBIDDEN", `This host installs CI artifacts only from runs on ${settings.branches.join(", ")}, not ${branch}`, {
    hint: `Use a run on an allowed branch, or ask the host owner to allow it: tapdance host artifacts enable --repo ${repo} --branch ${branch}`,
  });
}

/** What the host owner does when the host's gh cannot read the repository. */
export const OWNER_GH_HINT =
  "Only the host's owner can fix this (an agent cannot): on the host, run `gh auth login --with-token` with a fine-grained, read-only GitHub token for this repository (permissions Actions: read and Contents: read). `tapdance host artifacts status` on the host shows whether gh works.";

/** gh's environment: never prompts, never pages, no colour codes in its output. */
export function ghEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" };
}

/** A failed gh call as an error that says whose problem it is. */
export function ghFailure(output: string, what: string, repo: string, code: number): TapdanceError {
  const last = output.trim().split("\n").filter((l) => l.trim()).slice(-3).join(" ").slice(0, 400);
  const offline = hostNetworkHint(output) ?? (/dial tcp|no such host|i\/o timeout|connection (refused|reset)/i.test(output) ? "The host cannot reach api.github.com. This is the host's network, not yours: only the host owner can fix it." : undefined);
  if (offline) return new TapdanceError("PROVIDER_UNAVAILABLE", `The host could not reach GitHub for ${what}: ${last}`, { hint: offline, details: { reason: "HOST_NETWORK" } });
  if (/gh auth login|not logged in|authentication required|HTTP 401|Bad credentials|requires authentication/i.test(output)) {
    return new TapdanceError("PROVIDER_UNAVAILABLE", "The host's gh is not signed in to GitHub", { hint: OWNER_GH_HINT, details: { reason: "GH_AUTH" } });
  }
  if (/rate limit/i.test(output)) return new TapdanceError("NO_CAPACITY", `GitHub's API rate limit stopped ${what}`, { hint: "Try again in a few minutes." });
  if (/HTTP 410|expired/i.test(output)) return new TapdanceError("USAGE", `The artifact of ${repo} has expired on GitHub (${what})`, { hint: "Run the workflow again, or pick a newer run." });
  if (/HTTP 404|Not Found/i.test(output)) {
    return new TapdanceError("USAGE", `GitHub answered 404 for ${what}: the run or artifact does not exist, or the host's token cannot read ${repo}`, { hint: `Check the run id and artifact name. If they are right: ${OWNER_GH_HINT}`, details: { reason: "GH_NOT_FOUND" } });
  }
  if (/HTTP 403|Resource not accessible|Forbidden/i.test(output)) {
    return new TapdanceError("FORBIDDEN", `The host's GitHub token may not read ${what} of ${repo}`, { hint: OWNER_GH_HINT, details: { reason: "GH_AUTH" } });
  }
  return new TapdanceError("DEVICE_ERROR", `gh failed for ${what} (exit ${code})${last ? `: ${last}` : ""}`);
}

/** The outcome of checking that this host's gh can read a repository and its Actions artifacts. */
export interface CiAccess {
  repo: string;
  ok: boolean;
  /** gh's own words when it failed. */
  detail?: string;
  hint?: string;
  reason?: string;
}

/**
 * Checks that this host's gh can read `repo` and list its Actions artifacts (#86): the two reads an
 * install from CI starts with, without downloading anything. Never throws: the caller warns.
 */
export async function ciAccessProbe(input: string, run: CommandRunner = spawnRunner): Promise<CiAccess> {
  let repo: string;
  try {
    repo = githubRepo(input);
  } catch (error) {
    return { repo: input, ok: false, detail: (error as Error).message, reason: "USAGE" };
  }
  for (const [path, what] of [
    [`repos/${repo}`, "the repository"],
    [`repos/${repo}/actions/artifacts?per_page=1`, "its Actions artifacts"],
  ] as const) {
    let r: { code: number; output: string };
    try {
      r = await run("gh", ["api", path, "--jq", ".id // .total_count"], { env: ghEnv(), timeoutMs: 30_000, onLine: () => undefined });
    } catch (error) {
      return { repo, ok: false, detail: `gh could not run: ${(error as Error).message}`, hint: `GitHub's CLI must be installed on this machine (https://cli.github.com). ${OWNER_GH_HINT}`, reason: "GH_MISSING" };
    }
    if (r.code !== 0) {
      const e = ghFailure(r.output, what, repo, r.code);
      return { repo, ok: false, detail: e.message, ...(e.hint ? { hint: e.hint } : {}), reason: typeof e.details?.["reason"] === "string" ? (e.details["reason"] as string) : e.code };
    }
  }
  return { repo, ok: true };
}

interface RunInfo {
  id: number | string;
  head_branch: string | null;
  head_sha: string;
  conclusion: string | null;
  status: string | null;
  head_repo: string | null;
}
interface ArtifactInfo {
  id: number | string;
  name: string;
  size: number;
  expired: boolean;
}

const RUN_FIELDS = "{id, head_branch, head_sha, conclusion, status, head_repo: .head_repository.full_name}";

/** The last line of gh's output that is JSON (gh's --jq prints `@json` as one raw line). */
function lastJson<T>(output: string, what: string): T {
  const lines = output.trim().split("\n").reverse();
  for (const line of lines) {
    const l = line.trim();
    if (!l.startsWith("{") && !l.startsWith("[") && !l.startsWith('"')) continue;
    try {
      return JSON.parse(l) as T;
    } catch {
      // Not this one.
    }
  }
  throw new TapdanceError("DEVICE_ERROR", `gh gave no readable answer for ${what}`);
}

/**
 * Finds the run and artifact `req` names, downloads the artifact with the host's gh (or reuses an
 * earlier download of it), unpacks its newest .apk and returns where it is.
 */
export async function fetchCiApk(
  req: CiInstallRequest,
  settings: ArtifactSettings,
  root: string,
  onLine: (line: string) => void,
  run: CommandRunner = spawnRunner,
): Promise<CiApk> {
  const repo = req.repo;
  const env = ghEnv();
  const maxBytes = settings.maxMB * 1024 * 1024;
  const gh = async <T>(args: string[], what: string): Promise<T> => {
    let r: { code: number; output: string };
    try {
      r = await run("gh", args, { env, timeoutMs: 60_000, onLine: () => undefined });
    } catch (error) {
      throw new TapdanceError("PROVIDER_UNAVAILABLE", `gh could not start on the host: ${(error as Error).message}`, { hint: `GitHub's CLI must be installed on the host (https://cli.github.com). ${OWNER_GH_HINT}` });
    }
    if (r.code !== 0) throw ghFailure(r.output, what, repo, r.code);
    return lastJson<T>(r.output, what);
  };
  const artifactsOf = (runId: string) =>
    gh<ArtifactInfo[]>(
      ["api", "-X", "GET", `repos/${repo}/actions/runs/${runId}/artifacts`, "-f", "per_page=100", "-f", `name=${req.artifact}`, "--jq", "[.artifacts[] | {id, name, size: .size_in_bytes, expired}] | @json"],
      `the artifacts of run ${runId}`,
    );
  const fromThisRepo = (r: RunInfo) => (r.head_repo ?? "").toLowerCase() === repo.toLowerCase();

  let chosen: { run: RunInfo; artifact: ArtifactInfo } | undefined;
  if (req.run) {
    onLine(`Looking up run ${req.run} of ${repo}`);
    const info = await gh<RunInfo>(["api", `repos/${repo}/actions/runs/${req.run}`, "--jq", `${RUN_FIELDS} | @json`], `run ${req.run}`);
    if (info.conclusion !== "success") {
      throw new TapdanceError("USAGE", `Run ${req.run} of ${repo} has not succeeded (${info.conclusion ?? info.status ?? "unknown"})`, { hint: "Install from a run that finished successfully, or pass --branch to take the newest successful run." });
    }
    if (!fromThisRepo(info)) {
      throw new TapdanceError("FORBIDDEN", `Run ${req.run} built code from another repository (${info.head_repo ?? "unknown"}), such as a fork's pull request`, { hint: `Install from a run of ${repo}'s own branches.` });
    }
    branchAllowed(info.head_branch ?? "", settings, repo);
    const found = (await artifactsOf(req.run)).find((a) => a.name === req.artifact && !a.expired);
    if (!found) throw new TapdanceError("USAGE", `Run ${req.run} of ${repo} has no artifact named ${req.artifact} (or it has expired)`, { hint: "Check the name actions/upload-artifact gives it in the workflow." });
    chosen = { run: info, artifact: found };
  } else {
    const branch = req.branch ?? (await gh<string>(["api", `repos/${repo}`, "--jq", ".default_branch | @json"], "the repository"));
    if (typeof branch !== "string" || !BRANCH_NAME.test(branch)) throw new TapdanceError("DEVICE_ERROR", `GitHub named an unexpected default branch for ${repo}`);
    branchAllowed(branch, settings, repo);
    onLine(`Looking for the newest successful run on ${branch} of ${repo} with an artifact named ${req.artifact}`);
    const runs = await gh<RunInfo[]>(
      ["api", "-X", "GET", `repos/${repo}/actions/runs`, "-f", `branch=${branch}`, "-f", "status=success", "-f", "exclude_pull_requests=true", "-f", "per_page=20", "--jq", `[.workflow_runs[] | ${RUN_FIELDS}] | @json`],
      `the runs on ${branch}`,
    );
    for (const r of runs.filter((x) => x.conclusion === "success" && x.head_branch === branch && fromThisRepo(x))) {
      const found = (await artifactsOf(String(r.id))).find((a) => a.name === req.artifact && !a.expired);
      if (found) {
        chosen = { run: r, artifact: found };
        break;
      }
    }
    if (!chosen) {
      throw new TapdanceError("USAGE", `No recent successful run on ${branch} of ${repo} has an artifact named ${req.artifact}`, {
        hint: "Check that the workflow uploads it with actions/upload-artifact under that name, that the run finished successfully and that the artifact has not expired; or pass --run <id> for a specific run.",
      });
    }
  }

  const runId = String(chosen.run.id);
  const artifactId = String(chosen.artifact.id);
  if (!RUN_ID.test(runId) || !RUN_ID.test(artifactId) || !/^[0-9a-f]{40}$/.test(chosen.run.head_sha ?? "")) throw new TapdanceError("DEVICE_ERROR", "GitHub answered with an unexpected run or artifact id");
  const base = { repo, runId, sha: chosen.run.head_sha, branch: chosen.run.head_branch ?? "", artifact: req.artifact, artifactId };
  if (!(chosen.artifact.size <= maxBytes)) {
    throw new TapdanceError("FORBIDDEN", `Artifact ${req.artifact} is ${Math.ceil(chosen.artifact.size / 1024 / 1024)} MB; this host installs artifacts up to ${settings.maxMB} MB`, {
      hint: "Upload only the debug APK in that artifact, or ask the host owner to raise the limit: tapdance host artifacts enable --repo <owner/repo> --max-mb <n>",
    });
  }

  const repoDir = join(root, repoSlug(`https://github.com/${repo}`));
  const dir = join(repoDir, `${runId}-${artifactId}`);
  const cached = await readCached(dir);
  if (cached) {
    onLine(`Using the copy of ${req.artifact} from run ${runId} this host downloaded before`);
    await touchCached(dir, cached);
    return { ...base, apk: join(dir, "app.apk"), apkSha256: cached.apkSha256, cached: true };
  }

  await ownerDir(root);
  await ownerDir(repoDir);
  const work = join(repoDir, `.download-${randomBytes(6).toString("hex")}`);
  await ownerDir(work);
  try {
    const zip = join(work, "artifact.zip");
    onLine(`Downloading ${req.artifact} (${Math.max(1, Math.round(chosen.artifact.size / 1024 / 1024))} MB) from run ${runId} at ${chosen.run.head_sha.slice(0, 12)}`);
    let r: { code: number; output: string; truncated?: boolean };
    try {
      r = await run("gh", ["api", `repos/${repo}/actions/artifacts/${artifactId}/zip`], { env, timeoutMs: 20 * 60_000, onLine: () => undefined, stdoutPath: zip, maxStdoutBytes: maxBytes });
    } catch (error) {
      throw new TapdanceError("PROVIDER_UNAVAILABLE", `gh could not start on the host: ${(error as Error).message}`, { hint: OWNER_GH_HINT });
    }
    if (r.truncated) throw new TapdanceError("FORBIDDEN", `Artifact ${req.artifact} is larger than this host's limit of ${settings.maxMB} MB`, { hint: "Upload only the debug APK in that artifact." });
    if (r.code !== 0) throw ghFailure(r.output, `downloading artifact ${req.artifact}`, repo, r.code);
    const entry = await extractApk(zip, join(work, "app.apk"), maxBytes);
    await rm(zip, { force: true });
    const apkSha256 = createHash("sha256").update(await readFile(join(work, "app.apk"))).digest("hex");
    const meta: CacheMeta = { ...base, entry, apkSha256, fetchedAt: new Date().toISOString(), usedAt: new Date().toISOString() };
    await writeFile(join(work, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    await rm(dir, { recursive: true, force: true });
    await rename(work, dir);
    onLine(`Unpacked ${entry} (sha256 ${apkSha256.slice(0, 12)})`);
    await pruneCache(repoDir);
    return { ...base, apk: join(dir, "app.apk"), apkSha256, cached: false };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

interface CacheMeta {
  repo: string;
  runId: string;
  sha: string;
  branch: string;
  artifact: string;
  artifactId: string;
  entry: string;
  apkSha256: string;
  fetchedAt: string;
  usedAt: string;
}

async function readCached(dir: string): Promise<CacheMeta | undefined> {
  try {
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as CacheMeta;
    const apk = await readFile(join(dir, "app.apk"));
    return createHash("sha256").update(apk).digest("hex") === meta.apkSha256 ? meta : undefined;
  } catch {
    return undefined;
  }
}

async function touchCached(dir: string, meta: CacheMeta): Promise<void> {
  await writeFile(join(dir, "meta.json"), `${JSON.stringify({ ...meta, usedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
}

/** Keeps the `keep` most recently used downloads of one repository. */
async function pruneCache(repoDir: string, keep = 3): Promise<void> {
  const kept: Array<{ name: string; usedAt: string }> = [];
  for (const name of await readdir(repoDir).catch(() => [] as string[])) {
    if (!/^\d+-\d+$/.test(name)) continue;
    const meta = await readFile(join(repoDir, name, "meta.json"), "utf8").then((t) => JSON.parse(t) as Partial<CacheMeta>).catch(() => ({}) as Partial<CacheMeta>);
    kept.push({ name, usedAt: typeof meta.usedAt === "string" ? meta.usedAt : "" });
  }
  kept.sort((a, b) => b.usedAt.localeCompare(a.usedAt));
  for (const old of kept.slice(keep)) await rm(join(repoDir, old.name), { recursive: true, force: true });
}

/** The bytes the artifact cache holds. */
export async function artifactCacheBytes(root: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    for (const name of await readdir(d).catch(() => [] as string[])) {
      const p = join(d, name);
      const info = await stat(p).catch(() => undefined);
      if (info?.isDirectory()) await walk(p);
      else if (info?.isFile()) total += info.size;
    }
  };
  if (existsSync(root)) await walk(root);
  return total;
}

async function ownerDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

// ------------------------------------------------------------------ zip

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  /** DOS date and time as one sortable number. */
  modified: number;
  symlink: boolean;
  directory: boolean;
}

const zipError = (why: string, hint?: string) => new TapdanceError("USAGE", `The artifact ${why}`, hint ? { hint } : {});

/** Reads a zip file's central directory (zip64 included), without extracting anything. */
export async function readZipEntries(path: string, maxEntries = 10_000): Promise<ZipEntry[]> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw zipError("is not a zip file");
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw zipError("has a damaged zip64 directory");
      const rec = Buffer.alloc(56);
      await fh.read(rec, 0, 56, Number(tail.readBigUInt64LE(loc + 8)));
      if (rec.readUInt32LE(0) !== 0x06064b50) throw zipError("has a damaged zip64 directory");
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    if (count > maxEntries) throw zipError(`holds more than ${maxEntries} files`);
    if (cdOffset + cdSize > size || cdSize > 64 * 1024 * 1024) throw zipError("has a damaged zip directory");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw zipError("has a damaged zip directory");
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const time = cd.readUInt16LE(p + 12);
      const date = cd.readUInt16LE(p + 14);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressed = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      let localOffset = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw zipError("has a damaged zip directory");
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      // zip64 sizes and offset live in extra field 0x0001, in this order, for the fields set to 0xffffffff.
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          const next = () => {
            if (q + 8 > e + 4 + len) throw zipError("has a damaged zip64 entry");
            const v = Number(cd.readBigUInt64LE(q));
            q += 8;
            return v;
          };
          if (uncompressed === 0xffffffff) uncompressed = next();
          if (compressedSize === 0xffffffff) compressedSize = next();
          if (localOffset === 0xffffffff) localOffset = next();
        }
        e += 4 + len;
      }
      const mode = external >>> 16;
      entries.push({
        name,
        method,
        flags,
        crc,
        compressedSize,
        size: uncompressed,
        localOffset,
        modified: date * 65_536 + time,
        // Unix-made entries carry the file type in the high bits of the external attributes.
        symlink: madeBy >> 8 === 3 && (mode & 0o170000) === 0o120000,
        directory: name.endsWith("/") || (madeBy >> 8 === 3 && (mode & 0o170000) === 0o040000),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** Refuses a zip with any entry that could write outside its folder, a link, or encryption. */
export function checkZipEntries(entries: ZipEntry[]): void {
  for (const entry of entries) {
    const n = entry.name;
    const segments = n.split("/");
    if (n.length === 0 || n.includes("\0") || n.includes("\\") || n.startsWith("/") || /^[A-Za-z]:/.test(n) || segments.includes("..")) {
      throw zipError(`has an entry whose path leaves its folder (${JSON.stringify(n.slice(0, 200))}); it was not unpacked`);
    }
    if (entry.symlink) throw zipError(`holds a symbolic link (${JSON.stringify(n.slice(0, 200))}); it was not unpacked`);
    if (entry.flags & 1) throw zipError("is encrypted");
  }
}

/**
 * Unpacks the newest .apk of the zip at `zipPath` to `dest` (a path this machine chooses). Refuses the
 * whole zip when any entry is unsafe, and an .aab or a zip without an .apk with a hint.
 */
export async function extractApk(zipPath: string, dest: string, maxBytes: number): Promise<string> {
  const entries = await readZipEntries(zipPath);
  checkZipEntries(entries);
  const apks = entries.filter((e) => !e.directory && /\.apk$/i.test(e.name)).sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  const apk = apks[0];
  if (!apk) {
    if (entries.some((e) => /\.aab$/i.test(e.name))) {
      throw zipError("holds an Android App Bundle (.aab), not an .apk", "Have the workflow upload an APK (e.g. ./gradlew assembleDebug and app/build/outputs/apk/debug/*.apk), or download the .aab and install it from your machine with `tapdance app install <file.aab>` (bundletool converts it there).");
    }
    const names = entries.filter((e) => !e.directory).slice(0, 10).map((e) => e.name);
    throw zipError(`holds no .apk${names.length ? ` (it has ${names.join(", ")})` : ""}`, "Have the workflow upload the APK, e.g. app/build/outputs/apk/debug/*.apk.");
  }
  if (apk.method !== 0 && apk.method !== 8) throw zipError(`stores ${apk.name} with an unsupported compression method (${apk.method})`);
  if (apk.size === 0) throw zipError(`holds an empty ${apk.name}`);
  if (apk.size > maxBytes) throw new TapdanceError("FORBIDDEN", `${apk.name} is ${Math.ceil(apk.size / 1024 / 1024)} MB unpacked, more than this host's limit of ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const fh = await open(zipPath, "r");
  let dataStart: number;
  let fileSize: number;
  try {
    fileSize = (await fh.stat()).size;
    const local = Buffer.alloc(30);
    await fh.read(local, 0, 30, apk.localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) throw zipError("has a damaged entry");
    dataStart = apk.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  if (apk.compressedSize === 0 || dataStart + apk.compressedSize > fileSize) throw zipError("has a damaged entry");
  let written = 0;
  let crc = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, done) {
      written += chunk.length;
      if (written > apk.size) return done(zipError(`unpacks ${apk.name} to more bytes than its directory says; it was not installed`));
      crc = crc32(chunk, crc);
      done(null, chunk);
    },
  });
  const source = createReadStream(zipPath, { start: dataStart, end: dataStart + apk.compressedSize - 1 });
  const sink = createWriteStream(dest, { mode: 0o600, flags: "wx" });
  try {
    if (apk.method === 8) await pipeline(source, createInflateRaw(), check, sink);
    else await pipeline(source, check, sink);
  } catch (error) {
    await rm(dest, { force: true });
    if (error instanceof TapdanceError) throw error;
    throw zipError(`could not be unpacked: ${(error as Error).message}`);
  }
  if (written !== apk.size || crc >>> 0 !== apk.crc >>> 0) {
    await rm(dest, { force: true });
    throw zipError(`unpacks ${apk.name} to different content than its directory says (size or checksum); it was not installed`);
  }
  await chmod(dest, 0o600);
  return apk.name;
}
