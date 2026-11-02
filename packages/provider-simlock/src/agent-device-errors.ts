import { TapdanceError, type ErrorCode } from "@tapdance/core";
import { WORKER_OFFLINE_HINT } from "./http.js";

interface AgentDeviceLikeError {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

/** Backend code → Tapdance code when nothing more specific matches. UNAUTHORIZED is decided below. */
export const CODE_MAP: Record<string, ErrorCode> = {
  INVALID_ARGS: "USAGE",
  COMMAND_FAILED: "DEVICE_ERROR",
  DEVICE_NOT_FOUND: "DEVICE_UNAVAILABLE",
  DEVICE_IN_USE: "DEVICE_UNAVAILABLE",
  AMBIGUOUS_MATCH: "DEVICE_ERROR",
  TEXT_INPUT_NOT_FOCUSED: "ELEMENT_NOT_FOUND",
  ELEMENT_NOT_FOUND: "ELEMENT_NOT_FOUND",
  SELECTOR_NOT_FOUND: "ELEMENT_NOT_FOUND",
  UNSUPPORTED_OPERATION: "NOT_SUPPORTED",
  UNSUPPORTED_PLATFORM: "NOT_SUPPORTED",
  TIMEOUT: "TIMEOUT",
  APP_NOT_INSTALLED: "APP_NOT_INSTALLED",
};

const HINTS: Partial<Record<ErrorCode, string>> = {
  ELEMENT_NOT_FOUND: "Run inspect_screen / `tapdance ui inspect` and target an element by its ref or exact label.",
  LEASE_LOST: "The lease ended (expired, released, or the worker restarted). Lease a new device.",
  PROVIDER_UNREACHABLE: "The worker or gateway is not answering; `tapdance doctor` shows which.",
  WORKER_OFFLINE: WORKER_OFFLINE_HINT,
  APP_NOT_INSTALLED: "Install it with install_app first (call list_apps to see what is installed).",
  AUTH_FAILED: "The token is missing, revoked or from another daemon. Run `tapdance config set-token`.",
};

const LEASE_GONE = /lease ended by simlock|lease is not active|no active proxy device lease/i;
// Simlock's agent-device front answers UNAUTHORIZED with these reasons when the lease itself is gone.
const LEASE_GONE_REASONS = new Set(["LEASE_ENDED_BY_HOST", "LEASE_NOT_FOUND", "LEASE_EXPIRED", "LEASE_REVOKED"]);
const SCOPE_REFUSED = /LEASE_SCOPE_MISMATCH|LEASE_SCOPE_REQUIRED|outside this tenant/i;
const STALE_REF = /ref_generation_mismatch|ref_frame_expired|superseded snapshot generation|expired ref frame/i;
const STALE_REF_HINT = "The screen changed since that inspect_screen; inspect again and use the new ref.";
const NO_CAPACITY_HINT = "No device of that platform can run on any worker right now; call list_devices to see capacity, or ask the user to start a worker.";
const UNKNOWN_DEVICE_HINT = "Call list_devices and pass one of the listed models / OS versions.";
/** agent-device's refusal when a device is still claimed by a session whose daemon has gone. */
const OWNED_BY = /device \S+ is owned by session/i;
const DEAD_OWNER = /can no longer release|device release .*--stale/i;
/** `details.reason` of a TapdanceError for a device blocked by a dead session's claim. */
export const STALE_CLAIM_REASON = "STALE_DEVICE_CLAIM";
const STALE_CLAIM_HINT =
  "An earlier session's claim on this device outlived its worker process. Lease again: a worker guard clears such claims before each lease. On the worker machine, `tapdance worker cleanup` clears them by hand.";

/** Turns an agent-device or proxy failure into a TapdanceError an agent can act on. */
export function fromAgentDeviceError(error: unknown, action: string): TapdanceError {
  if (error instanceof TapdanceError) return error;
  const e = (error ?? {}) as AgentDeviceLikeError;
  const rawCode = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : String(error);
  const backendDetails = e.details !== null && typeof e.details === "object" ? (e.details as Record<string, unknown>) : {};
  const reason = typeof backendDetails["reason"] === "string" ? backendDetails["reason"] : "";
  let code: ErrorCode = CODE_MAP[rawCode] ?? "DEVICE_ERROR";
  let hint: string | undefined;
  let retryable: boolean | undefined;
  let staleClaim = false;
  let noBackendHint = false;

  if (LEASE_GONE.test(message) || (rawCode === "UNAUTHORIZED" && LEASE_GONE_REASONS.has(reason))) code = "LEASE_LOST";
  else if (/not one of yours|needs an agent token/i.test(message) || SCOPE_REFUSED.test(reason) || SCOPE_REFUSED.test(message)) code = "FORBIDDEN";
  else if (rawCode === "UNAUTHORIZED") code = "AUTH_FAILED";
  else if (reason === "WORKER_UNREACHABLE" || /not connected to the gateway/i.test(message)) {
    // The gateway keeps a disconnected worker's lease: the device is still the caller's.
    code = "WORKER_OFFLINE";
    retryable = true;
  } else if (/not available on this simlock|try again/i.test(message)) code = "PROVIDER_UNAVAILABLE";
  else if (/ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up|ETIMEDOUT/i.test(message)) code = "PROVIDER_UNREACHABLE";
  else if (/timed out waiting for a device/i.test(message)) code = "NO_CAPACITY";
  else if (/^refused by simlock:/i.test(message)) {
    // Simlock's allocate refusals all arrive as INVALID_ARGS; the text says which kind.
    const inner = message.replace(/^refused by simlock:\s*/i, "");
    if (/no capacity|no .*device can run|no worker/i.test(inner)) {
      code = "NO_CAPACITY";
      retryable = true;
      hint = NO_CAPACITY_HINT;
    } else if (/unknown model|no such model|runtime|not installed/i.test(inner)) {
      code = "DEVICE_UNAVAILABLE";
      hint = UNKNOWN_DEVICE_HINT;
    } else code = "USAGE";
  } else if (OWNED_BY.test(message) && DEAD_OWNER.test(`${message} ${extractHint(e.details) ?? ""}`)) {
    code = "DEVICE_UNAVAILABLE";
    retryable = true;
    hint = STALE_CLAIM_HINT;
    staleClaim = true;
  } else if (/requires an active app session|Run open first|app '[^']*' is not running/i.test(message)) {
    // agent-device's iOS reads need the session's app running; on the Home Screen there is none (#50).
    code = "DEVICE_ERROR";
    hint = "No app is in front (the Home Screen, or the app was killed). agent-device reads the session's app: launch it again (launch_app / `tapdance app launch <id>`), or read the Home Screen with `tapdance ui inspect --app com.apple.springboard` (inspect_screen app_id).";
    noBackendHint = true;
  } else if (STALE_REF.test(rawCode) || STALE_REF.test(reason) || STALE_REF.test(message)) {
    code = "ELEMENT_NOT_FOUND";
    hint = STALE_REF_HINT;
  } else if (rawCode !== "APP_NOT_INSTALLED" && code === "DEVICE_ERROR" && /no (matching )?element|not found|did not match|no node/i.test(message)) {
    code = "ELEMENT_NOT_FOUND";
  }
  if (rawCode === "DEVICE_IN_USE" && code === "DEVICE_UNAVAILABLE") retryable = true;

  const details: Record<string, unknown> = { action };
  if (rawCode) details["backendCode"] = rawCode;
  if (reason) details["reason"] = reason;
  if (staleClaim) details["reason"] = STALE_CLAIM_REASON;
  if (rawCode === "AMBIGUOUS_MATCH") {
    const candidates = candidateLabels(backendDetails);
    if (candidates.length > 0) details["candidates"] = candidates;
  }
  // agent-device's own fix for a stale claim names a command only the worker machine can run.
  const backendHint = staleClaim || noBackendHint ? undefined : extractHint(e.details);
  const ownHint = hint ?? HINTS[code];
  const joined = [ownHint, backendHint === ownHint ? undefined : backendHint].filter(Boolean).join(" ");
  return new TapdanceError(code, `${action} failed: ${firstLine(message)}`, {
    ...(joined === "" ? {} : { hint: joined }),
    details,
    ...(retryable === undefined ? {} : { retryable }),
    cause: error,
  });
}

/** Up to five labels of the elements an ambiguous selector matched, as agent-device lists them. */
function candidateLabels(details: Record<string, unknown>): string[] {
  const list = Array.isArray(details["candidates"]) ? details["candidates"] : Array.isArray(details["matches"]) ? details["matches"] : [];
  const out: string[] = [];
  for (const item of list as unknown[]) {
    if (out.length >= 5) break;
    if (typeof item === "string" && item !== "") out.push(item);
    else if (item !== null && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const node = o["node"] !== null && typeof o["node"] === "object" ? (o["node"] as Record<string, unknown>) : o;
      const label = [node["label"], node["text"], node["name"], node["ref"]].find((v) => typeof v === "string" && v !== "");
      if (typeof label === "string") out.push(label);
    }
  }
  return out;
}

function extractHint(details: unknown): string | undefined {
  if (details !== null && typeof details === "object" && "hint" in details) {
    const hint = (details as { hint?: unknown }).hint;
    if (typeof hint === "string" && hint.trim() !== "" && !/run --help/i.test(hint)) return hint;
  }
  return undefined;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? text;
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}
