import { describe, expect, it } from "vitest";
import { isStatusBar } from "./tapdance.js";

describe("Android status bar is not the app's screen", () => {
  it("recognises the clock, signal and battery and notification icons, not the app's own elements", () => {
    expect(isStatusBar({ label: "1:02", identifier: "com.android.systemui:id/clock", depth: 0 })).toBe(true);
    expect(isStatusBar({ label: "Android System notification: Serial console enabled", depth: 0 })).toBe(true);
    expect(isStatusBar({ label: "Battery 100 percent.", identifier: "com.android.systemui:id/battery", depth: 0 })).toBe(true);
    expect(isStatusBar({ label: "Lesson 1 · Right hand", depth: 5 })).toBe(false);
    expect(isStatusBar({ label: "Turn on notification: reminders", depth: 4 })).toBe(false);
  });
});
