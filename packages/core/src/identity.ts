import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { writeJsonFile } from "./config.js";

/**
 * Agent tools that hand their session id to child processes. The first one set wins, so every
 * `tapdance` call inside one Claude Code session — sub-agents included — is the same session.
 * Same order Simlock uses (src/agent-identity, MIT), so a session is one identity in both tools.
 *
 * Codex and pi do not pass their variables to MCP servers they start, so under them the MCP server
 * falls back to a per-process identity: use either the CLI or the MCP server in one session, or set
 * TAPDANCE_SESSION_ID in both the shell and the MCP config.
 */
const AGENT_SESSION_VARIABLES = [
  { tool: "claude-code", variable: "CLAUDE_CODE_SESSION_ID" },
  { tool: "codex", variable: "CODEX_SESSION_ID" },
  { tool: "pi", variable: "PI_SESSION_ID" },
] as const;

export interface SessionIdentity {
  id: string;
  source: string;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function sanitizeSessionId(raw: string): string {
  if (SAFE_ID.test(raw)) return raw;
  return `h-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

/** TAPDANCE_SESSION_ID, then the agent's own session; undefined when neither is set. */
export function agentSessionIdentity(env: NodeJS.ProcessEnv = process.env): SessionIdentity | undefined {
  const explicit = env["TAPDANCE_SESSION_ID"];
  if (explicit) return { id: sanitizeSessionId(explicit), source: "TAPDANCE_SESSION_ID" };
  for (const { tool, variable } of AGENT_SESSION_VARIABLES) {
    const value = env[variable];
    if (value) return { id: sanitizeSessionId(`${tool}:${value}`), source: variable };
  }
  return undefined;
}

/**
 * The CLI's identity: the agent session when there is one, else a per-user identity kept in
 * ~/.tapdance/identity.json, so a person typing in several terminals is one session (and one lease)
 * unless they set TAPDANCE_SESSION_ID per terminal.
 */
export async function resolveSessionIdentity(home: string, env: NodeJS.ProcessEnv = process.env): Promise<SessionIdentity> {
  const agent = agentSessionIdentity(env);
  if (agent) return agent;
  const file = join(home, "identity.json");
  if (existsSync(file)) {
    try {
      const data = JSON.parse(await readFile(file, "utf8")) as { id?: unknown };
      if (typeof data.id === "string" && SAFE_ID.test(data.id)) return { id: data.id, source: file };
    } catch {
      // A corrupt identity file is replaced below.
    }
  }
  const id = `cli:${userInfo().username.replace(/[^A-Za-z0-9._-]/g, "") || "user"}-${randomBytes(4).toString("hex")}`;
  await writeJsonFile(file, { id, createdAt: new Date().toISOString() }, 0o600);
  return { id, source: file };
}

/** The MCP server's identity: the agent session when visible, else one per server process. */
export function processSessionIdentity(env: NodeJS.ProcessEnv = process.env): SessionIdentity {
  return agentSessionIdentity(env) ?? { id: `mcp:${process.pid}-${randomBytes(4).toString("hex")}`, source: "process" };
}

/** Filesystem-safe key for a session id. */
export function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}
