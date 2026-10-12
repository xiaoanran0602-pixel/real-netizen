// ============================================================
// 记忆整理与记忆强度的接线（design §6、§11）：
//   - 新写入的记忆按 importance 写强度记录；
//   - recalled 列表加固（同日只算一次）；
//   - 整理用的记忆清单只列清晰与模糊的（最多 200 条；模糊的给概括），沉底的不列，避免一年后清单爆掉。
// ============================================================

import { formatLocalDate } from "../util/time.js";
import { MANIFEST_LIMIT } from "./curator-prompt.js";
import { parseMemoryFile, readMemories } from "./memory.js";
import { annotate, readStrengthTable, recallMemories, recordWritten, syncStrength } from "./strength.js";

/** @param {readonly any[]} memories @param {Date} at */
export async function selectCuratorManifest(memories, at) {
  await syncStrength(memories);
  const table = await readStrengthTable();
  return annotate(memories, table, formatLocalDate(at))
    .filter((entry) => entry.clarity !== "sunk")
    .sort((a, b) => b.r - a.r)
    .slice(0, MANIFEST_LIMIT)
    .map((entry) => ({ entry, text: entry.clarity === "blurry" && entry.record.gist ? entry.record.gist : undefined }));
}

/** 写入/改写的记忆：建强度记录（改写保留已积累的稳定度）。 */
export async function onCuratorWritten(applied, at) {
  const today = formatLocalDate(at);
  for (const op of applied) {
    if (op.op !== "write" || op.file.startsWith("life/")) continue;
    const entry = parseMemoryFile(op.content);
    if (entry) await recordWritten({ ...entry, file: op.file }, op.importance, today);
  }
}

/** 这轮聊天里真的提到了的已有记忆：加固一次。 */
export async function onCuratorRecalled(files, at) {
  if (!files?.length) return;
  const wanted = new Set(files);
  const entries = (await readMemories()).filter((entry) => wanted.has(entry.file));
  if (entries.length > 0) await recallMemories(entries, formatLocalDate(at));
}

/** @param {{onEvents?: Function, selectRelated?: Function}} [extra] */
export function strengthHooks(extra = {}) {
  return { selectManifest: selectCuratorManifest, onWritten: onCuratorWritten, onRecalled: onCuratorRecalled, ...extra };
}
