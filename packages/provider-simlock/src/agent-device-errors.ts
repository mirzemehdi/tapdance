import { TapdanceError, type ErrorCode } from "@tapdance/core";

interface AgentDeviceLikeError {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

const CODE_MAP: Record<string, ErrorCode> = {
  INVALID_ARGS: "USAGE",
  UNAUTHORIZED: "LEASE_LOST",
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
  APP_NOT_INSTALLED: "DEVICE_ERROR",
};

const HINTS: Partial<Record<ErrorCode, string>> = {
  ELEMENT_NOT_FOUND: "Run inspect_screen / `tapdance ui inspect` and target an element by its ref or exact label.",
  LEASE_LOST: "The lease ended (expired, released, or the worker restarted). Lease a new device.",
  PROVIDER_UNREACHABLE: "The worker or gateway is not answering; `tapdance doctor` shows which.",
};

/** Turns an agent-device or proxy failure into a TapdanceError an agent can act on. */
export function fromAgentDeviceError(error: unknown, action: string): TapdanceError {
  if (error instanceof TapdanceError) return error;
  const e = (error ?? {}) as AgentDeviceLikeError;
  const rawCode = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : String(error);
  let code: ErrorCode = CODE_MAP[rawCode] ?? "DEVICE_ERROR";
  if (/lease ended by simlock|lease is not active|no active proxy device lease/i.test(message)) code = "LEASE_LOST";
  else if (/not one of yours|needs an agent token/i.test(message)) code = "FORBIDDEN";
  else if (/not available on this simlock|not connected to the gateway|try again/i.test(message)) code = "PROVIDER_UNAVAILABLE";
  else if (/ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up|ETIMEDOUT/i.test(message)) code = "PROVIDER_UNREACHABLE";
  else if (/timed out waiting for a device/i.test(message)) code = "NO_CAPACITY";
  else if (/no (matching )?element|not found|did not match|no node/i.test(message) && code === "DEVICE_ERROR") code = "ELEMENT_NOT_FOUND";
  const details: Record<string, unknown> = { action };
  if (rawCode) details["backendCode"] = rawCode;
  const backendHint = extractHint(e.details);
  const hint = HINTS[code] ?? backendHint;
  return new TapdanceError(code, `${action} failed: ${firstLine(message)}`, {
    ...(hint === undefined ? {} : { hint }),
    details,
    cause: error,
  });
}

function extractHint(details: unknown): string | undefined {
  if (details !== null && typeof details === "object" && "hint" in details) {
    const hint = (details as { hint?: unknown }).hint;
    if (typeof hint === "string" && !/run --help/i.test(hint)) return hint;
  }
  return undefined;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? text;
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}
