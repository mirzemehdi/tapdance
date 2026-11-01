import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import { TapdanceError, hostChecks, isPrivateHost, saveCredentials, userConfigPath, writeConfigFile, type DoctorCheck, type TapdanceConfig } from "@tapdance/sdk";
import { agentDeviceBin, output, simlockBin, type GlobalOptions } from "./context.js";
import { bold, dim, renderChecks, yellow } from "./output.js";
import { readSecret } from "./commands-setup.js";
import { registerGuardCommands } from "./commands-guard.js";

const exec = promisify(execFile);

/** Runs the bundled Simlock CLI. Its output is returned, never printed raw (it can contain secrets). */
async function simlock(args: string[], timeoutMs = 180_000): Promise<string> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [simlockBin(), ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    const text = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message;
    throw new TapdanceError("PROVIDER_UNAVAILABLE", `simlock ${args.filter((a) => !a.startsWith("{")).join(" ")} failed: ${text.split("\n").slice(-3).join(" ")}`);
  }
}

/**
 * Some installers (pnpm's store, zip extraction) drop the execute bit on Simlock's bundled capture
 * helpers, and the stream then fails with EACCES. Put it back before the daemon starts.
 */
async function ensureSimlockHelpersExecutable(out: ReturnType<typeof output>): Promise<void> {
  const binDir = join(dirname(simlockBin()), "..", "bin");
  if (!existsSync(binDir)) return;
  for (const name of await readdir(binDir)) {
    const file = join(binDir, name);
    const mode = (await stat(file)).mode;
    if ((mode & 0o111) === 0) {
      await chmod(file, mode | 0o755);
      out.progress(`Made ${name} executable`);
    }
  }
}

async function restart(gateway: boolean, out: ReturnType<typeof output>): Promise<void> {
  const flag = gateway ? ["--gateway"] : ["--local"];
  out.progress(`Restarting the ${gateway ? "gateway" : "worker"} daemon`);
  await ensureSimlockHelpersExecutable(out);
  await simlock([...flag, "daemon", "stop"]).catch(() => "");
  // `daemon stop` returns while the old daemon is still draining; a start before it has gone loses
  // its connection (DAEMON_CONNECTION_LOST). Wait until status says stopped.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const status = await simlock([...flag, "daemon", "status"]).catch((e: Error) => e.message);
    if (/stopped|not running/i.test(status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!gateway) await killStaleAdbServer(out);
  for (let attempt = 1; ; attempt++) {
    try {
      await simlock([...flag, "daemon", "start"]);
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/**
 * Simlock runs its own adb server on a private port and records it in adb-server.json. If that server
 * outlives the daemon, the next start finds the port "occupied" and Android stays off. Stop it.
 */
async function killStaleAdbServer(out: ReturnType<typeof output>): Promise<void> {
  let port: unknown;
  try {
    port = (JSON.parse(await readFile(join(simlockHome(), "adb-server.json"), "utf8")) as { port?: unknown }).port;
  } catch {
    return;
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port === 5037) return;
  const sdk = process.env["ANDROID_HOME"] ?? process.env["ANDROID_SDK_ROOT"] ?? join(homedir(), osPlatform() === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
  const adb = existsSync(join(sdk, "platform-tools", "adb")) ? join(sdk, "platform-tools", "adb") : "adb";
  await exec(adb, ["-P", String(port), "kill-server"], { timeout: 15_000 }).then(
    () => out.progress(`Stopped Simlock's leftover adb server on port ${port}`),
    () => undefined,
  );
}

/**
 * Switching Simlock's iOS device set while its own set still holds simulators leaves iOS disabled
 * (`device-set-changed`). Refuse up front and give Simlock's documented migration.
 */
async function checkDeviceSetSwitch(): Promise<void> {
  let current = "simlock";
  try {
    const config = JSON.parse(await readFile(join(simlockHome(), "config.json"), "utf8")) as { drivers?: { ios?: { deviceSet?: unknown } } };
    if (typeof config.drivers?.ios?.deviceSet === "string") current = config.drivers.ios.deviceSet;
  } catch {
    // No config yet: Simlock's default is its own set.
  }
  if (current === "default") return;
  const own = await readdir(join(simlockHome(), "devices", "ios")).catch(() => [] as string[]);
  if (own.filter((n) => !n.startsWith(".")).length === 0) return;
  throw new TapdanceError("USAGE", `Simlock still has ${own.length} simulator(s) in its own device set; switching to AXe now would turn iOS off`, {
    hint: [
      "Move them first (this ends every lease on this worker and deletes only Simlock's simulators, never yours):",
      "  tapdance simlock --local nuke --delete-devices",
      "  tapdance simlock --local doctor --purge-orphans",
      "then run `tapdance worker install --ios-backend axe` again. See docs/ios/simulator-management.md.",
    ].join("\n"),
  });
}

async function readUserConfig(): Promise<Partial<TapdanceConfig>> {
  try {
    return JSON.parse(await readFile(userConfigPath(), "utf8")) as Partial<TapdanceConfig>;
  } catch {
    return {};
  }
}

function simlockHome(): string {
  return process.env["SIMLOCK_HOME"] ?? join(homedir(), ".simlock");
}

function checkGatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TapdanceError("USAGE", `"${raw}" is not a URL`, { hint: "Use wss://gateway.example.com (or ws://100.x.y.z:4700 on a private network)." });
  }
  if (url.protocol === "https:" || url.protocol === "http:") url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new TapdanceError("USAGE", "The gateway URL must start with wss:// (or ws:// on a private network)");
  if (url.protocol === "ws:" && !isPrivateHost(url.hostname)) {
    throw new TapdanceError("USAGE", `Refusing ws:// to public host ${url.hostname}: the join token would travel in plain text`, {
      hint: "Put TLS in front of the gateway and use wss://, or join over a private network such as Tailscale.",
    });
  }
  return url.toString().replace(/\/$/, "");
}

export function registerWorkerCommands(program: Command, globals: () => GlobalOptions): void {
  const worker = program.command("worker").description("Run this machine as a device worker (your laptop, a Mac, a KVM server)");

  registerGuardCommands(worker, globals);

  worker
    .command("check")
    .description("Check this machine can run emulators/simulators: SDKs, images, KVM, Xcode")
    .option("--android-only", "skip iOS checks")
    .action(async (o: { androidOnly?: boolean }) => {
      const out = output(globals());
      try {
        const checks = await hostChecks({ platforms: { android: true, ios: !o.androidOnly } });
        out.result({ checks }, () => renderChecks(checks));
        if (checks.some((c) => c.status === "fail" && c.id.startsWith("host.kvm"))) process.exitCode = 10;
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  worker
    .command("install")
    .description("Configure the bundled Simlock worker: agent-device, live streaming and input on; then start it")
    .option("--no-stream", "leave screen streaming and input off")
    .option("--ios-backend <backend>", "agent-device (default; works through gateways) or axe (Tapdance on this Mac only)", "agent-device")
    .option("--service", "also install it as a login service (launchd / systemd --user)")
    .action(async (o: { stream: boolean; iosBackend: string; service?: boolean }) => {
      const out = output(globals());
      try {
        if (osPlatform() === "win32") {
          throw new TapdanceError("NOT_SUPPORTED", "Windows cannot run a Tapdance worker yet: Simlock supports macOS and Linux only", {
            hint: "Use Windows as a control machine (CLI/MCP), or run the worker on a Mac, a Linux box, or a Linux VM with nested virtualization.",
          });
        }
        out.progress("Checking this machine");
        const checks = await hostChecks({ platforms: { android: true, ios: osPlatform() === "darwin" } });
        const kvmFail = checks.filter((c) => c.id.startsWith("host.kvm") && c.status === "fail");
        if (kvmFail.length > 0) {
          out.warn("Hardware acceleration is not available; Android emulators will not be provisioned here (no software fallback).");
        }
        if (!["agent-device", "axe"].includes(o.iosBackend)) throw new TapdanceError("USAGE", "--ios-backend must be agent-device or axe");
        const settings: Array<[string, string]> = [
          ["capabilities.agent-device.enabled", "true"],
          ["capabilities.agent-device.command", agentDeviceBin()],
          ["capabilities.stream.enabled", o.stream ? "true" : "false"],
          ["capabilities.input.enabled", o.stream ? "true" : "false"],
        ];
        if (o.iosBackend === "axe") {
          // AXe only sees Xcode's default device set (it hardcodes deviceSetPath nil).
          await checkDeviceSetSwitch();
          settings.push(["drivers.ios.deviceSet", "default"]);
          await writeConfigFile(userConfigPath(), { ...(await readUserConfig()), ios: { uiBackend: "axe" } });
        }
        for (const [key, value] of settings) {
          out.progress(`simlock config set ${key} ${key.endsWith("command") ? dim(value) : value}`);
          await simlock(["--local", "config", "set", key, value]);
        }
        await restart(false, out);
        if (o.service) {
          out.progress("Installing the login service");
          await simlock(["--local", "daemon", "install"]);
        }
        const status = await simlock(["--local", "status", "--json"]).catch(() => "{}");
        out.result({ configured: settings.map(([k]) => k), checks, status: safeJson(status) }, () =>
          [renderChecks(checks), "", bold("Worker is running."), dim("This machine now serves devices to agents on it (provider: local)."), "To serve a remote agent from a personal Mac, use device-only mode: tapdance worker guard start (see docs/security/personal-mac.md).", "On a dedicated worker machine: tapdance worker login --accept-gateway-exec --gateway wss://<gateway> --label <name>"].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  worker
    .command("login")
    .description("Join a gateway: the worker dials out over an authenticated WebSocket; no inbound port is opened")
    .requiredOption("--gateway <url>", "gateway address, e.g. wss://gateway.example.com")
    .option("--label <name>", "name shown in `tapdance workers list`")
    .option("--token-stdin", "read the join token from stdin (default when stdin is piped)")
    .option("--no-viewer", "leave live streaming and remote input off")
    .option("--accept-gateway-exec", "acknowledge that a joined gateway (and its agent tokens) can run programs on this machine")
    .action(async (o: { gateway: string; label?: string; viewer: boolean; acceptGatewayExec?: boolean }) => {
      const out = output(globals());
      try {
        if (!o.acceptGatewayExec) {
          throw new TapdanceError("FORBIDDEN", "Joining a gateway gives it, and every agent token it issues, command execution on this machine (Simlock's exec: `simctl spawn` starts any program)", {
            hint: "On a personal Mac use device-only mode instead: `tapdance worker guard start` (see docs/security/personal-mac.md). For a dedicated worker machine, re-run with --accept-gateway-exec.",
          });
        }
        const url = checkGatewayUrl(o.gateway);
        const token = process.env["TAPDANCE_WORKER_TOKEN"] ?? (await readSecret("Worker join token (from `tapdance gateway token --role worker`):"));
        if (!token) throw new TapdanceError("USAGE", "No join token given");
        const value = JSON.stringify({ url, token, ...(o.label ? { label: o.label } : {}) });
        out.progress(`Joining ${url}`);
        await simlock(["--local", "config", "set", "http.enabled", "false"]);
        for (const cap of ["agent-device", ...(o.viewer ? ["stream", "input"] : [])]) {
          await simlock(["--local", "config", "set", `capabilities.${cap}.enabled`, "true"]);
        }
        await simlock(["--local", "config", "set", "capabilities.agent-device.command", agentDeviceBin()]);
        await simlock(["--local", "config", "set", "gateway", value]);
        await restart(false, out);
        out.result({ joined: url, label: o.label ?? null, viewer: o.viewer }, () =>
          [
            `Joined ${url}${o.label ? ` as "${o.label}"` : ""}.`,
            "The gateway now has operator rights on this machine's devices; agents with gateway tokens can run commands here as this user.",
            "The worker reconnects on its own (1 s, doubling to 30 s) after network drops.",
            "On the gateway machine check it with: tapdance workers list",
            yellow("While joined, this machine's own HTTP API is off: agents on this machine must use the gateway too"),
            yellow(`(tapdance init --mode self-hosted --endpoint ${url.replace(/^ws/, "http")}).`),
            process.platform === "darwin" ? "Keep it awake while agents work: caffeinate -is (a closed lid or sleep takes the worker offline)." : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  worker
    .command("logout")
    .description("Leave the gateway and serve local agents only")
    .action(async () => {
      const out = output(globals());
      try {
        const file = join(simlockHome(), "config.json");
        if (existsSync(file)) {
          const data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
          delete data["gateway"];
          if (typeof data["http"] === "object" && data["http"] !== null) (data["http"] as Record<string, unknown>)["enabled"] = true;
          await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        }
        await restart(false, out);
        out.result({ left: true }, () => "Left the gateway. Revoke this worker's join token on the gateway: `tapdance simlock -- --gateway token list`, then `tapdance simlock -- --gateway token revoke <id>`.");
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  for (const [name, args, help] of [
    ["start", ["daemon", "start"], "Start the worker daemon"],
    ["stop", ["daemon", "stop"], "Stop the worker daemon (leases on it end when their TTL runs out)"],
    ["status", ["status"], "Show the worker's devices, leases and capabilities"],
    ["logs", ["daemon", "logs"], "Print the worker daemon log"],
  ] as const) {
    worker
      .command(name)
      .description(help)
      .action(async () => {
        const out = output(globals());
        try {
          if (name === "start") await ensureSimlockHelpersExecutable(out);
          const text = await simlock(["--local", ...args, ...(name === "status" && globals().json ? ["--json"] : [])]);
          out.result(safeJson(text) ?? { output: text }, () => text);
        } catch (error) {
          process.exitCode = out.error(error);
        }
      });
  }
  worker
    .command("restart")
    .description("Restart the worker daemon (ends agent-device sessions on it)")
    .action(async () => {
      const out = output(globals());
      try {
        await restart(false, out);
        out.result({ restarted: true }, () => "Restarted");
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  // ------------------------------------------------------------------ escape hatch
  program
    .command("simlock")
    .description("Run the Simlock CLI bundled with Tapdance (for operators; agents should not need it)")
    .allowUnknownOption()
    .argument("[args...]")
    .action(async (args: string[]) => {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync(process.execPath, [simlockBin(), ...args], { stdio: "inherit" });
      process.exitCode = r.status ?? 1;
    });

  // ------------------------------------------------------------------ gateway
  const gateway = program.command("gateway").description("Run a gateway on this machine (an ordinary VPS is fine: it needs no KVM)");

  gateway
    .command("setup")
    .description("Start a Simlock gateway, enable agent-device + streaming, mint tokens, and point this machine's Tapdance at it")
    .option("--worker-label <name>", "label for the first worker's join token", "worker-1")
    .option("--agent-label <name>", "label for this machine's agent token", "tapdance-agent")
    .option("--public-url <url>", "the https:// address workers and remote agents will use (after you add TLS)")
    .option("--no-configure-here", "do not write ~/.tapdance config/credentials for this machine")
    .action(async (o: { workerLabel: string; agentLabel: string; publicUrl?: string; configureHere: boolean }) => {
      const out = output(globals());
      try {
        out.progress("Starting the gateway daemon");
        await simlock(["--gateway", "daemon", "start"]);
        for (const cap of ["agent-device", "stream", "input"]) {
          await simlock(["--gateway", "config", "set", `capabilities.${cap}.enabled`, "true"]);
        }
        await restart(true, out);
        const mint = async (role: string, label: string) => {
          const text = await simlock(["--gateway", "token", "create", "--role", role, "--label", label]);
          const parsed = safeJson(text) as { secret?: string; token?: { id?: string } } | undefined;
          if (!parsed?.secret) throw new TapdanceError("PROVIDER_UNAVAILABLE", `Could not create a ${role} token`);
          return { secret: parsed.secret, id: parsed.token?.id ?? "?" };
        };
        const workerToken = await mint("worker", o.workerLabel);
        const agentToken = await mint("agent", o.agentLabel);
        const operatorToken = await mint("operator", `${o.agentLabel}-operator`);
        if (o.configureHere) {
          await saveCredentials({ token: agentToken.secret, operatorToken: operatorToken.secret });
          await writeConfigFile(userConfigPath(), { provider: "self-hosted", endpoint: "http://127.0.0.1:4700" });
        }
        const publicWs = o.publicUrl ? o.publicUrl.replace(/^http/, "ws") : "wss://<your-gateway-host>";
        // The worker join secret is printed once, to stdout, for the person setting up the worker.
        out.secretResult(
          { gateway: "http://127.0.0.1:4700", workerJoinToken: workerToken.secret, workerTokenId: workerToken.id, agentTokenId: agentToken.id, configuredHere: o.configureHere },
          () =>
            [
              bold("Gateway running on 127.0.0.1:4700 (not reachable from other machines yet)."),
              o.configureHere ? `This machine's Tapdance now uses it (agent + operator tokens saved to ~/.tapdance/credentials.json).` : "",
              "",
              bold("1. Make it reachable over TLS or a private network (pick one):"),
              "   • Caddy:     gateway.example.com { reverse_proxy 127.0.0.1:4700 { flush_interval -1 } }",
              "   • Tailscale: tailscale serve --bg --https=443 http://127.0.0.1:4700",
              "",
              bold("2. On the worker machine (laptop, Mac, KVM server):"),
              "   install Tapdance from source (docs/installation.md), then: tapdance worker install",
              `   echo '<join token>' | tapdance worker login --gateway ${publicWs} --label ${o.workerLabel} --accept-gateway-exec`,
              "   (a joined worker gives this gateway command execution on it; for a personal Mac prefer device-only mode: docs/security/personal-mac.md)",
              "",
              bold("Worker join token (shown once; give it only to that worker):"),
              `   ${workerToken.secret}`,
              "",
              "3. Check: tapdance workers list && tapdance devices",
            ]
              .filter((l) => l !== "")
              .join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  gateway
    .command("token")
    .description("Mint a token on this machine's gateway (printed once)")
    .requiredOption("--role <role>", "worker (to join a worker), agent (one per agent), or operator")
    .requiredOption("--label <name>", "who it is for")
    .action(async (o: { role: string; label: string }) => {
      const out = output(globals());
      try {
        if (!["worker", "agent", "operator"].includes(o.role)) throw new TapdanceError("USAGE", "--role must be worker, agent or operator");
        const text = await simlock(["--gateway", "token", "create", "--role", o.role, "--label", o.label]);
        const parsed = safeJson(text) as { secret?: string; token?: unknown } | undefined;
        // This one command exists to hand a secret to a person, so it prints it.
        process.stdout.write(`${globals().json ? JSON.stringify(parsed, null, 2) : `${parsed?.secret}\n${dim("Shown once. Revoke with: tapdance simlock -- --gateway token revoke <id>")}`}\n`);
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  gateway
    .command("status")
    .description("Show the gateway's workers, devices and queue")
    .action(async () => {
      const out = output(globals());
      try {
        const workers = await simlock(["--gateway", "worker", "list"]);
        out.result({ workers: workers.split("\n") }, () => workers);
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
}

function safeJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
}

export type { DoctorCheck };
