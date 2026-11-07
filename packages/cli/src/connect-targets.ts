import { TARGET_NAME, TapdanceError, targetNameFor, urlOrigin, type Platform, type TapdanceConfig, type TargetConfig } from "@tapdance/sdk";

type UserConfig = Partial<TapdanceConfig>;

/**
 * The user config's connect targets, turning an older single `endpoint` into the first target so a
 * second `connect` adds a host instead of replacing the first one. `migrated` is that endpoint.
 */
export function currentTargets(config: UserConfig): { targets: TargetConfig[]; migrated?: string } {
  if (config.targets && config.targets.length > 0) return { targets: [...config.targets] };
  if (config.endpoint && config.provider === "self-hosted") return { targets: [{ name: targetNameFor(config.endpoint), endpoint: config.endpoint }], migrated: config.endpoint };
  return { targets: [] };
}

/**
 * Adds `endpoint` as a connect target, or updates the target with the same origin (its address, and
 * its name and platforms when given). Returns the new user config (with `targets`, without the old
 * single `endpoint`) and the target.
 */
export function upsertTarget(
  config: UserConfig,
  add: { endpoint: string; name?: string; platforms?: Platform[] },
): { config: UserConfig; target: TargetConfig; added: boolean; migrated?: string } {
  if (add.name !== undefined && !TARGET_NAME.test(add.name)) {
    throw new TapdanceError("USAGE", `"${add.name}" is not a valid target name`, { hint: "Use lower-case letters, digits and dashes (at most 32), e.g. --name mac-mini." });
  }
  const { targets, migrated } = currentTargets(config);
  const origin = urlOrigin(add.endpoint);
  const index = targets.findIndex((t) => urlOrigin(t.endpoint) === origin);
  const others = targets.filter((_, i) => i !== index).map((t) => t.name);
  if (add.name !== undefined && others.includes(add.name)) {
    throw new TapdanceError("USAGE", `Another target is already called "${add.name}"`, { hint: "Pick another --name, or remove that one first with `tapdance disconnect <name>`." });
  }
  const before = index >= 0 ? targets[index]! : undefined;
  const target: TargetConfig = {
    name: add.name ?? before?.name ?? targetNameFor(add.endpoint, others),
    endpoint: add.endpoint,
    ...((add.platforms ?? before?.platforms) ? { platforms: add.platforms ?? before!.platforms! } : {}),
  };
  if (index >= 0) targets[index] = target;
  else targets.push(target);
  const { endpoint: _endpoint, ...rest } = config;
  return { config: { ...rest, provider: "self-hosted", targets }, target, added: index < 0, ...(migrated ? { migrated } : {}) };
}

/** Removes a target by name or endpoint; returns the new user config and the removed target. */
export function removeTarget(config: UserConfig, which: string): { config: UserConfig; removed: TargetConfig; migrated?: string } {
  const { targets, migrated } = currentTargets(config);
  const origin = urlOrigin(which);
  const index = targets.findIndex((t) => t.name === which || (origin !== undefined && urlOrigin(t.endpoint) === origin));
  if (index < 0) {
    throw new TapdanceError("USAGE", `No connect target "${which}"`, {
      hint: targets.length ? `Targets: ${targets.map((t) => t.name).join(", ")} (\`tapdance connect --list\`).` : "No targets are configured; add one with `tapdance connect <endpoint>`.",
    });
  }
  const removed = targets.splice(index, 1)[0]!;
  const { endpoint: _endpoint, targets: _targets, ...rest } = config;
  return { config: { ...rest, ...(targets.length > 0 ? { targets } : {}) }, removed, ...(migrated ? { migrated } : {}) };
}

/** `--platform android --platform ios` or `--platform android,ios`. */
export function parsePlatforms(values: string[] | undefined): Platform[] | undefined {
  if (!values || values.length === 0) return undefined;
  const out = new Set<Platform>();
  for (const value of values.flatMap((v) => v.split(","))) {
    const p = value.trim().toLowerCase();
    if (p !== "android" && p !== "ios") throw new TapdanceError("USAGE", `--platform must be android or ios, got "${value}"`);
    out.add(p);
  }
  return [...out];
}
