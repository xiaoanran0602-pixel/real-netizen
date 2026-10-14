// ============================================================
// 聊天状态的落盘（data/conversation-state.json）：只存「这段聊天聊到了什么份上」这一小块。
// 它是眼下的事，隔 45 分钟没人说话就算另起一回，所以不进回档范围，丢了也只是从头判断。
// 同一进程内串行读写；同一条消息只推进一次（conversation.advanceConversation 自己判重）。
// ============================================================

import { paths } from "../config/paths.js";
import { createSerializer, readJson, writeJsonAtomic } from "../store/files.js";
import { advanceConversation, MODES } from "./conversation.js";

const serialize = createSerializer();

function valid(state) {
  return state && typeof state === "object" && MODES.includes(state.mode) && typeof state.lastMessageId === "string" && Number.isFinite(state.lastAt) ? state : null;
}

export async function readConversationState() {
  return valid(await readJson(paths.conversationState(), null));
}

/**
 * 他发来一条消息：推进一步并落盘，返回新状态和推进前的状态（晚到的判断要从推进前重算）。
 * @param {Parameters<typeof advanceConversation>[1]} input
 */
export function stepConversation(input) {
  return serialize(async () => {
    const prev = await readConversationState();
    const next = advanceConversation(prev, input);
    if (next !== prev) await writeJsonAtomic(paths.conversationState(), next);
    return { state: next, prev: next === prev ? null : prev, fresh: next !== prev };
  });
}

/**
 * 决策模型晚到的判断：这一条回复已经按粗略猜测发出去了，不改它；只把状态改准，下一句从准的状态接着走。
 * 期间他又发了新消息（lastMessageId 变了）就作废。
 * @param {string} messageId
 * @param {(current: any) => any} recompute 拿到当前状态，返回按晚到判断重算的状态
 */
export function amendConversation(messageId, recompute) {
  return serialize(async () => {
    const current = await readConversationState();
    if (!current || current.lastMessageId !== messageId) return null;
    const next = valid(recompute(current));
    if (!next) return null;
    await writeJsonAtomic(paths.conversationState(), next);
    return next;
  });
}

/** 给当前这条消息的状态补几个字段（这一轮碰巧发生的小事）。他又发了新消息就作废。 */
export function patchConversationState(messageId, patch) {
  return serialize(async () => {
    const current = await readConversationState();
    if (!current || current.lastMessageId !== messageId) return null;
    const next = { ...current, ...patch };
    await writeJsonAtomic(paths.conversationState(), next);
    return next;
  });
}
