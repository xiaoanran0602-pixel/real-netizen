// ============================================================
// 承诺即约束（docs/13 第 9 节）：她说出口的时间，反向约束程序。
//   她说「还剩二十分钟」→ busy_until = now + 20 分钟 × 0.7–2.0（说话算数，但带偏差）
//   她说「我收尾了 / 先这样」→ now + 5–15 分钟
//   她说「睡了」→ 次日日程起床时间
//   日程硬边界（比如 17:00 下课）→ 直接写入，不需要她说
// busy_until 之前收到消息：剩余 > 10 分钟不回（进待回队列）；≤ 10 分钟按概率回一句，字数硬上限 15。
// 她说走了就必须真的消失。宣告式结尾每天最多一次，默认是没有结尾（docs/13 第 9.6 节）。
// 先用正则兜底解析（可靠、零延迟）；想让模型看得更细时可以接小模型，正则仍作兜底。
// ============================================================

import { isAsleep, nextWake } from "./tags.js";
import { MINUTE_MS } from "../util/time.js";

export const BUSY_QUEUE_MIN = 10;
export const SHORT_REPLY_CHARS = 15;
export const MID_REPLY_CHARS = 60;
export const MID_REPLY_MIN = 30;
export const ANNOUNCE_PATTERN = /(我先(?:送|去|忙|走)|先这样|不聊了|我挂了|回头说|晚点说|不说了，)/u;
export const QUEUE_PROBABILITY = 0.5;

const NUMBERS = Object.freeze({ 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 });
// 修复（演练发现）：原来「车里就别睡了」这种劝他的话也被当成「她要睡了」。
// 现在只认她说自己的动作，并且只看回复最后一小段（宣告一般在结尾）。
const MINUTES_PATTERN = /(?:我)?(?:还有|还剩|再过|再等|再有|差不多|大概还有)\s*(\d+|[一二两三四五六七八九十半]+)\s*(个)?\s*(分钟|分|小时|钟头|个小时)/u;
const WRAP_UP_PATTERN = /(我(?:先)?收尾了|我收个尾|我快结束了|我这就完|我快完了|我结束了|我马上下课|我下课了)/u;
const SLEEP_PATTERN = /(我先睡了|我去睡了|我睡了|我要睡了|我睡觉去了|我先睡|我去睡|^晚安|[。！，\s]晚安[。！~～]*$)/u;
const TAIL_CHARS = 40;
const RANGE = Object.freeze({ minutes: [0.7, 2], wrapUp: [5, 15] });

/** 把「二十」「十五」这类中文数字转成数。 */
export function parseCount(raw) {
  if (/^\d+$/u.test(raw)) return Number(raw);
  if (raw === "半") return 0.5;
  if (raw === "十") return 10;
  if (raw.includes("十")) {
    const [tens, ones] = raw.split("十");
    return (NUMBERS[tens] ?? 1) * 10 + (NUMBERS[ones] ?? 0);
  }
  let value = 0;
  for (const char of raw) value += NUMBERS[char] ?? 0;
  return value || null;
}

/**
 * 从她这句话里提取时间承诺。纯正则，拿不准就不约束（宁可不管，也不要错怪她）。
 * @param {string} text
 * @returns {{kind: "minutes"|"wrap-up"|"sleep", minutes?: number} | null}
 */
export function parsePromise(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  // 只看最后一段话的结尾部分：宣告式的时间承诺一般在结尾。
  const lastParagraph = text.trim().split(/\n\s*\n/u).at(-1) ?? text;
  const tail = [...lastParagraph].slice(-TAIL_CHARS).join("").trim();
  if (SLEEP_PATTERN.test(tail)) return { kind: "sleep" };
  const match = MINUTES_PATTERN.exec(tail);
  if (match) {
    const count = parseCount(match[1]);
    if (count) {
      const minutes = match[3] === "分钟" || match[3] === "分" ? count : count * 60;
      if (minutes > 0 && minutes <= 8 * 60) return { kind: "minutes", minutes };
    }
    return null;
  }
  if (WRAP_UP_PATTERN.test(tail)) return { kind: "wrap-up" };
  return null;
}

/**
 * 承诺 → busy_until（毫秒时间戳）。睡着时按次日起床时间。
 * @param {{kind: string, minutes?: number}} promise
 * @param {{now: Date, slots: any[], random?: () => number}} input
 */
export function promiseToBusyUntil(promise, input) {
  const rand = input.random ?? Math.random;
  const pick = ([min, max]) => min + rand() * (max - min);
  if (promise.kind === "sleep") {
    const minute = input.now.getHours() * 60 + input.now.getMinutes();
    // 今天的起床时间已经过了：按明天的（日程一天一份，作息大致重复）。
    const tomorrowWake = (input.slots ?? []).find((slot) => slot.tag === "起床")?.start;
    const wake = nextWake(input.slots ?? [], minute) ?? (tomorrowWake !== undefined ? tomorrowWake + 24 * 60 : 24 * 60 + 8 * 60);
    const deltaMin = (wake - minute + 24 * 60) % (24 * 60);
    return input.now.getTime() + Math.max(30, deltaMin) * MINUTE_MS;
  }
  if (promise.kind === "wrap-up") return input.now.getTime() + pick(RANGE.wrapUp) * MINUTE_MS;
  return input.now.getTime() + (promise.minutes ?? 20) * pick(RANGE.minutes) * MINUTE_MS;
}

/** 日程硬边界：当前时段结束时刻（她说不用，日程说了算）。 */
export function scheduleBoundaryUntil(slots, now) {
  const minute = now.getHours() * 60 + now.getMinutes();
  const boundary = (slots ?? []).map((slot) => slot.start).find((start) => start > minute);
  if (boundary === undefined) return 0;
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime() + boundary * MINUTE_MS;
}

/**
 * busy 状态下的回复字数硬上限（docs/13 第 9.3 节）。0 表示不限。
 * @param {number} remainingMs
 */
export function stagedCharLimit(remainingMs) {
  if (remainingMs <= BUSY_QUEUE_MIN * MINUTE_MS) return SHORT_REPLY_CHARS;
  if (remainingMs <= MID_REPLY_MIN * MINUTE_MS) return MID_REPLY_CHARS;
  return 0;
}

/** 忙时是否回一句（剩余 ≤10 分钟按概率回，回也得短）。 */
export function shouldReplyWhileBusy(remainingMs, random = Math.random) {
  if (remainingMs > BUSY_QUEUE_MIN * MINUTE_MS) return false;
  return random() < QUEUE_PROBABILITY;
}

/** 睡着时段不产生承诺约束（睡着本来就不回，由 reply-timing 的 asleep 分支处理）。 */
export function promiseFromReply(text, input) {
  const slot = input.slot;
  if (slot && isAsleep(slot.tag)) return null;
  return parsePromise(text);
}
