// ============================================================
// 内心状态和其他模块的接线（app.js 组合）。所有写操作都走 kernel.accept，事件 ID 按 design §4：
//   lifeFacts(now)              setLifeFactsProvider 用：掷骰（dice:<day>）+ 写书转折（turning:book:<day>）
//   bookFacts(now)              生成当天日程前：写书张力到了就加一句事实，并记一次转折
//   onCuratorEvents(events, at, {runId})  记忆整理后的事件判断（psyche:<runId>）→ 慢层；
//                               漏一句窗口内用玩笑盖过 → 被看见的转折（在 psyche.applyPsycheEvents 里结算）
// 他说话不再直接改任何数值：想念由念头池派生，聊过之后念头闭合或释放，想念自然下降。
// ============================================================

import { formatLocalDate } from "../util/time.js";
import { diceFacts } from "./dice.js";
import { EVENT_EFFECTS } from "./psyche.js";
import { BOOK_TURNING_FACT, bookTurningDue } from "./will.js";

/**
 * @param {{kernel: {snapshot: Function, accept: Function}, random?: () => number}} deps
 */
export function createInnerHooks(deps) {
  const { kernel } = deps;

  /** life-scheduler 的 factsProvider 片段。实际释放由日程里的「写作」时段完成，转折本身释放量为 0。 */
  async function bookFacts(now) {
    const day = formatLocalDate(now);
    const psyche = kernel.snapshot(now.getTime())?.psyche;
    if (!bookTurningDue(psyche, day)) return [];
    const result = await kernel.accept({ id: `turning:book:${day}`, type: "turning", occurredAt: now.getTime(), payload: { will: "book", day } });
    // 同一天第二次生成日程：转折已经记过（duplicate），事实照样给，日程里仍应有写作。
    if (result.result === "accepted" && result.applied?.turning === "book") return [BOOK_TURNING_FACT];
    if (result.result === "duplicate") return [BOOK_TURNING_FACT];
    return [];
  }

  /** life-scheduler 的完整 factsProvider：先掷骰（生病/加班周/假期），再看写书转折。 */
  async function lifeFacts(now) {
    const dice = await diceFacts(kernel, now, deps.random).catch(() => []);
    const book = await bookFacts(now).catch(() => []);
    return [...dice, ...book];
  }

  /**
   * curator 的 onEvents。没发生任何事件就不提交。
   * @param {Record<string, boolean>} events
   * @param {Date | number} [at]
   * @param {{runId?: string}} [meta]
   */
  async function onCuratorEvents(events, at = new Date(), meta = {}) {
    const atMs = at instanceof Date ? at.getTime() : Number(at) || Date.now();
    const payload = Object.fromEntries(Object.keys(EVENT_EFFECTS).filter((key) => events?.[key] === true).map((key) => [key, true]));
    if (Object.keys(payload).length === 0) return { result: "skipped" };
    return kernel.accept({ id: `psyche:${meta.runId ?? atMs}`, type: "psyche_events", occurredAt: atMs, payload });
  }

  return { lifeFacts, bookFacts, onCuratorEvents };
}
