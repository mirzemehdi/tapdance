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
  /** A device profile prepared on this machine (`tapdance device profile create`): booted read-only. */
  profile?: string;
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
  /** The OS version a lease gets when it names none. */
  defaultOsVersion?: string;
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
  /** State flags the backend reports: checked / unchecked (checkable controls), selected, focused, expanded. */
  states?: string[];
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
  /** The action moved to a different surface (a new screen or a system sheet): earlier refs are void. */
  screenChanged?: boolean;
  warning?: string;
  /** What to do next, when the backend or Tapdance knows. */
  hint?: string;
  /** How the target was found when it was not an exact match: a stale ref matched by label, or one of several matches. */
  resolvedBy?: "label-fallback" | "disambiguated";
  /** Labels of the other elements that matched, when the backend picked one of several. */
  alternatives?: string[];
  /** Actionable elements still on screen that the change list does not mention, as `@eN [role] "label"`. */
  stillOnScreen?: string[];
  /** For a fill: whether the field was read back with the requested text. */
  typed?: "confirmed" | "unconfirmed";
  /** For an unconfirmed fill: what the field holds now. */
  fieldNow?: string;
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

/** An explicit Android intent for `launch_app`. Values are validated and quoted by the provider. */
export interface IntentSpec {
  action?: string;
  data?: string;
  component?: string;
  categories?: string[];
  flags?: string;
  extras?: Record<string, string | number | boolean>;
}

/** Device settings an agent may change on its leased device. Every change ends with the lease (the device is wiped). */
export const DEVICE_SETTINGS = [
  "wifi",
  "bluetooth",
  "airplane",
  "mobile-data",
  "location",
  "animations",
  "appearance",
  "text-size",
  "faceid",
  "touchid",
  "fingerprint",
  "permission",
  "reset-keychain",
  "orientation",
  "status-bar-time",
  "browser-first-run",
] as const;
export type DeviceSettingName = (typeof DEVICE_SETTINGS)[number];

export interface DeviceSettingChange {
  name: DeviceSettingName;
  /** on/off, light/dark, a text size, portrait/landscape-left…, HH:MM, or grant/deny/reset. */
  value?: string;
  appId?: string;
  /** For `permission`: camera, microphone, photos, notifications, location… */
  permission?: string;
  latitude?: number;
  longitude?: number;
}

/** `files` (iOS): the Files app's "On My iPhone", which every app's document picker sees. */
export type FileDestination = "downloads" | "pictures" | "documents" | "app_sandbox" | "files";

export interface DeviceNotification {
  package: string;
  title?: string;
  text?: string;
  key?: string;
  postedAt?: string;
}

/** Device-level operations beyond UI driving. Optional for providers; absent means NOT_SUPPORTED. */
/** An app build on the device's host from a git repository (iOS: xcodebuild; Android: Gradle). */
export interface AppBuildRequest {
  repo: string;
  ref: string;
  project?: string;
  scheme?: string;
  configuration?: string;
  gradleTask?: string;
  dir?: string;
}

export interface AppBuildResult {
  /** The exact commit that was built. */
  sha: string;
  seconds: number;
  /** File name of the built .app or .apk (it stays on the host). */
  artifact: string;
  installed: boolean;
}

/** One tap of a timed sequence: `t` ms after the start, at (x, y); `hold` ms makes it a long press. */
export interface TimedTap {
  t: number;
  x: number;
  y: number;
  hold?: number;
}

export type DeviceOperation =
  | { kind: "uninstall"; appId: string }
  | { kind: "clear-app-data"; appId: string }
  /** Android: taps (or holds) at set times, run as one script inside the emulator so the network adds no delay between them. */
  | { kind: "tap-sequence"; steps: TimedTap[] }
  /** Read or write the device clipboard (paste flows, checking what "Copy link" copied). */
  | { kind: "clipboard"; action: "get" } | { kind: "clipboard"; action: "set"; text: string }
  /** Android 13+: one app's language (`cmd locale set-app-locales`), e.g. "de-DE". */
  | { kind: "app-locale"; appId: string; locale: string }
  /** End an app the way a user does (to the background, then gone), keeping its alarms and jobs: unlike a force-stop. */
  | { kind: "kill-app"; appId: string }
  | { kind: "setting"; change: DeviceSettingChange }
  | { kind: "intent"; intent: IntentSpec }
  | { kind: "push-file"; localPath: string; destination: FileDestination; appId?: string; name?: string }
  | { kind: "pull-file"; outPath: string; devicePath?: string; appId?: string; relativePath?: string; filesName?: string }
  | { kind: "notifications"; action: "list" | "open" | "close"; appId?: string }
  | { kind: "post-notification"; title?: string; text?: string; appId?: string; payload?: Record<string, unknown> }
  | { kind: "perf"; metric: "frames" | "memory"; appId?: string }
  /** Android: `adb shell` inside the leased emulator (its own VM, wiped at release); never the host. */
  | { kind: "shell"; command: string; stdin?: string; timeoutMs?: number };

export interface DeviceOperationResult {
  ok: boolean;
  message: string;
  /** Operation-specific data: the setting read back, notifications, a perf summary… */
  data?: Record<string, unknown>;
  /** A file the operation wrote on this machine (pulled file). */
  path?: string;
  /** Where a pushed file landed on the device. */
  devicePath?: string;
}

const GENERIC_ROLES = /^(group|other|view|layout|frame|container|linearlayout|framelayout|relativelayout|viewgroup|scrollview|window|element|composeview|androidcomposeview)$/i;

/** Drops unlabelled containers (no label, value, id or state), the bulk of a Compose or SwiftUI tree. */
export function compactElements(elements: UiElement[]): UiElement[] {
  return elements.filter((e) => !(GENERIC_ROLES.test(e.role) && !e.label && !e.value && !e.identifier && !e.states?.length));
}
