import { inflateRawSync } from "node:zlib";

export const MAX_ICON_ZIP_BYTES = 2 * 1024 * 1024;

const MAX_FILES = 128;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const DESCRIPTOR_FLAG = 0x0008;
const UTF8_FLAG = 0x0800;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = (byte >>> 1) ^ (byte & 1 ? 0xedb88320 : 0);
  return byte;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function requireZip(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid icon ZIP archive.");
}

function directoryEnd(zip: Buffer): number {
  // EOCD can be followed by a comment. Search only the range a 16-bit comment can cover.
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset--) {
    if (zip.readUInt32LE(offset) === EOCD && offset + 22 + zip.readUInt16LE(offset + 20) === zip.length) {
      return offset;
    }
  }
  throw new Error("Invalid icon ZIP archive.");
}

function checkExtraFields(extra: Buffer): void {
  for (let offset = 0; offset < extra.length;) {
    requireZip(offset + 4 <= extra.length);
    const kind = extra.readUInt16LE(offset);
    // ZIP64 changes the offset/length interpretation. Unicode Path can override the name
    // some extraction tools use. This archive must carry one unambiguous name per file.
    requireZip(kind !== 0x0001 && kind !== 0x7075);
    offset += 4 + extra.readUInt16LE(offset + 2);
    requireZip(offset <= extra.length);
  }
}

function pathName(raw: Buffer, flags: number): string {
  requireZip(raw.length > 0 && raw.length <= 512);
  const name = flags & UTF8_FLAG ? new TextDecoder("utf-8", { fatal: true }).decode(raw) : raw.toString("latin1");
  // Check compatibility forms as well, since the recipient's filesystem can normalize names.
  const normalized = name.normalize("NFKC");
  const parts = normalized.replace(/\/$/, "").split("/");
  requireZip(!/[\\:<>"|?*\p{C}]/u.test(normalized) && parts.every((part) => part.length > 0
    && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)));
  return normalized;
}

interface Entry {
  name: string;
  rawName: Buffer;
  offset: number;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
}

function readEntry(zip: Buffer, entry: Entry, boundary: number): Buffer {
  const { offset, flags, method, crc, compressed, size, rawName } = entry;
  requireZip(offset + 30 <= boundary && zip.readUInt32LE(offset) === LOCAL);
  requireZip(zip.readUInt16LE(offset + 6) === flags && zip.readUInt16LE(offset + 8) === method);
  const nameEnd = offset + 30 + zip.readUInt16LE(offset + 26);
  const dataStart = nameEnd + zip.readUInt16LE(offset + 28);
  const dataEnd = dataStart + compressed;
  requireZip(dataEnd <= boundary && zip.subarray(offset + 30, nameEnd).equals(rawName));
  checkExtraFields(zip.subarray(nameEnd, dataStart));
  const localValues = [zip.readUInt32LE(offset + 14), zip.readUInt32LE(offset + 18), zip.readUInt32LE(offset + 22)];
  const centralValues = [crc, compressed, size];
  if (flags & DESCRIPTOR_FLAG) {
    requireZip(localValues.every((value, i) => value === 0 || value === centralValues[i]));
    const hasSignature = boundary - dataEnd === 16 && zip.readUInt32LE(dataEnd) === DESCRIPTOR;
    const descriptor = dataEnd + (hasSignature ? 4 : 0);
    requireZip(descriptor + 12 === boundary && centralValues.every((value, i) => value === zip.readUInt32LE(descriptor + 4 * i)));
  } else {
    requireZip(dataEnd === boundary && localValues.every((value, i) => value === centralValues[i]));
  }

  const raw = zip.subarray(dataStart, dataEnd);
  if (method === 0) {
    requireZip(raw.length === size && crc32(raw) === crc);
    return raw;
  }
  // With info=true, Node returns the number of compressed bytes consumed as well as the
  // decompressed buffer. Reject trailing data inside the entry's advertised deflate stream.
  const result = inflateRawSync(raw, { info: true, maxOutputLength: Math.max(1, size) }) as unknown as {
    buffer: Buffer; engine: { bytesWritten: number };
  };
  requireZip(result.engine.bytesWritten === compressed && result.buffer.length === size && crc32(result.buffer) === crc);
  return result.buffer;
}

function checkPng(data: Buffer): void {
  requireZip(data.length >= 45 && data.subarray(0, 8).equals(PNG_SIGNATURE));
  requireZip(data.readUInt32BE(8) === 13 && data.toString("ascii", 12, 16) === "IHDR");
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  requireZip(width > 0 && height > 0 && width <= 4096 && height <= 4096);
  let hasImageData = false;
  for (let offset = 8; offset + 12 <= data.length;) {
    const length = data.readUInt32BE(offset);
    const dataEnd = offset + 8 + length;
    requireZip(dataEnd + 4 <= data.length && crc32(data.subarray(offset + 4, dataEnd)) === data.readUInt32BE(dataEnd));
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT" && length > 0) hasImageData = true;
    offset = dataEnd + 4;
    if (type === "IEND") {
      requireZip(length === 0 && hasImageData && offset === data.length);
      return;
    }
  }
  throw new Error("Invalid icon ZIP archive.");
}

/** Verify a bounded, single-disk ZIP and its PNG assets in memory, without extracting any files. */
export function validateIconZip(bytes: Uint8Array): void {
  requireZip(bytes.length >= 22 && bytes.length <= MAX_ICON_ZIP_BYTES);
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = directoryEnd(zip);
  const count = zip.readUInt16LE(end + 10);
  const directory = zip.readUInt32LE(end + 16);
  requireZip(zip.readUInt32LE(end + 4) === 0 && zip.readUInt16LE(end + 8) === count
    && count > 0 && count <= MAX_FILES && directory + zip.readUInt32LE(end + 12) === end);
  const entries: Entry[] = [];
  const names = new Map<string, boolean>();
  let total = 0;
  let cursor = directory;
  for (let index = 0; index < count; index++) {
    requireZip(cursor + 46 <= end && zip.readUInt32LE(cursor) === CENTRAL);
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameEnd = cursor + 46 + zip.readUInt16LE(cursor + 28);
    const extraEnd = nameEnd + zip.readUInt16LE(cursor + 30);
    const next = extraEnd + zip.readUInt16LE(cursor + 32);
    const attributes = zip.readUInt32LE(cursor + 38);
    const unixType = (attributes >>> 16) & 0xf000;
    const offset = zip.readUInt32LE(cursor + 42);
    total += size;
    requireZip(next <= end && zip.readUInt16LE(cursor + 34) === 0 && offset < directory
      && (method === 0 || method === 8) && !(flags & ~(UTF8_FLAG | DESCRIPTOR_FLAG | (method === 8 ? 0x0006 : 0)))
      && size <= MAX_FILE_BYTES && total <= MAX_TOTAL_BYTES && (unixType === 0 || unixType === 0x4000 || unixType === 0x8000));
    const rawName = zip.subarray(cursor + 46, nameEnd);
    const name = pathName(rawName, flags);
    const isDirectory = name.endsWith("/");
    requireZip(isDirectory ? size === 0 && unixType !== 0x8000 : unixType !== 0x4000 && !(attributes & 0x10));
    const normalized = name.replace(/\/$/, "").toLowerCase();
    requireZip(!names.has(normalized));
    names.set(normalized, isDirectory);
    checkExtraFields(zip.subarray(nameEnd, extraEnd));
    entries.push({ name, rawName, offset, flags, method, crc, compressed, size });
    cursor = next;
  }
  requireZip(cursor === end);
  for (const name of names.keys()) {
    for (let separator = name.indexOf("/"); separator >= 0; separator = name.indexOf("/", separator + 1)) {
      requireZip(names.get(name.slice(0, separator)) !== false);
    }
  }

  entries.sort((a, b) => a.offset - b.offset);
  requireZip(entries[0]?.offset === 0);
  let hasPng = false;
  for (const [index, entry] of entries.entries()) {
    const data = readEntry(zip, entry, entries[index + 1]?.offset ?? directory);
    // Finder can add an AppleDouble metadata file for a PNG. Validate its ZIP CRC but
    // require a real PNG asset independently of that metadata.
    const name = entry.name.toLowerCase();
    if (name.endsWith(".png") && !(name.startsWith("__macosx/") && name.split("/").at(-1)?.startsWith("._"))) {
      checkPng(data);
      hasPng = true;
    }
  }
  requireZip(hasPng);
}
