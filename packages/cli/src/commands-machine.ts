import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { TapdanceError } from "@tapdance/sdk";
import { CLI_ENTRY, output, type GlobalOptions } from "./context.js";
import { readSecret } from "./commands-setup.js";
import { currentTargets } from "./connect-targets.js";
import { readUserConfig } from "./commands-worker.js";
import { defaultLabel } from "./host/plan.js";
import { bold, dim, green, red, table, yellow, type Output } from "./output.js";
import { autoHousekeeping, autoPolicyFrom, closeQuietly, describePolicy, machineAutoHook, openLog, readAuto, writeAuto, type AutoOnOptions } from "./machine/auto.js";
import { assetPaths, confirmOrThrow, formatSeconds, localTailscaleBin, type MachineIo } from "./machine/common.js";
import { age, money } from "./machine/cost.js";
import { realExec, realSleep } from "./machine/exec.js";
import {
  GCP_DEFAULTS,
  Gcp,
  LABEL,
  gcpCostOf,
  gcpCreate,
  gcpDefaultZone,
  gcpDestroy,
  gcpPreflight,
  gcpPriceLine,
  gcpStart,
  gcpStop,
  lastSegment,
  type DestroyReport,
} from "./machine/gcp.js";
import { SCALEWAY_DEFAULTS, Scaleway, scalewayCostOf, scalewayCreate, scalewayDestroy, scalewayPreflight, scalewayPriceLine, scalewayStock } from "./machine/scaleway.js";
import { CLOUDS, MachineStore, assertMachineName, resourceName, type Cloud, type MachineRecord } from "./machine/state.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export interface CreateOptions {
  cloud?: string;
  name?: string;
  project?: string;
  zone?: string;
  type?: string;
  diskGb?: string;
  idleStop?: string;
  maxHours?: string;
  keep?: boolean;
  label?: string;
  tailscaleKey?: boolean;
  setupRef?: string;
  verbose?: boolean;
  yes?: boolean;
}

export function defaultMachineIo(out: Output, verbose = false): MachineIo {
  return {
    exec: realExec,
    sleep: realSleep,
    now: () => new Date(),
    out,
    store: new MachineStore(),
    env: process.env,
    self: [process.execPath, CLI_ENTRY],
    assets: assetPaths(),
    verbose,
    tailscaleBin: localTailscaleBin(),
    readSecret,
    spawnCreate: async (args, logFile) => {
      const fd = openLog(logFile);
      try {
        const child = spawn(process.execPath, [CLI_ENTRY, ...args], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
        child.unref();
        if (child.pid === undefined) throw new TapdanceError("INTERNAL", "Could not start the background machine create");
        return child.pid;
      } finally {
        closeQuietly(fd);
      }
    },
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    healthz: async (endpoint) => {
      try {
        return (await fetch(`${endpoint.replace(/\/$/, "")}/v1/healthz`, { signal: AbortSignal.timeout(5_000) })).ok;
      } catch {
        return false;
      }
    },
    targetNames: async () => currentTargets(await readUserConfig()).targets.map((t) => t.name),
  };
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} ${dim("[y/N]")} `)).trim());
  } finally {
    rl.close();
  }
}

/** How to get a shell on the machine yourself (host builds, gh-login, troubleshooting). */
export function shellCommand(r: MachineRecord, dir: string): string | undefined {
  if (r.cloud === "gcp") return `gcloud compute ssh ${r.resourceName} --zone ${r.zone} --project ${r.project} --tunnel-through-iap`;
  return r.ip ? `ssh -i ${dir}/id_ed25519 ${r.sshUser ?? "m1"}@${r.ip}` : undefined;
}

export function parseIdleStop(value: string | undefined): number | "off" {
  if (value === undefined) return GCP_DEFAULTS.idleStop;
  if (value === "off") return "off";
  const n = Number(value);
  if (!Number.isInteger(n) || n < 5 || n > 1440) throw new TapdanceError("USAGE", `--idle-stop must be minutes from 5 to 1440, or off (got "${value}")`);
  return n;
}

export function parseMaxHours(value: string | undefined): number | "off" {
  if (value === undefined) return GCP_DEFAULTS.maxHours;
  if (value === "off") return "off";
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 168) throw new TapdanceError("USAGE", `--max-hours must be whole hours from 1 to 168, or off (got "${value}")`);
  return n;
}

export function parseCloud(value: string | undefined): Cloud {
  if (value === undefined) throw new TapdanceError("USAGE", "Say which cloud: --cloud gcp (Android) or --cloud scaleway (iOS)");
  if (!(CLOUDS as readonly string[]).includes(value)) throw new TapdanceError("USAGE", `Unknown cloud "${value}"`, { hint: "Use --cloud gcp (Android on Google Cloud) or --cloud scaleway (iOS on a Scaleway Mac mini)." });
  return value as Cloud;
}

/** What create will do and cost, shown before anything is created. */
export function createSummary(record: MachineRecord): string[] {
  if (record.cloud === "gcp") {
    return [
      bold(`Create an Android machine "${record.name}" in Google Cloud project ${record.project}:`),
      `  ${record.machineType} VM ${record.resourceName} in ${record.zone}, Ubuntu 24.04, ${record.diskGb} GB disk, with its own network that only Google's SSH tunnel may enter`,
      `  cost: ${gcpPriceLine(record.machineType, record.diskGb ?? GCP_DEFAULTS.diskGb)}`,
      `  it stops itself after ${record.idleStopMinutes === "off" ? "(idle stop off)" : `${record.idleStopMinutes} minutes without use`}${record.maxHours === "off" ? "" : `, and at the latest ${record.maxHours} hours after each start`}; a stopped VM bills only its disk`,
      `  it joins your Tailscale network as ${record.tailscaleHostname} and is connected to this computer as target "${record.target}"`,
      "  time: about 10 minutes",
    ];
  }
  return [
    bold(`Rent an iOS machine "${record.name}" from Scaleway: a Mac mini ${record.machineType} in ${record.zone}${record.project ? ` (project ${record.project})` : ""}.`),
    yellow(`  Scaleway bills a Mac mini for at least 24 hours, and you cannot delete it sooner (Apple's macOS licence).`),
    yellow(`  It bills until it is deleted, also while switched off: ${scalewayPriceLine(record.machineType)}.`),
    record.scheduledDeletion
      ? "  It is scheduled for automatic deletion at the 24-hour mark, so a forgotten Mac costs one day (--keep turns that off)."
      : yellow("  --keep: it is NOT deleted automatically; it bills until `tapdance machine destroy`."),
    `  It joins your Tailscale network as ${record.tailscaleHostname} and is connected to this computer as target "${record.target}".`,
    "  time: Scaleway's macOS install (often 20-60 minutes), then about 20 minutes of setup",
  ];
}

export async function machineCreate(io: MachineIo, o: CreateOptions, extra: string[], isTty: boolean): Promise<MachineRecord> {
  const cloud = parseCloud(o.cloud);
  const name = assertMachineName(o.name ?? (cloud === "gcp" ? "android" : "ios"));
  let record = await io.store.get(name);
  if (record && record.cloud !== cloud) {
    throw new TapdanceError("USAGE", `Machine ${name} already exists on ${record.cloud}`, { hint: `Pick another --name, or remove it first with \`tapdance machine destroy ${name}\`.` });
  }
  if (record?.pendingDeletionAt) {
    throw new TapdanceError("USAGE", `Machine ${name} is waiting to be deleted (${record.pendingDeletionAt})`, { hint: "Pick another --name for a new machine." });
  }
  const resuming = record !== undefined;
  if (!record) {
    if ((await io.targetNames()).includes(name)) {
      throw new TapdanceError("USAGE", `This computer already has a connect target called ${name}`, { hint: `Pick another --name, or remove that target with \`tapdance disconnect ${name}\` first.` });
    }
  }
  const isGcp = cloud === "gcp";
  let project = o.project ?? record?.project;
  if (isGcp) project = await gcpPreflight(io, project);
  else await scalewayPreflight(io);
  if (!record) {
    const zone = isGcp ? await gcpDefaultZone(io, o.zone) : (o.zone ?? SCALEWAY_DEFAULTS.zone);
    const diskGb = o.diskGb === undefined ? GCP_DEFAULTS.diskGb : Number(o.diskGb);
    if (!Number.isInteger(diskGb) || diskGb < 32 || diskGb > 500) throw new TapdanceError("USAGE", "--disk-gb must be 32 to 500");
    const setupRef = o.setupRef ?? "";
    if (setupRef && !/^[A-Za-z0-9._/-]{1,100}$/.test(setupRef)) throw new TapdanceError("USAGE", `--setup-ref "${setupRef}" is not a git ref`);
    record = {
      version: 1,
      name,
      cloud,
      createdAt: io.now().toISOString(),
      ...(project ? { project } : {}),
      zone,
      machineType: o.type ?? (isGcp ? GCP_DEFAULTS.machineType : SCALEWAY_DEFAULTS.machineType),
      resourceName: resourceName(name),
      label: defaultLabel(o.label ?? hostname()),
      target: name,
      tailscaleHostname: resourceName(name),
      setupRef,
      ...(setupRef ? {} : { tapdanceVersion: pkg.version }),
      ...(isGcp ? { idleStopMinutes: parseIdleStop(o.idleStop), maxHours: parseMaxHours(o.maxHours), diskGb } : { scheduledDeletion: !o.keep }),
      done: [],
      timings: {},
    };
    if (!isGcp) {
      const stock = await scalewayStock(io, record.machineType, record.zone);
      if (stock && /no_stock|out/i.test(stock)) throw new TapdanceError("NO_CAPACITY", `Scaleway has no ${record.machineType} in stock in ${record.zone} right now`, { hint: "Try another offer with --type (e.g. M2-M), or later." });
    }
    for (const line of createSummary(record)) io.out.progress(line);
    await confirmOrThrow(isGcp ? "Create it?" : "Rent it? You pay Scaleway for at least 24 hours.", o.yes, ask, isTty);
    await io.store.save(record);
  } else {
    io.out.progress(`Machine ${name} exists on this computer: continuing its setup (${record.done.length} step(s) done). Other options given now are ignored.`);
  }
  let tailscaleKey: string | undefined;
  if (o.tailscaleKey) {
    tailscaleKey = await io.readSecret("Tailscale auth key (input hidden):");
    if (!/^tskey-[A-Za-z0-9_-]+$/.test(tailscaleKey)) throw new TapdanceError("USAGE", "That is not a Tailscale auth key (tskey-...)", { hint: "Make one in the Tailscale admin console under Settings > Keys: pre-approved, not ephemeral for --cloud gcp (it must survive a stop)." });
  }
  const started = io.now().getTime();
  if (isGcp) await gcpCreate(io, new Gcp(io, record.project!), { record, ...(tailscaleKey !== undefined ? { tailscaleKey } : {}), extraSetupArgs: extra });
  else await scalewayCreate(io, new Scaleway(io, record.project), { record, ...(tailscaleKey !== undefined ? { tailscaleKey } : {}), extraSetupArgs: extra });
  if (!resuming) record.timings["total"] = Math.round((io.now().getTime() - started) / 1000);
  await io.store.save(record);
  return record;
}

export interface ListedMachine {
  name: string;
  cloud: Cloud;
  type: string;
  state: string;
  zone: string;
  project?: string;
  createdAt: string;
  age: string;
  hourly?: string;
  costSoFar?: string;
  costBasis?: string;
  endpoint?: string;
  shell?: string;
  tracked: boolean;
  note?: string;
}

export async function machineList(io: MachineIo, opts: { project?: string } = {}): Promise<{ machines: ListedMachine[]; warnings: string[] }> {
  const now = io.now();
  const records = await io.store.list();
  const machines: ListedMachine[] = [];
  const warnings: string[] = [];
  const projects = new Set(records.filter((r) => r.cloud === "gcp" && r.project).map((r) => r.project!));
  if (opts.project) projects.add(opts.project);
  const seen = new Set<string>();
  for (const project of projects) {
    const gcp = new Gcp(io, project);
    let vms: Awaited<ReturnType<Gcp["listMachines"]>>;
    try {
      vms = await gcp.listMachines();
    } catch (error) {
      warnings.push(`Google Cloud project ${project}: ${(error as Error).message.split("\n")[0]}`);
      for (const r of records.filter((x) => x.cloud === "gcp" && x.project === project)) seen.add(r.name);
      for (const r of records.filter((x) => x.cloud === "gcp" && x.project === project)) machines.push(listed(r, "unknown", now));
      continue;
    }
    for (const vm of vms) {
      const name = vm.labels?.[LABEL] ?? vm.name;
      const r = records.find((x) => x.cloud === "gcp" && x.name === name && x.project === project);
      const base: MachineRecord = r ?? {
        version: 1, name, cloud: "gcp", createdAt: vm.creationTimestamp, project, zone: lastSegment(vm.zone), machineType: lastSegment(vm.machineType),
        resourceName: vm.name, label: "", target: name, tailscaleHostname: vm.name, setupRef: "", diskGb: Number(vm.disks?.[0]?.diskSizeGb ?? GCP_DEFAULTS.diskGb), done: [], timings: {},
      };
      seen.add(name);
      machines.push({ ...listed({ ...base, createdAt: vm.creationTimestamp }, vm.status, now), shell: shellCommand(base, io.store.dir(name))!, tracked: r !== undefined, ...(r ? {} : { note: "made by Tapdance on another computer (no local record)" }) });
    }
  }
  for (const r of records.filter((x) => x.cloud === "gcp" && !seen.has(x.name))) {
    machines.push({ ...listed(r, r.done.includes("vm") ? "gone" : "not created", now), note: r.done.includes("vm") ? "no longer in Google Cloud; `tapdance machine destroy` removes the rest" : "create did not finish; run create again or destroy" });
  }
  const macs = records.filter((r) => r.cloud === "scaleway");
  if (macs.length) {
    const scw = new Scaleway(io, undefined);
    let servers: Awaited<ReturnType<Scaleway["listServers"]>> | undefined;
    try {
      servers = await scw.listServers();
    } catch (error) {
      warnings.push(`Scaleway: ${(error as Error).message.split("\n")[0]}`);
    }
    for (const r of macs) {
      const s = servers?.find((x) => x.id === r.serverId);
      const state = servers === undefined ? "unknown" : s ? s.status : r.serverId ? "gone" : "not created";
      const shell = shellCommand(r, io.store.dir(r.name));
      machines.push({ ...listed({ ...r, ...(s?.created_at ? { createdAt: s.created_at } : {}) }, state, now), ...(shell ? { shell } : {}), ...(r.pendingDeletionAt ? { note: `scheduled for deletion at ${r.pendingDeletionAt}` } : s?.deletion_scheduled ? { note: `deleted automatically after ${s.deletable_at ?? "24 hours"}` } : {}) });
    }
  }
  return { machines, warnings };
}

function listed(r: MachineRecord, state: string, now: Date): ListedMachine {
  const gone = state === "gone" || state === "not created";
  const cost = gone ? undefined : r.cloud === "gcp" ? gcpCostOf(r, state, now) : scalewayCostOf(r, now);
  return {
    name: r.name,
    cloud: r.cloud,
    type: r.machineType,
    state,
    zone: r.zone,
    ...(r.project ? { project: r.project } : {}),
    createdAt: r.createdAt,
    age: age(new Date(r.createdAt), now),
    ...(cost ? { hourly: `${money(cost.hourly, cost.currency)}/h`, costSoFar: money(cost.soFar, cost.currency), costBasis: cost.basis } : {}),
    ...(r.endpoint ? { endpoint: r.endpoint } : {}),
    tracked: true,
  };
}

async function requireRecord(io: MachineIo, name: string): Promise<MachineRecord> {
  const r = await io.store.get(assertMachineName(name));
  if (!r) throw new TapdanceError("USAGE", `No machine called ${name} on this computer`, { hint: "`tapdance machine list` shows the machines this computer made." });
  return r;
}

export async function machineStop(io: MachineIo, name: string, start: boolean): Promise<string> {
  const r = await requireRecord(io, name);
  if (r.cloud === "scaleway") {
    throw new TapdanceError("NOT_SUPPORTED", `A Scaleway Mac mini cannot be ${start ? "started" : "stopped"} to save money`, {
      hint: `Scaleway bills it by the hour until it is deleted, also while it is switched off, and deletes it no sooner than 24 hours after it was rented. It stays ready for your agent until then. When you are done: \`tapdance machine destroy ${r.name}\`${r.deletableAt ? ` (possible from ${r.deletableAt}; before that it is scheduled instead)` : ""}.`,
    });
  }
  const gcp = new Gcp(io, r.project!);
  if (start) {
    await gcpStart(gcp, r);
    return `Started ${r.name}. Tailscale and the Tapdance host come back by themselves in about a minute; then lease as usual. It stops itself again after ${r.idleStopMinutes === "off" ? "(idle stop off)" : `${r.idleStopMinutes} idle minutes`}.`;
  }
  await gcpStop(gcp, r);
  return `Stopped ${r.name}. It now bills only its disk (about USD ${(((r.diskGb ?? GCP_DEFAULTS.diskGb) * 0.1)).toFixed(2)} a month) until you destroy it. Start it again with \`tapdance machine start ${r.name}\`.`;
}

export async function machineDestroy(io: MachineIo, name: string, o: { yes?: boolean }, isTty: boolean): Promise<DestroyReport & { record: MachineRecord; clean: boolean }> {
  const r = await requireRecord(io, name);
  io.out.progress(
    r.cloud === "gcp"
      ? `Destroy machine ${r.name}: the VM ${r.resourceName} and its disk, network and firewall rule in project ${r.project}, its Tailscale node and connect target ${r.target}.`
      : `Destroy machine ${r.name}: the Scaleway Mac mini ${r.resourceName}${r.serverId ? ` (${r.serverId})` : ""}, its ssh key in your Scaleway project, its Tailscale node and connect target ${r.target}.`,
  );
  await confirmOrThrow("Destroy it? This cannot be undone.", o.yes, ask, isTty);
  const report = r.cloud === "gcp" ? await gcpDestroy(io, new Gcp(io, r.project!), r) : await scalewayDestroy(io, new Scaleway(io, r.project), r);
  const pending = r.pendingDeletionAt !== undefined;
  const clean = report.leftovers.ours.length === 0 && report.leftovers.unknown.length === 0;
  if (clean && !pending) await io.store.remove(r.name);
  else await io.store.save(r);
  return { ...report, record: r, clean: clean || (pending && report.leftovers.unknown.length === 0) };
}

export function renderDestroy(d: DestroyReport & { record: MachineRecord; clean: boolean }): string {
  const lines = [...d.removed.map((x) => `${green("✓")} ${x}`), ...d.notes.map((x) => `${yellow("!")} ${x}`), ""];
  const l = d.leftovers;
  if (d.record.pendingDeletionAt && l.unknown.length === 0) {
    lines.push(bold(`Left: the Mac mini, scheduled for deletion at ${d.record.pendingDeletionAt}; it bills until then. Nothing else of this machine is left.`));
  } else if (l.ours.length === 0 && l.unknown.length === 0) {
    lines.push(bold(green("Nothing billable left from this machine.")));
  } else {
    if (l.ours.length) lines.push(red(bold("Still there from this machine:")), ...l.ours.map((x) => `  ${x}`));
    if (l.unknown.length) lines.push(yellow("Could not check:"), ...l.unknown.map((x) => `  ${x}`));
    lines.push(`Run \`tapdance machine destroy ${d.record.name}\` again, or delete them in the cloud console.`);
  }
  if (l.others.length) {
    lines.push("", dim(`Other billable resources in this ${d.record.cloud === "gcp" ? "project" : "account"}, not made by Tapdance (left alone):`), ...l.others.map((x) => dim(`  ${x}`)));
  }
  return lines.join("\n");
}

/** The SDK hook for auto mode, or undefined when it is off for every platform. */
export async function machineAutoOption(out: Output): Promise<import("@tapdance/sdk").MachineAutoHook | undefined> {
  const io = defaultMachineIo(out);
  const config = await readAuto(io);
  return config.android || config.ios ? machineAutoHook(io, config) : undefined;
}

/** Runs the auto mode housekeeping (delete-after-days), warning instead of failing. */
export async function runHousekeeping(io: MachineIo): Promise<string[]> {
  try {
    return await autoHousekeeping(io);
  } catch (error) {
    io.out.warn(`Auto mode housekeeping: ${(error as Error).message.split("\n")[0]}`);
    return [];
  }
}

export function registerMachineCommands(program: Command, globals: () => GlobalOptions): void {
  const machine = program
    .command("machine")
    .description("On the agent's machine: create, list, stop, start and destroy phone machines in your own Google Cloud (Android) or Scaleway (iOS) account, with your own logged-in gcloud or scw");

  machine
    .command("create")
    .description("Create a machine in your cloud account, set it up as a Tapdance host, join it to your tailnet and connect this computer to it. Run it again after a failure: it continues where it stopped")
    .option("--cloud <cloud>", "gcp (Android, a Google Cloud N2 VM) or scaleway (iOS, a Scaleway Mac mini)")
    .option("--name <name>", "the machine's name, also its connect target (default: android for gcp, ios for scaleway)")
    .option("--project <id>", "Google Cloud project id (default: gcloud's) or Scaleway project id (default: scw's)")
    .option("--zone <zone>", "gcp: default gcloud's compute/zone, else us-central1-a; scaleway: fr-par-3")
    .option("--type <type>", "gcp: machine type (default n2-standard-4); scaleway: Mac mini offer (default M1-M)")
    .option("--disk-gb <gb>", "gcp: boot disk size (default 64)")
    .option("--idle-stop <minutes|off>", "gcp: stop the VM after this many minutes without a lease, request or build (default 30)")
    .option("--max-hours <hours|off>", "gcp: stop the VM at the latest this many hours after each start (default 8)")
    .option("--keep", "scaleway: do not schedule the Mac for automatic deletion at the 24-hour mark")
    .option("--label <name>", "the pairing's name on the machine (default: this computer's name)")
    .option("--tailscale-key", "join the tailnet with a pre-approved auth key, read with echo off (or from stdin), instead of a login link you open")
    .option("--setup-ref <ref>", "build Tapdance on the machine from this git ref instead of installing tapdance-cli from npm at this CLI's version")
    .option("--verbose", "show every line of the machine's setup, not only its progress")
    .option("-y, --yes", "do not ask for confirmation (for scripts; read the cost first)")
    .argument("[host-setup-args...]", "after --: extra options for host-setup.sh on the machine, e.g. -- --with-gh --android-build-sdk")
    .action(async (extra: string[], o: CreateOptions) => {
      const out = output(globals());
      try {
        const io = defaultMachineIo(out, o.verbose);
        const record = await machineCreate(io, o, extra ?? [], process.stdin.isTTY === true);
        const platform = record.cloud === "gcp" ? "android" : "ios";
        const shell = shellCommand(record, io.store.dir(record.name));
        out.result({ machine: record.name, cloud: record.cloud, endpoint: record.endpoint, target: record.target, shell, timings: record.timings }, () =>
          [
            bold(green(`Machine ${record.name} is ready and connected.`)) + (record.timings["total"] !== undefined ? ` ${dim(`(${formatSeconds(record.timings["total"])} in all)`)}` : ""),
            `  endpoint: ${record.endpoint ?? "?"}`,
            "",
            "Try it, or ask your agent to:",
            `  tapdance device lease --platform ${platform}`,
            "  tapdance screenshot",
            "  tapdance device release",
            "",
            dim(`A shell on the machine, for setting up host builds: ${shell ?? "?"}`),
            dim(record.cloud === "gcp" ? `It stops itself when idle; \`tapdance machine start ${record.name}\` wakes it. Done for good: \`tapdance machine destroy ${record.name}\`.` : `When you are done: \`tapdance machine destroy ${record.name}\`.`),
          ].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  machine
    .command("list")
    .description("List the machines this computer created, with cloud, type, state, age and an estimated cost so far")
    .option("--project <id>", "also look for Tapdance's VMs in this Google Cloud project")
    .action(async (o: { project?: string }) => {
      const out = output(globals());
      try {
        const io = defaultMachineIo(out);
        for (const m of await runHousekeeping(io)) out.progress(m);
        const { machines, warnings } = await machineList(io, o);
        for (const w of warnings) out.warn(w);
        out.result({ machines }, () =>
          machines.length === 0
            ? "No machines. Create one with `tapdance machine create --cloud gcp` (Android) or `--cloud scaleway` (iOS)."
            : [
                table([["NAME", "CLOUD", "TYPE", "STATE", "AGE", "NOW", "COST SO FAR (est.)"], ...machines.map((m) => [m.name, m.cloud, m.type, m.state, m.age, m.hourly ?? "-", m.costSoFar ?? "-"])]),
                ...machines.filter((m) => m.note).map((m) => dim(`${m.name}: ${m.note}`)),
                dim("Estimates from list prices, excluding VAT: Google Cloud counts the whole age as running (an upper bound) plus the disk; Scaleway bills at least 24 hours. Your cloud's billing page is the final word."),
              ].join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  for (const verb of ["stop", "start"] as const) {
    machine
      .command(`${verb} <name>`)
      .description(verb === "stop" ? "gcp: stop the VM (it then bills only its disk). Scaleway Macs cannot be stopped to save money" : "gcp: start a stopped VM; Tailscale and the host come back by themselves")
      .action(async (name: string) => {
        const out = output(globals());
        try {
          const message = await machineStop(defaultMachineIo(out), name, verb === "start");
          out.result({ machine: name, action: verb }, () => message);
        } catch (error) {
          process.exitCode = out.error(error);
        }
      });
  }

  const auto = machine
    .command("auto")
    .description("Auto mode: when the agent asks for a phone and no machine for that platform is up, this computer starts the stopped machine or creates one in your cloud; it stops itself when idle. `machine auto` shows the setting")
    .action(async () => {
      const out = output(globals());
      try {
        const io = defaultMachineIo(out);
        for (const m of await runHousekeeping(io)) out.progress(m);
        const config = await readAuto(io);
        const rows = await Promise.all((["android", "ios"] as const).filter((p) => config[p]).map(async (p) => ({ platform: p, policy: config[p]!, machine: await io.store.get(config[p]!.name) })));
        out.result({ auto: config, machines: rows.map((r) => ({ platform: r.platform, name: r.policy.name, exists: r.machine !== undefined, done: r.machine?.done ?? [] })) }, () =>
          rows.length === 0
            ? "Auto mode is off. Turn it on with `tapdance machine auto on --platform android` (Google Cloud) or `--platform ios --accept-mac-day` (Scaleway)."
            : rows.map((r) => `${describePolicy(r.platform, r.policy)}\n  now: ${r.machine ? (r.machine.done.includes("connect") ? "created" : `being created (${r.machine.done.length} of 6 steps)`) : "no machine yet"}`).join("\n"),
        );
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  auto
    .command("on")
    .description("Turn auto mode on for a platform: android (a Google Cloud N2 VM) or ios (a Scaleway Mac mini, only with --accept-mac-day)")
    .option("--platform <platform>", "android or ios")
    .option("--cloud <cloud>", "gcp for android, scaleway for ios (the default for each)")
    .option("--name <name>", "the machine's name (default: the platform)")
    .option("--project <id>", "Google Cloud or Scaleway project id (default: the CLI's)")
    .option("--zone <zone>", "as for machine create")
    .option("--type <type>", "as for machine create")
    .option("--idle-stop <minutes|off>", "android: stop the VM after this many idle minutes (default 30)")
    .option("--max-hours <hours|off>", "android: stop the VM at the latest this many hours after each start (default 8)")
    .option("--delete-after-days <days>", "android: destroy the machine once it has been stopped this many days (default: never)")
    .option("--accept-mac-day", "ios: agree that each new Mac auto mode rents bills at least 24 hours")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (o: AutoOnOptions & { yes?: boolean }) => {
      const out = output(globals());
      try {
        const io = defaultMachineIo(out);
        const { platform, policy } = autoPolicyFrom(o, { idleStop: parseIdleStop, maxHours: parseMaxHours }, io.now());
        if (policy.cloud === "gcp") policy.project = await gcpPreflight(io, policy.project);
        else await scalewayPreflight(io);
        out.progress(describePolicy(platform, policy));
        out.progress(policy.cloud === "gcp" ? `cost: ${gcpPriceLine(policy.type ?? GCP_DEFAULTS.machineType, GCP_DEFAULTS.diskGb)}` : `cost: ${scalewayPriceLine(policy.type ?? SCALEWAY_DEFAULTS.machineType)} per Mac`);
        await confirmOrThrow("Turn auto mode on? Tapdance will create or start machines in your account when your agent needs one.", o.yes, ask, process.stdin.isTTY === true);
        const config = await readAuto(io);
        config[platform] = policy;
        await writeAuto(io, config);
        out.result({ platform, policy }, () => `Auto mode is on for ${platform}. The next ${platform} lease brings machine ${policy.name} up if it is not.`);
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  auto
    .command("off")
    .description("Turn auto mode off (for one platform with --platform); existing machines stay, remove them with `tapdance machine destroy`")
    .option("--platform <platform>", "android or ios (default: both)")
    .action(async (o: { platform?: string }) => {
      const out = output(globals());
      try {
        const io = defaultMachineIo(out);
        const config = await readAuto(io);
        const platforms: Array<"android" | "ios"> | undefined = o.platform === undefined ? ["android", "ios"] : o.platform === "android" || o.platform === "ios" ? [o.platform] : undefined;
        if (!platforms) throw new TapdanceError("USAGE", "--platform is android or ios");
        for (const p of platforms) delete config[p];
        await writeAuto(io, config);
        out.result({ auto: config }, () => `Auto mode is off for ${platforms.join(" and ")}. Machines it made are still there: \`tapdance machine list\`.`);
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });

  machine
    .command("destroy <name>")
    .description("Remove the machine and everything created for it (disk, network, firewall rule, ssh key, Tailscale node, connect target), then check that nothing billable is left")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (name: string, o: { yes?: boolean }) => {
      const out = output(globals());
      try {
        const d = await machineDestroy(defaultMachineIo(out), name, o, process.stdin.isTTY === true);
        out.result({ machine: name, removed: d.removed, notes: d.notes, leftovers: d.leftovers, pendingDeletionAt: d.record.pendingDeletionAt, nothingBillableLeft: d.clean && !d.record.pendingDeletionAt }, () => renderDestroy(d));
        if (!d.clean) process.exitCode = 1;
      } catch (error) {
        process.exitCode = out.error(error);
      }
    });
}
