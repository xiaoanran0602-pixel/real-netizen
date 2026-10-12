// ============================================================
// 内心状态和其他模块的接线（main.js 组合）：
//   lifeFacts(now)          setLifeFactsProvider 用：掷骰事实 + 写书转折事实
//   bookFacts(now)          生成当天日程前：写书张力到了就加一句事实，并记一次转折
//   onCuratorEvents(events) 记忆整理后的事件判断 → 张力/自我感觉；漏过一句就记被看见的转折
//   onUserTurn(message)     每轮他说话 → 想念下降
// ============================================================

import { formatLocalDate } from "../util/time.js";
import { diceFacts } from "./dice.js";
import { mutateInner, readInner, recordEvents, recordUserTurn, settleNow } from "./store.js";
import { markTurning } from "./vitals.js";
import { afterEvents, BOOK_TURNING_FACT, bookTurningDue } from "./will.js";

/** life-scheduler 的 factsProvider 片段。实际释放由日程里的「写作」标签在结算时完成，这里释放量为 0。 */
export async function bookFacts(now) {
  const day = formatLocalDate(now);
  const state = await settleNow(now.getTime());
  if (!bookTurningDue(state, day)) return [];
  await mutateInner((current) => (bookTurningDue(current, day) ? { state: markTurning(current, "book", day, 0), reason: { kind: "turning", will: "book", day } } : { state: current }));
  return [BOOK_TURNING_FACT];
}

/** life-scheduler 的完整 factsProvider：先掷骰（生病/加班周/假期），再看写书转折。 */
export async function lifeFacts(now) {
  const dice = await diceFacts(now).catch(() => []);
  const book = await bookFacts(now).catch(() => []);
  return [...dice, ...book];
}

/** curator 的 onEvents。 */
export async function onCuratorEvents(events, at = new Date()) {
  const atMs = at instanceof Date ? at.getTime() : Number(at) || Date.now();
  await recordEvents(events, atMs);
  const state = await readInner();
  if (!afterEvents(state, events, atMs)) return;
  await mutateInner((current) => afterEvents(current, events, atMs) ?? { state: current });
}

/** chat-service 的 onUserMessage。 */
export function onUserTurn(message) {
  const at = Number(message?.at) || Date.now();
  return recordUserTurn(at);
}
