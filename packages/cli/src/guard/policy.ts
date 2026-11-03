import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { TapdanceError, redactSecrets, tapdanceHome } from "@tapdance/sdk";

/**
 * The Mac owner's local policy for the worker guard. It lives on the worker, is edited only on the
 * worker, and nothing the guard serves can change it: remote clients get no route to it.
 */
export const GuardPolicySchema = z
  .object({
    /** Only "device-only" exists: no host shell. Builds from allow-listed git repositories are `allow.builds` + `builds`. */
    profile: z.enum(["device-only"]).default("device-only"),
    listen: z.object({ host: z.string().default("127.0.0.1"), port: z.number().int().min(0).max(65535).default(4720) }).default({ host: "127.0.0.1", port: 4720 }),
    allow: z
      .object({
        install: z.boolean().default(true),
        interaction: z.boolean().default(true),
        inspection: z.boolean().default(true),
        screenshots: z.boolean().default(true),
        recording: z.boolean().default(true),
        logs: z.boolean().default(true),
        streaming: z.boolean().default(true),
        input: z.boolean().default(true),
        /** Device settings (network, permissions, appearance, text size, orientation, status bar). */
        settings: z.boolean().default(true),
        /** Files pushed to or pulled from the leased device's shared storage or a debuggable app's sandbox. */
        files: z.boolean().default(true),
        /**
         * Notifications on a physical phone: reading them (they can hold the owner's private text) and
         * posting to it. On emulators and simulators, reading is part of `inspection` and posting (a
         * shell notification, a push payload) part of `interaction`.
         */
        notifications: z.boolean().default(false),
        /** Frame and memory measurements. */
        perf: z.boolean().default(true),
        /** `adb shell` inside a leased emulator (its own VM, wiped at release). Never on physical phones. */
        deviceShell: z.boolean().default(true),
        /** Physical phones plugged into the Mac carry the owner's data; off unless the owner turns it on. */
        physicalDevices: z.boolean().default(false),
        /**
         * Build an app on this machine from an allow-listed git repository and install it on the lease.
         * Building runs the project's scripts (Xcode run-script phases, Gradle): code execution on this
         * machine as this account. Off by default; `tapdance host builds enable`.
         */
        builds: z.boolean().default(false),
        /**
         * Download an APK the user's CI built (a GitHub Actions artifact of an allow-listed repository)
         * with this machine's `gh auth` and install it on an Android lease. Nothing from the repository
         * runs here. Off by default; `tapdance host artifacts enable`. Not a token scope: a token also
         * needs `install`.
         */
        artifacts: z.boolean().default(false),
      })
      .default({
        install: true,
        interaction: true,
        inspection: true,
        screenshots: true,
        recording: true,
        logs: true,
        streaming: true,
        input: true,
        settings: true,
        files: true,
        notifications: false,
        perf: true,
        deviceShell: true,
        physicalDevices: false,
        builds: false,
        artifacts: false,
      }),
    /** Builds on this machine (`allow.builds`): which repositories, which refs, how to reach them. */
    builds: z
      .object({
        /** Repository URLs that may be built (https or ssh), compared without a trailing .git or slash. */
        repos: z.array(z.string().min(1).max(500)).max(100).default([]),
        /** When set, only commits on these branches of the remote (e.g. main) are built. */
        protectedRefs: z.array(z.string().regex(/^(?!-)[A-Za-z0-9._/-]{1,200}$/)).max(20).default([]),
        /** How git reaches private repositories: the host's `gh auth`, a read-only deploy key, or nothing. */
        gitAuth: z.enum(["none", "gh", "deploy-key"]).default("none"),
        timeoutMinutes: z.number().int().min(1).max(240).default(45),
      })
      .default({ repos: [], protectedRefs: [], gitAuth: "none", timeoutMinutes: 45 }),
    /** Installs from CI (`allow.artifacts`): which GitHub repositories and branches, and how large. */
    artifacts: z
      .object({
        /** GitHub repositories (owner/repo or https://github.com/owner/repo) whose Actions artifacts may be installed. */
        repos: z.array(z.string().min(1).max(300)).max(100).default([]),
        /** When set, only artifacts of runs whose head branch is listed. */
        branches: z.array(z.string().regex(/^(?![-/.])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/)).max(50).default([]),
        /** The largest artifact (zip) and APK, in MB. */
        maxMB: z.number().int().min(1).max(4096).default(512),
      })
      .default({ repos: [], branches: [], maxMB: 512 }),
    limits: z
      .object({
        maxSessions: z.number().int().min(1).max(16).default(1),
        maxLeaseMinutes: z.number().int().min(1).max(240).default(60),
        maxUploadMB: z.number().int().min(1).max(4096).default(512),
        tokenDays: z.number().int().min(1).max(90).default(7),
      })
      .default({ maxSessions: 1, maxLeaseMinutes: 60, maxUploadMB: 512, tokenDays: 7 }),
    /**
     * Cost guard for a host on a cloud VM (Linux only; ignored on macOS): power the machine off after
     * `idleMinutes` without a lease, guard request or build, and stop taking leases once it has been up
     * `maxUptimeHours`, powering off when the last lease ends. 0 turns each off. Absent: off, and
     * `tapdance host up` may set its cloud default. The stop command is fixed (guard/host-stop.ts).
     */
    hostStop: z
      .object({
        idleMinutes: z.number().int().min(0).max(1440).default(0),
        maxUptimeHours: z.number().int().min(0).max(720).default(0),
      })
      .strict()
      .optional(),
  })
  .strict();

export type GuardPolicy = z.infer<typeof GuardPolicySchema>;

export function guardDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(tapdanceHome(env), "worker");
}

/** Refuses a policy or token file anyone but the owner could write: a writable policy is no policy. */
function assertOwnerOnly(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o022) {
    throw new TapdanceError("CONFIG_INVALID", `${path} is writable by other users (mode ${mode.toString(8)})`, { hint: `chmod 600 ${path}` });
  }
}

export async function loadPolicy(env: NodeJS.ProcessEnv = process.env): Promise<{ policy: GuardPolicy; path: string }> {
  const path = join(guardDir(env), "policy.json");
  if (!existsSync(path)) {
    await mkdir(guardDir(env), { recursive: true, mode: 0o700 });
    const policy = GuardPolicySchema.parse({});
    await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
    return { policy, path };
  }
  assertOwnerOnly(path);
  return { policy: GuardPolicySchema.parse(JSON.parse(await readFile(path, "utf8"))), path };
}

export interface GuardToken {
  id: string;
  label: string;
  hash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  /**
   * Policy areas this token may use (e.g. ["interaction", "inspection", "screenshots"]). Absent: every
   * area the host policy allows. A scope never widens the policy: both must allow a request.
   */
  scopes?: string[];
}

/** The host policy as one token may use it: each `allow` switch also needs the token's scope. */
export function scopedPolicy(policy: GuardPolicy, token: GuardToken | undefined): GuardPolicy {
  if (!token?.scopes) return policy;
  const allow = Object.fromEntries(
    Object.entries(policy.allow).map(([area, on]) => [area, on && (OWNER_ONLY_SWITCHES.includes(area) ? on : token.scopes!.includes(area))]),
  ) as GuardPolicy["allow"];
  return { ...policy, allow };
}

/**
 * Switches only the host owner sets, never a token scope: physical phones, and installs from CI (which
 * a token reaches through its `install` scope).
 */
const OWNER_ONLY_SWITCHES = ["physicalDevices", "artifacts"];

/** The scope names a token can be issued with: the policy's allow switches except the owner-only ones. */
export function scopeNames(): string[] {
  return Object.keys(GuardPolicySchema.parse({}).allow).filter((k) => !OWNER_ONLY_SWITCHES.includes(k));
}

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** Revocable credentials the guard issues after the owner approves locally (`worker guard pair`). */
export class GuardTokens {
  readonly path: string;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.path = join(guardDir(env), "tokens.json");
  }

  async all(): Promise<GuardToken[]> {
    if (!existsSync(this.path)) return [];
    assertOwnerOnly(this.path);
    return JSON.parse(await readFile(this.path, "utf8")) as GuardToken[];
  }

  private async save(tokens: GuardToken[]): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600);
  }

  async issue(label: string, days: number, scopes?: string[]): Promise<{ secret: string; token: GuardToken }> {
    const secret = `tdg_${randomBytes(24).toString("base64url")}`;
    const now = Date.now();
    const token: GuardToken = {
      id: `gt_${randomBytes(6).toString("hex")}`,
      label,
      hash: hash(secret),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + days * 86_400_000).toISOString(),
      ...(scopes ? { scopes } : {}),
    };
    await this.save([...(await this.all()), token]);
    return { secret, token };
  }

  async revoke(idOrAll: string): Promise<number> {
    let count = 0;
    const tokens = (await this.all()).map((t) => {
      if ((idOrAll === "all" || t.id === idOrAll) && !t.revokedAt) {
        count++;
        return { ...t, revokedAt: new Date().toISOString() };
      }
      return t;
    });
    await this.save(tokens);
    return count;
  }

  /** Read on every request, so a revocation takes effect immediately. */
  async verify(secret: string): Promise<GuardToken | undefined> {
    const digest = Buffer.from(hash(secret));
    for (const t of await this.all()) {
      const candidate = Buffer.from(t.hash);
      if (candidate.length === digest.length && timingSafeEqual(candidate, digest)) {
        if (t.revokedAt || Date.parse(t.expiresAt) <= Date.now()) return undefined;
        return t;
      }
    }
    return undefined;
  }
}

export interface AuditEntry {
  /** The guard token id (not the secret). */
  client?: string;
  method: string;
  path: string;
  command?: string;
  decision: "allow" | "deny";
  reason?: string;
  leaseId?: string;
}

/** Local, append-only record of what remote clients asked for. Never bodies, tokens or secrets. */
export async function audit(entry: AuditEntry, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = join(guardDir(env), "audit.log");
  await mkdir(guardDir(env), { recursive: true, mode: 0o700 });
  await appendFile(file, `${redactSecrets(JSON.stringify({ at: new Date().toISOString(), ...entry }))}\n`, { mode: 0o600 });
}
