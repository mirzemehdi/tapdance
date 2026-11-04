import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    provider: z.enum(PROVIDER_KINDS).default("local"),
    /** Base URL of a Simlock worker or gateway, e.g. https://gateway.example.com. Local mode defaults it. */
    endpoint: httpUrl.optional(),
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
];

/** Removes the user-only keys from a project file's contents, returning what was there. */
function stripUserOnly(project: Record<string, unknown>): { kept: Record<string, unknown>; removed: Array<{ key: string; path: readonly [string, string]; value: unknown }> } {
  const kept: Record<string, unknown> = { ...project };
  const removed: Array<{ key: string; path: readonly [string, string]; value: unknown }> = [];
  for (const path of USER_ONLY_CONFIG_KEYS) {
    const [section, key] = path;
    const value = kept[section];
    if (value === null || typeof value !== "object" || Array.isArray(value) || !(key in value)) continue;
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

async function readJson(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new TapdanceError("CONFIG_INVALID", `Cannot read ${path}`, { cause: error });
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new TapdanceError("CONFIG_INVALID", `${path} is not a JSON object: ${(error as Error).message}`, {
      hint: `Fix the file, or run \`tapdance init --force\` to rewrite it.`,
    });
  }
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
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

  const userPath = userConfigPath(env);
  if (existsSync(userPath)) {
    const user = await readJson(userPath);
    merged = deepMerge(merged, user);
    if (user["endpoint"] !== undefined) endpointSource = "user";
    userEndpoint = typeof user["endpoint"] === "string" ? user["endpoint"] : undefined;
    sources.push(userPath);
  }
  const projectPath = options.configPath ?? env["TAPDANCE_CONFIG"] ?? findProjectConfig(cwd);
  if (projectPath !== undefined) {
    if (!existsSync(projectPath)) {
      throw new TapdanceError("CONFIG_INVALID", `Config file ${projectPath} does not exist`);
    }
    const { kept, removed } = stripUserOnly(await readJson(projectPath));
    ignored = removed;
    merged = deepMerge(merged, kept);
    // Repeating the user's own endpoint does not make it the project's.
    const projectEndpoint = kept["endpoint"];
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
  return {
    config,
    sources,
    credentials,
    credentialSources,
    home: tapdanceHome(env),
    artifactsDir,
    ...(config.endpoint !== undefined && endpointSource !== undefined ? { endpointSource } : {}),
    warnings,
  };
}

export async function writeJsonFile(path: string, data: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, mode === undefined ? {} : { mode });
  if (mode !== undefined) await chmod(path, mode);
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
