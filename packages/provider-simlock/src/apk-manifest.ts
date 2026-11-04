import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { readZipEntries } from "./ci-artifacts.js";

/**
 * Reads an APK's package name and version from its compiled AndroidManifest.xml, in TypeScript, so the
 * host can name the app it just installed (#89) without aapt2 or apkanalyzer. Bounded and defensive:
 * anything unexpected answers undefined, never an error.
 */

export interface ApkManifest {
  /** The application id, e.g. com.example.app. */
  appId: string;
  versionCode?: number;
  versionName?: string;
}

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/** android:versionCode and android:versionName, for manifests whose attribute names were stripped. */
const VERSION_CODE_ID = 0x0101021b;
const VERSION_NAME_ID = 0x0101021c;
const APP_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

export async function readApkManifest(apkPath: string): Promise<ApkManifest | undefined> {
  try {
    const entries = await readZipEntries(apkPath, 100_000);
    const entry = entries.find((e) => e.name === "AndroidManifest.xml");
    if (!entry || (entry.method !== 0 && entry.method !== 8) || entry.size > MAX_MANIFEST_BYTES || entry.compressedSize > MAX_MANIFEST_BYTES) return undefined;
    const fh = await open(apkPath, "r");
    let data: Buffer;
    try {
      const local = Buffer.alloc(30);
      await fh.read(local, 0, 30, entry.localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50) return undefined;
      const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = Buffer.alloc(entry.compressedSize);
      await fh.read(raw, 0, entry.compressedSize, start);
      data = entry.method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_MANIFEST_BYTES }) : raw;
    } finally {
      await fh.close();
    }
    return parseBinaryManifest(data);
  } catch {
    return undefined;
  }
}

/** The <manifest> element's package, versionCode and versionName from Android's binary XML. */
export function parseBinaryManifest(buf: Buffer): ApkManifest | undefined {
  if (buf.length < 8 || buf.readUInt16LE(0) !== 0x0003) return undefined;
  let strings: string[] = [];
  let resourceIds: number[] = [];
  let p = buf.readUInt16LE(2);
  for (let chunks = 0; p + 8 <= buf.length && chunks < 100_000; chunks++) {
    const type = buf.readUInt16LE(p);
    const headerSize = buf.readUInt16LE(p + 2);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8 || p + size > buf.length) return undefined;
    if (type === 0x0001) strings = readStringPool(buf, p, headerSize, size);
    else if (type === 0x0180) resourceIds = Array.from({ length: Math.floor((size - headerSize) / 4) }, (_, i) => buf.readUInt32LE(p + headerSize + i * 4));
    else if (type === 0x0102) {
      // RES_XML_START_ELEMENT: the first one is <manifest>.
      const ext = p + headerSize;
      if (ext + 20 > p + size) return undefined;
      if (strings[buf.readUInt32LE(ext + 4)] !== "manifest") return undefined;
      const attrStart = buf.readUInt16LE(ext + 8);
      const attrSize = buf.readUInt16LE(ext + 10);
      const attrCount = buf.readUInt16LE(ext + 12);
      let appId: string | undefined;
      let versionCode: number | undefined;
      let versionName: string | undefined;
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        if (a + 20 > p + size) break;
        const nameIndex = buf.readUInt32LE(a + 4);
        const name = strings[nameIndex] ?? "";
        const resId = resourceIds[nameIndex];
        const rawIndex = buf.readUInt32LE(a + 8);
        const dataType = buf.readUInt8(a + 15);
        const value = buf.readUInt32LE(a + 16);
        const text = rawIndex !== 0xffffffff ? strings[rawIndex] : dataType === 0x03 ? strings[value] : undefined;
        if (name === "package") appId = text;
        else if (name === "versionCode" || resId === VERSION_CODE_ID) {
          if (dataType === 0x10 || dataType === 0x11) versionCode = value;
          else if (text && /^\d+$/.test(text)) versionCode = Number(text);
        } else if (name === "versionName" || resId === VERSION_NAME_ID) versionName = text;
      }
      if (!appId || !APP_ID.test(appId) || appId.length > 255) return undefined;
      return { appId, ...(versionCode !== undefined ? { versionCode } : {}), ...(versionName ? { versionName: versionName.slice(0, 100) } : {}) };
    }
    p += size;
  }
  return undefined;
}

function readStringPool(buf: Buffer, chunk: number, headerSize: number, size: number): string[] {
  const count = buf.readUInt32LE(chunk + 8);
  const utf8 = (buf.readUInt32LE(chunk + 16) & (1 << 8)) !== 0;
  const stringsStart = chunk + buf.readUInt32LE(chunk + 20);
  const end = chunk + size;
  const out: string[] = [];
  for (let i = 0; i < Math.min(count, 200_000); i++) {
    const offsetAt = chunk + headerSize + i * 4;
    if (offsetAt + 4 > end) break;
    let q = stringsStart + buf.readUInt32LE(offsetAt);
    if (q >= end) {
      out.push("");
      continue;
    }
    if (utf8) {
      // UTF-16 length, then UTF-8 byte length, each one or two bytes.
      q += buf[q]! & 0x80 ? 2 : 1;
      let len = buf[q]!;
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | buf[q + 1]!;
        q += 2;
      } else q += 1;
      out.push(q + len <= end ? buf.toString("utf8", q, q + len) : "");
    } else {
      let len = buf.readUInt16LE(q);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(q + 2);
        q += 4;
      } else q += 2;
      out.push(q + len * 2 <= end ? buf.toString("utf16le", q, q + len * 2) : "");
    }
  }
  return out;
}
