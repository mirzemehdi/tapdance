import { TapdanceError, type DeviceProvider, type ResolvedConfig } from "@tapdance/core";
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
      return new SimlockProvider(
        remoteConnection({
          endpoint: config.endpoint,
          token: credentials.token,
          ...(credentials.operatorToken ? { operatorToken: credentials.operatorToken } : {}),
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
