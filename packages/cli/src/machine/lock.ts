import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TapdanceError } from "@tapdance/sdk";
import type { MachineIo } from "./common.js";

/**
 * One create (or destroy) per machine at a time. `machines/<name>/create.lock` holds the pid and start
 * time of the process that owns the machine's resources right now. It is taken with an exclusive create
 * ("wx"), and it is stale only when that pid is dead, or alive but started at another time (the pid was
 * reused). Auto mode's lease process takes it before it spawns the background create and hands it to the
 * child through a one-time token, so two leases cannot both spawn one.
 */
export interface CreateLock {
  pid: number;
  /** When the holder started (ms since the epoch), to tell it from a later process with the same pid. */
  startedAt?: number;
  /** starting: a lease process spawning the background create; create; destroy. */
  role: "starting" | "create" | "destroy";
  /** Lets the spawned background create take the lock over from the process that spawned it. */
  token?: string;
  since: string;
}

/** The environment variable that hands the lock to the background create. */
export const LOCK_TOKEN_ENV = "TAPDANCE_MACHINE_CREATE_LOCK";
/** How far a process's start time may differ from the one in the lock (ps reports whole seconds). */
const START_SLACK_MS = 5_000;

export function lockPath(io: Pick<MachineIo, "store">, name: string): string {
  return join(io.store.dir(name), "create.lock");
}

export async function readLock(io: Pick<MachineIo, "store">, name: string): Promise<CreateLock | undefined> {
  try {
    const lock = JSON.parse(await readFile(lockPath(io, name), "utf8")) as CreateLock;
    return Number.isInteger(lock.pid) && lock.pid > 0 ? lock : undefined;
  } catch {
    return undefined;
  }
}

/** True while the lock's holder runs (the same process: same pid and start time). */
export async function holderAlive(io: Pick<MachineIo, "alive" | "processStart">, lock: CreateLock): Promise<boolean> {
  if (!io.alive(lock.pid)) return false;
  if (lock.startedAt === undefined) return true;
  const started = await io.processStart(lock.pid);
  return started === undefined || Math.abs(started - lock.startedAt) <= START_SLACK_MS;
}

/** The live holder of the machine's lock, if any. */
export async function lockHolder(io: MachineIo, name: string): Promise<CreateLock | undefined> {
  const lock = await readLock(io, name);
  return lock && (await holderAlive(io, lock)) ? lock : undefined;
}

async function writeLockAtomically(path: string, lock: CreateLock): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(lock)}\n`, { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
}

function busy(name: string, lock: CreateLock): TapdanceError {
  const what = lock.role === "destroy" ? "destroyed" : "created";
  return new TapdanceError("PROVIDER_UNAVAILABLE", `Machine ${name} is being ${what} by another process (pid ${lock.pid}, since ${lock.since})`, {
    hint:
      lock.role === "destroy"
        ? "Wait until that destroy has finished."
        : `Wait for it (\`tapdance machine auto\` or \`tapdance machine list\` shows how far it got), or stop it: \`tapdance machine destroy ${name}\` in a terminal stops it first and then removes what it made.`,
    retryable: true,
    retryAfterMs: 60_000,
    details: { machine: name, pid: lock.pid, role: lock.role },
  });
}

/**
 * Takes the machine's lock or throws when a live process holds it. `adopt` is a token from the process
 * that spawned this one: a lock carrying it is taken over. Returns the release function, which removes
 * the lock only while it is still this process's, and the machine's folder when nothing else is in it.
 */
export async function acquireLock(
  io: MachineIo,
  name: string,
  role: CreateLock["role"],
  options: { adopt?: string; token?: string } = {},
): Promise<{ release: () => Promise<void>; lock: CreateLock }> {
  const dir = io.store.dir(name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = lockPath(io, name);
  const mine: CreateLock = {
    pid: io.proc.pid,
    startedAt: io.proc.startedAt,
    role,
    ...(options.token ? { token: options.token } : {}),
    since: io.now().toISOString(),
  };
  const release = async () => {
    const now = await readLock(io, name);
    if (now?.pid !== mine.pid || now.role !== mine.role) return;
    await rm(path, { force: true });
    await rmdir(dir).catch(() => undefined);
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await writeFile(path, `${JSON.stringify(mine)}\n`, { mode: 0o600, flag: "wx" });
      return { release, lock: mine };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = await readLock(io, name);
    if (held === undefined) {
      // Being written right now, or garbage: give a writer a moment, then treat it as stale.
      if (attempt < 2) {
        await io.sleep(200);
        continue;
      }
      await rm(path, { force: true });
      continue;
    }
    if (options.adopt !== undefined && held.token === options.adopt) {
      await writeLockAtomically(path, mine);
      return { release, lock: mine };
    }
    if (held.pid !== io.proc.pid && (await holderAlive(io, held))) throw busy(name, held);
    // Its holder is gone (or it is this very process from an earlier step): stale.
    await rm(path, { force: true });
  }
  throw new TapdanceError("INTERNAL", `Could not take the lock ${path}`);
}

/** Rewrites a lock this process took, e.g. to name the background create it spawned as the holder. */
export async function handOver(io: MachineIo, name: string, lock: CreateLock): Promise<void> {
  await writeLockAtomically(lockPath(io, name), lock);
}
