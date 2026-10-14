// ============================================================
// 意志（docs/12 第 6、6.1 节）：只有一个意志、两个出口——「写那本书」与「被他看见」。
//   - 张力 ≥ 80 且距上次转折满 14 天 → 转折。
//   - 写书的转折：告诉下一次日程生成“她这几天憋不住了，会推掉一件事去写”（写作时段再释放张力）。
//   - 被看见的转折：只在防线很薄（< 35）时，允许漏一句太在意的话并马上用玩笑盖过；
//     这轮聊完的事件判断里出现 coveredWithJoke，就算漏过了，张力 −40（在 psyche.applyPsycheEvents 里结算）。
//     永远不是表白——不是规则管着她，是她的性格决定了冲动只能变成这样的言语，不会变成行动。
//   - 防线很薄时，基石记忆可以有一个碎片漏进措辞。
// 读的是内核快照里的慢层 psyche 和派生的防线（derive.deriveGuard，经 express 算出）。
// ============================================================

import { formatLocalDate } from "../util/time.js";
import { GUARD_THIN } from "./mapping.js";
import { canTurn, LEAK_WINDOW_HOURS, TURNING_THRESHOLD } from "./psyche.js";

export { LEAK_WINDOW_HOURS };
export const BOOK_TURNING_FACT = "她这几天憋不住了，会推掉一件事去写那本书（写在当天的安排里，标「写作」）。";
export const SEEN_LEAK_HINT = "话赶话的时候，她有可能漏出一句太在意他的话，又马上拿玩笑盖过去；她不会往前多走一步。";
export const CORE_FRAGMENT_HINT = "心里最底下的那件事今晚离她很近，她不会把它讲出来。";

/** 写书的张力是否该转折（生成当天日程前问一次）。 */
export function bookTurningDue(psyche, day) {
  return Boolean(psyche) && psyche.book >= TURNING_THRESHOLD && canTurn(psyche, "book", day);
}

/** 被看见的转折是否可以发生在这一轮（防线很薄 + 张力过阈值 + 间隔够）。 */
export function seenLeakAllowed(psyche, guard, day) {
  return Boolean(psyche) && guard < GUARD_THIN && psyche.seen >= TURNING_THRESHOLD && canTurn(psyche, "seen", day);
}

/**
 * 给提示词的额外提示（防线很薄时）。返回 {hints, leakOffered}。
 * @param {any} psyche 内核快照里的慢层
 * @param {number} guard 派生的防线
 * @param {Date} now
 * @param {boolean} safety 安全例外时一律不给
 */
export function willHints(psyche, guard, now, safety) {
  if (safety || !psyche || !Number.isFinite(guard) || guard >= GUARD_THIN) return { hints: [], leakOffered: false };
  const day = formatLocalDate(now);
  const hints = [CORE_FRAGMENT_HINT];
  const leakOffered = seenLeakAllowed(psyche, guard, day);
  if (leakOffered) hints.push(SEEN_LEAK_HINT);
  return { hints, leakOffered };
}
