// ============================================================
// 记忆强度与遗忘曲线（design §11）。
//   清晰度 R = exp(−(今天 − 上次想起的日子) / 稳定度 S)，S 单位：天
//   R ≥ 0.5 清晰；0.15 ≤ R < 0.5 模糊；R < 0.15 沉底
// 强度表 data/memory/.strength.json：文件名 → {importance, stability, lastRecalled, recallDays, pinned, gist}
// 记忆 md 文件本身不改，所以“过去不可改”的 event 也能随时间变淡。数值只在程序里，模型永远看不到。
// 所有可调参数集中在这里。
// ============================================================

import { paths } from "../config/paths.js";
import { createSerializer, readJson, writeJsonAtomic } from "../store/files.js";
import { daysBetween, formatLocalDate } from "../util/time.js";

export const IMPORTANCE_LEVELS = Object.freeze(["normal", "care", "core"]);
export const CLEAR_THRESHOLD = 0.5;
export const SUNK_THRESHOLD = 0.15;
/** 底色类（他是谁、她是谁）和 pinned 的清晰度下限：最多模糊，不会沉底。 */
export const FLOOR_R = SUNK_THRESHOLD;
export const FOUNDATION_TYPES = Object.freeze(["profile", "preference", "self"]);
export const GROWTH = 2.0;
export const GROWTH_CORE = 2.5;
export const S_MAX = 3650;
export const RECALL_DAYS_KEEP = 10;

/** 初始稳定度（天）：类型 × 重要程度。 */
export const INITIAL_STABILITY = Object.freeze({
  event: { normal: 3, care: 14, core: 365 },
  recent: { normal: 5, care: 20, core: 120 },
  thread: { normal: 7, care: 30, core: 180 },
  self_daily: { normal: 2, care: 7, core: 60 },
  profile: { normal: 90, care: 365, core: 3650 },
  preference: { normal: 90, care: 365, core: 3650 },
  self: { normal: 90, care: 365, core: 3650 },
});
export const WEEK_SUMMARY_STABILITY = 30;
export const MONTH_SUMMARY_STABILITY = 180;
const WEEK_SUMMARY_FILE = /^week-summary-/u;
const MONTH_SUMMARY_FILE = /^month-summary-/u;

/** 迁移来的、手动新建的记忆，没有强度记录时的默认重要程度。 */
export function defaultImportance(type) {
  return FOUNDATION_TYPES.includes(type) ? "core" : "care";
}

export function normalizeImportance(value, type) {
  return IMPORTANCE_LEVELS.includes(value) ? value : defaultImportance(type);
}

/** @param {{file: string, type: string}} entry */
export function initialStability(entry, importance) {
  if (WEEK_SUMMARY_FILE.test(entry.file)) return WEEK_SUMMARY_STABILITY;
  if (MONTH_SUMMARY_FILE.test(entry.file)) return MONTH_SUMMARY_STABILITY;
  const table = INITIAL_STABILITY[entry.type] ?? INITIAL_STABILITY.event;
  return table[importance] ?? table.care;
}

/**
 * 缺记录时补一条：lastRecalled = updated ?? created ?? 文件 mtime 日期。
 * @param {{file: string, type: string, updated?: string, created?: string, mtimeMs?: number}} entry
 */
export function defaultRecord(entry, importance) {
  const level = normalizeImportance(importance, entry.type);
  const lastRecalled = entry.updated ?? entry.created ?? formatLocalDate(new Date(entry.mtimeMs || Date.now()));
  return { importance: level, stability: initialStability(entry, level), lastRecalled, recallDays: [], pinned: false, gist: "" };
}

/**
 * recent 未过期、thread 未聊完：视为当下，清晰且不衰减。
 * recent 过期后从过期那天开始算，thread 聊完后从最后更新那天开始算。
 */
function decayStart(entry, record) {
  if (entry.type === "recent" && entry.expires && record.lastRecalled < entry.expires) return entry.expires;
  return record.lastRecalled;
}

export function isLive(entry, today) {
  if (entry.type === "recent") return !entry.expires || entry.expires >= today;
  if (entry.type === "thread") return !entry.closed;
  return false;
}

/**
 * @param {{file: string, type: string, expires?: string, closed?: boolean}} entry
 * @param {{stability: number, lastRecalled: string, pinned?: boolean}} record
 * @param {string} today YYYY-MM-DD
 */
export function retention(entry, record, today) {
  if (isLive(entry, today)) return 1;
  const elapsed = Math.max(0, daysBetween(decayStart(entry, record), today));
  const stability = Math.max(0.1, Number(record.stability) || 1);
  let r = Math.exp(-elapsed / stability);
  if (record.pinned || FOUNDATION_TYPES.includes(entry.type)) r = Math.max(r, FLOOR_R);
  return r;
}

export function clarityOf(r) {
  if (r >= CLEAR_THRESHOLD) return "clear";
  if (r >= SUNK_THRESHOLD) return "blurry";
  return "sunk";
}

/**
 * 想起一次：S_new = min(S × (1 + G × (1 − R)) + 1, S_MAX)；同一天只算一次；pinned 不受上限。
 * @returns {{record: object, changed: boolean}}
 */
export function reinforce(entry, record, today) {
  if (record.recallDays?.at(-1) === today) return { record, changed: false };
  const r = retention(entry, record, today);
  const growth = record.importance === "core" ? GROWTH_CORE : GROWTH;
  let stability = record.stability * (1 + growth * (1 - r)) + 1;
  if (!record.pinned) stability = Math.min(stability, S_MAX);
  const recallDays = [...(record.recallDays ?? []), today].slice(-RECALL_DAYS_KEEP);
  return { record: { ...record, stability: Math.round(stability * 100) / 100, lastRecalled: today, recallDays }, changed: true };
}

// ---------------- 读写 ----------------

const serialize = createSerializer();

export async function readStrengthTable() {
  const table = await readJson(paths.strength(), {});
  return table && typeof table === "object" && !Array.isArray(table) ? table : {};
}

/**
 * 串行地读-改-写强度表。mutator 返回 false 表示没改，不写盘。
 * @param {(table: Record<string, any>) => boolean | void} mutator
 */
export function updateStrengthTable(mutator) {
  return serialize(async () => {
    const table = await readStrengthTable();
    const changed = mutator(table);
    if (changed !== false) await writeJsonAtomic(paths.strength(), table);
    return table;
  });
}

/**
 * 与记忆目录对齐：缺记录的按类型补默认值，文件已删的清理掉。返回对齐后的表。
 * @param {readonly {file: string, type: string}[]} memories
 */
export function syncStrength(memories) {
  return updateStrengthTable((table) => {
    let changed = false;
    const files = new Set(memories.map((entry) => entry.file));
    for (const entry of memories) {
      if (!table[entry.file]) {
        table[entry.file] = defaultRecord(entry);
        changed = true;
      }
    }
    for (const file of Object.keys(table)) {
      if (!files.has(file)) {
        delete table[file];
        changed = true;
      }
    }
    return changed;
  });
}

/** 一组记忆被想起（同日只算一次）。 */
export function recallMemories(entries, today) {
  return updateStrengthTable((table) => {
    let changed = false;
    for (const entry of entries) {
      const current = table[entry.file] ?? defaultRecord(entry);
      const result = reinforce(entry, current, today);
      if (result.changed || !table[entry.file]) {
        table[entry.file] = result.record;
        changed = true;
      }
    }
    return changed;
  });
}

/** 新写入（或重写）的记忆：按重要程度设起点，lastRecalled = 今天。 */
export function recordWritten(entry, importance, today) {
  return updateStrengthTable((table) => {
    const previous = table[entry.file];
    const level = normalizeImportance(importance ?? previous?.importance, entry.type);
    const fresh = { ...defaultRecord(entry, level), lastRecalled: today };
    // 改写已有记忆不降低已经积累的稳定度。
    table[entry.file] = previous ? { ...previous, importance: level, stability: Math.max(previous.stability, fresh.stability), lastRecalled: today } : fresh;
  });
}

export function setPinned(entry, pinned) {
  return updateStrengthTable((table) => {
    table[entry.file] = { ...(table[entry.file] ?? defaultRecord(entry)), pinned: Boolean(pinned) };
  });
}

export function setGist(file, gist) {
  return updateStrengthTable((table) => {
    if (!table[file]) return false;
    table[file] = { ...table[file], gist: String(gist ?? "").trim() };
  });
}

export function forgetRecord(file) {
  return updateStrengthTable((table) => {
    if (!table[file]) return false;
    delete table[file];
  });
}

/**
 * 给每条记忆附上清晰度信息（不写盘；缺记录时用默认值算）。
 * @template {{file: string, type: string}} T
 * @param {readonly T[]} memories
 * @returns {(T & {r: number, clarity: string, record: any})[]}
 */
export function annotate(memories, table, today) {
  return memories.map((entry) => {
    const record = table[entry.file] ?? defaultRecord(entry);
    const r = retention(entry, record, today);
    return { ...entry, record, r, clarity: clarityOf(r) };
  });
}
