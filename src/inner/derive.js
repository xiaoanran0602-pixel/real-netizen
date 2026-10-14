// ============================================================
// 派生读数（merge-inner-engines design §5）：想念、饱腹、防线。存储只会带来不同步，所以一律在读取时算。
//   deriveMissing  ← 念头池里「他留下、还没闭合」的念头（饱和曲线，边际递减）
//   deriveFullness ← 上一顿饭（进入「吃饭」时段）之后醒着/睡着各多久
//   deriveGuard    ← 张力、精力、钟点、喝酒、深谈
// 纯函数：不读盘、不读系统时钟。
// ============================================================

import { HOUR_MS } from "../util/time.js";
import { activeSegment, effectiveFrom } from "./body-drivers.js";
import { activeCondition, DEEP_TALK_HOURS, DRINK_HOURS, MISSING_CAP } from "./psyche.js";

export const MISSING_SCALE = 120;
export const FULLNESS = Object.freeze({ meal: 90, awakePerHour: -12, asleepPerHour: -3, unknown: 60 });
export const GUARD = Object.freeze({ tensionFrom: 20, tensionWeight: 0.8, energyFrom: 60, energyWeight: 0.5, lateNight: 15, drink: 15, deepTalk: 10 });

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));

/**
 * 念头是否已经闭合。念头池闭合时标 closed=true（thoughts.js 的 applyExtract）；
 * 更早的数据没有这个字段：按「改成 fade、去掉 affect、原来有闭合条件」推断。
 */
export function isClosedThought(thought) {
  if (typeof thought?.closed === "boolean") return thought.closed;
  return thought?.decay === "fade" && !thought.affect && thought.closes_on != null;
}

/** 念头池 → 内核时间线里的精简念头（身体负荷与想念都只读这几个字段）。 */
export function kernelThoughts(thoughts) {
  return (thoughts ?? []).map((thought) => ({ id: thought.id, source: thought.source, strength: thought.strength, closed: isClosedThought(thought), ...(thought.affect ? { affect: thought.affect } : {}) }));
}

/**
 * 想念 = 100 × (1 − e^(−L/120))，L 是来源为「他」且未闭合的念头强度之和。生病中 × sickMissCap/70，上限 100。
 * @param {any[]} thoughts
 * @param {any} psyche
 * @param {string} day
 * @param {number} [sickMissCap]
 */
export function deriveMissing(thoughts, psyche, day, sickMissCap = 85) {
  const load = (thoughts ?? []).filter((thought) => thought?.source === "him" && !isClosedThought(thought)).reduce((sum, thought) => sum + Math.max(0, Number(thought.strength) || 0), 0);
  let missing = 100 * (1 - Math.exp(-load / MISSING_SCALE));
  if (activeCondition(psyche, day)?.kind === "cold") missing = Math.min(100, (missing * sickMissCap) / MISSING_CAP);
  return clamp(missing);
}

/**
 * 时间线 → 按生效时刻切开的区间表（区间内采用的段不变）。每个 segments 数组只算一次，
 * 推进时每个 5 秒小段都要读饱腹，不能每次都从头扫。
 */
const INTERVALS = new WeakMap();
function intervalsOf(segments) {
  const list = segments ?? [];
  const cached = INTERVALS.get(list);
  if (cached) return cached;
  const edges = [...new Set(list.map(effectiveFrom))].sort((a, b) => a - b);
  const intervals = [];
  for (const from of edges) {
    const segment = activeSegment(list, from).segment;
    const previous = intervals.at(-1);
    if (previous && previous.slotId === segment?.slotId) continue;
    intervals.push({ from, slotId: segment?.slotId ?? null, meal: segment?.tag === "吃饭", asleep: Boolean(segment?.asleep) });
  }
  INTERVALS.set(list, intervals);
  return intervals;
}

/** 最近一个已生效的「吃饭」段的开始时刻（它必须是当时采用的段）；找不到返回 null。 */
export function lastMealAt(segments, nowMs) {
  const intervals = intervalsOf(segments);
  for (let index = intervals.length - 1; index >= 0; index -= 1) {
    if (intervals[index].from <= nowMs && intervals[index].meal) return intervals[index].from;
  }
  return null;
}

/**
 * 饱腹 ≈ 90 − 12 × 清醒小时 − 3 × 睡眠小时，夹在 0–100。时间线里找不到吃饭时段按 60。
 * @param {any[]} segments
 * @param {number} nowMs
 */
export function deriveFullness(segments, nowMs) {
  const intervals = intervalsOf(segments);
  let index = -1;
  for (let i = intervals.length - 1; i >= 0; i -= 1) {
    if (intervals[i].from <= nowMs && intervals[i].meal) {
      index = i;
      break;
    }
  }
  if (index < 0) return FULLNESS.unknown;
  let fullness = FULLNESS.meal;
  for (let i = index; i < intervals.length && intervals[i].from < nowMs; i += 1) {
    const end = Math.min(nowMs, intervals[i + 1]?.from ?? nowMs);
    fullness += ((intervals[i].asleep ? FULLNESS.asleepPerHour : FULLNESS.awakePerHour) * (end - intervals[i].from)) / HOUR_MS;
    if (fullness <= 0) return 0;
  }
  return clamp(fullness);
}

/**
 * 防线 = 100 − 0.8·max(0, T − 20) − 0.5·max(0, 60 − E)；0–3 点 −15；喝酒后 3 小时 −15；深谈后 3 小时 −10。
 * @param {{energy: number, tension: number}} values
 * @param {any} psyche
 * @param {number} nowMs
 */
export function deriveGuard(values, psyche, nowMs) {
  let guard = 100 - GUARD.tensionWeight * Math.max(0, (values?.tension ?? 0) - GUARD.tensionFrom) - GUARD.energyWeight * Math.max(0, GUARD.energyFrom - (values?.energy ?? 100));
  const hour = new Date(nowMs).getHours();
  if (hour >= 0 && hour < 3) guard -= GUARD.lateNight;
  const within = (at, hours) => Boolean(at) && nowMs >= at && nowMs - at < hours * HOUR_MS;
  if (within(psyche?.lastDrinkAt, DRINK_HOURS)) guard -= GUARD.drink;
  if (within(psyche?.lastDeepTalkAt, DEEP_TALK_HOURS)) guard -= GUARD.deepTalk;
  return clamp(guard);
}
