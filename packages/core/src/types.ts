export type Platform = "android" | "ios";
export const PLATFORMS: readonly Platform[] = ["android", "ios"];

/** What the caller asks for. Everything but `platform` is optional; the provider picks the rest. */
export interface LeaseRequest {
  platform: Platform;
  /** A model name such as "Pixel 8" or "iPhone 16". */
  device?: string;
  /** An OS version or range ("18.5", ">=17", Android API level "34"). */
  osVersion?: string;
  /** Android system image tag, e.g. "google_apis_playstore". */
  imageTag?: string;
  physical?: boolean;
  ttlMs: number;
  /** How long to wait in the provider's queue before failing. */
  waitTimeoutMs?: number;
}

/** Where a device runs, so humans and agents can tell a laptop from a cloud VM. */
export interface DeviceLocation {
  /** "local" (this machine's worker), "remote" (a worker behind a gateway or endpoint), "cloud". */
  kind: "local" | "remote" | "cloud";
  workerId?: string;
  workerLabel?: string;
  endpoint: string;
}

/**
 * Everything needed to act on a leased device again from another process: it is written to the
 * session record. `providerData` is opaque to everything but the provider that wrote it.
 */
export interface LeaseHandle {
  provider: string;
  leaseId: string;
  sessionId: string;
  platform: Platform;
  model: string;
  osVersion: string;
  physical: boolean;
  /** iOS simulator UDID or Android serial. Informational: commands never take it from callers. */
  deviceId: string;
  location: DeviceLocation;
  ttlMs: number;
  createdAt: string;
  expiresAt: string;
  providerData: Record<string, unknown>;
}

export type LeaseState = "active" | "ended" | "unknown";

export interface LeaseStatus {
  state: LeaseState;
  handle: LeaseHandle;
  expiresAt?: string;
  /** Why the lease ended, when the provider knows. */
  endReason?: string;
  foregroundApp?: string;
  notices?: string[];
}

export interface CatalogEntry {
  platform: Platform;
  models: string[];
  osVersions: string[];
  imageTags?: string[];
}

export interface CapacitySummary {
  platform: Platform;
  running: number;
  limit: number;
  warm: number;
  leased: number;
}

export interface DeviceInventory {
  catalog: CatalogEntry[];
  capacity: CapacitySummary[];
  devices: Array<{
    id: string;
    platform: Platform;
    model: string;
    osVersion?: string;
    state: string;
    leased: boolean;
    workerId?: string;
  }>;
  queueDepth: number;
  notes: string[];
}

export interface WorkerInfo {
  id: string;
  label?: string;
  connection: "connected" | "disconnected" | "incompatible" | "self";
  platforms: Array<{ platform: Platform; running: number; limit: number }>;
  leases: number;
  host?: string;
  capabilities: Record<string, string>;
  lastSeen?: string;
}

/** A way to point at a UI element. Exactly one form must be set. */
export type ElementTarget =
  | { kind: "text"; text: string }
  | { kind: "id"; id: string }
  | { kind: "ref"; ref: string }
  | { kind: "selector"; selector: string }
  | { kind: "point"; x: number; y: number };

export interface UiElement {
  ref: string;
  role: string;
  label?: string;
  value?: string;
  identifier?: string;
  placeholder?: string;
  enabled?: boolean;
  editable?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  depth?: number;
}

export interface ScreenInspection {
  app?: string;
  viewport?: { width: number; height: number };
  elements: UiElement[];
  truncated: boolean;
  warnings: string[];
}

export interface ActionResult {
  ok: true;
  message: string;
  /** What changed on screen after the action, when the backend reports it. */
  changes?: string[];
  point?: { x: number; y: number };
}

export type SwipeDirection = "up" | "down" | "left" | "right";

/** What to wait for on screen. `stable` waits until the UI stops changing. */
export type WaitCondition =
  | { kind: "text"; text: string }
  | { kind: "absent"; text: string }
  | { kind: "stable" };

export interface WaitResult {
  /** False on timeout: that is an answer, not an error. */
  found: boolean;
  waitedMs: number;
  hint?: string;
}

export type AlertAction = "get" | "accept" | "dismiss";

export interface AlertResult {
  present: boolean;
  title?: string;
  message?: string;
  buttons?: string[];
  acted?: string;
}
export type DeviceKey = "back" | "home" | "enter" | "app_switcher" | "dismiss_keyboard";

export interface AppInstallResult {
  appId?: string;
  path: string;
  platform: Platform;
}

export interface ArtifactRef {
  id: string;
  kind: "screenshot" | "recording" | "log" | "inspection" | "other";
  path: string;
  bytes: number;
  createdAt: string;
  sessionId: string;
  leaseId?: string;
  note?: string;
}

export interface LogResult {
  source: string;
  lines: string[];
  truncated: boolean;
  artifact?: ArtifactRef;
}
