/**
 * Which Android system image a lease asks Simlock for (#112).
 *
 * Simlock treats "no image tag" as its own device kind: a lease without a tag is granted any untagged
 * device that exists, so on a host that first ran with the Play image and later got `google_apis`
 * too, an untagged lease keeps getting the old Play device. With a tag but no OS version, Simlock
 * takes the newest API level that has the tag, and with it a different default model (Pixel 9 /
 * API 35 instead of the host's Pixel 8 / API 34).
 *
 * So, for an Android emulator lease, Tapdance fills in from the host's catalog:
 * - no tag, and the host has both a Play image and a plain one where the lease would run: the
 *   plain one (`google_apis` first), so "leave the tag out for normal testing" holds;
 * - a tag (given or chosen above) but no OS version: the host's default API level, when an image
 *   with that tag is installed there. Simlock then picks the model it would for that level.
 * A host with one kind of image only, a request that names its OS, or an unreadable catalog keeps
 * the request as it was.
 */
import type { LeaseRequest } from "@tapdance/core";
import type { SimlockCatalog } from "./http.js";

type CatalogEntry = SimlockCatalog["platforms"][number];

export interface ImageChoice {
  /** The image tag to send; undefined keeps the request's (none). */
  imageTag?: string;
  /** The OS version to send; undefined keeps the request's. */
  osVersion?: string;
  /** What Tapdance chose and why, for the lease's progress line. */
  note?: string;
}

/** Whether an Android system image tag is a Google Play image. */
export function isPlayImageTag(tag: string): boolean {
  return /playstore/i.test(tag);
}

/** The images a catalog entry lists (Simlock 0.5 `images`), empty for older shapes. */
function catalogImages(entry: CatalogEntry | undefined): Array<{ runtime: string; tag: string }> {
  const images = entry?.images;
  if (!Array.isArray(images)) return [];
  return images.filter((i): i is { runtime: string; tag: string; abi?: string } => typeof i?.runtime === "string" && typeof i?.tag === "string");
}

export function chooseAndroidImage(request: Pick<LeaseRequest, "platform" | "physical" | "imageTag" | "osVersion" | "profile">, entry: CatalogEntry | undefined): ImageChoice {
  if (request.platform !== "android" || request.physical || request.profile) return {};
  const images = catalogImages(entry);
  if (images.length === 0) return {};
  const exactOs = request.osVersion !== undefined && /^\d+$/.test(request.osVersion) ? request.osVersion : undefined;
  const defaultOs = request.osVersion === undefined ? entry?.defaultRuntime : undefined;
  const where = exactOs ?? defaultOs;
  const notes: string[] = [];

  let imageTag = request.imageTag;
  if (imageTag === undefined) {
    const considered = where === undefined ? images : images.filter((i) => i.runtime === where);
    const tags = [...new Set(considered.map((i) => i.tag))];
    const play = tags.filter(isPlayImageTag);
    const plain = tags.filter((t) => !isPlayImageTag(t));
    if (play.length > 0 && plain.length > 0) {
      imageTag = plain.includes("google_apis") ? "google_apis" : plain[0]!;
      notes.push(`the ${imageTag} image (this host also has ${play.join(", ")}; ask for that image tag when the test needs the Play Store)`);
    }
  }

  let osVersion: string | undefined;
  if (imageTag !== undefined && request.osVersion === undefined && defaultOs !== undefined && images.some((i) => i.tag === imageTag && i.runtime === defaultOs)) {
    osVersion = defaultOs;
    notes.push(`API ${defaultOs}, the host's default`);
  }

  return {
    ...(imageTag !== request.imageTag && imageTag !== undefined ? { imageTag } : {}),
    ...(osVersion !== undefined ? { osVersion } : {}),
    ...(notes.length > 0 ? { note: `Using ${notes.join(", ")}` } : {}),
  };
}
