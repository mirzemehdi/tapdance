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
 * Adds `endpoint` as a connect target, or updates an existing one: the target with the same origin
 * (its address, and its name and platforms when given), or else the target called `name`, which then
 * moves to the new address (`replaced` is its old endpoint, whose token the caller drops). Returns the
 * new user config (with `targets`, without the old single `endpoint`) and the target.
 */
export function upsertTarget(
  config: UserConfig,
  add: { endpoint: string; name?: string; platforms?: Platform[] },
): { config: UserConfig; target: TargetConfig; added: boolean; replaced?: string; migrated?: string } {
  if (add.name !== undefined && !TARGET_NAME.test(add.name)) {
    throw new TapdanceError("USAGE", `"${add.name}" is not a valid target name`, { hint: "Use lower-case letters, digits and dashes (at most 32), e.g. --name mac-mini." });
  }
  const { targets, migrated } = currentTargets(config);
  const origin = urlOrigin(add.endpoint);
  const byOrigin = targets.findIndex((t) => urlOrigin(t.endpoint) === origin);
  const byName = add.name === undefined ? -1 : targets.findIndex((t) => t.name === add.name);
  if (byOrigin >= 0 && byName >= 0 && byOrigin !== byName) {
    throw new TapdanceError("USAGE", `${add.endpoint} is already target ${targets[byOrigin]!.name}, and another target is called "${add.name}"`, {
      hint: `Pick another --name, or remove one first with \`tapdance disconnect ${add.name}\` or \`tapdance disconnect ${targets[byOrigin]!.name}\`.`,
    });
  }
  // Same origin: update that target. Otherwise an existing name moves that target to the new address.
  const index = byOrigin >= 0 ? byOrigin : byName;
  const others = targets.filter((_, i) => i !== index).map((t) => t.name);
  const before = index >= 0 ? targets[index]! : undefined;
  const replaced = before && urlOrigin(before.endpoint) !== origin ? before.endpoint : undefined;
  const target: TargetConfig = {
    name: add.name ?? before?.name ?? targetNameFor(add.endpoint, others),
    endpoint: add.endpoint,
    ...(() => {
      const platforms = add.platforms !== undefined ? add.platforms : before?.platforms;
      return platforms && platforms.length > 0 ? { platforms } : {};
    })(),
  };
  if (index >= 0) targets[index] = target;
  else targets.push(target);
  const { endpoint: _endpoint, ...rest } = config;
  return { config: { ...rest, provider: "self-hosted", targets }, target, added: index < 0, ...(replaced ? { replaced } : {}), ...(migrated ? { migrated } : {}) };
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
/** `--platform` values; `any` alone gives [], which clears a target's earlier limit (review). */
export function parsePlatforms(values: string[] | undefined): Platform[] | undefined {
  if (!values || values.length === 0) return undefined;
  const all = values.flatMap((v) => v.split(",")).map((v) => v.trim().toLowerCase());
  if (all.length === 1 && all[0] === "any") return [];
  const out = new Set<Platform>();
  for (const value of all) {
    const p = value;
    if (p !== "android" && p !== "ios") throw new TapdanceError("USAGE", `--platform must be android, ios or any, got "${value}"`);
    out.add(p);
  }
  return [...out];
}
