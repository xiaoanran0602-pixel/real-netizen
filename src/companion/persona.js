// ============================================================
// 人设（data/persona.md）与基石记忆（data/core.md）的读取。按 mtime 缓存，改完下一句话生效。
// ============================================================

import { paths } from "../config/paths.js";
import { readCached, writeTextAtomic } from "../store/files.js";

export const PERSONA_MAX_CHARS = 60_000;

export async function readPersona() {
  const text = await readCached(paths.persona(), (raw) => raw.replace(/^\uFEFF/u, "").trim());
  return text || "";
}

export async function writePersona(text) {
  await writeTextAtomic(paths.persona(), text);
}

/** data/core.md：手改；不回档、不整理、不遗忘。 */
export async function readCore() {
  const text = await readCached(paths.core(), (raw) => raw.replace(/^\uFEFF/u, "").trim());
  return text || "";
}
