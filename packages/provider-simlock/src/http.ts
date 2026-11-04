import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TapdanceError, type ErrorCode } from "@tapdance/core";
import type { CrashReportInfo } from "./crash-reports.js";
import type { PlayedTap } from "./touch-sequence.js";
import type { AppBuildResult, AppCiInstallResult, TimedTap } from "@tapdance/core";

/** Status → Tapdance code for Simlock's JSON errors (`{"error":{"code","message"}}`). */
const SIMLOCK_CODE_MAP: Record<string, ErrorCode> = {
  UNAUTHENTICATED: "AUTH_FAILED",
  FORBIDDEN: "FORBIDDEN",
  NO_CAPACITY: "NO_CAPACITY",
  QUEUE_TIMEOUT: "TIMEOUT",
  EXEC_TIMEOUT: "TIMEOUT",
  UNKNOWN_LEASE: "LEASE_LOST",
  REQUESTER_ALREADY_LEASED: "LEASE_ALREADY_HELD",
  UNKNOWN_MODEL: "DEVICE_UNAVAILABLE",
  RUNTIME_MISSING: "DEVICE_UNAVAILABLE",
  NO_DRIVER: "DEVICE_UNAVAILABLE",
  WORKER_UNREACHABLE: "WORKER_OFFLINE",
  CAPABILITY_MISSING: "PROVIDER_UNAVAILABLE",
  UNSUPPORTED_IN_GATEWAY_MODE: "NOT_SUPPORTED",
  PASSTHROUGH_REFUSED: "FORBIDDEN",
  UNKNOWN_PASSTHROUGH_TOOL: "NOT_SUPPORTED",
  BAD_REQUEST: "USAGE",
  STREAM_UNAVAILABLE: "NOT_SUPPORTED",
  INPUT_UNAVAILABLE: "NOT_SUPPORTED",
};

/** Shared with the agent-device error path so both say the same thing about an offline worker. */
export const WORKER_OFFLINE_HINT = "The machine holding your device is offline; the lease stays yours. Retry this call in 30-60 s; do not release the device.";

export const PASSTHROUGH_REFUSED_HINT =
  "The worker does not allow this command; a gateway worker must be joined with `tapdance worker login --accept-gateway-exec` (dedicated machines only), and the worker guard allows only its device API.";

export interface SimlockStatus {
  devices: Array<{
    id: string;
    state: string;
    platform?: string;
    spec?: { platform?: string; model?: string; osVersion?: string };
    workerId?: string;
  }>;
  leases: Array<{ id: string; deviceId?: string }>;
  capacity?: Record<string, { running?: number; limit?: number; warm?: number; used?: number } | undefined>;
  capabilities?: Array<{ name: string; state: string; reason?: string }>;
  daemon?: { health?: string; mode?: string; version?: string };
  host?: { os?: string; osVersion?: string; arch?: string; tools?: Array<{ platform: string; name: string; version?: string }> };
  queueDepth?: number;
}

export interface SimlockLease {
  id: string;
  platform: string;
  device?: string;
  os?: string;
  udid?: string;
  address?: string;
  deviceId?: string;
  createdAt?: string;
  expiresAt?: string;
  ttlMs?: number;
  mode?: string;
  worker?: { id?: string; label?: string };
}

export interface SimlockCatalog {
  platforms: Array<{
    platform: string;
    models?: string[];
    /** Simlock 0.4 sends plain version strings; older shapes sent objects. */
    runtimes?: Array<string | { version?: string; osVersion?: string; installed?: boolean; imageTag?: string; tag?: string }>;
    defaultRuntime?: string;
    /** OS versions each model can boot; an empty list means no installed image fits it. */
    modelRuntimes?: Record<string, string[]>;
    osVersions?: string[];
    imageTags?: string[];
  }>;
}

export interface SimlockWorker {
  id: string;
  label?: string;
  connection?: string;
  state?: string;
  capacity?: Record<string, { running?: number; limit?: number } | undefined>;
  leases?: number;
  host?: { os?: string; osVersion?: string; arch?: string };
  capabilities?: Array<{ name: string; state: string }>;
  lastSeenAt?: string | number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class SimlockHttp {
  constructor(
    readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(token = this.token, extra: Record<string, string> = {}): Record<string, string> {
    return { ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }), ...extra };
  }

  authHeaders(): Record<string, string> {
    return this.headers();
  }

  private async request(path: string, init: RequestInit & { timeoutMs?: number; token?: string } = {}): Promise<Response> {
    const { timeoutMs = 15_000, token, ...rest } = init;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...rest,
        headers: { ...this.headers(token ?? this.token), ...(rest.headers as Record<string, string> | undefined) },
        signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new TapdanceError("PROVIDER_UNREACHABLE", `Cannot reach Simlock at ${this.baseUrl}: ${reason}`, {
        hint: "Check the endpoint with `tapdance doctor`. For local mode, start the worker with `tapdance worker start`.",
        cause: error,
      });
    }
  }

  private async json<T>(path: string, init: RequestInit & { timeoutMs?: number; token?: string } = {}): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) throw await toError(response, path);
    return (await response.json()) as T;
  }

  /** Probes `/v1/healthz`; `body` is kept for a failed answer so callers can say why. */
  async healthz(timeoutMs = 15_000): Promise<{ ok: boolean; status: number; body: string; ms: number }> {
    const started = Date.now();
    const response = await this.request("/v1/healthz", { timeoutMs });
    const body = response.ok ? "" : (await response.text().catch(() => "")).slice(0, 300);
    return { ok: response.ok, status: response.status, body, ms: Date.now() - started };
  }

  identity(): Promise<{ principal: string; name?: string; role: string; via?: string }> {
    return this.json("/v1/identity");
  }

  status(): Promise<SimlockStatus> {
    return this.json("/v1/status");
  }

  catalog(platform?: string): Promise<SimlockCatalog> {
    return this.json(`/v1/catalog${platform === undefined ? "" : `?platform=${encodeURIComponent(platform)}`}`);
  }

  async workers(operatorToken: string): Promise<SimlockWorker[]> {
    const body = await this.json<{ workers?: SimlockWorker[] }>("/v1/workers", { token: operatorToken });
    return body.workers ?? [];
  }

  /** Undefined when the lease has ended or never existed. */
  async lease(leaseId: string): Promise<SimlockLease | undefined> {
    const response = await this.request(`/v1/leases/${encodeURIComponent(leaseId)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw await toError(response, "/v1/leases/{id}");
    const body = (await response.json()) as { lease?: SimlockLease };
    return body.lease;
  }

  /**
   * Runs one allowlisted adb/simctl command on the lease's device (the worker fills the device in).
   * Internal only: Tapdance never forwards caller-chosen arguments here.
   */
  /** Worker guard only: carries a file into a leased iOS simulator (Photos, or an app's Documents). */
  async putFile(leaseId: string, query: Record<string, string>, bytes: Buffer): Promise<{ devicePath: string }> {
    const response = await this.request(`/v1/leases/${encodeURIComponent(leaseId)}/files?${new URLSearchParams(query)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bytes),
      timeoutMs: 300_000,
    });
    if (response.status === 404 && !(response.headers.get("content-type") ?? "").includes("json")) throw filesUnsupported();
    if (!response.ok) throw await toError(response, "/v1/leases/{id}/files");
    return (await response.json()) as { devicePath: string };
  }

  /** Worker guard only: reads a file from an app's container on a leased iOS simulator. */
  async getFile(leaseId: string, query: Record<string, string>): Promise<Buffer> {
    const response = await this.request(`/v1/leases/${encodeURIComponent(leaseId)}/files?${new URLSearchParams(query)}`, { timeoutMs: 300_000 });
    if (response.status === 404 && !(response.headers.get("content-type") ?? "").includes("json")) throw filesUnsupported();
    if (!response.ok) throw await toError(response, "/v1/leases/{id}/files");
    return Buffer.from(await response.arrayBuffer());
  }

  /** A worker guard's touch route: plays timed taps on the lease's simulator from the host (#58). */
  async touches(leaseId: string, body: { steps: TimedTap[]; viewport?: { width: number; height: number }; orientation: string; model?: string }): Promise<PlayedTap[]> {
    const last = body.steps.at(-1);
    const response = await this.request(`/v1/leases/${encodeURIComponent(leaseId)}/touches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: (last ? last.t + (last.hold ?? 0) : 0) + 60_000,
    });
    if (response.status === 404 && !(response.headers.get("content-type") ?? "").includes("json")) {
      throw new TapdanceError("NOT_SUPPORTED", "This endpoint cannot play timed taps on an iOS simulator", { hint: "Timed iOS taps go through a worker in device-only mode (tapdance worker guard) that is up to date, or run Tapdance on the Mac itself." });
    }
    if (!response.ok) throw await toError(response, "/v1/leases/{id}/touches");
    return ((await response.json()) as { steps: PlayedTap[] }).steps;
  }

  /** A worker guard's console route: relaunch the app with its stdout/stderr captured on the host (#59). */
  async consoleLaunch(leaseId: string, appId: string, args: string[] = []): Promise<void> {
    const response = await this.request(`/v1/leases/${encodeURIComponent(leaseId)}/console`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, args }),
      timeoutMs: 120_000,
    });
    if (response.status === 404 && !(response.headers.get("content-type") ?? "").includes("json")) throw consoleUnsupported();
    if (!response.ok) throw await toError(response, "/v1/leases/{id}/console");
  }

  /** The captured stdout/stderr of the last `launch --console`, last `lines` lines of each. */
  async console(leaseId: string, lines: number): Promise<{ stdout: string[]; stderr: string[]; captured: boolean }> {
    const response = await this.request(`/v1/leases/${encodeURIComponent(leaseId)}/console?lines=${lines}`, { timeoutMs: 60_000 });
    if (response.status === 404 && !(response.headers.get("content-type") ?? "").includes("json")) throw consoleUnsupported();
    if (!response.ok) throw await toError(response, "/v1/leases/{id}/console");
    return (await response.json()) as { stdout: string[]; stderr: string[]; captured: boolean };
  }

  /** A worker guard's crash reports for the lease's simulator (#59). */
  async crashes(leaseId: string, appId?: string): Promise<CrashReportInfo[]> {
    const response = await this.request(`/v1/leases/${encodeURIComponent(leaseId)}/crashes${appId ? `?${new URLSearchParams({ app: appId })}` : ""}`, { timeoutMs: 60_000 });
    if (response.status === 404 && !(response.headers.get("content-type") ?? "").includes("json")) throw crashesUnsupported();
    if (!response.ok) throw await toError(response, "/v1/leases/{id}/crashes");
    return ((await response.json()) as { reports?: CrashReportInfo[] }).reports ?? [];
  }

  /** One crash report's text through a worker guard; `name` may be "latest". */
  async crash(leaseId: string, name: string, appId?: string): Promise<{ name: string; text: string }> {
    const response = await this.request(`/v1/leases/${encodeURIComponent(leaseId)}/crashes/${encodeURIComponent(name)}${appId ? `?${new URLSearchParams({ app: appId })}` : ""}`, { timeoutMs: 120_000 });
    if (response.status === 404 && !(response.headers.get("content-type") ?? "").includes("json")) throw crashesUnsupported();
    if (!response.ok) throw await toError(response, "/v1/leases/{id}/crashes/{name}");
    return { name: decodeURIComponent(response.headers.get("x-tapdance-crash-name") ?? name), text: await response.text() };
  }

  /**
   * A worker guard's build route: builds on the host and installs on the lease, streaming log lines
   * to `onLine`. Answers the result, or throws the build's error.
   */
  async build(leaseId: string, body: Record<string, unknown>, onLine: (line: string) => void, timeoutMs = 4 * 3_600_000): Promise<AppBuildResult> {
    const response = await this.request(`/v1/leases/${encodeURIComponent(leaseId)}/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs,
    });
    if (response.status === 404 && !(response.headers.get("content-type") ?? "").includes("json")) {
      throw new TapdanceError("NOT_SUPPORTED", "This endpoint cannot build apps", { hint: "Builds run on a worker in device-only mode (tapdance worker guard) whose owner turned them on: tapdance host builds enable." });
    }
    if (!response.ok || !response.body) throw await toError(response, "/v1/leases/{id}/build");
    return this.readResultStream(response, onLine, "build");
  }

  /**
   * A worker guard's install-from-CI route: the host fetches a GitHub Actions artifact with its own gh
   * and installs its APK on the lease, streaming progress to `onLine`.
   */
  async ciInstall(leaseId: string, body: Record<string, unknown>, onLine: (line: string) => void, timeoutMs = 30 * 60_000): Promise<AppCiInstallResult> {
    const response = await this.request(`/v1/leases/${encodeURIComponent(leaseId)}/ci-install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs,
    });
    if (response.status === 404) {
      const text = await response.text().catch(() => "");
      // Simlock itself, or a guard from before this route, does not know it.
      if (!(response.headers.get("content-type") ?? "").includes("json") || /"NOT_ALLOWED"/.test(text)) {
        throw new TapdanceError("NOT_SUPPORTED", "This endpoint cannot install apps from CI", {
          hint: "Installs from CI run on a worker in device-only mode (tapdance worker guard) whose owner turned them on: tapdance host artifacts enable --repo <owner/repo>. Without it, download the APK yourself and run tapdance app install <path>.",
        });
      }
      throw await toError(new Response(text, { status: response.status, headers: response.headers }), "/v1/leases/{id}/ci-install");
    }
    if (!response.ok || !response.body) throw await toError(response, "/v1/leases/{id}/ci-install");
    return this.readResultStream(response, onLine, "install from CI");
  }

  /** Reads a guard's NDJSON stream ({"log"}, then {"result"} or {"error"}). */
  private async readResultStream<T>(response: Response, onLine: (line: string) => void, what: string): Promise<T> {
    let buffer = "";
    let result: T | undefined;
    const decoder = new TextDecoder();
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        if (!raw.trim()) continue;
        const msg = JSON.parse(raw) as { log?: string; result?: typeof result; error?: { code: string; message: string; hint?: string; tail?: string; details?: Record<string, unknown> } };
        if (msg.log !== undefined) onLine(msg.log);
        if (msg.result) result = msg.result;
        if (msg.error) {
          // The few details a guard names (why, and which app), so a caller can act on them (#85, #89).
          const given = msg.error.details && typeof msg.error.details === "object" ? msg.error.details : {};
          const details: Record<string, unknown> = Object.fromEntries(
            Object.entries(given).filter(([k, v]) => ["reason", "appId", "gitAuth", "keyFingerprint"].includes(k) && typeof v === "string" && v.length <= 300),
          );
          if (msg.error.tail) details["tail"] = msg.error.tail;
          throw new TapdanceError(msg.error.code as never, msg.error.message, { ...(msg.error.hint ? { hint: msg.error.hint } : {}), ...(Object.keys(details).length > 0 ? { details } : {}) });
        }
      }
    }
    if (!result) throw new TapdanceError("PROVIDER_UNREACHABLE", `The ${what} stream ended without a result`);
    return result;
  }

  /** Streams an agent-device artifact (a recording) to `destination`, with a generous time limit. */
  async downloadArtifact(artifactId: string, scope: { leaseId: string; tenant: string }, destination: string, timeoutMs: number): Promise<void> {
    const response = await this.request(`/v1/agent-device/artifacts/${encodeURIComponent(artifactId)}`, {
      headers: {
        ...(this.token ? { "x-agent-device-token": this.token } : {}),
        "x-agent-device-lease-id": scope.leaseId,
        ...(/^[a-zA-Z0-9._-]{1,128}$/.test(scope.tenant) ? { "x-agent-device-tenant": scope.tenant } : {}),
      },
      timeoutMs,
    });
    if (!response.ok || !response.body) throw await toError(response, "/v1/agent-device/artifacts/{id}");
    await mkdir(dirname(destination), { recursive: true });
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination, { mode: 0o600 }));
  }

  async exec(leaseId: string, tool: "adb" | "simctl", args: string[], timeoutMs = 120_000, stdin?: string): Promise<ExecResult> {
    const response = await this.request(`/v1/leases/${encodeURIComponent(leaseId)}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stdin === undefined ? { tool, args } : { tool, args, stdin }),
      timeoutMs,
    });
    if (!response.ok) throw await toError(response, "/v1/leases/{id}/exec");
    return parseExecStream(await response.text());
  }
}

function consoleUnsupported(): TapdanceError {
  return new TapdanceError("NOT_SUPPORTED", "This endpoint cannot capture an iOS app's console", {
    hint: "A remote simulator's console comes through a worker in device-only mode (tapdance worker guard), or run Tapdance on the Mac itself.",
  });
}

function crashesUnsupported(): TapdanceError {
  return new TapdanceError("NOT_SUPPORTED", "This endpoint cannot read iOS crash reports", {
    hint: "Crash reports of a remote simulator come through a worker in device-only mode (tapdance worker guard), or run Tapdance on the Mac itself.",
  });
}

function filesUnsupported(): TapdanceError {
  return new TapdanceError("NOT_SUPPORTED", "This endpoint cannot carry files to an iOS simulator", {
    hint: "Files for a remote iOS simulator go through a worker in device-only mode (tapdance worker guard), or run Tapdance on the Mac itself.",
  });
}

/** Parses Simlock's exec Server-Sent Events: `output` chunks, then `exit` or `error`. */
export function parseExecStream(body: string): ExecResult {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  for (const block of body.split(/\r?\n\r?\n/)) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data.join("\n")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event === "output") {
      const chunk = typeof payload["chunk"] === "string" ? payload["chunk"] : "";
      if (payload["stream"] === "stderr") stderr += chunk;
      else stdout += chunk;
    } else if (event === "exit") {
      exitCode = typeof payload["exitCode"] === "number" ? payload["exitCode"] : -1;
    } else if (event === "error") {
      const code = typeof payload["code"] === "string" ? payload["code"] : "EXEC_FAILED";
      const message = typeof payload["message"] === "string" ? payload["message"] : "exec failed";
      const hint = code === "PASSTHROUGH_REFUSED" ? PASSTHROUGH_REFUSED_HINT : code === "WORKER_UNREACHABLE" ? WORKER_OFFLINE_HINT : undefined;
      throw new TapdanceError(SIMLOCK_CODE_MAP[code] ?? "DEVICE_ERROR", `${code}: ${message}`, hint === undefined ? {} : { hint });
    }
  }
  if (exitCode === undefined) {
    throw new TapdanceError("DEVICE_ERROR", "The worker ended the command without an exit status");
  }
  return { exitCode, stdout, stderr };
}

async function toError(response: Response, path: string): Promise<TapdanceError> {
  let code = `HTTP_${response.status}`;
  let message = `${path} answered ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // Not JSON: keep the status line.
  }
  const mapped: ErrorCode =
    SIMLOCK_CODE_MAP[code] ??
    (response.status === 401
      ? "AUTH_FAILED"
      : response.status === 403
        ? "FORBIDDEN"
        : response.status === 404
          ? "NOT_SUPPORTED"
          : response.status >= 500
            ? "PROVIDER_UNAVAILABLE"
            : "DEVICE_ERROR");
  const hint =
    mapped === "AUTH_FAILED"
      ? "The token is missing, revoked or from another daemon. Run `tapdance config set-token`."
      : mapped === "LEASE_ALREADY_HELD"
        ? "Release the current lease with `tapdance device release` first."
        : mapped === "WORKER_OFFLINE"
          ? WORKER_OFFLINE_HINT
          : code === "PASSTHROUGH_REFUSED"
            ? PASSTHROUGH_REFUSED_HINT
            : mapped === "DEVICE_UNAVAILABLE" && /RUNTIME_MISSING|UNKNOWN_MODEL/.test(code)
              ? "Install the runtime or system image on a worker: `tapdance devices install <ios|android> <version>`, then check `tapdance devices`."
              : undefined;
  const retryAfter = Number(response.headers.get("retry-after"));
  return new TapdanceError(mapped, message, { ...(hint === undefined ? {} : { hint }), details: { status: response.status, backendCode: code }, ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}) });
}
