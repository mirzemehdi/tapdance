import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
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
  /** "takeover": the person pressed Take over (a fixed hold until Hand back); otherwise touches. */
  kind?: "touch" | "takeover";
}

export interface SessionStoreOptions {
  /** How long a caller waits for another holder before giving up with TIMEOUT. */
  lockWaitMs?: number;
  /** A live holder's lock is taken over when its file has not been touched for this long. */
  lockStaleMs?: number;
  /** How often a holder touches its lock while it works, so a long device boot keeps it fresh. */
  heartbeatMs?: number;
}

const DEFAULT_LOCK_WAIT_MS = 20_000;
const DEFAULT_LOCK_STALE_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_MS = 60_000;
// A lockfile whose content does not parse may be mid-write by an older Tapdance (which created the
// file, then wrote its pid); it is left alone this long.
const UNPARSED_LOCK_GRACE_MS = 2_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The holder pid of a lock's content: `pid:nonce`, or a bare pid from older versions. */
function lockHolder(content: string): number | undefined {
  const match = /^(\d+)(?::[0-9a-f]+)?$/.exec(content.trim());
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export class SessionStore {
  readonly dir: string;
  private readonly lockWaitMs: number;
  private readonly lockStaleMs: number;
  private readonly heartbeatMs: number;

  constructor(home: string, options: SessionStoreOptions = {}) {
    this.dir = join(home, "sessions");
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
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
   * Runs `fn` holding the session's lock: a lockfile naming `pid:nonce`, created whole with a hard
   * link so it is never seen empty, and touched every `heartbeatMs` while `fn` runs. A lock whose
   * holder process is dead, or that nobody touched for `lockStaleMs`, is taken over. Not reentrant:
   * do not nest calls.
   */
  async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lock = this.lockPath(sessionId);
    const nonce = randomBytes(8).toString("hex");
    const token = `${process.pid}:${nonce}`;
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      if (await this.tryAcquire(lock, token, nonce)) break;
      let content: string;
      let mtimeMs: number;
      try {
        [content, { mtimeMs }] = await Promise.all([readFile(lock, "utf8"), stat(lock)]);
      } catch (error) {
        if (errno(error) === "ENOENT") continue;
        throw error;
      }
      const holder = lockHolder(content);
      const age = Date.now() - mtimeMs;
      const stale = holder === undefined ? age > UNPARSED_LOCK_GRACE_MS : !alive(holder) || age > this.lockStaleMs;
      if (stale) {
        await this.takeOver(lock, content);
        continue;
      }
      if (Date.now() > deadline) {
        if (holder === process.pid) {
          throw new TapdanceError("TIMEOUT", "An earlier call in this process is still working on this session (for example a lease being granted)", {
            hint: "Call again in 30 s; a lease request keeps running and returns the device once granted.",
          });
        }
        throw new TapdanceError("TIMEOUT", "Another Tapdance process is busy with this session", { hint: "Retry in a moment." });
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const heartbeat = setInterval(() => {
      void (async () => {
        if ((await readFile(lock, "utf8")) !== token) return;
        const now = new Date();
        await utimes(lock, now, now);
      })().catch(() => undefined);
    }, this.heartbeatMs);
    heartbeat.unref();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      try {
        // Only our own lock: if it was taken over meanwhile, it belongs to someone else now.
        if ((await readFile(lock, "utf8")) === token) await rm(lock, { force: true });
      } catch {
        // Already gone.
      }
    }
  }

  /** Creates the lockfile with its content in one step: write a private temp file, hard-link it. */
  private async tryAcquire(lock: string, token: string, nonce: string): Promise<boolean> {
    const tmp = `${lock}.${process.pid}.${nonce}.tmp`;
    await writeFile(tmp, token, { mode: 0o600 });
    try {
      await link(tmp, lock);
      return true;
    } catch (error) {
      if (errno(error) === "EEXIST") return false;
      throw error;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /**
   * Moves a stale lock aside. Rename is atomic, so of several waiters only one moves it; if what it
   * moved is no longer the lock it judged stale (someone replaced it in between), it puts it back.
   */
  private async takeOver(lock: string, judged: string): Promise<void> {
    const tombstone = `${lock}.stale.${randomBytes(8).toString("hex")}`;
    try {
      await rename(lock, tombstone);
    } catch (error) {
      if (errno(error) === "ENOENT") return;
      throw error;
    }
    try {
      const moved = await readFile(tombstone, "utf8").catch(() => undefined);
      if (moved !== undefined && moved !== judged) {
        await link(tombstone, lock).catch((error: unknown) => {
          if (errno(error) !== "EEXIST") throw error;
        });
      }
    } finally {
      await rm(tombstone, { force: true });
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
