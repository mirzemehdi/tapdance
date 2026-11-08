import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { TapdanceError } from "./errors.js";

/**
 * Deployment modes. `local` and `self-hosted` are both served by the Simlock provider and differ
 * only in where the worker or gateway lives; `cloud` is reserved for a future hosted provider.
 */
export const PROVIDER_KINDS = ["local", "self-hosted", "cloud"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//.test(value), "must start with http:// or https://");

/** A target's name: what `--target` and `tapdance disconnect` take. */
export const TARGET_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const TargetSchema = z
  .object({
    name: z.string().regex(TARGET_NAME, "use lower-case letters, digits and dashes (at most 32)"),
    endpoint: httpUrl,
    /** Only route these platforms here (`connect --platform`); unset = whatever the host serves. */
    platforms: z.array(z.enum(["android", "ios"])).min(1).optional(),
  })
  .strict();

export type TargetConfig = z.infer<typeof TargetSchema>;

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    provider: z.enum(PROVIDER_KINDS).default("local"),
    /** Base URL of a Simlock worker or gateway, e.g. https://gateway.example.com. Local mode defaults it. */
    endpoint: httpUrl.optional(),
    /**
     * Several hosts at once (`tapdance connect`): a lease goes to the first one, in this order, that
     * serves the platform. Read only from ~/.tapdance/config.json: it decides where tokens are sent.
     */
    targets: z.array(TargetSchema).optional(),
    platforms: z
      .object({
        android: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
        ios: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
      })
      .default({ android: { enabled: true }, ios: { enabled: true } }),
    session: z
      .object({
        defaultTtlMinutes: z.number().int().min(1).max(240).default(30),
        /** Keep renewing a CLI lease in the background until it is released or this cap passes. */
        keepalive: z.boolean().default(true),
        maxSessionMinutes: z.number().int().min(1).max(24 * 60).default(240),
        /** How long a lease request may wait in the queue. The Simlock provider caps it at 330 s (its agent-device front's limit). */
        leaseWaitSeconds: z.number().int().min(0).max(3600).default(330),
        /** Release a lease nobody has used for this long (0 = never). The keepalive enforces it. */
        idleReleaseMinutes: z.number().int().min(0).max(24 * 60).default(30),
        /**
         * How long an Android emulator lease checks the guest's CPU, once it has booted with no
         * dialog in front, before handing it out (0 = skip the CPU check; boot and dialog checks run).
         */
        settleSeconds: z.number().int().min(0).max(300).default(15),
      })
      .default({ defaultTtlMinutes: 30, keepalive: true, maxSessionMinutes: 240, leaseWaitSeconds: 330, idleReleaseMinutes: 30, settleSeconds: 15 }),
    ios: z
      .object({
        /** "agent-device" works locally and through gateways; "axe" (local Mac only) drives the simulator with AXe. */
        uiBackend: z.enum(["agent-device", "axe"]).default("agent-device"),
        axePath: z.string().optional(),
      })
      .default({ uiBackend: "agent-device" }),
    artifacts: z
      .object({ directory: z.string().min(1).default("./tapdance-artifacts") })
      .default({ directory: "./tapdance-artifacts" }),
    viewer: z
      .object({
        host: z.string().default("127.0.0.1"),
        port: z.number().int().min(0).max(65535).default(4710),
        /** How long a human's touch blocks agent input, in milliseconds. */
        humanHoldMs: z.number().int().min(0).max(600_000).default(15_000),
      })
      .default({ host: "127.0.0.1", port: 4710, humanHoldMs: 15_000 }),
    tools: z
      .object({
        /** External tools agents may run through MCP execute_tool. */
        mcpEnabled: z.array(z.string()).default(["asc", "android", "axe", "maestro"]),
        /** Tools agents may run without their read-only switch (asc) or at all when they have none (fastlane). */
        allowMutation: z.array(z.string()).default([]),
        /** Absolute executable paths, when not on PATH. */
        paths: z.record(z.string(), z.string()).default({}),
      })
      .default({ mcpEnabled: ["asc", "android", "axe", "maestro"], allowMutation: [], paths: {} }),
    simlock: z
      .object({
        /** Where a local Simlock worker writes its agent-device profile (token + URL). */
        profilePath: z.string().optional(),
      })
      .default({}),
  })
  .strict();

export type TapdanceConfig = z.infer<typeof ConfigSchema>;

export interface Credentials {
  /** Agent token for a self-hosted Simlock worker or gateway. */
  token?: string;
  /** Operator token, only for fleet views such as `tapdance workers list`. */
  operatorToken?: string;
  /** The URL origin `token` was saved for; Tapdance sends the token nowhere else. Unset for older files and TAPDANCE_TOKEN. */
  endpoint?: string;
  /** The URL origin `operatorToken` was saved for. */
  operatorEndpoint?: string;
  /** Agent tokens of `tapdance connect` targets, keyed by URL origin: each goes only to its origin. */
  tokens?: Record<string, string>;
}

/** A configured connect target, resolved: its token is looked up by `origin`. */
export interface ResolvedTarget extends TargetConfig {
  origin: string;
}

/** Where the resolved `endpoint` came from: a repository's file is not trusted with an unbound token. */
export type EndpointSource = "user" | "project" | "env";

export interface ResolvedConfig {
  config: TapdanceConfig;
  /** Files that contributed, lowest precedence first. */
  sources: string[];
  credentials: Credentials;
  /** Where credentials came from, for doctor output; never the values. */
  credentialSources: string[];
  home: string;
  artifactsDir: string;
  /** Where `config.endpoint` came from, when it is set. */
  endpointSource?: EndpointSource;
  /** Settings Tapdance ignored, for `config show` and doctor. */
  warnings: string[];
  /**
   * The connect targets leases are routed across (self-hosted only). Empty when a single endpoint is
   * in use: an older config with `endpoint`, or TAPDANCE_ENDPOINT / a project file naming one.
   */
  targets: ResolvedTarget[];
}

/**
 * Settings that pick which executables run, which agents may mutate, and where a local token is
 * read from. A repository's tapdance.config.json could otherwise point them at anything, so they are
 * read only from the user's ~/.tapdance/config.json and the environment.
 */
export const USER_ONLY_CONFIG_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["tools", "paths"],
  ["tools", "mcpEnabled"],
  ["tools", "allowMutation"],
  ["ios", "axePath"],
  ["simlock", "profilePath"],
  // Which interface `tapdance view` listens on: a repository must not open it to the network.
  ["viewer", "host"],
];

/** Removes the user-only keys from a project file's contents, returning what was there. */
function stripUserOnly(project: Record<string, unknown>): { kept: Record<string, unknown>; removed: Array<{ key: string; path: readonly [string, string]; value: unknown }> } {
  const kept: Record<string, unknown> = { ...project };
  const removed: Array<{ key: string; path: readonly [string, string]; value: unknown }> = [];
  for (const path of USER_ONLY_CONFIG_KEYS) {
    const [section, key] = path;
    const value = kept[section];
    if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) continue;
    const { [key]: dropped, ...rest } = value as Record<string, unknown>;
    kept[section] = rest;
    removed.push({ key: `${section}.${key}`, path, value: dropped });
  }
  return { kept, removed };
}

/** A URL's origin (`https://gw.example.com:8443`), or undefined when it is not a URL. */
export function urlOrigin(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

export const PROJECT_CONFIG_FILE = "tapdance.config.json";

export function tapdanceHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["TAPDANCE_HOME"] ?? join(homedir(), ".tapdance");
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(tapdanceHome(env), "config.json");
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(tapdanceHome(env), "credentials.json");
}

/** Walks up from `cwd` to the nearest tapdance.config.json, like git does for .git. */
export function findProjectConfig(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, PROJECT_CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Keys that name an object's prototype machinery: no config or credentials file has a reason to use them. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** The dotted path of the first reserved key anywhere in a parsed JSON value, if there is one. */
function reservedKeyPath(value: unknown, path: readonly string[] = []): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (RESERVED_KEYS.has(key)) return [...path, key].join(".");
    const found = reservedKeyPath(child, [...path, key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new TapdanceError("CONFIG_INVALID", `Cannot read ${path}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
  } catch (error) {
    throw new TapdanceError("CONFIG_INVALID", `${path} is not a JSON object: ${(error as Error).message}`, {
      hint: `Fix the file, or run \`tapdance init --force\` to rewrite it.`,
    });
  }
  // JSON.parse keeps these as own keys; merged into an object they would set its prototype.
  const reserved = reservedKeyPath(parsed);
  if (reserved !== undefined) {
    throw new TapdanceError("CONFIG_INVALID", `${path} uses the reserved key "${reserved}"`, {
      hint: "Remove it: __proto__, constructor and prototype are not settings.",
    });
  }
  return parsed as Record<string, unknown>;
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (RESERVED_KEYS.has(key)) continue;
    const current = Object.hasOwn(out, key) ? out[key] : undefined;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      out[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function int(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new TapdanceError("CONFIG_INVALID", `${name} must be an integer, got "${raw}"`);
  }
  return value;
}

/** Environment overrides, highest precedence. Secrets come only from env or the credentials file. */
export function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (env["TAPDANCE_PROVIDER"]) out["provider"] = env["TAPDANCE_PROVIDER"];
  if (env["TAPDANCE_ENDPOINT"]) out["endpoint"] = env["TAPDANCE_ENDPOINT"];
  if (env["TAPDANCE_ARTIFACTS_DIR"]) out["artifacts"] = { directory: env["TAPDANCE_ARTIFACTS_DIR"] };
  const ttl = int(env, "TAPDANCE_TTL_MINUTES");
  const settle = int(env, "TAPDANCE_SETTLE_SECONDS");
  if (ttl !== undefined || settle !== undefined) {
    out["session"] = { ...(ttl !== undefined ? { defaultTtlMinutes: ttl } : {}), ...(settle !== undefined ? { settleSeconds: settle } : {}) };
  }
  const port = int(env, "TAPDANCE_VIEWER_PORT");
  if (port !== undefined) out["viewer"] = { port };
  if (env["TAPDANCE_SIMLOCK_PROFILE"]) out["simlock"] = { profilePath: env["TAPDANCE_SIMLOCK_PROFILE"] };
  return out;
}

export function parseConfig(raw: unknown, source = "configuration"): TapdanceConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new TapdanceError("CONFIG_INVALID", `Invalid ${source}: ${issues}`, {
      hint: "Run `tapdance config show` to see the merged configuration.",
    });
  }
  return result.data;
}

export async function loadCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ credentials: Credentials; sources: string[] }> {
  const credentials: Credentials = {};
  const sources: string[] = [];
  const file = credentialsPath(env);
  if (existsSync(file)) {
    const data = await readJson(file);
    if (typeof data["token"] === "string") credentials.token = data["token"];
    if (typeof data["operatorToken"] === "string") credentials.operatorToken = data["operatorToken"];
    const endpoint = typeof data["endpoint"] === "string" ? urlOrigin(data["endpoint"]) : undefined;
    if (endpoint && credentials.token) credentials.endpoint = endpoint;
    const operatorEndpoint = typeof data["operatorEndpoint"] === "string" ? urlOrigin(data["operatorEndpoint"]) : undefined;
    if (operatorEndpoint && credentials.operatorToken) credentials.operatorEndpoint = operatorEndpoint;
    const tokens = data["tokens"];
    if (tokens !== null && typeof tokens === "object" && !Array.isArray(tokens)) {
      for (const [key, value] of Object.entries(tokens as Record<string, unknown>)) {
        const origin = urlOrigin(key);
        if (origin && typeof value === "string" && value) (credentials.tokens ??= {})[origin] = value;
      }
    }
    sources.push(file);
  }
  // A token from the environment is bound to no origin.
  if (env["TAPDANCE_TOKEN"]) {
    credentials.token = env["TAPDANCE_TOKEN"];
    delete credentials.endpoint;
    sources.push("TAPDANCE_TOKEN");
  }
  if (env["TAPDANCE_OPERATOR_TOKEN"]) {
    credentials.operatorToken = env["TAPDANCE_OPERATOR_TOKEN"];
    delete credentials.operatorEndpoint;
    sources.push("TAPDANCE_OPERATOR_TOKEN");
  }
  return { credentials, sources };
}

/** Merges defaults ← ~/.tapdance/config.json ← nearest tapdance.config.json ← env. */
export async function loadConfig(
  options: { cwd?: string; env?: NodeJS.ProcessEnv; configPath?: string } = {},
): Promise<ResolvedConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const sources: string[] = [];
  let merged: Record<string, unknown> = {};

  let endpointSource: EndpointSource | undefined;
  let ignored: Array<{ key: string; path: readonly [string, string]; value: unknown }> = [];
  let userEndpoint: string | undefined;
  let projectTargetsIgnored: string | undefined;

  const userPath = userConfigPath(env);
  if (existsSync(userPath)) {
    const user = await readJson(userPath);
    merged = deepMerge(merged, user);
    const ownEndpoint = Object.hasOwn(user, "endpoint") ? user["endpoint"] : undefined;
    if (ownEndpoint !== undefined) endpointSource = "user";
    userEndpoint = typeof ownEndpoint === "string" ? ownEndpoint : undefined;
    sources.push(userPath);
  }
  const projectPath = options.configPath ?? env["TAPDANCE_CONFIG"] ?? findProjectConfig(cwd);
  if (projectPath !== undefined) {
    if (!existsSync(projectPath)) {
      throw new TapdanceError("CONFIG_INVALID", `Config file ${projectPath} does not exist`);
    }
    const { kept, removed } = stripUserOnly(await readJson(projectPath));
    ignored = removed;
    if (Object.hasOwn(kept, "targets")) {
      delete kept["targets"];
      projectTargetsIgnored = projectPath;
    }
    merged = deepMerge(merged, kept);
    // Repeating the user's own endpoint does not make it the project's.
    const projectEndpoint = Object.hasOwn(kept, "endpoint") ? kept["endpoint"] : undefined;
    if (projectEndpoint !== undefined && (typeof projectEndpoint !== "string" || userEndpoint === undefined || urlOrigin(projectEndpoint) !== urlOrigin(userEndpoint))) {
      endpointSource = "project";
    }
    sources.push(projectPath);
  }
  const overrides = envOverrides(env);
  if (overrides["endpoint"] !== undefined) endpointSource = "env";
  if (Object.keys(overrides).length > 0) {
    merged = deepMerge(merged, overrides);
    sources.push("environment");
  }
  if ("token" in merged || "operatorToken" in merged) {
    throw new TapdanceError("CONFIG_INVALID", "Tokens must not be stored in config files", {
      hint: "Remove the token from the file and run `tapdance config set-token` or set TAPDANCE_TOKEN.",
    });
  }

  const config = parseConfig(merged, sources.at(-1) ?? "configuration");
  const { credentials, sources: credentialSources } = await loadCredentials(env);
  const base = projectPath === undefined ? cwd : dirname(projectPath);
  const artifactsDir = isAbsolute(config.artifacts.directory)
    ? config.artifacts.directory
    : resolve(base, config.artifacts.directory);
  const warnings: string[] = [];
  for (const { key, path, value } of ignored) {
    const effective = (config as unknown as Record<string, Record<string, unknown>>)[path[0]]?.[path[1]];
    if (JSON.stringify(value) !== JSON.stringify(effective)) {
      warnings.push(`Ignored ${key} from ${projectPath}: security settings are read only from ~/.tapdance/config.json (\`tapdance config set --global\`) or the environment`);
    }
  }
  if (projectTargetsIgnored) warnings.push(`Ignored targets from ${projectTargetsIgnored}: connect targets are read only from ~/.tapdance/config.json (\`tapdance connect\`)`);
  // A single endpoint from the environment or a project file wins: it names one host on purpose.
  const single = endpointSource === "env" || endpointSource === "project";
  const targets: ResolvedTarget[] =
    config.provider === "self-hosted" && !single ? (config.targets ?? []).map((t) => ({ ...t, origin: urlOrigin(t.endpoint) ?? t.endpoint })) : [];
  if (targets.length > 0 && config.endpoint !== undefined) warnings.push(`endpoint ${config.endpoint} is ignored: targets are set (\`tapdance connect --list\`)`);
  return {
    config,
    sources,
    credentials,
    credentialSources,
    home: tapdanceHome(env),
    artifactsDir,
    ...(config.endpoint !== undefined && endpointSource !== undefined ? { endpointSource } : {}),
    warnings,
    targets,
  };
}

/** The saved agent token for a connect target's origin, never one saved for another origin. */
export function targetToken(credentials: Credentials, origin: string): string | undefined {
  const saved = credentials.tokens?.[origin];
  if (saved !== undefined) return saved;
  // An older single-target file: its token goes to the origin it was saved for.
  if (credentials.token !== undefined && credentials.endpoint === origin) return credentials.token;
  return undefined;
}

/**
 * A target name from an endpoint's host: `https://n2-host.tail1234.ts.net` → `n2-host`, an IP address
 * → its digits with dashes. `taken` names are avoided with a numeric suffix.
 */
export function targetNameFor(endpoint: string, taken: readonly string[] = []): string {
  let host = "";
  try {
    host = new URL(endpoint).hostname;
  } catch {
    host = endpoint;
  }
  const ip = /^[\d.]+$/.test(host) || host.includes(":");
  const raw = (ip ? host : host.split(".")[0] ?? host).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = (TARGET_NAME.test(raw) ? raw : `host-${raw}`.replace(/-+$/, "")).slice(0, 28) || "host";
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`;
  return name;
}

export async function writeJsonFile(path: string, data: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // A temp file renamed into place: a process reading the file meanwhile (an MCP server starting, a
  // second `connect`) sees the old or the new content, never a half-written one, and a token file is
  // mode 600 from its first byte (review).
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: mode ?? 0o644 });
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Merges `update` into ~/.tapdance/credentials.json (mode 600). Endpoints are stored as URL origins.
 * A new token saved without its endpoint drops the old binding, so it never inherits another
 * token's origin.
 */
export async function saveCredentials(update: Credentials, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const file = credentialsPath(env);
  const current: Credentials = existsSync(file) ? ((await readJson(file)) as Credentials) : {};
  const next: Credentials = { ...current, ...update };
  if (update.tokens !== undefined) {
    // Merged per origin; an empty string removes that origin's token.
    const tokens: Record<string, string> = { ...(current.tokens ?? {}) };
    for (const [key, value] of Object.entries(update.tokens)) {
      const origin = urlOrigin(key);
      if (origin === undefined || !/^https?:/.test(origin)) throw new TapdanceError("USAGE", `${key} is not an http(s) URL`);
      if (value) tokens[origin] = value;
      else delete tokens[origin];
    }
    if (Object.keys(tokens).length > 0) next.tokens = tokens;
    else delete next.tokens;
  }
  for (const [tokenKey, endpointKey] of [["token", "endpoint"], ["operatorToken", "operatorEndpoint"]] as const) {
    if (update[tokenKey] !== undefined && update[endpointKey] === undefined) delete next[endpointKey];
    const endpoint = next[endpointKey];
    if (endpoint !== undefined) {
      const origin = urlOrigin(endpoint);
      if (origin === undefined || !/^https?:/.test(origin)) {
        throw new TapdanceError("USAGE", `${endpoint} is not an http(s) URL`, { hint: "Pass the gateway's base URL, e.g. https://gateway.example.com." });
      }
      next[endpointKey] = origin;
    }
  }
  await writeJsonFile(file, next, 0o600);
  return file;
}

/** Writes a config file with only the keys the user chose, plus a schema pointer for editors. */
export async function writeConfigFile(path: string, config: Partial<TapdanceConfig>): Promise<void> {
  parseConfig(config, path);
  await writeJsonFile(path, config);
}

/**
 * Moves an older single-target token (`token` + `endpoint`) into the per-origin `tokens` map, for the
 * endpoint it served: its bound origin, or `origin` (the user config's endpoint) when it is unbound.
 * Returns the origin it moved to, or undefined when there was nothing to move.
 */
export async function migrateLegacyToken(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const file = credentialsPath(env);
  if (!existsSync(file)) return undefined;
  const current = (await readJson(file)) as Credentials;
  if (typeof current.token !== "string") return undefined;
  const to = (typeof current.endpoint === "string" ? urlOrigin(current.endpoint) : undefined) ?? origin;
  if (to === undefined) return undefined;
  const { token, endpoint: _endpoint, ...rest } = current;
  const next: Credentials = { ...rest, tokens: { ...(current.tokens ?? {}), ...(current.tokens?.[to] ? {} : { [to]: token }) } };
  await writeJsonFile(file, next, 0o600);
  return to;
}
