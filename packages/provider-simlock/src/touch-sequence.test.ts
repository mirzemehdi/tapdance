import { describe, expect, it } from "vitest";
import { checkTimedTaps, orientationOf, playTouches, sequenceResult, toFramebuffer, type TouchSocket } from "./touch-sequence.js";

const portrait = { width: 402, height: 874 };
const landscape = { width: 874, height: 402 };

/** A fake input channel: answers its configuration, then records each touch with the clock. */
function fakeSocket(now: () => number) {
  const sent: Array<{ at: number; type: string; x: number; y: number }> = [];
  let listener: ((d: Buffer) => void) | undefined;
  const socket: TouchSocket = {
    send: (data) => {
      expect(data[0]).toBe(0x03);
      sent.push({ at: now(), ...(JSON.parse(data.toString("utf8", 1)) as { type: string; x: number; y: number }) });
    },
    on: (_e, l) => {
      listener = l as (d: Buffer) => void;
      setTimeout(() => listener?.(Buffer.concat([Buffer.from([0x82]), Buffer.from('{"width":1206,"height":2622,"orientation":"portrait"}')])), 5);
    },
    off: () => (listener = undefined),
  };
  return { socket, sent };
}

describe("iOS timed taps through the input channel (#58)", () => {
  it("maps app points to the portrait framebuffer in every orientation", () => {
    expect(toFramebuffer(201, 437, portrait, "portrait")).toEqual({ x: 0.5, y: 0.5 });
    // Pianolune's Back button in landscape-left (92, 46) is near the portrait top-right... rotated.
    const back = toFramebuffer(92, 46, landscape, "landscape-left");
    expect(back.x).toBeCloseTo((402 - 46) / 402);
    expect(back.y).toBeCloseTo(92 / 874);
    expect(toFramebuffer(0, 0, landscape, "landscape-right")).toEqual({ x: 0, y: 1 });
    expect(toFramebuffer(0, 0, portrait, "portrait-upside-down")).toEqual({ x: 1, y: 1 });
    expect(toFramebuffer(-5, 9999, portrait, "portrait")).toEqual({ x: 0, y: 1 });
    expect(orientationOf(landscape)).toBe("landscape-left");
    expect(orientationOf(portrait)).toBe("portrait");
    expect(orientationOf(landscape, "landscape-right")).toBe("landscape-right");
  });

  it("accepts the same sequences as Android and refuses the rest", () => {
    expect(checkTimedTaps([{ t: 0, x: 10, y: 20 }, { t: 250, x: 10.5, y: 20, hold: 100 }])).toHaveLength(2);
    expect(() => checkTimedTaps([])).toThrow(/1 to 500/);
    expect(() => checkTimedTaps([{ t: 500, x: 1, y: 1 }, { t: 100, x: 1, y: 1 }])).toThrow(/time order/);
    expect(() => checkTimedTaps([{ t: 0, x: -1, y: 1 }])).toThrow(/x must be/);
    expect(() => checkTimedTaps([{ t: 700_000, x: 1, y: 1 }])).toThrow(/t must be/);
  });

  it("sends each touch at its time, ending a held touch before the next begins", async () => {
    const t0 = performance.now();
    const { socket, sent } = fakeSocket(() => performance.now() - t0);
    const played = await playTouches(socket, [{ t: 0, x: 201, y: 437 }, { t: 120, x: 201, y: 437, hold: 300 }, { t: 200, x: 100, y: 100 }], (x, y) => toFramebuffer(x, y, portrait, "portrait"));
    expect(played.map((p) => p.t)).toEqual([0, 120, 200]);
    for (const p of played) expect(Math.abs(p.driftMs)).toBeLessThan(25);
    expect(sent.map((s) => s.type)).toEqual(["begin", "end", "begin", "end", "begin", "end"]);
    // The held second tap was cut short by the third (one finger).
    expect(sent[3]!.at).toBeLessThan(sent[4]!.at + 1);
    expect(sequenceResult(played, 3, "n").message).toMatch(/^Ran 3\/3 taps; largest start drift/);
  });
});
