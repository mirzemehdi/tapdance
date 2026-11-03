import { describe, expect, it } from "vitest";
import { auditScreen } from "./audit.js";

const el = (ref: string, role: string, extra: Record<string, unknown> = {}) => ({ ref, role, ...extra });

describe("accessibility audit (#60)", () => {
  it("flags unlabelled controls, small targets, controls announced alike and unlabelled images", () => {
    const r = auditScreen(
      {
        app: "com.x",
        viewport: { width: 402, height: 874 },
        truncated: false,
        warnings: [],
        elements: [
          el("@e1", "button", { identifier: "play_pause", rect: { x: 0, y: 0, width: 60, height: 60 }, depth: 0 }),
          el("@e2", "button", { label: "Next", rect: { x: 0, y: 70, width: 30, height: 30 }, depth: 0 }),
          el("@e3", "button", { label: "Delete", rect: { x: 0, y: 110, width: 200, height: 48 }, depth: 0 }),
          el("@e4", "button", { label: "Delete", rect: { x: 0, y: 170, width: 200, height: 48 }, depth: 0 }),
          el("@e5", "image", { rect: { x: 0, y: 230, width: 64, height: 64 }, depth: 0 }),
          // A Compose button announced by its child text, and a row with a same-label button inside.
          el("@e6", "button", { rect: { x: 0, y: 300, width: 200, height: 48 }, depth: 0 }),
          el("@e7", "text", { label: "Let me try", depth: 1 }),
          el("@e8", "cell", { label: "Siri", rect: { x: 0, y: 360, width: 400, height: 52 }, depth: 0 }),
          el("@e9", "button", { label: "Siri", rect: { x: 10, y: 362, width: 380, height: 48 }, depth: 1 }),
        ],
      },
      "ios",
    );
    expect(r.counts).toEqual({ "unlabelled-control": 1, "small-target": 1, "duplicate-label": 1, "unlabelled-image": 1 });
    expect(r.findings.find((f) => f.rule === "unlabelled-control")).toMatchObject({ ref: "@e1", severity: "error" });
    expect(r.findings.find((f) => f.rule === "unlabelled-control")!.detail).toContain('only the id "play_pause"');
    expect(r.findings.find((f) => f.rule === "small-target")!.ref).toBe("@e2");
    expect(r.findings.find((f) => f.rule === "duplicate-label")!.detail).toContain('2 controls are announced as "delete"');
  });

  it("measures Android targets in dp from the screen's pixels and skips the status bar", () => {
    const r = auditScreen(
      { viewport: { width: 1080, height: 2400 }, truncated: false, warnings: [], elements: [
        el("@e1", "button", { label: "Ok", rect: { x: 0, y: 0, width: 140, height: 140 } }),
        el("@e2", "button", { label: "Tiny", rect: { x: 0, y: 200, width: 100, height: 100 } }),
        el("@e3", "button", { identifier: "com.android.systemui:id/clock", rect: { x: 0, y: 0, width: 10, height: 10 } }),
      ] },
      "android",
    );
    expect(r.findings.map((f) => f.ref)).toEqual(["@e2"]);
  });
});
