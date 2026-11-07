import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import {
  ConfigSchema,
  PROJECT_CONFIG_FILE,
  PROVIDER_KINDS,
  TapdanceError,
  credentialsPath,
  isPrivateHost,
  loadConfig,
  redactObject,
  saveCredentials,
  urlOrigin,
  userConfigPath,
  writeConfigFile,
  type ProviderKind,
  type TapdanceConfig,
} from "@tapdance/sdk";
import { output, run, type GlobalOptions } from "./context.js";
import { bold, dim, renderChecks } from "./output.js";

async function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question}${fallback ? dim(` [${fallback}]`) : ""} `)).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

/** Reads a secret from stdin (piped) or a hidden-ish prompt; never from argv by default. */
export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stderr.write(`${prompt} `);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  return new Promise((resolveSecret, reject) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolveSecret(value.trim());
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          reject(new TapdanceError("USAGE", "Cancelled"));
          return;
        }
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * The origin a token is bound to. Refuses what is not http(s), and plain http to a public host, by
 * the same rule as the self-hosted connection: a token sent there would cross the internet in clear.
 */
export function tokenOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TapdanceError("USAGE", `${url} is not a URL`, { hint: "Pass the gateway's base URL, e.g. https://gateway.example.com." });
  }
  const origin = urlOrigin(url);
  if (origin === undefined || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new TapdanceError("USAGE", `${url} is not an http(s) URL`, { hint: "Pass the gateway's base URL, e.g. https://gateway.example.com." });
  }
  if (parsed.protocol === "http:" && !isPrivateHost(parsed.hostname)) {
    throw new TapdanceError("USAGE", `Refusing to bind a token to plain HTTP on ${parsed.host}`, {
      hint: "Put TLS in front of the gateway (Caddy), use https://, or reach it over a private network (Tailscale, WireGuard, SSH tunnel).",
    });
  }
  return origin;
}

export function registerSetupCommands(program: Command, globals: () => GlobalOptions): void {
  program
    .command("init")
    .description("Create tapdance.config.json for this project (or ~/.tapdance/config.json with --global)")
    .option("--mode <mode>", `device infrastructure: ${PROVIDER_KINDS.join(" | ")}`)
    .option("--endpoint <url>", "self-hosted: Simlock gateway or worker URL, e.g. https://gateway.example.com")
    .option("--artifacts <dir>", "where screenshots, recordings and logs go", "./tapdance-artifacts")
    .option("--ttl <minutes>", "default lease TTL", "30")
    .option("--global", "write the per-user config instead of the project one")
    .option("--force", "overwrite an existing file")
    .option("-y, --yes", "accept defaults, never prompt")
    .action(async (o: { mode?: string; endpoint?: string; artifacts: string; ttl: string; global?: boolean; force?: boolean; yes?: boolean }) => {
      const out = output(globals());
      try {
        const target = o.global ? userConfigPath() : resolve(PROJECT_CONFIG_FILE);
        if (existsSync(target) && !o.force) {
          throw new TapdanceError("USAGE", `${target} already exists`, { hint: "Pass --force to overwrite, or edit it with `tapdance config set`." });
        }
        let mode = o.mode as ProviderKind | undefined;
        const interactive = process.stdin.isTTY && !o.yes && !globals().json;
        if (mode === undefined && interactive) {
          process.stderr.write(
            `${bold("Device infrastructure:")}\n  1) Local device          emulators/simulators on this machine\n  2) Self-hosted worker    a gateway + your laptop, a KVM server or a Google Cloud N2 VM\n  3) Tapdance Cloud        not available yet\n`,
          );
          const choice = await ask("Choose 1, 2 or 3:", "1");
          mode = choice === "2" ? "self-hosted" : choice === "3" ? "cloud" : "local";
        }
        mode ??= "local";
        if (!PROVIDER_KINDS.includes(mode)) throw new TapdanceError("USAGE", `--mode must be one of ${PROVIDER_KINDS.join(", ")}`);
        if (mode === "cloud") {
          throw new TapdanceError("NOT_SUPPORTED", "Tapdance Cloud is not available yet", { hint: "Choose local or self-hosted; switching later only changes this file." });
        }
        let endpoint = o.endpoint;
        if (mode === "self-hosted" && !endpoint) {
          if (!interactive) throw new TapdanceError("USAGE", "--endpoint is required for self-hosted mode");
          endpoint = await ask("Gateway URL (https://… or a private-network http:// address):");
        }
        const config: Partial<TapdanceConfig> = {
          provider: mode,
          ...(endpoint ? { endpoint } : {}),
          session: { defaultTtlMinutes: Number(o.ttl), keepalive: true, maxSessionMinutes: 240, leaseWaitSeconds: 330, idleReleaseMinutes: 30, settleSeconds: 15 },
          artifacts: { directory: o.artifacts },
        };
        await writeConfigFile(target, config);
        let tokenNote = "";
        if (mode === "self-hosted" && interactive) {
          const token = await readSecret("Agent token for this gateway (input hidden, Enter to skip):");
          if (token) {
            // Bound to this endpoint: the token is never sent to an endpoint a project file names later.
            await saveCredentials({ token, ...(endpoint ? { endpoint: tokenOrigin(endpoint) } : {}) });
            tokenNote = `Token saved to ${credentialsPath()} (mode 600).`;
          }
        }
        out.result({ written: target, config }, () =>
          [
            `Wrote ${target}`,
            tokenNote,
            "",
            bold("Next:"),
            mode === "local"
              ? "  tapdance worker start      # start the local device worker (Simlock)\n  tapdance doctor\n  tapdance device lease --platform android"
              : `  tapdance config set-token  # if you skipped it (or export TAPDANCE_TOKEN)\n  tapdance doctor\n  tapdance workers list\n  tapdance device lease --platform android`,
            "  claude mcp add tapdance -- tapdance mcp   # give your agent the tools",
          ]
            .filter((l) => l !== "")
            .join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  program
    .command("doctor")
    .description("Check configuration, this machine, the worker/gateway, tokens and the current lease")
    .option("--no-host", "skip checks of this machine's SDKs and KVM")
    .action(async (o: { host: boolean }) =>
      run(globals(), async (t, out) => {
        const checks = await t.doctor({ ...(o.host === false ? { host: false } : {}) });
        out.result({ checks, ok: !checks.some((c) => c.status === "fail") }, () => renderChecks(checks));
        if (checks.some((c) => c.status === "fail")) process.exitCode = 10;
      }, { fleet: true }),
    );

  const config = program.command("config").description("Show or change configuration and credentials");
  config
    .command("show", { isDefault: true })
    .description("Print the merged configuration and where it came from")
    .action(async () => {
      const out = output(globals());
      try {
        const r = await loadConfig(globals().config ? { configPath: globals().config! } : {});
        const data = {
          config: r.config,
          sources: r.sources,
          ...(r.endpointSource ? { endpointSource: r.endpointSource } : {}),
          artifactsDir: r.artifactsDir,
          credentials: redactObject(r.credentials),
          credentialSources: r.credentialSources,
          warnings: r.warnings,
        };
        out.result(data, () => JSON.stringify(data, null, 2));
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
  config
    .command("path")
    .description("Print config and credential file locations")
    .action(() => {
      const out = output(globals());
      const data = { project: join(process.cwd(), PROJECT_CONFIG_FILE), user: userConfigPath(), credentials: credentialsPath() };
      out.result(data, () => Object.entries(data).map(([k, v]) => `${k}: ${v}${existsSync(v) ? "" : dim(" (absent)")}`).join("\n"));
    });
  config
    .command("set <key> <value>")
    .description("Set a key in the nearest tapdance.config.json (or --global), e.g. session.defaultTtlMinutes 45")
    .option("--global", "edit the per-user config")
    .action(async (key: string, value: string, o: { global?: boolean }) => {
      const out = output(globals());
      try {
        if (/token|secret/i.test(key)) throw new TapdanceError("USAGE", "Tokens never go in config files", { hint: "Use `tapdance config set-token`." });
        const r = await loadConfig();
        const file = o.global ? userConfigPath() : (r.sources.find((s) => s.endsWith(PROJECT_CONFIG_FILE)) ?? resolve(PROJECT_CONFIG_FILE));
        const current: Record<string, unknown> = existsSync(file) ? JSON.parse((await import("node:fs")).readFileSync(file, "utf8")) : {};
        let parsed: unknown = value;
        try {
          parsed = JSON.parse(value);
        } catch {
          parsed = value;
        }
        const parts = key.split(".");
        let node = current;
        for (const part of parts.slice(0, -1)) {
          if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
          node = node[part] as Record<string, unknown>;
        }
        node[parts.at(-1)!] = parsed;
        ConfigSchema.parse({ ...current });
        await writeConfigFile(file, current as Partial<TapdanceConfig>);
        out.result({ file, key, value: parsed }, () => `Set ${key} in ${file}`);
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
  config
    .command("set-token")
    .description("Store the agent token (or --operator token) in ~/.tapdance/credentials.json, mode 600. Reads stdin or prompts.")
    .option("--operator", "store an operator token (only needed for `workers list` on a gateway)")
    .option("--endpoint <url>", "the gateway or worker the token is for; Tapdance sends it nowhere else (default: the configured self-hosted endpoint)")
    .action(async (o: { operator?: boolean; endpoint?: string }) => {
      const out = output(globals());
      try {
        const kind = o.operator ? "operator" : "agent";
        let endpoint = o.endpoint;
        let from = "--endpoint";
        if (endpoint === undefined) {
          const r = await loadConfig(globals().config ? { configPath: globals().config! } : {});
          if (r.config.provider === "self-hosted" && r.config.endpoint) {
            endpoint = r.config.endpoint;
            from = r.endpointSource === "project" ? "this project's tapdance.config.json" : r.endpointSource === "env" ? "TAPDANCE_ENDPOINT" : "~/.tapdance/config.json";
          }
        }
        const origin = endpoint === undefined ? undefined : tokenOrigin(endpoint);
        const token = await readSecret(`${o.operator ? "Operator" : "Agent"} token${origin ? ` for ${origin} (from ${from})` : ""}:`);
        if (!token) throw new TapdanceError("USAGE", "No token given");
        const file = await saveCredentials(
          o.operator ? { operatorToken: token, ...(origin ? { operatorEndpoint: origin } : {}) } : { token, ...(origin ? { endpoint: origin } : {}) },
        );
        out.result({ saved: file, kind, endpoint: origin ?? null }, () =>
          origin
            ? `Saved ${kind} token for ${origin} to ${file}`
            : `Saved ${kind} token to ${file}. No endpoint is known, so it works only with an endpoint from ~/.tapdance/config.json or TAPDANCE_ENDPOINT (pass --endpoint to bind it).`,
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
}
