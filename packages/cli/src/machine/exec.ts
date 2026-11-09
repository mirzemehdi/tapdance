import { spawn } from "node:child_process";
import { TapdanceError, redactSecrets } from "@tapdance/sdk";

/**
 * How `tapdance machine` runs the user's own cloud CLIs (gcloud, scw), ssh and its own CLI. Every
 * call is an argument array, never a shell. Tests pass a fake `Exec` instead (machine.test.ts).
 */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Written to the child's standard input, then closed. Used for secrets: never logged. */
  input?: string;
  timeoutMs?: number;
  /** Called with each output line as it arrives (both streams), e.g. to show setup progress. */
  onLine?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

export type Exec = (file: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export const realExec: Exec = (file, args, options = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let pending = "";
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], env: options.env ?? process.env });
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs) : undefined;
    const feed = (chunk: string) => {
      if (!options.onLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) options.onLine(line);
    };
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      stdout += c;
      feed(c);
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      stderr += c;
      feed(c);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      resolve({ code: error.code === "ENOENT" ? 127 : 1, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (pending && options.onLine) options.onLine(pending);
      resolve({ code: code ?? (signal ? 124 : 1), stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });

/** The last lines of a command's error output, redacted, for an error message. Never stdout: it may hold a password or token. */
export function errorTail(r: ExecResult, lines = 6): string {
  return redactSecrets(r.stderr)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "")
    .slice(-lines)
    .join("\n");
}

/** Throws a TapdanceError naming the command (not its arguments' secrets: callers never put secrets in arguments). */
export function check(r: ExecResult, what: string, hint?: string): ExecResult {
  if (r.code === 0) return r;
  if (r.code === 127) throw new TapdanceError("NOT_SUPPORTED", `${what}: the command is not installed or not on PATH`, hint ? { hint } : {});
  const tail = errorTail(r);
  throw new TapdanceError("INTERNAL", `${what} failed (exit ${r.code})${tail ? `:\n${tail}` : ""}`, hint ? { hint } : {});
}

export function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TapdanceError("INTERNAL", `${what} did not return JSON`);
  }
}

/** POSIX single-quote quoting for a remote shell command line (ssh runs one). */
export function shQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shJoin(args: string[]): string {
  return args.map(shQuote).join(" ");
}

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
