/**
 * Simlock's screen-stream framing, as published in its docs and `src/core/screen.ts` (MIT,
 * callstackincubator/simlock): each frame is a 4-byte big-endian length (payload + 1), one tag byte,
 * then the payload. `description` carries an avcC record, `keyframe`/`delta` carry AVCC NAL units
 * (or JPEG for an mjpeg stream), `seed` a JPEG, `meta` JSON, `alive` nothing, `ended` JSON {reason}.
 * The browser viewer has its own copy of this table; this one serves Node-side tests and tools.
 */
export const SCREEN_FRAME_TAG = {
  description: 0x01,
  keyframe: 0x02,
  delta: 0x03,
  seed: 0x04,
  meta: 0x05,
  alive: 0x06,
  ended: 0x07,
} as const;

export interface ScreenFrame {
  tag: number;
  payload: Uint8Array;
}

/** Splits a buffer into whole frames; returns the bytes of a trailing partial frame as `rest`. */
export function decodeFrames(buffer: Uint8Array): { frames: ScreenFrame[]; rest: Uint8Array } {
  const frames: ScreenFrame[] = [];
  let offset = 0;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  while (buffer.length - offset >= 5) {
    const length = view.getUint32(offset);
    if (length < 1) throw new Error(`Invalid frame length ${length} at offset ${offset}`);
    if (buffer.length - offset - 4 < length) break;
    const tag = buffer[offset + 4]!;
    frames.push({ tag, payload: buffer.subarray(offset + 5, offset + 4 + length) });
    offset += 4 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export function encodeFrame(tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1);
  out[4] = tag;
  out.set(payload, 5);
  return out;
}
