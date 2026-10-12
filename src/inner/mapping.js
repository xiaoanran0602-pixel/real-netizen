// ============================================================
// 对照表（docs/12 第 5、7 节）：数值 → 给模型的一两句话 + 代码直接控制的行为参数。
// 模型永远只看到文字，看不到数字。
//   - 一次最多两句状态提示，按马斯洛优先级从底层往上取（生理 → 安全 → 归属 → 尊重），再加一句防线提示。
//   - 精力 < 25 或饱腹 < 20：减少展开余量，想念、意志不参与提示；不等于要求用户结束话题。
//   - 安全例外：他流露出不想活了的意思时，去掉一切疲惫、防线类提示。
// ============================================================

import { HOUR_MS } from "../util/time.js";
import { AVAILABILITY, STATUS_TEXT } from "./tags.js";
import { computeGuard, POST_TURNING_HOURS } from "./vitals.js";

export const MAX_HINTS = 2;
export const STATE_PREAMBLE = "（这些只约束你此刻能展开多少，不是催他结束话题的要求，不要逐项说出来；他问起你的情况，可以照实说。）";
export const GUARD_HINTS = Object.freeze({ loose: "你今晚有点松，没平时那么端着。", thin: "你防线很薄，心里的东西容易漏出来。" });
export const GUARD_LOOSE = 60;
export const GUARD_THIN = 35;

// 宁可多判：命中任何一个就当作需要立即、认真地回。
const SAFETY_PATTERN = /(不想活|活不下去|活着没意思|没意思活|想死|去死|自杀|轻生|结束(自己|生命)|了结|割腕|跳楼|跳下去|吃药.*(睡|走)|安眠药|遗书|活够了|没有活下去|撑不下去了|kill myself|suicid|end my life)/iu;

export function isSafetyRisk(text) {
  return SAFETY_PATTERN.test(String(text ?? ""));
}

/**
 * @param {{vitals: any, tensions: any, lastDrinkAt?: number, lastTurning?: any, condition?: any}} inner
 * @param {{now: number, condition?: any, safety?: boolean}} context
 */
export function mapInner(inner, context) {
  const v = inner.vitals;
  const physiological = [];
  const safety = [];
  const belonging = [];
  const esteem = [];
  let maxSegments = null;
  let delayFactor = 1;
  let proactive = { allowed: true, factor: 1, newTopic: true };
  const cap = (n) => (maxSegments = maxSegments === null ? n : Math.min(maxSegments, n));

  if (context.condition?.kind === "cold") physiological.push("你这几天感冒了，身上没什么力气。");
  if (v.energy < 25) {
    cap(1);
    delayFactor *= 1.6;
    proactive = { ...proactive, allowed: false };
    physiological.push("你很困，组织句子慢一些；需要休息就说自己的情况，不要求他停止思考。");
  } else if (v.energy < 60) {
    cap(2);
    delayFactor *= 1.3;
    proactive = { ...proactive, newTopic: false };
    physiological.push("你有点累，可以少说、慢慢接，不必把话题处理完。");
  }
  if (v.fullness < 30) physiological.push("你有点饿，身体会分去一点注意力，不必转成对他的吃饭提醒。");
  if (v.stress >= 65) {
    cap(2);
    proactive = { ...proactive, factor: proactive.factor * 0.5 };
    safety.push("你今天事多，同时顾及的内容少一些；认真回应眼前这句，不把压力归到他身上。");
  }
  const survival = v.energy < 25 || v.fullness < 20;
  if (!survival && v.missing >= 50) {
    delayFactor *= 0.5;
    proactive = { ...proactive, factor: proactive.factor * 1.5 };
    belonging.push("你今天有点想找他说话。");
  }
  if (!survival) {
    if (v.selfWorth <= 35) esteem.push("你最近有点不太看得上自己。");
    else if (v.selfWorth >= 75) esteem.push("你最近心情不错，对自己挺满意。");
    const turnedAt = Math.max(inner.lastTurning?.bookAt ?? 0, inner.lastTurning?.seenAt ?? 0);
    if (turnedAt && context.now - turnedAt < POST_TURNING_HOURS * HOUR_MS) esteem.push("事情过去了，心里反而有点空。");
  }
  if (context.condition?.proactive === "boosted") proactive = { ...proactive, factor: proactive.factor * 1.5 };
  if (context.condition?.proactive === "reduced") proactive = { ...proactive, factor: proactive.factor * 0.5 };

  const guard = computeGuard(v, context.now, inner.lastDrinkAt);
  let hints = [...physiological, ...safety, ...belonging, ...esteem].slice(0, MAX_HINTS);
  let guardHint = guard < GUARD_THIN ? GUARD_HINTS.thin : guard < GUARD_LOOSE ? GUARD_HINTS.loose : null;
  if (context.safety) {
    // 安全优先于活人感：去掉疲惫、防线类提示，不限段数。
    hints = hints.filter((hint) => !physiological.includes(hint) && !safety.includes(hint));
    guardHint = null;
    maxSegments = null;
  }
  return { hints, guardHint, guard, maxSegments, delayFactor, proactive, survival };
}

/** 系统提示词的「# 你现在的状态」小节；没有任何提示时返回 null。不含数字。 */
export function formatStateSection(mapped) {
  const lines = [...mapped.hints, ...(mapped.guardHint ? [mapped.guardHint] : [])];
  if (mapped.maxSegments === 1) lines.push("这次只回一两句，一段就够。");
  else if (mapped.maxSegments === 2) lines.push("这次最多分两段说。");
  if (lines.length === 0) return null;
  return ["# 你现在的状态", STATE_PREAMBLE, ...lines].join("\n");
}

/** 她现在的状态文字（网页标题下）与可回复性。 */
export function describeSlot(slot) {
  const tag = slot?.tag ?? "空闲";
  return { tag, label: STATUS_TEXT[tag] ?? "在线", availability: AVAILABILITY[tag] ?? "free" };
}
