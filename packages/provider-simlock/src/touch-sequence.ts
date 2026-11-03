import type { TimedTap } from "@tapdance/core";
import { TapdanceError } from "@tapdance/core";

/**
 * Timed taps on an iOS simulator through Simlock's input channel (#58): the touches the live viewer
 * sends, injected without XCTest. XCTest taps cost 300–450 ms each, too slow for a rhythm game; this
 * path is a few milliseconds. The schedule runs next to Simlock (the worker guard, or this machine in
 * local mode), so the network between agent and host adds no jitter.
 *
 * Message format (binary): one tag byte, then JSON. 0x03 is a touch `{type: begin|end, x, y}` with x and
 * y as fractions of the portrait framebuffer; the channel first answers 0x82 with its configuration.
 */

const TOUCH = 0x03;
const CONFIG = 0x82;
/** How long a plain tap stays down. */
export const DEFAULT_HOLD_MS = 60;

export type Orientation = "portrait" | "landscape-left" | "landscape-right" | "portrait-upside-down";

export interface TouchSocket {
  send(data: Buffer): void;
  on(event: "message", listener: (data: Buffer | ArrayBuffer) => void): unknown;
  off?(event: "message", listener: (data: Buffer | ArrayBuffer) => void): unknown;
}

/**
 * A point in the app's coordinates (what `ui inspect --bounds` shows, in the current orientation) as
 * fractions of the portrait framebuffer. Device orientation `landscape-left` (Tapdance's "landscape",
 * and what most apps that force landscape use) is the interface rotated so its top is on the left.
 */
export function toFramebuffer(x: number, y: number, viewport: { width: number; height: number }, orientation: Orientation): { x: number; y: number } {
  const { width: w, height: h } = viewport;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  switch (orientation) {
    case "landscape-left":
      // Interface landscapeRight: portrait x runs against the interface's y.
      return { x: clamp((h - y) / h), y: clamp(x / w) };
    case "landscape-right":
      return { x: clamp(y / h), y: clamp((w - x) / w) };
    case "portrait-upside-down":
      return { x: clamp((w - x) / w), y: clamp((h - y) / h) };
    default:
      return { x: clamp(x / w), y: clamp(y / h) };
  }
}

/** The orientation to assume from the screen's shape when the caller does not say. */
export function orientationOf(viewport: { width: number; height: number }, said?: Orientation): Orientation {
  if (said) return said;
  return viewport.width > viewport.height ? "landscape-left" : "portrait";
}

export interface PlayedTap extends TimedTap {
  actualMs: number;
  driftMs: number;
}

/**
 * Plays `steps` on an open input socket: waits for the channel's configuration, then sends each touch
 * at its time (begin at `t`, end after `hold`). A tap that starts before the previous one ended ends
 * that one first (the channel has one finger). Answers when each touch began, against the schedule.
 */
export async function playTouches(
  socket: TouchSocket,
  steps: TimedTap[],
  point: (x: number, y: number) => { x: number; y: number },
  clock: () => number = () => performance.now(),
): Promise<PlayedTap[]> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off?.("message", onMessage);
      reject(new TapdanceError("DEVICE_ERROR", "The device's input channel did not answer", { hint: "Check that the worker offers remote input (tapdance doctor: Remote input)." }));
    }, 8_000);
    const onMessage = (data: Buffer | ArrayBuffer) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (bytes[0] !== CONFIG) return;
      const text = bytes.toString("utf8", 1);
      clearTimeout(timer);
      socket.off?.("message", onMessage);
      if (/inputUnavailable/.test(text)) reject(new TapdanceError("NOT_SUPPORTED", "This device takes no remote input", { hint: "The worker's input capability is off: tapdance worker install --stream enables it." }));
      else resolve();
    };
    socket.on("message", onMessage);
  });
  const send = (type: "begin" | "end", p: { x: number; y: number }) => socket.send(Buffer.concat([Buffer.from([TOUCH]), Buffer.from(JSON.stringify({ type, x: p.x, y: p.y }))]));
  const sleepUntil = async (at: number, t0: number) => {
    for (;;) {
      const left = at - (clock() - t0);
      if (left <= 0) return;
      // Coarse sleep, then the last couple of milliseconds on the event loop.
      await new Promise((r) => setTimeout(r, left > 3 ? left - 2 : 0));
    }
  };
  const played: PlayedTap[] = [];
  const t0 = clock();
  let down: { p: { x: number; y: number }; until: number } | undefined;
  for (const step of steps) {
    if (down && down.until <= step.t) {
      await sleepUntil(down.until, t0);
      send("end", down.p);
      down = undefined;
    }
    await sleepUntil(step.t, t0);
    if (down) send("end", down.p);
    const p = point(step.x, step.y);
    const at = clock() - t0;
    send("begin", p);
    played.push({ ...step, actualMs: Math.round(at * 10) / 10, driftMs: Math.round((at - step.t) * 10) / 10 });
    down = { p, until: step.t + (step.hold ?? DEFAULT_HOLD_MS) };
  }
  if (down) {
    await sleepUntil(down.until, t0);
    send("end", down.p);
  }
  return played;
}

/** The same limits as Android's sequence: 1 to 500 taps within 10 minutes, in time order. */
export function checkTimedTaps(steps: unknown): TimedTap[] {
  const usage = (m: string) => new TapdanceError("USAGE", m);
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 500) throw usage("A sequence has 1 to 500 taps");
  let previous = 0;
  return steps.map((raw) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const num = (k: string, max: number, required = true) => {
      const v = s[k];
      if (v === undefined && !required) return undefined;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) throw usage(`${k} must be a number from 0 to ${max}`);
      return v;
    };
    const t = num("t", 600_000)!;
    if (t < previous) throw usage("Taps must be in time order (t ascending)");
    previous = t;
    const hold = num("hold", 10_000, false);
    return { t, x: num("x", 10_000)!, y: num("y", 10_000)!, ...(hold !== undefined ? { hold } : {}) };
  });
}

/** The reply every platform gives for a timed sequence. */
export function sequenceResult(played: PlayedTap[], total: number, note: string) {
  const drifts = played.map((s) => Math.abs(s.driftMs));
  return {
    ok: played.length === total,
    message: `Ran ${played.length}/${total} taps; largest start drift ${Math.max(0, ...drifts).toFixed(1)} ms`,
    data: { steps: played, maxDriftMs: Math.max(0, ...drifts), note },
  };
}
