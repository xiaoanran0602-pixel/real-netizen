// ============================================================
// 身体内核的输入规范化（docs/14 第 4 节）。把日程、天气、念头负荷变成可计算的驱动。
// 关键区别（docs/14 第 2 节）：驱动是持续的背景（在多久就作用多久），扰动是一次性冲击。
//
// 日程：生成时只登记未来的驱动，走到某一段才采用；「实际：」只从采用时刻往后生效，
//       绝不用刚生成的计划倒灌已经历过的时间（docs/14 第 4.1 节第 3、4 条）。
// 天气：W = 偏好 × freshness；观测 30 分钟内为 1，6 小时后为 0；缺失或城市不符为 0。
//       必须用真实的观测时间，不能拿「刷新时间」冒充（docs/14 第 4.3 节）。
// 念头：U = clamp(top3(strength/100 × demand) 之和 / 2, 0, 1)。
// ============================================================

import { MINUTE_MS } from "../util/time.js";
import { BODY_PARAMS, paramTag } from "./body.js";

export const WEATHER_FRESH_MS = 30 * MINUTE_MS;
export const WEATHER_MAX_AGE_MS = 6 * 60 * MINUTE_MS;
export const EXPECTED_LOAD_WINDOW_MIN = 60;

/** 日程段 → 驱动。时区沿用本机，跨日不重置身体状态。version=0 表示兜底作息。 */
export function normalizeSchedule(slots, { date, adoptedAt, version = 1, provenance = "simulation_plan" }) {
  return (slots ?? []).map((slot, index) => {
    const params = paramTag(slot.tag);
    const startMin = slot.start;
    return {
      slotId: `${date}#${version}#${index}`,
      day: date,
      startAt: new Date(`${date}T00:00:00`).getTime() + startMin * MINUTE_MS,
      endAt: null,
      tag: slot.tag,
      load: params.load,
      recovery: params.recovery,
      physical: params.physical,
      interest: 0,
      asleep: slot.tag === "睡觉",
      actual: Boolean(slot.actual),
      provenance,
      version,
      adoptedAt,
    };
  });
}

/** 补上每段的结束时刻（同一来源里下一段的开始）。 */
export function closeSegments(segments) {
  return segments.map((segment, index) => {
    const next = segments.slice(index + 1).find((item) => item.day === segment.day && item.version === segment.version);
    return { ...segment, endAt: next?.startAt ?? segment.startAt + 24 * 60 * MINUTE_MS };
  });
}

/** 未采用计划时的中性段：相当于「空着」，不会凭空给出负荷。 */
const NEUTRAL_SEGMENT = Object.freeze({ slotId: null, startAt: 0, endAt: 0, tag: "空闲", load: 0, recovery: 0.2, physical: 0, interest: 0, asleep: false, actual: false, provenance: "fallback", version: 0, adoptedAt: 0 });

/**
 * 当前时刻采用的段。
 * 一段在 max(段开始, 采用时刻) 之后才生效，采用之前不走它的驱动——
 * 否则「中午才生成日程」会把刚写的早晨争执倒灌进已经历的时间（docs/14 第 4.1 节第 3、4 条）。
 * 多个来源同时生效时：先比日期（新的一天优先），再比版本（采用的计划 > 兜底作息），最后取最晚开始的段。
 */
export function activeSegment(segments, nowMs) {
  let current = null;
  const better = (a, b) => (a.day ?? "") !== (b.day ?? "") ? (a.day ?? "") > (b.day ?? "") : a.version !== b.version ? a.version > b.version : a.startAt > b.startAt;
  for (const segment of segments) {
    if (segment.startAt > nowMs || (Number(segment.adoptedAt) || 0) > nowMs) continue;
    if (!current || better(segment, current)) current = segment;
  }
  if (!current) return { segment: NEUTRAL_SEGMENT, fromAt: nowMs, until: nowMs };
  const fromAt = effectiveFrom(current);
  return { segment: current, fromAt, until: Math.max(fromAt, current.endAt ?? nowMs) };
}

export function effectiveFrom(segment) {
  const adopted = Number(segment.adoptedAt) || 0;
  return Math.max(segment.startAt ?? 0, adopted > (segment.startAt ?? 0) ? adopted : segment.startAt ?? 0);
}

/**
 * 未来一小时的预期负荷 F（docs/14 第 4.2 节）：只取最大的一项，不相加。
 * 修复：只用「此刻已经被采用」的计划里的未来段——中午才生成的计划不能回填 11 点的准备压力，
 * 否则就是拿后写的日程倒灌已经历的时间（违反第 4.1 节第 3、4 条）。
 */
export function expectedLoad(segments, nowMs) {
  let best = 0;
  for (const segment of segments) {
    if ((Number(segment.adoptedAt) || 0) > nowMs) continue;
    if (segment.startAt <= nowMs) continue;
    const minutes = (segment.startAt - nowMs) / MINUTE_MS;
    if (minutes > EXPECTED_LOAD_WINDOW_MIN) continue;
    best = Math.max(best, segment.load * (1 - minutes / EXPECTED_LOAD_WINDOW_MIN));
  }
  return Math.max(0, Math.min(1, best));
}

/** 天气的独立贡献：不超过偏好绝对值（默认 ±4），并按观测年龄褪色。code 可以是 WMO 代码或已分类的 kind。 */
export function weatherLoad(world, city, nowMs) {
  const raw = world?.weather?.kind ?? world?.weather?.code;
  const kind = typeof raw === "number" ? kindOfCode(raw) : String(raw ?? "").toLowerCase();
  const observedAt = Number(world?.weatherObservedAt) || 0;
  const sameCity = !world?.city || world.city === city;
  if (!kind || !observedAt || !sameCity) return 0;
  const age = nowMs - observedAt;
  if (age > WEATHER_MAX_AGE_MS) return 0;
  const freshness = age <= WEATHER_FRESH_MS ? 1 : 1 - (age - WEATHER_FRESH_MS) / (WEATHER_MAX_AGE_MS - WEATHER_FRESH_MS);
  const preference = BODY_PARAMS.weatherPreference[kind] ?? 0;
  return preference * Math.max(0, Math.min(1, freshness));
}

/**
 * 念头负荷 U（docs/14 第 4.4 节）：未闭合、有 demand 的念头，取最高的三项。
 * @param {any[]} thoughts
 */
export function thoughtLoad(thoughts) {
  const demands = (thoughts ?? [])
    .filter((thought) => !thought.closed && (thought.affect?.demand ?? 0) > 0)
    .map((thought) => ((thought.strength ?? 0) / 100) * thought.affect.demand)
    .sort((a, b) => b - a)
    .slice(0, 3);
  return clamp(demands.reduce((sum, value) => sum + value, 0) / 2, 0, 1);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** WMO 天气代码 → 天气偏好表里的分类（与 moments/world.js 的 weatherKind 一致，这里不反向依赖它）。 */
function kindOfCode(code) {
  if (code <= 2) return "clear";
  if (code === 3) return "overcast";
  if (code <= 48) return "fog";
  if (code <= 67 || (code >= 80 && code <= 82)) return "rain";
  if (code <= 86) return "snow";
  return "storm";
}
