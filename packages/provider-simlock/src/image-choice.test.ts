import { describe, expect, it } from "vitest";
import { chooseAndroidImage, isPlayImageTag } from "./image-choice.js";

/** A fake Simlock catalog entry (no host involved). */
const entry = (images: Array<[string, string]>, defaultRuntime = "34") => ({
  platform: "android",
  defaultRuntime,
  images: images.map(([runtime, tag]) => ({ runtime, tag, abi: "x86_64" })),
});
const android = { platform: "android" as const };

describe("chooseAndroidImage (#112; fake catalog)", () => {
  it("prefers the plain image when the host has both kinds, at the default API level", () => {
    expect(chooseAndroidImage(android, entry([["34", "google_apis_playstore"], ["34", "google_apis"]]))).toEqual({
      imageTag: "google_apis",
      osVersion: "34",
      note: expect.stringMatching(/^Using the google_apis image \(this host also has google_apis_playstore; .*\), API 34, the host's default$/),
    });
    // Another plain tag when google_apis is missing.
    expect(chooseAndroidImage(android, entry([["34", "google_apis_playstore"], ["34", "default"]])).imageTag).toBe("default");
  });

  it("keeps an explicit tag and fills in the default API level only when that tag is installed there", () => {
    expect(chooseAndroidImage({ ...android, imageTag: "google_apis" }, entry([["34", "google_apis"], ["35", "google_apis"]]))).toEqual({ osVersion: "34", note: "Using API 34, the host's default" });
    expect(chooseAndroidImage({ ...android, imageTag: "google_apis" }, entry([["34", "google_apis_playstore"], ["35", "google_apis"]]))).toEqual({});
  });

  it("changes nothing for one kind of image, a named OS range, iOS, a physical device, a profile or no catalog", () => {
    expect(chooseAndroidImage(android, entry([["34", "google_apis"], ["35", "google_apis"]]))).toEqual({});
    expect(chooseAndroidImage(android, entry([["34", "google_apis_playstore"]]))).toEqual({});
    expect(chooseAndroidImage({ ...android, osVersion: ">=34" }, entry([["34", "google_apis_playstore"], ["34", "google_apis"]]))).toMatchObject({ imageTag: "google_apis" });
    expect(chooseAndroidImage({ ...android, osVersion: ">=34" }, entry([["34", "google_apis_playstore"], ["34", "google_apis"]])).osVersion).toBeUndefined();
    expect(chooseAndroidImage({ platform: "ios" }, entry([["34", "google_apis_playstore"], ["34", "google_apis"]]))).toEqual({});
    expect(chooseAndroidImage({ ...android, physical: true }, entry([["34", "google_apis_playstore"], ["34", "google_apis"]]))).toEqual({});
    expect(chooseAndroidImage({ ...android, profile: "p" }, entry([["34", "google_apis_playstore"], ["34", "google_apis"]]))).toEqual({});
    expect(chooseAndroidImage(android, undefined)).toEqual({});
    expect(chooseAndroidImage(android, { platform: "android" })).toEqual({});
  });

  it("knows a Play image tag", () => {
    expect(isPlayImageTag("google_apis_playstore")).toBe(true);
    expect(isPlayImageTag("google_apis")).toBe(false);
  });
});
