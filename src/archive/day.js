// ============================================================
// 「一天」的分界：dayBoundaryHour（默认 4）。凌晨 1 点的聊天算前一天。
// 存档名 = 那一天的日期；“回到 10 月 3 日”= 回到 10 月 4 日凌晨 4 点那一刻。
// ============================================================

import { addDays, formatLocalDate, HOUR_MS } from "../util/time.js";

/**
 * 某一时刻属于哪一天。
 * @param {Date | number} when
 * @param {number} boundaryHour
 */
export function experienceDay(when, boundaryHour) {
  const at = typeof when === "number" ? when : when.getTime();
  return formatLocalDate(new Date(at - boundaryHour * HOUR_MS));
}

/** 已经结束的最后一天（现在所在“那一天”的前一天）。 */
export function lastFinishedDay(now, boundaryHour) {
  return addDays(experienceDay(now, boundaryHour), -1);
}

/** 某一天结束的时刻（次日分界点）。 */
export function dayEndsAt(day, boundaryHour) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date + 1, boundaryHour, 0, 0, 0).getTime();
}

/**
 * 需要补做的日期：从 last 的下一天到 lastFinishedDay（含），按日期升序。
 * last 为空时只补“昨天”这一天（迁移后首次启动：存档从迁移那天开始）。
 * @param {string | undefined} last
 * @param {Date} now
 * @param {number} boundaryHour
 * @param {number} [maxDays] 一次最多补多少天（防止很久没开机时一次跑太多）
 */
export function pendingDays(last, now, boundaryHour, maxDays = 60) {
  const end = lastFinishedDay(now, boundaryHour);
  if (!last) return [end];
  const out = [];
  for (let day = addDays(last, 1); day <= end && out.length < maxDays; day = addDays(day, 1)) out.push(day);
  return out;
}

/** 这一天结束时次日是周一（即这一天是周日）→ 要做周整理。 */
export function isWeekEnd(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).getDay() === 0;
}

/** 这一天是月末 → 要做月整理。 */
export function isMonthEnd(day) {
  return addDays(day, 1).slice(8, 10) === "01";
}
