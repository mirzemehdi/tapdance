import { TapdanceError, targetToken, urlOrigin, type DeviceProvider, type EndpointSource, type ResolvedConfig, type ResolvedTarget } from "@tapdance/core";
import { SimlockProvider, defaultProfilePath, readLocalProfile, remoteConnection } from "@tapdance/provider-simlock";
import { RoutingProvider, type RouteTarget } from "./routing-provider.js";

/**
 * The single place that maps configuration to a provider. A hosted provider is added here, and
 * nothing in the CLI, MCP server or SDK surface changes.
 */
export async function createProvider(
  resolved: ResolvedConfig,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { fleet?: boolean } = {},
): Promise<DeviceProvider> {
  const { config } = resolved;
  // Agents never hold the operator token: it is loaded only for fleet views.
  const credentials = options.fleet ? resolved.credentials : { ...resolved.credentials, operatorToken: undefined };
  switch (config.provider) {
    case "local": {
      const connection = await readLocalProfile(config.simlock.profilePath ?? defaultProfilePath(env));
      if (credentials.operatorToken) connection.operatorToken = credentials.operatorToken;
      return new SimlockProvider(connection, { iosBackend: config.ios.uiBackend, ...(config.ios.axePath ? { axePath: config.ios.axePath } : {}) });
    }
    case "self-hosted": {
      if ((resolved.targets?.length ?? 0) > 0) {
        return new RoutingProvider(resolved.targets.map((t) => simlockTarget(resolved, t, sessionId, options.fleet ?? false)));
      }
      if (!config.endpoint) {
        throw new TapdanceError("CONFIG_INVALID", "provider is self-hosted but no endpoint is set", {
          hint: "Run `tapdance init --mode self-hosted --endpoint https://gateway.example.com` or set TAPDANCE_ENDPOINT.",
        });
      }
      const origin = urlOrigin(config.endpoint) ?? config.endpoint;
      // A token `tapdance connect` saved for this origin serves it too (TAPDANCE_ENDPOINT naming one target).
      const saved = credentials.tokens?.[origin];
      const token = credentials.token === undefined && saved !== undefined ? saved : boundToken(credentials.token, credentials.endpoint, origin, resolved.endpointSource, false);
      const operatorToken = boundToken(credentials.operatorToken, credentials.operatorEndpoint, origin, resolved.endpointSource, true);
      return new SimlockProvider(
        remoteConnection({
          endpoint: config.endpoint,
          token,
          ...(operatorToken ? { operatorToken } : {}),
          sessionId,
        }),
        { iosBackend: config.ios.uiBackend, ...(config.ios.axePath ? { axePath: config.ios.axePath } : {}) },
      );
    }
    case "cloud":
      throw new TapdanceError("NOT_SUPPORTED", "Tapdance Cloud is not available yet", {
        hint: "Use provider \"local\" or \"self-hosted\". The cloud provider will implement the same contract, so commands and MCP tools stay the same.",
      });
  }
}

/** A connect target served by its own Simlock provider, with only the token saved for its origin. */
function simlockTarget(resolved: ResolvedConfig, target: ResolvedTarget, sessionId: string, fleet: boolean): RouteTarget {
  const { config, credentials } = resolved;
  const token = targetToken(credentials, target.origin);
  const operatorToken = fleet && credentials.operatorToken !== undefined && credentials.operatorEndpoint === target.origin ? credentials.operatorToken : undefined;
  const base = { name: target.name, endpoint: target.endpoint, ...(target.platforms ? { platforms: target.platforms } : {}) };
  let provider: SimlockProvider;
  try {
    provider = new SimlockProvider(
      remoteConnection({ endpoint: target.endpoint, token, ...(operatorToken ? { operatorToken } : {}), sessionId }),
      { iosBackend: config.ios.uiBackend, ...(config.ios.axePath ? { axePath: config.ios.axePath } : {}) },
    );
  } catch (error) {
    // One target with no token (or a refused URL) must not take the others down: it reports why instead.
    const e = error instanceof TapdanceError ? error : new TapdanceError("INTERNAL", String(error));
    return { ...base, provider: unusableProvider(e), probe: async () => Promise.reject(e) };
  }
  return {
    ...base,
    provider,
    probe: async (timeoutMs) => {
      const h = await provider.http.healthz(timeoutMs);
      if (!h.ok) throw new TapdanceError("PROVIDER_UNREACHABLE", `${target.endpoint}/v1/healthz answered HTTP ${h.status}`);
      return provider.inventory();
    },
  };
}

/**
 * The token to send to `origin`, refusing to hand it to an endpoint it was not saved for. A token
 * saved for an origin goes only there; an unbound one (older credentials files, TAPDANCE_TOKEN) goes
 * only to an endpoint the user chose, never to one a repository's tapdance.config.json names.
 */
function boundToken(token: string | undefined, bound: string | undefined, origin: string, source: EndpointSource | undefined, operator: boolean): string | undefined {
  if (token === undefined) return undefined;
  const setToken = `tapdance config set-token${operator ? " --operator" : ""}`;
  const from = source === "project" ? "tapdance.config.json" : source === "env" ? "TAPDANCE_ENDPOINT" : "your user config";
  if (bound !== undefined) {
    if (bound === origin) return token;
    throw new TapdanceError("AUTH_FAILED", `Your saved ${operator ? "operator " : ""}token belongs to ${bound}, but the configuration points at ${origin} (from ${from})`, {
      hint: `If you trust ${origin}, run \`${setToken} --endpoint ${origin}\`; otherwise remove endpoint from tapdance.config.json.`,
    });
  }
  if (source !== "project") return token;
  throw new TapdanceError("CONFIG_INVALID", `This project's tapdance.config.json points at ${origin}, and your ${operator ? "operator " : ""}token is not bound to any endpoint`, {
    hint: `Re-run \`${setToken}\` in this project to bind your token to ${origin}, or set TAPDANCE_ENDPOINT.`,
  });
}
/** A provider for a target that cannot be used: doctor says why, every other call throws it. */
function unusableProvider(error: TapdanceError): DeviceProvider {
  const doctor = async () => [{ id: "provider", title: "Device provider", status: "fail" as const, detail: error.message, ...(error.hint ? { fix: error.hint } : {}) }];
  return new Proxy({} as DeviceProvider, {
    get: (_target, key) => {
      if (key === "name") return "simlock";
      if (key === "then") return undefined;
      if (key === "doctor") return doctor;
      if (key === "close") return async () => undefined;
      if (key === "workers") return async () => [];
      return async () => {
        throw error;
      };
    },
  });
}
