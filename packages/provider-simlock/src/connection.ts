import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TapdanceError } from "@tapdance/core";

/** How Tapdance reaches one Simlock worker or gateway. */
export interface SimlockConnection {
  kind: "local" | "remote";
  /** Simlock's HTTP base, without `/v1`. */
  baseUrl: string;
  token: string;
  operatorToken?: string;
  /** agent-device proxy fields. Simlock overwrites the tenant with the token's identity. */
  tenant: string;
  runId: string;
  clientId: string;
  source: string;
}

/** What a standalone Simlock worker writes for agents on the same machine (Simlock ADR 0046). */
interface LocalProfile {
  daemonBaseUrl?: string;
  daemonAuthToken?: string;
  tenant?: string;
  runId?: string;
  clientId?: string;
}

export function defaultProfilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["SIMLOCK_HOME"] ?? join(homedir(), ".simlock"), "agent-device-profile.json");
}

const AGENT_DEVICE_SUFFIX = /\/v1\/agent-device\/?$/;

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function readLocalProfile(path: string): Promise<SimlockConnection> {
  if (!existsSync(path)) {
    const configFile = join(path, "..", "config.json");
    if (existsSync(configFile)) {
      try {
        const cfg = JSON.parse(await readFile(configFile, "utf8")) as { gateway?: { url?: string } };
        if (cfg.gateway?.url) {
          throw new TapdanceError("PROVIDER_UNAVAILABLE", `This machine's worker has joined the gateway ${cfg.gateway.url}, so it serves agents only through the gateway`, {
            hint: `Use the gateway here too: tapdance init --mode self-hosted --endpoint ${cfg.gateway.url.replace(/^ws/, "http")} (or \`tapdance worker logout\` to serve local agents again).`,
          });
        }
      } catch (error) {
        if (error instanceof TapdanceError) throw error;
      }
    }
    throw new TapdanceError("PROVIDER_UNAVAILABLE", `No local Simlock worker profile at ${path}`, {
      hint:
        "Start the local worker with `tapdance worker start` (it runs `simlock daemon start`), " +
        "and make sure agent-device is installed so the worker serves it.",
    });
  }
  let profile: LocalProfile;
  try {
    profile = JSON.parse(await readFile(path, "utf8")) as LocalProfile;
  } catch (error) {
    throw new TapdanceError("PROVIDER_UNAVAILABLE", `Cannot read ${path}`, { cause: error });
  }
  if (!profile.daemonBaseUrl || !profile.daemonAuthToken) {
    throw new TapdanceError("PROVIDER_UNAVAILABLE", `${path} names no agent-device URL or token`, {
      hint: "Restart the worker (`tapdance worker restart`) so Simlock rewrites the profile.",
    });
  }
  return {
    kind: "local",
    baseUrl: stripTrailingSlash(profile.daemonBaseUrl.replace(AGENT_DEVICE_SUFFIX, "")),
    token: profile.daemonAuthToken,
    tenant: profile.tenant ?? "local",
    runId: profile.runId ?? "simlock-local",
    clientId: profile.clientId ?? clientIdFor("local"),
    source: path,
  };
}

/** 16 hex characters, stable per session: agent-device's client id. */
export function clientIdFor(seed: string): string {
  return createHash("sha256").update(`tapdance:${seed}`).digest("hex").slice(0, 16);
}

export function remoteConnection(options: {
  endpoint: string;
  token: string | undefined;
  operatorToken?: string;
  sessionId: string;
}): SimlockConnection {
  if (!options.token) {
    throw new TapdanceError("AUTH_FAILED", `No agent token for ${options.endpoint}`, {
      hint:
        "Create one on the gateway (`simlock --gateway token create --role agent --label <agent>`), then " +
        "store it with `tapdance config set-token` or export TAPDANCE_TOKEN.",
    });
  }
  const url = new URL(options.endpoint);
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    throw new TapdanceError("CONFIG_INVALID", `Refusing to send a token over plain HTTP to ${url.host}`, {
      hint: "Put TLS in front of the gateway (Caddy), use https://, or reach it over a private network (Tailscale, WireGuard, SSH tunnel).",
    });
  }
  return {
    kind: "remote",
    baseUrl: stripTrailingSlash(options.endpoint.replace(AGENT_DEVICE_SUFFIX, "")),
    token: options.token,
    ...(options.operatorToken === undefined ? {} : { operatorToken: options.operatorToken }),
    tenant: "tapdance",
    runId: "tapdance",
    clientId: clientIdFor(options.sessionId),
    source: "config",
  };
}

/** Loopback, RFC 1918, link-local, CGNAT (Tailscale's 100.64/10) and Tailscale .ts.net names. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost") || h.endsWith(".ts.net")) return true;
  const parts = h.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
