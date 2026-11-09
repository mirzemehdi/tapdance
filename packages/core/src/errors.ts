/**
 * Every failure Tapdance reports carries a stable code, a message a person can act on,
 * an optional hint with the fix, and the CLI exit code it maps to.
 */
export const ERROR_CODES = {
  USAGE: 2,
  CONFIG_INVALID: 2,
  APP_PATH_INVALID: 2,
  NO_ACTIVE_LEASE: 3,
  LEASE_ALREADY_HELD: 3,
  LEASE_LOST: 3,
  PROVIDER_UNREACHABLE: 4,
  PROVIDER_UNAVAILABLE: 4,
  WORKER_OFFLINE: 4,
  AUTH_FAILED: 5,
  FORBIDDEN: 5,
  NO_CAPACITY: 6,
  DEVICE_UNAVAILABLE: 6,
  DEVICE_ERROR: 7,
  ELEMENT_NOT_FOUND: 7,
  APP_NOT_INSTALLED: 7,
  NOT_SUPPORTED: 8,
  TIMEOUT: 9,
  HOST_CHECK_FAILED: 10,
  HUMAN_HELD: 11,
  /** A scenario step's expectation did not hold (wait_for, expect_*); reported inside a scenario report. */
  ASSERTION_FAILED: 12,
  /** `tapdance run`: the scenario ran and at least one step failed. */
  SCENARIO_FAILED: 12,
  /** A wait ended because someone cancelled it (`device request-human --cancel`). */
  CANCELLED: 13,
  INTERNAL: 1,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface TapdanceErrorOptions {
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
  /** True when the same call may succeed later without any change (worker briefly offline, a person holding the device). */
  retryable?: boolean;
  retryAfterMs?: number;
}

const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set(["PROVIDER_UNREACHABLE", "WORKER_OFFLINE", "NO_CAPACITY", "HUMAN_HELD", "TIMEOUT"]);

export class TapdanceError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(code: ErrorCode, message: string, options: TapdanceErrorOptions = {}) {
    super(redactSecrets(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TapdanceError";
    this.code = code;
    this.hint = options.hint === undefined ? undefined : redactSecrets(options.hint);
    this.details = options.details === undefined ? undefined : redactObject(options.details);
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    this.retryAfterMs = options.retryAfterMs;
  }

  get exitCode(): number {
    return ERROR_CODES[this.code];
  }

  toJSON(): { code: ErrorCode; message: string; retryable: boolean; retryAfterMs?: number; hint?: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function isTapdanceError(error: unknown): error is TapdanceError {
  return error instanceof TapdanceError;
}

/** Wraps anything thrown into a TapdanceError so callers print one shape. */
export function toTapdanceError(error: unknown): TapdanceError {
  if (isTapdanceError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new TapdanceError("INTERNAL", message, { cause: error });
}

// Simlock secrets start with `slk_`, worker-guard tokens with `tdg_`, GitHub's with `gh?_`/`github_pat_`; bearer headers, JWTs, the
// viewer's `#k=` key, private keys and token-ish `key=value` pairs are covered too.
const SECRET_PATTERNS: RegExp[] = [
  /slk_[A-Za-z0-9_-]{8,}/g,
  /tdg_[A-Za-z0-9_-]{16,}/g,
  // Tailscale auth, API and OAuth client keys (`machine create --tailscale-key`): tskey-auth-…, tskey-api-…, tskey-client-….
  /\btskey-[A-Za-z0-9_-]{10,}/g,
  // GitHub tokens (`host gh-login` puts one on the host): classic, OAuth, app and fine-grained.
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  // A Basic credential in an Authorization header; a bare `Basic …` is checked in redactBasic.
  /(\bAuthorization"?\s*[:=]\s*"?Basic\s+)[A-Za-z0-9+/=]{4,}/gi,
  // A password in a URL's userinfo (`https://user:secret@host`); `git@github.com:` and `user@host` have no scheme.
  /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]+:)(?!\[REDACTED\])[^\s@/]+(?=@)/g,
  // A token as a URL's whole userinfo (`https://<token>@host`): long, and with a digit, unlike a user name.
  /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}(?=@)/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(#k=)[A-Za-z0-9_-]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /("?(?:token|secret|daemonAuthToken|authorization|password|api[_-]?key|private[_-]?key)"?\s*[:=]\s*"?)(?!Bearer\b|Basic\b|\[REDACTED\])[^"\s,}]{6,}/gi,
  // Environment-style names such as ASC_PRIVATE_KEY_B64=…; case-sensitive so a bare `key=` is left alone.
  /(\b[A-Z][A-Z0-9_]*KEY(?:_B64)?"?\s*[:=]\s*"?)(?!\[REDACTED\])[^"\s,}]{6,}/g,
];

const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/g;
const PEM_BODY_CHAR = /[A-Za-z0-9+/=\s]/;

/**
 * The tail of a private key whose BEGIN line was cut off (output truncated mid-key): at least 40
 * base64 characters right before an END line. Equivalent to
 * /[A-Za-z0-9+/=\s]{40,}-----END [A-Z ]*PRIVATE KEY-----/g, but scanned backwards from each END line so
 * long base64-looking output cannot make it quadratic.
 */
function redactOrphanPemTails(text: string): string {
  if (!text.includes("PRIVATE KEY-----")) return text;
  let out = "";
  let from = 0;
  for (const match of text.matchAll(PEM_END)) {
    const end = match.index;
    let start = end;
    while (start > from && PEM_BODY_CHAR.test(text[start - 1]!)) start--;
    if (end - start >= 40) {
      out += `${text.slice(from, start)}[REDACTED]`;
      from = end + match[0].length;
    }
  }
  return out + text.slice(from);
}

const BASIC = /\b(Basic\s+)([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/gi;

/**
 * `Basic <base64>` outside a header: redacted only when the word after it looks like base64 (a
 * length that is a multiple of 4, and a digit, `+`, `/`, `=` or an inner capital), so prose such as
 * "Basic configuration" is left alone.
 */
function redactBasic(text: string): string {
  return text.replace(BASIC, (match, prefix: string, value: string) =>
    value.length % 4 === 0 && (/[0-9+/=]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value.slice(1)))) ? `${prefix}[REDACTED]` : match,
  );
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix: unknown) =>
      typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return redactOrphanPemTails(redactBasic(out));
}

const SECRET_KEYS = /^(token|secret|daemonAuthToken|authorization|password|operatorToken|joinToken|apiKey|privateKey|joinUrl)$/i;
/**
 * The per-origin token map in credentials.json (`tokens: { origin: token }`): every value is
 * redacted and the origins stay readable. An array under `tokens` (the guard's token list, which
 * holds no secrets) is redacted like any other value.
 */
const TOKEN_MAP_KEY = /^tokens$/i;

function redactTokenMap(map: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [origin, item] of Object.entries(map)) out[origin] = item === undefined || item === null ? item : "[REDACTED]";
  return out;
}

export function redactObject<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactObject(item)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (TOKEN_MAP_KEY.test(key) && item !== undefined && item !== null && !Array.isArray(item)) {
        out[key] = typeof item === "object" ? redactTokenMap(item as Record<string, unknown>) : "[REDACTED]";
      } else out[key] = SECRET_KEYS.test(key) && item !== undefined && item !== null ? "[REDACTED]" : redactObject(item);
    }
    return out as T;
  }
  return value;
}
