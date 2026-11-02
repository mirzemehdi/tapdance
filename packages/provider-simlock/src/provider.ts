import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createAgentDeviceClient, type AgentDeviceClient } from "agent-device";
import {
  TapdanceError,
  sessionKey,
  type ActionResult,
  type AppInstallResult,
  type CallOptions,
  type DeviceInventory,
  type DeviceKey,
  type DeviceProvider,
  type DoctorCheck,
  type ElementTarget,
  type LeaseHandle,
  type LeaseRequest,
  type LeaseStatus,
  type LogResult,
  type Platform,
  type ScreenInspection,
  type SwipeDirection,
  type UiElement,
  type ViewerEndpoints,
  type WorkerInfo,
  type WaitCondition,
  type WaitResult,
  type AlertAction,
  type AlertResult,
  type DeviceOperation,
  type DeviceOperationResult,
} from "@tapdance/core";
import { runDeviceOperation } from "./device-operations.js";
import { fromAgentDeviceError, STALE_CLAIM_REASON } from "./agent-device-errors.js";
import { releaseStaleDeviceClaims } from "./stale-claims.js";
import * as deviceCommands from "./device-commands.js";
import type { SimlockConnection } from "./connection.js";
import { SimlockHttp, type ExecResult, type SimlockWorker } from "./http.js";
import { AxeBackend } from "./axe.js";

export const PROVIDER_NAME = "simlock";

/** The Simlock release Tapdance is tested against. Each release accepts exactly one protocol version. */
export const TESTED_SIMLOCK_VERSION = "0.4.0";

/** Simlock's agent-device front waits at most this long in the queue (src/agent-device, "Allocate queue wait"). */
const MAX_ALLOCATE_WAIT_MS = 330_000;

export interface SimlockProviderOptions {
  iosBackend?: "agent-device" | "axe";
  axePath?: string;
}

/** What this provider keeps in `LeaseHandle.providerData`. */
interface SimlockLeaseData {
  baseUrl: string;
  agentDeviceSession: string;
  deviceKey: string;
  tenant: string;
  runId: string;
  clientId: string;
}

const APP_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,254}$/;

/**
 * Tapdance's provider for Simlock workers and gateways. Orchestration (queue, leases, workers) is
 * Simlock's; device automation, app upload and artifact download go through agent-device on Simlock's
 * `/v1/agent-device` proxy; a fixed allowlist of `adb`/`simctl` commands goes through Simlock's exec.
 */
export class SimlockProvider implements DeviceProvider {
  readonly name: string = PROVIDER_NAME;
  readonly http: SimlockHttp;
  private readonly clients = new Map<string, AgentDeviceClient>();

  private readonly axe: AxeBackend | undefined;

  constructor(
    readonly connection: SimlockConnection,
    readonly options: SimlockProviderOptions = {},
    fetchImpl: typeof fetch = fetch,
  ) {
    this.http = new SimlockHttp(connection.baseUrl, connection.token, fetchImpl);
    if (options.iosBackend === "axe") this.axe = new AxeBackend(options.axePath);
  }

  /** The AXe backend for this lease, or undefined to use agent-device. */
  private axeFor(handle: LeaseHandle): AxeBackend | undefined {
    if (handle.platform !== "ios" || this.axe === undefined || handle.physical) return undefined;
    if (this.connection.kind !== "local") {
      throw new TapdanceError("NOT_SUPPORTED", "The AXe iOS backend only works when Tapdance runs on the Mac that hosts the simulator", {
        hint: "Set ios.uiBackend to \"agent-device\" for remote Mac workers (it drives the simulator through the gateway).",
      });
    }
    return this.axe;
  }

  // ---------------------------------------------------------------- discovery

  async doctor(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const where = this.connection.kind === "local" ? "local worker" : "gateway/worker";
    let reachable = false;
    const fix = this.connection.kind === "local" ? "Run `tapdance worker start`." : "Check the endpoint, TLS proxy and network path to the gateway.";
    // The first request over a fresh path (MagicDNS, a TLS handshake through `tailscale serve`, a
    // certificate being issued) can take several seconds: one retry before calling it unreachable.
    let failure: Error | undefined;
    for (let attempt = 1; attempt <= 2 && !reachable; attempt++) {
      try {
        const h = await this.http.healthz();
        if (h.ok) {
          reachable = true;
          checks.push({ id: "simlock.reachable", title: `Simlock ${where} reachable`, status: "pass", detail: `${this.connection.baseUrl}/v1/healthz answered in ${h.ms} ms` });
        } else {
          checks.push({ id: "simlock.reachable", title: `Simlock ${where} reachable`, status: "fail", ...describeBadHealth(this.connection.baseUrl, h, fix) });
          return checks;
        }
      } catch (error) {
        failure = error as Error;
      }
    }
    if (!reachable) {
      checks.push({ id: "simlock.reachable", title: `Simlock ${where} reachable`, status: "fail", detail: `${failure?.message ?? "no answer"} (two tries, 15 s each)`, fix });
    }
    if (!reachable) return checks;

    try {
      const who = await this.http.identity();
      checks.push({
        id: "simlock.auth",
        title: "Token accepted",
        status: who.role === "agent" ? "pass" : "warn",
        detail: `role ${who.role}${who.name ? `, label "${who.name}"` : ""}`,
        ...(who.role === "agent" ? {} : { fix: "Use an agent token for agents: mint one on the gateway with `tapdance gateway token --role agent --label <agent>`." }),
      });
    } catch (error) {
      checks.push({ id: "simlock.auth", title: "Token accepted", status: "fail", detail: (error as Error).message, fix: "Run `tapdance config set-token` with a valid agent token." });
      return checks;
    }

    try {
      const status = await this.http.status();
      let caps = new Map((status.capabilities ?? []).map((c) => [c.name, c]));
      // A gateway reports capabilities per worker; take the best state among connected workers.
      if (caps.size === 0 && status.daemon?.mode === "gateway" && this.connection.operatorToken) {
        const workers = (await this.workers().catch(() => [])).filter((w) => w.connection === "connected");
        const rank = (state: string | undefined) => (state === "available" ? 2 : state === undefined ? 0 : 1);
        const merged = new Map<string, { name: string; state: string; reason?: string }>();
        for (const w of workers) {
          for (const [name, state] of Object.entries(w.capabilities)) {
            if (rank(state) > rank(merged.get(name)?.state)) merged.set(name, { name, state, reason: `on ${w.label ?? w.id}` });
          }
        }
        caps = merged;
      }
      const ad = caps.get("agent-device");
      checks.push({
        id: "simlock.agent-device",
        title: "agent-device served by Simlock",
        status: ad?.state === "available" ? "pass" : "fail",
        detail: ad === undefined ? "capability not reported" : `${ad.state}${ad.reason ? `: ${ad.reason}` : ""}`,
        ...(ad?.state === "available"
          ? {}
          : {
              fix: "Run `tapdance worker install` on each worker (it enables the bundled agent-device); on a gateway: `tapdance simlock -- --gateway config set capabilities.agent-device.enabled true`, then restart.",
            }),
      });
      for (const name of ["stream", "input"] as const) {
        const cap = caps.get(name);
        checks.push({
          id: `simlock.${name}`,
          title: name === "stream" ? "Live screen streaming (browser viewer)" : "Remote input (browser viewer)",
          status: cap?.state === "available" ? "pass" : "warn",
          detail: cap === undefined ? "not reported" : `${cap.state}${cap.reason ? `: ${cap.reason}` : ""}`,
          ...(cap?.state === "available"
            ? {}
            : { fix: `\`tapdance worker install\` (or \`tapdance simlock -- --local config set capabilities.${name}.enabled true\`), then \`tapdance worker restart\`.` }),
        });
      }
      for (const platform of ["android", "ios"] as const) {
        const cap = status.capacity?.[platform];
        const limit = cap?.limit ?? 0;
        const tool = status.host?.tools?.find((t) => t.platform === platform);
        checks.push({
          id: `simlock.capacity.${platform}`,
          title: `${platform === "ios" ? "iOS simulators" : "Android emulators"} available`,
          status: limit > 0 ? "pass" : "warn",
          detail:
            limit > 0
              ? `${cap?.running ?? 0}/${limit} running, ${cap?.warm ?? 0} warm${tool ? ` (${tool.name} ${tool.version ?? ""})` : ""}`
              : this.connection.kind === "local"
                ? "this worker cannot run them (see host checks)"
                : "no capacity reported by this endpoint",
        });
      }
      if (status.daemon?.version) {
        const same = status.daemon.version === TESTED_SIMLOCK_VERSION;
        checks.push({
          id: "simlock.version",
          title: "Simlock version",
          status: same ? "pass" : "warn",
          detail: `${status.daemon.version} (${status.daemon.mode ?? "?"} mode); Tapdance is tested with ${TESTED_SIMLOCK_VERSION}`,
          ...(same ? {} : { fix: `Run Simlock ${TESTED_SIMLOCK_VERSION} on the gateway and every worker: each release talks only to its own protocol version.` }),
        });
      }
      if (this.axe) {
        const version = await this.axe.version();
        checks.push({
          id: "ios.axe",
          title: "AXe (iOS UI backend)",
          status: this.connection.kind !== "local" ? "fail" : version ? "pass" : "fail",
          detail: this.connection.kind !== "local" ? "AXe runs only on the Mac that hosts the simulator; this endpoint is remote" : (version ?? "not installed"),
          ...(version && this.connection.kind === "local" ? {} : { fix: this.connection.kind !== "local" ? 'Set ios.uiBackend to "agent-device".' : "brew install cameroncooke/axe/axe" }),
        });
      }
    } catch (error) {
      checks.push({ id: "simlock.status", title: "Simlock status", status: "fail", detail: (error as Error).message });
    }

    if (this.connection.operatorToken) {
      try {
        const workers = await this.workers();
        const online = workers.filter((w) => w.connection === "connected" || w.connection === "self");
        checks.push({
          id: "simlock.workers",
          title: "Workers online",
          status: online.length > 0 ? "pass" : "fail",
          detail: workers.map((w) => `${w.label ?? w.id}: ${w.connection}`).join(", ") || "none",
          ...(online.length > 0 ? {} : { fix: "Start a worker and join it: `echo <join token> | tapdance worker login --gateway wss://… --accept-gateway-exec`." }),
        });
      } catch (error) {
        checks.push({ id: "simlock.workers", title: "Workers online", status: "warn", detail: (error as Error).message });
      }
    } else if (this.connection.kind === "remote") {
      checks.push({
        id: "simlock.workers",
        title: "Workers online",
        status: "skip",
        detail: "needs an operator token to list workers",
        fix: "`tapdance config set-token --operator` (operator token from `tapdance gateway token --role operator --label <name>`).",
      });
    }
    return checks;
  }

  async inventory(filter: { platform?: Platform } = {}): Promise<DeviceInventory> {
    const [status, catalog] = await Promise.all([this.http.status(), this.http.catalog(filter.platform)]);
    const leased = new Set(status.leases.map((l) => l.deviceId));
    const entries = catalog.platforms
      .filter((p): p is typeof p & { platform: Platform } => p.platform === "android" || p.platform === "ios")
      .filter((p) => filter.platform === undefined || p.platform === filter.platform)
      .map((p) => {
        const osVersions = new Set<string>(p.osVersions ?? []);
        const imageTags = new Set<string>(p.imageTags ?? []);
        for (const r of p.runtimes ?? []) {
          if (typeof r === "string") {
            osVersions.add(r);
            continue;
          }
          const v = r.osVersion ?? r.version;
          if (v) osVersions.add(v);
          const tag = r.imageTag ?? r.tag;
          if (tag) imageTags.add(tag);
        }
        // Models with no installed OS image cannot be leased; listing them only invites failed leases.
        const runtimesOf = p.modelRuntimes;
        const models = runtimesOf ? (p.models ?? []).filter((m) => (runtimesOf[m]?.length ?? 1) > 0) : (p.models ?? []);
        return {
          platform: p.platform,
          models,
          osVersions: [...osVersions],
          ...(p.defaultRuntime ? { defaultOsVersion: p.defaultRuntime } : {}),
          ...(imageTags.size > 0 ? { imageTags: [...imageTags] } : {}),
        };
      });
    // Simlock's capacity `used` counts devices that exist (shut-down ones too), not leases: count leases here.
    const platformOf = new Map(status.devices.map((d) => [d.id, d.spec?.platform ?? d.platform]));
    const capacity = (["android", "ios"] as const)
      .filter((p) => filter.platform === undefined || p === filter.platform)
      .map((platform) => {
        const c = status.capacity?.[platform];
        const held = status.leases.filter((l) => l.deviceId !== undefined && platformOf.get(l.deviceId) === platform).length;
        return { platform, running: c?.running ?? 0, limit: c?.limit ?? 0, warm: c?.warm ?? 0, leased: held };
      });
    const devices = status.devices
      .map((d) => {
        const platform = (d.spec?.platform ?? d.platform) as Platform | undefined;
        return {
          id: d.id,
          platform: platform ?? "android",
          model: d.spec?.model ?? "unknown",
          ...(d.spec?.osVersion ? { osVersion: d.spec.osVersion } : {}),
          state: d.state,
          leased: leased.has(d.id) || d.state === "leased",
          ...(d.workerId ? { workerId: d.workerId } : {}),
        };
      })
      .filter((d) => filter.platform === undefined || d.platform === filter.platform);
    const notes: string[] = [];
    for (const c of capacity) {
      if (c.limit === 0) notes.push(`No ${c.platform} capacity on this ${this.connection.kind === "local" ? "machine" : "endpoint"}.`);
    }
    notes.push("Leasing any listed model creates or reuses a clean device; your own AVDs and simulators are never handed out.");
    return { catalog: entries, capacity, devices, queueDepth: status.queueDepth ?? 0, notes };
  }

  async workers(): Promise<WorkerInfo[]> {
    if (!this.connection.operatorToken) {
      if (this.connection.kind === "local") {
        const status = await this.http.status();
        return [
          {
            id: "local",
            label: "this machine",
            connection: "self",
            platforms: (["android", "ios"] as const).map((p) => ({ platform: p, running: status.capacity?.[p]?.running ?? 0, limit: status.capacity?.[p]?.limit ?? 0 })),
            leases: status.leases.length,
            ...(status.host?.os ? { host: `${status.host.os} ${status.host.osVersion ?? ""} ${status.host.arch ?? ""}`.trim() } : {}),
            capabilities: Object.fromEntries((status.capabilities ?? []).map((c) => [c.name, c.state])),
          },
        ];
      }
      throw new TapdanceError("FORBIDDEN", "Listing workers needs an operator token", {
        hint: "Run `tapdance config set-token --operator` with a token from `tapdance gateway token --role operator --label <name>`.",
      });
    }
    const workers = await this.http.workers(this.connection.operatorToken);
    return workers.map(toWorkerInfo);
  }

  // ---------------------------------------------------------------- leases

  private client(data: SimlockLeaseData): AgentDeviceClient {
    let client = this.clients.get(data.agentDeviceSession);
    if (client === undefined) {
      client = createAgentDeviceClient({
        daemonBaseUrl: `${this.connection.baseUrl}/v1/agent-device`,
        daemonAuthToken: this.connection.token,
        daemonTransport: "http",
        daemonLifecycle: "attach",
        leaseProvider: "proxy",
        sessionIsolation: "tenant",
        tenant: data.tenant,
        runId: data.runId,
        clientId: data.clientId,
        session: data.agentDeviceSession,
      } as Parameters<typeof createAgentDeviceClient>[0]);
      this.clients.set(data.agentDeviceSession, client);
    }
    return client;
  }

  private data(handle: LeaseHandle): SimlockLeaseData {
    if (handle.provider !== PROVIDER_NAME) {
      throw new TapdanceError("FORBIDDEN", `Lease ${handle.leaseId} was issued by provider "${handle.provider}", not ${PROVIDER_NAME}`);
    }
    const data = handle.providerData as Partial<SimlockLeaseData>;
    if (!data.agentDeviceSession || !data.deviceKey || !data.tenant || !data.runId || !data.clientId) {
      throw new TapdanceError("LEASE_LOST", "The session record is missing lease details", { hint: "Release and lease again." });
    }
    if (data.baseUrl !== undefined && data.baseUrl !== this.connection.baseUrl) {
      throw new TapdanceError("FORBIDDEN", `This lease belongs to ${data.baseUrl}, but Tapdance is configured for ${this.connection.baseUrl}`, {
        hint: "Switch back to that endpoint to release it, or wait for it to expire.",
      });
    }
    return data as SimlockLeaseData;
  }

  /** Lease-scoped request fields every agent-device call carries. */
  /** The agent-device client for this lease. A subclass may drive devices without Simlock's proxy. */
  protected agentClient(handle: LeaseHandle): AgentDeviceClient {
    return this.client(this.data(handle));
  }

  /** Runs adb/simctl against the leased device (Simlock's lease exec puts the device in). */
  protected execOn(handle: LeaseHandle, tool: "adb" | "simctl", args: string[], timeoutMs?: number, stdin?: string): Promise<ExecResult> {
    return this.http.exec(handle.leaseId, tool, args, timeoutMs, stdin);
  }

  /** True when the devices run on this machine, so host paths are meaningful. */
  protected isLocal(): boolean {
    return this.connection.kind === "local";
  }

  protected scope(handle: LeaseHandle): Record<string, unknown> {
    const d = this.data(handle);
    return { leaseId: handle.leaseId, deviceKey: d.deviceKey, tenant: d.tenant, runId: d.runId, clientId: d.clientId };
  }

  protected selection(handle: LeaseHandle): Record<string, unknown> {
    return handle.platform === "ios" ? { platform: "ios", udid: handle.deviceId } : { platform: "android", serial: handle.deviceId };
  }

  async lease(sessionId: string, request: LeaseRequest, options: CallOptions = {}): Promise<LeaseHandle> {
    // Claims left by a dead worker process block the devices they name; settle them first when the
    // worker runs here (a worker guard does the same for remote agents).
    if (this.isLocal()) await this.settleStaleClaims();
    try {
      return await this.leaseOnce(sessionId, request, options);
    } catch (error) {
      if (!(error instanceof TapdanceError) || error.details?.["reason"] !== STALE_CLAIM_REASON) throw error;
      options.onProgress?.("That device still carried an earlier session's claim; clearing it and leasing again");
      if (this.isLocal()) await this.settleStaleClaims();
      return this.leaseOnce(sessionId, request, options);
    }
  }

  /** Releases claims of dead agent-device processes on this machine; never fails a lease. */
  protected async settleStaleClaims(): Promise<void> {
    await releaseStaleDeviceClaims().catch(() => undefined);
  }

  private async leaseOnce(sessionId: string, request: LeaseRequest, options: CallOptions): Promise<LeaseHandle> {
    const leaseId = randomBytes(16).toString("hex");
    // One agent-device session per lease: a session keeps state on the worker (an unfinished screen
    // recording, a device claim) that a later lease under the same name would otherwise inherit.
    const agentDeviceSession = `td-${sessionKey(sessionId).slice(0, 12)}-${leaseId.slice(0, 12)}`;
    const base = {
      baseUrl: this.connection.baseUrl,
      agentDeviceSession,
      tenant: this.connection.tenant,
      runId: this.connection.runId,
      clientId: this.connection.clientId,
    };
    const client = this.client({ ...base, deviceKey: "" });
    const waitMs = request.waitTimeoutMs === undefined ? undefined : Math.min(request.waitTimeoutMs, MAX_ALLOCATE_WAIT_MS);
    const waitSignal = waitMs ? AbortSignal.timeout(waitMs) : undefined;
    const signal = options.signal && waitSignal ? AbortSignal.any([options.signal, waitSignal]) : (options.signal ?? waitSignal);
    options.onProgress?.(`Requesting ${request.platform}${request.device ? ` "${request.device}"` : ""} from ${this.connection.baseUrl} (queues if busy; a new device can take a few minutes)`);
    let lease;
    try {
      lease = await client.leases.allocate({
        tenant: base.tenant,
        runId: base.runId,
        clientId: base.clientId,
        leaseId,
        platform: request.platform,
        ...(request.device ? { device: request.device } : {}),
        ...(request.osVersion ? { osVersion: request.osVersion } : {}),
        ...(request.imageTag ? { imageTag: request.imageTag } : {}),
        ...(request.physical ? { physical: true } : {}),
        ttlMs: request.ttlMs,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (waitSignal?.aborted) {
        throw new TapdanceError("TIMEOUT", `No device was granted within ${Math.round((waitMs ?? 0) / 1000)} s; nothing was leased`, {
          hint: "Every matching device is busy or still booting. Retry, raise session.leaseWaitSeconds, or ask for another model.",
        });
      }
      throw fromAgentDeviceError(error, "lease");
    }
    const deviceKey = lease.deviceKey ?? "";
    const deviceId = deviceKey.split(":").slice(2).join(":");
    const providerData: SimlockLeaseData = { ...base, deviceKey };
    const now = Date.now();
    const handle: LeaseHandle = {
      provider: PROVIDER_NAME,
      leaseId: lease.leaseId,
      sessionId,
      platform: request.platform,
      model: lease.device?.model ?? request.device ?? "unknown",
      osVersion: lease.device?.osVersion ?? request.osVersion ?? "unknown",
      physical: lease.device?.physical ?? false,
      deviceId,
      location: { kind: this.connection.kind, endpoint: this.connection.baseUrl },
      ttlMs: request.ttlMs,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + request.ttlMs).toISOString(),
      providerData: { ...providerData },
    };
    try {
      const detail = await this.http.lease(handle.leaseId);
      if (detail?.worker?.id) handle.location.workerId = detail.worker.id;
      if (detail?.worker?.label) handle.location.workerLabel = detail.worker.label;
      if (detail?.expiresAt) handle.expiresAt = detail.expiresAt;
    } catch {
      // Worker details are a courtesy; the lease stands without them.
    }
    options.onProgress?.(`Granted ${handle.model} (${handle.platform} ${handle.osVersion}); attaching automation session`);
    try {
      await client.apps.open({ ...this.selection(handle), ...this.scope(handle) } as never);
    } catch (error) {
      await this.release(handle).catch(() => undefined);
      throw fromAgentDeviceError(error, "open device session");
    }
    return handle;
  }

  async status(handle: LeaseHandle): Promise<LeaseStatus> {
    this.data(handle);
    const lease = await this.http.lease(handle.leaseId);
    if (lease === undefined) {
      // Right after a worker restarts, a gateway hides its leases for up to about a minute; a lease
      // that has not reached its deadline may still stand.
      if (this.connection.kind === "remote" && Date.parse(handle.expiresAt) > Date.now()) {
        return { state: "unknown", handle, endReason: "The gateway does not list this lease right now (its worker may be restarting or offline); retry in a minute" };
      }
      return { state: "ended", handle, endReason: "Simlock no longer knows this lease (released, expired, or ended by an operator)" };
    }
    return { state: "active", handle, ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {}) };
  }

  async renew(handle: LeaseHandle, ttlMs = handle.ttlMs): Promise<LeaseStatus> {
    try {
      const lease = await this.agentClient(handle).leases.heartbeat({ ...this.scope(handle), ttlMs } as never);
      void lease;
    } catch (error) {
      throw fromAgentDeviceError(error, "renew");
    }
    return this.status(handle);
  }

  async release(handle: LeaseHandle): Promise<{ released: boolean; unreachable?: boolean }> {
    const client = this.agentClient(handle);
    let released = false;
    let unreachable = 0;
    const isUnreachable = (error: unknown) => ["PROVIDER_UNREACHABLE", "WORKER_OFFLINE"].includes(fromAgentDeviceError(error, "release").code);
    // `close` ends the agent-device session and, with it, the Simlock lease; `release` covers a
    // session that never opened. Either answering "not active" means it is already gone.
    try {
      await client.sessions.close({ ...this.scope(handle) } as never);
      released = true;
    } catch (error) {
      if (isUnreachable(error)) unreachable++;
    }
    try {
      const result = await client.leases.release({ ...this.scope(handle) } as never);
      released = released || result.released;
    } catch (error) {
      if (isUnreachable(error)) unreachable++;
    }
    this.clients.delete(this.data(handle).agentDeviceSession);
    return { released, ...(unreachable === 2 ? { unreachable: true } : {}) };
  }

  // ---------------------------------------------------------------- apps

  async installApp(handle: LeaseHandle, appPath: string, options: CallOptions & { appId?: string } = {}): Promise<AppInstallResult> {
    const path = validateAppPath(appPath, handle.platform, handle.physical);
    options.onProgress?.(`Uploading ${path} to the worker and installing`);
    try {
      const result = await this.agentClient(handle).apps.install({
        appPath: path,
        ...(options.appId ? { app: options.appId } : {}),
        ...this.scope(handle),
      } as never);
      let appId = result.appId ?? result.bundleId ?? result.package ?? (result.app && result.app !== path ? result.app : undefined);
      // Without an id the agent cannot launch what it just installed; an iOS bundle names itself.
      if (!appId && handle.platform === "ios") appId = await bundleIdOf(path);
      return { path, platform: handle.platform, ...(appId ? { appId } : {}) };
    } catch (error) {
      throw fromAgentDeviceError(error, "install");
    }
  }

  async launchApp(handle: LeaseHandle, appId: string, options: { relaunch?: boolean; url?: string; args?: string[] } = {}): Promise<ActionResult> {
    checkAppId(appId);
    if (options.args?.some((a) => typeof a !== "string" || a.length > 1024 || a.includes("\u0000"))) throw new TapdanceError("USAGE", "Launch arguments must be short plain strings");
    try {
      await this.agentClient(handle).apps.open({
        app: appId,
        ...(options.url ? { url: options.url } : {}),
        ...(options.relaunch || options.args?.length ? { relaunch: true } : {}),
        ...(options.args?.length ? { launchArgs: options.args } : {}),
        ...this.selection(handle),
        ...this.scope(handle),
      } as never);
      return { ok: true, message: `Launched ${appId}` };
    } catch (error) {
      throw fromAgentDeviceError(error, `launch ${appId}`);
    }
  }

  async stopApp(handle: LeaseHandle, appId: string): Promise<ActionResult> {
    checkAppId(appId);
    const result =
      handle.platform === "android"
        ? await this.execOn(handle, "adb", ["shell", "am", "force-stop", appId])
        : await this.execOn(handle, "simctl", ["terminate", appId]);
    if (result.exitCode !== 0 && !/not running|found nothing to terminate/i.test(result.stderr)) {
      throw new TapdanceError("DEVICE_ERROR", `Stopping ${appId} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    return { ok: true, message: `Stopped ${appId}` };
  }

  async listApps(handle: LeaseHandle): Promise<string[]> {
    try {
      return await this.agentClient(handle).apps.list({ ...this.scope(handle) } as never);
    } catch (error) {
      throw fromAgentDeviceError(error, "list apps");
    }
  }

  // ---------------------------------------------------------------- UI

  async inspect(handle: LeaseHandle, options: { interactiveOnly?: boolean } = {}): Promise<ScreenInspection> {
    const axe = this.axeFor(handle);
    if (axe) return axe.inspect(handle.deviceId, options.interactiveOnly ?? true);
    try {
      const snap = await this.agentClient(handle).capture.snapshot({
        interactiveOnly: options.interactiveOnly ?? true,
        ...this.scope(handle),
      } as never);
      const raw = snap as unknown as {
        nodes?: Array<Record<string, unknown>>;
        truncated?: boolean;
        appBundleId?: string;
        appName?: string;
        viewport?: { width?: number; height?: number };
        warnings?: unknown[];
        refsGeneration?: unknown;
      };
      // Refs pinned to this snapshot (`@e7~s4`): agent-device then refuses one the screen has
      // since replaced instead of acting on whatever element now has that number.
      const generation = typeof raw.refsGeneration === "number" && Number.isInteger(raw.refsGeneration) ? raw.refsGeneration : undefined;
      return {
        ...(raw.appBundleId ?? raw.appName ? { app: (raw.appBundleId ?? raw.appName) as string } : {}),
        ...(raw.viewport?.width && raw.viewport.height ? { viewport: { width: raw.viewport.width, height: raw.viewport.height } } : {}),
        elements: (raw.nodes ?? []).map((node) => pinRef(toUiElement(node), generation)),
        truncated: raw.truncated ?? false,
        warnings: (raw.warnings ?? []).map((w) => (typeof w === "string" ? w : JSON.stringify(w))),
      };
    } catch (error) {
      throw fromAgentDeviceError(error, "inspect");
    }
  }

  async tap(handle: LeaseHandle, target: ElementTarget, options: { settle?: boolean; inject?: boolean } = {}): Promise<ActionResult> {
    const axe = this.axeFor(handle);
    if (axe) return axe.tap(handle.deviceId, target);
    if (options.inject) {
      if (handle.platform !== "android") throw new TapdanceError("NOT_SUPPORTED", "Raw input taps are for Android; iOS taps already go through the simulator's own input");
      return this.rawTap(handle, target.kind === "point" ? { x: target.x, y: target.y } : await this.centerOf(handle, target), target);
    }
    let out: ActionResult;
    try {
      const result = (await this.agentClient(handle).interactions.press({
        ...toAgentDeviceTarget(target),
        ...(options.settle === false ? {} : { settle: true }),
        ...this.scope(handle),
      } as never)) as unknown as { message?: string; x?: number; y?: number; settle?: { diff?: unknown } };
      out = actionResult(result, `Tapped ${describe(target)}`);
    } catch (error) {
      throw fromAgentDeviceError(error, `tap ${describe(target)}`);
    }
    // Some system surfaces (the file picker, the share sheet) drop the automation helper's touch
    // events while `adb shell input tap` works. When a settled tap changed nothing there, repeat it
    // as a raw input event. Elsewhere a tap that changes nothing (a piano key) is left alone.
    const unchanged = options.settle !== false && !out.screenChanged && (out.changes ?? []).every((c) => c.startsWith("="));
    if (handle.platform === "android" && unchanged && out.point && RAW_INPUT_APPS.has((await this.focusedApp(handle)) ?? "")) {
      const raw = await this.rawTap(handle, { x: Math.round(out.point.x), y: Math.round(out.point.y) }, target);
      return { ...raw, warning: "This system screen ignored the first tap; it was repeated as a raw input event" };
    }
    return out;
  }

  /** Taps through Android's input service (`adb shell input tap`), like a finger would. */
  private async rawTap(handle: LeaseHandle, point: { x: number; y: number }, target: ElementTarget): Promise<ActionResult> {
    const cmd = deviceCommands.android.inputTap(Math.round(point.x), Math.round(point.y));
    const r = await this.execOn(handle, "adb", cmd.args, 15_000);
    if (r.exitCode !== 0) throw new TapdanceError("DEVICE_ERROR", `Raw tap at (${point.x}, ${point.y}) failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    return { ok: true, message: `Tapped ${describe(target)} at (${Math.round(point.x)}, ${Math.round(point.y)}) with a raw input event`, point };
  }

  /** The centre of the element `target` names, from a fresh snapshot. */
  private async centerOf(handle: LeaseHandle, target: Exclude<ElementTarget, { kind: "point" }>): Promise<{ x: number; y: number }> {
    const { elements } = await this.inspect(handle, { interactiveOnly: false });
    const match = elements.find((e) => matchesTarget(e, target)) ?? (target.kind === "text" ? elements.find((e) => (e.label ?? e.value ?? "").toLowerCase().includes(target.text.toLowerCase())) : undefined);
    if (!match?.rect) {
      throw new TapdanceError("ELEMENT_NOT_FOUND", `No element with bounds matches ${describe(target)}`, { hint: "Run `tapdance ui inspect --bounds` and tap by coordinates (--x/--y)." });
    }
    return { x: Math.round(match.rect.x + match.rect.width / 2), y: Math.round(match.rect.y + match.rect.height / 2) };
  }

  /** The package of the focused Android window, from the window manager. */
  private async focusedApp(handle: LeaseHandle): Promise<string | undefined> {
    const cmd = deviceCommands.android.focusedWindow();
    const r = await this.execOn(handle, "adb", cmd.args, 10_000).catch(() => undefined);
    return r ? focusedPackage(r.stdout) : undefined;
  }

  async swipe(
    handle: LeaseHandle,
    gesture:
      | { kind: "direction"; direction: SwipeDirection; amount?: number; untilText?: string }
      | { kind: "points"; from: { x: number; y: number }; to: { x: number; y: number } },
  ): Promise<ActionResult> {
    const axe = this.axeFor(handle);
    if (axe) return axe.swipe(handle.deviceId, gesture);
    const client = this.agentClient(handle);
    try {
      if (gesture.kind === "points") {
        const result = await client.interactions.swipe({ from: gesture.from, to: gesture.to, ...this.scope(handle) } as never);
        return actionResult(result as never, `Swiped (${gesture.from.x},${gesture.from.y}) → (${gesture.to.x},${gesture.to.y})`);
      }
      // A finger swiping up moves the content down: Tapdance speaks in finger directions.
      const scroll: Record<SwipeDirection, string> = { up: "down", down: "up", left: "right", right: "left" };
      if (gesture.untilText) return await this.swipeUntil(handle, scroll[gesture.direction], gesture.direction, gesture.untilText, gesture.amount);
      const result = await client.interactions.scroll({
        direction: scroll[gesture.direction],
        ...(gesture.amount === undefined ? {} : { amount: gesture.amount }),
        settle: true,
        ...this.scope(handle),
      } as never);
      return actionResult(result as never, `Swiped ${gesture.direction}`);
    } catch (error) {
      throw fromAgentDeviceError(error, "swipe");
    }
  }

  /**
   * Scrolls one pass at a time until an element whose label or value contains `text` (any case) is on
   * screen. A list row often merges several texts into one label ("Fantaisie-Impromptu, Chopin, 3:45"),
   * which an exact selector misses. Stops at the end of the list (a pass that changes nothing).
   */
  private async swipeUntil(handle: LeaseHandle, direction: string, finger: SwipeDirection, text: string, amount: number | undefined): Promise<ActionResult> {
    const client = this.agentClient(handle);
    const needle = text.toLowerCase();
    const find = (elements: UiElement[]) => elements.find((e) => [e.label, e.value, e.identifier].some((v) => v?.toLowerCase().includes(needle)));
    let screen = await this.inspect(handle, { interactiveOnly: false });
    let passes = 0;
    for (; passes <= MAX_SWIPE_PASSES; passes++) {
      const hit = find(screen.elements);
      if (hit) return { ok: true, message: `Found "${hit.label ?? hit.value ?? text}" after ${passes} swipe(s) ${finger}`, ...(hit.rect ? { point: { x: hit.rect.x + Math.round(hit.rect.width / 2), y: hit.rect.y + Math.round(hit.rect.height / 2) } } : {}) };
      if (passes === MAX_SWIPE_PASSES) break;
      const before = screenFingerprint(screen.elements);
      await client.interactions.scroll({ direction, ...(amount === undefined ? {} : { amount }), settle: true, ...this.scope(handle) } as never);
      screen = await this.inspect(handle, { interactiveOnly: false });
      if (screenFingerprint(screen.elements) === before && !find(screen.elements)) {
        throw new TapdanceError("ELEMENT_NOT_FOUND", `Reached the end of the list after ${passes + 1} swipe(s) ${finger} without finding "${text}"`, { hint: "Swipe the other way, or check the text with `tapdance ui inspect --all`." });
      }
    }
    throw new TapdanceError("ELEMENT_NOT_FOUND", `"${text}" did not appear within ${MAX_SWIPE_PASSES} swipes ${finger}`, { hint: "Check the text with `tapdance ui inspect --all`; it matches any part of a label or value." });
  }

  async waitFor(handle: LeaseHandle, condition: WaitCondition, timeoutMs: number): Promise<WaitResult> {
    const started = Date.now();
    if (condition.kind === "stable") return this.waitStable(handle, started, timeoutMs);
    const axe = this.axeFor(handle);
    if (axe) {
      // AXe has no wait: poll its tree.
      for (;;) {
        const elements = await axe.describe(handle.deviceId);
        const seen = elements.some((e) => e.label === condition.text || e.value === condition.text);
        const done = condition.kind === "absent" ? !seen : seen;
        if (done) return { found: true, waitedMs: Date.now() - started };
        if (Date.now() - started > timeoutMs) return { found: false, waitedMs: Date.now() - started };
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const command = this.agentClient(handle).command as unknown as { wait: (o: unknown) => Promise<{ waitedMs?: number; hint?: string }> };
    const target =
      condition.kind === "text" ? { text: condition.text } : condition.kind === "absent" ? { absent: textSelector(condition.text) } : { stable: true };
    try {
      const r = await command.wait({ ...target, timeoutMs, ...this.scope(handle) });
      return { found: true, waitedMs: r.waitedMs ?? Date.now() - started, ...(r.hint ? { hint: r.hint } : {}) };
    } catch (error) {
      const mapped = fromAgentDeviceError(error, "wait");
      if (mapped.code === "TIMEOUT" || mapped.code === "ELEMENT_NOT_FOUND" || /timed? ?out/i.test(mapped.message)) {
        return { found: false, waitedMs: Date.now() - started };
      }
      throw mapped;
    }
  }

  /**
   * Stable = the screen's content (roles, labels, ids, values, states) did not change for a quiet
   * window. Positions are left out, so an animated background or a moving shimmer does not count as
   * change. Implemented here rather than with the backend's own stable wait, which some devices refuse.
   */
  private async waitStable(handle: LeaseHandle, started: number, timeoutMs: number, quietMs = 1000): Promise<WaitResult> {
    let last = "";
    let sameSince = Date.now();
    for (;;) {
      const screen = await this.inspect(handle, { interactiveOnly: false });
      const fingerprint = screenFingerprint(screen.elements);
      const now = Date.now();
      if (fingerprint !== last) {
        last = fingerprint;
        sameSince = now;
      } else if (now - sameSince >= quietMs) {
        return { found: true, waitedMs: now - started };
      }
      if (now - started >= timeoutMs) return { found: false, waitedMs: now - started, hint: `The UI was still changing after ${timeoutMs} ms` };
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async alert(handle: LeaseHandle, action: AlertAction): Promise<AlertResult> {
    if (this.axeFor(handle)) {
      throw new TapdanceError("NOT_SUPPORTED", "The AXe backend has no alert handling", { hint: "Tap the alert's button by its label instead." });
    }
    const command = this.agentClient(handle).command as unknown as { alert: (o: unknown) => Promise<Record<string, unknown>> };
    try {
      const r = await command.alert({ action, ...this.scope(handle) });
      const alert = (r["alert"] ?? r) as Record<string, unknown>;
      const buttons = Array.isArray(alert["buttons"]) ? (alert["buttons"] as unknown[]).map((b) => (typeof b === "string" ? b : String((b as { label?: unknown }).label ?? b))) : undefined;
      return {
        present: alert["present"] !== false && (alert["title"] !== undefined || buttons !== undefined || action !== "get"),
        ...(typeof alert["title"] === "string" ? { title: alert["title"] } : {}),
        ...(typeof alert["message"] === "string" ? { message: alert["message"] } : {}),
        ...(buttons ? { buttons } : {}),
        ...(typeof r["button"] === "string" ? { acted: r["button"] } : action !== "get" ? { acted: action } : {}),
      };
    } catch (error) {
      const mapped = fromAgentDeviceError(error, `alert ${action}`);
      if (/alert not found|no (active |visible )?alert|ALERT_NOT_FOUND/i.test(mapped.message) || mapped.details?.["backendCode"] === "ALERT_NOT_FOUND") return { present: false };
      throw mapped;
    }
  }

  async typeText(handle: LeaseHandle, text: string, target?: ElementTarget): Promise<ActionResult> {
    const axe = this.axeFor(handle);
    if (axe) return axe.type(handle.deviceId, text, target);
    const client = this.agentClient(handle);
    try {
      if (target !== undefined) {
        const result = await client.interactions.fill({ ...toAgentDeviceTarget(target), text, settle: true, ...this.scope(handle) } as never);
        return actionResult(result as never, `Filled ${describe(target)}`);
      }
      const result = await client.interactions.type({ text, ...this.scope(handle) } as never);
      return actionResult(result as never, `Typed ${text.length} characters`);
    } catch (error) {
      const mapped = fromAgentDeviceError(error, "type");
      if (mapped.code === "ELEMENT_NOT_FOUND" && target === undefined) {
        throw new TapdanceError("ELEMENT_NOT_FOUND", "No text field has focus", {
          hint: "Tap the field first, or pass a target so Tapdance fills that field.",
        });
      }
      throw mapped;
    }
  }

  async pressKey(handle: LeaseHandle, key: DeviceKey): Promise<ActionResult> {
    const axe = this.axeFor(handle);
    if (axe && key === "home") return axe.button(handle.deviceId, "home");
    const command = this.agentClient(handle).command as unknown as Record<string, (o: unknown) => Promise<unknown>>;
    const scope = this.scope(handle);
    const call: Record<DeviceKey, () => Promise<unknown>> = {
      back: () => command["back"]!({ ...scope, settle: true }),
      home: () => command["home"]!({ ...scope }),
      enter: () => command["keyboard"]!({ ...scope, action: "enter" }),
      dismiss_keyboard: () => command["keyboard"]!({ ...scope, action: "dismiss" }),
      app_switcher: () => command["appSwitcher"]!({ ...scope }),
    };
    try {
      const result = await call[key]();
      return actionResult(result as never, `Pressed ${key}`);
    } catch (error) {
      throw fromAgentDeviceError(error, `press ${key}`);
    }
  }

  // ---------------------------------------------------------------- evidence

  async screenshot(handle: LeaseHandle, outPath: string): Promise<{ path: string; width?: number; height?: number }> {
    const axe = this.axeFor(handle);
    if (axe) return axe.screenshot(handle.deviceId, resolve(outPath));
    try {
      const result = await this.agentClient(handle).capture.screenshot({ path: resolve(outPath), ...this.scope(handle) } as never);
      return { path: result.path, ...(result.width ? { width: result.width } : {}), ...(result.height ? { height: result.height } : {}) };
    } catch (error) {
      throw fromAgentDeviceError(error, "screenshot");
    }
  }

  async startRecording(handle: LeaseHandle, outPath: string): Promise<{ path: string; token?: Record<string, unknown> }> {
    const axe = this.axeFor(handle);
    if (axe) {
      const { pid } = axe.startRecording(handle.deviceId, resolve(outPath));
      return { path: resolve(outPath), token: { backend: "axe", pid, path: resolve(outPath) } };
    }
    const client = this.agentClient(handle);
    const base = { action: "start", path: resolve(outPath), ...this.scope(handle) };
    try {
      const result = (await client.recording.record(base as never)) as { outPath?: string };
      return { path: result.outPath ?? resolve(outPath) };
    } catch (error) {
      // App-scoped recording needs an app in the foreground; fall back to the whole screen.
      try {
        const result = (await client.recording.record({ ...base, recordingScope: "device" } as never)) as { outPath?: string };
        return { path: result.outPath ?? resolve(outPath) };
      } catch {
        throw fromAgentDeviceError(error, "start recording");
      }
    }
  }

  async stopRecording(handle: LeaseHandle, token?: Record<string, unknown>): Promise<{ path: string; durationMs?: number; extraPaths: string[] }> {
    if (token?.["backend"] === "axe" && typeof token["pid"] === "number" && this.axe) {
      const path = typeof token["path"] === "string" ? token["path"] : undefined;
      const stopped = await this.axe.stopRecording(token["pid"], path ?? "");
      return { path: stopped.path, extraPaths: [] };
    }
    try {
      const result = (await this.agentClient(handle).recording.record({ action: "stop", ...this.scope(handle) } as never)) as {
        outPath: string;
        durationMs?: number;
        chunks?: Array<{ path: string }>;
        warning?: string;
      };
      const extra = (result.chunks ?? []).map((c) => c.path).filter((p) => p !== result.outPath);
      return { path: result.outPath, ...(result.durationMs ? { durationMs: result.durationMs } : {}), extraPaths: extra };
    } catch (error) {
      throw fromAgentDeviceError(error, "stop recording");
    }
  }

  async logs(handle: LeaseHandle, options: { lines: number; appId?: string }): Promise<LogResult> {
    const lines = clampLines(options.lines);
    if (options.appId !== undefined) checkAppId(options.appId);
    if (handle.platform === "android") {
      const args = ["logcat", "-d", "-v", "threadtime", "-t", String(lines)];
      let unfiltered = false;
      if (options.appId) {
        const pid = (await this.execOn(handle, "adb", ["shell", "pidof", options.appId])).stdout.trim().split(/\s+/)[0];
        if (pid && /^\d+$/.test(pid)) args.push(`--pid=${pid}`);
        else unfiltered = true;
      }
      const result = await this.execOn(handle, "adb", args);
      const out = toLogResult(unfiltered ? "logcat (all processes)" : "logcat", result.stdout, lines);
      if (unfiltered) out.lines.push(`Note: ${options.appId} is not running, so these lines are not filtered to it. Launch the app and fetch logs again.`);
      return out;
    }
    const args = ["spawn", "log", "show", "--last", "3m", "--style", "compact"];
    if (options.appId) args.push("--predicate", `subsystem BEGINSWITH "${options.appId}" OR process == "${options.appId.split(".").at(-1)}"`);
    const result = await this.execOn(handle, "simctl", args, 180_000);
    return toLogResult("simulator log (last 3 min)", result.stdout, lines);
  }

  async crashLogs(handle: LeaseHandle, options: { lines: number; appId?: string }): Promise<LogResult> {
    const lines = clampLines(options.lines);
    if (options.appId !== undefined) checkAppId(options.appId);
    if (handle.platform === "android") {
      const result = await this.execOn(handle, "adb", ["logcat", "-d", "-b", "crash", "-v", "threadtime", "-t", String(lines)]);
      return toLogResult("logcat crash buffer", result.stdout, lines);
    }
    const predicate = options.appId
      ? `(messageType == fault OR eventMessage CONTAINS[c] "crash" OR eventMessage CONTAINS[c] "terminat") AND (subsystem BEGINSWITH "${options.appId}" OR process == "${options.appId.split(".").at(-1)}" OR eventMessage CONTAINS "${options.appId}")`
      : `messageType == fault OR eventMessage CONTAINS[c] "crash"`;
    const result = await this.execOn(handle, "simctl", ["spawn", "log", "show", "--last", "10m", "--style", "compact", "--predicate", predicate], 180_000);
    const out = toLogResult("simulator faults and crash messages (last 10 min)", result.stdout, lines);
    out.lines.push("Note: full iOS crash reports (.ips) stay on the worker in ~/Library/Logs/DiagnosticReports.");
    return out;
  }

  async device(handle: LeaseHandle, operation: DeviceOperation): Promise<DeviceOperationResult> {
    return runDeviceOperation(
      {
        client: this.agentClient(handle),
        scope: { ...this.selection(handle), ...this.scope(handle) },
        exec: (command, timeoutMs) => this.execOn(handle, command.tool, command.args, timeoutMs, command.stdin),
        local: this.isLocal(),
        ...(this.isLocal() ? {} : { remoteFiles: { put: (q, bytes) => this.http.putFile(handle.leaseId, q, bytes), get: (q) => this.http.getFile(handle.leaseId, q) } }),
      },
      handle,
      operation,
    );
  }

  async viewer(handle: LeaseHandle): Promise<ViewerEndpoints> {
    this.data(handle);
    const ws = this.connection.baseUrl.replace(/^http/, "ws");
    return {
      streamUrl: `${this.connection.baseUrl}/v1/leases/${encodeURIComponent(handle.leaseId)}/stream`,
      inputUrl: `${ws}/v1/leases/${encodeURIComponent(handle.leaseId)}/input`,
      headers: this.http.authHeaders(),
    };
  }

  async close(): Promise<void> {
    this.clients.clear();
  }
}

// ---------------------------------------------------------------- helpers

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function textSelector(text: string): string {
  return `label=${quote(text)} || text=${quote(text)} || value=${quote(text)}`;
}

export function toAgentDeviceTarget(target: ElementTarget): Record<string, unknown> {
  switch (target.kind) {
    case "text":
      return { selector: textSelector(target.text) };
    case "id":
      return { selector: `id=${quote(target.id)}` };
    case "ref":
      return { ref: `@${target.ref.replace(/^@/, "")}` };
    case "selector":
      return { selector: target.selector };
    case "point":
      return { x: Math.round(target.x), y: Math.round(target.y) };
  }
}

function describe(target: ElementTarget): string {
  switch (target.kind) {
    case "text":
      return `"${target.text}"`;
    case "id":
      return `id=${target.id}`;
    case "ref":
      return `@${target.ref}`;
    case "selector":
      return target.selector;
    case "point":
      return `(${target.x}, ${target.y})`;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

const NEW_SCREEN_HINT = "New screen: call inspect_screen before targeting refs.";

/**
 * An agent-device interaction reply, reduced to what the next step needs: what changed, whether the
 * screen was replaced, how the target was resolved, what is still tappable, and whether a fill took.
 */
export function actionResult(result: unknown, fallback: string): ActionResult {
  const r = asRecord(result);
  const out: ActionResult = { ok: true, message: asText(r["message"]) ?? fallback };
  if (typeof r["x"] === "number" && typeof r["y"] === "number") out.point = { x: r["x"], y: r["y"] };
  const settle = asRecord(r["settle"]);
  if (settle["diff"] !== undefined) out.changes = summarizeDiff(settle["diff"]);
  const hints: string[] = [];
  const warnings: string[] = [];
  const surface = asRecord(settle["surfaceChange"] ?? asRecord(r["evidence"])["surfaceChange"]);
  if (Object.keys(surface).length > 0) {
    out.screenChanged = true;
    hints.push(NEW_SCREEN_HINT);
    const disclosure = asText(surface["disclosure"]);
    if (disclosure) warnings.push(disclosure);
  }
  const warning = asText(r["warning"]);
  if (warning) warnings.push(warning);
  for (const h of [asText(r["hint"]), asText(settle["hint"])]) if (h && !hints.includes(h)) hints.push(h);

  const resolution = asRecord(r["resolution"]);
  if (resolution["kind"] === "label-fallback" || resolution["kind"] === "disambiguated") {
    out.resolvedBy = resolution["kind"];
    const alternatives = (Array.isArray(resolution["alternatives"]) ? resolution["alternatives"] : [])
      .map((a) => {
        const entry = asRecord(a);
        return asText(entry["label"]) ?? asText(entry["role"]) ?? asText(entry["diagnosticRef"]);
      })
      .filter((label): label is string => label !== undefined)
      .slice(0, 5);
    if (alternatives.length > 0) out.alternatives = alternatives;
    if (resolution["kind"] === "label-fallback") warnings.push("That ref was stale; agent-device matched it by its label instead. Inspect again before reusing refs.");
  }

  if (Array.isArray(settle["tail"])) {
    const still = settle["tail"]
      .map((t) => {
        const entry = asRecord(t);
        const ref = asText(entry["ref"]);
        if (!ref) return undefined;
        const label = asText(entry["label"]);
        return `@${ref.replace(/^@/, "")} [${asText(entry["role"]) ?? "element"}]${label ? ` "${label}"` : ""}`;
      })
      .filter((line): line is string => line !== undefined);
    if (still.length > 0) out.stillOnScreen = still.slice(0, MAX_DIFF_LINES);
  }

  if (r["verification"] === "unconfirmed") {
    out.typed = "unconfirmed";
    const after = typeof r["after"] === "string" ? r["after"] : undefined;
    if (after !== undefined) out.fieldNow = after;
    warnings.push(`The field could not be read back with the requested text${after !== undefined ? `; it shows "${after}"` : ""}. Check it before submitting.`);
  } else if (r["verification"] === "confirmed") {
    out.typed = "confirmed";
  }
  if (warnings.length > 0) out.warning = warnings.join(" ");
  if (hints.length > 0) out.hint = hints.join(" ");
  return out;
}

/** Pins a plain agent-device ref to the snapshot generation it came from. */
function pinRef(element: UiElement, generation: number | undefined): UiElement {
  if (generation === undefined || !/^@e\d+$/.test(element.ref)) return element;
  return { ...element, ref: `${element.ref}~s${generation}` };
}

/**
 * The bundle id of a simulator .app, read from its Info.plist: XML plists directly, binary ones
 * through `plutil` when the machine has it. Undefined when it cannot be read.
 */
export async function bundleIdOf(appPath: string): Promise<string | undefined> {
  const plist = join(appPath, "Info.plist");
  let data: Buffer;
  try {
    if (!statSync(appPath).isDirectory()) return undefined;
    data = await readFile(plist);
  } catch {
    return undefined;
  }
  let id: string | undefined;
  if (data.subarray(0, 6).toString("latin1") === "bplist") {
    try {
      const { stdout } = await promisify(execFile)("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist], { timeout: 10_000 });
      id = stdout.trim();
    } catch {
      return undefined;
    }
  } else {
    id = /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/.exec(data.toString("utf8"))?.[1];
  }
  return id !== undefined && APP_ID.test(id) ? id : undefined;
}

const MAX_DIFF_LINES = 30;

/**
 * agent-device's settle diff, flattened to short lines an agent can read cheaply:
 * `+ @e7 [text-field] "Email"` for what appeared, `- …` for what went away. Additions come first
 * because they hold the refs the next action needs.
 */
export function summarizeDiff(diff: unknown): string[] {
  let entries: unknown[] = [];
  if (typeof diff === "string") entries = diff.split("\n").filter(Boolean);
  else if (Array.isArray(diff)) entries = diff;
  else if (diff !== null && typeof diff === "object") {
    const lines = (diff as { lines?: unknown }).lines;
    entries = Array.isArray(lines) ? lines : [JSON.stringify(diff).slice(0, 2000)];
  }
  const line = (d: unknown): { added: boolean; text: string } => {
    if (typeof d === "string") return { added: d.startsWith("+"), text: d };
    const e = d as { kind?: string; text?: string };
    const mark = e.kind === "added" ? "+" : e.kind === "removed" ? "-" : "=";
    return { added: e.kind === "added", text: `${mark} ${e.text ?? JSON.stringify(d)}` };
  };
  const mapped = entries.map(line);
  const ordered = [...mapped.filter((l) => l.added), ...mapped.filter((l) => !l.added)].map((l) => l.text);
  if (ordered.length <= MAX_DIFF_LINES) return ordered;
  return [...ordered.slice(0, MAX_DIFF_LINES), `… ${ordered.length - MAX_DIFF_LINES} more changes; call inspect for the full screen`];
}

export function toUiElement(node: Record<string, unknown>): UiElement {
  const str = (key: string): string | undefined => (typeof node[key] === "string" && node[key] !== "" ? (node[key] as string) : undefined);
  const rect = node["rect"] as { x?: number; y?: number; width?: number; height?: number } | undefined;
  const el: UiElement = { ref: `@${String(node["ref"] ?? "")}`, role: str("kind") ?? str("type") ?? str("role") ?? "element" };
  const label = str("label");
  if (label) el.label = label;
  const value = str("value");
  if (value && value !== label) el.value = value;
  const id = str("identifier");
  if (id) el.identifier = id;
  const placeholder = str("placeholder");
  if (placeholder && placeholder !== value) el.placeholder = placeholder;
  if (node["enabled"] === false) el.enabled = false;
  if (node["editable"] === true) el.editable = true;
  const rn = (node["iosValueSemantics"] ?? {}) as { checked?: unknown; expanded?: unknown };
  const checked = typeof node["checked"] === "boolean" ? node["checked"] : rn.checked;
  const states = [
    ...(checked === true ? ["checked"] : checked === false ? ["unchecked"] : checked === "mixed" ? ["mixed"] : []),
    ...(node["selected"] === true ? ["selected"] : []),
    ...(node["focused"] === true ? ["focused"] : []),
    ...(rn.expanded === true ? ["expanded"] : rn.expanded === false ? ["collapsed"] : []),
  ];
  if (states.length) el.states = states;
  if (rect && typeof rect.x === "number" && typeof rect.y === "number" && typeof rect.width === "number" && typeof rect.height === "number") {
    el.rect = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  }
  if (typeof node["depth"] === "number") el.depth = node["depth"];
  return el;
}

function toWorkerInfo(w: SimlockWorker): WorkerInfo {
  const conn = (w.connection ?? w.state ?? "disconnected").toLowerCase();
  return {
    id: w.id,
    ...(w.label ? { label: w.label } : {}),
    connection: conn === "connected" ? "connected" : conn === "incompatible" ? "incompatible" : "disconnected",
    platforms: (["android", "ios"] as const).map((p) => ({ platform: p, running: w.capacity?.[p]?.running ?? 0, limit: w.capacity?.[p]?.limit ?? 0 })),
    leases: w.leases ?? 0,
    ...(w.host?.os ? { host: `${w.host.os} ${w.host.osVersion ?? ""} ${w.host.arch ?? ""}`.trim() } : {}),
    capabilities: Object.fromEntries((w.capabilities ?? []).map((c) => [c.name, c.state])),
    ...(w.lastSeenAt !== undefined ? { lastSeen: new Date(w.lastSeenAt).toISOString() } : {}),
  };
}

export function checkAppId(appId: string): void {
  if (!APP_ID.test(appId)) {
    throw new TapdanceError("USAGE", `"${appId}" is not a valid app id`, {
      hint: "Use the Android package name (com.example.app) or iOS bundle id (com.example.App).",
    });
  }
}

/** Refuses paths that cannot install on the leased device, before anything is uploaded. */
export function validateAppPath(appPath: string, platform: Platform, physical: boolean): string {
  const path = resolve(appPath);
  if (!existsSync(path)) {
    throw new TapdanceError("APP_PATH_INVALID", `No file or bundle at ${path}`, { hint: "Build the app first and pass the path to the build output." });
  }
  const ext = extname(path).toLowerCase();
  const isDir = statSync(path).isDirectory();
  if (platform === "android") {
    if (isDir || (ext !== ".apk" && ext !== ".aab")) {
      throw new TapdanceError("APP_PATH_INVALID", `${path} is not an .apk`, { hint: "Android emulators install .apk files, e.g. app/build/outputs/apk/debug/app-debug.apk." });
    }
    if (ext === ".aab") {
      throw new TapdanceError("APP_PATH_INVALID", "App bundles (.aab) cannot be installed directly", { hint: "Build an APK (`./gradlew assembleDebug`) for emulator testing." });
    }
    return path;
  }
  if (ext === ".ipa" && !physical) {
    throw new TapdanceError("APP_PATH_INVALID", `${path} is a signed device build (.ipa); simulators need a simulator .app`, {
      hint: "Build for the simulator: `xcodebuild -sdk iphonesimulator -configuration Debug ...` and pass the .app from Build/Products/Debug-iphonesimulator.",
    });
  }
  if (ext === ".app" && !isDir) {
    throw new TapdanceError("APP_PATH_INVALID", `${path} should be an .app bundle directory`);
  }
  if (ext !== ".app" && ext !== ".ipa" && !(ext === ".zip" || ext === ".tar")) {
    throw new TapdanceError("APP_PATH_INVALID", `${path} is not an iOS .app bundle`, {
      hint: "Pass the simulator .app from Build/Products/Debug-iphonesimulator.",
    });
  }
  return path;
}

function clampLines(lines: number): number {
  if (!Number.isInteger(lines) || lines < 1) return 200;
  return Math.min(lines, 5000);
}

function toLogResult(source: string, text: string, lines: number): LogResult {
  const all = text.split("\n").filter((l) => l.length > 0);
  return { source, lines: all.slice(-lines), truncated: all.length > lines };
}

/** What a screen shows, without positions: equal fingerprints mean nothing visible changed but layout. */
export function screenFingerprint(elements: UiElement[]): string {
  return elements
    .map((e) => [e.role, e.label ?? "", e.value ?? "", e.identifier ?? "", e.enabled === false ? "off" : "", (e.states ?? []).join(",")].join("|"))
    .join("\n");
}

/** Detail and fix for a /v1/healthz that answered but not with 2xx. */
export function describeBadHealth(baseUrl: string, h: { status: number; body: string; ms: number }, fix: string): { detail: string; fix: string } {
  if (baseUrl.startsWith("http://") && /http request to an https server/i.test(h.body)) {
    const https = baseUrl.replace(/^http:/, "https:");
    return {
      detail: `${baseUrl} serves HTTPS now (HTTP ${h.status}: "Client sent an HTTP request to an HTTPS server")`,
      // The token is saved per origin, so a scheme change needs connect again, not just a new endpoint.
      fix: `Connect again with the https address: tapdance connect ${https} < pairing-<label>.token`,
    };
  }
  return { detail: `${baseUrl}/v1/healthz answered HTTP ${h.status} after ${h.ms} ms${h.body ? `: ${h.body.slice(0, 120)}` : ""}`, fix };
}

const MAX_SWIPE_PASSES = 10;

/** System apps whose lists ignore the automation helper's touches (#34). */
export const RAW_INPUT_APPS = new Set([
  "com.google.android.documentsui",
  "com.android.documentsui",
  "com.android.intentresolver",
  "com.google.android.intentresolver",
]);

/** The package in `mCurrentFocus` of `dumpsys window displays`. */
export function focusedPackage(dumpsys: string): string | undefined {
  return /mCurrentFocus=Window\{\S+ \S+ ([A-Za-z][A-Za-z0-9_.]*)\//.exec(dumpsys)?.[1];
}

/** True when `el` is the element a ref, id, text or selector target names exactly. */
export function matchesTarget(el: UiElement, target: Exclude<ElementTarget, { kind: "point" }>): boolean {
  switch (target.kind) {
    case "ref":
      return el.ref === (target.ref.startsWith("@") ? target.ref : `@${target.ref}`);
    case "id":
      return el.identifier === target.id;
    case "text":
      return el.label === target.text || el.value === target.text;
    case "selector": {
      const m = /^(label|id|text|role)\s*=\s*"?(.*?)"?$/.exec(target.selector.trim());
      if (!m) return false;
      const v = m[2]!;
      return m[1] === "id" ? el.identifier === v : m[1] === "role" ? el.role === v : el.label === v || el.value === v;
    }
  }
}
