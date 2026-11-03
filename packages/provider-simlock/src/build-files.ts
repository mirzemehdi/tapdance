import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { TapdanceError } from "@tapdance/core";

/**
 * Per-repository material the host owner keeps for builds on the host: a deploy key per repository
 * (GitHub refuses one deploy key on a second repository) and "build files", config a repository keeps
 * out of git (google-services.json, local.properties, .env) that the host copies into the checkout
 * before each build. Owner-only: the CLI on the host writes them; no guard route or MCP tool reads or
 * writes them. Layout under the builds folder (`~/.tapdance/worker/builds`):
 *
 *   keys/<slug>, keys/<slug>.pub         a repository's deploy key (600; folder 700)
 *   files/<slug>/index.json              the repository and its files: path, size, sha256
 *   files/<slug>/blobs/<sha256>          each file's content (600; folders 700)
 */

export const BUILD_FILE_MAX_BYTES = 1024 * 1024;
export const BUILD_FILES_MAX = 50;

/** A repository URL as compared with the allow-list: lower-case host, no trailing slash or .git. */
export function normalizeRepo(url: string): string {
  let u = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const ssh = /^git@([^:]+):(.+)$/.exec(u);
  if (ssh) u = `ssh://git@${ssh[1]}/${ssh[2]}`;
  return u.replace(/^([a-z+]+:\/\/)([^/]+)/i, (_m, scheme: string, host: string) => `${scheme.toLowerCase()}${host.toLowerCase()}`);
}

export interface BuildFileEntry {
  /** Where the file goes, relative to the repository root (forward slashes). */
  path: string;
  sha256: string;
  size: number;
  addedAt: string;
}

/** A repository's host and path, as one repository: scheme, user, `.git` and case do not matter. */
export function repoIdentity(url: string): string {
  const m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(normalizeRepo(url));
  if (!m) throw new TapdanceError("USAGE", `${url} is not an https:// or ssh git URL`, { hint: "Use the URL you clone with, e.g. https://github.com/owner/repo or git@github.com:owner/repo.git." });
  return `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase().replace(/\/+/g, "/")}`;
}

/**
 * A file-system-safe folder name for a repository: readable host and path, plus a hash of them so two
 * repositories whose readable parts sanitize to the same text still differ. The https and ssh URLs of
 * one repository give the same slug.
 */
export function repoSlug(url: string): string {
  const identity = repoIdentity(url);
  const readable = identity
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 80)
    .replace(/[-.]+$/, "");
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 10);
  return `${readable || "repo"}-${hash}`;
}

/** The deploy key `host builds key --repo <url>` creates for one repository. */
export function repoKeyPath(buildsRoot: string, repo: string): string {
  return join(buildsRoot, "keys", repoSlug(repo));
}

/** The folder that holds one repository's build files. */
export function buildFilesDir(buildsRoot: string, repo: string): string {
  return join(buildsRoot, "files", repoSlug(repo));
}

const SEGMENT = /^[A-Za-z0-9 _.+@,=-]{1,200}$/;

/** Checks a build file's path inside the repository; returns it with forward slashes. */
export function checkBuildFilePath(path: string): string {
  const refuse = (why: string): never => {
    throw new TapdanceError("USAGE", `Build file path ${JSON.stringify(path)} ${why}`, { hint: "Give a path relative to the repository root, e.g. androidApp/google-services.json or local.properties." });
  };
  if (typeof path !== "string" || path.length === 0 || path.length > 300) refuse("must be 1 to 300 characters");
  if (path.startsWith("/") || path.startsWith("\\") || path.startsWith("~") || /^[A-Za-z]:/.test(path)) refuse("is absolute: give a path inside the repository");
  if (path.includes("\\") || path.includes("\0")) refuse("must use forward slashes");
  const segments = path.split("/");
  // .gitmodules would change what git fetches; .github/ and other dot-files are ordinary content.
  if (/^\.git(modules)?$/i.test(segments[0]!)) refuse("is one of git's own files (.git, .gitmodules): those are never written");
  for (const s of segments) {
    if (s === "..") refuse("contains ..: it must stay inside the repository");
    if (s === "" || s === ".") refuse("has an empty or . part");
    if (/^\.git$/i.test(s)) refuse("is in a .git folder: those are never written");
    if (!SEGMENT.test(s)) refuse("has characters that are not allowed (letters, digits, space and _ . + @ , = - only)");
  }
  return segments.join("/");
}

interface Index {
  repo: string;
  files: BuildFileEntry[];
}

async function readIndex(dir: string, repo: string): Promise<Index> {
  try {
    const raw = JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as Partial<Index>;
    const files = Array.isArray(raw.files) ? raw.files.filter((f): f is BuildFileEntry => !!f && typeof f.path === "string" && typeof f.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256) && typeof f.size === "number") : [];
    return { repo: typeof raw.repo === "string" ? raw.repo : normalizeRepo(repo), files };
  } catch {
    return { repo: normalizeRepo(repo), files: [] };
  }
}

async function ownerDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

/** Writes a file owner-only through a temporary name, so a reader never sees half of it. */
async function writeOwnerOnly(path: string, content: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

async function writeIndex(dir: string, index: Index): Promise<void> {
  index.files.sort((a, b) => a.path.localeCompare(b.path));
  await writeOwnerOnly(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
}

/** Adds or replaces one build file for `repo`. */
export async function addBuildFile(buildsRoot: string, repo: string, path: string, content: Buffer): Promise<BuildFileEntry> {
  const rel = checkBuildFilePath(path);
  if (content.length > BUILD_FILE_MAX_BYTES) throw new TapdanceError("USAGE", `${rel} is ${content.length} bytes; a build file may be at most ${BUILD_FILE_MAX_BYTES} bytes (1 MB)`);
  const dir = buildFilesDir(buildsRoot, repo);
  const index = await readIndex(dir, repo);
  const others = index.files.filter((f) => f.path !== rel);
  if (others.length >= BUILD_FILES_MAX) throw new TapdanceError("USAGE", `${normalizeRepo(repo)} already has ${BUILD_FILES_MAX} build files, the most a repository may have`, { hint: "Remove one first: tapdance host builds files remove --repo <url> <path>." });
  await ownerDir(buildsRoot);
  await ownerDir(join(buildsRoot, "files"));
  await ownerDir(dir);
  await ownerDir(join(dir, "blobs"));
  const sha256 = createHash("sha256").update(content).digest("hex");
  await writeOwnerOnly(join(dir, "blobs", sha256), content);
  const entry: BuildFileEntry = { path: rel, sha256, size: content.length, addedAt: new Date().toISOString() };
  const replaced = index.files.find((f) => f.path === rel);
  await writeIndex(dir, { repo: index.repo, files: [...others, entry] });
  if (replaced && replaced.sha256 !== sha256 && !others.some((f) => f.sha256 === replaced.sha256)) await rm(join(dir, "blobs", replaced.sha256), { force: true });
  return entry;
}

/** Removes one build file; throws when `repo` has no file at `path`. */
export async function removeBuildFile(buildsRoot: string, repo: string, path: string): Promise<BuildFileEntry> {
  const rel = checkBuildFilePath(path);
  const dir = buildFilesDir(buildsRoot, repo);
  const index = await readIndex(dir, repo);
  const entry = index.files.find((f) => f.path === rel);
  if (!entry) {
    throw new TapdanceError("USAGE", `${normalizeRepo(repo)} has no build file ${rel}`, { hint: "List them with: tapdance host builds files list --repo <url>." });
  }
  const rest = index.files.filter((f) => f.path !== rel);
  await writeIndex(dir, { repo: index.repo, files: rest });
  if (!rest.some((f) => f.sha256 === entry.sha256)) await rm(join(dir, "blobs", entry.sha256), { force: true });
  return entry;
}

/** One repository's build files (empty when it has none). */
export async function readBuildFiles(buildsRoot: string, repo: string): Promise<BuildFileEntry[]> {
  return (await readIndex(buildFilesDir(buildsRoot, repo), repo)).files;
}

/** Every repository's build files, keyed by the repository URL they were added for. */
export async function listAllBuildFiles(buildsRoot: string): Promise<Array<{ repo: string; files: BuildFileEntry[] }>> {
  const found: Array<{ repo: string; files: BuildFileEntry[] }> = [];
  for (const slug of await readdir(join(buildsRoot, "files")).catch(() => [] as string[])) {
    const dir = join(buildsRoot, "files", slug);
    if (!existsSync(join(dir, "index.json"))) continue;
    const index = await readIndex(dir, "");
    if (index.files.length > 0) found.push({ repo: index.repo, files: index.files });
  }
  return found.sort((a, b) => a.repo.localeCompare(b.repo));
}

/** What changes a build when a build file changes: empty when the repository has none. */
export function buildFilesDigest(files: BuildFileEntry[]): string {
  if (files.length === 0) return "";
  const lines = files.map((f) => `${f.path}\u0000${f.sha256}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

const PLACED = "placed-files.json";

/**
 * Resolves where `rel` goes inside the checkout `src`, creating missing folders. Refuses a folder that
 * is a symlink resolving outside the checkout, and a target that is a symlink or not a plain file.
 */
async function targetInCheckout(src: string, realSrc: string, rel: string, create: boolean): Promise<string | undefined> {
  const inside = (p: string) => p === realSrc || p.startsWith(realSrc + sep);
  const escape = (what: string): never => {
    throw new TapdanceError("FORBIDDEN", `Host build file ${rel} was not copied: ${what}`, {
      hint: "The repository at this commit has a symlink or file where the build file goes. Only the host's owner can change build files: tapdance host builds files remove --repo <url> <path>, or add it at another path.",
    });
  };
  const parts = rel.split("/");
  let dir = src;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    const info = await lstat(dir).catch(() => undefined);
    if (!info) {
      if (!create) return undefined;
      await mkdir(dir);
      continue;
    }
    if (info.isSymbolicLink()) {
      const real = await realpath(dir).catch(() => undefined);
      if (!real || !inside(real)) escape(`${dir.slice(src.length + 1)} is a symlink that leads outside the checkout`);
      if (!(await stat(real!)).isDirectory()) escape(`${dir.slice(src.length + 1)} is not a folder`);
    } else if (!info.isDirectory()) escape(`${dir.slice(src.length + 1)} is not a folder`);
  }
  const realParent = await realpath(dir);
  if (!inside(realParent)) escape("its folder resolves outside the checkout");
  const target = join(realParent, parts.at(-1)!);
  const existing = await lstat(target).catch(() => undefined);
  if (existing && !existing.isFile()) escape(`${rel} in the repository is a ${existing.isSymbolicLink() ? "symlink" : "folder"}`);
  return target;
}

/**
 * Copies `files` into the checkout `src` (after checkout, before the build). Records what it wrote in
 * `cache`, so `removePlacedBuildFiles` takes them out again after the build, or before the next one if
 * this process died. Logs one line per file, never its content.
 */
export async function placeBuildFiles(buildsRoot: string, repo: string, files: BuildFileEntry[], src: string, cache: string, onLine: (line: string) => void): Promise<string[]> {
  if (files.length === 0) return [];
  const blobs = join(buildFilesDir(buildsRoot, repo), "blobs");
  const realSrc = await realpath(src);
  const placed: string[] = [];
  const record = () => writeOwnerOnly(join(cache, PLACED), JSON.stringify(placed));
  for (const file of files) {
    const rel = checkBuildFilePath(file.path);
    const blob = join(blobs, file.sha256);
    const content = await readFile(blob).catch(() => undefined);
    if (!content || createHash("sha256").update(content).digest("hex") !== file.sha256) {
      throw new TapdanceError("CONFIG_INVALID", `Host build file ${rel} is missing or changed on disk since it was added`, { hint: "The host's owner adds it again: tapdance host builds files add --repo <url> <path> --from <file>." });
    }
    const target = (await targetInCheckout(src, realSrc, rel, true))!;
    placed.push(rel);
    await record();
    await writeFile(target, content, { mode: 0o600 });
    // The stored copy's time, so Xcode and Gradle see an unchanged file as unchanged between builds.
    const blobInfo = await stat(blob);
    await utimes(target, blobInfo.atime, blobInfo.mtime).catch(() => undefined);
    onLine(`using host build file ${rel} (sha256 ${file.sha256.slice(0, 8)})`);
  }
  return placed;
}

/**
 * Deletes the build files the last build copied into `src`, so they never stay in the checkout for a
 * later commit (an ignored path would survive `git clean`) and never leak into a build without them.
 * Plain files only, through folders inside the checkout only; never fails the build.
 */
export async function removePlacedBuildFiles(src: string, cache: string): Promise<void> {
  const record = join(cache, PLACED);
  let placed: unknown;
  try {
    placed = JSON.parse(await readFile(record, "utf8"));
  } catch {
    return;
  }
  const realSrc = await realpath(src).catch(() => undefined);
  if (realSrc && Array.isArray(placed)) {
    for (const rel of placed) {
      try {
        const target = await targetInCheckout(src, realSrc, checkBuildFilePath(String(rel)), false);
        if (target && (await lstat(target)).isFile()) await unlink(target);
      } catch {
        // Already gone, or no longer a plain file inside the checkout: leave it to git.
      }
    }
  }
  await rm(record, { force: true });
}
