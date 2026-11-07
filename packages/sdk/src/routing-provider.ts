import {
  TapdanceError,
  urlOrigin,
  type CallOptions,
  type CatalogEntry,
  type DeviceInventory,
  type DeviceProvider,
  type DoctorCheck,
  type HostInventory,
  type LeaseHandle,
  type LeaseRequest,
  type Platform,
  type WorkerInfo,
} from "@tapdance/core";

/** One `tapdance connect` target with its own provider (and token, bound to its origin). */
export interface RouteTarget {
  name: string;
  endpoint: string;
  /** Only route these platforms here (`connect --platform`); unset = whatever the host serves. */
  platforms?: Platform[];
  provider: DeviceProvider;
  /**
   * A quick check that the host answers, returning what it serves. Throws when it does not answer
   * within `timeoutMs`.
   */
  probe(timeoutMs: number): Promise<DeviceInventory>;
}

/** How long a lease waits for a host to answer before calling it down. */
export const TARGET_PROBE_MS = 5_000;

const LABEL: Record<Platform, string> = { android: "Android", ios: "iOS" };

/** Platforms an inventory really offers: a catalog entry with models or OS versions. */
export function servedPlatforms(inventory: Pick<DeviceInventory, "catalog">): Platform[] {
  return [...new Set(inventory.catalog.filter((c) => c.models.length > 0 || c.osVersions.length > 0).map((c) => c.platform))];
}

/** Why `entry` cannot serve a requested model or OS version, or undefined when it can. */
function mismatch(entry: CatalogEntry, request: LeaseRequest): string | undefined {
  if (request.device && !entry.models.some((m) => m.toLowerCase() === request.device!.toLowerCase())) return `has no ${request.device}`;
  // A plain version ("18.5", "34") must be offered; a range (">=17") is left to the host.
  if (request.osVersion && /^[\d.]+$/.test(request.osVersion) && entry.osVersions.length > 0 && !entry.osVersions.some((v) => v === request.osVersion || v.startsWith(`${request.osVersion}.`))) {
    return `has no ${LABEL[entry.platform]} ${request.osVersion}`;
  }
  return undefined;
}

function reasonOf(error: unknown): string {
  // The deepest cause says most ("connect ECONNREFUSED 100.64.0.7:443" rather than "fetch failed").
  let e: unknown = error;
  while (e instanceof Error && e.cause instanceof Error) e = e.cause;
  const message = e instanceof Error ? e.message : String(e);
  return message.split("\n")[0] || "no answer";
}

/**
 * Routes leases across several connect targets (one Simlock worker guard or gateway each) and sends
 * every call about a lease to the target that issued it, never to another one: the target is found
 * from the endpoint the lease recorded. Each target keeps its own provider and token, so one host
 * being down does not touch leases on the others.
 */
export class RoutingProvider implements DeviceProvider {
  readonly name: string;

  constructor(readonly targets: RouteTarget[]) {
    if (targets.length === 0) throw new TapdanceError("CONFIG_INVALID", "No connect targets are configured", { hint: "Run `tapdance connect <endpoint>` with the host's pairing token on stdin." });
    this.name = targets[0]!.provider.name;
  }

  /** The target that issued a lease, from the endpoint recorded on it. */
  targetFor(handle: LeaseHandle): RouteTarget {
    const recorded = typeof handle.providerData["baseUrl"] === "string" ? (handle.providerData["baseUrl"] as string) : handle.location.endpoint;
    const origin = urlOrigin(recorded) ?? recorded;
    const target = this.targets.find((t) => (urlOrigin(t.endpoint) ?? t.endpoint) === origin);
    if (target === undefined) {
      throw new TapdanceError("FORBIDDEN", `This lease belongs to ${origin}, which is not a connect target any more`, {
        hint: `Connect it again (\`tapdance connect ${origin}\` with its token on stdin) to use or release the lease, or let the lease expire there.`,
        details: { endpoint: origin, targets: this.targets.map((t) => t.name) },
      });
    }
    return target;
  }

  private on(handle: LeaseHandle): DeviceProvider {
    return this.targetFor(handle).provider;
  }

  private byName(name: string): RouteTarget {
    const target = this.targets.find((t) => t.name === name || (urlOrigin(t.endpoint) ?? t.endpoint) === (urlOrigin(name) ?? name));
    if (target === undefined) {
      throw new TapdanceError("USAGE", `No connect target is called "${name}"`, {
        hint: `Use one of: ${this.targets.map((t) => t.name).join(", ")} (\`tapdance connect --list\`).`,
      });
    }
    return target;
  }

  /** Probes targets in parallel; a down one gets its reason instead of an inventory. */
  private async probeAll(targets: RouteTarget[], timeoutMs = TARGET_PROBE_MS): Promise<Array<{ target: RouteTarget; inventory?: DeviceInventory; error?: string }>> {
    return Promise.all(
      targets.map(async (target) => {
        try {
          return { target, inventory: await target.probe(timeoutMs) };
        } catch (error) {
          return { target, error: reasonOf(error) };
        }
      }),
    );
  }

  // ---------------------------------------------------------------- discovery

  async doctor(options?: CallOptions): Promise<DoctorCheck[]> {
    const sections = await Promise.all(
      this.targets.map(async (target) => {
        const [checks, probe] = await Promise.all([
          target.provider.doctor(options).catch((error: unknown): DoctorCheck[] => [{ id: "provider", title: "Device provider", status: "fail", detail: reasonOf(error) }]),
          target.probe(TARGET_PROBE_MS).then(
            (inventory) => ({ inventory }),
            (error: unknown) => ({ error: reasonOf(error) }),
          ),
        ]);
        const usable = !checks.some((c) => c.status === "fail" && (c.id === "simlock.reachable" || c.id === "simlock.auth" || c.id === "provider"));
        const served = "inventory" in probe ? servedPlatforms(probe.inventory).filter((p) => !target.platforms || target.platforms.includes(p)) : [];
        return { target, checks, usable, served, error: "error" in probe ? probe.error : undefined };
      }),
    );
    const anyUsable = sections.some((s) => s.usable);
    const summary = sections.map((s) =>
      s.usable ? `${s.target.name}: ${s.served.length ? s.served.map((p) => LABEL[p]).join(" + ") : "nothing to lease"}` : `${s.target.name}: down`,
    );
    const platforms = (["android", "ios"] as const).map((p) => {
      const host = sections.find((s) => s.usable && s.served.includes(p));
      return `${LABEL[p]} → ${host ? host.target.name : "no host up"}`;
    });
    const down = sections.filter((s) => !s.usable);
    const checks: DoctorCheck[] = [
      {
        id: "targets",
        title: "Connect targets",
        status: !anyUsable ? "fail" : down.length > 0 ? "warn" : "pass",
        detail: `${summary.join("; ")}. Leases: ${platforms.join(", ")}`,
        ...(down.length > 0 ? { fix: `Bring ${down.map((s) => s.target.name).join(", ")} back (\`tapdance host status\` on that host), or remove it with \`tapdance disconnect <name>\`. The other targets keep working.` } : {}),
      },
    ];
    for (const s of sections) {
      checks.push({
        id: `target.${s.target.name}`,
        title: `Target ${s.target.name}`,
        status: s.usable ? "pass" : anyUsable ? "warn" : "fail",
        detail: `${s.target.endpoint}${s.target.platforms ? ` (only ${s.target.platforms.join(", ")})` : ""}: ${s.usable ? `up, serves ${s.served.length ? s.served.join(", ") : "nothing yet"}` : `down${s.error ? ` (${s.error})` : ""}`}`,
        target: s.target.name,
      });
      for (const c of s.checks) {
        // A host that is down is a warning while another one works: the setup is still usable.
        let status = c.status === "fail" && !s.usable && anyUsable ? "warn" : c.status;
        let detail = c.detail;
        // A platform this host does not run is no problem when another target serves it.
        const platform = /^simlock\.capacity\.(android|ios)$/.exec(c.id)?.[1] as Platform | undefined;
        const elsewhere = platform && s.usable && c.status === "warn" ? sections.find((o) => o !== s && o.usable && o.served.includes(platform)) : undefined;
        if (elsewhere) {
          status = "skip";
          detail = `${detail}; ${LABEL[platform!]} leases go to ${elsewhere.target.name}`;
        }
        const { fix, ...rest } = c;
        checks.push({ ...rest, ...(fix && status !== "skip" ? { fix } : {}), id: `target.${s.target.name}.${c.id}`, status, detail, target: s.target.name });
      }
    }
    return checks;
  }

  async inventory(filter: { platform?: Platform } = {}): Promise<DeviceInventory> {
    const targets = this.targets.filter((t) => !filter.platform || !t.platforms || t.platforms.includes(filter.platform));
    const probes = await Promise.all(
      targets.map(async (target) => {
        try {
          // The probe's own inventory is unfiltered: ask again with the filter only when it applies.
          await target.probe(TARGET_PROBE_MS);
          return { target, inventory: await target.provider.inventory(filter) };
        } catch (error) {
          return { target, error: reasonOf(error) };
        }
      }),
    );
    const hosts: HostInventory[] = probes.map((p) => ({
      target: p.target.name,
      endpoint: p.target.endpoint,
      reachable: p.inventory !== undefined,
      ...(p.error ? { error: p.error } : {}),
      ...(p.inventory ? { inventory: restrict(p.inventory, p.target.platforms) } : {}),
    }));
    const up = hosts.filter((h) => h.inventory);
    if (up.length === 0) {
      throw new TapdanceError("PROVIDER_UNREACHABLE", `No connect target answered: ${hosts.map((h) => `${h.target} (${h.endpoint}): ${h.error}`).join("; ")}`, {
        hint: "Check that the hosts run (`tapdance host status` on each) and that this machine reaches them (`tailscale status`).",
      });
    }
    const capacity = (["android", "ios"] as const)
      .filter((p) => !filter.platform || p === filter.platform)
      .map((platform) => {
        const rows = up.flatMap((h) => h.inventory!.capacity.filter((c) => c.platform === platform));
        return rows.reduce((a, c) => ({ platform, running: a.running + c.running, limit: a.limit + c.limit, warm: (a.warm ?? 0) + (c.warm ?? 0), leased: a.leased + c.leased }), { platform, running: 0, limit: 0, warm: 0, leased: 0 });
      });
    return {
      catalog: up.flatMap((h) => h.inventory!.catalog),
      capacity,
      devices: up.flatMap((h) => h.inventory!.devices),
      queueDepth: up.reduce((n, h) => n + h.inventory!.queueDepth, 0),
      notes: [
        ...hosts.filter((h) => !h.reachable).map((h) => `${h.target} (${h.endpoint}) is down: ${h.error}`),
        ...up.flatMap((h) => h.inventory!.notes.map((n) => `${h.target}: ${n}`)),
      ],
      hosts,
    };
  }

  async workers(): Promise<WorkerInfo[]> {
    const lists = await Promise.all(this.targets.map((t) => t.provider.workers().then((ws) => ws.map((w) => ({ ...w, host: w.host ?? t.name }))).catch(() => [] as WorkerInfo[])));
    return lists.flat();
  }

  // ---------------------------------------------------------------- leases

  /**
   * Leases from the first target (config order) that is up and serves the platform (and the model or
   * OS version asked for). `request.target` picks one by name. A host that does not answer is skipped
   * only for another host of the same platform; when none is left, the error names it and says which
   * targets are up. Another platform is never used instead.
   */
  async lease(sessionId: string, request: LeaseRequest, options?: CallOptions): Promise<LeaseHandle> {
    const { target: wanted, ...rest } = request;
    const pool = wanted ? [this.byName(wanted)] : this.targets;
    const candidates = pool.filter((t) => !t.platforms || t.platforms.includes(request.platform));
    if (candidates.length === 0) {
      const only = wanted ? this.byName(wanted) : undefined;
      throw new TapdanceError("DEVICE_UNAVAILABLE", only ? `Target ${only.name} is set to serve ${only.platforms!.join(", ")} only, not ${request.platform}` : `No connect target serves ${request.platform}`, {
        hint: `Connect a host that runs ${LABEL[request.platform]} devices: \`tapdance connect <endpoint> --platform ${request.platform}\` (see \`tapdance connect --list\`).`,
        retryable: false,
        details: { platform: request.platform, targets: this.targets.map((t) => ({ name: t.name, endpoint: t.endpoint, platforms: t.platforms ?? "any" })) },
      });
    }
    // One target and nothing to choose: its own lease path reports its own errors, as with one endpoint.
    if (this.targets.length === 1) return this.stamp(await candidates[0]!.provider.lease(sessionId, rest, options), candidates[0]!);

    const down: Array<{ target: RouteTarget; reason: string }> = [];
    const skipped: string[] = [];
    for (const target of candidates) {
      let inventory: DeviceInventory;
      try {
        inventory = await target.probe(TARGET_PROBE_MS);
      } catch (error) {
        down.push({ target, reason: reasonOf(error) });
        options?.onProgress?.(`${target.name} (${target.endpoint}) does not answer: ${reasonOf(error)}`);
        continue;
      }
      const entries = inventory.catalog.filter((c) => c.platform === request.platform && (c.models.length > 0 || c.osVersions.length > 0));
      if (entries.length === 0) {
        skipped.push(`${target.name} serves ${servedPlatforms(inventory).join(", ") || "nothing"}`);
        continue;
      }
      const why = entries.map((e) => mismatch(e, request)).find((m) => m !== undefined);
      if (why !== undefined && entries.every((e) => mismatch(e, request) !== undefined)) {
        skipped.push(`${target.name} ${why}`);
        continue;
      }
      if (down.length > 0) options?.onProgress?.(`Leasing ${request.platform} from ${target.name} instead`);
      else options?.onProgress?.(`Target ${target.name} (${target.endpoint}) serves ${request.platform}`);
      return this.stamp(await target.provider.lease(sessionId, rest, options), target);
    }

    if (down.length > 0) {
      const others = this.targets.filter((t) => !down.some((d) => d.target === t));
      const answers = await this.probeAll(others);
      const up = answers.filter((a) => a.inventory).map((a) => `${a.target.name} (${servedPlatforms(a.inventory!).join(", ") || "nothing to lease"})`);
      const first = down[0]!;
      throw new TapdanceError(
        "PROVIDER_UNREACHABLE",
        `Cannot lease ${request.platform}: target ${first.target.name} (${first.target.endpoint}) does not answer (${first.reason})${down.length > 1 ? `; nor does ${down.slice(1).map((d) => d.target.name).join(", ")}` : ""}`,
        {
          hint: `${up.length ? `Up: ${up.join(", ")}.` : "No other target answers either."} Retry when ${first.target.name} is back (\`tapdance host status\` on that host, \`tailscale status\` here); \`tapdance doctor\` shows every target.`,
          retryable: true,
          details: { platform: request.platform, target: first.target.name, endpoint: first.target.endpoint, down: down.map((d) => d.target.name), up: answers.filter((a) => a.inventory).map((a) => a.target.name), ...(skipped.length ? { skipped } : {}) },
        },
      );
    }
    throw new TapdanceError("DEVICE_UNAVAILABLE", `No connect target can lease ${request.platform}${request.device ? ` "${request.device}"` : ""}${request.osVersion ? ` ${request.osVersion}` : ""}: ${skipped.join("; ")}`, {
      hint: "`tapdance devices` lists what each target serves.",
      retryable: false,
      details: { platform: request.platform, skipped },
    });
  }

  private stamp(handle: LeaseHandle, target: RouteTarget): LeaseHandle {
    return { ...handle, location: { ...handle.location, target: target.name } };
  }

  status(handle: LeaseHandle) {
    return this.on(handle).status(handle);
  }
  renew(handle: LeaseHandle, ttlMs?: number) {
    return this.on(handle).renew(handle, ttlMs);
  }
  release(handle: LeaseHandle) {
    return this.on(handle).release(handle);
  }

  // ---------------------------------------------------------------- everything on a lease

  installApp(...args: Parameters<DeviceProvider["installApp"]>) {
    return this.on(args[0]).installApp(...args);
  }
  launchApp(...args: Parameters<DeviceProvider["launchApp"]>) {
    return this.on(args[0]).launchApp(...args);
  }
  stopApp(...args: Parameters<DeviceProvider["stopApp"]>) {
    return this.on(args[0]).stopApp(...args);
  }
  listApps(...args: Parameters<DeviceProvider["listApps"]>) {
    return this.on(args[0]).listApps(...args);
  }
  inspect(...args: Parameters<DeviceProvider["inspect"]>) {
    return this.on(args[0]).inspect(...args);
  }
  buildApp(...args: Parameters<NonNullable<DeviceProvider["buildApp"]>>) {
    const p = this.on(args[0]);
    if (!p.buildApp) throw new TapdanceError("NOT_SUPPORTED", `Target ${this.targetFor(args[0]).name} cannot build apps`);
    return p.buildApp(...args);
  }
  installFromCi(...args: Parameters<NonNullable<DeviceProvider["installFromCi"]>>) {
    const p = this.on(args[0]);
    if (!p.installFromCi) throw new TapdanceError("NOT_SUPPORTED", `Target ${this.targetFor(args[0]).name} cannot install apps from CI`);
    return p.installFromCi(...args);
  }
  tap(...args: Parameters<DeviceProvider["tap"]>) {
    return this.on(args[0]).tap(...args);
  }
  swipe(...args: Parameters<DeviceProvider["swipe"]>) {
    return this.on(args[0]).swipe(...args);
  }
  waitFor(...args: Parameters<DeviceProvider["waitFor"]>) {
    return this.on(args[0]).waitFor(...args);
  }
  alert(...args: Parameters<DeviceProvider["alert"]>) {
    return this.on(args[0]).alert(...args);
  }
  typeText(...args: Parameters<DeviceProvider["typeText"]>) {
    return this.on(args[0]).typeText(...args);
  }
  pressKey(...args: Parameters<DeviceProvider["pressKey"]>) {
    return this.on(args[0]).pressKey(...args);
  }
  screenshot(...args: Parameters<DeviceProvider["screenshot"]>) {
    return this.on(args[0]).screenshot(...args);
  }
  startRecording(...args: Parameters<DeviceProvider["startRecording"]>) {
    return this.on(args[0]).startRecording(...args);
  }
  stopRecording(...args: Parameters<DeviceProvider["stopRecording"]>) {
    return this.on(args[0]).stopRecording(...args);
  }
  logs(...args: Parameters<DeviceProvider["logs"]>) {
    return this.on(args[0]).logs(...args);
  }
  crashLogs(...args: Parameters<DeviceProvider["crashLogs"]>) {
    return this.on(args[0]).crashLogs(...args);
  }
  device(...args: Parameters<NonNullable<DeviceProvider["device"]>>) {
    const p = this.on(args[0]);
    if (!p.device) throw new TapdanceError("NOT_SUPPORTED", `Target ${this.targetFor(args[0]).name} has no device-level operations`);
    return p.device(...args);
  }
  viewer(...args: Parameters<NonNullable<DeviceProvider["viewer"]>>) {
    const p = this.on(args[0]);
    if (!p.viewer) throw new TapdanceError("NOT_SUPPORTED", `Target ${this.targetFor(args[0]).name} has no live viewer`);
    return p.viewer(...args);
  }

  async close(): Promise<void> {
    await Promise.all(this.targets.map((t) => t.provider.close().catch(() => undefined)));
  }
}

/** A host's inventory limited to the platforms its target is set to serve. */
function restrict(inventory: DeviceInventory, platforms: Platform[] | undefined): DeviceInventory {
  if (!platforms) return inventory;
  return {
    ...inventory,
    catalog: inventory.catalog.filter((c) => platforms.includes(c.platform)),
    capacity: inventory.capacity.filter((c) => platforms.includes(c.platform)),
    devices: inventory.devices.filter((d) => platforms.includes(d.platform)),
  };
}
