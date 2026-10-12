// ============================================================
// 活人感内核的数值（docs/12 第 3、6、7、9 节）：五个体征、两条意志张力、防线。纯函数。
// 结算是惰性的：给「上次状态 + 上次结算时间 → 现在」和每一天的日程时段，逐段补算，结果和心跳是否按时无关。
// 所有常量集中在这里；模型永远看不到这些数字（见 mapping.js）。
// ============================================================

import { addDays, formatLocalDate, HOUR_MS, MINUTE_MS } from "../util/time.js";
import { isAsleep, slotAt } from "./tags.js";

export const STEP_MINUTES = 15;
const STEP_HOURS = STEP_MINUTES / 60;
const MAX_SETTLE_DAYS = 800;

export const BASELINE = Object.freeze({ stress: 30, selfWorth: 55 });
export const RATES = Object.freeze({
  energyAwake: -5, energyOvertime: -8, energySleep: 12, exerciseHit: -10,
  fullnessAwake: -12, fullnessAsleep: -3, fullnessMeal: 90,
  stressRecover: 3, stressOvertime: 15, stressRelief: { 天文台: -10, 写作: -5, 运动: -8 }, stressWeekend: -10,
  missingSilenceHours: 4, missingPerHour: 2, missingPerTurn: -10, missingSessionMax: -30,
  selfWorthDaily: 1,
  bookNoWritingDaily: 2, bookWriting: -15, seenMissingDaily: 3, seenThreshold: 50, overflowPerDay: 2, overflowFrom: 60,
});
export const MISSING_CAP = 70;
export const SLEEP_QUALITY_CAP = Object.freeze({ good: 100, ok: 85, bad: 65 });
export const SESSION_GAP_MS = 30 * MINUTE_MS;
export const TURNING_THRESHOLD = 80;
export const TURNING_GAP_DAYS = 14;
export const SEEN_LEAK_RELEASE = -40;
export const DRINK_HOURS = 3;
export const POST_TURNING_HOURS = 24;

/** 生病 / 加班周 / 假期的参数（第 9 节）。missingCap 为 null 时用设置里的 sickMissCap。 */
export const CONDITIONS = Object.freeze({
  cold: { energyCap: 60, drain: 1.3, missingCap: null, missingRate: 1.5, delayCapMin: 45, proactive: "boosted", label: "感冒" },
  overtime: { energyCap: 100, drain: 1.3, missingCap: MISSING_CAP, missingRate: 0.5, delayCapMin: 45, proactive: "reduced", label: "加班周" },
  vacation: { energyCap: 100, drain: 0.8, missingCap: MISSING_CAP, missingRate: 1, delayCapMin: null, proactive: "normal", label: "假期" },
});

/** 聊天后事件 → 加减（第 3、6 节）。 */
export const EVENT_EFFECTS = Object.freeze({
  praisedByHim: { selfWorth: 5 },
  dismissedByHim: { selfWorth: -8 },
  deflectedIdeal: { book: 5 },
  coveredWithJoke: { seen: 5 },
  deepTalk: { seen: -10 },
  askedAboutHer: { seen: -10 },
});

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));

export function initialInner(now = Date.now()) {
  return {
    vitals: { energy: 70, fullness: 60, stress: BASELINE.stress, missing: 30, selfWorth: BASELINE.selfWorth },
    tensions: { book: 40, seen: 30 },
    lastSettledAt: now,
    sleepQuality: {},
    condition: null,
    lastTurning: {},
    session: null,
    lastDrinkAt: 0,
    lastSlotKey: "",
    writingDays: [],
  };
}

/** 现在生效的生病/事件。 */
export function activeCondition(state, day) {
  const condition = state.condition;
  if (!condition || day < condition.from || day > condition.until) return null;
  return { ...CONDITIONS[condition.kind], kind: condition.kind, until: condition.until };
}

export function missingCap(state, day, sickMissCap = 85) {
  const condition = activeCondition(state, day);
  if (!condition) return MISSING_CAP;
  return condition.missingCap ?? sickMissCap;
}

function energyCap(state, day) {
  const quality = state.sleepQuality?.[day] ?? "ok";
  return Math.min(SLEEP_QUALITY_CAP[quality] ?? 85, activeCondition(state, day)?.energyCap ?? 100);
}

/** 进入一个新时段时的一次性影响。 */
function enterSlot(state, tag, at, reasons) {
  const v = state.vitals;
  if (tag === "吃饭") v.fullness = RATES.fullnessMeal;
  if (tag === "加班" || tag === "截止") v.stress = clamp(v.stress + RATES.stressOvertime);
  if (RATES.stressRelief[tag]) v.stress = clamp(v.stress + RATES.stressRelief[tag]);
  if (tag === "运动") v.energy = clamp(v.energy + RATES.exerciseHit);
  if (tag === "写作") {
    state.tensions.book = clamp(state.tensions.book + RATES.bookWriting);
    const day = formatLocalDate(new Date(at));
    if (!state.writingDays.includes(day)) state.writingDays = [...state.writingDays, day].slice(-30);
  }
  if (tag === "喝酒") state.lastDrinkAt = at;
  if (["吃饭", "加班", "截止", "写作", "天文台", "运动"].includes(tag)) reasons.push({ at, kind: "slot", tag });
}

/** 跨过一天（午夜）时的日结算：自我感觉回归、张力积累、溢流。 */
function closeCalendarDay(state, endedDay, reasons, options) {
  const v = state.vitals;
  const t = state.tensions;
  v.selfWorth += Math.sign(BASELINE.selfWorth - v.selfWorth) * Math.min(RATES.selfWorthDaily, Math.abs(BASELINE.selfWorth - v.selfWorth));
  if (!state.writingDays.includes(endedDay)) t.book = clamp(t.book + RATES.bookNoWritingDaily);
  if (v.missing >= RATES.seenThreshold) t.seen = clamp(t.seen + RATES.seenMissingDaily);
  // 叔本华：堵住的出口把张力让给开着的出口——说不出口的写进书里。
  // 修复：原来只在“距上次转折不满 14 天”时算堵住，漏掉了文档 6.1 的另一半（防线不薄、漏不出来）。
  // 改为按结果判断：这一天“被看见”在高位却没有漏出来（当天没有转折），就算堵住。
  const seenBlocked = t.seen >= RATES.overflowFrom && state.lastTurning?.seen !== endedDay;
  if (seenBlocked && options.allowOverflow !== false) {
    t.seen = clamp(t.seen - RATES.overflowPerDay);
    t.book = clamp(t.book + RATES.overflowPerDay);
  }
  reasons.push({ day: endedDay, kind: "day", book: Math.round(t.book), seen: Math.round(t.seen), selfWorth: Math.round(v.selfWorth) });
}

export function canTurn(state, will, day) {
  const last = state.lastTurning?.[will];
  return !last || addDays(last, TURNING_GAP_DAYS) <= day;
}

/**
 * 惰性结算：从 state.lastSettledAt 推到 to。返回新状态与变化原因（不改入参）。
 * 修复：分段点对齐到「15 分钟网格 / 日程时段起点 / 想念开始累积的时刻」，
 * 否则心跳时机不同会让结果有细微差别（违反“和心跳是否按时无关”）。线性变化 + 夹取在对齐的分段上可任意拆分，结果一致。
 * @param {any} input
 * @param {number} to 毫秒
 * @param {{slotsFor: (day: string) => any[], lastUserMessageAt?: number, sickMissCap?: number}} options
 */
export function settle(input, to, options) {
  const state = structuredClone(input);
  const reasons = [];
  let at = Math.max(state.lastSettledAt ?? to, to - MAX_SETTLE_DAYS * 24 * HOUR_MS);
  const stepMs = STEP_MINUTES * MINUTE_MS;
  const lastUser = options.lastUserMessageAt ?? 0;
  const missingFrom = lastUser > 0 ? lastUser + RATES.missingSilenceHours * HOUR_MS : -Infinity;
  let currentDay = formatLocalDate(new Date(at));
  while (at < to) {
    const date = new Date(at);
    const day = formatLocalDate(date);
    if (day !== currentDay) {
      closeCalendarDay(state, currentDay, reasons, options);
      if ([0, 6].includes(date.getDay())) state.vitals.stress = clamp(state.vitals.stress + RATES.stressWeekend);
      currentDay = day;
    }
    const slots = options.slotsFor(day);
    const minute = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
    const slot = slotAt(slots, Math.floor(minute));
    const key = `${day}|${slot.start}`;
    if (key !== state.lastSlotKey) {
      state.lastSlotKey = key;
      enterSlot(state, slot.tag, at, reasons);
    }
    // 本段终点：下一个网格点、下一个时段起点、午夜、想念开始时刻、to，取最早。
    const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
    const nextSlot = slots.find((item) => item.start > minute);
    const slotBoundary = nextSlot ? new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, nextSlot.start).getTime() : midnight;
    const grid = Math.floor(at / stepMs) * stepMs + stepMs;
    const end = Math.min(to, grid, midnight, slotBoundary, missingFrom > at ? missingFrom : Infinity);
    const dt = (end - at) / HOUR_MS;
    const v = state.vitals;
    const condition = activeCondition(state, day);
    const drain = condition?.drain ?? 1;
    if (isAsleep(slot.tag)) {
      v.energy = Math.max(v.energy, Math.min(energyCap(state, day), v.energy + RATES.energySleep * dt));
      v.fullness = clamp(v.fullness + RATES.fullnessAsleep * dt);
    } else {
      const rate = slot.tag === "加班" ? RATES.energyOvertime : RATES.energyAwake;
      v.energy = clamp(Math.min(v.energy, energyCap(state, day)) + rate * drain * dt);
      v.fullness = clamp(v.fullness + RATES.fullnessAwake * dt);
    }
    const toward = BASELINE.stress - v.stress;
    v.stress = clamp(v.stress + Math.sign(toward) * Math.min(Math.abs(toward), RATES.stressRecover * dt));
    const cap = missingCap(state, day, options.sickMissCap);
    if (at >= missingFrom || lastUser === 0) v.missing = Math.min(cap, v.missing + RATES.missingPerHour * (condition?.missingRate ?? 1) * dt);
    if (v.missing > cap) v.missing = cap;
    at = end;
  }
  state.lastSettledAt = to;
  return { state, reasons };
}

/** 他来聊了一轮：想念 −10，同一次会话（间隔 < 30 分钟）最多 −30。 */
export function applyUserTurn(input, at) {
  const state = structuredClone(input);
  const session = state.session && at - state.session.lastAt < SESSION_GAP_MS ? state.session : { startedAt: at, dropped: 0, lastAt: at };
  const allowed = Math.max(RATES.missingSessionMax - session.dropped, RATES.missingPerTurn);
  const drop = Math.max(-state.vitals.missing, allowed);
  state.vitals.missing = clamp(state.vitals.missing + drop);
  state.session = { ...session, dropped: session.dropped + drop, lastAt: at };
  return { state, reason: { at, kind: "turn", missing: Math.round(drop) } };
}

/** 聊天后事件判断 → 自我感觉与张力。 */
export function applyEvents(input, events, at) {
  const state = structuredClone(input);
  const changes = {};
  for (const [key, effect] of Object.entries(EVENT_EFFECTS)) {
    if (events?.[key] !== true) continue;
    for (const [target, delta] of Object.entries(effect)) {
      if (target === "selfWorth") state.vitals.selfWorth = clamp(state.vitals.selfWorth + delta);
      else state.tensions[target] = clamp(state.tensions[target] + delta);
      changes[target] = (changes[target] ?? 0) + delta;
    }
  }
  return { state, reason: Object.keys(changes).length > 0 ? { at, kind: "events", events: Object.keys(events).filter((k) => events[k]), changes } : null };
}

/**
 * 防线（第 7 节）。
 * @param {{energy: number, stress: number}} vitals
 */
export function computeGuard(vitals, now, lastDrinkAt = 0) {
  const date = new Date(now);
  const hour = date.getHours();
  let guard = 100 - Math.max(0, vitals.stress - BASELINE.stress) * 0.6 - Math.max(0, 60 - vitals.energy) * 0.5;
  if (hour >= 0 && hour < 3) guard -= 15;
  if (lastDrinkAt && now - lastDrinkAt < DRINK_HOURS * HOUR_MS) guard -= 15;
  return clamp(guard);
}

/** 意志转折记一笔：时间、张力释放。 */
export function markTurning(input, will, day, release) {
  const state = structuredClone(input);
  state.lastTurning = { ...state.lastTurning, [will]: day, [`${will}At`]: Date.now() };
  state.tensions[will] = clamp(state.tensions[will] + release);
  return state;
}
