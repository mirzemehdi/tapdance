import { writeFile } from "node:fs/promises";
import {
  TapdanceError,
  type ActionResult,
  type DeviceProvider,
  type DoctorCheck,
  type ElementTarget,
  type LeaseHandle,
  type LeaseRequest,
  type LeaseStatus,
  type ScreenInspection,
  type WaitCondition,
} from "@tapdance/core";

/**
 * An in-memory provider for tests of everything above the provider contract. It records calls and
 * enforces the contract's rule that only handles it issued are accepted. It is not a device.
 */
export class FakeProvider implements DeviceProvider {
  readonly name: string = "fake";
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly active = new Set<string>();
  private next = 1;
  private readonly recordings = new Map<string, string>();
  private readonly failures = new Map<string, Error>();
  /** What inspect returns; tests may replace it. */
  screen: ScreenInspection = { app: "com.example.app", elements: [{ ref: "@e1", role: "button", label: "Sign in" }], truncated: false, warnings: [] };
  /** When set, waitFor answers from this text instead of always finding it. */
  visibleText: string[] | undefined;

  private note(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  /** Makes the next call of `method` throw `error` (once). */
  failNext(method: keyof DeviceProvider, error: Error): void {
    this.failures.set(method, error);
  }

  private failIfArmed(method: keyof DeviceProvider): void {
    const error = this.failures.get(method);
    if (error === undefined) return;
    this.failures.delete(method);
    throw error;
  }

  private check(handle: LeaseHandle): void {
    if (handle.provider !== this.name) throw new TapdanceError("FORBIDDEN", "foreign handle");
    if (!this.active.has(handle.leaseId)) throw new TapdanceError("LEASE_LOST", "lease ended");
  }

  async doctor(): Promise<DoctorCheck[]> {
    return [{ id: "fake", title: "Fake provider", status: "pass", detail: "ok" }];
  }
  async inventory() {
    return { catalog: [{ platform: "android" as const, models: ["Pixel 8"], osVersions: ["35"] }], capacity: [], devices: [], queueDepth: 0, notes: [] };
  }
  async workers() {
    return [{ id: "w1", connection: "connected" as const, platforms: [], leases: 0, capabilities: {} }];
  }
  async lease(sessionId: string, request: LeaseRequest): Promise<LeaseHandle> {
    this.note("lease", sessionId, request);
    const leaseId = `lease-${this.next++}`;
    this.active.add(leaseId);
    return {
      provider: this.name,
      leaseId,
      sessionId,
      platform: request.platform,
      model: request.device ?? "Pixel 8",
      osVersion: "35",
      physical: false,
      deviceId: "emulator-5554",
      location: { kind: "remote", endpoint: "https://gw.example.com", workerLabel: "laptop" },
      ttlMs: request.ttlMs,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + request.ttlMs).toISOString(),
      providerData: {},
    };
  }
  async status(handle: LeaseHandle): Promise<LeaseStatus> {
    this.failIfArmed("status");
    this.note("status", handle.leaseId);
    return this.active.has(handle.leaseId) ? { state: "active", handle, expiresAt: handle.expiresAt } : { state: "ended", handle };
  }
  async renew(handle: LeaseHandle): Promise<LeaseStatus> {
    this.failIfArmed("renew");
    this.check(handle);
    this.note("renew", handle.leaseId);
    return { state: "active", handle, expiresAt: new Date(Date.now() + handle.ttlMs).toISOString() };
  }
  async release(handle: LeaseHandle) {
    this.failIfArmed("release");
    this.note("release", handle.leaseId);
    return { released: this.active.delete(handle.leaseId) };
  }
  async installApp(handle: LeaseHandle, path: string) {
    this.check(handle);
    this.note("installApp", path);
    return { path, platform: handle.platform, appId: "com.example.app" };
  }
  async launchApp(handle: LeaseHandle, appId: string): Promise<ActionResult> {
    this.check(handle);
    this.note("launchApp", appId);
    return { ok: true, message: `Launched ${appId}` };
  }
  async stopApp(handle: LeaseHandle, appId: string): Promise<ActionResult> {
    this.check(handle);
    this.note("stopApp", appId);
    return { ok: true, message: `Stopped ${appId}` };
  }
  async listApps(handle: LeaseHandle) {
    this.check(handle);
    return ["com.example.app"];
  }
  async inspect(handle: LeaseHandle) {
    this.check(handle);
    this.note("inspect");
    return structuredClone(this.screen);
  }
  async tap(handle: LeaseHandle, target: ElementTarget): Promise<ActionResult> {
    this.failIfArmed("tap");
    this.check(handle);
    this.note("tap", target);
    return { ok: true, message: "Tapped", changes: ["+ @e2 [text-field] \"Email\""] };
  }
  async swipe(handle: LeaseHandle, gesture: unknown): Promise<ActionResult> {
    this.check(handle);
    this.note("swipe", gesture);
    return { ok: true, message: "Swiped" };
  }
  async waitFor(handle: LeaseHandle, condition: WaitCondition, timeoutMs = 0) {
    this.check(handle);
    this.note("waitFor", condition);
    if (this.visibleText === undefined || condition.kind === "stable") return { found: true, waitedMs: 5 };
    const seen = this.visibleText.includes(condition.text);
    const found = condition.kind === "text" ? seen : !seen;
    return { found, waitedMs: found ? 5 : timeoutMs };
  }
  async alert(handle: LeaseHandle, action: string) {
    this.check(handle);
    this.note("alert", action);
    return action === "get" ? { present: true, title: "Allow notifications?", buttons: ["Allow", "Don't Allow"] } : { present: true, acted: action };
  }
  async typeText(handle: LeaseHandle, text: string, target?: ElementTarget): Promise<ActionResult> {
    this.check(handle);
    this.note("typeText", text, target);
    return { ok: true, message: "Typed" };
  }
  async pressKey(handle: LeaseHandle, key: string): Promise<ActionResult> {
    this.check(handle);
    this.note("pressKey", key);
    return { ok: true, message: `Pressed ${key}` };
  }
  async screenshot(handle: LeaseHandle, outPath: string) {
    this.check(handle);
    // A 1×1 PNG, so callers that read the file get real bytes.
    await writeFile(outPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    return { path: outPath, width: 1, height: 1 };
  }
  async startRecording(handle: LeaseHandle, outPath: string) {
    this.failIfArmed("startRecording");
    this.check(handle);
    this.note("startRecording", outPath);
    // 2 KiB of stand-in video, so callers that size the file see real bytes.
    await writeFile(outPath, Buffer.alloc(2048, 1));
    this.recordings.set(handle.leaseId, outPath);
    return { path: outPath };
  }
  async stopRecording(handle: LeaseHandle) {
    this.failIfArmed("stopRecording");
    this.check(handle);
    this.note("stopRecording", handle.leaseId);
    const path = this.recordings.get(handle.leaseId);
    this.recordings.delete(handle.leaseId);
    if (path === undefined) throw new TapdanceError("USAGE", "no recording running");
    return { path, extraPaths: [] as string[] };
  }
  async logs(handle: LeaseHandle) {
    this.check(handle);
    return { source: "fake", lines: ["line 1", "line 2"], truncated: false };
  }
  async crashLogs(handle: LeaseHandle) {
    this.check(handle);
    return { source: "fake crash", lines: [], truncated: false };
  }
  async close(): Promise<void> {}
}
