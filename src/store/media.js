// ============================================================
// 媒体文件（朋友圈配图、头像）：data/media/<sha1>.<ext>。文件名是内容的 sha1，同一张图只存一份。
// ============================================================

import { createHash } from "node:crypto";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import { ensureDir, fileExists, readBytes, writeBytesAtomic } from "./files.js";

export const MEDIA_FILE_PATTERN = /^[a-f0-9]{40}\.(jpg|png|webp)$/u;
export const MEDIA_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
export const MEDIA_URL_PREFIX = "/api/lin/media/";

/** @param {string} file */
export function mediaPath(file) {
  if (!MEDIA_FILE_PATTERN.test(file)) throw new Error("invalid media file name");
  return join(paths.media(), file);
}

export function mediaUrl(file) {
  return `${MEDIA_URL_PREFIX}${file}`;
}

/** @param {string} file */
export async function readMedia(file) {
  if (!MEDIA_FILE_PATTERN.test(file)) return null;
  return readBytes(join(paths.media(), file));
}

export function mediaContentType(file) {
  const ext = file.split(".").pop() ?? "";
  return MEDIA_TYPES[ext] ?? "application/octet-stream";
}

/**
 * 存一张图，返回文件名。已有同内容的就不重写。
 * @param {Buffer} bytes
 * @param {"jpg"|"png"|"webp"} ext
 */
export async function saveMedia(bytes, ext) {
  const name = `${createHash("sha1").update(bytes).digest("hex")}.${ext}`;
  await ensureDir(paths.media());
  const path = join(paths.media(), name);
  if (!(await fileExists(path))) await writeBytesAtomic(path, bytes);
  return name;
}
