// ============================================================
// 内核事件与持久化格式的纯部分（kernel.js 的运行时引用这里）：
//   EVENT_TYPES / validateEvent   事件类型与形状校验（外部边界只验一次，docs/14 第 8.2 节）
//   parseKernelLog                事件日志解析：只容忍最后一行不完整（docs/14 第 8.1 节）
//   migrateInner                  inner.json → body-v2（merge-inner-engines design §7）
// 不读盘、不读时钟。
// ============================================================

import { createHash } from "node:crypto";
import { formatLocalDate } from "../util/time.js";
import { driversAt } from "./body-advance.js";
import { bandsOf, BODY_PARAMS, createBody } from "./body.js";
import { EVENT_EFFECTS, initialPsyche, TURNING_THRESHOLD, validCondition } from "./psyche.js";

export const EVENT_TYPES = Object.freeze([
  "message_perceived",
  "chat_appraisal",
  "schedule_adopted",
  "weather_observed",
  "thoughts_changed",
  "delivery_confirmed",
  "psyche_events",
  "condition_set",
  "turning",
  "leak_offered",
  "force",
]);
/** 调试强制（/api/lin/inner/force）能提交的事件。 */
export const FORCE_KINDS = Object.freeze(["tension:book", "tension:seen", "stress", "tired", "drink"]);
export const FORCED = Object.freeze({ tension: TURNING_THRESHOLD + 5, stress: 90, energy: 15 });
const LEGACY_PARAMS = "body-v1";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function payloadHash(payload) {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex").slice(0, 16);
}

/**
 * 校验事件形状。
 * @returns {string | null} 错误原因
 */
export function validateEvent(event) {
  if (!event || typeof event !== "object") return "not-object";
  if (typeof event.id !== "string" || !event.id) return "no-id";
  if (!EVENT_TYPES.includes(event.type)) return "unknown-type";
  if (!Number.isFinite(event.occurredAt)) return "no-time";
  const p = event.payload;
  const isObject = p !== null && typeof p === "object" && !Array.isArray(p);
  switch (event.type) {
    case "chat_appraisal":
      if (p === null) return null;
      if (!isObject) return "bad-appraisal";
      for (const key of ["valence", "activation", "tension"]) if (typeof p[key] !== "number" || !Number.isFinite(p[key]) || p[key] < -1 || p[key] > 1) return `bad-${key}`;
      for (const key of ["importance", "confidence", "surprise"]) if (typeof p[key] !== "number" || !Number.isFinite(p[key]) || p[key] < 0 || p[key] > 1) return `bad-${key}`;
      return null;
    case "psyche_events":
      if (!isObject) return "bad-psyche-events";
      for (const [key, value] of Object.entries(p)) {
        if (!EVENT_EFFECTS[key]) return `unknown-${key}`;
        if (typeof value !== "boolean") return `bad-${key}`;
      }
      return null;
    case "condition_set":
      if (!isObject) return "bad-condition";
      if (!("condition" in p) && p.diceDay === undefined) return "empty-condition";
      if ("condition" in p && p.condition !== null && !validCondition(p.condition)) return "bad-condition";
      if (p.diceDay !== undefined && (typeof p.diceDay !== "string" || !DAY_PATTERN.test(p.diceDay))) return "bad-dice-day";
      return null;
    case "turning":
      if (!isObject || p.will !== "book") return "bad-will";
      if (typeof p.day !== "string" || !DAY_PATTERN.test(p.day)) return "bad-day";
      return null;
    case "leak_offered":
      if (!isObject || !Number.isFinite(p.at)) return "bad-leak";
      return null;
    case "force":
      if (!isObject || !FORCE_KINDS.includes(p.event)) return "bad-force";
      return null;
    default:
      return null;
  }
}

/** 解析事件日志：只容忍最后一行不完整。 */
export function parseKernelLog(text) {
  const lines = (text ?? "").split("\n");
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      const tail = lines.slice(index + 1).every((rest) => !rest.trim());
      if (tail) break;
      throw Object.assign(new Error(`kernel log corrupted at line ${index + 1}`), { kind: "corrupted" });
    }
  }
  return rows;
}

/**
 * 从 inner.json 的内容得到 v2 body。
 *   已是 v2：原样；body-v1：values、dedup、epoch、lastEventSeq 保留，从旧顶层字段构造 psyche；
 *   没有 body：从旧 vitals 迁移精力与张力（旧想念、旧饱腹丢弃，不转换成不快）；
 *   其余版本：null（调用方停用内核，防止旧代码读到新数据后写坏）。
 * closedDay 设为今天（不把过去的天重新结算一遍），lastSlotId 设为状态时刻所在的段（不重复触发它的效果）。
 * @param {any} file inner.json 全文
 * @param {number} nowMs
 * @param {any} timeline
 * @returns {{body: any, migrated: "none" | "v1" | "legacy" | "fresh"} | null}
 */
export function migrateInner(file, nowMs, timeline) {
  const saved = file?.body;
  const today = formatLocalDate(new Date(nowMs));
  if (saved?.schemaVersion === 2 && saved.paramsVersion === BODY_PARAMS.version) return { body: saved, migrated: "none" };
  if (saved && !(saved.schemaVersion === 1 && saved.paramsVersion === LEGACY_PARAMS)) return null;
  if (saved) {
    const at = Number.isFinite(saved.at) ? Math.min(saved.at, nowMs) : nowMs;
    const psyche = initialPsyche({ legacy: file, day: today, slotId: driversAt(timeline, at).segment?.slotId ?? null });
    return { body: { ...saved, schemaVersion: 2, paramsVersion: BODY_PARAMS.version, at, psyche, bands: bandsOf({ ...saved.values }, saved.bands ?? {}) }, migrated: "v1" };
  }
  const psyche = initialPsyche({ legacy: file ?? {}, day: today, slotId: driversAt(timeline, nowMs).segment?.slotId ?? null });
  const body = createBody(nowMs, { energy: file?.vitals?.energy, tension: file?.vitals?.stress, psyche });
  return { body, migrated: file?.vitals ? "legacy" : "fresh" };
}
