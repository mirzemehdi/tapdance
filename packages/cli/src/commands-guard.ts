import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { TapdanceError, defaultProfilePath, findAndroidSdk, isPrivateHost, readLocalProfile } from "@tapdance/sdk";
import { releaseStaleDeviceClaims } from "@tapdance/provider-simlock";
import { CLI_ENTRY, output, type GlobalOptions } from "./context.js";
import { bold, dim, red, table, yellow } from "./output.js";
import { GuardTokens, guardDir, loadPolicy, scopeNames, type GuardToken } from "./guard/policy.js";
import { startGuard } from "./guard/server.js";
import { prepareLinuxUserServices,
  guardServiceEnvironment,
  guardServiceState,
  installGuardService,
  runCommand,
  uninstallGuardService,
  waitForGuard,
  type ServiceInstall,
  type ServicePlatform,
} from "./guard/service.js";

/** True when this macOS account is in the admin group. */
export function isMacAdmin(user = userInfo().username): boolean {
  if (process.platform !== "darwin") return false;
  try {
    return execFileSync("dseditgroup", ["-o", "checkmember", "-m", user, "admin"], { encoding: "utf8" }).startsWith("yes");
  } catch {
    return false;
  }
}

export function joinedGateway(): string | undefined {
  const file = join(process.env["SIMLOCK_HOME"] ?? join(homedir(), ".simlock"), "config.json");
  if (!existsSync(file)) return undefined;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { gateway?: { url?: string } }).gateway?.url;
  } catch {
    return undefined;
  }
}

/**
 * The refusals every way of running the guard shares (`start`, `install`, `host up`): never as root,
 * not from an administrator account unless the owner says so, and not while the local worker has
 * joined a gateway (which would reach this machine around the guard).
 */
export function assertGuardHostSafe(allowAdminAccount: boolean, adminHint?: string): void {
  if (process.getuid?.() === 0) throw new TapdanceError("FORBIDDEN", "Refusing to run the worker guard as root");
  if (isMacAdmin() && !allowAdminAccount) {
    throw new TapdanceError("FORBIDDEN", `This macOS account (${userInfo().username}) is an administrator`, {
      hint: adminHint ?? "Run the worker as a dedicated standard account (infrastructure/scripts/macos-create-worker-account.sh); see docs/security/device-only-mode.md.",
    });
  }
  const gateway = joinedGateway();
  if (gateway) {
    throw new TapdanceError("FORBIDDEN", `This worker has joined the gateway ${gateway}, which gives that gateway command execution here around the guard`, {
      hint: "Leave it first: tapdance worker logout. In device-only mode the remote side reaches this machine only through the guard.",
    });
  }
}

/** Issues a guard token for a control machine, capped at the policy's lifetime. */
export async function issuePairing(label: string, days?: string | number, scopes?: string[]): Promise<{ secret: string; token: GuardToken }> {
  const { policy } = await loadPolicy();
  const n = Math.min(Number(days ?? policy.limits.tokenDays), policy.limits.tokenDays);
  return new GuardTokens().issue(label, n, scopes);
}

/** `--scope interaction,inspection,screenshots`: checked against the policy's area names. */
export function parseScopes(spec: string | undefined): string[] | undefined {
  if (spec === undefined) return undefined;
  const names = scopeNames();
  const scopes = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = scopes.filter((s) => !names.includes(s));
  if (unknown.length || scopes.length === 0) {
    throw new TapdanceError("USAGE", `Unknown scope${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ") || "(none)"}`, { hint: `Scopes: ${names.join(", ")}.` });
  }
  return [...new Set(scopes)];
}

/** The service manager on this OS, or NOT_SUPPORTED. */
export function servicePlatform(platform: NodeJS.Platform = process.platform): ServicePlatform {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new TapdanceError("NOT_SUPPORTED", `The worker guard cannot run on ${platform}: Simlock workers run on macOS and Linux only`, {
    hint: "Use this machine as the control machine instead (`tapdance connect <guard URL>`), or run the worker on a Mac, a Linux box, or a Linux VM with nested virtualization.",
  });
}

export interface GuardServiceResult extends ServiceInstall {
  url: string;
  answering: boolean;
  notes: string[];
}

/** `worker guard install`: the LaunchAgent / systemd user unit that keeps `worker guard start` running. */
export async function installGuardAsService(o: { allowAdminAccount?: boolean; keepAwake?: boolean }, adminHint?: string): Promise<GuardServiceResult> {
  const platform = servicePlatform();
  assertGuardHostSafe(Boolean(o.allowAdminAccount), adminHint);
  const { policy } = await loadPolicy();
  if (!isPrivateHost(policy.listen.host)) throw new TapdanceError("CONFIG_INVALID", `policy.listen.host ${policy.listen.host} is not a private address`);
  if (platform === "linux") await prepareLinuxUserServices({ progress: (m) => process.stderr.write(`› ${m}\n`), warn: (m) => process.stderr.write(`! ${m}\n`) });
  const io = { run: runCommand, uid: process.getuid?.() ?? 0 };
  const url = `http://${policy.listen.host}:${policy.listen.port}`;
  // A `guard start` still running in a terminal holds the port: the service would restart in a loop
  // while that other guard answers, and the check below would wrongly succeed.
  if (policy.listen.port !== 0 && !(await guardServiceState(platform, homedir(), io)).running && (await waitForGuard(url, 0))) {
    throw new TapdanceError("USAGE", `A worker guard already answers on ${url}, outside the service`, {
      hint: "Stop it first (Ctrl-C in the terminal running `tapdance worker guard start`), then install again.",
    });
  }
  const installed = await installGuardService(
    {
      platform,
      node: process.execPath,
      cli: CLI_ENTRY,
      startFlags: o.allowAdminAccount ? ["--allow-admin-account"] : [],
      keepAwake: Boolean(o.keepAwake),
      environment: guardServiceEnvironment(process.env, process.execPath, findAndroidSdk()),
      home: homedir(),
    },
    io,
  );
  const notes: string[] = [];
  if (o.keepAwake && platform === "linux") {
    notes.push('--keep-awake has no effect on Linux. Keep the machine awake with: systemd-inhibit --what=idle:sleep --why="tapdance worker guard" sleep infinity');
  }

  notes.push("The service runs this Node.js and this Tapdance build by absolute path: install it again after moving the checkout or upgrading Node.js.");
  const answering = policy.listen.port === 0 ? false : await waitForGuard(url, 20_000);
  return { ...installed, url, answering, notes };
}

export function registerGuardCommands(worker: Command, globals: () => GlobalOptions): void {
  const guard = worker
    .command("guard")
    .description("Device-only access for remote agents: the only endpoint they reach on this machine, enforcing a local policy");

  guard
    .command("start")
    .description("Serve the device-only API (loopback by default; expose it with Tailscale, never publicly)")
    .option("--allow-admin-account", "run even though this account is an administrator (not recommended)")
    .action(async (o: { allowAdminAccount?: boolean }) => {
      const out = output(globals());
      try {
        assertGuardHostSafe(Boolean(o.allowAdminAccount));
        const { policy, path } = await loadPolicy();
        if (!isPrivateHost(policy.listen.host)) throw new TapdanceError("CONFIG_INVALID", `policy.listen.host ${policy.listen.host} is not a private address`);
        const upstream = await readLocalProfile(defaultProfilePath());
        if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(upstream.baseUrl)) {
          throw new TapdanceError("CONFIG_INVALID", `Simlock must listen on loopback, not ${upstream.baseUrl}`);
        }
        const { url, close } = await startGuard({ upstream, policy, log: (m) => out.warn(m), settleStaleClaims: () => releaseStaleDeviceClaims() });
        out.result({ url, policy: path, profile: policy.profile }, () =>
          [
            bold(`Worker guard (${policy.profile}) on ${url}`),
            `Policy: ${path} (edit it here; remote clients cannot change it)`,
            `Audit log: ${join(guardDir(), "audit.log")}`,
            dim("Reach it from the control machine over your tailnet, e.g. `tailscale serve --bg --https=4720 http://127.0.0.1:4720`."),
            dim("Issue a credential for the control machine with: tapdance worker guard pair --label <name>"),
          ].join("\n"),
        );
        await new Promise<void>((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
        await close();
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  guard
    .command("install")
    .description("Keep the guard running: a LaunchAgent (macOS) or systemd user unit (Linux) that starts it at login and restarts it")
    .option("--allow-admin-account", "run even though this account is an administrator (not recommended)")
    .option("--keep-awake", "macOS: run the guard under `caffeinate -i` so idle sleep does not take it offline")
    .action(async (o: { allowAdminAccount?: boolean; keepAwake?: boolean }) => {
      const out = output(globals());
      try {
        const r = await installGuardAsService(o);
        out.result({ installed: r.file, unchanged: Boolean(r.unchanged), platform: r.platform, log: r.log ?? null, url: r.url, answering: r.answering, commands: r.commands, notes: r.notes }, () =>
          [
            bold(r.unchanged ? `The worker guard service is already installed and running: ${r.file}` : `Installed the worker guard service: ${r.file}`),
            r.answering ? `The guard answers on ${r.url}.` : yellow(`The guard does not answer on ${r.url} yet; read its log.`),
            `Log: ${r.log}`,
            ...r.notes.map((n) => dim(n)),
            dim("Remove it with: tapdance worker guard uninstall"),
          ].join("\n"),
        );
        if (!r.answering) process.exitCode = 4;
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  guard
    .command("uninstall")
    .description("Stop the guard service and remove its LaunchAgent / systemd user unit (tokens and policy are kept)")
    .action(async () => {
      const out = output(globals());
      try {
        const r = await uninstallGuardService(servicePlatform(), homedir(), { run: runCommand, uid: process.getuid?.() ?? 0 });
        out.result(r, () => (r.removed ? `Stopped the worker guard and removed ${r.file}.` : `No guard service was installed (${r.file}); nothing to remove.`));
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  guard
    .command("pair")
    .description("Approve a control machine locally: prints a revocable device-only token once")
    .requiredOption("--label <name>", "who it is for, e.g. hetzner-vps")
    .option("--days <n>", "lifetime in days (policy maximum applies)")
    .option("--scope <areas>", "limit this token to these policy areas, e.g. interaction,inspection,screenshots (default: everything the policy allows)")
    .action(async (o: { label: string; days?: string; scope?: string }) => {
      const out = output(globals());
      try {
        if (!process.stdin.isTTY && !process.env["TAPDANCE_GUARD_PAIR_NONINTERACTIVE"]) {
          throw new TapdanceError("FORBIDDEN", "Pairing must be approved at this machine's terminal", { hint: "Run it in a local terminal (not over a pipe)." });
        }
        const { secret, token } = await issuePairing(o.label, o.days, parseScopes(o.scope));
        out.secretResult({ id: token.id, label: token.label, expiresAt: token.expiresAt, secret }, () =>
          [
            bold(`Paired "${token.label}" (${token.id}), expires ${token.expiresAt}`),
            "Give this token to that machine only (it is shown once):",
            `  ${secret}`,
            dim("On the control machine: tapdance init --mode self-hosted --endpoint https://<this-mac>.<tailnet>.ts.net:4720 && tapdance config set-token"),
            dim(`Revoke any time: tapdance worker guard revoke ${token.id}`),
          ].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  guard
    .command("tokens")
    .description("List paired control machines")
    .action(async () => {
      const out = output(globals());
      try {
        const all = await new GuardTokens().all();
        out.result({ tokens: all.map(({ hash: _h, ...t }) => t) }, () =>
          table([
            ["ID", "LABEL", "CREATED", "EXPIRES", "STATE", "SCOPES"],
            ...all.map((t) => [t.id, t.label, t.createdAt, t.expiresAt, t.revokedAt ? red("revoked") : Date.parse(t.expiresAt) < Date.now() ? yellow("expired") : "active", t.scopes ? t.scopes.join(",") : "all the policy allows"]),
          ]),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  guard
    .command("revoke <id>")
    .description("Revoke a paired control machine immediately (or `all`)")
    .action(async (id: string) => {
      const out = output(globals());
      try {
        const n = await new GuardTokens().revoke(id);
        if (n === 0 && id !== "all") {
          throw new TapdanceError("USAGE", `No active paired control machine with id ${id}`, { hint: "Revoke takes a token id (gt_…), not a label: list them with `tapdance worker guard tokens`." });
        }
        out.result({ revoked: n }, () => `Revoked ${n} token(s); requests using them are refused from now on.`);
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  guard
    .command("policy")
    .description("Show the local policy and its file")
    .action(async () => {
      const out = output(globals());
      try {
        const { policy, path } = await loadPolicy();
        out.result({ path, policy }, () => `${path}\n${JSON.stringify(policy, null, 2)}`);
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  guard
    .command("audit")
    .description("Show recent remote requests and decisions")
    .option("-n, --lines <n>", "how many", "50")
    .action(async (o: { lines: string }) => {
      const out = output(globals());
      try {
        const count = Number(o.lines);
        if (!/^\d+$/.test(o.lines) || count < 1 || count > 100_000) throw new TapdanceError("USAGE", `--lines must be an integer from 1 to 100000, not "${o.lines}"`);
        const file = join(guardDir(), "audit.log");
        const lines = existsSync(file) ? (await readFile(file, "utf8")).trim().split("\n").slice(-count) : [];
        out.result({ entries: lines.map((l) => JSON.parse(l) as unknown) }, () => lines.join("\n") || "no entries");
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
}
