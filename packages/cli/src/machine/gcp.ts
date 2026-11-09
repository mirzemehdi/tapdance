import { TapdanceError } from "@tapdance/sdk";
import {
  ENV_PREFIX,
  TAILSCALE_LOGOUT,
  installArgs,
  checkLocalTailscale,
  connectMachine,
  disconnectMachine,
  remoteEndpoint,
  runSteps,
  setupLineHandler,
  setupLog,
  type MachineIo,
  type Step,
} from "./common.js";
import { check, errorTail, parseJson, shJoin, type ExecResult } from "./exec.js";
import { gcpCost, gcpDiskHourly, gcpRunningHourly, type CostEstimate } from "./cost.js";
import { resourceName, type MachineRecord } from "./state.js";

/**
 * Android machines on Google Cloud, made with the user's own logged-in gcloud. Every resource is named
 * tapdance-<name>; the VM carries the labels tapdance-machine=<name> and created-by=tapdance, and the
 * network and firewall rule say tapdance-machine=<name> in their description (they take no labels).
 * List and destroy act only on resources that match, never on anything else in the project.
 */

export const GCP_DEFAULTS = { zone: "us-central1-a", machineType: "n2-standard-4", diskGb: 64, idleStop: 30, maxHours: 8 } as const;
export const IAP_RANGE = "35.235.240.0/20";
export const LABEL = "tapdance-machine";
const SUBNET_RANGE = "10.88.0.0/24";
const APIS = ["compute.googleapis.com", "iap.googleapis.com", "oslogin.googleapis.com"];
export const GCLOUD_LOGIN_HINT = "Install gcloud (https://cloud.google.com/sdk/docs/install), then run `gcloud auth login` and `gcloud config set project <PROJECT_ID>`. Tapdance uses your gcloud login and never reads or stores its credentials.";

export function regionOf(zone: string): string {
  return zone.replace(/-[a-z]$/, "");
}

export function marker(name: string): string {
  return `${LABEL}=${name}`;
}

/** Instance states in which the VM is stopped (it bills only its disk) and can be started. */
export const GCP_STOPPED: ReadonlySet<string> = new Set(["TERMINATED", "STOPPED", "SUSPENDED"]);

/** The network, subnet and firewall rule of a machine: gcloud command group and resource name. */
export function networkParts(record: Pick<MachineRecord, "resourceName" | "zone">): Array<{ what: string; kind: string[]; name: string; extra: string[] }> {
  const n = record.resourceName;
  return [
    { what: "firewall rule", kind: ["compute", "firewall-rules"], name: `${n}-iap-ssh`, extra: [] },
    { what: "subnet", kind: ["compute", "networks", "subnets"], name: n, extra: ["--region", regionOf(record.zone)] },
    { what: "network", kind: ["compute", "networks"], name: n, extra: [] },
  ];
}

function notOurs(what: string, name: string, project: string, machine: string): TapdanceError {
  return new TapdanceError("FORBIDDEN", `The ${what} ${name} in ${project} is not marked ${marker(machine)}; Tapdance did not make it for this machine and leaves it alone`, {
    hint: "Pick another --name for a new machine, or rename or delete that resource yourself if you no longer need it.",
  });
}

export class Gcp {
  constructor(
    private readonly io: MachineIo,
    readonly project: string,
  ) {}

  gcloud(args: string[], options: { input?: string; timeoutMs?: number; onLine?: (l: string) => void } = {}): Promise<ExecResult> {
    return this.io.exec("gcloud", [...args, "--project", this.project, "--quiet"], { timeoutMs: 600_000, ...options });
  }

  sshArgs(record: MachineRecord, command: string): string[] {
    // --billing-project: a gcloud with another quota project set fails OS Login otherwise (stage 2, #15).
    return ["compute", "ssh", record.resourceName, "--zone", record.zone, "--tunnel-through-iap", `--billing-project=${this.project}`, "--command", command];
  }

  ssh(record: MachineRecord, command: string, options: { input?: string; timeoutMs?: number; onLine?: (l: string) => void } = {}): Promise<ExecResult> {
    return this.gcloud(this.sshArgs(record, command), { timeoutMs: 120_000, ...options });
  }

  /**
   * Whether a network, subnet or firewall rule exists and was made for this machine: "missing", "ours"
   * (its description is exactly tapdance-machine=<name>) or "theirs".
   */
  async owner(kind: string[], name: string, extra: string[], machine: string): Promise<"missing" | "ours" | "theirs"> {
    const r = await this.gcloud([...kind, "describe", name, ...extra, "--format=value(description)"], { timeoutMs: 60_000 });
    if (r.code !== 0) {
      if (/not found|was not found|notFound/i.test(r.stderr)) return "missing";
      check(r, `gcloud ${kind.join(" ")} describe ${name}`);
    }
    return r.stdout.trim() === marker(machine) ? "ours" : "theirs";
  }

  /** Starts the VM when it is stopped (an idle stop or --max-hours may stop it between create runs). */
  async ensureRunning(record: MachineRecord, progress: (m: string) => void): Promise<void> {
    const vm = await this.instance(record);
    if (!vm || !GCP_STOPPED.has(vm.status)) return;
    if (vm.labels?.[LABEL] !== record.name) throw notOurs("VM", record.resourceName, this.project, record.name);
    progress(`  the VM is ${vm.status.toLowerCase()}: starting it`);
    check(await this.gcloud(["compute", "instances", "start", record.resourceName, "--zone", record.zone], { timeoutMs: 600_000 }), "gcloud compute instances start");
  }

  async instance(record: Pick<MachineRecord, "resourceName" | "zone">): Promise<GcpInstance | undefined> {
    const r = await this.gcloud(["compute", "instances", "describe", record.resourceName, "--zone", record.zone, "--format=json"], { timeoutMs: 60_000 });
    if (r.code !== 0) {
      if (/not found|was not found/i.test(r.stderr)) return undefined;
      check(r, `gcloud compute instances describe ${record.resourceName}`);
    }
    return parseJson<GcpInstance>(r.stdout, "gcloud compute instances describe");
  }

  /** Tapdance's VMs in the project: only those labelled tapdance-machine. */
  async listMachines(): Promise<GcpInstance[]> {
    const r = check(await this.gcloud(["compute", "instances", "list", `--filter=labels.${LABEL}:*`, "--format=json"], { timeoutMs: 120_000 }), "gcloud compute instances list", GCLOUD_LOGIN_HINT);
    return parseJson<GcpInstance[]>(r.stdout || "[]", "gcloud compute instances list");
  }
}

export interface GcpInstance {
  name: string;
  zone: string;
  status: string;
  machineType: string;
  creationTimestamp: string;
  lastStartTimestamp?: string;
  lastStopTimestamp?: string;
  labels?: Record<string, string>;
  disks?: Array<{ diskSizeGb?: string }>;
}

export const lastSegment = (url: string) => url.split("/").pop() ?? url;

/** gcloud is installed and logged in; returns the project to use. */
export async function gcpPreflight(io: MachineIo, projectFlag: string | undefined): Promise<string> {
  const auth = await io.exec("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], { timeoutMs: 30_000 });
  if (auth.code === 127) throw new TapdanceError("HOST_CHECK_FAILED", "gcloud is not installed on this computer", { hint: GCLOUD_LOGIN_HINT });
  if (auth.code !== 0 || !auth.stdout.trim()) throw new TapdanceError("AUTH_FAILED", "gcloud is not logged in", { hint: GCLOUD_LOGIN_HINT });
  let project = projectFlag;
  if (!project) {
    const r = await io.exec("gcloud", ["config", "get-value", "project"], { timeoutMs: 30_000 });
    project = r.stdout.trim();
    if (!project || project === "(unset)") throw new TapdanceError("USAGE", "No Google Cloud project chosen", { hint: "Pass --project <PROJECT_ID>, or set a default with `gcloud config set project <PROJECT_ID>`." });
  }
  if (!/^[a-z][-a-z0-9]{4,28}[a-z0-9]$/.test(project)) throw new TapdanceError("USAGE", `"${project}" is not a Google Cloud project id`);
  const billing = await io.exec("gcloud", ["billing", "projects", "describe", project, "--format=value(billingEnabled)"], { timeoutMs: 30_000 });
  if (billing.code === 0 && billing.stdout.trim().toLowerCase() === "false") {
    throw new TapdanceError("HOST_CHECK_FAILED", `Billing is not turned on for Google Cloud project ${project}`, {
      hint: `Link a billing account: in the console (Billing > Link a billing account), or \`gcloud billing accounts list\` and then \`gcloud billing projects link ${project} --billing-account=<ACCOUNT_ID>\`.`,
    });
  }
  return project;
}

export async function gcpDefaultZone(io: MachineIo, zoneFlag: string | undefined): Promise<string> {
  if (zoneFlag) return zoneFlag;
  const r = await io.exec("gcloud", ["config", "get-value", "compute/zone"], { timeoutMs: 30_000 });
  const z = r.stdout.trim();
  return z && z !== "(unset)" ? z : GCP_DEFAULTS.zone;
}

export interface GcpCreateInput {
  record: MachineRecord;
  tailscaleKey?: string;
  extraSetupArgs: string[];
}

/** The command line create runs on the VM: the copied host-setup.sh, ending in `host up`. */
export function gcpSetupCommand(record: MachineRecord, opts: { withKey: boolean; extra: string[] }): string {
  const args = ["bash", "tapdance-host-setup.sh", "--yes", "--label", record.label, "--tailscale-hostname", record.tailscaleHostname];
  if (opts.withKey) args.push("--tailscale-auth-key-stdin");
  args.push("--idle-stop", String(record.idleStopMinutes ?? GCP_DEFAULTS.idleStop));
  const install = installArgs(record);
  args.push(...install.args, ...opts.extra);
  return `${ENV_PREFIX}${install.env ? `TAPDANCE_REF=${shJoin([record.setupRef])} ` : ""}${shJoin(args)}`;
}

export function gcpInstanceCreateArgs(record: MachineRecord): string[] {
  const n = record.resourceName;
  const args = [
    "compute", "instances", "create", n,
    "--zone", record.zone,
    "--machine-type", record.machineType,
    "--enable-nested-virtualization",
    "--image-family=ubuntu-2404-lts-amd64", "--image-project=ubuntu-os-cloud",
    `--boot-disk-size=${record.diskGb ?? GCP_DEFAULTS.diskGb}GB`, "--boot-disk-type=pd-balanced",
    `--subnet=${n}`,
    "--no-service-account", "--no-scopes",
    `--tags=${n}`,
    `--labels=${LABEL}=${record.name},created-by=tapdance`,
    "--shielded-secure-boot", "--shielded-vtpm", "--shielded-integrity-monitoring",
    "--metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE",
  ];
  if (record.maxHours !== undefined && record.maxHours !== "off") args.push(`--max-run-duration=${record.maxHours}h`, "--instance-termination-action=STOP");
  return args;
}

export async function gcpCreate(io: MachineIo, gcp: Gcp, input: GcpCreateInput): Promise<void> {
  const { record } = input;
  const n = record.resourceName;
  const region = regionOf(record.zone);
  const steps: Step[] = [
    {
      id: "apis",
      title: "Turn on the Compute Engine, IAP and OS Login APIs",
      run: async () => {
        const r = check(await gcp.gcloud(["services", "list", "--enabled", "--format=value(config.name)"], { timeoutMs: 120_000 }), "gcloud services list", GCLOUD_LOGIN_HINT);
        const on = new Set(r.stdout.split("\n").map((s) => s.trim()));
        const missing = APIS.filter((a) => !on.has(a));
        if (missing.length) check(await gcp.gcloud(["services", "enable", ...missing], { timeoutMs: 600_000 }), `gcloud services enable ${missing.join(" ")}`, "Billing must be on for the project (console: Billing).");
      },
    },
    {
      id: "network",
      title: `Create a private network (${n}) that allows only Google's SSH tunnel in`,
      run: async () => {
        // Each part is reused only when it carries this machine's marker; anything else of that name is refused.
        const own = async (what: string, kind: string[], name: string, extra: string[] = []) => {
          const o = await gcp.owner(kind, name, extra, record.name);
          if (o === "theirs") throw notOurs(what, name, gcp.project, record.name);
          return o === "ours";
        };
        if (!(await own("network", ["compute", "networks"], n))) {
          check(await gcp.gcloud(["compute", "networks", "create", n, "--subnet-mode=custom", `--description=${marker(record.name)}`]), "gcloud compute networks create");
        }
        if (!(await own("subnet", ["compute", "networks", "subnets"], n, ["--region", region]))) {
          check(await gcp.gcloud(["compute", "networks", "subnets", "create", n, `--network=${n}`, `--region=${region}`, `--range=${SUBNET_RANGE}`, `--description=${marker(record.name)}`]), "gcloud compute networks subnets create");
        }
        if (!(await own("firewall rule", ["compute", "firewall-rules"], `${n}-iap-ssh`))) {
          check(
            await gcp.gcloud([
              "compute", "firewall-rules", "create", `${n}-iap-ssh`,
              `--network=${n}`, "--direction=INGRESS", "--action=allow", "--rules=tcp:22",
              `--source-ranges=${IAP_RANGE}`, `--target-tags=${n}`, `--description=${marker(record.name)}`,
            ]),
            "gcloud compute firewall-rules create",
          );
        }
      },
    },
    {
      id: "vm",
      title: `Create the VM (${record.machineType}, nested virtualization, Ubuntu 24.04)`,
      run: async () => {
        const vm = await gcp.instance(record);
        if (vm) {
          if (vm.labels?.[LABEL] !== record.name) throw notOurs("VM", n, gcp.project, record.name);
          return;
        }
        const r = await gcp.gcloud(gcpInstanceCreateArgs(record), { timeoutMs: 600_000 });
        if (r.code !== 0 && /N2_CPUS|quota/i.test(r.stderr)) {
          throw new TapdanceError("NO_CAPACITY", `Google Cloud refused the VM: ${errorTail(r)}`, { hint: "Ask for a higher N2 CPU quota (4 or more) in the console under IAM & Admin > Quotas, or pick another zone with --zone." });
        }
        if (r.code !== 0 && /nested virtualization|enableNestedVirtualization|constraints\/compute.disableNestedVirtualization/i.test(r.stderr)) {
          throw new TapdanceError("NOT_SUPPORTED", `Google Cloud refused nested virtualization: ${errorTail(r)}`, { hint: "An organization policy forbids it. Use a project outside that organization (a personal account)." });
        }
        check(r, "gcloud compute instances create");
      },
    },
    {
      id: "ssh",
      title: "Wait until the VM answers over SSH (through Google's IAP tunnel)",
      run: async () => {
        await gcp.ensureRunning(record, io.out.progress);
        const deadline = io.now().getTime() + 8 * 60_000;
        let last: ExecResult | undefined;
        while (io.now().getTime() < deadline) {
          last = await gcp.ssh(record, "true", { timeoutMs: 90_000 });
          if (last.code === 0) return;
          await io.sleep(10_000);
        }
        throw new TapdanceError("TIMEOUT", `The VM did not answer over SSH in 8 minutes${last ? `: ${errorTail(last, 3)}` : ""}`, {
          hint: "gcloud must be allowed to SSH through IAP (project owner or roles/compute.osAdminLogin and roles/iap.tunnelResourceAccessor).",
        });
      },
    },
    {
      id: "setup",
      title: "Set up the machine: Android SDK, emulator, Tailscale, Tapdance host (about 5-10 min)",
      run: async () => {
        await gcp.ensureRunning(record, io.out.progress);
        check(await gcp.gcloud(["compute", "scp", io.assets.hostSetup, `${n}:tapdance-host-setup.sh`, "--zone", record.zone, "--tunnel-through-iap", `--billing-project=${gcp.project}`], { timeoutMs: 180_000 }), "copying host-setup.sh to the VM");
        const cmd = gcpSetupCommand(record, { withKey: input.tailscaleKey !== undefined, extra: input.extraSetupArgs });
        const r = await gcp.ssh(record, cmd, {
          timeoutMs: 60 * 60_000,
          onLine: setupLineHandler(io, setupLog(io, record.name)),
          ...(input.tailscaleKey !== undefined ? { input: `${input.tailscaleKey}\n` } : {}),
        });
        if (r.code !== 0) {
          throw new TapdanceError("HOST_CHECK_FAILED", `host-setup.sh on the VM failed (exit ${r.code}); the last lines are above and the full log is in ${setupLog(io, record.name)}`, {
            hint: "Fix what it names (a Tailscale approval that timed out, a download that failed).",
          });
        }
      },
    },
    {
      id: "connect",
      title: "Connect this computer to the machine",
      run: async () => {
        await gcp.ensureRunning(record, io.out.progress);
        const remote = (c: string) => gcp.ssh(record, c, { timeoutMs: 90_000 });
        record.endpoint = await remoteEndpoint(remote);
        // Tailscale may have named it tapdance-<name>-1 (an older node of that name is still listed).
        record.tailscaleHostname = new URL(record.endpoint).hostname.split(".")[0] ?? record.tailscaleHostname;
        const c = await connectMachine(io, { endpoint: record.endpoint, target: record.target, label: record.label, platform: "android" }, remote);
        if (!c.ok) io.out.warn(`connect saved the machine, but some checks failed: ${c.checks.filter((x) => x.status === "fail").map((x) => `${x.name}: ${x.message ?? ""}`).join("; ")}`);
      },
    },
  ];
  await checkLocalTailscale(io);
  await runSteps(record, steps, io, { create: `tapdance machine create --cloud gcp --name ${record.name}${record.project ? ` --project ${record.project}` : ""}`, destroy: `tapdance machine destroy ${record.name}` });
}

export async function gcpStop(gcp: Gcp, record: MachineRecord): Promise<void> {
  check(await gcp.gcloud(["compute", "instances", "stop", record.resourceName, "--zone", record.zone], { timeoutMs: 600_000 }), "gcloud compute instances stop");
}

export async function gcpStart(gcp: Gcp, record: MachineRecord): Promise<void> {
  check(await gcp.gcloud(["compute", "instances", "start", record.resourceName, "--zone", record.zone], { timeoutMs: 600_000 }), "gcloud compute instances start");
}

export interface DestroyReport {
  removed: string[];
  notes: string[];
  leftovers: LeftoverReport;
}

export interface LeftoverReport {
  /** Tapdance's resources for this machine still there: must be empty. */
  ours: string[];
  /** Other billable resources in the account, not made by Tapdance: listed, never touched. */
  others: string[];
  /** Kinds that could not be checked. */
  unknown: string[];
}

export async function gcpDestroy(io: MachineIo, gcp: Gcp, record: MachineRecord): Promise<DestroyReport> {
  const n = record.resourceName;
  const removed: string[] = [];
  const notes: string[] = [];
  const vm = await gcp.instance(record);
  if (vm && vm.labels?.[LABEL] !== record.name) {
    throw new TapdanceError("FORBIDDEN", `The VM ${n} in ${gcp.project} is not labelled ${marker(record.name)}; Tapdance did not make it and leaves it alone`);
  }
  // Every part is checked before anything is deleted: a network, subnet or firewall rule of that name
  // without this machine's marker is someone else's.
  const parts: Array<ReturnType<typeof networkParts>[number]> = [];
  for (const part of networkParts(record)) {
    const o = await gcp.owner(part.kind, part.name, part.extra, record.name);
    if (o === "theirs") throw notOurs(part.what, part.name, gcp.project, record.name);
    if (o === "ours") parts.push(part);
  }
  if (vm?.status === "RUNNING") {
    io.out.progress("Logging the machine out of Tailscale…");
    const r = await gcp.ssh(record, TAILSCALE_LOGOUT, { timeoutMs: 90_000 });
    if (r.code === 0) {
      removed.push(`Tailscale: ${record.tailscaleHostname} logged out`);
      notes.push(`Tailscale keeps listing ${record.tailscaleHostname} as offline: delete it under Machines in the admin console (https://login.tailscale.com/admin/machines).`);
    } else if (r.code === 3 || r.code === 4) removed.push("Tailscale: the machine had not joined your tailnet, nothing to remove");
    else notes.push(`Could not log ${record.tailscaleHostname} out of Tailscale; remove it under Machines in the Tailscale admin console (https://login.tailscale.com/admin/machines).`);
  } else if (record.done.includes("setup")) {
    notes.push(`The VM was not running, so it could not log out of Tailscale: remove ${record.tailscaleHostname} under Machines in the Tailscale admin console (https://login.tailscale.com/admin/machines).`);
  }
  io.out.progress(`Removing connect target ${record.target}…`);
  removed.push(await disconnectMachine(io, record.target));
  if (vm) {
    io.out.progress(`Deleting the VM ${n} and its disk…`);
    check(await gcp.gcloud(["compute", "instances", "delete", n, "--zone", record.zone, "--delete-disks=all"], { timeoutMs: 600_000 }), "gcloud compute instances delete");
    removed.push(`VM ${n} and its boot disk`);
  }
  for (const part of parts) {
    check(await gcp.gcloud([...part.kind, "delete", part.name, ...part.extra]), `gcloud ${part.kind.join(" ")} delete`);
    removed.push(`${part.what} ${part.name}`);
  }
  io.out.progress("Checking that nothing billable is left…");
  const leftovers = await gcpLeftovers(gcp, record);
  return { removed, notes, leftovers };
}

/**
 * The same kinds infrastructure/scripts/gcp-leftovers.sh checks, split into this machine's resources
 * (by name and label) and everything else in the project (listed, never touched).
 */
export async function gcpLeftovers(gcp: Gcp, record: Pick<MachineRecord, "name" | "resourceName">): Promise<LeftoverReport> {
  const n = record.resourceName;
  const ours: string[] = [];
  const others: string[] = [];
  const unknown: string[] = [];
  // Exact names only: machine "android" must never claim "android-2"'s tapdance-android-2.
  const nameIs = (...names: string[]) => (row: string) => names.includes(row.split(/\s+/)[0] ?? "");
  // `labels` prints as key=value pairs separated by ";" (or ","): the value must be exactly this name.
  const labelled = (row: string) => (row.split(/\s+/)[3] ?? "").split(/[;,]/).some((kv) => kv.trim() === marker(record.name));
  const kinds: Array<[string, string[], (row: string) => boolean]> = [
    ["instance", ["compute", "instances", "list", "--format=value(name,zone.basename(),status,labels)"], (row) => nameIs(n)(row) || labelled(row)],
    ["disk", ["compute", "disks", "list", "--format=value(name,zone.basename(),sizeGb)"], nameIs(n)],
    ["address", ["compute", "addresses", "list", "--format=value(name,region.basename(),status)"], nameIs(n)],
    ["snapshot", ["compute", "snapshots", "list", "--format=value(name,diskSizeGb)"], nameIs(n)],
    ["firewall rule", ["compute", "firewall-rules", "list", "--format=value(name)"], nameIs(`${n}-iap-ssh`)],
    ["network", ["compute", "networks", "list", "--format=value(name)"], nameIs(n)],
    ["forwarding rule", ["compute", "forwarding-rules", "list", "--format=value(name,region.basename())"], nameIs(n)],
    ["router", ["compute", "routers", "list", "--format=value(name,region.basename())"], nameIs(n)],
  ];
  for (const [kind, args, isOurs] of kinds) {
    const r = await gcp.gcloud(args, { timeoutMs: 120_000 });
    if (r.code !== 0 || /did not succeed/i.test(r.stderr)) {
      unknown.push(`${kind}s (${errorTail(r, 1) || `exit ${r.code}`})`);
      continue;
    }
    for (const row of r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
      const free = kind === "firewall rule" || kind === "network" || kind === "router";
      if (isOurs(row)) ours.push(`${kind} ${row}`);
      else if (!free) others.push(`${kind} ${row}`);
    }
  }
  return { ours, others, unknown };
}

export function gcpCostOf(record: Pick<MachineRecord, "machineType" | "diskGb" | "createdAt">, status: string, now: Date): CostEstimate | undefined {
  return gcpCost({ machineType: record.machineType, diskGb: record.diskGb ?? GCP_DEFAULTS.diskGb, createdAt: new Date(record.createdAt), status, now });
}

export function gcpPriceLine(machineType: string, diskGb: number): string {
  const run = gcpRunningHourly(machineType);
  const disk = gcpDiskHourly(diskGb) * 730;
  return run === undefined
    ? `${machineType}: see https://cloud.google.com/compute/vm-instance-pricing; disk about USD ${disk.toFixed(2)} a month until destroyed`
    : `about USD ${run.toFixed(2)} an hour while it runs (${machineType}, us-central1 list price read 2026-11-09; Europe about 10 % more), plus about USD ${disk.toFixed(2)} a month for its ${diskGb} GB disk until you destroy it. Current prices: https://cloud.google.com/compute/vm-instance-pricing`;
}
