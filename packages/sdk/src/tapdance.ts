import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  LocalArtifactStore,
  SessionStore,
  TapdanceError,
  compactElements,
  loadConfig,
  resolveSessionIdentity,
  type ActionResult,
  type ArtifactRef,
  type DeviceInventory,
  type DeviceKey,
  type DeviceProvider,
  type DoctorCheck,
  type ElementTarget,
  type LeaseHandle,
  type LeaseStatus,
  type LogResult,
  type Platform,
  type ProgressListener,
  type ResolvedConfig,
  type ScreenInspection,
  type LeaseOwner,
  type SessionIdentity,
  type SessionRecord,
  type SwipeDirection,
  type ViewerEndpoints,
  type WorkerInfo,
  type WaitCondition,
  type WaitResult,
  type AlertAction,
  type AlertResult,
  type DeviceOperation,
  type DeviceOperationResult, type TimedTap, type AppBuildRequest, type AppBuildResult } from "@tapdance/core";
import { aabToApk } from "./bundletool.js";
import { PROFILE_PROVIDER, ProfileProvider, isNotableBuildLine } from "@tapdance/provider-simlock";
import { hostChecks } from "./host-checks.js";
import { findTool, runTool, type ToolRun } from "./tools.js";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { readFileSync } from "node:fs";
import { createProvider } from "./provider-factory.js";

export interface TapdanceOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  /** Overrides the resolved session identity (the MCP server passes one per process). */
  session?: SessionIdentity;
  /** Inject a provider (tests, embedding). Defaults to the one the config names. */
  provider?: DeviceProvider;
  /** Inject the device-profile provider (tests). */
  profileProvider?: DeviceProvider;
  onProgress?: ProgressListener;
  /** Who is acting; recorded as the lease owner so a shutdown releases only what it created. */
  owner?: LeaseOwner["kind"];
  /** Load the operator token (fleet views such as `workers list`). Off for agents by default. */
  fleet?: boolean;
}

/** The longest `waitFor` (10 minutes): an audio preview, a slow sync. */
export const MAX_WAIT_MS = 600_000;

export interface HumanRequest {
  reason: string;
  requestedAt: string;
  leaseId: string;
  doneAt?: string;
  doneBy?: string;
  /** Ended by `cancelHumanRequest`, not by the person. */
  cancelled?: boolean;
}

export interface LeaseOptions {
  platform: Platform;
  device?: string;
  osVersion?: string;
  imageTag?: string;
  physical?: boolean;
  /** A device profile on this machine (`tapdance device profile create`), booted read-only. */
  profile?: string;
  ttlMinutes?: number;
  waitSeconds?: number;
  /** Return the session's current lease instead of failing when it already holds one on this platform. */
  reuse?: boolean;
}

export interface DeviceSummary {
  sessionId: string;
  leaseId: string;
  platform: Platform;
  model: string;
  osVersion: string;
  deviceId: string;
  provider: string;
  location: LeaseHandle["location"];
  expiresAt: string;
  state: LeaseStatus["state"];
  recording?: string;
  humanHoldUntil?: string;
  owner?: string;
  note?: string;
}

export function summarize(record: SessionRecord, status?: LeaseStatus, holdUntil?: string): DeviceSummary {
  const h = record.handle;
  return {
    sessionId: record.sessionId,
    leaseId: h.leaseId,
    platform: h.platform,
    model: h.model,
    osVersion: h.osVersion,
    deviceId: h.deviceId,
    provider: h.provider,
    location: h.location,
    expiresAt: status?.expiresAt ?? h.expiresAt,
    state: status?.state ?? "unknown",
    ...(record.recording ? { recording: record.recording.path } : {}),
    ...(holdUntil ? { humanHoldUntil: holdUntil } : {}),
    ...(record.owner ? { owner: `${record.owner.kind} (pid ${record.owner.pid})` } : {}),
    ...(status?.endReason && status.state !== "active" ? { note: status.endReason } : {}),
  };
}

/**
 * The programmatic Tapdance API. Every device method acts on the active lease of this instance's
 * session and nothing else: there is no way to pass a device or lease id in.
 */
/** The screen's content without positions (see SimlockProvider's stable wait). */
function fingerprintOf(elements: Array<{ role: string; label?: string; value?: string; identifier?: string; states?: string[] }>): string {
  return elements.map((e) => [e.role, e.label ?? "", e.value ?? "", e.identifier ?? "", (e.states ?? []).join(",")].join("|")).join("\n");
}

export class Tapdance {
  readonly store: SessionStore;
  readonly artifacts: LocalArtifactStore;
  private providerPromise: Promise<DeviceProvider> | undefined;
  private profileProviderInstance: DeviceProvider | undefined;

  private constructor(
    readonly resolved: ResolvedConfig,
    readonly session: SessionIdentity,
    private readonly options: TapdanceOptions,
  ) {
    this.store = new SessionStore(resolved.home);
    this.artifacts = new LocalArtifactStore(resolved.artifactsDir);
    if (options.provider) this.providerPromise = Promise.resolve(options.provider);
  }

  static async create(options: TapdanceOptions = {}): Promise<Tapdance> {
    const resolved = await loadConfig({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.configPath ? { configPath: options.configPath } : {}),
    });
    const session = options.session ?? (await resolveSessionIdentity(resolved.home, options.env ?? process.env));
    return new Tapdance(resolved, session, options);
  }

  get sessionId(): string {
    return this.session.id;
  }

  provider(): Promise<DeviceProvider> {
    this.providerPromise ??= createProvider(this.resolved, this.session.id, this.options.env ?? process.env, { fleet: this.options.fleet ?? false });
    return this.providerPromise;
  }

  /** Device profiles run on this machine, outside Simlock (see ProfileProvider). */
  private profileProvider(): DeviceProvider {
    this.profileProviderInstance ??= this.options.profileProvider ?? new ProfileProvider(this.options.env ?? process.env);
    return this.profileProviderInstance;
  }

  /** The provider that issued a handle: profile leases go to the profile provider. */
  private async providerFor(handle: LeaseHandle): Promise<DeviceProvider> {
    return handle.provider === PROFILE_PROVIDER ? this.profileProvider() : this.provider();
  }

  private progress(message: string): void {
    this.options.onProgress?.(message);
  }

  // ------------------------------------------------------------ setup

  async doctor(options: { host?: boolean } = {}): Promise<DoctorCheck[]> {
    const { config } = this.resolved;
    const warnings = this.resolved.warnings ?? [];
    const checks: DoctorCheck[] = [
      {
        id: "config",
        title: "Configuration",
        status: warnings.length > 0 ? "warn" : "pass",
        detail: `provider ${config.provider}${config.endpoint ? ` → ${config.endpoint}` : ""}; sources: ${this.resolved.sources.join(", ") || "defaults"}${warnings.length > 0 ? `. ${warnings.join(". ")}` : ""}`,
        ...(warnings.length > 0 ? { fix: "Set those keys with `tapdance config set --global`, or remove them from tapdance.config.json." } : {}),
      },
      { id: "session", title: "Session identity", status: "pass", detail: `${this.session.id} (from ${this.session.source})` },
    ];
    const runHost = options.host ?? config.provider === "local";
    if (runHost) {
      checks.push(...(await hostChecks({ platforms: { android: config.platforms.android.enabled, ios: config.platforms.ios.enabled }, ...(this.options.env ? { env: this.options.env } : {}) })));
    }
    try {
      const provider = await this.provider();
      checks.push(...(await provider.doctor()));
    } catch (error) {
      const e = error instanceof TapdanceError ? error : new TapdanceError("INTERNAL", String(error));
      checks.push({ id: "provider", title: "Device provider", status: "fail", detail: e.message, ...(e.hint ? { fix: e.hint } : {}) });
    }
    const record = await this.store.get(this.session.id);
    checks.push({
      id: "lease",
      title: "Device lease",
      status: "pass",
      detail: record ? `holding ${record.handle.model} (${record.handle.platform}) lease ${record.handle.leaseId}` : "none held by this session",
    });
    return checks;
  }

  async devices(platform?: Platform): Promise<DeviceInventory> {
    const inventory = await (await this.provider()).inventory(platform ? { platform } : {});
    // Device profiles on this machine are leasable too (`profile:<name>`).
    const profiles = await this.profileProvider().inventory().catch(() => undefined);
    const catalog = (profiles?.catalog ?? []).filter((c) => !platform || c.platform === platform);
    if (!catalog.length) return inventory;
    return { ...inventory, catalog: [...inventory.catalog, ...catalog], notes: [...inventory.notes, ...(profiles?.notes ?? [])] };
  }

  async workers(): Promise<WorkerInfo[]> {
    return (await this.provider()).workers();
  }

  // ------------------------------------------------------------ lease lifecycle

  /** The session record if a lease is held; never touches the provider. */
  async current(): Promise<SessionRecord | undefined> {
    return this.store.get(this.session.id);
  }

  private endedPath(): string {
    return `${this.store.path(this.session.id)}.ended.json`;
  }

  /** Remembers why the session's lease ended, so the next command can say so instead of "no device". */
  private async noteEnded(handle: LeaseHandle, reason: string): Promise<void> {
    const note = { model: handle.model, platform: handle.platform, leaseId: handle.leaseId, endedAt: new Date().toISOString(), reason };
    await writeFile(this.endedPath(), JSON.stringify(note), { mode: 0o600 }).catch(() => undefined);
  }

  private async active(): Promise<{ record: SessionRecord; provider: DeviceProvider }> {
    const record = await this.store.get(this.session.id);
    if (record === undefined) {
      const ended = JSON.parse(await readFile(this.endedPath(), "utf8").catch(() => "{}")) as { model?: string; endedAt?: string; reason?: string; leaseId?: string };
      if (ended.endedAt) {
        throw new TapdanceError("LEASE_LOST", `The lease on ${ended.model ?? "the device"} ended at ${ended.endedAt}: ${ended.reason ?? "unknown reason"}`, {
          hint: "Lease a new device (anything installed on the old one was wiped).",
          details: { sessionId: this.session.id, ...ended },
        });
      }
      throw new TapdanceError("NO_ACTIVE_LEASE", "This session holds no device", {
        hint: "Lease one first: `tapdance device lease --platform android` (MCP: lease_device).",
        details: { sessionId: this.session.id },
      });
    }
    return { record, provider: await this.providerFor(record.handle) };
  }

  /** Runs a device action; a lost lease clears the session record so the next call says so plainly. */
  private async onDevice<T>(fn: (handle: LeaseHandle, provider: DeviceProvider, record: SessionRecord) => Promise<T>): Promise<T> {
    const { record, provider } = await this.active();
    try {
      const result = await fn(record.handle, provider, record);
      await this.store
        .update(this.session.id, (r) => (r.handle.leaseId === record.handle.leaseId ? { ...r, lastUsedAt: new Date().toISOString() } : undefined))
        .catch(() => undefined);
      return result;
    } catch (error) {
      if (error instanceof TapdanceError && error.code === "LEASE_LOST") {
        // End it on the provider too: a lease misjudged as lost must not stay booked until its TTL.
        await provider.release(record.handle).catch(() => undefined);
        await this.store.delete(this.session.id, record.handle.leaseId);
        await this.noteEnded(record.handle, error.message);
        throw error;
      }
      // An unexpected failure may really be a lease that ended underneath the call (expired, released
      // by the host, worker restarted): ask the provider, and say that instead of an internal error.
      if (!(error instanceof TapdanceError) || ["INTERNAL", "DEVICE_ERROR", "PROVIDER_UNREACHABLE", "TIMEOUT"].includes(error.code)) {
        const status = await provider.status(record.handle).catch(() => undefined);
        if (status?.state === "ended") {
          const reason = status.endReason ?? "the lease ended on the worker";
          await this.store.delete(this.session.id, record.handle.leaseId);
          await this.noteEnded(record.handle, reason);
          throw new TapdanceError("LEASE_LOST", `The lease on ${record.handle.model} ended: ${reason}`, {
            hint: "Lease a new device (anything installed on the old one was wiped).",
            cause: error,
          });
        }
      }
      throw error;
    }
  }

  /** Marks the session's lease as used now, so the keepalive's idle release leaves it alone. */
  private async touch(leaseId: string): Promise<void> {
    await this.store
      .update(this.session.id, (r) => (r.handle.leaseId === leaseId ? { ...r, lastUsedAt: new Date().toISOString() } : undefined))
      .catch(() => undefined);
  }

  /** Agent input waits while a person holds the device in the browser viewer (cf. Loupe's humanHeld). */
  private async guardHuman(): Promise<void> {
    const hold = await this.store.getHold(this.session.id);
    const until = hold ? Date.parse(hold.until) : 0;
    const now = Date.now();
    if (hold && until > now) {
      throw new TapdanceError("HUMAN_HELD", `A person is controlling the device in the viewer (${hold.by})`, {
        hint: `Wait and retry in ${Math.ceil((until - now) / 1000)} s; their control lapses when they stop touching the screen or press "Hand back".`,
        details: { retryAfterMs: until - now },
        retryAfterMs: until - now,
      });
    }
  }

  async lease(options: LeaseOptions): Promise<{ record: SessionRecord; summary: DeviceSummary; reused: boolean; ttlCappedMinutes?: number }> {
    const { config } = this.resolved;
    if (!config.platforms[options.platform].enabled) {
      throw new TapdanceError("USAGE", `${options.platform} is disabled in the configuration`, { hint: `Set platforms.${options.platform}.enabled to true.` });
    }
    const provider = options.profile ? this.profileProvider() : await this.provider();
    // The whole check-then-lease runs under the session lock, so two processes of one session
    // (parallel sub-agents, CLI + MCP) cannot both lease.
    return this.store.withLock(this.session.id, async () => {
      const existing = await this.store.get(this.session.id);
      if (existing !== undefined) {
        const status = await (await this.providerFor(existing.handle)).status(existing.handle).catch(() => undefined);
        if (status?.state === "active" || status?.state === "unknown" || status === undefined) {
          if (options.reuse && existing.handle.platform === options.platform && (!options.device || options.device === existing.handle.model)) {
            return { record: existing, summary: summarize(existing, status), reused: true };
          }
          throw new TapdanceError("LEASE_ALREADY_HELD", `This session already holds ${existing.handle.model} (${existing.handle.platform})`, {
            hint: "Use it, or release it first with `tapdance device release` (MCP: release_device).",
            details: { device: summarize(existing, status) },
          });
        }
        await rm(this.store.path(this.session.id), { force: true });
      }
      const ttlMinutes = options.ttlMinutes ?? config.session.defaultTtlMinutes;
      const waitSeconds = options.waitSeconds ?? config.session.leaseWaitSeconds;
      const handle = await provider.lease(
        this.session.id,
        {
          platform: options.platform,
          ...(options.device ? { device: options.device } : {}),
          ...(options.osVersion ? { osVersion: options.osVersion } : {}),
          ...(options.imageTag ? { imageTag: options.imageTag } : {}),
          ...(options.physical ? { physical: true } : {}),
          ...(options.profile ? { profile: options.profile } : {}),
          ttlMs: ttlMinutes * 60_000,
          ...(waitSeconds > 0 ? { waitTimeoutMs: waitSeconds * 1000 } : {}),
        },
        { onProgress: (m) => this.progress(m) },
      );
      const now = new Date().toISOString();
      const record = await this.store.put({
        sessionId: this.session.id,
        handle,
        owner: { kind: this.options.owner ?? "sdk", pid: process.pid },
        lastUsedAt: now,
        updatedAt: now,
      });
      await rm(this.endedPath(), { force: true });
      // A worker may grant less time than asked (the worker guard's maxLeaseMinutes): say so.
      const grantedMin = Math.round((Date.parse(handle.expiresAt) - Date.now()) / 60_000);
      const ttlCappedMinutes = grantedMin > 0 && grantedMin < ttlMinutes - 1 ? grantedMin : undefined;
      return {
        record,
        summary: summarize(record, { state: "active", handle, expiresAt: handle.expiresAt }),
        reused: false,
        ...(ttlCappedMinutes ? { ttlCappedMinutes } : {}),
      };
    });
  }

  async status(): Promise<DeviceSummary> {
    const { record, provider } = await this.active();
    const status = await provider.status(record.handle);
    if (status.state === "ended") {
      await this.store.delete(this.session.id, record.handle.leaseId);
      await this.noteEnded(record.handle, status.endReason ?? "the lease ended on the worker");
      throw new TapdanceError("LEASE_LOST", `The lease on ${record.handle.model} has ended${status.endReason ? `: ${status.endReason}` : ""}`, {
        hint: "Lease a new device. Anything installed on the old one was wiped.",
        details: { reason: status.endReason },
      });
    }
    const hold = await this.store.getHold(this.session.id);
    return summarize(record, status, hold?.until);
  }

  async renew(ttlMinutes?: number): Promise<DeviceSummary> {
    const { record, provider } = await this.active();
    try {
      const status = await provider.renew(record.handle, ttlMinutes === undefined ? record.handle.ttlMs : ttlMinutes * 60_000);
      if (status.state === "ended") {
        await this.store.delete(this.session.id, record.handle.leaseId);
        await this.noteEnded(record.handle, status.endReason ?? "the lease ended on the worker");
        throw new TapdanceError("LEASE_LOST", `The lease on ${record.handle.model} has ended${status.endReason ? `: ${status.endReason}` : ""}`, {
          hint: "Lease a new device. Anything installed on the old one was wiped.",
          details: { reason: status.endReason },
        });
      }
      const updated = await this.store.update(this.session.id, (r) =>
        r.handle.leaseId === record.handle.leaseId
          ? { ...r, handle: { ...r.handle, ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}) }, renewer: { pid: process.pid, heartbeatAt: new Date().toISOString() } }
          : undefined,
      );
      return summarize(updated ?? record, status);
    } catch (error) {
      if (error instanceof TapdanceError && error.code === "LEASE_LOST") {
        await this.store.delete(this.session.id, record.handle.leaseId);
        await this.noteEnded(record.handle, error.message);
      }
      throw error;
    }
  }

  /**
   * Releases this session's lease. Only ever this session's: there is no id to pass. With
   * `onlyOwnedBy`, releases only a lease that process created (the MCP server's shutdown uses it).
   */
  async release(options: { onlyOwnedBy?: LeaseOwner } = {}): Promise<{ released: boolean; unreachable?: boolean; device?: DeviceSummary; skipped?: string; artifacts?: ArtifactRef[] }> {
    const record = await this.store.get(this.session.id);
    if (record === undefined) return { released: false };
    if (options.onlyOwnedBy && (record.owner?.kind !== options.onlyOwnedBy.kind || record.owner.pid !== options.onlyOwnedBy.pid)) {
      return { released: false, skipped: `lease belongs to ${record.owner?.kind ?? "another process"}` };
    }
    const provider = await this.providerFor(record.handle);
    // A recording still running is evidence: stop it and keep the video before the device goes away.
    const artifacts: ArtifactRef[] = [];
    if (record.recording) {
      try {
        const stopped = await provider.stopRecording(record.handle, record.recording.token);
        const base = { kind: "recording" as const, sessionId: this.session.id, leaseId: record.handle.leaseId, note: "stopped at release" };
        artifacts.push(await this.artifacts.record({ ...base, path: stopped.path }));
        for (const p of stopped.extraPaths) if (existsSync(p)) artifacts.push(await this.artifacts.record({ ...base, path: p }));
      } catch (error) {
        this.progress(`Could not stop the recording before release: ${(error as Error).message}`);
      }
    }
    const result: { released: boolean; unreachable?: boolean } = await provider.release(record.handle).catch(() => ({ released: false }));
    // An unreachable worker still holds the lease: keep the record so release can be run again.
    if (!result.unreachable) {
      await this.store.delete(this.session.id, record.handle.leaseId);
      await rm(this.endedPath(), { force: true });
    }
    if (record.keepalivePid && record.keepalivePid !== process.pid && (await isKeepaliveProcess(record.keepalivePid))) {
      try {
        process.kill(record.keepalivePid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    return {
      released: result.released,
      ...(result.unreachable ? { unreachable: true } : {}),
      device: summarize(record, { state: "ended", handle: record.handle }),
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
  }

  // ------------------------------------------------------------ apps

  async installApp(appPath: string, appId?: string): Promise<{ appId?: string; path: string; convertedFrom?: string }> {
    await this.guardHuman();
    // An Android App Bundle becomes a universal APK here, before upload, so gateways and the guard
    // only ever see an APK.
    const converted = extname(appPath).toLowerCase() === ".aab" ? await aabToApk(appPath, { env: this.options.env ?? process.env, onProgress: (m) => this.progress(m), ...(this.resolved.config.tools.paths["bundletool"] ? { bundletool: this.resolved.config.tools.paths["bundletool"] } : {}) }) : undefined;
    try {
      const result = await this.onDevice((handle, provider) =>
        provider.installApp(handle, converted ?? appPath, { ...(appId ? { appId } : {}), onProgress: (m) => this.progress(m) }),
      );
      return converted ? { ...result, path: appPath, convertedFrom: appPath } : result;
    } finally {
      // The universal APK lives in its own temporary folder; it is not needed once uploaded.
      if (converted) await rm(dirname(converted), { recursive: true, force: true });
    }
  }

  /**
   * Device-level operations: reset, settings, files, notifications, intents, perf, audio. A pulled
   * file becomes a session artifact. Mutations wait for a person holding the device to hand it back.
   */
  /**
   * Taps at set times, run inside the emulator (Android) so the network adds no delay between taps:
   * rhythm and timing games. With `startOnText`, waits for that text first (up to `waitMs`), then starts
   * `offsetMs` later; the wait itself costs one round trip.
   */
  async tapSequence(
    steps: TimedTap[],
    options: { startOnText?: string; offsetMs?: number; waitMs?: number } = {},
  ): Promise<DeviceOperationResult & { startedAfterMs?: number }> {
    const offset = options.offsetMs ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > 60_000) throw new TapdanceError("USAGE", "offsetMs must be whole milliseconds from 0 to 60000");
    const shifted = steps.map((s) => ({ ...s, t: s.t + offset }));
    let startedAfterMs: number | undefined;
    if (options.startOnText) {
      const wait = await this.waitFor({ kind: "text", text: options.startOnText }, options.waitMs ?? 60_000);
      if (!wait.found) throw new TapdanceError("TIMEOUT", `"${options.startOnText}" did not appear within ${Math.round(wait.waitedMs / 1000)} s; no tap was sent`);
      startedAfterMs = wait.waitedMs;
    }
    const result = await this.device({ kind: "tap-sequence", steps: shifted });
    return { ...result, ...(startedAfterMs !== undefined ? { startedAfterMs } : {}) };
  }

  async device(operation: DeviceOperation): Promise<DeviceOperationResult & { artifact?: ArtifactRef }> {
    const readOnly =
      (operation.kind === "notifications" && operation.action === "list") ||
      operation.kind === "perf" ||
      operation.kind === "pull-file" ||
      operation.kind === "crash-list" ||
      operation.kind === "crash-pull" ||
      (operation.kind === "clipboard" && operation.action === "get") ||
      (operation.kind === "setting" && operation.change.value === undefined && operation.change.name !== "reset-keychain");
    if (!readOnly) await this.guardHuman();
    if (operation.kind === "shell" && Buffer.byteLength(operation.stdin ?? "") > 16 * 1024 * 1024) throw new TapdanceError("USAGE", "stdin is limited to 16 MB");
    return this.onDevice(async (handle, provider) => {
      if (!provider.device) throw new TapdanceError("NOT_SUPPORTED", `The ${provider.name} provider has no device-level operations`);
      if (operation.kind === "crash-pull") {
        const outPath = await this.artifacts.allocate(this.session.id, "log", "ips", operation.outPath || undefined);
        const result = await provider.device(handle, { ...operation, outPath });
        const artifact = await this.artifacts.record({ kind: "log", path: result.path ?? outPath, sessionId: this.session.id, leaseId: handle.leaseId, note: `crash report ${String(result.data?.["name"] ?? operation.name)}` });
        return { ...result, artifact };
      }
      if (operation.kind !== "pull-file") return provider.device(handle, operation);
      const name = basename(operation.devicePath ?? operation.relativePath ?? operation.filesName ?? "file");
      const outPath = await this.artifacts.allocate(this.session.id, "other", extname(name).slice(1) || "bin", operation.outPath || undefined);
      const result = await provider.device(handle, { ...operation, outPath });
      const artifact = await this.artifacts.record({ kind: "other", path: result.path ?? outPath, sessionId: this.session.id, leaseId: handle.leaseId, note: `pulled ${name}` });
      return { ...result, artifact };
    });
  }

  /**
   * Builds the app on the machine that runs the leased device, from a git repository its owner
   * allow-listed, and installs it there (#45): how an agent without Xcode gets an iOS app onto a lease.
   * Log lines go to progress: by default only steps, errors and the outcome, with a count of the lines
   * left out; `verbose` passes every line (#53).
   */
  async buildApp(request: AppBuildRequest, options: { verbose?: boolean } = {}): Promise<AppBuildResult> {
    await this.guardHuman();
    let hidden = 0;
    const onLine = (line: string) => {
      if (options.verbose || isNotableBuildLine(line)) {
        if (hidden > 0) this.progress(`… ${hidden} log lines`);
        hidden = 0;
        this.progress(line);
      } else if (++hidden % 5000 === 0) this.progress(`… ${hidden} log lines`);
    };
    return this.onDevice(async (handle, provider) => {
      if (!provider.buildApp) throw new TapdanceError("NOT_SUPPORTED", `Provider ${provider.name} cannot build apps`);
      return provider.buildApp(handle, request, onLine);
    });
  }

  /**
   * Launches an app. `locale` (e.g. "de-DE") runs it in that language: iOS through the launch
   * arguments -AppleLanguages/-AppleLocale, Android 13+ by setting the app's own locale first.
   */
  async launchApp(appId: string, options: { relaunch?: boolean; url?: string; args?: string[]; locale?: string } = {}): Promise<ActionResult> {
    await this.guardHuman();
    const { locale, ...launch } = options;
    if (!locale) return this.onDevice((handle, provider) => provider.launchApp(handle, appId, launch));
    if (!/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/.test(locale)) throw new TapdanceError("USAGE", `"${locale}" is not a locale such as de-DE or pt-BR`);
    const { record } = await this.active();
    if (record.handle.platform === "ios") {
      const language = locale.split("-").slice(0, -1).join("-") || locale;
      const args = [...(launch.args ?? []), "-AppleLanguages", `(${locale.includes("-") ? language : locale})`, "-AppleLocale", locale.replace(/-/g, "_")];
      return this.onDevice((handle, provider) => provider.launchApp(handle, appId, { ...launch, args }));
    }
    await this.device({ kind: "app-locale", appId, locale });
    return this.onDevice((handle, provider) => provider.launchApp(handle, appId, { ...launch, relaunch: true }));
  }

  async stopApp(appId: string): Promise<ActionResult> {
    await this.guardHuman();
    return this.onDevice((handle, provider) => provider.stopApp(handle, appId));
  }

  async listApps(): Promise<string[]> {
    return this.onDevice((handle, provider) => provider.listApps(handle));
  }

  // ------------------------------------------------------------ UI

  async inspect(options: { interactiveOnly?: boolean; compact?: boolean; system?: boolean; appId?: string } = {}): Promise<ScreenInspection> {
    const screen = await this.onDevice((handle, provider) =>
      provider.inspect(handle, { ...(options.interactiveOnly !== undefined ? { interactiveOnly: options.interactiveOnly } : {}), ...(options.system ? { system: true } : {}), ...(options.appId ? { appId: options.appId } : {}) }),
    );
    return options.compact ? { ...screen, elements: compactElements(screen.elements) } : screen;
  }

  /**
   * Taps; with `settleMs`, also waits up to that long for the UI to come to rest (a tap that advances to
   * the next screen after an animation) and says whether the screen's content changed, with its first
   * labels, so the agent does not have to inspect again to learn that.
   */
  async tap(target: ElementTarget, options: { settle?: boolean; settleMs?: number; inject?: boolean } = {}): Promise<ActionResult & { screen?: string[] }> {
    await this.guardHuman();
    const tapOptions = { ...(options.settle !== undefined ? { settle: options.settle } : {}), ...(options.inject ? { inject: true } : {}) };
    if (!options.settleMs) return this.onDevice((handle, provider) => provider.tap(handle, target, tapOptions));
    const before = fingerprintOf((await this.inspect({ interactiveOnly: false })).elements);
    const result = await this.onDevice((handle, provider) => provider.tap(handle, target, tapOptions));
    await this.waitFor({ kind: "stable" }, Math.min(options.settleMs, 30_000)).catch(() => undefined);
    const after = await this.inspect({ interactiveOnly: false });
    const changed = fingerprintOf(after.elements) !== before;
    const screen = after.elements.filter((e) => e.label).slice(0, 5).map((e) => e.label!);
    return { ...result, screenChanged: changed || result.screenChanged === true, screen };
  }

  async swipe(
    gesture:
      | { kind: "direction"; direction: SwipeDirection; amount?: number; untilText?: string }
      | { kind: "points"; from: { x: number; y: number }; to: { x: number; y: number } },
  ): Promise<ActionResult> {
    await this.guardHuman();
    return this.onDevice((handle, provider) => provider.swipe(handle, gesture));
  }

  /**
   * Waits for text to appear or go away, or for the UI to settle, for up to 10 minutes. A timeout
   * answers found:false. Long waits run as 30 s waits in a row, so no single backend call runs long.
   */
  async waitFor(condition: WaitCondition, timeoutMs = 10_000): Promise<WaitResult> {
    const total = Math.min(Math.max(timeoutMs, 0), MAX_WAIT_MS);
    const started = Date.now();
    let last: WaitResult = { found: false, waitedMs: 0 };
    do {
      const slice = Math.min(30_000, Math.max(total - (Date.now() - started), 0));
      last = await this.onDevice((handle, provider) => provider.waitFor(handle, condition, slice));
      if (last.found) return { ...last, waitedMs: Date.now() - started };
    } while (Date.now() - started < total);
    return { ...last, waitedMs: Date.now() - started };
  }

  async alert(action: AlertAction): Promise<AlertResult> {
    if (action !== "get") await this.guardHuman();
    return this.onDevice((handle, provider) => provider.alert(handle, action));
  }

  async typeText(text: string, target?: ElementTarget, options: { delayMs?: number } = {}): Promise<ActionResult> {
    await this.guardHuman();
    return this.onDevice((handle, provider) => provider.typeText(handle, text, target, options));
  }

  async pressKey(key: DeviceKey): Promise<ActionResult> {
    await this.guardHuman();
    return this.onDevice((handle, provider) => provider.pressKey(handle, key));
  }

  // ------------------------------------------------------------ evidence

  /** The current screen as PNG bytes, kept nowhere (the viewer's fallback when it cannot decode video). */
  async frame(): Promise<Buffer> {
    return this.onDevice(async (handle, provider) => {
      const dir = await mkdtemp(join(tmpdir(), "tapdance-frame-"));
      try {
        const shot = await provider.screenshot(handle, join(dir, "frame.png"));
        return await readFile(shot.path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  async screenshot(outPath?: string, note?: string): Promise<ArtifactRef> {
    return this.onDevice(async (handle, provider) => {
      const path = await this.artifacts.allocate(this.session.id, "screenshot", "png", outPath);
      const shot = await provider.screenshot(handle, path);
      return this.artifacts.record({ kind: "screenshot", path: shot.path, sessionId: this.session.id, leaseId: handle.leaseId, ...(note ? { note } : {}) });
    });
  }

  async startRecording(outPath?: string): Promise<{ path: string }> {
    return this.onDevice(async (handle, provider, record) => {
      if (record.recording) {
        throw new TapdanceError("USAGE", `A recording is already running (${record.recording.path})`, { hint: "Stop it with `tapdance record stop` (MCP: stop_recording)." });
      }
      const path = await this.artifacts.allocate(this.session.id, "recording", "mp4", outPath);
      const started = await provider.startRecording(handle, path);
      await this.store.update(this.session.id, (r) => ({ ...r, recording: { path: started.path, startedAt: new Date().toISOString(), ...(started.token ? { token: started.token } : {}) } }));
      return started;
    });
  }

  async stopRecording(): Promise<ArtifactRef & { extra: ArtifactRef[]; durationMs?: number }> {
    return this.onDevice(async (handle, provider, record) => {
      if (!record.recording) {
        throw new TapdanceError("USAGE", "No recording is running", { hint: "Start one with `tapdance record start` (MCP: start_recording)." });
      }
      this.progress("Stopping the recording and downloading the video");
      let stopped: Awaited<ReturnType<DeviceProvider["stopRecording"]>>;
      try {
        // Bounded: a stop that hangs (a lost lease, a worker restarting) must come back with a reason.
        stopped = await Promise.race([
          provider.stopRecording(handle, record.recording.token),
          new Promise<never>((_, reject) =>
            // agent-device's own download (90 s), then Tapdance's slower fallback for a large file (#51).
            setTimeout(() => reject(new TapdanceError("TIMEOUT", "Stopping the recording took longer than 32 min", { hint: "Check `tapdance device status`; on a slow link prefer several shorter recordings." })), 32 * 60_000).unref(),
          ),
        ]);
      } catch (error) {
        if (error instanceof TapdanceError && error.code === "LEASE_LOST") throw error;
        // Forget the recording, or start_recording would be refused for the rest of the lease.
        await this.store
          .update(this.session.id, (r) => {
            if (r.handle.leaseId !== handle.leaseId) return undefined;
            const { recording: _, ...rest } = r;
            return rest;
          })
          .catch(() => undefined);
        const e = error instanceof TapdanceError ? error : new TapdanceError("DEVICE_ERROR", `Stopping the recording failed: ${(error as Error).message}`, { cause: error });
        const hint = "The recording could not be stopped cleanly; start a new one with start_recording.";
        throw new TapdanceError(e.code, e.message, {
          hint: e.hint ? `${hint} ${e.hint}` : hint,
          ...(e.details ? { details: e.details } : {}),
          retryable: e.retryable,
          ...(e.retryAfterMs === undefined ? {} : { retryAfterMs: e.retryAfterMs }),
          cause: error,
        });
      }
      await this.store.update(this.session.id, (r) => {
        const { recording: _, ...rest } = r;
        return rest;
      });
      const main = await this.artifacts.record({ kind: "recording", path: stopped.path, sessionId: this.session.id, leaseId: handle.leaseId });
      const extra: ArtifactRef[] = [];
      for (const p of stopped.extraPaths) {
        if (existsSync(p)) extra.push(await this.artifacts.record({ kind: "recording", path: p, sessionId: this.session.id, leaseId: handle.leaseId, note: "continuation chunk" }));
      }
      return { ...main, extra, ...(stopped.durationMs ? { durationMs: stopped.durationMs } : {}) };
    });
  }

  async logs(options: { lines?: number; appId?: string; crash?: boolean } = {}): Promise<LogResult> {
    return this.onDevice(async (handle, provider) => {
      const lines = options.lines ?? 200;
      const result = options.crash
        ? await provider.crashLogs(handle, { lines, ...(options.appId ? { appId: options.appId } : {}) })
        : await provider.logs(handle, { lines, ...(options.appId ? { appId: options.appId } : {}) });
      const path = await this.artifacts.allocate(this.session.id, "log", "txt");
      await writeFile(path, `# ${result.source}\n${result.lines.join("\n")}\n`);
      result.artifact = await this.artifacts.record({ kind: "log", path, sessionId: this.session.id, leaseId: handle.leaseId, note: result.source });
      return result;
    });
  }

  async listArtifacts(): Promise<ArtifactRef[]> {
    return this.artifacts.list(this.session.id);
  }

  // ------------------------------------------------------------ external tools

  /**
   * Runs an external tool from the registry (asc, android, axe, maestro, fastlane, xcodebuild) with
   * the arguments unchanged. Agent calls (`fromAgent`) must be enabled in config, get the tool's own
   * read-only switch unless the user allowed mutation, and lease-scoped tools only ever see the
   * session's device.
   */
  async tool(
    name: string,
    args: string[],
    options: { target?: string; fromAgent?: boolean; allowMutation?: boolean; timeoutMs?: number; cwd?: string; inherit?: boolean } = {},
  ): Promise<ToolRun & { artifact?: ArtifactRef }> {
    const spec = findTool(name);
    const cfg = this.resolved.config.tools;
    const target = options.target ?? "control";
    if (target !== "control") {
      throw new TapdanceError("NOT_SUPPORTED", `Execution target "${target}" is not available yet: tools run on this machine only`, {
        hint: "Remote worker targets need a worker-side executor that Simlock does not provide yet (see STATUS.md). Run Tapdance on the Mac/worker itself meanwhile.",
      });
    }
    if (options.fromAgent && !cfg.mcpEnabled.includes(name)) {
      throw new TapdanceError("FORBIDDEN", `Agents may not run ${name} here`, { hint: `Add "${name}" to tools.mcpEnabled in ~/.tapdance/config.json (\`tapdance config set --global\`) to allow it.` });
    }
    const mutationAuthorized = cfg.allowMutation.includes(name);
    const readOnly = Boolean(options.fromAgent) && !(options.allowMutation && mutationAuthorized);
    if (readOnly && name === "asc") refuseAscEscapes(args);
    if (readOnly && !spec.readOnlyEnv && spec.location === "control") {
      throw new TapdanceError("FORBIDDEN", `${name} has no read-only mode, so agents need your authorization to run it`, {
        hint: `Add "${name}" to tools.allowMutation in ~/.tapdance/config.json (\`tapdance config set --global\`), then call with allow_mutation: true.`,
      });
    }
    if (options.fromAgent && spec.location === "lease") await this.guardHuman();
    let deviceId: string | undefined;
    let adbServerPort: number | undefined;
    let leaseInUse: string | undefined;
    if (spec.location === "lease") {
      const record = await this.store.get(this.session.id);
      if (record) {
        if (spec.platforms && !spec.platforms.includes(record.handle.platform)) {
          throw new TapdanceError("USAGE", `${name} works on ${spec.platforms.join("/")} devices; this session holds ${record.handle.platform}`);
        }
        if (record.handle.location.kind !== "local") {
          throw new TapdanceError("NOT_SUPPORTED", `${name} must run where the device is; this session's device is on a remote worker`, {
            hint: "It would run on this machine, not beside the device. Use Tapdance's device tools, which reach remote workers: set_device_setting, push_file/pull_file, notifications, uninstall_app/clear_app_data, launch_app intent, measure_performance (CLI: tapdance device setting|push|pull|notifications|perf, tapdance app uninstall|clear).",
          });
        }
        deviceId = record.handle.deviceId;
        leaseInUse = record.handle.leaseId;
        // Profile emulators sit on the default adb server; Simlock's own devices on its private one.
        if (record.handle.platform === "android" && record.handle.provider !== PROFILE_PROVIDER) adbServerPort = simlockAdbPort(this.options.env ?? process.env);
      } else if (spec.deviceEnv) {
        // No lease: device-free commands still work, but nothing may reach a device outside a lease.
        deviceId = "tapdance-no-lease";
      }
    }
    const prefix = options.inherit ? undefined : await this.artifacts.allocate(this.session.id, "log", "run");
    // A tool driving the leased device is use: keep the idle release away while it runs.
    let toucher: NodeJS.Timeout | undefined;
    if (leaseInUse !== undefined) {
      await this.touch(leaseInUse);
      toucher = setInterval(() => void this.touch(leaseInUse), 5 * 60_000);
      toucher.unref();
    }
    const run = await runTool(spec, {
      args,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      readOnly,
      ...(deviceId ? { deviceId } : {}),
      ...(adbServerPort ? { adbServerPort } : {}),
      ...(prefix ? { outputPrefix: prefix.replace(/\.run$/, "") } : {}),
      ...(options.inherit ? { inherit: true } : {}),
      ...(cfg.paths[name] ? { executableOverride: cfg.paths[name] } : {}),
    }).finally(() => {
      if (toucher) clearInterval(toucher);
    });
    if (leaseInUse !== undefined) await this.touch(leaseInUse);
    if (run.truncated && run.stdoutPath) {
      const artifact = await this.artifacts.record({ kind: "log", path: run.stdoutPath, sessionId: this.session.id, note: `${name} ${args.slice(0, 3).join(" ")} (full stdout)` });
      return { ...run, artifact };
    }
    return run;
  }

  // ------------------------------------------------------------ viewer

  async viewer(): Promise<{ endpoints: ViewerEndpoints; record: SessionRecord }> {
    return this.onDevice(async (handle, provider, record) => {
      if (!provider.viewer) throw new TapdanceError("NOT_SUPPORTED", `Provider ${provider.name} has no live viewer`);
      return { endpoints: await provider.viewer(handle), record };
    });
  }

  private humanRequestPath(): string {
    return `${this.store.path(this.session.id)}.human-request.json`;
  }

  /** The agent's open request for a person (sign in, approve, set something up), if any. */
  async pendingHumanRequest(): Promise<HumanRequest | undefined> {
    try {
      const r = JSON.parse(await readFile(this.humanRequestPath(), "utf8")) as HumanRequest;
      return r.doneAt ? undefined : r;
    } catch {
      return undefined;
    }
  }

  /** Marks the open request done: the viewer's "Hand back", or `tapdance device done`. */
  async completeHumanRequest(by: string): Promise<boolean> {
    const pending = await this.pendingHumanRequest();
    if (!pending) return false;
    await writeFile(this.humanRequestPath(), JSON.stringify({ ...pending, doneAt: new Date().toISOString(), doneBy: by }), { mode: 0o600 });
    return true;
  }

  /** Withdraws the open request (plans changed); a waiter returns `cancelled: true`. */
  async cancelHumanRequest(by: string): Promise<boolean> {
    const pending = await this.pendingHumanRequest();
    if (!pending) return false;
    await writeFile(this.humanRequestPath(), JSON.stringify({ ...pending, doneAt: new Date().toISOString(), doneBy: by, cancelled: true }), { mode: 0o600 });
    return true;
  }

  /** The latest request for a person, open or answered, if any (for `device status`). */
  async humanRequestState(): Promise<HumanRequest | undefined> {
    try {
      return JSON.parse(await readFile(this.humanRequestPath(), "utf8")) as HumanRequest;
    } catch {
      return undefined;
    }
  }

  /**
   * Opens a request for a person without waiting: the viewer shows it until they hand back. Check it
   * with `humanRequestState()`; `requestHuman` is the blocking form.
   */
  async openHumanRequest(reason: string): Promise<HumanRequest> {
    const { record } = await this.active();
    const request: HumanRequest = { reason: reason.slice(0, 500), requestedAt: new Date().toISOString(), leaseId: record.handle.leaseId };
    await writeFile(this.humanRequestPath(), JSON.stringify(request), { mode: 0o600 });
    this.progress(`Asked a person: ${request.reason}. ${this.handOverHow(record.handle.provider)}`);
    return request;
  }

  private handOverHow(provider: string): string {
    return provider === PROFILE_PROVIDER
      ? "Use the emulator window on the machine running it, then run `tapdance device done`."
      : "Open `tapdance view`, press Take over, do it, then press Hand back (or run `tapdance device done`).";
  }

  /**
   * Asks a person to do something on the device the agent cannot (sign in to a test account, approve
   * a purchase sheet, solve a check) and waits until they say they are done: "Hand back" in the
   * viewer, or `tapdance device done`. A person merely touching the screen does not end the wait.
   */
  async requestHuman(
    reason: string,
    timeoutMs = 10 * 60_000,
    signal?: AbortSignal,
    options: { noteEveryMs?: number } = {},
  ): Promise<{ completed: boolean; cancelled?: boolean; how?: string; waitedMs: number; hint?: string }> {
    const { record } = await this.active();
    const started = Date.now();
    const request: HumanRequest = { reason: reason.slice(0, 500), requestedAt: new Date(started).toISOString(), leaseId: record.handle.leaseId };
    await writeFile(this.humanRequestPath(), JSON.stringify(request), { mode: 0o600 });
    const how = this.handOverHow(record.handle.provider);
    this.progress(`Waiting for a person: ${request.reason}. ${how}`);
    const noteEvery = options.noteEveryMs ?? 15_000;
    let lastNote = Date.now();
    let lastTouch = Date.now();
    try {
      while (Date.now() - started < timeoutMs && !signal?.aborted) {
        const current = JSON.parse(await readFile(this.humanRequestPath(), "utf8").catch(() => "{}")) as Partial<HumanRequest>;
        if (current.doneAt) {
          await this.touch(record.handle.leaseId);
          if (current.cancelled) return { completed: false, cancelled: true, how: current.doneBy ?? "cancelled", waitedMs: Date.now() - started };
          return { completed: true, how: current.doneBy ?? "done", waitedMs: Date.now() - started };
        }
        if (Date.now() - lastNote > noteEvery) {
          // Progress keeps MCP clients that reset their timeout on progress from giving up. The reason
          // was printed once at the start; repeating it only adds noise.
          this.progress(`Still waiting for a person (${Math.round((Date.now() - started) / 1000)} s)`);
          lastNote = Date.now();
        }
        if (Date.now() - lastTouch > 15_000) {
          await this.touch(record.handle.leaseId);
          lastTouch = Date.now();
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return { completed: false, waitedMs: Date.now() - started, hint: `Nobody marked it done. Ask the user: "${request.reason}". ${how} Then call request_human again or continue.` };
    } finally {
      await rm(this.humanRequestPath(), { force: true });
    }
  }

  /** Called by the viewer while a person touches the screen; 0 clears it. */
  async setHumanHold(holdMs: number, by: string): Promise<void> {
    await this.store.setHold(this.session.id, holdMs > 0 ? { until: new Date(Date.now() + holdMs).toISOString(), by } : undefined);
    if (holdMs <= 0) return;
    // A person driving the device is use. Stamp at most every 30 s (the viewer calls this on every
    // touch), and never wait on the session lock: a lease call may hold it for minutes.
    const record = await this.store.get(this.session.id);
    if (record && Date.now() - Date.parse(record.lastUsedAt ?? record.handle.createdAt) > 30_000) void this.touch(record.handle.leaseId);
  }

  async close(): Promise<void> {
    if (this.providerPromise) await (await this.providerPromise.catch(() => undefined))?.close();
  }
}

/**
 * asc commands an agent may not run even read-only: `auth` (other than `auth status`) can print or
 * change credentials, `workflow` runs shell steps, `install-skills` writes into the user's setup.
 * Help (`--help`, `-h`) is always allowed.
 */
function refuseAscEscapes(args: string[]): void {
  if (args.some((a) => a === "--help" || a === "-h")) return;
  const words = args.filter((a) => !a.startsWith("-"));
  const [first, second] = words;
  if (first === "workflow" || first === "install-skills" || (first === "auth" && second !== "status")) {
    throw new TapdanceError("FORBIDDEN", `Agents may not run \`asc ${[first, second].filter(Boolean).join(" ")}\``, {
      hint: "This asc command emits credentials or runs shell steps; run it yourself in a terminal.",
    });
  }
}

/** True only when `pid` is a Tapdance keepalive, so a reused pid is never signalled. */
async function isKeepaliveProcess(pid: number): Promise<boolean> {
  try {
    const { stdout } = await promisify(execFile)("ps", ["-p", String(pid), "-o", "command="]);
    return stdout.includes("__keepalive");
  } catch {
    return false;
  }
}

/** The port of Simlock's private adb server on this machine, which sees Simlock's emulators. */
function simlockAdbPort(env: NodeJS.ProcessEnv): number | undefined {
  try {
    const file = join(env["SIMLOCK_HOME"] ?? join(homedir(), ".simlock"), "adb-server.json");
    const port = (JSON.parse(readFileSync(file, "utf8")) as { port?: unknown }).port;
    return typeof port === "number" ? port : undefined;
  } catch {
    return undefined;
  }
}
