// ============================================================
// 每轮聊天的内心提示词接线（context.js 的 innerProvider）。只有一个引擎、一个出口：
//   1. 取内核快照（同一份 epoch/seq/at，整条回复都用它；流式回复中途心跳更新不影响这一条）；
//   2. express → 状态提示、段数上限、注意预算（安全例外最高优先）；
//   3. willHints 读慢层 psyche 与派生防线；漏一句被允许时提交 leak_offered（id = leak:<消息id>）；
//   4. 拼一节「# 你现在的状态」；
//   5. 拼念头小节，预算取 activeBudget；
//   6. 情境（situation.js）：她此刻在哪、手上在干嘛，写进「# 现在」下面。说话方式由处境带出来，不另写规则。
//   7. 这段聊天聊到了什么份上（conversation.js）：决策分布带惯性取最大值，和处境写在一起。
//   8. 交出状态与注意预算，由 companion/reply-plan.js 确定本轮回应范围。不随机虚构打断。
//
// 每条他的消息只处理一次（docs/14 第 6.3、9.1 节）：
//   第一次真正处理它时登记 perceivedAt，跑一次分类（相关度 + 评价），评价以 chat:<消息id>:appraisal-v1 提交；
//   重试、占位后的重新生成复用这次结果，不再碰撞、不再评价。睡着时只收件，醒来才处理。
//   聊天状态同理：同一条消息只判断、只推进一次（状态里记着 lastMessageId）。
// ============================================================

import { readSettings } from "../config/settings.js";
import { decide } from "../model/systemone.js";
import { createLogger } from "../util/log.js";
import { HOUR_MS } from "../util/time.js";
import { advanceConversation, conversationLines, decisionState, QUESTIONS } from "./conversation.js";
import { amendConversation, readConversationState, stepConversation } from "./conversation-store.js";
import { express, formatStateSection } from "./express.js";
import { isSafetyRisk } from "./mapping.js";
import { segmentCap } from "./perturbation.js";
import { formatSituation, sceneOf } from "./situation.js";
import { currentSlot } from "./state.js";
import { formatThoughtsSection, selectForPrompt } from "./thoughts.js";
import { collide } from "./thought-store.js";
import { willHints } from "./will.js";

const log = createLogger("inner");
/** 处理过的消息：id → {perceivedAt, groups}。只留最近几条，重试与重新生成复用。 */
const PROCESSED_LIMIT = 50;
/** 等决策模型多久（实测一次约 0.7 秒）。到点没回就按粗略猜测走，不拖回复。 */
export const DECISION_WAIT_MS = 1500;
/** 她主动发的消息过了这么久他才回，就不再算「他在回你那条」。 */
const ANSWERING_WINDOW_MS = 12 * HOUR_MS;

/**
 * @param {{kernel?: ReturnType<import("./kernel.js").createKernel>, classifier?: Function, waitMs?: number, readSlot?: (now: Date) => Promise<{slot: any, slots: any[]}>,
 *   decide?: typeof decide | null, decisionWaitMs?: number, random?: () => number}} deps
 *   decide 传 null = 不用决策模型（只用粗略猜测）。
 */
export function createInnerProvider(deps = {}) {
  const processed = new Map();
  const readSlot = deps.readSlot ?? currentSlot;
  const decideFn = deps.decide === null ? async () => null : deps.decide ?? decide;

  async function submitAppraisal(message, appraisal, perceivedAt) {
    if (!deps.kernel || appraisal === undefined) return;
    // 明确的 null：登记为一次零冲击，避免反复抽到有情绪为止。
    const payload = appraisal === null ? null : { ...appraisal, perceivedAt, evidenceMessageIds: [message.id] };
    const result = await deps.kernel.accept({ id: `chat:${message.id}:appraisal-v1`, type: "chat_appraisal", occurredAt: perceivedAt, payload }).catch(() => ({ result: "unavailable" }));
    if (result.result === "invalid") log.warn("appraisal rejected", { reason: result.reason });
  }

  async function perceive(message, nowMs) {
    const cached = processed.get(message.id);
    if (cached) return cached;
    const { groups, degraded, appraisal } = await collide(message.text, {
      nowMs,
      classifier: deps.classifier,
      waitMs: deps.waitMs,
      // 晚到的评价走同一个去重入口：30 分钟内按半衰期折减，超过只补记（内核里处理）。
      onLateAppraisal: (late) => void submitAppraisal(message, late, nowMs),
    });
    const entry = { perceivedAt: nowMs, groups, degraded };
    processed.set(message.id, entry);
    while (processed.size > PROCESSED_LIMIT) processed.delete(processed.keys().next().value);
    if (deps.kernel) {
      await deps.kernel.accept({ id: `chat:${message.id}:perceived`, type: "message_perceived", occurredAt: nowMs, payload: { messageId: message.id, perceivedAt: nowMs } }).catch(() => undefined);
      // 分类器失败或超时（undefined）：不编造情绪事件。
      await submitAppraisal(message, appraisal, nowMs);
    }
    return entry;
  }

  /**
   * 这段聊天聊到了什么份上（docs/19）。同一条消息只判断一次、只推进一次；重试与重新生成读已有的状态。
   * 决策模型在等待预算内没回来：这一条先按粗略猜测走，晚到的判断只把状态改准，不倒写这条回复。
   */
  async function converse({ messages, lastUser, nowMs, safety, situation }) {
    const existing = await readConversationState();
    if (existing?.lastMessageId === lastUser.id) return { state: existing, fresh: false };
    const list = messages ?? [];
    const lastIndex = list.lastIndexOf(lastUser);
    // 他连着发的几条算一回话；再往前的是之前的对话。
    let first = lastIndex;
    while (first > 0 && list[first - 1].role === "user") first -= 1;
    const text = list.slice(first, lastIndex + 1).map((message) => message.text).join("\n");
    const before = list.slice(0, first);
    const opener = before.at(-1);
    const answering = opener?.role === "assistant" && opener.source === "proactive" && nowMs - (opener.at ?? 0) <= ANSWERING_WINDOW_MS;
    const sentAt = Number.isFinite(list[first]?.at) && list[first].at > 0 ? list[first].at : nowMs;
    const input = { messageId: lastUser.id, at: nowMs, sentAt, text, safety, answering };

    let reading = null;
    let late = null;
    // 安全例外不问、不等：那时只有一件事。
    if (!safety) {
      const running = Promise.resolve()
        .then(() => decideFn({ state: decisionState({ scene: situation?.brief, prev: existing, at: nowMs, sentAt, recent: before, text }), questions: QUESTIONS }))
        .catch(() => null);
      const TIMED_OUT = Symbol("timeout");
      let timer;
      const budget = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), deps.decisionWaitMs ?? DECISION_WAIT_MS);
      });
      const result = await Promise.race([running, budget]).finally(() => clearTimeout(timer));
      if (result === TIMED_OUT) late = running;
      else reading = result;
    }
    const stepped = await stepConversation({ ...input, reading });
    if (late && stepped.fresh) {
      const recompute = (_current, lateReading) => advanceConversation(stepped.prev, { ...input, reading: lateReading });
      void late.then((lateReading) => (lateReading ? amendConversation(lastUser.id, (current) => recompute(current, lateReading)) : null)).catch(() => undefined);
    }
    return { state: stepped.state, fresh: stepped.fresh };
  }

  /** context.js 的 innerProvider。 */
  return async function provide({ now, messages }) {
    const settings = await readSettings();
    const lastUser = [...(messages ?? [])].reverse().find((message) => message.role === "user");
    const safety = isSafetyRisk(lastUser?.text);
    const nowMs = now.getTime();
    const parts = [];

    const snapshot = deps.kernel ? deps.kernel.snapshot(nowMs) : { status: "unavailable", values: null };
    const expressed = express(snapshot, { safety, now: nowMs, sickMissCap: settings.sickMissCap });
    const will = expressed.degraded ? { hints: [], leakOffered: false } : willHints(snapshot.psyche, expressed.guard, now, safety);
    if (will.leakOffered && deps.kernel) {
      // 记下「这一轮允许过漏一句」：聊完的记忆整理里 coveredWithJoke 才算数（psyche.applyPsycheEvents）。
      await deps.kernel.accept({ id: `leak:${lastUser?.id ?? nowMs}`, type: "leak_offered", occurredAt: nowMs, payload: { at: nowMs } }).catch(() => undefined);
    }
    const section = formatStateSection({ ...expressed, hints: [...expressed.hints, ...will.hints] });
    if (section) parts.push(section);

    if (settings.thoughtsEnabled !== false && lastUser?.id && lastUser.text) {
      const entry = await perceive(lastUser, nowMs).catch((error) => {
        log.warn("thoughts failed", { error: error?.message });
        return null;
      });
      if (entry) {
        const text = formatThoughtsSection(selectForPrompt(entry.groups, { activeBudget: expressed.activeBudget }));
        if (text) parts.push(text);
      }
    }
    // 日程读不到就不写处境：宁可少一句，也不编一个对不上的。
    const located = await readSlot(now).catch(() => null);
    const situation = located ? sceneOf({ slot: located.slot, slots: located.slots, now, safety }) : null;
    const talk = lastUser?.id && lastUser.text ? await converse({ messages, lastUser, nowMs, safety, situation }).catch((error) => {
      log.warn("conversation state failed", { error: error?.message });
      return null;
    }) : null;
    const conversation = talk?.state ?? null;
    // 回复链路不再用随机虚构的小事控制篇幅。注意力来自当前日程和内核快照。
    const passing = null;
    const attention = situation?.attention;
    // 段数上限取身体状态和处境里更紧的那个（安全例外两边都不限）。
    const caps = [expressed.maxSegments, segmentCap({ attention: situation?.attention, passing, safety })].filter((cap) => Number.isFinite(cap));
    return {
      text: parts.length > 0 ? parts.join("\n\n") : null,
      stateText: section,
      maxSegments: caps.length > 0 ? Math.min(...caps) : undefined,
      safety,
      situation,
      conversation,
      expressed,
      passing,
      extraNow: formatSituation(situation, conversationLines(conversation, { attention, safety })),
      snapshot: snapshot?.values ? { epoch: snapshot.epoch, seq: snapshot.seq, at: snapshot.at } : null,
    };
  };
}
