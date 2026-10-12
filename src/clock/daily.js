// ============================================================
// 一天的分界调度（design §11.5、§12.1）：心跳检查 state.lastConsolidated 与 lastSnapshotDay，
// 按日期顺序补做所有错过的日子。每一天是一个「日结任务」，进聊天串行队列（排在正在进行的对话之后）：
//   daily → （这天是周日）weekly → （这天是月末）monthly → snapshot
// 整理失败：记日志，不推进；下次心跳重试；到了下一个分界仍失败 → 跳过该日整理（记 consolidationSkipped），照常存档。
// 启动补存：lastSnapshotDay 之后到昨天的每一天都补一份。--dry 下只在手动触发时运行。
// ============================================================

import { readSettings } from "../config/settings.js";
import { readState, updateState } from "../store/state.js";
import { createLogger } from "../util/log.js";
import { MINUTE_MS } from "../util/time.js";
import { experienceDay, isMonthEnd, isWeekEnd, lastFinishedDay, pendingDays } from "../archive/day.js";

const log = createLogger("clock");
export const HEARTBEAT_MS = 5 * MINUTE_MS;
const SKIPPED_KEEP = 30;

/**
 * @param {{
 *   chatService: ReturnType<import("../chat/chat-service.js").createChatService>,
 *   consolidate: {daily: (day: string) => Promise<any>, weekly: (day: string) => Promise<any>, monthly: (day: string) => Promise<any>},
 *   snapshot: (day: string) => Promise<any>,
 *   now?: () => Date,
 *   isRestoring?: () => boolean,
 *   onBeat?: (now: Date) => Promise<void> | void,
 * }} deps
 */
export function createDailyClock(deps) {
  const now = deps.now ?? (() => new Date());
  let timer;
  let running = null;

  /** 一天的日结（在队列里执行）。返回 {consolidated, skipped}。 */
  async function closeDay(day, { giveUp }) {
    const state = await readState();
    const last = state.lastConsolidated ?? {};
    let consolidated = Boolean(last.day && last.day >= day);
    let skipped = false;
    if (!consolidated) {
      try {
        await deps.consolidate.daily(day);
        if (isWeekEnd(day)) await deps.consolidate.weekly(day);
        if (isMonthEnd(day)) await deps.consolidate.monthly(day);
        await updateState((current) => ({ lastConsolidated: { ...(current.lastConsolidated ?? {}), day, ...(isWeekEnd(day) ? { week: day } : {}), ...(isMonthEnd(day) ? { month: day } : {}) } }));
        consolidated = true;
      } catch (error) {
        log.warn("consolidation failed", { day, kind: error?.kind, error: error?.message });
        if (!giveUp) return { consolidated: false, skipped: false, snapshot: false };
        // 到了下一个分界仍失败：跳过这天的整理，照常存档。
        skipped = true;
        await updateState((current) => ({
          lastConsolidated: { ...(current.lastConsolidated ?? {}), day },
          consolidationSkipped: [...(current.consolidationSkipped ?? []), day].slice(-SKIPPED_KEEP),
        }));
      }
    }
    await deps.snapshot(day);
    await updateState({ lastSnapshotDay: day });
    return { consolidated, skipped, snapshot: true };
  }

  /**
   * 检查并补做。每天一个系统任务；某天整理失败且还没过“它之后的下一个分界”时停下，等下次心跳。
   * @returns {Promise<{day: string, consolidated: boolean, skipped: boolean, snapshot: boolean}[]>}
   */
  async function tick() {
    if (running) return running;
    running = (async () => {
      if (deps.isRestoring?.()) return [];
      const current = now();
      const { dayBoundaryHour } = await readSettings();
      await deps.onBeat?.(current);
      const state = await readState();
      const lastDone = state.lastSnapshotDay;
      const days = pendingDays(lastDone, current, dayBoundaryHour);
      const results = [];
      const finished = lastFinishedDay(current, dayBoundaryHour);
      for (const day of days) {
        // 失败时：只有当已经又过了一个分界（这一天不是最近结束的那天）才放弃整理。
        const giveUp = day < finished;
        const result = await deps.chatService.runSystemTask(() => closeDay(day, { giveUp }));
        results.push({ day, ...result });
        if (!result.snapshot) break;
      }
      return results;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    tick,
    /** 当前时刻属于哪一天（给网页和测试用）。 */
    async today() {
      const { dayBoundaryHour } = await readSettings();
      return experienceDay(now(), dayBoundaryHour);
    },
    start() {
      if (timer) return;
      void tick().catch((error) => log.warn("tick failed", { error: error?.message }));
      timer = setInterval(() => void tick().catch((error) => log.warn("tick failed", { error: error?.message })), HEARTBEAT_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
