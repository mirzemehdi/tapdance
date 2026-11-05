/** How often a slow lease step says it is still running (field run 2d: no silent gaps over ~5 s). */
export const HEARTBEAT_MS = 5_000;

/**
 * Awaits `work`, telling `progress` every `everyMs` while it runs, with the whole seconds since it
 * began. Without a listener it is a plain await.
 */
export async function withHeartbeat<T>(work: Promise<T>, progress: ((message: string) => void) | undefined, message: (seconds: number) => string, everyMs = HEARTBEAT_MS): Promise<T> {
  if (!progress) return work;
  const started = Date.now();
  const timer = setInterval(() => progress(message(Math.round((Date.now() - started) / 1000))), everyMs);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

/** `work`, or undefined once `ms` have passed; never rejects. The work itself is not stopped. */
export async function bounded<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work.catch(() => undefined), new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), Math.max(0, ms))))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
