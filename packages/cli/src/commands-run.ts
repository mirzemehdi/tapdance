import type { Command } from "commander";
import { ERROR_CODES, loadScenario, runScenario, type StepReport } from "@tapdance/sdk";
import { run, spawnKeepalive, type GlobalOptions } from "./context.js";
import { bold, dim, green, red, yellow } from "./output.js";

const MARK: Record<StepReport["status"], string> = { pass: green("✓"), fail: red("✗"), skipped: dim("–") };

function stepLine(s: StepReport): string {
  const head = `${MARK[s.status]} ${String(s.index).padStart(2)} ${s.name} ${dim(s.status === "skipped" ? "skipped" : `${s.durationMs} ms`)}`;
  if (!s.error) return head;
  return `${head}\n     ${red(s.error.code)} ${s.error.message}${s.error.hint ? `\n     ${bold("fix:")} ${s.error.hint}` : ""}`;
}

export function registerRunCommand(program: Command, globals: () => GlobalOptions): void {
  program
    .command("run <file>")
    .description("Replay a scenario file (.yaml or .json) on this session's device and report PASS/FAIL with evidence")
    .option("--keep-lease", "keep a device the scenario leased instead of releasing it at the end")
    .option("--continue-on-failure", "run every step even after one fails")
    .action(async (file: string, o: { keepLease?: boolean; continueOnFailure?: boolean }) =>
      run(globals(), async (t, out) => {
        const scenario = await loadScenario(file);
        out.progress(`Running "${scenario.name}" (${scenario.steps.length} steps)`);
        const report = await runScenario(t, scenario, {
          file,
          ...(o.keepLease ? { keepLease: true } : {}),
          ...(o.continueOnFailure ? { continueOnFailure: true } : {}),
          // Each step's line as it finishes: on stdout as part of the result, on stderr with --json.
          onStep: (s) => (out.jsonMode ? out.progress(stepLine(s)) : process.stdout.write(`${stepLine(s)}\n`)),
        });
        let keepalive: string | undefined;
        if (o.keepLease && report.leased && t.resolved.config.session.keepalive) {
          const pid = spawnKeepalive(t, globals());
          if (pid) await t.store.update(t.sessionId, (r) => ({ ...r, keepalivePid: pid }));
          keepalive = `the lease is kept and renewed in the background (pid ${pid ?? "?"}); release it with \`tapdance device release\``;
        }
        out.result(report, () =>
          [
            "",
            `${report.status === "pass" ? green(bold("PASS")) : red(bold("FAIL"))} ${report.scenario} ${dim(`· ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped · ${(report.durationMs / 1000).toFixed(1)} s`)}`,
            `${dim("device:")} ${report.device.model} (${report.device.platform} ${report.device.osVersion})${report.app ? `  ${dim("app:")} ${report.app.id}` : ""}`,
            `${dim("report:")} ${report.summaryPath}`,
            ...(keepalive ? [yellow(keepalive)] : []),
          ].join("\n"),
        );
        if (report.status === "fail") process.exitCode = ERROR_CODES.SCENARIO_FAILED;
      }),
    );
}
