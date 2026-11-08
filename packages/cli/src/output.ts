import { redactObject, redactSecrets, toTapdanceError, type DoctorCheck } from "@tapdance/sdk";

/**
 * One rule for every command: the result goes to stdout (JSON with --json, text otherwise);
 * progress, warnings and human-facing errors go to stderr; the exit code says what happened.
 */
export class Output {
  constructor(readonly jsonMode: boolean, private readonly quiet = false) {}

  progress(message: string): void {
    if (!this.quiet) process.stderr.write(`${dim("›")} ${redactSecrets(message)}\n`);
  }

  warn(message: string): void {
    process.stderr.write(`${yellow("warning:")} ${redactSecrets(message)}\n`);
  }

  result(data: unknown, human: () => string): void {
    if (this.jsonMode) process.stdout.write(`${JSON.stringify(redactObject(data), null, 2)}\n`);
    else {
      const text = human();
      if (text) process.stdout.write(`${redactSecrets(text)}\n`);
    }
  }

  /**
   * For the few commands whose purpose is to hand a person a secret once (gateway setup, gateway
   * token). Everything else goes through `result`, which redacts.
   */
  secretResult(data: unknown, human: () => string): void {
    if (this.jsonMode) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    else process.stdout.write(`${human()}\n`);
  }

  error(error: unknown): number {
    const e = toTapdanceError(error);
    if (this.jsonMode) {
      process.stdout.write(`${JSON.stringify({ error: e.toJSON() }, null, 2)}\n`);
    } else {
      process.stderr.write(`${red("error")} ${dim(`[${e.code}]`)} ${e.message}\n`);
      if (e.hint) process.stderr.write(`  ${bold("fix:")} ${e.hint}\n`);
      if (process.env["TAPDANCE_DEBUG"] && e.cause) process.stderr.write(`${String((e.cause as Error).stack ?? e.cause)}\n`);
    }
    return e.exitCode;
  }
}

const tty = process.stdout.isTTY && process.stderr.isTTY && !process.env["NO_COLOR"];
const paint = (code: number) => (s: string) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);

export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ")).join("\n");
}

export function kv(pairs: Array<[string, string | undefined]>): string {
  const shown = pairs.filter((p): p is [string, string] => p[1] !== undefined && p[1] !== "");
  const width = Math.max(...shown.map(([k]) => k.length));
  return shown.map(([k, v]) => `${dim(`${k}:`.padEnd(width + 1))} ${v}`).join("\n");
}

const MARK: Record<DoctorCheck["status"], string> = { pass: green("✓"), warn: yellow("!"), fail: red("✗"), skip: dim("–") };

export function renderChecks(checks: DoctorCheck[]): string {
  // With several connect targets, each host's checks form one section under its "Target <name>" line.
  let section: string | undefined;
  const lines = checks.map((c) => {
    const opens = c.target !== undefined && c.target !== section;
    const closes = c.target === undefined && section !== undefined;
    section = c.target;
    const indent = c.target !== undefined && !opens ? "  " : "";
    const head = `${opens || closes ? "\n" : ""}${indent}${MARK[c.status]} ${opens ? bold(c.title) : c.title}${dim(` — ${c.detail}`)}`;
    return c.fix && c.status !== "pass" ? `${head}\n${indent}    ${bold("fix:")} ${c.fix}` : head;
  });
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  lines.push("", fails ? red(`${fails} problem(s), ${warns} warning(s)`) : warns ? yellow(`OK with ${warns} warning(s)`) : green("All checks passed"));
  return lines.join("\n");
}
