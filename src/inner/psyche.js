// ============================================================
// 慢层（merge-inner-engines design §2–§4）：自我感觉、写书与被看见两条张力、生病/加班周/假期、
// 转折记录、掷骰日期、喝酒与深谈时刻、漏一句的窗口。存在 inner.json 的 body.psyche 里。
// 只在三种时刻变化：跨过本地午夜（closeDay）、进入一个日程时段（enterSegment）、收到内核事件。
// 全部是纯函数：不改入参、不读盘、不调模型、不读系统时钟。模型永远看不到这些数字。
// ============================================================

import { addDays, formatLocalDate, HOUR_MS } from "../util/time.js";

export const BASELINE = Object.freeze({ selfWorth: 55 });
export const TURNING_THRESHOLD = 80;
export const TURNING_GAP_DAYS = 14;
export const SEEN_LEAK_RELEASE = -40;
export const DRINK_HOURS = 3;
export const DEEP_TALK_HOURS = 3;
export const POST_TURNING_HOURS = 24;
/** 提示词允许过漏一句之后，多久之内「用玩笑盖过去」才算数。 */
export const LEAK_WINDOW_HOURS = 3;
/** 日结算与进入时段的常量（沿用旧版五体征引擎的手感）。 */
export const DAILY = Object.freeze({ selfWorth: 1, bookNoWriting: 2, bookWriting: -15, seenMissing: 3, seenThreshold: 50, overflowFrom: 60, overflowPerDay: 2 });
const WRITING_DAYS_KEEP = 30;
const MISSING_CAP = 70;

/** 生病 / 加班周 / 假期的参数。drain 只乘在清醒时的消耗上。 */
export const CONDITIONS = Object.freeze({
  cold: { energyCap: 60, drain: 1.3, delayCapMin: 45, proactive: "boosted", label: "感冒" },
  overtime: { energyCap: 100, drain: 1.3, delayCapMin: 45, proactive: "reduced", label: "加班周" },
  vacation: { energyCap: 100, drain: 0.8, delayCapMin: null, proactive: "normal", label: "假期" },
});

/** 记忆整理的事件判断 → 慢层加减。 */
export const EVENT_EFFECTS = Object.freeze({
  praisedByHim: { selfWorth: 5 },
  dismissedByHim: { selfWorth: -8 },
  deflectedIdeal: { book: 5 },
  coveredWithJoke: { seen: 5 },
  deepTalk: { seen: -10 },
  askedAboutHer: { seen: -10 },
});

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const num = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const dayOf = (ms) => formatLocalDate(new Date(ms));

/**
 * 慢层的初始值。seed 可以是旧 inner.json 的顶层（迁移用），缺的字段取默认。
 * @param {{day?: string, slotId?: string | null, legacy?: any}} [options]
 */
export function initialPsyche(options = {}) {
  const legacy = options.legacy ?? {};
  return {
    selfWorth: clamp(num(legacy.vitals?.selfWorth, BASELINE.selfWorth)),
    book: clamp(num(legacy.tensions?.book, 40)),
    seen: clamp(num(legacy.tensions?.seen, 30)),
    condition: validCondition(legacy.condition) ? { kind: legacy.condition.kind, from: legacy.condition.from, until: legacy.condition.until } : null,
    diceDay: typeof legacy.diceDay === "string" ? legacy.diceDay : "",
    lastTurning: legacy.lastTurning && typeof legacy.lastTurning === "object" ? { ...legacy.lastTurning } : {},
    writingDays: Array.isArray(legacy.writingDays) ? legacy.writingDays.filter((day) => typeof day === "string").slice(-WRITING_DAYS_KEEP) : [],
    lastDrinkAt: num(legacy.lastDrinkAt, 0),
    lastDeepTalkAt: num(legacy.lastDeepTalkAt, 0),
    leakOfferedAt: num(legacy.leakOfferedAt, 0),
    closedDay: options.day ?? "",
    lastSlotId: options.slotId ?? null,
  };
}

/** 生病/加班周/假期的形状：{kind, from, until}。 */
export function validCondition(condition) {
  const dayLike = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
  return Boolean(condition && typeof condition === "object" && CONDITIONS[condition.kind] && dayLike(condition.from) && dayLike(condition.until) && condition.from <= condition.until);
}

/** 现在生效的生病/事件（按 until 判断，跨午夜结束不需要事件）。 */
export function activeCondition(psyche, day) {
  const condition = psyche?.condition;
  if (!condition || !CONDITIONS[condition.kind] || day < condition.from || day > condition.until) return null;
  return { ...CONDITIONS[condition.kind], kind: condition.kind, from: condition.from, until: condition.until };
}

export function canTurn(psyche, will, day) {
  const last = psyche?.lastTurning?.[will];
  return !last || addDays(last, TURNING_GAP_DAYS) <= day;
}

/** 意志转折记一笔：日期、时刻、张力释放。 */
export function markTurning(psyche, will, day, release, at) {
  return { ...psyche, lastTurning: { ...psyche.lastTurning, [will]: day, [`${will}At`]: at }, [will]: clamp(psyche[will] + release) };
}

/**
 * 记忆整理的事件判断 → 慢层。漏一句窗口内用玩笑盖过 → 被看见的转折（张力 −40）。
 * @param {any} psyche
 * @param {Record<string, boolean>} events
 * @param {number} at 毫秒
 * @returns {{psyche: any, changes: Record<string, number>, turning: string | null}}
 */
export function applyPsycheEvents(psyche, events, at) {
  let next = { ...psyche, lastTurning: { ...psyche.lastTurning } };
  const changes = {};
  for (const [key, effect] of Object.entries(EVENT_EFFECTS)) {
    if (events?.[key] !== true) continue;
    for (const [target, delta] of Object.entries(effect)) {
      next[target] = clamp(next[target] + delta);
      changes[target] = (changes[target] ?? 0) + delta;
    }
  }
  if (events?.deepTalk === true) next.lastDeepTalkAt = at;
  let turning = null;
  const offeredAt = next.leakOfferedAt ?? 0;
  if (events?.coveredWithJoke === true && offeredAt && at >= offeredAt && at - offeredAt <= LEAK_WINDOW_HOURS * HOUR_MS) {
    next = markTurning(next, "seen", dayOf(at), SEEN_LEAK_RELEASE, at);
    next.leakOfferedAt = 0;
    turning = "seen";
  }
  return { psyche: next, changes, turning };
}

/**
 * 跨过一个午夜：结算刚结束的那一天 endedDay。closedDay 记为新的一天，同一个午夜只结算一次。
 * @param {any} psyche
 * @param {string} endedDay
 * @param {number} missingAtMidnight 午夜时刻派生的想念
 */
export function closeDay(psyche, endedDay, missingAtMidnight) {
  const newDay = addDays(endedDay, 1);
  if (psyche.closedDay && psyche.closedDay >= newDay) return { psyche, closed: false };
  const next = { ...psyche, lastTurning: { ...psyche.lastTurning } };
  const gap = BASELINE.selfWorth - next.selfWorth;
  next.selfWorth = clamp(next.selfWorth + Math.sign(gap) * Math.min(DAILY.selfWorth, Math.abs(gap)));
  if (!(next.writingDays ?? []).includes(endedDay)) next.book = clamp(next.book + DAILY.bookNoWriting);
  if ((missingAtMidnight ?? 0) >= DAILY.seenThreshold) next.seen = clamp(next.seen + DAILY.seenMissing);
  // 被看见在高位却没有漏出来（当天没有转折）：堵住的出口把力气让给写书。
  if (next.seen >= DAILY.overflowFrom && next.lastTurning?.seen !== endedDay) {
    next.seen = clamp(next.seen - DAILY.overflowPerDay);
    next.book = clamp(next.book + DAILY.overflowPerDay);
  }
  next.closedDay = newDay;
  return { psyche: next, closed: true };
}

/**
 * 进入一个日程时段的一次性效果，按 slotId 去重：写作 → 写书张力 −15 并记写作日；喝酒 → 记喝酒时刻。
 * @param {any} psyche
 * @param {{slotId?: string | null, tag?: string} | null} segment
 * @param {number} at 进入时刻（毫秒）
 */
export function enterSegment(psyche, segment, at) {
  const slotId = segment?.slotId ?? null;
  if (!slotId || slotId === psyche.lastSlotId) return { psyche, entered: false };
  const next = { ...psyche, lastSlotId: slotId };
  if (segment.tag === "写作") {
    next.book = clamp(next.book + DAILY.bookWriting);
    const day = dayOf(at);
    if (!(next.writingDays ?? []).includes(day)) next.writingDays = [...(next.writingDays ?? []), day].slice(-WRITING_DAYS_KEEP);
  }
  if (segment.tag === "喝酒") next.lastDrinkAt = at;
  return { psyche: next, entered: true };
}

export { MISSING_CAP };
