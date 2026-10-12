// ============================================================
// 时间：一律用本机本地时间。她只认系统时钟，不被对方的说法带偏。
// ============================================================

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/** @param {number} n */
export function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 本地日期 YYYY-MM-DD。 @param {Date} [date] */
export function formatLocalDate(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 本地 HH:MM。 @param {Date} date */
export function formatHM(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 把 YYYY-MM-DD 解析成本地零点。 @param {string} day */
export function parseLocalDate(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!match) return new Date(Number.NaN);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** 日期加减天数（按本地日历，跨夏令时也对）。 @param {string} day @param {number} n */
export function addDays(day, n) {
  const date = parseLocalDate(day);
  date.setDate(date.getDate() + n);
  return formatLocalDate(date);
}

/** 两个 YYYY-MM-DD 相差多少天（b − a）。 */
export function daysBetween(a, b) {
  return Math.round((parseLocalDate(b).getTime() - parseLocalDate(a).getTime()) / DAY_MS);
}

/** ISO 周（周一为一周第一天）。 @param {Date} date */
export function isoWeekOf(date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const isoWeek = Math.ceil(((target.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return { isoYear: target.getUTCFullYear(), isoWeek };
}

/** YYYY-Www。 @param {Date} date */
export function isoWeekKey(date) {
  const { isoYear, isoWeek } = isoWeekOf(date);
  return `${isoYear}-W${pad2(isoWeek)}`;
}

/**
 * 她的生活文件用到的几个键。
 * @param {Date} now
 * @returns {{today: string, weekday: string, year: string, month: string, week: string}}
 */
export function lifeKeys(now) {
  return {
    today: formatLocalDate(now),
    weekday: WEEKDAYS[now.getDay()],
    year: String(now.getFullYear()),
    month: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`,
    week: isoWeekKey(now),
  };
}

/** 时段描述（深夜/早上/上午/中午/下午/晚上）。 @param {number} hour */
export function describeDayPart(hour) {
  if (hour < 5) return "深夜";
  if (hour < 9) return "早上";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  if (hour < 23) return "晚上";
  return "深夜";
}

/** 「多久以前」的口语描述。 @param {number} gap 毫秒 */
export function describeGap(gap) {
  if (gap < 10 * MINUTE_MS) return "刚刚，你们还在聊着";
  if (gap < HOUR_MS) return `${Math.round(gap / MINUTE_MS)} 分钟前`;
  if (gap < DAY_MS) return `${Math.round(gap / HOUR_MS)} 小时前`;
  const days = Math.round(gap / DAY_MS);
  return days === 1 ? "昨天" : `${days} 天前`;
}

/** 距离下一个本地零点还有多少毫秒。 @param {Date} now */
export function msUntilNextMidnight(now) {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
}

/** 短的本地时间文字，如 10月3日 14:05。 @param {number} at */
export function formatShortDateTime(at) {
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${formatHM(date)}`;
}

/** 两个时间戳是否在同一本地日。 */
export function sameLocalDay(a, b) {
  return formatLocalDate(new Date(a)) === formatLocalDate(new Date(b));
}

/** [min, max) 内的随机数。 */
export function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}
