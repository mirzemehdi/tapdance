#!/usr/bin/env node
// Field-test driver for the MCP server: starts `tapdance mcp` from this repository over stdio, runs a
// JSON checklist of tool calls, and records each reply and its latency. Dev tooling for field tests
// (docs/testing/field-test-cloud-android.md); not shipped in any package.
//
// Usage:
//   node scripts/field-test/mcp-checklist.mjs <checklist.json> <out-dir> [--param KEY=VALUE ...]
//   node scripts/field-test/mcp-checklist.mjs --check <checklist.json> [--param KEY=VALUE ...]
//
// A checklist is a JSON array of steps:
//   { "tool": "lease_device", "args": { "platform": "android" }, "label": "lease",
//     "stopOnFail": true, "timeoutSec": 900, "requires": ["APP_ID"], "expectText": "..." }
//   - "${KEY}" anywhere in a string inside "args" is replaced by a parameter. Parameters come from
//     --param KEY=VALUE or the environment as FIELD_TEST_KEY. "${OUT}" is the output directory.
//   - A step whose "requires" names a parameter that is not set is SKIPPED, not failed.
//   - "optional": ["KEY"]: an argument whose whole value is "${KEY}" is left out when KEY is unset
//     (for example a CI branch).
//   - When the APK parameter is set, its folder is added to TAPDANCE_ALLOWED_ROOTS for the server, which
//     otherwise only uploads files inside its working directory (the output directory).
//   - A step with "tool": "__list" saves the server's tool list to tools.json.
//   - "expectText": the step fails unless the reply's text contains it.
// --check validates a checklist offline against the MCP tool schemas in packages/mcp/dist (no server,
// no device, no network): tool names exist and every step's arguments parse.
//
// Environment: TAPDANCE_HOME must be set to a scratch directory, never ~/.tapdance (the owner's
// config and credentials). TAPDANCE_SESSION_ID defaults to field-test-mcp. Both are passed to the
// server, with the rest of the environment.
//
// Output: <out-dir>/results.json, server-stderr.log, images the tools returned, and a PASS/FAIL table
// with latencies on stdout. Exit code 0 when every step that ran passed, 1 otherwise, 2 on usage errors.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(REPO, "packages/cli/dist/main.js");
const SDK = join(REPO, "packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm");
const MCP_DIST = join(REPO, "packages/mcp/dist/index.js");

function die(message, code = 2) {
  process.stderr.write(`mcp-checklist: ${message}\n`);
  process.exit(code);
}

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const params = {};
const positional = [];
let check = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--check") check = true;
  else if (a === "--param") {
    const kv = argv[++i] ?? "";
    const eq = kv.indexOf("=");
    if (eq < 1) die(`--param needs KEY=VALUE, got "${kv}"`);
    params[kv.slice(0, eq)] = kv.slice(eq + 1);
  } else if (a === "-h" || a === "--help") {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
    process.stdout.write(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    process.exit(0);
  } else positional.push(a);
}
const [checklistFile, outArg] = positional;
if (!checklistFile || (!check && !outArg)) die("usage: mcp-checklist.mjs <checklist.json> <out-dir> [--param KEY=VALUE ...]  (or --check <checklist.json>)");

for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("FIELD_TEST_") && v !== undefined && !(k.slice(11) in params)) params[k.slice(11)] = v;
}
const outDir = check ? undefined : resolve(outArg);
if (outDir) params["OUT"] = outDir;

let steps;
try {
  steps = JSON.parse(readFileSync(checklistFile, "utf8"));
} catch (e) {
  die(`cannot read ${checklistFile}: ${e.message}`);
}
if (!Array.isArray(steps)) die(`${checklistFile} must hold a JSON array of steps`);

// ------------------------------------------------------------------ parameters

const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g;

/** Every ${KEY} a step uses, so a missing one can be reported before anything runs. */
function placeholders(value, found = new Set()) {
  if (typeof value === "string") for (const m of value.matchAll(PLACEHOLDER)) found.add(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => placeholders(v, found));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => placeholders(v, found));
  return found;
}

const WHOLE = /^\$\{([A-Z][A-Z0-9_]*)\}$/;

/**
 * Replaces ${KEY} in strings (the result stays a string; the tool's schema decides what it accepts).
 * A property whose whole value is "${KEY}" for an unset KEY in `optional` is left out.
 */
function substitute(value, p = params, optional = []) {
  if (typeof value === "string") return value.replace(PLACEHOLDER, (_, k) => p[k]);
  if (Array.isArray(value)) return value.map((v) => substitute(v, p, optional));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => {
          const m = typeof v === "string" ? WHOLE.exec(v) : null;
          return !(m && optional.includes(m[1]) && p[m[1]] === undefined);
        })
        .map(([k, v]) => [k, substitute(v, p, optional)]),
    );
  }
  return value;
}

/** Why a step is skipped (a required parameter is unset), or undefined when it runs. */
function skipReason(step) {
  const missing = (step.requires ?? []).filter((k) => !params[k]);
  return missing.length ? `needs ${missing.join(", ")}` : undefined;
}

/** Placeholders a running step uses but nobody set: an error in the checklist or the invocation. */
function unsetPlaceholders(step) {
  return [...placeholders(step.args ?? {})].filter((k) => params[k] === undefined && !(step.optional ?? []).includes(k));
}

// ------------------------------------------------------------------ --check

if (check) {
  if (!existsSync(MCP_DIST)) die(`${MCP_DIST} is missing: run pnpm build first`);
  const { TOOLS } = await import(pathToFileURL(MCP_DIST).href);
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  let problems = 0;
  steps.forEach((step, i) => {
    const label = step.label ?? step.tool;
    if (step.tool === "__list") return;
    const tool = byName.get(step.tool);
    if (!tool) {
      problems++;
      console.log(`FAIL ${String(i + 1).padStart(2)} ${label}: no MCP tool named "${step.tool}"`);
      return;
    }
    // Unset parameters get a sample value that fits the usual shapes (an app id, a repo, a path).
    const sample = Object.fromEntries([...placeholders(step.args ?? {})].map((k) => [k, params[k] ?? "sample.value"]));
    const parsed = tool.input.safeParse(substitute(step.args ?? {}, sample));
    if (!parsed.success) {
      problems++;
      console.log(`FAIL ${String(i + 1).padStart(2)} ${label}: ${parsed.error.issues.map((x) => `${x.path.join(".") || "(args)"}: ${x.message}`).join("; ")}`);
    } else console.log(`ok   ${String(i + 1).padStart(2)} ${label} (${step.tool})${step.requires ? `, requires ${step.requires.join(", ")}` : ""}`);
  });
  console.log(problems ? `${problems} problem(s) in ${checklistFile}` : `${checklistFile}: every step names a real tool and its arguments parse`);
  process.exit(problems ? 1 : 0);
}

// ------------------------------------------------------------------ safety

const home = process.env.TAPDANCE_HOME;
if (!home) die("set TAPDANCE_HOME to a scratch directory (for example $HOME/td-field-home): the run writes config, credentials and artifacts there");
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
if (real(home) === real(join(homedir(), ".tapdance"))) die("TAPDANCE_HOME is ~/.tapdance, the owner's own config and credentials: use a scratch directory");
if (!existsSync(CLI)) die(`${CLI} is missing: run pnpm build first`);
if (!existsSync(SDK)) die(`${SDK} is missing: run pnpm install first`);

for (const [i, step] of steps.entries()) {
  if (skipReason(step) || step.tool === "__list") continue;
  const unset = unsetPlaceholders(step);
  if (unset.length) die(`step ${i + 1} (${step.label ?? step.tool}) uses ${unset.map((k) => "${" + k + "}").join(", ")}: pass --param ${unset[0]}=... or set FIELD_TEST_${unset[0]}`);
}

// ------------------------------------------------------------------ run

mkdirSync(outDir, { recursive: true });
// A small file the push steps can send. The server only sends files inside its working directory,
// so it runs in the output directory.
writeFileSync(join(outDir, "push.txt"), `tapdance field test ${new Date().toISOString()}\n`);

const { Client } = await import(pathToFileURL(join(SDK, "client/index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(join(SDK, "client/stdio.js")).href);

const env = { ...process.env, TAPDANCE_SESSION_ID: process.env.TAPDANCE_SESSION_ID ?? "field-test-mcp" };
if (params["APK"]) {
  params["APK"] = resolve(params["APK"]);
  env.TAPDANCE_ALLOWED_ROOTS = [env.TAPDANCE_ALLOWED_ROOTS, dirname(params["APK"])].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
}
const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, cwd: outDir, stderr: "pipe" });
const stderr = [];
transport.stderr?.on("data", (d) => stderr.push(String(d)));
const client = new Client({ name: "tapdance-field-checklist", version: "1.0.0" });
const started = Date.now();
await client.connect(transport);

const results = [];
let stopped = false;
for (const [i, step] of steps.entries()) {
  const n = i + 1;
  const label = step.label ?? step.tool;
  if (step.tool === "__list") {
    const { tools } = await client.listTools();
    writeFileSync(join(outDir, "tools.json"), JSON.stringify(tools, null, 2));
    console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(" ")}`);
    continue;
  }
  const skip = stopped ? "an earlier stopOnFail step failed" : skipReason(step);
  if (skip) {
    results.push({ n, label, tool: step.tool, status: "SKIP", reason: skip });
    console.log(`SKIP ${String(n).padStart(2)} ${label.padEnd(24)} ${"".padStart(7)}     ${skip}`);
    continue;
  }
  const args = substitute(step.args ?? {}, params, step.optional ?? []);
  const t0 = performance.now();
  let reply;
  let error;
  try {
    reply = await client.callTool({ name: step.tool, arguments: args }, undefined, { timeout: (step.timeoutSec ?? 900) * 1000 });
  } catch (e) {
    error = String(e?.message ?? e);
  }
  const ms = Math.round(performance.now() - t0);
  const texts = [];
  for (const [j, c] of (reply?.content ?? []).entries()) {
    if (c.type === "text") texts.push(c.text);
    else if (c.type === "image") writeFileSync(join(outDir, `${String(n).padStart(2, "0")}-${label.replace(/[^A-Za-z0-9_.-]+/g, "_")}-${j}.png`), Buffer.from(c.data, "base64"));
  }
  const text = texts.join("\n");
  let ok = !error && !reply?.isError;
  if (ok && step.expectText && !text.includes(substitute(step.expectText))) {
    ok = false;
    error = `reply does not contain "${substitute(step.expectText)}"`;
  }
  results.push({ n, label, tool: step.tool, status: ok ? "PASS" : "FAIL", ms, ...(error ? { error } : {}), text: text.slice(0, 4000) });
  console.log(`${ok ? "PASS" : "FAIL"} ${String(n).padStart(2)} ${label.padEnd(24)} ${String(ms).padStart(7)} ms  ${(error ?? text).replace(/\s+/g, " ").slice(0, 140)}`);
  if (!ok && step.stopOnFail) stopped = true;
}

await client.close().catch(() => undefined);
const ran = results.filter((r) => r.status !== "SKIP");
const passed = ran.filter((r) => r.status === "PASS").length;
const summary = {
  checklist: resolve(checklistFile),
  startedAt: new Date(started).toISOString(),
  durationMs: Date.now() - started,
  session: env.TAPDANCE_SESSION_ID,
  params: Object.fromEntries(Object.entries(params).filter(([k]) => k !== "OUT")),
  passed,
  failed: ran.length - passed,
  skipped: results.length - ran.length,
  steps: results,
};
writeFileSync(join(outDir, "results.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(outDir, "server-stderr.log"), stderr.join(""));

console.log("");
console.log(`${"#".padStart(3)}  ${"STEP".padEnd(24)} ${"RESULT".padEnd(6)} ${"MS".padStart(7)}`);
for (const r of results) console.log(`${String(r.n).padStart(3)}  ${r.label.padEnd(24)} ${r.status.padEnd(6)} ${r.ms === undefined ? "".padStart(7) : String(r.ms).padStart(7)}`);
console.log(`${passed}/${ran.length} passed, ${summary.skipped} skipped; details in ${join(outDir, "results.json")}`);
process.exit(ran.length > 0 && passed === ran.length ? 0 : 1);
