import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, platform as osPlatform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  BRANCH_NAME,
  BUILD_FILE_MAX_BYTES,
  addBuildFile,
  artifactCacheBytes,
  githubRepo,
  describeBadHealth,
  listAllBuildFiles,
  normalizeRepo,
  readBuildFiles,
  removeBuildFile,
  repoIdentity,
  repoKeyPath,
  repoSlug,
  type BuildFileEntry,
} from "@tapdance/provider-simlock";
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
import { applyWarm, installWorker, localWorkerStatus, readUserConfig, resetWarm, setWorkerService, simlockNuke, startWorker, stopWorkerCompletely, warmReport, workerRunning, workerServiceInstalled } from "./commands-worker.js";
import { assertGuardHostSafe, installGuardAsService, isMacAdmin, issuePairing, joinedGateway, parseScopes, servicePlatform } from "./commands-guard.js";
import { GuardPolicySchema, GuardTokens, guardDir, loadPolicy } from "./guard/policy.js";
import { HOST_STOP_COMMAND, HOST_STOP_SUDO_CHECK, describeHostStop, hostStopApplies, sudoersInstallCommand, sudoersRule } from "./guard/host-stop.js";
import { GUARD_LAUNCHD_LABEL, GUARD_SYSTEMD_UNIT, prepareLinuxUserServices, commandFailed, guardServicePaths, guardServiceState, runCommand, uninstallGuardService, waitForGuard } from "./guard/service.js";
import {
  assertHostPlatform,
  cloudCheck,
  defaultLabel,
  describeCatalog,
  detectCloudVm,
  cloudCostNote,
  findOnPath,
  formatStepFailure,
  hostEndpoint,
  hostUpCommand,
  installInstructions,
  mcpSnippets,
  pairingTokenPath,
  parseTailscaleStatus,
  TAILSCALE_DNS_ADMIN,
  renderReadyBlock,
  sanitizeLabel,
  serveHasPort,
  summarizePrerequisites,
  serveModeOf,
  tailscaleServeArgs,
  tailscaleServeOffArgs,
  tokenFingerprint,
  clipboardCommand,
  choosePairingLabel,
  describePlatforms,
  describeWorkerDevices,
  hostSecurityNote,
  offerClipboard,
  pairingApprovalRefusal,
  tailscaleAclHint,
  parseWarm,
  serveNeedsOperator,
  resolveHostStop,
  describeIdle,
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
  // Over a non-interactive ssh command JAVA_HOME may be unset: also look where host-setup.sh puts the JDK.
  const setupJdk = join(homedir(), ".local", "share", "tapdance", "jdk", "bin", "java");
  const java = process.env["JAVA_HOME"] ? join(process.env["JAVA_HOME"], "bin", "java") : existsSync(setupJdk) ? setupJdk : "java";
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
/** Puts text on the clipboard through the platform's tool (stdin, never argv). */
/** sudo lets this account run the cost guard's stop command without a password. */
async function hostStopAllowed(): Promise<boolean> {
  return (await runCommand("sudo", [...HOST_STOP_SUDO_CHECK])).ok;
}

/** Says, once, how to let the guard power this machine off. host up goes on either way. */
function warnHostStopNotAllowed(out: Output): void {
  const user = userInfo().username;
  out.warn(
    [
      `The cost guard cannot power this machine off yet: sudo does not let ${user} run \`${HOST_STOP_COMMAND.join(" ")}\` without a password. Allow exactly that command with this sudoers rule:`,
      `  ${sudoersRule(user)}`,
      "Install it with:",
      `  ${sudoersInstallCommand(user)}`,
      "Until then the guard logs the failed stop once an hour and the machine keeps running (and billing).",
    ].join("\n"),
  );
}

/**
 * Writes `policy.hostStop` when `host up` chose a value (a flag, or the cloud default) and checks that
 * sudo allows the stop command. Returns the settings the guard runs with.
 */
async function applyHostStop(out: Output, choice: ReturnType<typeof resolveHostStop>, platform: "darwin" | "linux"): Promise<{ idleMinutes: number; maxUptimeHours: number } | undefined> {
  const { policy, path } = await loadPolicy();
  if (choice.write) {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    raw["hostStop"] = { idleMinutes: choice.idleMinutes, maxUptimeHours: choice.maxUptimeHours };
    await writeFile(path, `${JSON.stringify(GuardPolicySchema.parse(raw), null, 2)}\n`, { mode: 0o600 });
  }
  const settings = choice.write ? { idleMinutes: choice.idleMinutes, maxUptimeHours: choice.maxUptimeHours } : policy.hostStop;
  if (hostStopApplies(settings, platform)) {
    out.progress(`Cost guard: ${describeHostStop(settings, platform)}${choice.idleSource === "cloud default" ? " (the default on a cloud VM; --idle-stop off turns it off)" : ""}`);
    if (!(await hostStopAllowed())) warnHostStopNotAllowed(out);
  }
  return settings;
}

async function copyToClipboard(text: string): Promise<boolean> {
  const cmd = clipboardCommand(osPlatform(), (bin) => findOnPath(bin, process.env["PATH"] ?? "", existsSync) !== undefined);
  if (!cmd) return false;
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}

interface PausedState {
  pausedAt: string;
  guardService: boolean;
  allowAdminAccount: boolean;
  keepAwake: boolean;
  tailscale: boolean;
  workerService: boolean;
}

async function pairings(): Promise<Array<{ label: string; path: string; state: "active" | "expired or revoked"; createdAt?: string; expiresAt?: string; scopes?: string[] }>> {
  const dir = guardDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const tokens = new GuardTokens();
  const found = [];
  for (const name of names.filter((n) => /^pairing-.+\.token$/.test(n))) {
    const path = join(dir, name);
    const secret = (await readFile(path, "utf8").catch(() => "")).trim();
    const token = secret ? await tokens.verify(secret) : undefined;
    found.push({
      label: name.slice("pairing-".length, -".token".length),
      path,
      state: token ? ("active" as const) : ("expired or revoked" as const),
      ...(token ? { createdAt: token.createdAt, expiresAt: token.expiresAt, ...(token.scopes ? { scopes: token.scopes } : {}) } : {}),
    });
  }
  return found;
}

export function registerHostCommands(program: Command, globals: () => GlobalOptions): void {
  const host = program.command("host").description("Set up this Mac or Linux machine as a device host for a remote agent, in one command");

  host
    .command("up")
    .description("Worker, guard service, pairing, Tailscale and a self-test, step by step; prints a block to paste to the agent's machine")
    .option("--label <name>", "name for the control machine's pairing (default: the pairing this host already has, if only one; else this machine's hostname)")
    .option("--allow-admin-account", "run the guard from an administrator account (not recommended)")
    .option("--no-tailscale", "do not expose the guard with `tailscale serve`; the endpoint stays on loopback")
    .option("--keep-awake", "macOS: run the guard under `caffeinate -i` so idle sleep does not take it offline")
    .option("--repair", "revoke the existing pairing with this label and issue a new token")
    .option("--skip-self-test", "do not lease a device through the guard at the end")
    .option("--scope <areas>", "limit the pairing token to these policy areas, e.g. interaction,inspection,screenshots,streaming,input (no install: it cannot put apps on the devices)")
    .option("--warm <counts>", "booted spare devices kept ready for fast leases, per platform, e.g. android=1,ios=0 (0 frees the memory; default: Simlock keeps one per device kind used)")
    .option("--idle-stop <minutes|off>", "Linux cloud VMs: power the machine off after this many minutes with no lease, request or build (default on a detected cloud VM: 30; elsewhere off; refused on macOS)")
    .option("--max-uptime <hours|off>", "Linux cloud VMs: after this many hours up, take no new leases and power off when the last one ends (default off; refused on macOS)")
    .option("-y, --yes", "approve pairing without a prompt (you are at this machine)")
    .action(async (o: HostUpOptions) => {
      const g = globals();
      const out = output(g);
      try {
        const platform = assertHostPlatform(osPlatform());
        // Decided before anything changes, so a bad or refused value stops here.
        const activeLabels = (await pairings()).filter((p) => p.state === "active").map((p) => p.label);
        const chosen = choosePairingLabel({ ...(o.label !== undefined ? { flag: o.label } : {}), hostnameLabel: defaultLabel(hostname()), active: activeLabels });
        const label = chosen.label;
        if (chosen.source === "only pairing") out.progress(`No --label: keeping this host's pairing "${label}"`);
        const tokenPath = pairingTokenPath(guardDir(), label);
        // A new pairing needs the owner's approval: refuse now, before the cost guard or anything else
        // changes, rather than at step 5 after earlier steps applied their settings (#93).
        {
          const existing = existsSync(tokenPath) ? (await readFile(tokenPath, "utf8")).trim() : "";
          const valid = existing ? await new GuardTokens().verify(existing) : undefined;
          const needsPairing = !valid || Boolean(o.repair);
          if (needsPairing && !o.yes && !process.env["TAPDANCE_GUARD_PAIR_NONINTERACTIVE"] && !process.stdin.isTTY) {
            throw pairingApprovalRefusal(o, label, activeLabels);
          }
        }
        const currentStop = (await loadPolicy()).policy.hostStop;
        const cloudVm = platform === "linux" ? detectCloudVm(readDmi()) : undefined;
        const costChoice = resolveHostStop({
          ...(o.idleStop !== undefined ? { idleStop: o.idleStop } : {}),
          ...(o.maxUptime !== undefined ? { maxUptime: o.maxUptime } : {}),
          ...(currentStop ? { current: currentStop } : {}),
          ...(cloudVm !== undefined ? { cloudVm } : {}),
          platform,
        });

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
          const warm = o.warm ? parseWarm(o.warm) : undefined;
          if (service.running && (await localWorkerStatus()) !== undefined) {
            if (warm) await applyWarm(out, warm);
            else out.progress("The worker already runs (from an earlier `host up`); left as is. `tapdance worker install --service` reconfigures it.");
            return;
          }
          await installWorker({ stream: true, iosBackend: "agent-device", service: true, checks: prereq.checks, ...(warm ? { warm } : {}) }, out);
        });

        const { policy } = await loadPolicy();
        const port = policy.listen.port;
        const localUrl = `http://${policy.listen.host}:${port}`;

        const hostStop = await step(out, "guard service", async () => {
          const settings = await applyHostStop(out, costChoice, platform);
          if (platform === "linux") await prepareLinuxUserServices(out);
          const r = await installGuardAsService({ allowAdminAccount: Boolean(o.allowAdminAccount), keepAwake: Boolean(o.keepAwake) });
          out.progress(r.unchanged ? `Already installed and running (${r.file}); left as is` : `Installed ${r.file}`);
          for (const n of r.notes) out.progress(dim(n));
          // A running guard reads its policy at start: restart it for a new cost guard setting.
          if (r.unchanged && costChoice.changed) {
            if (await restartGuardIfIdle(out)) {
              out.progress("Restarted the guard with the new cost guard setting");
              if (!(await waitForGuard(localUrl, 15_000))) out.warn(`The guard does not answer on ${localUrl} after its restart; check \`tapdance host status\`.`);
            } else out.warn(`The new cost guard setting applies when the guard restarts: \`systemctl --user restart ${GUARD_SYSTEMD_UNIT}\` once no lease is running.`);
          }
          if (!r.answering) {
            const log = r.log ? await readFile(r.log, "utf8").catch(() => "") : (await runCommand("journalctl", ["--user", "-u", "tapdance-guard.service", "-n", "30", "--no-pager"])).out;
            const runs = [process.execPath, CLI_ENTRY, "worker", "guard", "start", ...(o.allowAdminAccount ? ["--allow-admin-account"] : [])];
            throw commandFailed(runs, log, `The guard service is installed but does not answer on ${r.url}`, r.log ? `Read ${r.log}; fix what it reports, then run \`${hostUpCommand(o)}\` again.` : `Read \`journalctl --user -u tapdance-guard.service\`, then run \`${hostUpCommand(o)}\` again.`);
          }
          return settings;
        });

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
              hint: `Run \`${hostUpCommand({ ...o, label }, { repair: true })}\` to revoke it and issue a new token, or pick another --label.`,
            });
          }
          if (!o.yes && !process.env["TAPDANCE_GUARD_PAIR_NONINTERACTIVE"]) {
            if (!process.stdin.isTTY) throw pairingApprovalRefusal(o, label, activeLabels);
            const days = policy.limits.tokenDays;
            if (!(await confirm(`Pair a control machine as "${label}"? It gets device-only access to this machine for ${days} day(s).`))) {
              throw new TapdanceError("USAGE", "Pairing not approved; nothing was issued");
            }
          }
          for (const t of active) await tokens.revoke(t.id);
          const { secret: issued, token } = await issuePairing(label, undefined, parseScopes(o.scope));
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
          // Without tailnet HTTPS certificates, serve plain HTTP inside the tailnet: WireGuard encrypts it.
          const mode = state.https ? "https" : "http";
          if (mode === "http") {
            out.warn(
              `This tailnet has no HTTPS certificates; serving the guard over HTTP inside the tailnet (WireGuard-encrypted). Recommended: turn on HTTPS Certificates (${TAILSCALE_DNS_ADMIN}) for an https:// endpoint and live video in \`tapdance view --tailscale\`; then run host up again (agents must connect again: the address changes to https://).`,
            );
          }
          const args = tailscaleServeArgs(port, mode);
          const serve = await runCommand(bin, args);
          if (!serve.ok) {
            if (serveNeedsOperator(platform, serve.out)) {
              throw commandFailed([bin, ...args], serve.out, "tailscale serve refused this user", `On Linux only root and the tailnet's operator may change \`tailscale serve\`. Run \`sudo tailscale set --operator=$USER\` once, then \`${hostUpCommand(o)}\` again.`);
            }
            throw commandFailed([bin, ...args], serve.out, "tailscale serve could not expose the guard", "Check `tailscale serve status`; on a tailnet with HTTPS certificates see https://tailscale.com/kb/1153/enabling-https. Or pass --no-tailscale.");
          }
          return hostEndpoint(state.dnsName, port, mode);
        });

        const { devices, selfTest } = await step(out, "self-test", async () => {
          const work = await mkdtemp(join(tmpdir(), "tapdance-host-"));
          const env: NodeJS.ProcessEnv = { ...process.env, TAPDANCE_PROVIDER: "self-hosted", TAPDANCE_ENDPOINT: localUrl, TAPDANCE_TOKEN: secret, TAPDANCE_ARTIFACTS_DIR: work };
          delete env["TAPDANCE_CONFIG"];
          const t = await Tapdance.create({ cwd: work, env, session: { id: `host-self-test-${process.pid}`, source: "host up" }, owner: "cli", onProgress: (m) => out.progress(m) });
          try {
            const inventory = await t.devices();
            const devices = describeCatalog(inventory.catalog);
            // A platform with room but nothing on offer would make the self-test quietly fall back (#39).
            for (const note of inventory.notes) if (/ is not available right now/.test(note)) out.warn(note);
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
        const costGuard = describeHostStop(hostStop, platform);
        const cloudCost = cloudCostNote(cloudVm);
        const block = { endpoint, tokenPath, devices, selfTest, fingerprint: tokenFingerprint(secret), label, costGuard, ...(cloudCost ? { cloudCost } : {}) };
        out.result({ ready: true, ...block, label, android: prereq.android, ios: prereq.ios, hostStop: hostStop ?? { idleMinutes: 0, maxUptimeHours: 0 } }, () =>
          [
            renderReadyBlock(block),
            dim(`warm spares: ${o.warm ? o.warm : "one booted spare per device kind you used (fast next lease)"}; it uses memory while the worker runs. Change: tapdance host warm android=0,ios=0. Stop everything: tapdance host pause.`),
            "",
            yellow(hostSecurityNote(platform, userInfo().username, o.scope)),
            ...(endpoint.includes(".ts.net") ? [dim(tailscaleAclHint(platform, Number(new URL(endpoint).port) || 4720))] : []),
            ...(endpoint.startsWith("http://127.0.0.1")
              ? ["", yellow("The endpoint is loopback only: an agent on another machine cannot reach it until Tailscale is set up (then run this command again).")]
              : []),
          ].join("\n"),
        );
        // One keypress to get the token onto the clipboard; it never reaches the terminal. A machine with
        // no display or no clipboard tool (a server over ssh) is not asked.
        if (!g.json && process.stdin.isTTY && process.stdout.isTTY) {
          if (!offerClipboard(osPlatform(), process.env, (bin) => findOnPath(bin, process.env["PATH"] ?? "", existsSync) !== undefined)) {
            out.progress(`No clipboard here: copy ${tokenPath} to the agent's machine privately (scp), or print it with \`tapdance host token --show --label ${label}\`.`);
          } else if (await confirm("Copy the token to the clipboard now?")) {
            const copied = await copyToClipboard(secret);
            out.progress(copied ? "Token copied. Paste it to your agent privately (a direct message, not a shared channel)." : "No clipboard tool found; run `tapdance host token --show` to see it.");
          }
        }
      } catch (error) {
        process.exitCode = reportFailure(out, Boolean(g.json), error);
      }
    });

  host
    .command("pause")
    .description("Stop hosting for now, keeping the pairing: the guard (and caffeinate), Tailscale exposure, the worker and its devices stop, and nothing restarts at login")
    .action(async () => {
      const out = output(globals());
      try {
        const platform = assertHostPlatform(osPlatform());
        const { policy } = await loadPolicy();
        const io = { run: runCommand, uid: process.getuid?.() ?? 0 };
        // Remember how the guard ran, so `resume` brings back the same thing.
        const paths = guardServicePaths(platform, homedir());
        const definition = await readFile(paths.file, "utf8").catch(() => "");
        const bin = findTailscale();
        const served = bin ? serveHasPort((await runCommand(bin, ["serve", "status", "--json"])).out, policy.listen.port) : false;
        const state: PausedState = {
          pausedAt: new Date().toISOString(),
          guardService: definition !== "",
          allowAdminAccount: definition.includes("--allow-admin-account"),
          keepAwake: definition.includes("caffeinate"),
          tailscale: served,
          workerService: await workerServiceInstalled(),
        };
        await mkdir(guardDir(), { recursive: true, mode: 0o700 });
        await writeFile(join(guardDir(), "paused.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        out.progress("Stopping the guard (and caffeinate)");
        await uninstallGuardService(platform, homedir(), io);
        if (bin && served) {
          await runCommand(bin, tailscaleServeOffArgs(policy.listen.port, "https"));
          await runCommand(bin, tailscaleServeOffArgs(policy.listen.port, "http"));
        }
        out.progress("Ending leases and stopping the worker and its devices");
        if (await workerRunning()) await simlockNuke();
        if (state.workerService) await setWorkerService(false);
        const worker = await stopWorkerCompletely(out, { uninstallService: false });
        out.result({ paused: true, ...state, stoppedDevices: worker.stoppedDevices }, () =>
          [
            `Paused. The VPS cannot reach this machine; no guard, caffeinate, worker or ${worker.stoppedDevices.length ? `devices (${worker.stoppedDevices.length} shut down)` : "devices"} run, and nothing starts at login.`,
            dim("The pairing token is kept (it still expires on its own date). Start again with `tapdance host resume`."),
          ].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  host
    .command("resume")
    .description("Start hosting again after `host pause`, the same way as before (guard flags, Tailscale, login services)")
    .option("--allow-admin-account", "run the guard from an administrator account (remembered from `host pause` when it was used)")
    .option("--keep-awake", "macOS: run the guard under `caffeinate -i` (remembered from `host pause` when it was used)")
    .action(async (o: { allowAdminAccount?: boolean; keepAwake?: boolean }) => {
      const out = output(globals());
      try {
        assertHostPlatform(osPlatform());
        const file = join(guardDir(), "paused.json");
        const state = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as Partial<PausedState>;
        const allowAdminAccount = Boolean(o.allowAdminAccount || state.allowAdminAccount);
        const keepAwake = Boolean(o.keepAwake || state.keepAwake);
        if (!state.pausedAt) {
          out.warn(
            `No pause was recorded (resume follows \`tapdance host pause\`). After \`host down\` or a first setup, use \`tapdance host up\`. Starting with ${allowAdminAccount ? "" : "no "}--allow-admin-account and ${keepAwake ? "" : "no "}--keep-awake.`,
          );
        }
        // Refuse before starting anything, so a refused guard does not leave the worker half up.
        assertGuardHostSafe(allowAdminAccount, "Run `tapdance host resume --allow-admin-account` to accept running the guard from this account, or use a dedicated standard account (docs/security/personal-mac.md).");
        out.progress("Starting the worker");
        if (state.workerService !== false) await setWorkerService(true);
        await startWorker(out);
        out.progress("Starting the guard");
        const guard = await installGuardAsService({ allowAdminAccount, keepAwake });
        const { policy } = await loadPolicy();
        const port = policy.listen.port;
        let endpoint = hostEndpoint(undefined, port);
        const bin = findTailscale();
        if (bin && state.tailscale !== false) {
          const ts = parseTailscaleStatus((await runCommand(bin, ["status", "--json"])).out);
          if (ts.loggedIn && ts.dnsName) {
            const mode = ts.https ? "https" : "http";
            const r = await runCommand(bin, tailscaleServeArgs(port, mode));
            if (r.ok) endpoint = hostEndpoint(ts.dnsName, port, mode);
            else out.warn(`tailscale serve failed: ${r.out.split("\n")[0] ?? ""}`);
          } else out.warn("Tailscale is not logged in; the guard stays on loopback until you log in and run `tapdance host resume` again.");
        }
        await rm(file, { force: true });
        const paired = await pairings();
        const active = paired.filter((p) => p.state === "active");
        out.result({ resumed: true, endpoint, guard, pairings: paired }, () =>
          [
            `Resumed: guard ${keepAwake ? "(with caffeinate) " : ""}answering, endpoint ${endpoint}.`,
            active.length
              ? `Pairing ${active.map((p) => `"${p.label}"`).join(", ")} still valid: the VPS can connect again as before.`
              : yellow("No valid pairing token (expired or revoked): run `tapdance host up --repair` to issue a new one, then hand it over with `tapdance host token`."),
          ].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  host
    .command("warm [counts]")
    .description(
      "Set how many booted spare devices the worker keeps (e.g. android=0,ios=0), or `default` for Simlock's own (one spare per device kind leases used), without re-running host up; restarts the worker only when nothing is leased. With no counts, shows the current setting and spares",
    )
    .option("--now", "restart the worker even if a lease is running (that ends the lease)")
    .action(async (counts: string | undefined, o: { now?: boolean }) => {
      const out = output(globals());
      try {
        if (counts === undefined) {
          const report = await warmReport();
          out.result(report, () => report.text);
          return;
        }
        if (counts === "default") {
          const running = await workerRunning();
          const r = await resetWarm(out, { restart: !running ? "never" : o.now ? "always" : "if-idle" });
          out.result(r, () =>
            r.removed.length === 0
              ? "The worker already uses Simlock's default spares (nothing to remove)."
              : !running
                ? "Back to Simlock's default spares; the worker is not running, so it applies when it starts."
                : r.restarted
                  ? "Back to Simlock's default spares; the worker restarted with it."
                  : `Back to Simlock's default spares in the config, but ${r.activeLeases} lease(s) are running, so the worker was not restarted. It applies at the next \`tapdance worker restart\`, or now with --now, which ends the running lease(s).`,
          );
          return;
        }
        const warm = parseWarm(counts);
        if (!(await workerRunning())) {
          const r = await applyWarm(out, warm, { restart: "never" });
          out.result(r, () => "Saved; the worker is not running, so it applies when it starts.");
          return;
        }
        const r = await applyWarm(out, warm, { restart: o.now ? "always" : "if-idle" });
        out.result(r, () =>
          r.restarted
            ? `Spares set to ${counts}; the worker restarted with it.`
            : `Saved ${counts}, but ${r.activeLeases} lease(s) are running, so the worker was not restarted. It applies at the next worker restart (\`tapdance worker restart\` once the test is done), or now with --now, which ends the running lease(s).`,
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  // ------------------------------------------------------------------ builds (#45)
  const builds = host.command("builds").description("Let the agent build apps on this machine from allow-listed git repositories (off by default)");
  builds
    .command("enable")
    .description("Allow builds from these repositories (git mode): the agent sends a repo and ref, this machine fetches and builds it")
    .requiredOption("--repo <url>", "repository allowed to be built (repeatable)", (v: string, prev: string[] = []) => [...prev, v])
    .option("--git-auth <mode>", "how git reaches private repositories: gh (this machine's `gh auth`, e.g. a fine-grained read-only token), deploy-key (`host builds key`), or none; a repository's own key from `host builds key --repo` is used whenever it exists (default: keep the current setting, else none)")
    .option("--protected-ref <branch>", "only build commits already on this branch of the remote, e.g. main (repeatable)", (v: string, prev: string[] = []) => [...prev, v])
    .option("--timeout-minutes <n>", "longest build (default: keep the current setting, else 45)")
    .option("--allow-admin-account", "accept the risk of building on an administrator account")
    .action(async (o: { repo: string[]; gitAuth?: string; protectedRef?: string[]; timeoutMinutes?: string; allowAdminAccount?: boolean }) => {
      const out = output(globals());
      try {
        if (o.gitAuth !== undefined && !["none", "gh", "deploy-key"].includes(o.gitAuth)) throw new TapdanceError("USAGE", "--git-auth must be gh, deploy-key or none");
        for (const repo of o.repo) if (!/^(https:\/\/|ssh:\/\/|git@)/.test(repo)) throw new TapdanceError("USAGE", `${repo} is not an https:// or ssh git URL`);
        if (osPlatform() === "darwin" && (await isMacAdmin()) && !o.allowAdminAccount) {
          throw new TapdanceError("FORBIDDEN", `This macOS account (${userInfo().username}) is an administrator`, {
            hint: "A build runs the project's scripts as this account, and an administrator can become root. Build from a dedicated standard account, or accept the risk: add --allow-admin-account.",
          });
        }
        const { path } = await loadPolicy();
        const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
        raw["allow"] = { ...(raw["allow"] ?? {}), builds: true };
        // Options left out keep what an earlier `host builds enable` set (adding a repository must not
        // turn a private repository's git auth back to none).
        const current = (raw["builds"] ?? {}) as { repos?: string[]; gitAuth?: string; timeoutMinutes?: number };
        raw["builds"] = {
          ...current,
          repos: [...new Set([...(current.repos ?? []), ...o.repo])],
          gitAuth: o.gitAuth ?? current.gitAuth ?? "none",
          ...(o.protectedRef?.length ? { protectedRefs: o.protectedRef } : {}),
          timeoutMinutes: o.timeoutMinutes !== undefined ? Number(o.timeoutMinutes) : (current.timeoutMinutes ?? 45),
        };
        const policy = GuardPolicySchema.parse(raw);
        await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
        const notes = await buildPrerequisites(policy.builds.gitAuth, policy.builds.repos);
        const restarted = await restartGuardIfIdle(out);
        out.result({ builds: policy.builds, restarted, notes }, () =>
          [
            `Builds allowed from: ${policy.builds.repos.join(", ")} (git auth: ${policy.builds.gitAuth}${policy.builds.protectedRefs.length ? `; only commits on ${policy.builds.protectedRefs.join(", ")}` : ""})`,
            ...notes.map((n) => yellow(n)),
            yellow("A build runs the repository's own scripts (Xcode run-script phases, Gradle) on this machine as this account. Allow only repositories you trust, and prefer --protected-ref main."),
            restarted ? "The guard restarted with the new policy." : "Restart the guard to apply it when no test is running: tapdance host builds enable … again then, or `tapdance worker guard install` after `tapdance worker guard uninstall`.",
          ].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
  builds
    .command("disable")
    .description("Turn builds off (the allow-list is kept)")
    .action(async () => {
      const out = output(globals());
      try {
        const { path } = await loadPolicy();
        const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
        raw["allow"] = { ...(raw["allow"] ?? {}), builds: false };
        await writeFile(path, `${JSON.stringify(GuardPolicySchema.parse(raw), null, 2)}\n`, { mode: 0o600 });
        const restarted = await restartGuardIfIdle(out);
        out.result({ builds: false, restarted }, () => `Builds are off${restarted ? "; the guard restarted" : ". Restart the guard to apply it when no test is running"}.`);
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
  builds
    .command("status")
    .description("Show whether builds are on, the allowed repositories (with their deploy key and build files) and the build cache")
    .action(async () => {
      const out = output(globals());
      try {
        const { policy } = await loadPolicy();
        const cache = join(guardDir(), "builds");
        const legacyKey = existsSync(join(cache, "deploy_key"));
        const repositories = await Promise.all(
          policy.builds.repos.map(async (repo) => {
            const own = existsSync(repoKeyPath(cache, repo));
            const deployKey = own ? "own" : legacyKey && policy.builds.gitAuth === "deploy-key" ? "shared" : "none";
            return { repo, deployKey, buildFiles: (await readBuildFiles(cache, repo)).length };
          }),
        );
        out.result({ enabled: policy.allow.builds, ...policy.builds, repositories, cache }, () =>
          [
            `Builds: ${policy.allow.builds ? green("on") : "off"}`,
            `Git auth: ${policy.builds.gitAuth}${policy.builds.protectedRefs.length ? `; protected refs: ${policy.builds.protectedRefs.join(", ")}` : ""}; timeout ${policy.builds.timeoutMinutes} min`,
            repositories.length === 0
              ? "Repositories: none"
              : table([
                  ["REPOSITORY", "DEPLOY KEY", "BUILD FILES"],
                  ...repositories.map((r) => [r.repo, r.deployKey === "own" ? "its own" : r.deployKey === "shared" ? "the shared deploy_key" : "-", String(r.buildFiles)]),
                ]),
            `Cache: ${cache} (delete a repository's folder there to free disk; the next build clones again. keys/, files/ and deploy_key hold your deploy keys and build files)`,
          ].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
  builds
    .command("key")
    .description("Create a read-only deploy key and print its public half to add to the repository; --repo makes one for that repository only (GitHub accepts a deploy key on one repository)")
    .option("--repo <url>", "the repository this key is for; its builds use it whatever --git-auth says")
    .action(async (o: { repo?: string }) => {
      const out = output(globals());
      try {
        const dir = join(guardDir(), "builds");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        if (o.repo !== undefined) {
          await repoDeployKey(out, dir, o.repo);
          return;
        }
        const key = join(dir, "deploy_key");
        if (!existsSync(key)) {
          const r = await runCommand("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `tapdance-builds@${hostname()}`, "-f", key]);
          if (!r.ok) throw commandFailed(["ssh-keygen"], r.out, "ssh-keygen could not create the deploy key");
        }
        const pub = (await readFile(`${key}.pub`, "utf8")).trim();
        out.result({ publicKey: pub, privateKey: key }, () =>
          [
            "Add this as a read-only deploy key in each repository (GitHub: Settings › Deploy keys › Add, leave write access off):",
            "",
            pub,
            "",
            `The private key stays here: ${key}. Use ssh URLs (git@github.com:owner/repo.git) with --git-auth deploy-key.`,
            "GitHub accepts one deploy key on one repository only: for a second repository, use `tapdance host builds key --repo <url>`.",
          ].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  const files = builds
    .command("files")
    .description("Files this machine copies into the checkout before each build of a repository: config kept out of git (google-services.json, local.properties, .env). Only you add or read them; agents cannot");
  files
    .command("add <path-in-repo>")
    .description(`Add or replace a build file: its content comes from --from or stdin (at most ${BUILD_FILE_MAX_BYTES / 1024 / 1024} MB, 50 files per repository)`)
    .requiredOption("--repo <url>", "the repository it belongs to")
    .option("--from <file>", "read the content from this local file instead of stdin")
    .action(async (pathInRepo: string, o: { repo: string; from?: string }) => {
      const out = output(globals());
      try {
        const builds = join(guardDir(), "builds");
        repoIdentity(o.repo);
        const content = await readBuildFileContent(o.from);
        const entry = await addBuildFile(builds, o.repo, pathInRepo, content);
        const { policy } = await loadPolicy();
        const allowed = policy.builds.repos.some((r) => repoIdentity(r) === repoIdentity(o.repo));
        out.result({ repo: normalizeRepo(o.repo), path: entry.path, size: entry.size, sha256: entry.sha256.slice(0, 8) }, () =>
          [
            `Added ${entry.path} for ${normalizeRepo(o.repo)} (${entry.size} bytes, sha256 ${entry.sha256.slice(0, 8)}).`,
            "Each build of this repository copies it into the checkout before building and removes it after; changing it builds again instead of reusing an earlier build. No guard restart needed.",
            ...(allowed ? [] : [yellow(`${o.repo} is not on the build allow-list yet: tapdance host builds enable --repo <url>.`)]),
          ].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
  files
    .command("list")
    .description("List build files: path, size and the start of the sha256, never their content")
    .option("--repo <url>", "only this repository")
    .action(async (o: { repo?: string }) => {
      const out = output(globals());
      try {
        const builds = join(guardDir(), "builds");
        if (o.repo !== undefined) repoIdentity(o.repo);
        const groups: Array<{ repo: string; files: BuildFileEntry[] }> = o.repo !== undefined ? [{ repo: normalizeRepo(o.repo), files: await readBuildFiles(builds, o.repo) }] : await listAllBuildFiles(builds);
        const rows = groups.flatMap((g) => g.files.map((f) => ({ repo: g.repo, path: f.path, size: f.size, sha256: f.sha256.slice(0, 8), addedAt: f.addedAt })));
        out.result({ files: rows }, () =>
          rows.length === 0
            ? `No build files${o.repo ? ` for ${normalizeRepo(o.repo)}` : ""}. Add one with: tapdance host builds files add --repo <url> <path-in-repo> --from <file>`
            : table([["REPOSITORY", "PATH", "BYTES", "SHA256"], ...rows.map((r) => [r.repo, r.path, String(r.size), r.sha256])]),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
  files
    .command("remove <path-in-repo>")
    .description("Remove a build file; the next build runs without it")
    .requiredOption("--repo <url>", "the repository it belongs to")
    .action(async (pathInRepo: string, o: { repo: string }) => {
      const out = output(globals());
      try {
        repoIdentity(o.repo);
        const entry = await removeBuildFile(join(guardDir(), "builds"), o.repo, pathInRepo);
        out.result({ repo: normalizeRepo(o.repo), path: entry.path, removed: true }, () => `Removed ${entry.path} for ${normalizeRepo(o.repo)}.`);
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  // ------------------------------------------------------------------ installs from CI
  const artifacts = host.command("artifacts").description("Let the agent install Android APKs your CI built (GitHub Actions artifacts), downloaded by this machine with its own gh (off by default)");
  artifacts
    .command("enable")
    .description("Allow installs from these repositories' GitHub Actions artifacts: this machine downloads them with its `gh auth` and installs the APK on the agent's Android lease")
    .requiredOption("--repo <owner/repo>", "GitHub repository (owner/repo or its https://github.com URL), repeatable", (v: string, prev: string[] = []) => [...prev, v])
    .option("--branch <name>", "only artifacts of runs on this branch, e.g. main (repeatable; replaces the list)", (v: string, prev: string[] = []) => [...prev, v])
    .option("--max-mb <n>", "largest artifact and APK, in MB (default 512)")
    .action(async (o: { repo: string[]; branch?: string[]; maxMb?: string }) => {
      const out = output(globals());
      try {
        const repos = o.repo.map((r) => githubRepo(r));
        for (const b of o.branch ?? []) if (!BRANCH_NAME.test(b)) throw new TapdanceError("USAGE", `${b} is not a git branch name`);
        const maxMB = o.maxMb === undefined ? undefined : Number(o.maxMb);
        if (maxMB !== undefined && !(Number.isInteger(maxMB) && maxMB >= 1 && maxMB <= 4096)) throw new TapdanceError("USAGE", "--max-mb must be a whole number from 1 to 4096");
        const { path } = await loadPolicy();
        const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
        raw["allow"] = { ...(raw["allow"] ?? {}), artifacts: true };
        const current = (raw["artifacts"] ?? {}) as { repos?: string[] };
        const merged = [...(current.repos ?? [])];
        for (const r of repos) if (!merged.some((m) => m.toLowerCase() === r.toLowerCase())) merged.push(r);
        raw["artifacts"] = {
          ...current,
          repos: merged,
          ...(o.branch?.length ? { branches: [...new Set(o.branch)] } : {}),
          ...(maxMB !== undefined ? { maxMB } : {}),
        };
        const policy = GuardPolicySchema.parse(raw);
        await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
        const gh = await ghStatus();
        const notes = gh.ok ? [] : [gh.note];
        const restarted = await restartGuardIfIdle(out);
        out.result({ artifacts: policy.artifacts, ghReady: gh.ok, restarted, notes }, () =>
          [
            `Installs from CI allowed from: ${policy.artifacts.repos.join(", ")}${policy.artifacts.branches.length ? ` (only runs on ${policy.artifacts.branches.join(", ")})` : " (any branch of the repository itself, not forks)"}; up to ${policy.artifacts.maxMB} MB`,
            ...notes.map((n) => yellow(n)),
            "This machine downloads the artifact with its own gh and installs the APK on the agent's Android lease; nothing from the repository runs here. Use a fine-grained, read-only token (Actions: read, Contents: read) for these repositories only.",
            restarted ? "The guard restarted with the new policy." : "Restart the guard to apply it when no test is running: run this command again then.",
          ].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
  artifacts
    .command("disable")
    .description("Turn installs from CI off (the allow-list is kept)")
    .action(async () => {
      const out = output(globals());
      try {
        const { path } = await loadPolicy();
        const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
        raw["allow"] = { ...(raw["allow"] ?? {}), artifacts: false };
        await writeFile(path, `${JSON.stringify(GuardPolicySchema.parse(raw), null, 2)}\n`, { mode: 0o600 });
        const restarted = await restartGuardIfIdle(out);
        out.result({ artifacts: false, restarted }, () => `Installs from CI are off${restarted ? "; the guard restarted" : ". Restart the guard to apply it when no test is running"}.`);
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
  artifacts
    .command("status")
    .description("Show whether installs from CI are on, the allowed repositories and branches, the download cache and whether this machine's gh is signed in")
    .action(async () => {
      const out = output(globals());
      try {
        const { policy } = await loadPolicy();
        const cache = join(guardDir(), "artifacts");
        const cacheBytes = await artifactCacheBytes(cache);
        const gh = await ghStatus();
        out.result({ enabled: policy.allow.artifacts, ...policy.artifacts, cache, cacheBytes, ghReady: gh.ok }, () =>
          [
            `Installs from CI: ${policy.allow.artifacts ? green("on") : "off"}`,
            `Repositories: ${policy.artifacts.repos.length ? policy.artifacts.repos.join(", ") : "none"}`,
            `Branches: ${policy.artifacts.branches.length ? policy.artifacts.branches.join(", ") : "any (runs of the repository itself, not forks)"}; largest artifact ${policy.artifacts.maxMB} MB`,
            `gh: ${gh.ok ? green("signed in") : yellow(gh.note)}`,
            `Cache: ${cache} (${(cacheBytes / 1024 / 1024).toFixed(1)} MB; the newest 3 downloads per repository are kept; delete the folder to free disk)`,
          ].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  host
    .command("token")
    .description("Hand a pairing token to the agent: copy it to the clipboard (default) or show it once")
    .option("--label <name>", "which pairing (default: the only one, or this machine's hostname)")
    .option("--copy", "copy it to the clipboard (the default)")
    .option("--show", "print it once (it stays in your terminal's scrollback)")
    .action(async (o: { label?: string; copy?: boolean; show?: boolean }) => {
      const out = output(globals());
      try {
        const files = await pairings();
        const label = o.label ? sanitizeLabel(o.label) : files.length === 1 ? files[0]!.label : defaultLabel(hostname());
        const file = files.find((p) => p.label === label);
        if (!file) throw new TapdanceError("USAGE", `No pairing token for "${label}"`, { hint: files.length ? `Pass --label with one of: ${files.map((p) => p.label).join(", ")}` : "Pair first with `tapdance host up`." });
        if (file.state !== "active") throw new TapdanceError("AUTH_FAILED", `The "${label}" pairing is ${file.state}`, { hint: "Issue a new one with `tapdance host up --repair`." });
        const token = (await readFile(file.path, "utf8")).trim();
        const fingerprint = tokenFingerprint(token);
        if (o.show) {
          out.warn("Showing the token: anyone who sees it can drive this machine's devices until it expires or you revoke it.");
          out.secretResult({ label, token, fingerprint }, () => token);
          return;
        }
        if (!(await copyToClipboard(token))) throw new TapdanceError("NOT_SUPPORTED", "No clipboard tool found", { hint: "Install wl-copy or xclip, or use `tapdance host token --show`." });
        out.result({ label, copied: true, fingerprint }, () => `Token for "${label}" copied (fingerprint ${fingerprint}). Paste it to your agent privately; \`tapdance connect\` prints the same fingerprint.`);
      } catch (error) {
        process.exitCode = out.error(error);
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
        const sdkMissing = summary.problems.find((c) => c.id === "host.android.sdk");
        rows.push({
          step: "prerequisites",
          ok: summary.android || summary.ios,
          detail: `${describePlatforms(summary, platform)}${sdkMissing && !summary.android ? `; the Android SDK was not found from this shell (${sdkMissing.detail}): set ANDROID_HOME, or run it from a login shell` : ""}`,
        });
        const admin = isMacAdmin();
        const gateway = joinedGateway();
        rows.push({ step: "account", ok: !gateway && process.getuid?.() !== 0, detail: `${userInfo().username}${admin ? " (administrator)" : ""}${gateway ? `; joined gateway ${gateway}` : ""}` });
        const worker = await localWorkerStatus();
        const devicesLine = worker !== undefined ? describeWorkerDevices(worker) : "";
        rows.push({ step: "worker", ok: worker !== undefined, detail: worker !== undefined ? `the local Simlock worker answers; ${devicesLine}` : "not answering (tapdance worker start, or tapdance host resume)" });
        const { policy } = await loadPolicy();
        const port = policy.listen.port;
        const localUrl = `http://${policy.listen.host}:${port}`;
        const service = await guardServiceState(servicePlatform(), homedir(), { run: runCommand, uid: process.getuid?.() ?? 0 });
        const answering = port !== 0 && (await waitForGuard(localUrl, 0));
        rows.push({ step: "guard service", ok: service.installed && answering, detail: `${service.installed ? "installed" : "not installed"}, ${service.detail}; ${answering ? `answers on ${localUrl}` : "not answering"}` });
        {
          const on = hostStopApplies(policy.hostStop, platform);
          const allowed = on ? await hostStopAllowed() : true;
          const seen = on ? (JSON.parse(await readFile(join(guardDir(), "host-stop.json"), "utf8").catch(() => "null")) as Parameters<typeof describeIdle>[0]) : undefined;
          const idle = on ? describeIdle(seen ?? undefined, Date.now()) : undefined;
          rows.push({
            step: "cost guard",
            ok: allowed,
            detail: [
              describeHostStop(policy.hostStop, platform),
              ...(idle ? [idle] : []),
              ...(on && !allowed ? [`sudo does not allow \`${HOST_STOP_COMMAND.join(" ")}\`: add the rule \`${sudoersRule(userInfo().username)}\` (tapdance host up prints how)`] : []),
            ].join("; "),
          });
        }
        if (platform === "linux") {
          const cloudCost = cloudCostNote(detectCloudVm(readDmi()));
          if (cloudCost) rows.push({ step: "cloud VM", ok: true, detail: cloudCost });
        }
        const paired = await pairings();
        const age = (iso: string) => `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86_400_000))} d old`;
        rows.push({
          step: "pairing",
          ok: paired.some((p) => p.state === "active"),
          detail:
            paired
              .map((p) => `${p.label}: ${p.state}${p.createdAt ? `, ${age(p.createdAt)}, expires ${p.expiresAt}` : ""}${p.scopes ? `, scopes ${p.scopes.join(",")}` : ""}`)
              .join("; ") || "none",
        });
        let endpoint = hostEndpoint(undefined, port);
        const bin = findTailscale();
        if (bin) {
          const state = parseTailscaleStatus((await runCommand(bin, ["status", "--json"])).out);
          const serveStatus = (await runCommand(bin, ["serve", "status", "--json"])).out;
          const served = serveHasPort(serveStatus, port);
          const mode = serveModeOf(serveStatus, port) ?? (state.https ? "https" : "http");
          if (state.loggedIn && served) endpoint = hostEndpoint(state.dnsName, port, mode);
          rows.push({
            step: "tailscale",
            ok: state.loggedIn && served,
            detail: `${state.loggedIn ? `logged in as ${state.dnsName ?? "?"}` : state.backendState}; ${served ? `serving :${port} over ${mode}` : `not serving :${port}`}; tailnet HTTPS certificates ${state.https ? "on" : "off"}`,
          });
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
    .option("--all", "everything: --revoke, plus end the worker's leases, shut down the emulators and simulators it created, stop it and remove its login service")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (o: { revoke?: boolean; all?: boolean; yes?: boolean }) => {
      if (o.all) o.revoke = true;
      const out = output(globals());
      try {
        const platform = assertHostPlatform(osPlatform());
        if (!o.yes) {
          if (!process.stdin.isTTY) throw new TapdanceError("USAGE", "host down needs confirmation", { hint: "Run it in a terminal, or pass --yes." });
          if (!(await confirm(o.all ? "Stop hosting completely: revoke every paired control machine, remove the guard and its Tailscale exposure, shut down the worker's devices, stop the worker and remove its login service?" : `Stop the worker guard${o.revoke ? ", revoke every paired control machine" : ""} and remove its Tailscale exposure?`))) {
            throw new TapdanceError("USAGE", "Cancelled; nothing changed");
          }
        }
        const { policy } = await loadPolicy();
        const service = await uninstallGuardService(platform, homedir(), { run: runCommand, uid: process.getuid?.() ?? 0 });
        let tailscale = "not installed";
        const bin = findTailscale();
        if (bin) {
          // Turn off both modes: the one set is removed, the other is a harmless no-op.
          const https = await runCommand(bin, tailscaleServeOffArgs(policy.listen.port, "https"));
          const http = await runCommand(bin, tailscaleServeOffArgs(policy.listen.port, "http"));
          tailscale = https.ok || http.ok ? `stopped serving :${policy.listen.port}` : `nothing to stop (${(https.out || http.out).split("\n")[0] ?? ""})`;
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
        const worker = o.all ? await stopWorkerCompletely(out, { uninstallService: true }) : undefined;
        out.result({ service: service.file, serviceRemoved: service.removed, tailscale, revoked, removedTokenFiles: removed, ...(worker ? { worker } : {}) }, () =>
          [
            service.removed ? `Removed the guard service (${service.file}).` : "No guard service was installed.",
            `Tailscale: ${tailscale}.`,
            o.revoke ? `Revoked ${revoked} token(s); deleted ${removed.length} token file(s).` : dim("Pairings are kept; revoke them with `tapdance worker guard revoke all` or `tapdance host down --revoke`."),
            worker
              ? `Worker stopped${worker.serviceRemoved ? " and its login service removed" : ""}; shut down ${worker.stoppedDevices.length} device(s)${worker.stoppedDevices.length ? `: ${worker.stoppedDevices.join(", ")}` : ""}. Start again with \`tapdance host up\`.`
              : dim("The Simlock worker still runs for local agents; stop everything with `tapdance host down --all`."),
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
        await probeEndpoint(endpoint, out);
        const token = await readSecret(`Token for ${origin} (from the host's pairing file; input hidden):`);
        if (!token) throw new TapdanceError("USAGE", "No token given", { hint: `Pipe the token file in: tapdance connect ${endpoint} < pairing-<label>.token` });
        await writeConfigFile(userConfigPath(), { ...(await readUserConfig()), provider: "self-hosted", endpoint });
        const saved = await saveCredentials({ token, endpoint: origin });
        out.progress(`Wrote ${userConfigPath()} (provider self-hosted, endpoint ${endpoint}); token saved to ${saved} (mode 600) for ${origin} only; fingerprint ${tokenFingerprint(token)} (it should match what host up showed)`);
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

/**
 * Checks that `endpoint` answers before `connect` saves it: an address the guard no longer serves
 * (http after it switched to https, a stale name) fails here with the fix, not later in doctor.
 */
async function probeEndpoint(endpoint: string, out: ReturnType<typeof output>): Promise<void> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/healthz`, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) return;
      const body = (await response.text().catch(() => "")).slice(0, 300);
      const bad = describeBadHealth(endpoint, { status: response.status, body, ms: 0 }, "Check the address `host up` printed.");
      throw new TapdanceError("PROVIDER_UNREACHABLE", `Nothing saved: ${bad.detail}`, { hint: bad.fix });
    } catch (error) {
      if (error instanceof TapdanceError) throw error;
      lastError = error as Error;
      if (attempt === 1) out.progress(`${endpoint} did not answer yet; trying once more (a first TLS connection can take a few seconds)`);
    }
  }
  const reason = lastError?.cause instanceof Error ? lastError.cause.message : (lastError?.message ?? "no answer");
  throw new TapdanceError("PROVIDER_UNREACHABLE", `Nothing saved: ${endpoint} did not answer (${reason})`, {
    hint: "Check the address `host up` printed (its scheme too: http:// or https://), that both machines are on the same tailnet (`tailscale status`), and that the guard runs (`tapdance host status` on the host).",
  });
}

/**
 * `host builds key --repo <url>`: a deploy key for one repository (GitHub refuses a deploy key that
 * another repository already has), under builds/keys/<slug>, private half 600 in a 700 folder.
 */
async function repoDeployKey(out: Output, buildsDir: string, repo: string): Promise<void> {
  const identity = repoIdentity(repo);
  const keys = join(buildsDir, "keys");
  await mkdir(keys, { recursive: true, mode: 0o700 });
  await chmod(keys, 0o700);
  const key = repoKeyPath(buildsDir, repo);
  const created = !existsSync(key);
  if (created) {
    const r = await runCommand("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `tapdance-builds@${hostname()} ${identity}`, "-f", key]);
    if (!r.ok) throw commandFailed(["ssh-keygen"], r.out, "ssh-keygen could not create the deploy key");
  }
  await chmod(key, 0o600);
  const pub = (await readFile(`${key}.pub`, "utf8")).trim();
  const [host, ...path] = identity.split("/");
  const github = host === "github.com" ? `https://github.com/${path.join("/")}/settings/keys` : undefined;
  const sshUrl = `git@${host}:${path.join("/")}.git`;
  out.result({ repo: normalizeRepo(repo), slug: repoSlug(repo), publicKey: pub, privateKey: key, created, ...(github ? { addAt: github } : {}) }, () =>
    [
      `${created ? "Created" : "Already have"} a deploy key for ${identity}. Add this public key to that repository only, read-only (${github ? `GitHub: ${github}, i.e. the repository's Settings › Deploy keys › Add deploy key, leave "Allow write access" off` : "your git server's deploy keys page for the repository, read-only"}):`,
      "",
      pub,
      "",
      `The private key stays here: ${key}. Builds of this repository use it whatever --git-auth says; allow and build it with the ssh URL (${sshUrl}).`,
    ].join("\n"),
  );
}

/** A build file's content: from `--from <file>`, else stdin; refused above the size cap. */
async function readBuildFileContent(from: string | undefined): Promise<Buffer> {
  const tooBig = () => new TapdanceError("USAGE", `The file is larger than 1 MB (${BUILD_FILE_MAX_BYTES} bytes), the most a build file may be`);
  if (from !== undefined) {
    const info = await stat(from).catch(() => undefined);
    if (!info?.isFile()) throw new TapdanceError("USAGE", `${from} is not a file`);
    if (info.size > BUILD_FILE_MAX_BYTES) throw tooBig();
    return readFile(from);
  }
  if (process.stdin.isTTY) throw new TapdanceError("USAGE", "No content: pass --from <file>, or pipe the file in", { hint: "e.g. tapdance host builds files add --repo <url> app/google-services.json --from ./google-services.json" });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += b.length;
    if (size > BUILD_FILE_MAX_BYTES) throw tooBig();
    chunks.push(b);
  }
  if (size === 0) throw new TapdanceError("USAGE", "Nothing came in on stdin", { hint: "Pass --from <file>, or pipe the file in: tapdance host builds files add --repo <url> <path-in-repo> < ./file" });
  return Buffer.concat(chunks);
}

/** What a build on this machine still needs: git, Xcode for iOS, a JDK for Gradle (KMP), gh for gh auth. */
async function buildPrerequisites(gitAuth: string, repos: string[] = []): Promise<string[]> {
  const notes: string[] = [];
  if (!(await runCommand("git", ["--version"])).ok) notes.push("git is not installed: builds cannot fetch anything.");
  if (osPlatform() === "darwin" && !(await runCommand("xcodebuild", ["-version"])).ok) notes.push("xcodebuild is not available: iOS builds need Xcode.");
  const javaHome = process.env["JAVA_HOME"];
  if (!(await runCommand(javaHome ? join(javaHome, "bin", "java") : "java", ["-version"])).ok) notes.push("No java on PATH: Android and Kotlin Multiplatform builds need a JDK (17) on the guard's PATH or JAVA_HOME.");
  if (gitAuth === "gh" && !(await runCommand("gh", ["auth", "status"])).ok) notes.push("`gh auth status` fails: run `gh auth login` on this machine.");
  if (gitAuth === "deploy-key" && !existsSync(join(guardDir(), "builds", "deploy_key"))) {
    const keyless = repos.filter((r) => !existsSync(repoKeyPath(join(guardDir(), "builds"), r)));
    if (keyless.length > 0) notes.push(`No deploy key yet for ${keyless.join(", ")}: run \`tapdance host builds key --repo <url>\` for each and add it to that repository.`);
  }
  return notes;
}

/** Whether this machine's gh is installed and signed in (installs from CI download with it). */
async function ghStatus(): Promise<{ ok: true } | { ok: false; note: string }> {
  const r = await runCommand("gh", ["auth", "status"]).catch(() => ({ ok: false, out: "" }));
  if (r.ok) return { ok: true };
  return {
    ok: false,
    note: /ENOENT|not found|could not start/i.test(r.out) || r.out === ""
      ? "gh is not installed or does not run here: install GitHub's CLI (https://cli.github.com), then `gh auth login --with-token` with a fine-grained, read-only token (Actions: read, Contents: read)."
      : "`gh auth status` fails: run `gh auth login --with-token` on this machine with a fine-grained, read-only token (Actions: read, Contents: read) for the allowed repositories.",
  };
}

/**
 * The guard reads its policy when it starts. Restart its service now unless a lease is running (a
 * restart forgets which client owns which lease).
 */
async function restartGuardIfIdle(out: ReturnType<typeof output>): Promise<boolean> {
  const status = (await localWorkerStatus().catch(() => undefined)) as { leases?: unknown[] } | undefined;
  if (Array.isArray(status?.leases) && status.leases.length > 0) {
    out.warn(`${status.leases.length} lease(s) are running, so the guard was not restarted.`);
    return false;
  }
  const uid = process.getuid?.() ?? 0;
  // Over a non-interactive ssh command systemctl --user needs the user manager's bus set up first.
  if (osPlatform() === "linux") await prepareLinuxUserServices(out).catch(() => undefined);
  const r =
    osPlatform() === "darwin"
      ? await runCommand("launchctl", ["kickstart", "-k", `gui/${uid}/${GUARD_LAUNCHD_LABEL}`])
      : await runCommand("systemctl", ["--user", "restart", GUARD_SYSTEMD_UNIT]);
  if (!r.ok) out.warn(`Could not restart the guard: ${r.out.split("\n")[0] ?? ""}`);
  return r.ok;
}
