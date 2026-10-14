// ============================================================
// 掷骰（docs/12 第 9 节）：每天第一次生成日程前掷一次。
//   感冒约每 45 天一次（2–4 天），加班周约每 30 天一次（3–5 天），假期约每 90 天一次（2–7 天）。
//   正在生病/加班/假期时不再掷；「她会生病」关掉后不再掷骰。
//   结果以 condition_set 事件交给内核（id = dice:<day>）：同一天第二次掷会被内核当作重复丢弃。
//   生成日程时把它作为一句事实告诉模型，模型据此打「生病」「加班」标签。
// 不让模型决定概率：数字只在这里。
// ============================================================

import { readSettings } from "../config/settings.js";
import { addDays, daysBetween, formatLocalDate } from "../util/time.js";
import { activeCondition, CONDITIONS } from "./psyche.js";

export const DICE = Object.freeze({
  cold: { chance: 1 / 45, minDays: 2, maxDays: 4 },
  overtime: { chance: 1 / 30, minDays: 3, maxDays: 5 },
  vacation: { chance: 1 / 90, minDays: 2, maxDays: 7 },
});

const FACT_TEXT = Object.freeze({
  cold: (n, total) => `她感冒了（第 ${n} 天，大概要 ${total} 天才好）：人没精神、嗓子不舒服，今天的安排要少、要早睡，时段标「生病」。`,
  overtime: (n, total) => `她这周项目赶进度（加班周第 ${n} 天，共 ${total} 天）：今天晚上要加班，时段标「加班」。`,
  vacation: (n, total) => `她在休假 / 出行（第 ${n} 天，共 ${total} 天）：今天不上班，安排轻松一点。`,
});

/**
 * 纯函数：今天要不要开始一个事件。已有事件在生效时返回 null。
 * @param {{condition?: any}} psyche
 * @param {string} day
 * @param {{canGetSick: boolean}} options
 * @param {() => number} random
 */
export function rollCondition(psyche, day, options, random = Math.random) {
  // 文档第 9 节：开关关掉后不再掷骰（三种都不掷，网页提示也是这么写的）。
  if (!options.canGetSick || activeCondition(psyche, day)) return null;
  for (const kind of ["cold", "overtime", "vacation"]) {
    if (random() >= DICE[kind].chance) continue;
    return startCondition(kind, day, random);
  }
  return null;
}

/** 从 day 开始一个事件（掷骰与调试强制共用）。 */
export function startCondition(kind, day, random = Math.random) {
  const rule = DICE[kind];
  if (!rule || !CONDITIONS[kind]) throw new Error(`unknown condition: ${kind}`);
  const days = rule.minDays + Math.floor(random() * (rule.maxDays - rule.minDays + 1));
  return { kind, from: day, until: addDays(day, days - 1) };
}

/** 生效中的事件 → 给日程生成的一句事实。 */
export function conditionFact(condition, day) {
  if (!condition || day < condition.from || day > condition.until) return null;
  const n = daysBetween(condition.from, day) + 1;
  const total = daysBetween(condition.from, condition.until) + 1;
  return FACT_TEXT[condition.kind]?.(n, total) ?? null;
}

/**
 * life-scheduler 的 factsProvider 片段：今天掷一次（已掷过就不再掷），返回事实。
 * @param {{snapshot: Function, accept: Function}} kernel
 * @param {Date} now
 * @param {() => number} [random]
 */
export async function diceFacts(kernel, now, random = Math.random) {
  const day = formatLocalDate(now);
  const before = kernel.snapshot(now.getTime());
  if (!before?.psyche) return [];
  if (before.psyche.diceDay !== day) {
    const settings = await readSettings();
    const rolled = rollCondition(before.psyche, day, { canGetSick: settings.canGetSick !== false }, random);
    await kernel.accept({ id: `dice:${day}`, type: "condition_set", occurredAt: now.getTime(), payload: rolled ? { condition: rolled, diceDay: day } : { diceDay: day } });
  }
  const fact = conditionFact(kernel.snapshot(now.getTime()).psyche?.condition, day);
  return fact ? [fact] : [];
}

/**
 * 调试强制：从今天开始某个事件（`/api/lin/inner/force`）；kind=null 表示恢复健康。
 * @param {{accept: Function}} kernel
 * @param {string | null} kind
 * @param {Date} [now]
 */
export function forceCondition(kernel, kind, now = new Date()) {
  const condition = kind ? startCondition(kind, formatLocalDate(now)) : null;
  return kernel.accept({ id: `force:${now.getTime()}`, type: "condition_set", occurredAt: now.getTime(), payload: { condition } });
}
