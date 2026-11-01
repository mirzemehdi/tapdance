import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TapdanceError } from "./errors.js";
import { sessionKey } from "./identity.js";
import type { LeaseHandle } from "./types.js";

/** Which process created a lease, so a shutdown only releases what it started. */
export interface LeaseOwner {
  kind: "cli" | "cli-hold" | "mcp" | "sdk";
  pid: number;
}

/** The one process renewing a lease; others renew only when its heartbeat goes stale. */
export interface Renewer {
  pid: number;
  heartbeatAt: string;
}

/**
 * What one session holds, on disk, so a one-shot CLI call, the keepalive process, the MCP server and
 * the browser viewer all see the same lease. One active lease per session; every write happens under
 * the session's lock.
 */
export interface SessionRecord {
  schemaVersion?: 1;
  sessionId: string;
  handle: LeaseHandle;
  owner?: LeaseOwner;
  renewer?: Renewer;
  /** Process renewing the lease for the CLI, when one runs. */
  keepalivePid?: number;
  recording?: { path: string; startedAt: string; token?: Record<string, unknown> };
  /** Last time any command used the device; the keepalive releases after an idle period. */
  lastUsedAt?: string;
  generation?: number;
  updatedAt: string;
}

/** Kept apart from the record because the viewer writes it on every touch. */
export interface HumanHold {
  until: string;
  by: string;
}

// A lease call can hold the lock for minutes while a device boots; a lock is stale only when its
// holder is gone, or after this long.
const LOCK_STALE_MS = 15 * 60_000;
const LOCK_WAIT_MS = 20_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SessionStore {
  readonly dir: string;

  constructor(home: string) {
    this.dir = join(home, "sessions");
  }

  path(sessionId: string): string {
    return join(this.dir, `${sessionKey(sessionId)}.json`);
  }

  private lockPath(sessionId: string): string {
    return join(this.dir, `${sessionKey(sessionId)}.lock`);
  }

  private holdPath(sessionId: string): string {
    return join(this.dir, `${sessionKey(sessionId)}.hold.json`);
  }

  /**
   * Runs `fn` holding the session's lock (an exclusive lockfile naming its pid). A lock left by a
   * dead process, or older than 30 s, is taken over. Not reentrant: do not nest calls.
   */
  async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lock = this.lockPath(sessionId);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await open(lock, "wx", 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const [holder, info] = await Promise.all([readFile(lock, "utf8"), stat(lock)]);
          const pid = Number(holder);
          stale = !Number.isInteger(pid) || pid <= 0 || !alive(pid) || Date.now() - info.mtimeMs > LOCK_STALE_MS;
        } catch {
          stale = true;
        }
        if (stale) {
          await rm(lock, { force: true });
          continue;
        }
        if (Date.now() > deadline) {
          throw new TapdanceError("TIMEOUT", "Another Tapdance process is busy with this session", { hint: "Retry in a moment." });
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    const file = this.path(sessionId);
    if (!existsSync(file)) return undefined;
    try {
      const record = JSON.parse(await readFile(file, "utf8")) as SessionRecord;
      return record.sessionId === sessionId ? record : undefined;
    } catch {
      return undefined;
    }
  }

  /** Atomic write: a reader never sees half a record. Call under `withLock`. */
  async put(record: SessionRecord): Promise<SessionRecord> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.path(record.sessionId);
    const next: SessionRecord = { ...record, schemaVersion: 1, generation: (record.generation ?? 0) + 1, updatedAt: new Date().toISOString() };
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
    return next;
  }

  /** Read-modify-write under the session lock. `change` may return undefined to leave it as is. */
  async update(sessionId: string, change: (record: SessionRecord) => SessionRecord | undefined): Promise<SessionRecord | undefined> {
    return this.withLock(sessionId, async () => {
      const current = await this.get(sessionId);
      if (current === undefined) return undefined;
      const next = change(current);
      return next === undefined ? current : this.put(next);
    });
  }

  /** Deletes the record, but only if it still names `leaseId` (when given). */
  async delete(sessionId: string, leaseId?: string): Promise<void> {
    await this.withLock(sessionId, async () => {
      if (leaseId !== undefined) {
        const current = await this.get(sessionId);
        if (current && current.handle.leaseId !== leaseId) return;
      }
      await rm(this.path(sessionId), { force: true });
      await rm(this.holdPath(sessionId), { force: true });
    });
  }

  async getHold(sessionId: string): Promise<HumanHold | undefined> {
    try {
      const hold = JSON.parse(await readFile(this.holdPath(sessionId), "utf8")) as HumanHold;
      return Date.parse(hold.until) > Date.now() ? hold : undefined;
    } catch {
      return undefined;
    }
  }

  async setHold(sessionId: string, hold: HumanHold | undefined): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.holdPath(sessionId);
    if (hold === undefined) {
      await rm(file, { force: true });
      return;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(hold), { mode: 0o600 });
    await rename(tmp, file);
  }

  async list(): Promise<SessionRecord[]> {
    if (!existsSync(this.dir)) return [];
    const out: SessionRecord[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json") || name.endsWith(".hold.json")) continue;
      try {
        out.push(JSON.parse(await readFile(join(this.dir, name), "utf8")) as SessionRecord);
      } catch {
        // Skip unreadable records.
      }
    }
    return out;
  }
}
