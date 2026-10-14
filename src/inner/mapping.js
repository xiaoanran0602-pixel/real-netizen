// ============================================================
// 表达相关的小常量与判断（状态 → 提示词的对照已经并入 express.js）：
//   isSafetyRisk  他流露出不想活了的意思：安全优先于活人感
//   describeSlot  她现在的状态文字（网页标题下）与可回复性
//   GUARD_*       防线提示的阈值与句子
// ============================================================

import { AVAILABILITY, STATUS_TEXT } from "./tags.js";

export const GUARD_HINTS = Object.freeze({ loose: "今晚有点松，没平时那么端着。", thin: "今晚防线很薄，心里的东西容易漏出来。" });
export const GUARD_LOOSE = 60;
export const GUARD_THIN = 35;

// 宁可多判：命中任何一个就当作需要立即、认真地回。
const SAFETY_PATTERN = /(不想活|活不下去|活着没意思|没意思活|想死|去死|自杀|轻生|结束(自己|生命)|了结|割腕|跳楼|跳下去|吃药.*(睡|走)|安眠药|遗书|活够了|没有活下去|撑不下去了|kill myself|suicid|end my life)/iu;

export function isSafetyRisk(text) {
  return SAFETY_PATTERN.test(String(text ?? ""));
}

/** 她现在的状态文字（网页标题下）与可回复性。 */
export function describeSlot(slot) {
  const tag = slot?.tag ?? "空闲";
  return { tag, label: STATUS_TEXT[tag] ?? "在线", availability: AVAILABILITY[tag] ?? "free" };
}
