// ============================================================
// 13 + 14 合起来的提示词接线（替换 context.js 里的 innerProvider）。
//
// 模式（settings.innerEngineMode，docs/14 第 10.2 节）：
//   legacy  旧版五个体征控制回复；念头池照常（13 与 12 并行，不替代）
//   shadow  旧版控制回复；新内核只算、只记事件，不影响提示词（首版默认）
//   body    新内核唯一控制：不再注入旧版「你现在的状态」，也不再按旧想念/压力加权
// 不管哪个模式：安全例外最高优先；回复固定用同一份快照（流式回复中途心跳更新不影响这一条）。
//
// 每条他的消息只处理一次（docs/14 第 6.3、9.1 节）：
//   第一次真正处理它时登记 perceivedAt，跑一次分类（相关度 + 评价），评价以 chat:<消息id>:appraisal-v1 提交；
//   重试、占位后的重新生成复用这次结果，不再碰撞、不再评价。睡着时只收件，醒来才处理。
// ============================================================

import { readSettings } from "../config/settings.js";
import { createLogger } from "../util/log.js";
import { formatBodySection, mapBody } from "./heartbeat.js";
import { isSafetyRisk } from "./mapping.js";
import { innerPromptProvider } from "./state.js";
import { formatThoughtsSection, selectForPrompt } from "./thoughts.js";
import { collide } from "./thought-store.js";

const log = createLogger("inner");
/** 处理过的消息：id → {perceivedAt, groups}。只留最近几条，重试与重新生成复用。 */
const PROCESSED_LIMIT = 50;

/**
 * @param {{kernel?: ReturnType<import("./kernel.js").createKernel>, legacy?: typeof innerPromptProvider, classifier?: Function, waitMs?: number, now?: () => number}} deps
 */
export function createInnerProvider(deps = {}) {
  const legacy = deps.legacy ?? innerPromptProvider;
  const processed = new Map();

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

  /** context.js 的 innerProvider。 */
  return async function provide({ now, messages, source }) {
    const settings = await readSettings();
    const mode = settings.innerEngineMode ?? "shadow";
    const lastUser = [...(messages ?? [])].reverse().find((message) => message.role === "user");
    const safety = isSafetyRisk(lastUser?.text);
    const nowMs = now.getTime();
    const parts = [];
    const extraNow = [];
    let maxSegments;

    // 新内核的快照：同一份 epoch/seq/at，整条回复都用它。
    const snapshot = deps.kernel ? deps.kernel.snapshot(nowMs) : null;
    const bodyMap = mode === "body" ? mapBody(snapshot, { safety }) : null;

    if (mode !== "body") {
      const legacyResult = await legacy({ now, messages, source }).catch(() => null);
      if (legacyResult?.text) parts.push(legacyResult.text);
      maxSegments = legacyResult?.maxSegments;
    } else {
      const section = formatBodySection(bodyMap);
      if (section) parts.push(section);
    }

    if (settings.thoughtsEnabled !== false && lastUser?.id && lastUser.text) {
      const entry = await perceive(lastUser, nowMs).catch((error) => {
        log.warn("thoughts failed", { error: error?.message });
        return null;
      });
      if (entry) {
        // 注意预算：body 模式按精力与张力，其余模式用默认 2。安全例外放开到 4，不让疲惫挡住认真回应。
        const budget = safety ? 4 : bodyMap?.activeBudget ?? 2;
        const text = formatThoughtsSection(selectForPrompt(entry.groups, { activeBudget: budget }));
        if (text) parts.push(text);
      }
    }
    return { text: parts.length > 0 ? parts.join("\n\n") : null, maxSegments, safety, extraNow, snapshot: snapshot ? { epoch: snapshot.epoch, seq: snapshot.seq, at: snapshot.at } : null };
  };
}
