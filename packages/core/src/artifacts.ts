import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { TapdanceError } from "./errors.js";
import { sessionKey } from "./identity.js";
import type { ArtifactRef } from "./types.js";

/**
 * Where screenshots, recordings and logs go. The local store writes under one directory per session
 * with a manifest; a hosted provider can implement the same interface over S3 or R2.
 */
export interface ArtifactStore {
  /** A path to write a new artifact to. `requested` (from the user) wins when given. */
  allocate(sessionId: string, kind: ArtifactRef["kind"], extension: string, requested?: string): Promise<string>;
  record(entry: Omit<ArtifactRef, "id" | "bytes" | "createdAt"> & { bytes?: number }): Promise<ArtifactRef>;
  list(sessionId: string): Promise<ArtifactRef[]>;
}

const MANIFEST_LOCK_WAIT_MS = 5_000;
const MANIFEST_LOCK_RETRY_MS = 25;
const MANIFEST_LOCK_STALE_MS = 30_000;

export class LocalArtifactStore implements ArtifactStore {
  /** Per-session tail of manifest writes in this process, so parallel records queue instead of racing. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(readonly root: string) {}

  sessionDir(sessionId: string): string {
    const readable = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48);
    return join(this.root, `${readable}-${sessionKey(sessionId).slice(0, 8)}`);
  }

  async allocate(sessionId: string, kind: ArtifactRef["kind"], extension: string, requested?: string): Promise<string> {
    if (requested !== undefined) {
      const path = resolve(requested);
      await mkdir(resolve(path, ".."), { recursive: true });
      return path;
    }
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return join(dir, `${stamp}-${kind}-${randomBytes(4).toString("hex")}.${extension.replace(/^\./, "")}`);
  }

  private manifestPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "manifest.json");
  }

  async record(entry: Omit<ArtifactRef, "id" | "bytes" | "createdAt"> & { bytes?: number }): Promise<ArtifactRef> {
    const bytes = entry.bytes ?? (existsSync(entry.path) ? (await stat(entry.path)).size : 0);
    const ref: ArtifactRef = {
      ...entry,
      id: `art_${randomBytes(6).toString("hex")}`,
      bytes,
      createdAt: new Date().toISOString(),
    };
    await this.serialized(entry.sessionId, async () => {
      const list = await this.list(entry.sessionId);
      list.push(ref);
      const file = this.manifestPath(entry.sessionId);
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    });
    return ref;
  }

  /**
   * Runs a manifest read-modify-write alone: queued behind earlier ones in this process, and under
   * `manifest.json.lock` against other processes (a CLI call and the MCP server can record at once).
   */
  private async serialized(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      await mkdir(this.sessionDir(sessionId), { recursive: true });
      const lock = `${this.manifestPath(sessionId)}.lock`;
      await acquireFileLock(lock);
      try {
        await fn();
      } finally {
        await rm(lock, { force: true });
      }
    });
    this.queues.set(sessionId, run);
    try {
      await run;
    } finally {
      if (this.queues.get(sessionId) === run) this.queues.delete(sessionId);
    }
  }

  async list(sessionId: string): Promise<ArtifactRef[]> {
    const file = this.manifestPath(sessionId);
    if (!existsSync(file)) return [];
    try {
      const data: unknown = JSON.parse(await readFile(file, "utf8"));
      return Array.isArray(data) ? (data as ArtifactRef[]) : [];
    } catch {
      return [];
    }
  }

  static describe(ref: ArtifactRef): string {
    const kb = (ref.bytes / 1024).toFixed(ref.bytes < 10_240 ? 1 : 0);
    return `${ref.kind} ${basename(ref.path)} (${kb} KiB)`;
  }
}

/** Creates `lock` exclusively, retrying briefly; a lock older than 30 s was left by a dead writer. */
async function acquireFileLock(lock: string): Promise<void> {
  const deadline = Date.now() + MANIFEST_LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await stat(lock).catch(() => undefined);
    if (info !== undefined && Date.now() - info.mtimeMs > MANIFEST_LOCK_STALE_MS) {
      await rm(lock, { force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new TapdanceError("TIMEOUT", `Another process is writing the artifact manifest (${lock})`, {
        hint: "Retry in a moment; delete the .lock file if no Tapdance process is running.",
      });
    }
    await new Promise((r) => setTimeout(r, MANIFEST_LOCK_RETRY_MS));
  }
}
