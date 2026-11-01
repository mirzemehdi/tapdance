import { TapdanceError, urlOrigin, type DeviceProvider, type EndpointSource, type ResolvedConfig } from "@tapdance/core";
import { SimlockProvider, defaultProfilePath, readLocalProfile, remoteConnection } from "@tapdance/provider-simlock";

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
      if (!config.endpoint) {
        throw new TapdanceError("CONFIG_INVALID", "provider is self-hosted but no endpoint is set", {
          hint: "Run `tapdance init --mode self-hosted --endpoint https://gateway.example.com` or set TAPDANCE_ENDPOINT.",
        });
      }
      const origin = urlOrigin(config.endpoint) ?? config.endpoint;
      const token = boundToken(credentials.token, credentials.endpoint, origin, resolved.endpointSource, false);
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