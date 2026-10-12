// ============================================================
// 身体内核的推进（docs/14 第 5、7 节）。
//   advanceBody(body, toMs, timeline, params)
//     timeline 是「已知输入的时间线」：日程段、天气、念头负荷。
//     每个小段用「该段开始时」的同一份输入算目标与速率（docs/14 第 7.2 节）：
//     段的终点取「下个网格、日程边界、日程采用时刻、目标时刻」里最早者，
//     半段不重算系数，下一次从保存的终点继续。
//   网格固定 5 秒：5 秒心跳、15 秒心跳、离线补算走同一条路径，结果与调度频率无关。
//   超过 72 小时的补算：较早部分用 60 秒网格近似，最后 72 小时回到 5 秒网格，
//   结果里标 catchupMode=coarse（docs/14 第 7.3 节）。纯函数：不改入参、不读盘、不调模型。
// ============================================================

import { HOUR_MS, MINUTE_MS } from "../util/time.js";
import { bandsOf, BODY_PARAMS, COARSE_AFTER_MS, COARSE_GRID_MS, GRID_MS, stepWithTargets, targetsOf } from "./body.js";
import { activeSegment, effectiveFrom, expectedLoad, thoughtLoad, weatherLoad } from "./body-drivers.js";

const MAX_STEPS = 2_000_000;

/** 某个时刻的驱动输入。 */
export function driversAt(timeline, nowMs) {
  const { segment, fromAt } = activeSegment(timeline.segments ?? [], nowMs);
  const asleep = Boolean(segment?.asleep) || !segment;
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
  };
}

/** 小段终点：下个网格、目标时刻、日程边界、日程采用时刻里最早的那个。 */
function nextBoundary(atMs, toMs, gridMs, segments) {
  // 修复：原来用 ceil 取网格点，恰好对齐时得到 atMs 自身，会一步跨到 to，
  // 导致 5 秒心跳和 15 秒心跳结果不一致（违反 docs/14 第 7.2 节）。改成严格下一个网格点。
  let best = Math.min(toMs, Math.floor(atMs / gridMs) * gridMs + gridMs);
  for (const segment of segments) {
    for (const edge of [effectiveFrom(segment)]) {
      if (edge > atMs && edge < best) best = edge;
    }
  }
  return Math.max(atMs + 1, best);
}

/**
 * 推进到 to。返回 {body, reasons, catchupMode, steps}。
 * @param {any} body
 * @param {number} toMs
 * @param {{segments: any[], world: any, city: string, thoughts: any[]}} timeline
 */
export function advanceBody(body, toMs, timeline, params = BODY_PARAMS) {
  const valuesIn = { ...body.values };
  if (!Number.isFinite(toMs) || toMs <= body.at) return { body: { ...body, values: valuesIn }, reasons: [], catchupMode: "none", steps: 0 };
  const segments = timeline.segments ?? [];
  const span = toMs - body.at;
  const catchupMode = span > COARSE_AFTER_MS ? "coarse" : "grid";
  let values = valuesIn;
  let at = body.at;
  let steps = 0;
  const reasons = [];
  if (catchupMode === "coarse") reasons.push({ at: toMs, kind: "mode", catchupMode });
  let lastTag = driversAt(timeline, at).segment?.tag ?? null;
  while (at < toMs && steps < MAX_STEPS) {
    steps += 1;
    // 早期部分用 60 秒网格，最后 72 小时回到 5 秒网格。
    const gridMs = toMs - at > COARSE_AFTER_MS ? COARSE_GRID_MS : GRID_MS;
    const drivers = driversAt(timeline, at);
    const targets = targetsOf(values, drivers);
    const end = Math.min(nextBoundary(at, toMs, gridMs, segments), toMs);
    const minutes = Math.max(0, (end - at) / MINUTE_MS);
    if (minutes > 0) values = stepWithTargets(values, targets, minutes, params.halfLifeMin);
    const tag = drivers.segment?.tag ?? null;
    if (tag !== lastTag) {
      reasons.push({ at: end, kind: "segment", tag, slotId: drivers.segment?.slotId ?? null, targets: { ...targets } });
      lastTag = tag;
    }
    at = end;
  }
  const tail = driversAt(timeline, toMs);
  const tailTargets = targetsOf(values, tail);
  return {
    body: {
      ...body,
      at: toMs,
      values,
      segment: { until: toMs, targets: { valence: tailTargets.valence, activation: tailTargets.activation, tension: tailTargets.tension }, energyRatePerHour: tailTargets.energyRatePerHour },
      bands: bandsOf(values, body.bands),
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

export { HOUR_MS };
