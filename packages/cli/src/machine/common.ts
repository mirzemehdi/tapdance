import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TapdanceError, redactSecrets, toTapdanceError } from "@tapdance/sdk";
import { findTailscale, parseTailscaleStatus } from "../host/plan.js";
import { bold, dim, green, red } from "../output.js";
import { check, errorTail, parseJson, type Exec, type Sleep } from "./exec.js";
import type { MachineRecord, MachineStore } from "./state.js";

/** Everything a machine command touches outside its own logic; tests replace all of it. */
export interface MachineIo {
  exec: Exec;
  sleep: Sleep;
  now: () => Date;
  out: { progress(message: string): void; warn(message: string): void };
  store: MachineStore;
  env: NodeJS.ProcessEnv;
  /** Runs this CLI (`connect`, `disconnect`): node and the entry script. */
  self: [string, string];
  /** Scripts copied to the new machine. */
  assets: { hostSetup: string; autoLogin: string };
  verbose: boolean;
  /** Where the local tailscale binary is (undefined: not installed). */
  tailscaleBin: string | undefined;
  /** This computer's connect target names. */
  targetNames: () => Promise<string[]>;
  /** Reads a secret with echo off, or from stdin when it is not a terminal. */
  readSecret: (prompt: string) => Promise<string>;
  /** Auto mode: runs `tapdance <args>` detached, output to the log file, with `env` added; returns its pid. */
  spawnCreate: (args: string[], logFile: string, env: Record<string, string>) => Promise<number>;
  /** True while that process runs. */
  alive: (pid: number) => boolean;
  /** When a process started (ms since the epoch), or undefined when that cannot be told. */
  processStart: (pid: number) => Promise<number | undefined>;
  /** Sends a signal to a process; false when it is gone. */
  kill: (pid: number, signal: NodeJS.Signals) => boolean;
  /** This process, as recorded in a machine's create lock. */
  proc: { pid: number; startedAt: number };
  /**
   * True when this computer leases from its own local worker (provider local with a worker set up). A
   * machine is reached as a connect target, and connect targets replace the local worker.
   */
  localWorker: () => Promise<boolean>;
  /** True when a guard answers at `<endpoint>/v1/healthz`. */
  healthz: (endpoint: string) => Promise<boolean>;
}

/** The two scripts, from the npm package (dist/assets) or, in a source checkout, the repository. */
export function assetPaths(): { hostSetup: string; autoLogin: string } {
  const pick = (packed: string, repo: string) => {
    const a = fileURLToPath(new URL(packed, import.meta.url));
    return existsSync(a) ? a : fileURLToPath(new URL(repo, import.meta.url));
  };
  return {
    hostSetup: pick("../assets/host-setup.sh", "../../../../scripts/host-setup.sh"),
    autoLogin: pick("../assets/macos-auto-login.sh", "../../../../infrastructure/scripts/macos-auto-login.sh"),
  };
}

export interface Step {
  id: string;
  title: string;
  run: () => Promise<void>;
}

/**
 * Runs create's steps in order, saving the record after each, so the same command run again continues
 * where it stopped. Prints `[n/total] title` and the time each took.
 */
export async function runSteps(record: MachineRecord, steps: Step[], io: MachineIo, retry: { create: string; destroy: string }): Promise<void> {
  const total = steps.length;
  for (const [i, step] of steps.entries()) {
    const n = `[${i + 1}/${total}]`;
    if (record.done.includes(step.id)) {
      io.out.progress(`${n} ${step.title}: ${dim("done earlier")}`);
      continue;
    }
    // `machine destroy` marks the machine before it stops this create: never start another step then.
    if (await destroyingNow(io, record.name)) {
      throw new TapdanceError("CANCELLED", `Machine ${record.name} is being destroyed; its create stopped before step ${i + 1} of ${total} ("${step.title}")`);
    }
    io.out.progress(`${n} ${bold(step.title)}…`);
    const started = io.now().getTime();
    try {
      await step.run();
    } catch (error) {
      const e = toTapdanceError(error);
      const secs = Math.round((io.now().getTime() - started) / 1000);
      io.out.progress(`${n} ${red("failed")} after ${secs} s`);
      await io.store.save(record).catch(() => undefined);
      throw new TapdanceError(e.code, `Step ${i + 1} of ${total} ("${step.title}") failed: ${e.message}`, {
        hint: `${e.hint ? `${e.hint} ` : ""}Then run \`${retry.create}\` again: it continues at this step. To remove everything created so far: \`${retry.destroy}\`.`,
        ...(e.details ? { details: e.details } : {}),
      });
    }
    const secs = Math.round((io.now().getTime() - started) / 1000);
    record.done.push(step.id);
    record.timings[step.id] = secs;
    await io.store.save(record);
    io.out.progress(`${n} ${green("✓")} ${step.title} (${formatSeconds(secs)})`);
  }
}

/** True while a `machine destroy` of this machine runs (the pid in its mark is alive). */
export async function destroyingNow(io: Pick<MachineIo, "store" | "alive">, name: string): Promise<boolean> {
  const pid = await io.store.destroyingPid(name);
  return pid !== undefined && io.alive(pid);
}

export function formatSeconds(s: number): string {
  if (s < 90) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** This computer must be in a tailnet already: that is how it reaches the new machine. */
export async function checkLocalTailscale(io: MachineIo): Promise<string> {
  if (!io.tailscaleBin) {
    throw new TapdanceError("HOST_CHECK_FAILED", "Tailscale is not installed on this computer", {
      hint: "Install it from https://tailscale.com/download and log in (`sudo tailscale up` on Linux). The new machine joins the same tailnet, and this computer reaches it there.",
    });
  }
  const r = await io.exec(io.tailscaleBin, ["status", "--json"], { timeoutMs: 15_000 });
  const state = parseTailscaleStatus(r.stdout);
  if (!state.loggedIn) {
    throw new TapdanceError("HOST_CHECK_FAILED", `Tailscale on this computer is not connected (${state.backendState})`, {
      hint: "Log in with `sudo tailscale up` (Linux) or the Tailscale app (macOS), then run this again.",
    });
  }
  if (!state.https) io.out.warn("Your tailnet has no HTTPS certificates: the machine will be reached over http:// inside the tailnet. Turn them on under DNS > HTTPS Certificates in the Tailscale admin console for https:// and the live view.");
  return state.dnsName ?? "";
}

export function localTailscaleBin(): string | undefined {
  return findTailscale();
}

const LOGIN_URL = /https:\/\/login\.tailscale\.com\/a\/\S+/;
const INTERESTING = /^(host-setup:|TAPDANCE HOST READY|endpoint:|devices:|self-test:|cost guard:|error|warning|›|✓|✗|\[\d+\/\d+\])/i;

/**
 * Shows the remote setup's output: every line in --verbose, else the script's own progress lines, the
 * Tailscale login link (prominently) and errors. Every line also goes to the machine's setup.log.
 */
export function setupLineHandler(io: MachineIo, logFile: string): (line: string) => void {
  let shownLink = false;
  return (raw: string) => {
    const line = redactSecrets(raw.replace(/\u001b\[[0-9;]*m/g, "")).trimEnd();
    void appendFile(logFile, `${line}\n`, { mode: 0o600 }).catch(() => undefined);
    const link = LOGIN_URL.exec(line);
    if (link && !shownLink) {
      shownLink = true;
      io.out.progress(bold(`Open this link and approve the machine in your Tailscale network: ${link[0]}`));
      return;
    }
    if (line === "") return;
    if (io.verbose || INTERESTING.test(line.trim())) io.out.progress(`  ${dim("│")} ${line.trim()}`);
  };
}

/** Reads `tapdance host status --json` on the machine (through `remote`) and returns its endpoint. */
export async function remoteEndpoint(remote: (command: string) => Promise<{ code: number; stdout: string; stderr: string }>): Promise<string> {
  const r = await remote(`${ENV_PREFIX}tapdance host status --json`);
  const status = parseJson<{ ready?: boolean; endpoint?: string; steps?: Array<{ step: string; ok: boolean; detail: string }> }>(r.stdout.trim() || "{}", "tapdance host status on the machine");
  const endpoint = tailnetEndpoint(status.endpoint);
  if (!endpoint) {
    const bad = (status.steps ?? []).filter((s) => !s.ok).map((s) => `${s.step}: ${s.detail}`).join("; ");
    throw new TapdanceError("HOST_CHECK_FAILED", `The machine is not serving its guard on Tailscale yet${bad ? ` (${bad})` : ""}`, {
      hint: "Check that the machine was approved in the Tailscale admin console.",
    });
  }
  if (!status.ready) {
    const bad = (status.steps ?? []).filter((s) => !s.ok).map((s) => `${s.step}: ${s.detail}`).join("; ");
    throw new TapdanceError("HOST_CHECK_FAILED", `The machine's host is not ready${bad ? `: ${bad}` : ""}`);
  }
  return endpoint;
}

/**
 * The machine's endpoint as `scheme://host[:port]`, only when it is an http(s) URL on a Tailscale name
 * (`*.ts.net`) with no user info, path, query or fragment; otherwise undefined.
 */
export function tailnetEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== "/" && url.pathname !== "")) return undefined;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".ts.net") || host === ".ts.net" || !/^[a-z0-9.-]+$/.test(host)) return undefined;
  return `${url.protocol}//${url.host}`;
}

/** How the machine installs Tapdance: from npm at a version, or from source at a git ref. */
export function installArgs(record: { setupRef: string; tapdanceVersion?: string }): { env: string; args: string[] } {
  if (record.tapdanceVersion) return { env: "", args: ["--tapdance-version", record.tapdanceVersion] };
  return { env: `TAPDANCE_REF=${record.setupRef} `, args: [] };
}

/** Logs the machine out of Tailscale; exit 3/4: it never joined (Tailscale missing or logged out). */
export const TAILSCALE_LOGOUT = "[ -f ~/.tapdance/env.sh ] && . ~/.tapdance/env.sh; command -v tailscale >/dev/null 2>&1 || exit 3; tailscale status >/dev/null 2>&1 || exit 4; tailscale logout";

/** Sourced first in every remote command: host-setup.sh puts PATH, ANDROID_HOME and JAVA_HOME there. */
export const ENV_PREFIX = "[ -f ~/.tapdance/env.sh ] && . ~/.tapdance/env.sh; ";

/** The pairing token file `host up --label <label>` wrote on the machine. */
export function remoteTokenPath(label: string): string {
  return `~/.tapdance/worker/pairing-${label}.token`;
}

/**
 * Reads the pairing token on the machine and hands it to this CLI's `connect` on standard input. The
 * token stays in memory: it is never printed, logged or put in an error.
 */
export async function connectMachine(
  io: MachineIo,
  input: { endpoint: string; target: string; label: string; platform: "android" | "ios" },
  remote: (command: string) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; checks: Array<{ name: string; status: string; message?: string }> }> {
  const t = await remote(`cat ${remoteTokenPath(input.label)}`);
  const token = t.stdout.trim();
  if (t.code !== 0 || !token) {
    throw new TapdanceError("INTERNAL", `Could not read the pairing token on the machine (exit ${t.code})${errorTail(t) ? `: ${errorTail(t)}` : ""}`, {
      hint: `host up writes it to ${remoteTokenPath(input.label)}; the setup step may not have finished.`,
    });
  }
  const r = await io.exec(io.self[0], [io.self[1], "--json", "connect", input.endpoint, "--name", input.target, "--platform", input.platform], { input: `${token}\n`, env: io.env, timeoutMs: 120_000 });
  const data = parseJson<{ ok?: boolean; checks?: Array<{ name: string; status: string; message?: string }>; error?: { message?: string; hint?: string } }>(r.stdout || "{}", "tapdance connect");
  if (data.error) throw new TapdanceError("HOST_CHECK_FAILED", `tapdance connect failed: ${data.error.message ?? "unknown error"}`, data.error.hint ? { hint: data.error.hint } : {});
  return { ok: data.ok === true, checks: data.checks ?? [] };
}

/** Removes the connect target, if this computer still has it. */
export async function disconnectMachine(io: MachineIo, target: string): Promise<string> {
  const r = await io.exec(io.self[0], [io.self[1], "--json", "disconnect", target], { env: io.env, timeoutMs: 30_000 });
  if (r.code === 0) return `removed connect target ${target} and its token`;
  return `no connect target ${target} on this computer`;
}

/** Confirmation for something that costs money or cannot be undone. */
export async function confirmOrThrow(question: string, yes: boolean | undefined, ask: (q: string) => Promise<boolean>, isTty: boolean): Promise<void> {
  if (yes) return;
  if (!isTty) throw new TapdanceError("USAGE", "This needs your confirmation", { hint: "Run it in a terminal, or pass --yes once you have read what it does." });
  if (!(await ask(question))) throw new TapdanceError("USAGE", "Cancelled; nothing was changed");
}

export function setupLog(io: MachineIo, name: string): string {
  return join(io.store.dir(name), "setup.log");
}

export { check };
