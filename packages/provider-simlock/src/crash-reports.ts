import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TapdanceError } from "@tapdance/core";

/**
 * iOS simulator crash reports (#59). A simulator app's crash lands on the Mac, in the account's
 * ~/Library/Logs/DiagnosticReports, next to the Mac's own apps' reports. Only reports that name the
 * leased simulator (its UDID appears in the report's paths) and were written after the lease began
 * are listed or read, so a client never sees the host's own crashes or another lease's.
 */

export interface CrashReportInfo {
  /** File name, e.g. Pianolune-2026-11-02-225531.ips: what `pull` takes. */
  name: string;
  app?: string;
  bundleId?: string;
  version?: string;
  time: string;
  /** e.g. "EXC_BREAKPOINT (SIGTRAP)". */
  exception?: string;
}

export interface CrashFilter {
  /** The leased simulator's UDID; a report must contain it. */
  udid: string;
  /** Only reports written at or after this time (ms since epoch). */
  since: number;
  /** Only this app's reports. */
  bundleId?: string;
}

const NAME = /^[A-Za-z0-9 _.+-]{1,200}\.ips$/;

export function crashReportsDir(home: string = homedir()): string {
  return join(home, "Library", "Logs", "DiagnosticReports");
}

/** The leased simulator's crash reports, newest first. */
export async function listCrashReports(dir: string, filter: CrashFilter): Promise<CrashReportInfo[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => NAME.test(n));
  const out: Array<CrashReportInfo & { mtime: number }> = [];
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (!info?.isFile() || info.mtimeMs < filter.since || info.size > 20 * 1024 * 1024) continue;
    const text = await readFile(join(dir, name), "utf8").catch(() => undefined);
    if (!text || !text.includes(filter.udid)) continue;
    const header = parseHeader(text);
    if (filter.bundleId && header.bundleId !== filter.bundleId) continue;
    out.push({ name, ...header, time: new Date(info.mtimeMs).toISOString(), mtime: info.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime).map(({ mtime: _mtime, ...r }) => r);
}

/** One report's text, when it passes the same filter; "latest" picks the newest. */
export async function readCrashReport(dir: string, name: string, filter: CrashFilter): Promise<{ name: string; text: string }> {
  const list = await listCrashReports(dir, filter);
  const pick = name === "latest" ? list[0] : list.find((r) => r.name === name);
  if (!pick) {
    throw new TapdanceError("ELEMENT_NOT_FOUND", name === "latest" ? "No crash report from this lease's simulator" : `No crash report ${name} from this lease's simulator`, {
      hint: "List them with `tapdance device crashes`; reports appear a few seconds after the crash.",
    });
  }
  return { name: pick.name, text: await readFile(join(dir, pick.name), "utf8") };
}

function parseHeader(text: string): Omit<CrashReportInfo, "name" | "time"> {
  const nl = text.indexOf("\n");
  try {
    const h = JSON.parse(text.slice(0, nl)) as Record<string, unknown>;
    const b = JSON.parse(text.slice(nl + 1)) as { exception?: { type?: string; signal?: string } };
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const exception = b.exception?.type ? `${b.exception.type}${b.exception.signal ? ` (${b.exception.signal})` : ""}` : undefined;
    return {
      ...(str(h["app_name"]) ? { app: str(h["app_name"])! } : {}),
      ...(str(h["bundleID"]) ? { bundleId: str(h["bundleID"])! } : {}),
      ...(str(h["app_version"]) ? { version: str(h["app_version"])! } : {}),
      ...(exception ? { exception } : {}),
    };
  } catch {
    return {};
  }
}

/** The crash in a few lines: exception, then the crashed thread's top frames with their symbols. */
export function summarizeCrash(text: string, frames = 15): string[] {
  const nl = text.indexOf("\n");
  let body: {
    exception?: { type?: string; signal?: string; codes?: string };
    faultingThread?: number;
    threads?: Array<{ frames?: Array<{ imageIndex?: number; symbol?: string; symbolLocation?: number; sourceFile?: string; sourceLine?: number }>; queue?: string }>;
    usedImages?: Array<{ name?: string }>;
    asi?: Record<string, string[]>;
  };
  try {
    body = JSON.parse(text.slice(nl + 1)) as typeof body;
  } catch {
    return ["Not a JSON crash report (.ips); read the file itself."];
  }
  const lines: string[] = [];
  if (body.exception) lines.push(`Exception: ${body.exception.type ?? "?"}${body.exception.signal ? ` (${body.exception.signal})` : ""}${body.exception.codes ? ` codes ${body.exception.codes}` : ""}`);
  for (const [lib, msgs] of Object.entries(body.asi ?? {})) for (const m of msgs.slice(0, 2)) lines.push(`${lib}: ${m}`);
  const ft = body.faultingThread ?? 0;
  const thread = body.threads?.[ft];
  lines.push(`Crashed thread ${ft}${thread?.queue ? ` (${thread.queue})` : ""}${ft === 0 ? " (main)" : " (not the main thread)"}:`);
  for (const [i, f] of (thread?.frames ?? []).slice(0, frames).entries()) {
    const image = f.imageIndex !== undefined ? body.usedImages?.[f.imageIndex]?.name ?? "?" : "?";
    const where = f.sourceFile ? ` ${f.sourceFile}:${f.sourceLine ?? "?"}` : "";
    const symbol = f.symbol ? `${f.symbol.length > 160 ? `${f.symbol.slice(0, 160)}…` : f.symbol}${f.symbolLocation !== undefined ? `+${f.symbolLocation}` : ""}` : "?";
    lines.push(`  ${String(i).padStart(2)} ${image.padEnd(24)} ${symbol}${where}`);
  }
  return lines;
}
