import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
const LOCAL_SIGNATURE = 67324752;
const CENTRAL_SIGNATURE = 33639248;
const END_SIGNATURE = 101010256;
const MAX_ZIP32 = 4294967295;
const MAX_ENTRY_SIZE = 1024 * 1024 * 1024;
function u16(view, offset) {
  return view.getUint16(offset, true);
}
function u32(view, offset) {
  return view.getUint32(offset, true);
}
function put16(view, offset, value) {
  view.setUint16(offset, value, true);
}
function put32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}
function crc32(input) {
  let crc = 4294967295;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc >>> 1 ^ 3988292384 & -(crc & 1);
  }
  return (crc ^ 4294967295) >>> 0;
}
function textBytes(value) {
  return new TextEncoder().encode(value);
}
function zipSync(entries) {
  if (entries.length > 65535) throw new Error(`\u5907\u4EFD\u6587\u4EF6\u6761\u76EE\u8FC7\u591A\uFF08${entries.length}\uFF09\uFF0C\u8D85\u8FC7\u5355\u4E2A ZIP \u7684 65535 \u6761\u4E0A\u9650\uFF1B\u8BF7\u51CF\u5C11\u4F53\u79EF\u5DE8\u5927\u7684\u672C\u5730\u63D2\u4EF6\u540E\u91CD\u8BD5`);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const item of entries) {
    const name = item.name.replace(/\\/g, "/");
    const nameBytes = textBytes(name);
    const raw = item.data;
    const compressed = raw.byteLength > 32 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const method = compressed === raw ? 0 : 8;
    const checksum = crc32(raw);
    const local = new Uint8Array(30 + nameBytes.byteLength + compressed.byteLength);
    const lv = new DataView(local.buffer);
    put32(lv, 0, LOCAL_SIGNATURE);
    put16(lv, 4, 20);
    put16(lv, 6, 0);
    put16(lv, 8, method);
    put16(lv, 10, 0);
    put16(lv, 12, 0);
    put32(lv, 14, checksum);
    put32(lv, 18, compressed.byteLength);
    put32(lv, 22, raw.byteLength);
    put16(lv, 26, nameBytes.byteLength);
    put16(lv, 28, 0);
    local.set(nameBytes, 30);
    local.set(compressed, 30 + nameBytes.byteLength);
    localParts.push(local);
    const central = new Uint8Array(46 + nameBytes.byteLength);
    const cv = new DataView(central.buffer);
    put32(cv, 0, CENTRAL_SIGNATURE);
    put16(cv, 4, 20);
    put16(cv, 6, 20);
    put16(cv, 8, 0);
    put16(cv, 10, method);
    put16(cv, 12, 0);
    put16(cv, 14, 0);
    put32(cv, 16, checksum);
    put32(cv, 20, compressed.byteLength);
    put32(cv, 24, raw.byteLength);
    put16(cv, 28, nameBytes.byteLength);
    put16(cv, 30, 0);
    put16(cv, 32, 0);
    put16(cv, 34, 0);
    put16(cv, 36, 0);
    const attrs = (item.mode & 65535) << 16 | (item.kind === "dir" ? 16 : item.kind === "symlink" ? 2684354560 : 0);
    put32(cv, 38, attrs);
    put32(cv, 42, offset);
    central.set(nameBytes, 46);
    centralParts.push(central);
    offset += local.byteLength;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  put32(ev, 0, END_SIGNATURE);
  put16(ev, 4, 0);
  put16(ev, 6, 0);
  put16(ev, 8, entries.length);
  put16(ev, 10, entries.length);
  put32(ev, 12, centralSize);
  put32(ev, 16, centralOffset);
  put16(ev, 20, 0);
  return concat([...localParts, ...centralParts, end]);
}
function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
function unzipSync(input) {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let end = input.byteLength - 22;
  while (end >= 0 && u32(view, end) !== END_SIGNATURE) end -= 1;
  if (end < 0) throw new Error("Invalid ZIP: end record not found");
  const count = u16(view, end + 10);
  const centralSize = u32(view, end + 12);
  const centralOffset = u32(view, end + 16);
  if (centralOffset + centralSize > input.byteLength) throw new Error("Invalid ZIP: central directory out of range");
  const result = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > input.byteLength || u32(view, cursor) !== CENTRAL_SIGNATURE) throw new Error("Invalid ZIP central entry");
    const flags = u16(view, cursor + 8);
    const compression = u16(view, cursor + 10);
    const compressedSize = u32(view, cursor + 20);
    const originalSize = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const externalAttributes = u32(view, cursor + 38);
    const localOffset = u32(view, cursor + 42);
    const name = new TextDecoder().decode(input.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new Error(`Encrypted ZIP entries are not supported: ${name}`);
    if (localOffset + 30 > input.byteLength || u32(view, localOffset) !== LOCAL_SIGNATURE) throw new Error(`Invalid ZIP local entry: ${name}`);
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > input.byteLength) throw new Error(`ZIP entry out of range: ${name}`);
    const compressed = input.subarray(dataStart, dataEnd);
    let data;
    if (originalSize > MAX_ENTRY_SIZE) throw new Error(`ZIP entry too large: ${name}`);
    if (compression === 0) data = new Uint8Array(compressed);
    else if (compression === 8) data = new Uint8Array(inflateRawSync(compressed));
    else throw new Error(`Unsupported ZIP compression method ${compression}: ${name}`);
    if (data.byteLength !== originalSize) throw new Error(`ZIP size mismatch: ${name}`);
    result.push({ entry: { name, originalSize, compressedSize, compression, externalAttributes }, data });
  }
  return result;
}
function normalizeArchiveName(value) {
  const normalized = value.replace(/\\/g, "/");
  const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) throw new Error(`Unsafe archive path: ${value}`);
  const parts = trimmed.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe archive path: ${value}`);
  return trimmed;
}
function isSymlinkEntry(entry) {
  return (entry.externalAttributes >>> 16 & 61440) === 40960;
}
function isDirectoryEntry(entry) {
  return entry.name.endsWith("/") || (entry.externalAttributes >>> 16 & 61440) === 16384;
}
async function readZipEntry(path, wanted) {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const tailLength = Math.min(info.size, 65557);
    if (tailLength < 22) return void 0;
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, info.size - tailLength);
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let end = -1;
    for (let offset = tailLength - 22; offset >= 0; offset -= 1) {
      if (u32(tailView, offset) === END_SIGNATURE) {
        end = offset;
        break;
      }
    }
    if (end < 0) return void 0;
    const count = u16(tailView, end + 10);
    const centralSize = u32(tailView, end + 12);
    const centralOffset = u32(tailView, end + 16);
    if (!centralSize || centralOffset + centralSize > info.size) return void 0;
    const directory = Buffer.alloc(centralSize);
    await handle.read(directory, 0, centralSize, centralOffset);
    const directoryView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > directory.byteLength || u32(directoryView, cursor) !== CENTRAL_SIGNATURE) return void 0;
      const compression = u16(directoryView, cursor + 10);
      const compressedSize = u32(directoryView, cursor + 20);
      const originalSize = u32(directoryView, cursor + 24);
      const nameLength = u16(directoryView, cursor + 28);
      const extraLength = u16(directoryView, cursor + 30);
      const commentLength = u16(directoryView, cursor + 32);
      const localOffset = u32(directoryView, cursor + 42);
      const entryName = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      if (entryName === wanted) {
        const local = Buffer.alloc(30);
        await handle.read(local, 0, 30, localOffset);
        const localView = new DataView(local.buffer, local.byteOffset, local.byteLength);
        if (u32(localView, 0) !== LOCAL_SIGNATURE) return void 0;
        const dataStart = localOffset + 30 + u16(localView, 26) + u16(localView, 28);
        const compressed = Buffer.alloc(compressedSize);
        await handle.read(compressed, 0, compressedSize, dataStart);
        if (originalSize > MAX_ENTRY_SIZE) return void 0;
        if (compression === 0) return new Uint8Array(compressed);
        if (compression === 8) return new Uint8Array(inflateRawSync(compressed));
        return void 0;
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return void 0;
  } finally {
    await handle.close();
  }
}
async function collect(root, current, entries, shouldSkip, stats) {
  const info = await lstat(current).catch(() => void 0);
  if (!info) {
    stats.skipped.push(relative(root, current).replaceAll(sep, "/"));
    return;
  }
  const relativeName = relative(root, current).replaceAll(sep, "/");
  if (info.isSymbolicLink()) {
    const name = relativeName;
    if (name && !shouldSkip(name, "symlink")) entries.push({ name, kind: "symlink", data: textBytes(await readlink(current).catch(() => "")), mode: 511 });
    return;
  }
  if (info.isDirectory()) {
    if (relativeName && shouldSkip(relativeName, "dir")) return;
    if (relativeName) entries.push({ name: `${relativeName}/`, kind: "dir", data: new Uint8Array(), mode: info.mode & 511 });
    const children = await readdir(current).catch(() => {
      stats.skipped.push(relativeName || ".");
      return [];
    });
    for (const child of children) await collect(root, join(current, child), entries, shouldSkip, stats);
    return;
  }
  if (info.isFile() && !shouldSkip(relativeName, "file")) {
    const data = await readFile(current).catch(() => void 0);
    if (!data) {
      stats.skipped.push(relativeName);
      return;
    }
    const bytes = new Uint8Array(data);
    entries.push({ name: relativeName, kind: "file", data: bytes, mode: info.mode & 511 });
    stats.fileCount += 1;
    stats.bytes += bytes.byteLength;
  }
}
async function collectDirectoryWithStats(root, shouldSkip) {
  const rootInfo = await lstat(root);
  const actualRoot = rootInfo.isSymbolicLink() ? await realpath(root) : root;
  const entries = [];
  const stats = { fileCount: 0, bytes: 0, skipped: [] };
  await collect(actualRoot, actualRoot, entries, shouldSkip, stats);
  return { entries, stats };
}
async function collectDirectory(root, shouldSkip) {
  return (await collectDirectoryWithStats(root, shouldSkip)).entries;
}
async function restoreEntries(entries, targetRoot, prefix = "dsh-home", shouldSkip, options = {}) {
  const root = resolve(targetRoot);
  const selected = entries.filter(({ entry }) => entry.name === prefix || entry.name.startsWith(`${prefix}/`));
  let restored = 0;
  const notOlderThan = options.notOlderThan && options.notOlderThan > 0 ? options.notOlderThan : 0;
  for (const { entry, data } of selected) {
    if (entry.name === prefix || entry.name === `${prefix}/`) continue;
    const suffix = normalizeArchiveName(entry.name.slice(prefix.length + 1));
    const destination = resolve(root, suffix);
    if (destination !== root && !destination.startsWith(`${root}${sep}`)) throw new Error(`Unsafe restore path: ${entry.name}`);
    if (shouldSkip?.(suffix, entry)) continue;
    if (isDirectoryEntry(entry)) {
      await mkdir(destination, { recursive: true });
      restored += 1;
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    if (notOlderThan > 0) {
      const current = await stat(destination).catch(() => void 0);
      if (current && current.mtimeMs > notOlderThan) {
        const existing = await readFile(destination).catch(() => void 0);
        if (!existing || !existing.equals(Buffer.from(data))) {
          options.onSkip?.(suffix, "newer");
          continue;
        }
      }
    }
    if (isSymlinkEntry(entry)) {
      const linkTarget = new TextDecoder().decode(data);
      const resolvedLinkTarget = resolve(dirname(destination), linkTarget);
      if (isAbsolute(linkTarget) || resolvedLinkTarget !== root && !resolvedLinkTarget.startsWith(`${root}${sep}`)) continue;
      await rm(destination, { recursive: true, force: true });
      try {
        await symlink(linkTarget, destination, "junction");
      } catch {
        await symlink(linkTarget, destination);
      }
    } else {
      await rm(destination, { recursive: true, force: true });
      await writeFile(destination, data);
    }
    restored += 1;
  }
  return restored;
}
export {
  collectDirectory,
  collectDirectoryWithStats,
  isDirectoryEntry,
  isSymlinkEntry,
  readZipEntry,
  restoreEntries,
  unzipSync,
  zipSync
};
//# sourceMappingURL=zip.js.map
