import { TapdanceError } from "@tapdance/core";
import type { Tapdance } from "./tapdance.js";

export type RenewOutcome = "none" | "not-due" | "other-renewer" | "renewed" | "released-idle" | "lost" | "error";

/**
 * One renewal decision for the session's lease, shared by the CLI keepalive and the MCP server so
 * they never fight: renew only when a third of the granted time has passed, only when no other live
 * process renewed recently, and release a lease nobody has used for `idleMs`.
 */
export async function renewIfDue(tapdance: Tapdance, options: { idleMs: number; log?: (m: string) => void }): Promise<RenewOutcome> {
  const record = await tapdance.current();
  if (record === undefined) return "none";
  const now = Date.now();
  const ttl = record.handle.ttlMs;
  try {
    // A person holding the device in the viewer is using it, however long ago the agent last did.
    const hold = await tapdance.store.getHold(record.sessionId);
    const holdUntil = hold ? Date.parse(hold.until) : Number.NaN;
    const lastUsed = Math.max(Date.parse(record.lastUsedAt ?? record.handle.createdAt), Number.isFinite(holdUntil) ? holdUntil : 0);
    const held = Number.isFinite(holdUntil) && holdUntil > now;
    // A device call still running in this process (a long build, say) is use too.
    if (options.idleMs > 0 && !held && !tapdance.inUseNow && now - lastUsed > options.idleMs) {
      options.log?.(`Releasing ${record.handle.model}: unused for ${Math.round((now - lastUsed) / 60_000)} min`);
      await tapdance.release();
      return "released-idle";
    }
  } catch (error) {
    // The session lock may be busy (a long call holds it); try again on the next round.
    options.log?.(`Idle release failed: ${(error as Error).message}`);
    return "error";
  }
  const remaining = Date.parse(record.handle.expiresAt) - now;
  if (remaining > (ttl * 2) / 3) return "not-due";
  const r = record.renewer;
  if (r && r.pid !== process.pid && now - Date.parse(r.heartbeatAt) < ttl / 3 && alive(r.pid)) return "other-renewer";
  try {
    await tapdance.renew();
    return "renewed";
  } catch (error) {
    if (error instanceof TapdanceError && error.code === "LEASE_LOST") return "lost";
    options.log?.(`Renew failed: ${(error as Error).message}`);
    return "error";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface KeepaliveOptions {
  /** Stop renewing after this long even if nobody released the lease. */
  maxMs: number;
  /** Release after this long without use (0 = never). */
  idleMs?: number;
  /** How often to check; defaults to a sixth of the TTL, between 5 s and 60 s. */
  intervalMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

/**
 * Keeps the session's lease alive until it is released, lost, idle, aborted, or the cap passes.
 * Used by the detached CLI keepalive and by `tapdance device lease --hold`.
 */
export async function runKeepalive(
  tapdance: Tapdance,
  options: KeepaliveOptions,
): Promise<"released" | "lost" | "capped" | "aborted" | "idle"> {
  const started = Date.now();
  const first = await tapdance.current();
  if (first === undefined) return "released";
  const leaseId = first.handle.leaseId;
  const interval = options.intervalMs ?? Math.min(60_000, Math.max(5_000, Math.floor(first.handle.ttlMs / 6)));
  let errors = 0;
  for (;;) {
    await sleep(interval, options.signal);
    if (options.signal?.aborted) return "aborted";
    const record = await tapdance.current();
    if (record === undefined || record.handle.leaseId !== leaseId) return "released";
    if (Date.now() - started > options.maxMs) {
      options.log?.(`Keepalive cap reached after ${Math.round(options.maxMs / 60_000)} min; the lease will expire on its own`);
      return "capped";
    }
    const outcome = await renewIfDue(tapdance, { idleMs: options.idleMs ?? 0, ...(options.log ? { log: options.log } : {}) });
    if (outcome === "lost") return "lost";
    if (outcome === "released-idle") return "idle";
    if (outcome === "none") return "released";
    // A worker that is briefly offline answers WORKER_OFFLINE; keep trying until the lease would have expired.
    errors = outcome === "error" ? errors + 1 : 0;
    if (errors > 0 && Date.parse(record.handle.expiresAt) < Date.now()) return "lost";
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
