// ============================================================
// 身体内核的推进（docs/14 第 5、7 节；merge-inner-engines design §3）。
//   advanceBody(body, toMs, timeline, params)
//     timeline 是「已知输入的时间线」：日程段、天气、念头负荷（以及生病时想念的放大系数 sickMissCap）。
//     每个小段用「该段开始时」的同一份输入算目标与速率（docs/14 第 7.2 节）：
//     段的终点取「下个网格、日程边界、日程采用时刻、本地午夜、目标时刻」里最早者，
//     半段不重算系数，下一次从保存的终点继续。
//   慢层挂在同一条补算路径上：每走完一小段调用 psycheStep——
//     进入新时段（按 slotId 去重）触发一次性效果；段终点正好落在午夜时做日结算（按 closedDay 去重）。
//     午夜是硬边界，所以 5 秒心跳、15 秒心跳、离线补算（含 72 小时以上的粗网格）结果一致。
//   超过 72 小时的补算：较早部分用 60 秒网格近似，最后 72 小时回到 5 秒网格，
//   结果里标 catchupMode=coarse（docs/14 第 7.3 节）。纯函数：不改入参、不读盘、不调模型。
// ============================================================

import { formatLocalDate, HOUR_MS, MINUTE_MS } from "../util/time.js";
import { bandsOf, BODY_PARAMS, COARSE_AFTER_MS, COARSE_GRID_MS, createBody, GRID_MS, stepWithTargets, targetsOf } from "./body.js";
import { activeSegment, effectiveFrom, expectedLoad, thoughtLoad, weatherLoad } from "./body-drivers.js";
import { deriveFullness, deriveMissing } from "./derive.js";
import { activeCondition, closeDay, enterSegment, initialPsyche } from "./psyche.js";

const MAX_STEPS = 2_000_000;
const HUNGER_FROM = 30;

const dayOf = (ms) => formatLocalDate(new Date(ms));

/** ms 之后（严格大于）的下一个本地午夜。 */
export function nextMidnight(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function isMidnight(ms) {
  const date = new Date(ms);
  return date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0;
}

/**
 * 某个时刻的驱动输入。psyche 给出生病/加班周/假期；饱腹由时间线派生，饿了才有 hunger。
 * @param {{segments?: any[], world?: any, city?: string, thoughts?: any[]}} timeline
 * @param {number} nowMs
 * @param {any} [psyche]
 */
export function driversAt(timeline, nowMs, psyche = null) {
  const { segment, fromAt } = activeSegment(timeline.segments ?? [], nowMs);
  const asleep = Boolean(segment?.asleep) || !segment;
  const condition = psyche ? activeCondition(psyche, dayOf(nowMs)) : null;
  const fullness = deriveFullness(timeline.segments ?? [], nowMs);
  return {
    segment,
    adoptedFrom: fromAt,
    asleep,
    load: asleep ? 0 : segment?.load ?? 0,
    recovery: asleep ? 0 : segment?.recovery ?? 0,
    physical: asleep ? 0 : segment?.physical ?? 0,
    interest: segment?.interest ?? 0,
    weather: weatherLoad(timeline.world, timeline.city, nowMs),
    thoughtLoad: thoughtLoad(timeline.thoughts ?? []),
    expectedLoad: asleep ? 0 : expectedLoad(timeline.segments ?? [], nowMs),
    condition,
    fullness,
    hunger: Math.max(0, Math.min(1, (HUNGER_FROM - fullness) / HUNGER_FROM)),
  };
}

/** 小段终点：下个网格、目标时刻、日程边界、日程采用时刻、本地午夜里最早的那个。 */
function nextBoundary(atMs, toMs, gridMs, segments) {
  // 修复：原来用 ceil 取网格点，恰好对齐时得到 atMs 自身，会一步跨到 to，
  // 导致 5 秒心跳和 15 秒心跳结果不一致（违反 docs/14 第 7.2 节）。改成严格下一个网格点。
  let best = Math.min(toMs, Math.floor(atMs / gridMs) * gridMs + gridMs, nextMidnight(atMs));
  for (const segment of segments) {
    const edge = effectiveFrom(segment);
    if (edge > atMs && edge < best) best = edge;
  }
  return Math.max(atMs + 1, best);
}

/**
 * 慢层的一步（段终点调用）。
 *   1. 进入新时段（drivers.segment.slotId 与 psyche.lastSlotId 不同）：触发一次性效果，时刻取该段生效的时刻；
 *   2. 段终点正好是午夜、且这一天还没结算：日结算，想念取午夜时刻从念头池派生的值。
 * @param {any} psyche
 * @param {any} drivers 段开始时的驱动
 * @param {number} atEnd 段终点
 * @param {{thoughts?: any[], sickMissCap?: number}} timeline
 * @returns {{psyche: any, reasons: any[]}}
 */
export function psycheStep(psyche, drivers, atEnd, timeline) {
  let next = psyche;
  const reasons = [];
  const entered = enterSegment(next, drivers.segment, drivers.adoptedFrom);
  if (entered.entered) {
    next = entered.psyche;
    if (drivers.segment.tag === "写作" || drivers.segment.tag === "喝酒") reasons.push({ at: drivers.adoptedFrom, kind: "slot", tag: drivers.segment.tag });
  }
  if (isMidnight(atEnd) && next.closedDay !== dayOf(atEnd)) {
    const endedDay = dayOf(atEnd - 1);
    const missing = deriveMissing(timeline.thoughts ?? [], next, endedDay, timeline.sickMissCap);
    const closed = closeDay(next, endedDay, missing);
    if (closed.closed) {
      next = closed.psyche;
      reasons.push({ at: atEnd, kind: "day", day: endedDay, book: Math.round(next.book), seen: Math.round(next.seen), selfWorth: Math.round(next.selfWorth) });
    }
  }
  return { psyche: next, reasons };
}

/**
 * 推进到 to。返回 {body, reasons, catchupMode, steps}。
 * @param {any} body
 * @param {number} toMs
 * @param {{segments: any[], world: any, city: string, thoughts: any[], sickMissCap?: number}} timeline
 */
export function advanceBody(body, toMs, timeline, params = BODY_PARAMS) {
  const valuesIn = { ...body.values };
  const psycheIn = body.psyche ?? initialPsyche({ day: dayOf(body.at) });
  if (!Number.isFinite(toMs) || toMs <= body.at) return { body: { ...body, values: valuesIn, psyche: psycheIn }, reasons: [], catchupMode: "none", steps: 0 };
  const segments = timeline.segments ?? [];
  const span = toMs - body.at;
  const catchupMode = span > COARSE_AFTER_MS ? "coarse" : "grid";
  let values = valuesIn;
  let psyche = psycheIn;
  let at = body.at;
  let steps = 0;
  const reasons = [];
  if (catchupMode === "coarse") reasons.push({ at: toMs, kind: "mode", catchupMode });
  let lastTag = driversAt(timeline, at, psyche).segment?.tag ?? null;
  while (at < toMs && steps < MAX_STEPS) {
    steps += 1;
    // 早期部分用 60 秒网格，最后 72 小时回到 5 秒网格。
    const gridMs = toMs - at > COARSE_AFTER_MS ? COARSE_GRID_MS : GRID_MS;
    const drivers = driversAt(timeline, at, psyche);
    const targets = targetsOf(values, drivers);
    const end = Math.min(nextBoundary(at, toMs, gridMs, segments), toMs);
    const minutes = Math.max(0, (end - at) / MINUTE_MS);
    if (minutes > 0) values = stepWithTargets(values, targets, minutes, params.halfLifeMin);
    const step = psycheStep(psyche, drivers, end, timeline);
    psyche = step.psyche;
    reasons.push(...step.reasons);
    const tag = drivers.segment?.tag ?? null;
    if (tag !== lastTag) {
      reasons.push({ at: end, kind: "segment", tag, slotId: drivers.segment?.slotId ?? null, targets: { ...targets } });
      lastTag = tag;
    }
    at = end;
  }
  const tail = driversAt(timeline, toMs, psyche);
  const tailTargets = targetsOf(values, tail);
  return {
    body: {
      ...body,
      at: toMs,
      values,
      psyche,
      segment: { until: toMs, targets: { valence: tailTargets.valence, activation: tailTargets.activation, tension: tailTargets.tension }, energyRatePerHour: tailTargets.energyRatePerHour },
      bands: bandsOf(values, body.bands, { fullness: tail.fullness }),
    },
    reasons,
    catchupMode,
    steps,
  };
}

/** 只读投影：在副本上按同样的规则推进，不提交事件、不影响出口（docs/14 第 7.2 节第 5 条）。 */
export function projectBody(body, toMs, timeline, params = BODY_PARAMS) {
  return advanceBody({ ...body, values: { ...body.values }, impulseWindow: [...(body.impulseWindow ?? [])] }, toMs, timeline, params).body;
}

export { createBody, HOUR_MS };
