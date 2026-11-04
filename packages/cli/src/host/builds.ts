import { TapdanceError } from "@tapdance/sdk";

/**
 * Pure helpers for `host builds` and `host artifacts` (#87): removing entries from an allow-list and
 * describing a repository's deploy key. Kept apart from the commands so tests need no guard service.
 */

/**
 * Removes `remove` from `list`, comparing with `key` (two URLs that differ only in case or a trailing
 * .git are one entry). Throws USAGE naming the allowed entries when one of `remove` is not listed.
 */
export function removeFromAllowList(list: string[], remove: string[], key: (entry: string) => string, what: string): { kept: string[]; removed: string[] } {
  const keys = new Set(remove.map(key));
  const missing = remove.filter((r) => !list.some((entry) => key(entry) === key(r)));
  if (missing.length > 0) {
    throw new TapdanceError("USAGE", `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not on the ${what}`, {
      hint: list.length > 0 ? `It holds: ${list.join(", ")}. Give one exactly as listed (the ssh and https URLs of a repository are separate entries).` : "It is empty.",
    });
  }
  return { kept: list.filter((entry) => !keys.has(key(entry))), removed: list.filter((entry) => keys.has(key(entry))) };
}

/** What `host builds status` says about a repository's deploy key (#87): an https URL never uses one. */
export function deployKeyState(opts: { ssh: boolean; ownKey: boolean; sharedKey: boolean; gitAuth: string }): "own" | "shared" | "unused-https" | "none" {
  const key = opts.ownKey ? "own" : opts.sharedKey && opts.gitAuth === "deploy-key" ? "shared" : "none";
  if (key !== "none" && !opts.ssh) return "unused-https";
  return key;
}

export function describeDeployKeyState(state: ReturnType<typeof deployKeyState>): string {
  return state === "own" ? "its own" : state === "shared" ? "the shared deploy_key" : state === "unused-https" ? "not used (https)" : "-";
}

/**
 * Why this host needs a logged-in `gh`, from the owner's policy: builds that fetch with
 * `--git-auth gh`, or installs from CI artifacts (always through `gh`). Undefined when nothing needs it (#77).
 */
export function ghNeededFor(policy: { allow?: { builds?: boolean; artifacts?: boolean }; builds?: { gitAuth?: string; repos?: string[] }; artifacts?: { repos?: string[] } }): string | undefined {
  const uses: string[] = [];
  if (policy.allow?.builds && policy.builds?.gitAuth === "gh" && (policy.builds.repos?.length ?? 0) > 0) uses.push("builds with --git-auth gh");
  if (policy.allow?.artifacts && (policy.artifacts?.repos?.length ?? 0) > 0) uses.push("installs from CI");
  return uses.length ? uses.join(" and ") : undefined;
}

/** The owner's fix when `gh` is missing or not logged in. */
export const GH_FIX = "install it (scripts/host-setup.sh --with-gh, or your package manager), then `gh auth login --with-token` with a fine-grained read-only token (Contents and Actions: read) for the allowed repositories";
