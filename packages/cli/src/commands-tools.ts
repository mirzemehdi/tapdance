import type { Command } from "commander";
import { TOOL_REGISTRY, TapdanceError, toolStatus } from "@tapdance/sdk";
import { run, type GlobalOptions } from "./context.js";
import { bold, dim, green, table, yellow } from "./output.js";

/**
 * External tools (asc, android, axe, maestro, fastlane, xcodebuild): Tapdance forwards arguments to
 * the real executable unchanged, so every upstream command works without a Tapdance release.
 */
export function registerToolCommands(program: Command, globals: () => GlobalOptions): void {
  const tools = program.command("tools").description("External tools Tapdance can run for you, and whether they are installed here");

  const list = async (detail: boolean) =>
    run(globals(), async (_t, out) => {
      const statuses = await Promise.all(TOOL_REGISTRY.map((spec) => toolStatus(spec)));
      out.result({ tools: statuses }, () =>
        detail
          ? statuses
              .map((s) =>
                [
                  `${bold(s.name)} ${s.installed ? green(s.version ?? "installed") : yellow("not installed")}${s.supportedHere ? "" : dim(" (not supported on this OS)")}`,
                  `  ${s.description}`,
                  `  runs: ${s.location === "lease" ? "against the leased device" : s.location === "mac" ? "on a Mac" : "on this machine"} · license: ${s.license}`,
                  `  discover commands: ${s.discovery.join("  |  ")}`,
                  s.installed ? "" : `  install: ${s.install}`,
                  s.notes ? `  ${dim(s.notes)}` : "",
                ]
                  .filter(Boolean)
                  .join("\n"),
              )
              .join("\n\n")
          : table([["TOOL", "STATUS", "VERSION", "RUNS", "HOMEPAGE"], ...statuses.map((s) => [s.name, s.installed ? "installed" : s.supportedHere ? "missing" : "n/a here", s.version ?? "", s.location, s.homepage])]),
      );
    });
  tools.command("list", { isDefault: true }).description("Registered tools and install state").action(() => list(false));
  tools.command("doctor").description("Install state, versions, discovery commands and install guidance").action(() => list(true));
  tools.command("versions").description("Installed versions").action(() => list(false));

  const passthrough = (name: string | undefined) => async (argsOrName: string[] | string, maybeArgs: string[] | Record<string, unknown>, maybeOpts?: Record<string, unknown>) => {
    const toolName = name ?? (argsOrName as string);
    const args = (name ? argsOrName : maybeArgs) as string[];
    const o = ((name ? maybeArgs : maybeOpts) ?? {}) as { target?: string; timeout?: string };
    await run(globals(), async (t, out) => {
      const timeoutMs = o.timeout ? Number(o.timeout) * 1000 : undefined;
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TapdanceError("USAGE", "--timeout is in seconds");
      const json = Boolean(globals().json);
      const result = await t.tool(toolName, args ?? [], { ...(o.target ? { target: o.target } : {}), ...(timeoutMs ? { timeoutMs } : {}), inherit: !json });
      if (json) out.result(result, () => "");
      process.exitCode = result.exitCode ?? 1;
    });
  };

  const addTarget = (cmd: Command) =>
    cmd
      .option("--target <target>", "where to run it: control (this machine; default)")
      .option("--timeout <seconds>", "stop it after this long (default 600)")
      // Everything after `--` reaches the tool untouched; Tapdance parses nothing in it.
      .allowUnknownOption();

  addTarget(program.command("tool <name>").description("Run an external tool with arguments unchanged: tapdance tool asc -- apps list").argument("[args...]")).action(
    passthrough(undefined) as never,
  );
  for (const name of ["asc", "android"]) {
    addTarget(program.command(name).description(`Run the installed ${name} CLI with arguments unchanged (tapdance ${name} -- --help)`).argument("[args...]")).action(passthrough(name) as never);
  }
}
