// ============================================================
// 意志（docs/12 第 6、6.1 节）：只有一个意志、两个出口——「写那本书」与「被他看见」。
//   - 张力 ≥ 80 且距上次转折满 14 天 → 转折。
//   - 写书的转折：告诉下一次日程生成“她这几天憋不住了，会推掉一件事去写”（写作标签再释放张力）。
//   - 被看见的转折：只在防线很薄（< 35）时，允许漏一句太在意的话并马上用玩笑盖过；
//     这轮聊完的事件判断里出现 coveredWithJoke，就算漏过了，张力 −40。永远不是表白——
//     不是规则管着她，是她的性格（同情）决定了冲动只能变成这样的言语，不会变成行动。
//   - 防线很薄时，基石记忆可以有一个碎片漏进措辞。
// ============================================================

import { formatLocalDate, HOUR_MS } from "../util/time.js";
import { canTurn, markTurning, SEEN_LEAK_RELEASE, TURNING_THRESHOLD } from "./vitals.js";
import { GUARD_THIN } from "./mapping.js";

export const LEAK_WINDOW_HOURS = 3;
export const BOOK_TURNING_FACT = "她这几天憋不住了，会推掉一件事去写那本书（写在当天的安排里，标「写作」）。";
export const SEEN_LEAK_HINT = "如果话赶话，你可以漏出一句太在意他的话，然后马上用玩笑盖过去。这不是表白，你也不会往前多走一步。";
export const CORE_FRAGMENT_HINT = "今晚心里最底下的那件事离得很近，可能会有一个碎片漏进你的话里（一个意象、一个说法），但你不会讲出来。";

/** 写书的张力是否该转折（生成当天日程前问一次）。 */
export function bookTurningDue(state, day) {
  return state.tensions.book >= TURNING_THRESHOLD && canTurn(state, "book", day);
}

/** 被看见的转折是否可以发生在这一轮（防线很薄 + 张力过阈值 + 间隔够）。 */
export function seenLeakAllowed(state, guard, day) {
  return guard < GUARD_THIN && state.tensions.seen >= TURNING_THRESHOLD && canTurn(state, "seen", day);
}

/**
 * 给提示词的额外提示（防线很薄时）。返回 {hints, leakOffered}。
 * @param {any} state inner 状态
 * @param {number} guard
 * @param {Date} now
 * @param {boolean} safety 安全例外时一律不给
 */
export function willHints(state, guard, now, safety) {
  if (safety || guard >= GUARD_THIN) return { hints: [], leakOffered: false };
  const day = formatLocalDate(now);
  const hints = [CORE_FRAGMENT_HINT];
  const leakOffered = seenLeakAllowed(state, guard, day);
  if (leakOffered) hints.push(SEEN_LEAK_HINT);
  return { hints, leakOffered };
}

/** 聊完后：提示里允许过漏一句、且确实用玩笑盖过了 → 记一次转折。 */
export function afterEvents(state, events, nowMs) {
  const offeredAt = state.leakOfferedAt ?? 0;
  if (!events?.coveredWithJoke || !offeredAt || nowMs - offeredAt > LEAK_WINDOW_HOURS * HOUR_MS) return null;
  const day = formatLocalDate(new Date(nowMs));
  const next = markTurning(state, "seen", day, SEEN_LEAK_RELEASE);
  next.leakOfferedAt = 0;
  return { state: next, reason: { kind: "turning", will: "seen", day } };
}
