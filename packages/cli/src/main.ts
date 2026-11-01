#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { runHttp, runStdio } from "@tapdance/mcp";
import { sanitizeSessionId, TapdanceError } from "@tapdance/sdk";
import { registerDeviceCommands } from "./commands-device.js";
import { registerSetupCommands } from "./commands-setup.js";
import { registerWorkerCommands } from "./commands-worker.js";
import { output, type GlobalOptions } from "./context.js";
import { registerViewerCommand } from "./viewer.js";
import { registerReportCommand } from "./commands-report.js";
import { registerToolCommands } from "./commands-tools.js";
import { registerRunCommand } from "./commands-run.js";
import { registerHostCommands } from "./commands-host.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export function buildProgram(): Command {
  const program = new Command("tapdance")
    .description("Let your agent put your app through its paces: lease, drive and record Android emulators and iOS simulators.")
    .version(pkg.version, "-v, --version")
    .option("--json", "print machine-readable JSON on stdout")
    .option("-c, --config <path>", "use this config file instead of the nearest tapdance.config.json")
    .option("--session <id>", "act as this session (default: the agent's session, or your user)")
    .option("-q, --quiet", "no progress messages on stderr")
    .showHelpAfterError("(run `tapdance --help` for usage)")
    .configureOutput({ writeErr: (s) => process.stderr.write(s) })
    .exitOverride((err) => {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version" || err.code === "commander.help") process.exit(0);
      process.exit(2);
    });
  const globals = (): GlobalOptions => program.opts<GlobalOptions>();

  registerSetupCommands(program, globals);
  registerDeviceCommands(program, globals);
  registerRunCommand(program, globals);
  registerWorkerCommands(program, globals);
  registerHostCommands(program, globals);
  registerViewerCommand(program, globals);
  registerReportCommand(program, globals);
  registerToolCommands(program, globals);

  program
    .command("mcp")
    .description("Run the MCP server (stdio by default) so an agent gets Tapdance's device tools")
    .option("--http", "serve Streamable HTTP instead of stdio")
    .option("--host <host>", "HTTP: address to listen on", "127.0.0.1")
    .option("--port <port>", "HTTP: port", "4711")
    .action(async (o: { http?: boolean; host: string; port: string }) => {
      const g = globals();
      const base = {
        ...(g.config ? { configPath: g.config } : {}),
        ...(g.session ? { session: { id: sanitizeSessionId(g.session), source: "--session" } } : {}),
      };
      try {
        if (o.http) {
          const token = process.env["TAPDANCE_MCP_TOKEN"];
          const { url, token: used } = await runHttp({ ...base, host: o.host, port: Number(o.port), ...(token ? { authToken: token } : {}) });
          process.stderr.write(`tapdance MCP (Streamable HTTP) on ${url}\n`);
          if (!token) process.stderr.write(`Bearer token (set TAPDANCE_MCP_TOKEN to choose your own): ${used}\n`);
        } else {
          await runStdio(base);
        }
      } catch (error) {
        process.exitCode = output(g).error(error);
      }
    });

  return program;
}

const program = buildProgram();
program.parseAsync(process.argv).catch((error: unknown) => {
  const out = output(program.opts<GlobalOptions>());
  process.exitCode = out.error(error instanceof Error ? error : new TapdanceError("INTERNAL", String(error)));
});
