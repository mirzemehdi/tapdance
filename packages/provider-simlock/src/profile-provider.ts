import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentDeviceClient, type AgentDeviceClient } from "agent-device";
import {
  TapdanceError,
  type CallOptions,
  type DeviceInventory,
  type DoctorCheck,
  type LeaseHandle,
  type LeaseRequest,
  type LeaseStatus,
  type ViewerEndpoints,
  type WorkerInfo,
} from "@tapdance/core";
import type { ExecResult } from "./http.js";
import { SimlockProvider } from "./provider.js";

/**
 * Device profiles: an emulator the owner prepared once (signed in to a Google account, settings,
 * Play Store updates) that every lease boots from, with the lease's changes thrown away.
 *
 * Simlock creates, wipes and owns its emulators and enrols only USB phones, so it cannot lease these.
 * Tapdance runs them itself: the profile's AVD boots with `-read-only` (writes go to a temporary
 * overlay the emulator discards on exit) and agent-device drives it directly on this machine. The UI,
 * app, evidence and device-state methods are SimlockProvider's own; only the transport differs.
 *
 * Profiles run where Tapdance runs (local mode). There is no live browser stream for them: the
 * emulator's own window is the view.
 */
export const PROFILE_PROVIDER = "tapdance-profile";

export interface ProfileRecord {
  name: string;
  platform: "android";
  /** sdkmanager package of the system image, e.g. system-images;android-34;google_apis_playstore;arm64-v8a */
  image: string;
  osVersion: string;
  device: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
}

export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function profilesHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["TAPDANCE_HOME"] ?? join(homedir(), ".tapdance"), "profiles", "android");
}

/** AVDs of profiles live in Tapdance's own AVD home, never next to the developer's own AVDs. */
export function profileAvdHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(profilesHome(env), "avd");
}

export const avdName = (profile: string) => `tapdance-${profile}`;

export async function readProfiles(env: NodeJS.ProcessEnv = process.env): Promise<ProfileRecord[]> {
  try {
    return JSON.parse(await readFile(join(profilesHome(env), "profiles.json"), "utf8")) as ProfileRecord[];
  } catch {
    return [];
  }
}

export async function writeProfiles(list: ProfileRecord[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await mkdir(profilesHome(env), { recursive: true, mode: 0o700 });
  await writeFile(join(profilesHome(env), "profiles.json"), `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
}

export function androidSdk(env: NodeJS.ProcessEnv = process.env): string {
  return env["ANDROID_HOME"] ?? env["ANDROID_SDK_ROOT"] ?? join(homedir(), process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
}

interface ProfileLeaseData {
  profile: string;
  port: number;
  pid: number;
  session: string;
}

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });

export class ProfileProvider extends SimlockProvider {
  override readonly name: string = PROFILE_PROVIDER;
  private readonly agentClients = new Map<string, AgentDeviceClient>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    // The Simlock connection is never used: every transport method is overridden below.
    super({ kind: "local", baseUrl: "http://127.0.0.1:9", token: "", tenant: "local", runId: "profile", clientId: "profile", source: "profile" });
  }

  private adb(): string {
    return join(androidSdk(this.env), "platform-tools", "adb");
  }

  private run(file: string, args: string[], options: { timeoutMs?: number; stdin?: string } = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(file, args, { timeout: options.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, env: this.env }, (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : error ? 1 : 0;
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(new TapdanceError("PROVIDER_UNAVAILABLE", `${file} not found`, { hint: "Install the Android SDK platform-tools and emulator (see docs/platforms/android.md)." }));
        resolve({ exitCode: code, stdout, stderr });
      });
      if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    });
  }

  private profileData(handle: LeaseHandle): ProfileLeaseData {
    if (handle.provider !== PROFILE_PROVIDER) throw new TapdanceError("FORBIDDEN", `Lease ${handle.leaseId} is not a profile lease`);
    return handle.providerData as unknown as ProfileLeaseData;
  }

  protected override agentClient(handle: LeaseHandle): AgentDeviceClient {
    const data = this.profileData(handle);
    let client = this.agentClients.get(data.session);
    if (!client) {
      client = createAgentDeviceClient({ session: data.session } as never);
      this.agentClients.set(data.session, client);
    }
    return client;
  }

  protected override execOn(handle: LeaseHandle, tool: "adb" | "simctl", args: string[], timeoutMs?: number, stdin?: string): Promise<ExecResult> {
    if (tool !== "adb") throw new TapdanceError("NOT_SUPPORTED", "Profiles are Android emulators");
    return this.run(this.adb(), ["-s", handle.deviceId, ...args], { ...(timeoutMs ? { timeoutMs } : {}), ...(stdin !== undefined ? { stdin } : {}) });
  }

  protected override isLocal(): boolean {
    return true;
  }

  protected override scope(): Record<string, unknown> {
    return {};
  }

  override async doctor(): Promise<DoctorCheck[]> {
    const profiles = await readProfiles(this.env);
    return [{ id: "profiles", title: "Device profiles", status: profiles.length ? "pass" : "skip", detail: profiles.length ? profiles.map((p) => p.name).join(", ") : "none (tapdance device profile create)" }];
  }

  override async inventory(): Promise<DeviceInventory> {
    const profiles = await readProfiles(this.env);
    return {
      catalog: profiles.length ? [{ platform: "android", models: profiles.map((p) => `profile:${p.name}`), osVersions: [...new Set(profiles.map((p) => p.osVersion))] }] : [],
      capacity: [],
      devices: [],
      queueDepth: 0,
      notes: profiles.length ? ["Lease a profile with `--profile <name>` (MCP: lease_device profile)."] : [],
    };
  }

  override async workers(): Promise<WorkerInfo[]> {
    return [];
  }

  override async lease(sessionId: string, request: LeaseRequest, options: CallOptions = {}): Promise<LeaseHandle> {
    const name = request.profile ?? "";
    const profile = (await readProfiles(this.env)).find((p) => p.name === name);
    if (!profile) throw new TapdanceError("DEVICE_UNAVAILABLE", `No device profile "${name}"`, { hint: "List them with `tapdance device profile list`; create one with `tapdance device profile create <name>`." });
    if (request.platform !== "android") throw new TapdanceError("USAGE", "Device profiles are Android emulators");
    const emulator = join(androidSdk(this.env), "emulator", "emulator");
    if (!existsSync(emulator)) throw new TapdanceError("PROVIDER_UNAVAILABLE", "The Android emulator is not installed", { hint: "sdkmanager emulator" });
    let port = 0;
    for (let p = 5600; p < 5700; p += 2) {
      if ((await portFree(p)) && (await portFree(p + 1))) {
        port = p;
        break;
      }
    }
    if (!port) throw new TapdanceError("NO_CAPACITY", "No free emulator port between 5600 and 5699");
    options.onProgress?.(`Booting profile "${name}" (read-only: nothing this lease changes is kept)`);
    const child = spawn(emulator, ["-avd", avdName(name), "-port", String(port), "-read-only", "-no-snapshot", "-no-boot-anim", "-no-audio", ...(this.env["TAPDANCE_PROFILE_HEADLESS"] === "1" ? ["-no-window"] : [])], {
      env: { ...this.env, ANDROID_AVD_HOME: profileAvdHome(this.env) },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (!child.pid) throw new TapdanceError("DEVICE_ERROR", "Could not start the emulator");
    const serial = `emulator-${port}`;
    const deadline = Date.now() + Math.min(request.waitTimeoutMs ?? 300_000, 300_000);
    for (;;) {
      const r = await this.run(this.adb(), ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeoutMs: 10_000 }).catch(() => undefined);
      if (r?.stdout.trim() === "1") break;
      if (Date.now() > deadline) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
        throw new TapdanceError("TIMEOUT", `Profile "${name}" did not finish booting`, { hint: "Run it once by hand: `tapdance device profile edit <name>`." });
      }
      await new Promise((r2) => setTimeout(r2, 2000));
    }
    const leaseId = randomBytes(16).toString("hex");
    // agent-device remembers which session owns a serial; one session name per emulator port means a
    // later lease on the same port is never refused because an earlier process did not close it.
    const data: ProfileLeaseData = { profile: name, port, pid: child.pid, session: `td-profile-${serial}` };
    return {
      provider: PROFILE_PROVIDER,
      leaseId,
      sessionId,
      platform: "android",
      deviceId: serial,
      model: `profile:${name}`,
      osVersion: profile.osVersion,
      physical: false,
      ttlMs: request.ttlMs,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + request.ttlMs).toISOString(),
      location: { kind: "local", workerLabel: "this machine (device profile)", endpoint: "local" },
      providerData: data as unknown as Record<string, unknown>,
    };
  }

  override async status(handle: LeaseHandle): Promise<LeaseStatus> {
    const { pid } = this.profileData(handle);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    return alive ? { state: "active", handle } : { state: "ended", handle, endReason: "The profile emulator is no longer running" };
  }

  override async renew(handle: LeaseHandle, ttlMs = handle.ttlMs): Promise<LeaseStatus> {
    const status = await this.status(handle);
    return status.state === "active" ? { state: "active", handle: { ...handle, ttlMs, expiresAt: new Date(Date.now() + ttlMs).toISOString() } } : status;
  }

  override async release(handle: LeaseHandle): Promise<{ released: boolean }> {
    const { pid, session } = this.profileData(handle);
    await this.agentClient(handle).sessions.close({ ...this.selection(handle) } as never).catch(() => undefined);
    this.agentClients.delete(session);
    await this.run(this.adb(), ["-s", handle.deviceId, "emu", "kill"], { timeoutMs: 15_000 }).catch(() => undefined);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return { released: true };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone between checks.
    }
    return { released: true };
  }

  override async listApps(handle: LeaseHandle): Promise<string[]> {
    // agent-device's local daemon needs the device named; Simlock's proxy knows it from the lease.
    return (await this.agentClient(handle).apps.list({ ...this.selection(handle) } as never)) as string[];
  }

  override async viewer(): Promise<ViewerEndpoints> {
    throw new TapdanceError("NOT_SUPPORTED", "Profile leases have no browser stream", { hint: "Watch and use the emulator's own window on this machine." });
  }

  override async close(): Promise<void> {
    this.agentClients.clear();
  }
}
