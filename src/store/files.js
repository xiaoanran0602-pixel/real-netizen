// ============================================================
// 文件读写：原子写 JSON/文本、按 mtime 缓存、sha256。data 目录下的读写都走这里。
// ============================================================

import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

let tempCounter = 0;

/** @param {string} path */
export async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** @param {string} path */
export async function readBytes(path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * 读 JSON 对象；不存在或坏了返回 fallback（深拷贝，调用方可以随便改）。
 * @template T
 * @param {string} path
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export async function readJson(path, fallback) {
  const text = await readText(path);
  if (!text) return structuredClone(fallback);
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/u, ""));
    return parsed && typeof parsed === "object" ? parsed : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

/** 先写临时文件再改名，读的人不会读到半个文件。 */
export async function writeTextAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  tempCounter += 1;
  const temp = `${path}.${process.pid}.${Date.now()}.${tempCounter}.tmp`;
  await writeFile(temp, text);
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  invalidateCache(path);
}

export async function writeBytesAtomic(path, bytes) {
  await writeTextAtomic(path, bytes);
}

export async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, text);
  invalidateCache(path);
}

/** 只在文件不存在时创建；已存在返回 false，绝不覆盖。 */
export async function writeTextExclusive(path, text) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, text, { encoding: "utf8", flag: "wx" });
    invalidateCache(path);
    return true;
  } catch {
    return false;
  }
}

export async function removeFile(path) {
  await rm(path, { force: true });
  invalidateCache(path);
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function fileStat(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** 列目录（只要文件名）；不存在返回空数组。 */
export async function listDir(path) {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/**
 * 递归列出目录下所有文件，返回相对 base 的路径（用 / 分隔）。
 * 跳过临时文件。
 */
export async function listFilesRecursive(dir, base = dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full, base)));
    else if (entry.isFile() && !entry.name.endsWith(".tmp")) out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

/** @param {Buffer|string} data */
export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

// ---- 按 mtime 缓存：设置页改完文件，下一次读就是新的，不用重启 ----

/** @type {Map<string, {mtimeMs: number, size: number, value: unknown}>} */
const cache = new Map();

export function invalidateCache(path) {
  if (path === undefined) cache.clear();
  else cache.delete(path);
}

/** 回档等操作之后整体失效。 */
export function invalidateAllCaches() {
  cache.clear();
}

/**
 * 读并解析，mtime 和大小都没变时直接用缓存。
 * @template T
 * @param {string} path
 * @param {(raw: string) => T} parse
 * @returns {Promise<T | undefined>}
 */
export async function readCached(path, parse) {
  const info = await fileStat(path);
  if (!info) {
    cache.delete(path);
    return undefined;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return /** @type {T} */ (hit.value);
  const raw = await readText(path);
  if (raw === null) return undefined;
  try {
    const value = parse(raw);
    cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, value });
    return value;
  } catch {
    return hit ? /** @type {T} */ (hit.value) : undefined;
  }
}

/** 同一进程内把对同一资源的写操作串起来，避免两处同时改互相覆盖。 */
export function createSerializer() {
  let chain = Promise.resolve();
  return function serialize(work) {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };
}
