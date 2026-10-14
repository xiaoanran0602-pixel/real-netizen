// ============================================================
// 唯一表达出口（merge-inner-engines design §6）：一份内核快照 → 提示词里的状态提示、段数上限、
// 回复延迟系数、主动倾向、念头注意预算。取代旧版 mapping.mapInner 与 heartbeat.mapBody/formatBodySection。
//
//   提示按「身体 → 负荷 → 关系 → 自我 → 余韵」最多取两条，再加至多一句防线提示。
//   饿着、累着的时候顾不上细腻的情绪，所以余韵排最后。
//   安全例外：去掉一切疲惫、负荷、防线类提示，不限段数，注意预算 4，立即回复。
//   内核不可用：不注入状态小节、预算 2、延迟 1、主动放行——宁可少表演，也不编造状态。
// 模型永远只看到文字，看不到数字。纯函数。
// ============================================================

import { formatLocalDate, HOUR_MS } from "../util/time.js";
import { bandsOf } from "./body.js";
import { deriveFullness, deriveGuard, deriveMissing } from "./derive.js";
import { GUARD_HINTS, GUARD_LOOSE, GUARD_THIN } from "./mapping.js";
import { activeCondition, POST_TURNING_HOURS } from "./psyche.js";

export const MAX_HINTS = 2;
export const MISSING_HIGH = 50;
export const FULL_FROM = 85;
/** 状态小节的开头。后面只跟状态本身，不跟对她的要求（docs/19「补全写法」）。 */
export const STATE_PREAMBLE = "她这会儿的状态：";

/** 每条都是状态本身的平述短句。 */
export const HINTS = Object.freeze({
  cold: "这几天感冒了，身上没什么力气。",
  exhausted: "很困。",
  tired: "有点累。",
  hungry: "有点饿。",
  full: "刚吃饱，有点懒洋洋的。",
  highTension: "今天事多。",
  missing: "今天有点想找他说话。",
  lowSelf: "最近有点不太看得上自己。",
  highSelf: "最近心情不错，对自己挺满意。",
  afterTurning: "事情过去了，心里反而有点空。",
  highActivation: "这会儿有点坐不住。",
  relaxed: "刚才那点轻松还在，人是松的。",
  subdued: "心里还有点闷，没完全过去。",
});

/** 注意预算（docs/14 第 9.2 节）：clamp(floor(2 + 2E/100 − T/60), 1, 4)。 */
export function activeBudget(values) {
  if (!values) return 2;
  return Math.max(1, Math.min(4, Math.floor(2 + (2 * values.energy) / 100 - values.tension / 60)));
}

const DEGRADED = Object.freeze({ hints: [], guardHint: null, guard: 100, maxSegments: null, delayFactor: 1, activeBudget: 2, survival: false, degraded: true });

/**
 * @param {any} snapshot kernel.snapshot()（或 kernel.project() 的结果）
 * @param {{safety?: boolean, now?: number, sickMissCap?: number}} [ctx]
 */
export function express(snapshot, ctx = {}) {
  if (!snapshot?.values || (snapshot.status !== undefined && snapshot.status !== "ready")) {
    return { ...DEGRADED, proactive: { allowed: true, factor: 1, newTopic: true }, condition: null, bands: null, derived: { missing: 0, fullness: null, guard: null } };
  }
  const nowMs = ctx.now ?? snapshot.at;
  const day = formatLocalDate(new Date(nowMs));
  const values = snapshot.values;
  const psyche = snapshot.psyche ?? {};
  const fullness = deriveFullness(snapshot.segments ?? [], nowMs);
  const missing = deriveMissing(snapshot.thoughts ?? [], psyche, day, ctx.sickMissCap ?? snapshot.sickMissCap);
  const guard = deriveGuard(values, psyche, nowMs);
  const bands = bandsOf(values, snapshot.bands ?? {}, { fullness });
  const condition = activeCondition(psyche, day);

  const body = [];
  const load = [];
  const relation = [];
  const self = [];
  const afterglow = [];
  let maxSegments = null;
  let delayFactor = 1;
  let proactive = { allowed: true, factor: 1, newTopic: true };
  const cap = (n) => (maxSegments = maxSegments === null ? n : Math.min(maxSegments, n));

  // 身体
  if (condition?.kind === "cold") body.push(HINTS.cold);
  if (bands.exhausted) {
    cap(1);
    delayFactor *= 1.6;
    proactive = { ...proactive, allowed: false };
    body.push(HINTS.exhausted);
  } else if (bands.tired) {
    cap(2);
    delayFactor *= 1.3;
    proactive = { ...proactive, newTopic: false };
    body.push(HINTS.tired);
  }
  if (bands.hungry) body.push(HINTS.hungry);
  else if (fullness >= FULL_FROM) body.push(HINTS.full);
  const survival = Boolean(bands.exhausted || bands.hungry);

  // 负荷
  if (bands.highTension) {
    cap(2);
    proactive = { ...proactive, factor: proactive.factor * 0.5 };
    load.push(HINTS.highTension);
  }

  // 关系：想念只让她回得快一点，不再上调主动（主动的来由只有念头溢出）。
  if (!survival && missing >= MISSING_HIGH) {
    delayFactor *= 0.5;
    relation.push(HINTS.missing);
  }

  // 自我
  const selfWorth = psyche.selfWorth ?? 55;
  if (selfWorth <= 35) proactive = { ...proactive, factor: proactive.factor * 0.7 };
  if (!survival) {
    if (selfWorth <= 35) self.push(HINTS.lowSelf);
    else if (selfWorth >= 75) self.push(HINTS.highSelf);
    const turnedAt = Math.max(psyche.lastTurning?.bookAt ?? 0, psyche.lastTurning?.seenAt ?? 0);
    if (turnedAt && nowMs >= turnedAt && nowMs - turnedAt < POST_TURNING_HOURS * HOUR_MS) self.push(HINTS.afterTurning);
  }

  // 余韵
  if (bands.highActivation) afterglow.push(HINTS.highActivation);
  if (bands.valence === "relaxed") afterglow.push(HINTS.relaxed);
  if (bands.valence === "subdued") afterglow.push(HINTS.subdued);

  if (condition?.proactive === "boosted") proactive = { ...proactive, factor: proactive.factor * 1.5 };
  if (condition?.proactive === "reduced") proactive = { ...proactive, factor: proactive.factor * 0.5 };

  let hints = [...body, ...load, ...relation, ...self, ...afterglow].slice(0, MAX_HINTS);
  let guardHint = guard < GUARD_THIN ? GUARD_HINTS.thin : guard < GUARD_LOOSE ? GUARD_HINTS.loose : null;
  let budget = activeBudget(values);
  if (ctx.safety) {
    // 安全优先于活人感：去掉疲惫、负荷、防线类提示，不限段数，立即回复。
    hints = [...relation, ...self, ...afterglow].slice(0, MAX_HINTS);
    guardHint = null;
    maxSegments = null;
    delayFactor = 0;
    budget = 4;
  }
  return { hints, guardHint, guard, maxSegments, delayFactor, proactive, activeBudget: budget, survival, degraded: false, condition, bands, derived: { missing, fullness, guard } };
}

/** 系统提示词里「她这会儿的状态：……」一行；没有任何提示时返回 null。不含数字，不含对她的要求。 */
export function formatStateSection(expressed) {
  if (!expressed || expressed.degraded) return null;
  const lines = [...(expressed.hints ?? []), ...(expressed.guardHint ? [expressed.guardHint] : [])];
  // 段数上限由代码执行（chat-service 按 maxSegments 截断），这里只写成事实。
  if (expressed.maxSegments === 1) lines.push("只顾得上回一两句。");
  if (lines.length === 0) return null;
  return `${STATE_PREAMBLE}${lines.join("")}`;
}
