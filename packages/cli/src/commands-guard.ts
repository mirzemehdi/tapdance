import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { TapdanceError, defaultProfilePath, isPrivateHost, readLocalProfile } from "@tapdance/sdk";
import { output, type GlobalOptions } from "./context.js";
import { bold, dim, red, table, yellow } from "./output.js";
import { GuardTokens, guardDir, loadPolicy } from "./guard/policy.js";
import { startGuard } from "./guard/server.js";

/** True when this macOS account is in the admin group. */
export function isMacAdmin(user = userInfo().username): boolean {
  if (process.platform !== "darwin") return false;
  try {
    return execFileSync("dseditgroup", ["-o", "checkmember", "-m", user, "admin"], { encoding: "utf8" }).startsWith("yes");
  } catch {
    return false;
  }
}

function joinedGateway(): string | undefined {
  const file = join(process.env["SIMLOCK_HOME"] ?? join(homedir(), ".simlock"), "config.json");
  if (!existsSync(file)) return undefined;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { gateway?: { url?: string } }).gateway?.url;
  } catch {
    return undefined;
  }
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
        if (process.getuid?.() === 0) throw new TapdanceError("FORBIDDEN", "Refusing to run the worker guard as root");
        if (isMacAdmin() && !o.allowAdminAccount) {
          throw new TapdanceError("FORBIDDEN", `This macOS account (${userInfo().username}) is an administrator`, {
            hint: "Run the worker as a dedicated standard account (infrastructure/scripts/macos-create-worker-account.sh); see docs/security/personal-mac.md.",
          });
        }
        const gateway = joinedGateway();
        if (gateway) {
          throw new TapdanceError("FORBIDDEN", `This worker has joined the gateway ${gateway}, which gives that gateway command execution here around the guard`, {
            hint: "Leave it first: tapdance worker logout. In device-only mode the remote side reaches this machine only through the guard.",
          });
        }
        const { policy, path } = await loadPolicy();
        if (!isPrivateHost(policy.listen.host)) throw new TapdanceError("CONFIG_INVALID", `policy.listen.host ${policy.listen.host} is not a private address`);
        const upstream = await readLocalProfile(defaultProfilePath());
        if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(upstream.baseUrl)) {
          throw new TapdanceError("CONFIG_INVALID", `Simlock must listen on loopback, not ${upstream.baseUrl}`);
        }
        const { url, close } = await startGuard({ upstream, policy, log: (m) => out.warn(m) });
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
    .command("pair")
    .description("Approve a control machine locally: prints a revocable device-only token once")
    .requiredOption("--label <name>", "who it is for, e.g. hetzner-vps")
    .option("--days <n>", "lifetime in days (policy maximum applies)")
    .action(async (o: { label: string; days?: string }) => {
      const out = output(globals());
      try {
        if (!process.stdin.isTTY && !process.env["TAPDANCE_GUARD_PAIR_NONINTERACTIVE"]) {
          throw new TapdanceError("FORBIDDEN", "Pairing must be approved at this machine's terminal", { hint: "Run it in a local terminal (not over a pipe)." });
        }
        const { policy } = await loadPolicy();
        const days = Math.min(Number(o.days ?? policy.limits.tokenDays), policy.limits.tokenDays);
        const { secret, token } = await new GuardTokens().issue(o.label, days);
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
          table([["ID", "LABEL", "CREATED", "EXPIRES", "STATE"], ...all.map((t) => [t.id, t.label, t.createdAt, t.expiresAt, t.revokedAt ? red("revoked") : Date.parse(t.expiresAt) < Date.now() ? yellow("expired") : "active"])]),
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
        const file = join(guardDir(), "audit.log");
        const lines = existsSync(file) ? (await readFile(file, "utf8")).trim().split("\n").slice(-Number(o.lines)) : [];
        out.result({ entries: lines.map((l) => JSON.parse(l) as unknown) }, () => lines.join("\n") || "no entries");
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
}
