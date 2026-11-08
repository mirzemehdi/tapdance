import type {
  ActionResult,
  AppInstallResult,
  DeviceInventory,
  DeviceKey,
  ElementTarget,
  LeaseHandle,
  LeaseRequest,
  LeaseStatus,
  LogFilter,
  LogResult,
  Platform,
  ScreenInspection,
  SwipeDirection,
  WorkerInfo,
  WaitCondition,
  WaitResult,
  AlertAction,
  AlertResult,
  DeviceOperation,
  DeviceOperationResult,
  AppBuildRequest,
  AppBuildResult,
  AppCiInstallRequest,
  AppCiInstallResult,
} from "./types.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
  /** The connect target this check is about, when several are configured (doctor groups by it). */
  target?: string;
}

/** Progress for slow calls (queueing, booting, uploading). Printed on stderr by the CLI. */
export type ProgressListener = (message: string) => void;

export interface CallOptions {
  onProgress?: ProgressListener;
  /**
   * A lease's notices (`LeaseHandle.notices`) as soon as they are known, before the lease returns
   * (the CLI prints them while the rest of the lease finishes). They are in the handle as well.
   */
  onNotice?: (notice: string) => void;
  signal?: AbortSignal;
}

/** Live-view endpoints a viewer may proxy. Credentials stay with the caller of this method. */
export interface ViewerEndpoints {
  streamUrl: string;
  inputUrl: string;
  headers: Record<string, string>;
}

/**
 * The one contract every device backend implements. The CLI, MCP server and SDK only ever talk to
 * this interface, so switching from a local worker to a self-hosted gateway — or to a future hosted
 * provider — changes configuration, not commands.
 *
 * Every device method takes the `LeaseHandle` the provider returned from `lease`. Providers must
 * refuse handles they did not issue, and must act only on the device that lease names.
 */
export interface DeviceProvider {
  readonly name: string;

  doctor(options?: CallOptions): Promise<DoctorCheck[]>;
  inventory(filter?: { platform?: Platform }): Promise<DeviceInventory>;
  workers(): Promise<WorkerInfo[]>;

  lease(sessionId: string, request: LeaseRequest, options?: CallOptions): Promise<LeaseHandle>;
  status(handle: LeaseHandle): Promise<LeaseStatus>;
  renew(handle: LeaseHandle, ttlMs?: number): Promise<LeaseStatus>;
  /** `unreachable`: the worker could not be reached, so the lease may still stand there until its TTL ends. */
  release(handle: LeaseHandle): Promise<{ released: boolean; unreachable?: boolean }>;

  installApp(handle: LeaseHandle, appPath: string, options?: CallOptions & { appId?: string }): Promise<AppInstallResult>;
  /** `console` (iOS): relaunch with the app's stdout/stderr captured, for logs --app. */
  launchApp(handle: LeaseHandle, appId: string, options?: { relaunch?: boolean; url?: string; args?: string[]; console?: boolean }): Promise<ActionResult>;
  stopApp(handle: LeaseHandle, appId: string): Promise<ActionResult>;
  listApps(handle: LeaseHandle): Promise<string[]>;

  /**
   * `system` (Android): every window from the system's own view of the screen, e.g. a Chrome Custom Tab
   * or a system picker. `appId` switches the session to that app (activated as it is, not relaunched),
   * then reads it.
   */
  inspect(handle: LeaseHandle, options?: { interactiveOnly?: boolean; system?: boolean; appId?: string }): Promise<ScreenInspection>;
  /** Builds an app on the machine that runs the device (a worker guard's allow-listed repositories) and installs it on the lease. */
  buildApp?(handle: LeaseHandle, request: AppBuildRequest, onLine: (line: string) => void): Promise<AppBuildResult>;
  /** Has the device's host fetch an app from the user's CI (a GitHub Actions artifact) with its own credentials and install it on the lease: an APK, or an iOS simulator .app (#121). */
  installFromCi?(handle: LeaseHandle, request: AppCiInstallRequest, onLine: (line: string) => void): Promise<AppCiInstallResult>;
  /** `inject` taps through Android's input service (`adb shell input tap`) instead of the automation helper. */
  tap(handle: LeaseHandle, target: ElementTarget, options?: { settle?: boolean; inject?: boolean }): Promise<ActionResult>;
  swipe(
    handle: LeaseHandle,
    gesture:
      | { kind: "direction"; direction: SwipeDirection; amount?: number; untilText?: string }
      | { kind: "points"; from: { x: number; y: number }; to: { x: number; y: number } },
  ): Promise<ActionResult>;
  waitFor(handle: LeaseHandle, condition: WaitCondition, timeoutMs: number): Promise<WaitResult>;
  alert(handle: LeaseHandle, action: AlertAction): Promise<AlertResult>;
  /** `delayMs` spaces the keystrokes, for text fields that drop fast input (Compose on iOS, #58). */
  typeText(handle: LeaseHandle, text: string, target?: ElementTarget, options?: { delayMs?: number }): Promise<ActionResult>;
  pressKey(handle: LeaseHandle, key: DeviceKey): Promise<ActionResult>;

  screenshot(handle: LeaseHandle, outPath: string): Promise<{ path: string; width?: number; height?: number }>;
  /** `token` is whatever the provider needs to stop this recording from another process; it is stored with the session. */
  startRecording(handle: LeaseHandle, outPath: string): Promise<{ path: string; token?: Record<string, unknown> }>;
  stopRecording(handle: LeaseHandle, token?: Record<string, unknown>): Promise<{ path: string; durationMs?: number; extraPaths: string[] }>;

  /**
   * The last `lines` log lines. With a `filter`, the last `lines` lines that pass it, searched across
   * everything the device's log keeps (set `filtered` on the result when the provider applied it).
   */
  logs(handle: LeaseHandle, options: { lines: number; appId?: string; filter?: LogFilter }): Promise<LogResult>;
  crashLogs(handle: LeaseHandle, options: { lines: number; appId?: string; filter?: LogFilter }): Promise<LogResult>;

  /** Optional: device-level operations (reset, settings, files, notifications, perf, audio, intents). */
  device?(handle: LeaseHandle, operation: DeviceOperation): Promise<DeviceOperationResult>;

  /** Optional: endpoints for a live screen + input viewer. Undefined when the backend has none. */
  viewer?(handle: LeaseHandle): Promise<ViewerEndpoints>;

  close(): Promise<void>;
}
