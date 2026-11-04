import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseBinaryManifest, readApkManifest } from "./apk-manifest.js";

/**
 * A compiled AndroidManifest.xml as aapt2 writes it (Android's binary XML): a UTF-16 string pool, the
 * resource-id map and a <manifest> start element. `strip` blanks the version attribute names, as some
 * shrinkers do, so only the resource-id map names them.
 */
function binaryManifest(opts: { appId: string; versionCode?: number; versionName?: string; strip?: boolean; utf8?: boolean }): Buffer {
  const strings = [opts.strip ? "" : "versionCode", opts.strip ? "" : "versionName", "package", "manifest", opts.appId, opts.versionName ?? "1.0"];
  const encoded = strings.map((s) => {
    if (opts.utf8) {
      const bytes = Buffer.from(s, "utf8");
      return Buffer.concat([Buffer.from([s.length, bytes.length]), bytes, Buffer.from([0])]);
    }
    const len = Buffer.alloc(2);
    len.writeUInt16LE(s.length);
    return Buffer.concat([len, Buffer.from(s, "utf16le"), Buffer.alloc(2)]);
  });
  const offsets = Buffer.alloc(strings.length * 4);
  let at = 0;
  encoded.forEach((e, i) => {
    offsets.writeUInt32LE(at, i * 4);
    at += e.length;
  });
  let data = Buffer.concat(encoded);
  if (data.length % 4) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  const poolHeader = Buffer.alloc(28);
  poolHeader.writeUInt16LE(0x0001, 0);
  poolHeader.writeUInt16LE(28, 2);
  poolHeader.writeUInt32LE(28 + offsets.length + data.length, 4);
  poolHeader.writeUInt32LE(strings.length, 8);
  poolHeader.writeUInt32LE(opts.utf8 ? 1 << 8 : 0, 16);
  poolHeader.writeUInt32LE(28 + offsets.length, 20);
  const pool = Buffer.concat([poolHeader, offsets, data]);

  const resMap = Buffer.alloc(16);
  resMap.writeUInt16LE(0x0180, 0);
  resMap.writeUInt16LE(8, 2);
  resMap.writeUInt32LE(16, 4);
  resMap.writeUInt32LE(0x0101021b, 8);
  resMap.writeUInt32LE(0x0101021c, 12);

  const attr = (name: number, raw: number, type: number, value: number) => {
    const a = Buffer.alloc(20);
    a.writeUInt32LE(0xffffffff, 0);
    a.writeUInt32LE(name, 4);
    a.writeUInt32LE(raw, 8);
    a.writeUInt16LE(8, 12);
    a.writeUInt8(type, 15);
    a.writeUInt32LE(value, 16);
    return a;
  };
  const attrs = [attr(0, 0xffffffff, 0x10, opts.versionCode ?? 1), attr(1, 5, 0x03, 5), attr(2, 4, 0x03, 4)];
  const element = Buffer.alloc(36);
  element.writeUInt16LE(0x0102, 0);
  element.writeUInt16LE(16, 2);
  element.writeUInt32LE(36 + attrs.length * 20, 4);
  element.writeUInt32LE(0xffffffff, 12);
  element.writeUInt32LE(0xffffffff, 16);
  element.writeUInt32LE(3, 20);
  element.writeUInt16LE(20, 24);
  element.writeUInt16LE(20, 26);
  element.writeUInt16LE(attrs.length, 28);
  const body = Buffer.concat([pool, resMap, element, ...attrs]);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

/** A zip (an APK is one) with stored or deflated entries. */
function zipOf(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const stored = e.deflate ? deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(e.deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(stored.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    parts.push(local, name, stored);
    central.push(c, name);
    offset += 30 + name.length + stored.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

describe("reading an APK's package without Android tools (#89)", () => {
  it("parses the package, versionCode and versionName of a binary manifest (UTF-16 and UTF-8 pools)", () => {
    expect(parseBinaryManifest(binaryManifest({ appId: "com.measify.pianolune", versionCode: 3, versionName: "1.2.0" }))).toEqual({ appId: "com.measify.pianolune", versionCode: 3, versionName: "1.2.0" });
    expect(parseBinaryManifest(binaryManifest({ appId: "com.example.app", versionCode: 42, utf8: true }))).toMatchObject({ appId: "com.example.app", versionCode: 42 });
    // Attribute names stripped by a shrinker: the resource-id map still names versionCode.
    expect(parseBinaryManifest(binaryManifest({ appId: "com.example.app", versionCode: 7, strip: true }))).toMatchObject({ appId: "com.example.app", versionCode: 7 });
  });

  it("answers undefined, never throws, for anything else", () => {
    for (const bad of [Buffer.alloc(0), Buffer.from("<manifest package='x'/>"), binaryManifest({ appId: "not a package" }), binaryManifest({ appId: "com.x" }).subarray(0, 60)]) {
      expect(parseBinaryManifest(bad)).toBeUndefined();
    }
  });

  it("reads an APK that Android's own aapt2 linked", async () => {
    // `aapt2 link` (build-tools 36.0.0, android-36) of a manifest with package com.measify.pianolune,
    // versionCode 3 and versionName 1.2.0, and nothing else: 687 bytes.
    const real =
      "UEsDBAAAAAAIAAAAIQAPahMmlgEAAMwDAAATAAAAQW5kcm9pZE1hbmlmZXN0LnhtbJVSu07DQBCci3FiEghGAglESgpE4QAFQpShR0hIVBSYmJAoL8s2SOko+QYKvoCCgi+gRlR8B78Ac8vFcYwiwVnju53b2d3bOwsO3ixAoYaLAuBiMs4z6yqxRTSINvFIPBEvxCvxQXwSNQUkxD3xQLwTNnrwcYkrzkAFt1xFiNHBEAMc8R+Q+b1zTFVfdpbRJNNHyJ0emVMqujib8gbW/+A1zjZIY9vYhYc9YodWgda+sCdU+PQb0irJKmCcIdlAavWZJ2SeDrP6SNIqVk0VnsT3JXMLI9phGrGHG846+za7mfALcYg6v5jqNnf6ovRyeT0Tuy7Zu5wj+sZiT9fnSISB5NYeiZwiJNekzse1ZF+TE+jqW1RG1DRYme5eMKNv/9FM7g+4Uw5fmH5nSm0UlKoRka1UTEC5jKp7D3xxONJf2uSfM7weC1yv8CuZd1mRmKnOtcZauUPdB1i24ayM36bh5oii8Sua/UXOZcOVDVfNafV6KcO5pt6DTB495k29KlMv5C5+4uvZMufP66xcX8bnVzP69Q1QSwMEAAAAAAAAAAAhAAtQNhMoAAAAKAAAAA4AAQByZXNvdXJjZXMuYXJzYwACAAwAKAAAAAAAAAABABwAHAAAAAAAAAAAAAAAAAEAABwAAAAAAAAAUEsBAgAAAAAAAAgAAAAhAA9qEyaWAQAAzAMAABMAAAAAAAAAAAAAAAAAAAAAAEFuZHJvaWRNYW5pZmVzdC54bWxQSwECAAAAAAAAAAAAACEAC1A2EygAAAAoAAAADgAAAAAAAAAAAAAAAADHAQAAcmVzb3VyY2VzLmFyc2NQSwUGAAAAAAIAAgB9AAAAHAIAAAAA";
    const dir = await mkdtemp(join(tmpdir(), "td-apk-"));
    const apk = join(dir, "aapt2.apk");
    await writeFile(apk, Buffer.from(real, "base64"));
    expect(await readApkManifest(apk)).toEqual({ appId: "com.measify.pianolune", versionCode: 3, versionName: "1.2.0" });
  });

  it("reads AndroidManifest.xml out of an APK, stored or deflated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "td-apk-"));
    const manifest = binaryManifest({ appId: "com.measify.pianolune", versionCode: 3 });
    for (const deflate of [false, true]) {
      const apk = join(dir, `app-${deflate}.apk`);
      await writeFile(apk, zipOf([{ name: "classes.dex", data: Buffer.from("dex") }, { name: "AndroidManifest.xml", data: manifest, deflate }]));
      expect(await readApkManifest(apk)).toEqual({ appId: "com.measify.pianolune", versionCode: 3, versionName: "1.0" });
    }
    const noManifest = join(dir, "none.apk");
    await writeFile(noManifest, zipOf([{ name: "classes.dex", data: Buffer.from("dex") }]));
    expect(await readApkManifest(noManifest)).toBeUndefined();
    const notZip = join(dir, "text.apk");
    await writeFile(notZip, "APK");
    expect(await readApkManifest(notZip)).toBeUndefined();
    expect(await readApkManifest(join(dir, "missing.apk"))).toBeUndefined();
  });
});
