import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, platform as osPlatform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  Tapdance,
  TapdanceError,
  hostChecks,
  saveCredentials,
  toTapdanceError,
  userConfigPath,
  writeConfigFile,
  type DoctorCheck,
  type Platform,
} from "@tapdance/sdk";
import { CLI_ENTRY, open, output, type GlobalOptions } from "./context.js";
import { bold, dim, green, red, renderChecks, table, yellow, type Output } from "./output.js";
import { readSecret, tokenOrigin } from "./commands-setup.js";
import { installWorker, localWorkerStatus, readUserConfig } from "./commands-worker.js";
import { assertGuardHostSafe, installGuardAsService, isMacAdmin, issuePairing, joinedGateway, servicePlatform } from "./commands-guard.js";
import { GuardTokens, guardDir, loadPolicy } from "./guard/policy.js";
import { commandFailed, guardServiceState, runCommand, uninstallGuardService, waitForGuard } from "./guard/service.js";
import {
  assertHostPlatform,
  cloudCheck,
  defaultLabel,
  describeCatalog,
  detectCloudVm,
  findOnPath,
  formatStepFailure,
  hostEndpoint,
  hostUpCommand,
  installInstructions,
  mcpSnippets,
  pairingTokenPath,
  parseTailscaleStatus,
  renderReadyBlock,
  sanitizeLabel,
  serveHasPort,
  summarizePrerequisites,
  tailscaleServeArgs,
  tailscaleServeOffArgs,
  type HostUpOptions,
  type StepRef,
} from "./host/plan.js";

/**
 * `tapdance host up`: one command that turns this Mac or Linux machine into a device-only host for a
 * remote agent (worker, guard service, pairing, Tailscale, self-test) and prints a block to paste
 * back. `tapdance connect` is the other half, on the agent's machine. Every step reuses the commands
 * that do the same job on their own (`worker install`, `worker guard install`, `worker guard pair`).
 */

const STEPS = ["prerequisites", "account", "worker", "guard service", "pairing", "tailscale", "self-test", "summary"] as const;

class StepFailure extends Error {
  constructor(readonly step: StepRef, readonly error: TapdanceError) {
    super(error.message);
  }
}

async function step<T>(out: Output, name: (typeof STEPS)[number], body: () => Promise<T>): Promise<T> {
  const ref: StepRef = { index: STEPS.indexOf(name) + 1, total: STEPS.length, title: name };
  out.progress(bold(`[${ref.index}/${ref.total}] ${name}`));
  try {
    return await body();
  } catch (error) {
    throw new StepFailure(ref, toTapdanceError(error));
  }
}

function reportFailure(out: Output, json: boolean, error: unknown): number {
  if (!(error instanceof StepFailure)) return out.error(error);
  const e = error.error;
  if (json) {
    return out.error(new TapdanceError(e.code, `${error.step.title}: ${e.message}`, { ...(e.hint ? { hint: e.hint } : {}), details: { ...e.details, step: error.step.title } }));
  }
  process.stderr.write(`${red(formatStepFailure(error.step, e))}\n`);
  return e.exitCode;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} ${dim("[y/N]")} `)).trim());
  } finally {
    rl.close();
  }
}

function readDmi(): { sysVendor?: string; productName?: string; biosVendor?: string; chassisAssetTag?: string } {
  const read = (name: string) => {
    try {
      return readFileSync(join("/sys/class/dmi/id", name), "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const dmi = { sysVendor: read("sys_vendor"), productName: read("product_name"), biosVendor: read("bios_vendor"), chassisAssetTag: read("chassis_asset_tag") };
  return Object.fromEntries(Object.entries(dmi).filter(([, v]) => v !== undefined));
}

/** sdkmanager needs a JDK; the Mac's /usr/bin/java is a stub that fails without one. */
async function jdkCheck(): Promise<DoctorCheck> {
  const java = process.env["JAVA_HOME"] ? join(process.env["JAVA_HOME"], "bin", "java") : "java";
  const r = await runCommand(java, ["-version"]);
  return r.ok
    ? { id: "host.jdk", title: "JDK (for sdkmanager)", status: "pass", detail: r.out.split("\n")[0] ?? "found" }
    : { id: "host.jdk", title: "JDK (for sdkmanager)", status: "warn", detail: "not found (needed only to install Android images)", fix: "Install a JDK 17+ and set JAVA_HOME." };
}

async function prerequisiteChecks(platform: "darwin" | "linux"): Promise<DoctorCheck[]> {
  const checks = await hostChecks({ platforms: { android: true, ios: platform === "darwin" } });
  checks.push(await jdkCheck());
  if (platform === "linux") {
    const cloud = cloudCheck(detectCloudVm(readDmi()), existsSync("/dev/kvm"));
    if (cloud) checks.push(cloud);
  }
  return checks;
}

function findTailscale(): string | undefined {
  const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  return findOnPath("tailscale", process.env["PATH"] ?? "", existsSync) ?? (osPlatform() === "darwin" && existsSync(app) ? app : undefined);
}

/** The pairing files `host up` wrote, with what the guard thinks of each token. */
async function pairings(): Promise<Array<{ label: string; path: string; state: "active" | "expired or revoked" }>> {
  const dir = guardDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const tokens = new GuardTokens();
  const found = [];
  for (const name of names.filter((n) => /^pairing-.+\.token$/.test(n))) {
    const path = join(dir, name);
    const secret = (await readFile(path, "utf8").catch(() => "")).trim();
    const token = secret ? await tokens.verify(secret) : undefined;
    found.push({ label: name.slice("pairing-".length, -".token".length), path, state: token ? ("active" as const) : ("expired or revoked" as const) });
  }
  return found;
}

export function registerHostCommands(program: Command, globals: () => GlobalOptions): void {
  const host = program.command("host").description("Set up this Mac or Linux machine as a device host for a remote agent, in one command");

  host
    .command("up")
    .description("Worker, guard service, pairing, Tailscale and a self-test, step by step; prints a block to paste to the agent's machine")
    .option("--label <name>", "name for the control machine's pairing (default: this machine's hostname)")
    .option("--allow-admin-account", "run the guard from an administrator account (not recommended)")
    .option("--no-tailscale", "do not expose the guard with `tailscale serve`; the endpoint stays on loopback")
    .option("--keep-awake", "macOS: run the guard under `caffeinate -i` so idle sleep does not take it offline")
    .option("--repair", "revoke the existing pairing with this label and issue a new token")
    .option("--skip-self-test", "do not lease a device through the guard at the end")
    .option("-y, --yes", "approve pairing without a prompt (you are at this machine)")
    .action(async (o: HostUpOptions) => {
      const g = globals();
      const out = output(g);
      try {
        const platform = assertHostPlatform(osPlatform());
        const label = sanitizeLabel(o.label ?? defaultLabel(hostname())) || "host";

        const prereq = await step(out, "prerequisites", async () => {
          const checks = await prerequisiteChecks(platform);
          const summary = summarizePrerequisites(checks);
          for (const c of summary.problems) out.warn(`${c.title}: ${c.detail}`);
          if (checks.some((c) => c.id === "host.node" && c.status === "fail") || (!summary.android && !summary.ios)) {
            throw new TapdanceError("HOST_CHECK_FAILED", "This machine cannot serve Android emulators or iOS simulators yet", {
              hint: [`Install what is missing (Tapdance does not install SDKs), then run \`${hostUpCommand(o)}\` again:`, ...installInstructions(checks, platform, process.arch).map((l) => `  ${l}`)].join("\n"),
            });
          }
          out.progress(`android: ${summary.android ? green("ready") : yellow("not available")}, ios: ${summary.ios ? green("ready") : platform === "darwin" ? yellow("not available") : dim("needs a Mac")}`);
          return { checks, ...summary };
        });

        await step(out, "account", async () => {
          assertGuardHostSafe(
            Boolean(o.allowAdminAccount),
            [
              "A remote agent reaches this machine only through the guard, but anything that escapes it (a Simulator or emulator bug) runs with this account's rights, and an administrator can become root.",
              "Recommended: create a dedicated standard account (infrastructure/scripts/macos-create-worker-account.sh, untested), log in as it and run this command there.",
              `To accept the risk on this account instead, run: ${hostUpCommand(o, { allowAdminAccount: true })}`,
            ].join("\n"),
          );
        });

        await step(out, "worker", async () => {
          // On a re-run (worker answering, guard service running) leave both alone: restarting the
          // worker would end the sessions of an agent that is using this host right now.
          const service = await guardServiceState(platform, homedir(), { run: runCommand, uid: process.getuid?.() ?? 0 });
          if (service.running && (await localWorkerStatus()) !== undefined) {
            out.progress("The worker already runs (from an earlier `host up`); left as is. `tapdance worker install --service` reconfigures it.");
            return;
          }
          await installWorker({ stream: true, iosBackend: "agent-device", service: true, checks: prereq.checks }, out);
        });

        const { policy } = await loadPolicy();
        const port = policy.listen.port;
        const localUrl = `http://${policy.listen.host}:${port}`;

        await step(out, "guard service", async () => {
          const r = await installGuardAsService({ allowAdminAccount: Boolean(o.allowAdminAccount), keepAwake: Boolean(o.keepAwake) });
          out.progress(r.unchanged ? `Already installed and running (${r.file}); left as is` : `Installed ${r.file}`);
          for (const n of r.notes) out.progress(dim(n));
          if (!r.answering) {
            const log = r.log ? await readFile(r.log, "utf8").catch(() => "") : (await runCommand("journalctl", ["--user", "-u", "tapdance-guard.service", "-n", "30", "--no-pager"])).out;
            const runs = [process.execPath, CLI_ENTRY, "worker", "guard", "start", ...(o.allowAdminAccount ? ["--allow-admin-account"] : [])];
            throw commandFailed(runs, log, `The guard service is installed but does not answer on ${r.url}`, r.log ? `Read ${r.log}; fix what it reports, then run \`${hostUpCommand(o)}\` again.` : `Read \`journalctl --user -u tapdance-guard.service\`, then run \`${hostUpCommand(o)}\` again.`);
          }
        });

        const tokenPath = pairingTokenPath(guardDir(), label);
        const secret = await step(out, "pairing", async () => {
          const tokens = new GuardTokens();
          const existing = existsSync(tokenPath) ? (await readFile(tokenPath, "utf8")).trim() : "";
          const valid = existing ? await tokens.verify(existing) : undefined;
          if (valid && !o.repair) {
            out.progress(`Keeping the pairing "${label}" (${valid.id}, expires ${valid.expiresAt})`);
            return existing;
          }
          const active = (await tokens.all()).filter((t) => t.label === label && !t.revokedAt && Date.parse(t.expiresAt) > Date.now());
          if (active.length > 0 && !o.repair) {
            throw new TapdanceError("USAGE", `"${label}" is already paired (${active.map((t) => t.id).join(", ")}), but its token file ${tokenPath} is missing or stale`, {
              hint: `Run \`${hostUpCommand(o, { repair: true })}\` to revoke it and issue a new token, or pick another --label.`,
            });
          }
          if (!o.yes && !process.env["TAPDANCE_GUARD_PAIR_NONINTERACTIVE"]) {
            if (!process.stdin.isTTY) {
              throw new TapdanceError("FORBIDDEN", "Pairing must be approved at this machine's terminal", { hint: `Run it in a local terminal, or pass --yes if you are the owner running it here: ${hostUpCommand(o, { yes: true })}` });
            }
            const days = policy.limits.tokenDays;
            if (!(await confirm(`Pair a control machine as "${label}"? It gets device-only access to this machine for ${days} day(s).`))) {
              throw new TapdanceError("USAGE", "Pairing not approved; nothing was issued");
            }
          }
          for (const t of active) await tokens.revoke(t.id);
          const { secret: issued, token } = await issuePairing(label);
          await writeFile(tokenPath, `${issued}\n`, { mode: 0o600 });
          await chmod(tokenPath, 0o600);
          out.progress(`Paired "${label}" (${token.id}), expires ${token.expiresAt}; token written to ${tokenPath}`);
          return issued;
        });

        const endpoint = await step(out, "tailscale", async () => {
          if (o.tailscale === false) {
            out.progress("Skipped (--no-tailscale): the endpoint stays on loopback");
            return hostEndpoint(undefined, port);
          }
          const bin = findTailscale();
          if (!bin) {
            out.warn("Tailscale is not installed, so the guard stays on loopback. Install it from https://tailscale.com/download, log in, and run this command again.");
            return hostEndpoint(undefined, port);
          }
          const status = await runCommand(bin, ["status", "--json"]);
          const state = parseTailscaleStatus(status.out);
          if (!state.loggedIn || !state.dnsName) {
            out.warn(`Tailscale is ${state.loggedIn ? "connected but has no MagicDNS name" : `not logged in (${state.backendState})`}; the guard stays on loopback. Run \`tailscale up\` (and turn on MagicDNS), then this command again.`);
            return hostEndpoint(undefined, port);
          }
          const args = tailscaleServeArgs(port);
          const serve = await runCommand(bin, args);
          if (!serve.ok) {
            throw commandFailed([bin, ...args], serve.out, "tailscale serve could not expose the guard", "Turn on HTTPS certificates for your tailnet (admin console → DNS → HTTPS Certificates; https://tailscale.com/kb/1153/enabling-https), then run this command again, or pass --no-tailscale.");
          }
          return hostEndpoint(state.dnsName, port);
        });

        const { devices, selfTest } = await step(out, "self-test", async () => {
          const work = await mkdtemp(join(tmpdir(), "tapdance-host-"));
          const env: NodeJS.ProcessEnv = { ...process.env, TAPDANCE_PROVIDER: "self-hosted", TAPDANCE_ENDPOINT: localUrl, TAPDANCE_TOKEN: secret, TAPDANCE_ARTIFACTS_DIR: work };
          delete env["TAPDANCE_CONFIG"];
          const t = await Tapdance.create({ cwd: work, env, session: { id: `host-self-test-${process.pid}`, source: "host up" }, owner: "cli", onProgress: (m) => out.progress(m) });
          try {
            const inventory = await t.devices();
            const devices = describeCatalog(inventory.catalog);
            if (o.skipSelfTest) return { devices, selfTest: "SKIPPED (--skip-self-test)" };
            const has = (p: Platform) => inventory.catalog.some((e) => e.platform === p && (e.osVersions.length > 0 || e.defaultOsVersion));
            const platformToTest: Platform | undefined = has("android") ? "android" : has("ios") ? "ios" : undefined;
            if (!platformToTest) throw new TapdanceError("DEVICE_UNAVAILABLE", "The guard answers, but the worker offers no device to lease", { hint: "Install a system image or simulator runtime (`tapdance devices install android 35`), then run this command again." });
            out.progress(`Leasing an ${platformToTest} device through the guard (the first boot can take minutes)`);
            await t.lease({ platform: platformToTest, ttlMinutes: 10, waitSeconds: 300 });
            try {
              const shot = await t.screenshot(join(work, "self-test.png"), "host up self-test");
              if (shot.bytes <= 0) throw new TapdanceError("DEVICE_ERROR", "The self-test screenshot is empty");
            } finally {
              await t.release().catch(() => undefined);
            }
            return { devices, selfTest: `PASS (${platformToTest} lease, screenshot ok)` };
          } catch (error) {
            const e = toTapdanceError(error);
            const skip = o.skipSelfTest ? "" : ` To finish setup without the lease, run: ${hostUpCommand(o, { skipSelfTest: true })}`;
            throw new TapdanceError(e.code, `Self-test through the guard failed: ${e.message}`, { ...(e.hint || skip ? { hint: `${e.hint ?? ""}${skip}`.trim() } : {}) });
          } finally {
            await t.close().catch(() => undefined);
            await rm(work, { recursive: true, force: true }).catch(() => undefined);
          }
        });

        await step(out, "summary", async () => undefined);
        const block = { endpoint, tokenPath, devices, selfTest };
        out.result({ ready: true, ...block, label, android: prereq.android, ios: prereq.ios }, () =>
          [
            renderReadyBlock(block),
            ...(endpoint.startsWith("http://127.0.0.1")
              ? ["", yellow("The endpoint is loopback only: an agent on another machine cannot reach it until Tailscale is set up (then run this command again).")]
              : []),
          ].join("\n"),
        );
      } catch (error) {
        process.exitCode = reportFailure(out, Boolean(g.json), error);
      }
    });

  host
    .command("status")
    .description("Show the state of each `host up` step on this machine")
    .action(async () => {
      const out = output(globals());
      try {
        const platform = assertHostPlatform(osPlatform());
        const rows: Array<{ step: string; ok: boolean; detail: string }> = [];
        const summary = summarizePrerequisites(await prerequisiteChecks(platform));
        rows.push({ step: "prerequisites", ok: summary.android || summary.ios, detail: `android ${summary.android ? "ready" : "not available"}, ios ${summary.ios ? "ready" : "not available"}` });
        const admin = isMacAdmin();
        const gateway = joinedGateway();
        rows.push({ step: "account", ok: !gateway && process.getuid?.() !== 0, detail: `${userInfo().username}${admin ? " (administrator)" : ""}${gateway ? `; joined gateway ${gateway}` : ""}` });
        const worker = await localWorkerStatus();
        rows.push({ step: "worker", ok: worker !== undefined, detail: worker !== undefined ? "the local Simlock worker answers" : "not answering (tapdance worker start)" });
        const { policy } = await loadPolicy();
        const port = policy.listen.port;
        const localUrl = `http://${policy.listen.host}:${port}`;
        const service = await guardServiceState(servicePlatform(), homedir(), { run: runCommand, uid: process.getuid?.() ?? 0 });
        const answering = port !== 0 && (await waitForGuard(localUrl, 0));
        rows.push({ step: "guard service", ok: service.installed && answering, detail: `${service.installed ? "installed" : "not installed"}, ${service.detail}; ${answering ? `answers on ${localUrl}` : "not answering"}` });
        const paired = await pairings();
        rows.push({ step: "pairing", ok: paired.some((p) => p.state === "active"), detail: paired.map((p) => `${p.label}: ${p.state}`).join(", ") || "none" });
        let endpoint = hostEndpoint(undefined, port);
        const bin = findTailscale();
        if (bin) {
          const state = parseTailscaleStatus((await runCommand(bin, ["status", "--json"])).out);
          const served = serveHasPort((await runCommand(bin, ["serve", "status", "--json"])).out, port);
          if (state.loggedIn && served) endpoint = hostEndpoint(state.dnsName, port);
          rows.push({ step: "tailscale", ok: state.loggedIn && served, detail: `${state.loggedIn ? `logged in as ${state.dnsName ?? "?"}` : state.backendState}; ${served ? `serving :${port}` : `not serving :${port}`}` });
        } else rows.push({ step: "tailscale", ok: false, detail: "not installed" });
        out.result({ ready: rows.every((r) => r.ok), endpoint, steps: rows }, () =>
          [table([["STEP", "STATE", "DETAIL"], ...rows.map((r) => [r.step, r.ok ? green("ok") : yellow("not ready"), r.detail])]), "", `endpoint: ${endpoint}`].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  host
    .command("down")
    .description("Stop hosting: remove the guard service and `tailscale serve` for its port (tokens are kept unless --revoke)")
    .option("--revoke", "also revoke every paired control machine and delete the pairing token files")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (o: { revoke?: boolean; yes?: boolean }) => {
      const out = output(globals());
      try {
        const platform = assertHostPlatform(osPlatform());
        if (!o.yes) {
          if (!process.stdin.isTTY) throw new TapdanceError("USAGE", "host down needs confirmation", { hint: "Run it in a terminal, or pass --yes." });
          if (!(await confirm(`Stop the worker guard${o.revoke ? ", revoke every paired control machine" : ""} and remove its Tailscale exposure?`))) {
            throw new TapdanceError("USAGE", "Cancelled; nothing changed");
          }
        }
        const { policy } = await loadPolicy();
        const service = await uninstallGuardService(platform, homedir(), { run: runCommand, uid: process.getuid?.() ?? 0 });
        let tailscale = "not installed";
        const bin = findTailscale();
        if (bin) {
          const r = await runCommand(bin, tailscaleServeOffArgs(policy.listen.port));
          tailscale = r.ok ? `stopped serving :${policy.listen.port}` : `nothing to stop (${r.out.split("\n")[0] ?? ""})`;
        }
        let revoked = 0;
        const removed: string[] = [];
        if (o.revoke) {
          revoked = await new GuardTokens().revoke("all");
          for (const p of await pairings()) {
            await rm(p.path, { force: true });
            removed.push(p.path);
          }
        }
        out.result({ service: service.file, serviceRemoved: service.removed, tailscale, revoked, removedTokenFiles: removed }, () =>
          [
            service.removed ? `Removed the guard service (${service.file}).` : "No guard service was installed.",
            `Tailscale: ${tailscale}.`,
            o.revoke ? `Revoked ${revoked} token(s); deleted ${removed.length} token file(s).` : dim("Pairings are kept; revoke them with `tapdance worker guard revoke all` or `tapdance host down --revoke`."),
            dim("The Simlock worker still runs for local agents; stop it with `tapdance worker stop`."),
          ].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  // ------------------------------------------------------------------ the agent's side

  program
    .command("connect <endpoint>")
    .description("On the agent's machine: use a host's guard (reads the token from stdin), check it, and print MCP setup for Claude Code, Codex and Cursor")
    .action(async (endpoint: string) => {
      const g = globals();
      const out = output(g);
      try {
        const origin = tokenOrigin(endpoint);
        const token = await readSecret(`Token for ${origin} (from the host's pairing file; input hidden):`);
        if (!token) throw new TapdanceError("USAGE", "No token given", { hint: `Pipe the token file in: tapdance connect ${endpoint} < pairing-<label>.token` });
        await writeConfigFile(userConfigPath(), { ...(await readUserConfig()), provider: "self-hosted", endpoint });
        const saved = await saveCredentials({ token, endpoint: origin });
        out.progress(`Wrote ${userConfigPath()} (provider self-hosted, endpoint ${endpoint}); token saved to ${saved} (mode 600) for ${origin} only`);
        const t = await open(g, out, { fleet: false });
        let checks: DoctorCheck[];
        try {
          checks = await t.doctor({ host: false });
          if (t.resolved.endpointSource === "project" || t.resolved.endpointSource === "env") {
            out.warn(`This directory's ${t.resolved.endpointSource === "env" ? "TAPDANCE_ENDPOINT" : "tapdance.config.json"} overrides the endpoint here (${t.resolved.config.endpoint}).`);
          }
        } finally {
          await t.close().catch(() => undefined);
        }
        const ok = !checks.some((c) => c.status === "fail");
        const onPath = findOnPath("tapdance", process.env["PATH"] ?? "", existsSync);
        const command = onPath ? ["tapdance", "mcp"] : [process.execPath, CLI_ENTRY, "mcp"];
        out.result({ endpoint, origin, config: userConfigPath(), credentials: saved, ok, checks, mcpCommand: command }, () =>
          [
            renderChecks(checks),
            "",
            bold(ok ? "Connected. Give your agent the device tools:" : "The checks above failed; fix them, then give your agent the device tools:"),
            "",
            mcpSnippets(command),
            "",
            dim("Codex and Cursor do not pass a session id: set the same TAPDANCE_SESSION_ID in the server's env and in the agent's shell if it uses both the CLI and MCP (docs/agents/)."),
          ].join("\n"),
        );
        if (!ok) process.exitCode = 10;
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
}
