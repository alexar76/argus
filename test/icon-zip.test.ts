import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_ICON_ZIP_BYTES, validateIconZip } from "../src/checkout/zip.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function fixtureCrc(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface File {
  name?: string;
  data?: Buffer;
  deflate?: boolean;
  descriptor?: "plain" | "signature";
  mode?: number;
  declaredSize?: number;
  rawTail?: Buffer;
}

function fixture(files: File[] = [{}], comment = Buffer.alloc(0)) {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name ?? "icons/wallet.png");
    const data = file.data ?? png;
    const size = file.declaredSize ?? data.length;
    const raw = file.deflate ? deflateRawSync(data) : data;
    const compressed = file.rawTail ? Buffer.concat([raw, file.rawTail]) : raw;
    const crc = fixtureCrc(data);
    const flags = 0x800 | (file.descriptor ? 8 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(file.deflate ? 8 : 0, 8);
    if (!file.descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(file.descriptor === "signature" ? 16 : file.descriptor ? 12 : 0);
    if (file.descriptor) {
      const shift = file.descriptor === "signature" ? 4 : 0;
      if (shift) descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, shift);
      descriptor.writeUInt32LE(compressed.length, shift + 4);
      descriptor.writeUInt32LE(size, shift + 8);
    }
    locals.push(local, name, compressed, descriptor);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(file.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(file.mode ?? (name.toString().endsWith("/") ? 0x41ed : 0x81a4), 40);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + compressed.length + descriptor.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return { zip: Buffer.concat([...locals, central, end, comment]), directory: offset };
}

describe("icon archive verification", () => {
  it("accepts stored and deflated PNGs, notes, and an archive comment", () => {
    const { zip } = fixture([{ name: "icons/", data: Buffer.alloc(0) }, {}, { name: "icons/é.png", deflate: true },
      { name: "Readme.txt", data: Buffer.from("Icons") }], Buffer.from("License enclosed"));
    const backing = Buffer.concat([Buffer.from("padding"), zip]);
    expect(() => validateIconZip(backing.subarray(7))).not.toThrow();
  });

  it.each(["plain", "signature"] as const)("accepts a %s data descriptor", (descriptor) => {
    expect(() => validateIconZip(fixture([{ deflate: true, descriptor }]).zip)).not.toThrow();
  });

  it("requires a real PNG alongside any AppleDouble files", () => {
    const metadata = { name: "__MACOSX/icons/._wallet.png", data: Buffer.from("metadata") };
    expect(() => validateIconZip(fixture([{}, metadata]).zip)).not.toThrow();
    expect(() => validateIconZip(fixture([metadata]).zip)).toThrow();
  });

  it("rejects archives with no valid PNG or a malformed PNG entry", () => {
    const damaged = Buffer.from(png);
    damaged[45] = damaged[45]! ^ 1;
    for (const files of [[{ name: "readme.txt", data: Buffer.from("Icons") }], [{ data: Buffer.from("PNG") }],
      [{ data: damaged }], [{ data: png.subarray(0, -1) }], [{}, { name: "icons/bad.png", data: damaged }]]) {
      expect(() => validateIconZip(fixture(files).zip)).toThrow();
    }
  });

  it.each(["../wallet.png", "icons/../wallet.png", "/wallet.png", "C:/wallet.png", "icons\\wallet.png",
    "icons/CON.png", "icons/.././wallet.png", "icons/．．/wallet.png"])("rejects unsafe archive name %s", (name) => {
    expect(() => validateIconZip(fixture([{ name }]).zip)).toThrow();
  });

  it("rejects symlinks, case-insensitive duplicates, and file/directory collisions", () => {
    for (const files of [[{ mode: 0xa1ff }], [{}, { name: "ICONS/WALLET.PNG" }], [{}, { name: "icons" }]]) {
      expect(() => validateIconZip(fixture(files).zip)).toThrow();
    }
  });

  it("rejects corrupted entry bytes, contradictory headers, truncated archives, and encryption", () => {
    const { zip, directory } = fixture();
    const corrupt = Buffer.from(zip);
    corrupt[45] = corrupt[45]! ^ 1;
    const contradiction = Buffer.from(zip);
    contradiction.writeUInt32LE(0, directory + 16);
    const encrypted = Buffer.from(zip);
    encrypted.writeUInt16LE(0x801, directory + 8);
    const wrongPath = Buffer.from(zip);
    wrongPath[30] = 0x7a;
    for (const broken of [corrupt, contradiction, zip.subarray(0, -1), encrypted, wrongPath]) {
      expect(() => validateIconZip(broken)).toThrow();
    }
  });

  it("rejects oversized, understated, and padded deflate entries", () => {
    expect(() => validateIconZip(Buffer.alloc(MAX_ICON_ZIP_BYTES + 1))).toThrow();
    expect(() => validateIconZip(fixture([{ deflate: true, data: Buffer.alloc(4 * 1024 * 1024 + 1) }]).zip)).toThrow();
    expect(() => validateIconZip(fixture([{ deflate: true, data: Buffer.alloc(8192), declaredSize: 8 }]).zip)).toThrow();
    expect(() => validateIconZip(fixture([{ deflate: true, rawTail: Buffer.from("trailing") }]).zip)).toThrow();
  });

  it("enforces total expanded size and entry count before unpacking", () => {
    const data = Buffer.alloc(4 * 1024 * 1024);
    expect(() => validateIconZip(fixture([{}, ...Array.from({ length: 4 }, (_, i) => ({ name: `${i}.txt`, data,
      deflate: true }))]).zip)).toThrow();
    expect(() => validateIconZip(fixture(Array.from({ length: 129 }, (_, i) => ({ name: `${i}.png` }))).zip)).toThrow();
  });
});
