import { describe, expect, it } from "vitest";
import { normalizeRepo } from "@tapdance/provider-simlock";
import { deployKeyState, describeDeployKeyState, removeFromAllowList } from "./builds.js";

describe("host builds: allow-list removal and the deploy key column (#87)", () => {
  const SSH = "git" + "@github.com:KAppMakerDeveloperApps/Pianolune-All.git";
  const HTTPS = "https://github.com/KAppMakerDeveloperApps/Pianolune-All";
  const key = (r: string) => normalizeRepo(r).toLowerCase();

  it("removes exactly the URL named, whatever its case or trailing .git, and keeps the other form", () => {
    expect(removeFromAllowList([SSH, HTTPS], ["git@github.com:kappmakerdeveloperapps/pianolune-all"], key, "build allow-list")).toEqual({ kept: [HTTPS], removed: [SSH] });
    expect(removeFromAllowList([SSH, HTTPS], [`${HTTPS}.git/`], key, "build allow-list")).toEqual({ kept: [SSH], removed: [HTTPS] });
    expect(() => removeFromAllowList([SSH], ["https://github.com/acme/other"], key, "build allow-list")).toThrow(/not on the build allow-list/);
    try {
      removeFromAllowList([SSH], [HTTPS], key, "build allow-list");
    } catch (error) {
      expect((error as { code: string; hint: string }).code).toBe("USAGE");
      expect((error as { hint: string }).hint).toContain(SSH);
    }
  });

  it("says an https URL does not use the repository's ssh key", () => {
    expect(deployKeyState({ ssh: true, ownKey: true, sharedKey: false, gitAuth: "gh" })).toBe("own");
    expect(deployKeyState({ ssh: false, ownKey: true, sharedKey: false, gitAuth: "gh" })).toBe("unused-https");
    expect(deployKeyState({ ssh: true, ownKey: false, sharedKey: true, gitAuth: "deploy-key" })).toBe("shared");
    expect(deployKeyState({ ssh: true, ownKey: false, sharedKey: true, gitAuth: "gh" })).toBe("none");
    expect(deployKeyState({ ssh: false, ownKey: false, sharedKey: false, gitAuth: "none" })).toBe("none");
    expect(describeDeployKeyState("unused-https")).toBe("not used (https)");
  });
});

describe("gh on the host (#77)", () => {
  it("is needed for gh-auth builds and for installs from CI, and not otherwise", async () => {
    const { ghNeededFor } = await import("./builds.js");
    expect(ghNeededFor({})).toBeUndefined();
    expect(ghNeededFor({ allow: { builds: true }, builds: { gitAuth: "deploy-key", repos: ["git@github.com:a/b.git"] } })).toBeUndefined();
    expect(ghNeededFor({ allow: { builds: true }, builds: { gitAuth: "gh", repos: ["https://github.com/a/b"] } })).toBe("builds with --git-auth gh");
    expect(ghNeededFor({ allow: { builds: false, artifacts: true }, builds: { gitAuth: "gh", repos: ["x"] }, artifacts: { repos: ["a/b"] } })).toBe("installs from CI");
    expect(ghNeededFor({ allow: { builds: true, artifacts: true }, builds: { gitAuth: "gh", repos: ["x"] }, artifacts: { repos: ["a/b"] } })).toBe("builds with --git-auth gh and installs from CI");
    expect(ghNeededFor({ allow: { artifacts: true }, artifacts: { repos: [] } })).toBeUndefined();
  });
});
