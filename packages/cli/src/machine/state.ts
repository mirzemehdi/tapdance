import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TapdanceError, tapdanceHome } from "@tapdance/sdk";

export type Cloud = "gcp" | "scaleway";
export const CLOUDS: readonly Cloud[] = ["gcp", "scaleway"];

/**
 * What `tapdance machine create` recorded on this computer about a machine it made. The cloud's own
 * labels (Google Cloud) and the `tapdance-` name prefix (Scaleway) are the truth for what exists; this
 * record holds what the cloud does not: which steps are done (so a failed create resumes), the
 * connect target, the dedicated ssh key. It holds no secret: no token, password or cloud key.
 */
export interface MachineRecord {
  version: 1;
  name: string;
  cloud: Cloud;
  createdAt: string;
  /** Google Cloud project id, or Scaleway project id (absent: the scw CLI's default project). */
  project?: string;
  zone: string;
  machineType: string;
  /** The cloud resource name: tapdance-<name>. */
  resourceName: string;
  /** The pairing label on the machine: this computer's name. */
  label: string;
  /** The connect target name on this computer (the machine name). */
  target: string;
  tailscaleHostname: string;
  /** A git ref to build Tapdance from on the machine (--setup-ref), or "" to use tapdanceVersion. */
  setupRef: string;
  /** The tapdance-cli version the machine installs from npm (default: this CLI's). */
  tapdanceVersion?: string;
  idleStopMinutes?: number | "off";
  maxHours?: number | "off";
  diskGb?: number;
  /** Scaleway */
  serverId?: string;
  /** A Mac the person rented themselves and handed over with --server-id (Tapdance did not rent it). */
  adopted?: boolean;
  sshKeyId?: string;
  sshUser?: string;
  ip?: string;
  scheduledDeletion?: boolean;
  deletableAt?: string;
  /** The endpoint `host up` printed. */
  endpoint?: string;
  /** Finished create steps, by id. */
  done: string[];
  /** Seconds per finished step, for the summary and the evidence. */
  timings: Record<string, number>;
  /** Set when destroy could only schedule the deletion (Scaleway before its 24 hours). */
  pendingDeletionAt?: string;
}

/** Machine names: also the connect target name and part of every cloud resource name. */
export const MACHINE_NAME = /^[a-z]([a-z0-9-]{0,18}[a-z0-9])?$/;

export function assertMachineName(name: string): string {
  if (!MACHINE_NAME.test(name)) {
    throw new TapdanceError("USAGE", `"${name}" is not a machine name`, {
      hint: "Use 1-20 lowercase letters, digits and hyphens, starting with a letter, e.g. --name android.",
    });
  }
  return name;
}

export function resourceName(name: string): string {
  return `tapdance-${name}`;
}

export function machinesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(tapdanceHome(env), "machines");
}

export function machineDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(machinesDir(env), assertMachineName(name));
}

export class MachineStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  dir(name: string): string {
    return machineDir(name, this.env);
  }

  async get(name: string): Promise<MachineRecord | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir(name), "machine.json"), "utf8")) as MachineRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new TapdanceError("CONFIG_INVALID", `Cannot read the record of machine ${name}: ${(error as Error).message}`);
    }
  }

  async list(): Promise<MachineRecord[]> {
    let names: string[];
    try {
      names = await readdir(machinesDir(this.env));
    } catch {
      return [];
    }
    const out: MachineRecord[] = [];
    for (const n of names.sort()) {
      if (!MACHINE_NAME.test(n)) continue;
      const r = await this.get(n).catch(() => undefined);
      if (r) out.push(r);
    }
    return out;
  }

  async save(record: MachineRecord): Promise<void> {
    const dir = this.dir(record.name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const file = join(dir, "machine.json");
    // A temp name of its own: two processes saving at once (a background create and destroy) never
    // write into the same temp file, so the rename always moves a whole record into place.
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async remove(name: string): Promise<void> {
    await rm(this.dir(name), { recursive: true, force: true });
  }

  /** `destroy` marks the machine while it runs, so a create still running stops before its next step. */
  destroyingPath(name: string): string {
    return join(this.dir(name), "destroying");
  }

  async markDestroying(name: string, pid: number): Promise<void> {
    await mkdir(this.dir(name), { recursive: true, mode: 0o700 });
    await writeFile(this.destroyingPath(name), `${pid}\n`, { mode: 0o600 });
  }

  async clearDestroying(name: string): Promise<void> {
    await rm(this.destroyingPath(name), { force: true });
  }

  /** The pid of the destroy that marked the machine (the caller checks it still runs), or undefined. */
  async destroyingPid(name: string): Promise<number | undefined> {
    const pid = Number((await readFile(this.destroyingPath(name), "utf8").catch(() => "")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }
}
