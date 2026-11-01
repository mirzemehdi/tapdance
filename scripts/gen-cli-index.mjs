#!/usr/bin/env node
// Regenerates the command index at the end of docs/cli-reference.md from the built CLI's own --help,
// so the reference can never list a command that does not exist or miss one that does.
// Usage: pnpm build && pnpm docs:cli   (pass --check to fail instead of writing)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = `${root}packages/cli/dist/main.js`;
const file = `${root}docs/cli-reference.md`;
const BEGIN = "<!-- BEGIN GENERATED COMMAND INDEX (pnpm docs:cli) -->";
const END = "<!-- END GENERATED COMMAND INDEX -->";

const help = (path) =>
  execFileSync(process.execPath, [cli, ...path, "--help"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", COLUMNS: "100" } }).trim();

const commands = [];
const walk = (path) => {
  const section = help(path).split("Commands:")[1] ?? "";
  for (const line of section.split("\n")) {
    const name = /^\s{2}([a-z][a-z-]*)/.exec(line)?.[1];
    if (!name || name === "help") continue;
    const full = [...path, name];
    if (!commands.some((c) => c.join(" ") === full.join(" "))) {
      commands.push(full);
      if (path.length < 2) walk(full);
    }
  }
};
walk([]);

const body = [
  BEGIN,
  "",
  "## Command index",
  "",
  "Every command, with its exact `--help` output. Generated from the CLI; do not edit by hand.",
  "",
  ...commands.flatMap((c) => [`### \`tapdance ${c.join(" ")}\``, "", "```text", help(c), "```", ""]),
  END,
].join("\n");

const current = readFileSync(file, "utf8");
const start = current.indexOf(BEGIN);
const next = start === -1 ? `${current.trimEnd()}\n\n${body}\n` : `${current.slice(0, start)}${body}${current.slice(current.indexOf(END) + END.length)}`;
if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error("docs/cli-reference.md command index is stale: run `pnpm docs:cli`.");
    process.exit(1);
  }
} else {
  writeFileSync(file, next);
  console.log(`Wrote ${commands.length} commands to docs/cli-reference.md`);
}
