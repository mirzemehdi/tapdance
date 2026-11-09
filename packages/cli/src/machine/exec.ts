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

/** After the child exits, how long to wait for its pipes to close before giving up on them (a grandchild may hold them). */
export const PIPE_GRACE_MS = 1_000;
/** After a timeout's SIGTERM, how long before SIGKILL. */
export const KILL_GRACE_MS = 5_000;

/** Process groups of the children running now, killed when this process is told to stop. */
const activeGroups = new Set<number>();
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
}

function onSignal(signal: NodeJS.Signals): void {
  for (const pid of activeGroups) killGroup(pid, "SIGTERM");
  activeGroups.clear();
  for (const s of SIGNALS) process.removeListener(s, onSignal);
  // Nobody else handles it: end the way the signal would have ended this process.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function track(pid: number): void {
  if (activeGroups.size === 0) for (const s of SIGNALS) process.on(s, onSignal);
  activeGroups.add(pid);
}

function untrack(pid: number): void {
  if (!activeGroups.delete(pid)) return;
  if (activeGroups.size === 0) for (const s of SIGNALS) process.removeListener(s, onSignal);
}

/**
 * Runs the command in its own process group, so a timeout (or this process being stopped, e.g. by
 * `machine destroy` stopping a background create) ends it and everything it started. Resolves when the
 * child exits, waiting at most PIPE_GRACE_MS more for output still in its pipes: a grandchild that
 * keeps them open (an ssh ControlMaster, a backgrounded helper) cannot hold the call forever.
 */
export const realExec: Exec = (file, args, options = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], env: options.env ?? process.env, detached: true });
    const pid = child.pid;
    if (pid !== undefined) track(pid);
    let killTimer: NodeJS.Timeout | undefined;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (pid === undefined) return;
          killGroup(pid, "SIGTERM");
          killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), KILL_GRACE_MS);
          killTimer.unref();
        }, options.timeoutMs)
      : undefined;
    const feed = (chunk: string) => {
      if (!options.onLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) options.onLine(line);
    };
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pid !== undefined) {
        // The command ended; anything it left behind in its group goes too.
        if (timedOut) killGroup(pid, "SIGKILL");
        untrack(pid);
      }
      if (killTimer) clearTimeout(killTimer);
      if (pending && options.onLine) options.onLine(pending);
      pending = "";
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
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
      finish({ code: error.code === "ENOENT" ? 127 : 1, stdout, stderr: stderr || error.message });
    });
    const exitCode = (code: number | null, signal: NodeJS.Signals | null) => (timedOut ? 124 : (code ?? (signal ? 124 : 1)));
    child.on("close", (code, signal) => finish({ code: exitCode(code, signal), stdout, stderr }));
    child.on("exit", (code, signal) => {
      setTimeout(() => finish({ code: exitCode(code, signal), stdout, stderr }), PIPE_GRACE_MS);
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
