import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { sessionKey } from "./identity.js";
import type { ArtifactRef } from "./types.js";

/**
 * Where screenshots, recordings and logs go. The local store writes under one directory per session
 * with a manifest; a hosted provider can implement the same interface over S3 or R2.
 */
export interface ArtifactStore {
  /** A path to write a new artifact to. `requested` (from the user) wins when given. */
  allocate(sessionId: string, kind: ArtifactRef["kind"], extension: string, requested?: string): Promise<string>;
  record(entry: Omit<ArtifactRef, "id" | "bytes" | "createdAt"> & { bytes?: number }): Promise<ArtifactRef>;
  list(sessionId: string): Promise<ArtifactRef[]>;
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(readonly root: string) {}

  sessionDir(sessionId: string): string {
    const readable = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48);
    return join(this.root, `${readable}-${sessionKey(sessionId).slice(0, 8)}`);
  }

  async allocate(sessionId: string, kind: ArtifactRef["kind"], extension: string, requested?: string): Promise<string> {
    if (requested !== undefined) {
      const path = resolve(requested);
      await mkdir(resolve(path, ".."), { recursive: true });
      return path;
    }
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return join(dir, `${stamp}-${kind}-${randomBytes(2).toString("hex")}.${extension.replace(/^\./, "")}`);
  }

  private manifestPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "manifest.json");
  }

  async record(entry: Omit<ArtifactRef, "id" | "bytes" | "createdAt"> & { bytes?: number }): Promise<ArtifactRef> {
    const bytes = entry.bytes ?? (existsSync(entry.path) ? (await stat(entry.path)).size : 0);
    const ref: ArtifactRef = {
      ...entry,
      id: `art_${randomBytes(6).toString("hex")}`,
      bytes,
      createdAt: new Date().toISOString(),
    };
    const list = await this.list(entry.sessionId);
    list.push(ref);
    await mkdir(this.sessionDir(entry.sessionId), { recursive: true });
    await writeFile(this.manifestPath(entry.sessionId), `${JSON.stringify(list, null, 2)}\n`);
    return ref;
  }

  async list(sessionId: string): Promise<ArtifactRef[]> {
    const file = this.manifestPath(sessionId);
    if (!existsSync(file)) return [];
    try {
      const data: unknown = JSON.parse(await readFile(file, "utf8"));
      return Array.isArray(data) ? (data as ArtifactRef[]) : [];
    } catch {
      return [];
    }
  }

  static describe(ref: ArtifactRef): string {
    const kb = (ref.bytes / 1024).toFixed(ref.bytes < 10_240 ? 1 : 0);
    return `${ref.kind} ${basename(ref.path)} (${kb} KiB)`;
  }
}
