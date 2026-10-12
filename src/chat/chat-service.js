// ============================================================
// chat-service：对话的唯一写入者。网页、聊天渠道、主动消息、日结、回档都通过它排进同一条串行队列。
//
//   一轮：追加 user（重发时复用）→ 读 lastSeenAt 并写入现在 → 确保今天的日程 → 组提示词
//        → 调聊天模型（流式广播 typing/delta）→ 追加回复并广播 message + turn_done
//        失败：不写回复，广播 turn_error，user 消息保留（她“没看到”），可重发。
//   deferReply：只生成不写入（渠道的回复由 reply-timing 决定何时发，发出时再 appendAssistant）。
//   lastUserMessageAt 只由 web / channel 来源更新。
// ============================================================

import { appendMessage, getMainConversationId, newMessageId, readConversation, createConversation } from "../store/conversation.js";
import { readState, updateState } from "../store/state.js";
import { createLogger } from "../util/log.js";
import { buildModelMessages } from "./history.js";
import { createTaskQueue } from "./queue.js";

const log = createLogger("chat");
const HUMAN_SOURCES = new Set(["web", "channel"]);
export const TEXT_MAX_CHARS = 4000;

/**
 * @param {{
 *   complete: (opts: any) => Promise<string>,
 *   buildPrompt: (input: {now: Date, lastSeenAt?: number, messages: any[], extraNow?: string[], source: string}) => Promise<{system: any, afterTurn?: (reply: string) => Promise<void>, maxSegments?: number}>,
 *   ensureLife?: (now: Date) => Promise<unknown>,
 *   broadcast?: (type: string, data: any) => void,
 *   afterTurn?: (info: {source: string, reply: string}) => void,
 *   now?: () => Date,
 *   readSettings?: () => Promise<{replyMode?: string}>,
 * }} deps
 */
export function createChatService(deps) {
  const now = deps.now ?? (() => new Date());
  const broadcast = deps.broadcast ?? (() => {});
  const queue = createTaskQueue({ onError: (error, task) => log.warn("task failed", { kind: task.kind, error: error?.kind ?? error?.message }) });
  /** 她没回成的 user 消息 id（网页显示「消息未送达」）。 */
  const failed = new Set();

  async function conversation() {
    const id = await getMainConversationId();
    return { id, messages: await readConversation(id) };
  }

  function emitMessage(conversationId, message, clientId) {
    broadcast("message", { ...message, conversationId, ...(clientId ? { clientId } : {}) });
  }

  /** 重发：最后一条 user 文本相同且之后没有回复 → 复用，不再追加。 */
  function reusable(messages, text) {
    const last = messages.at(-1);
    return last && last.role === "user" && last.text === text ? last : null;
  }

  /**
   * 跑一轮（必须在队列里调用）。
   * @param {{text?: string, source: string, clientId?: string, id?: string, deferReply?: boolean, extraNow?: string[], at?: number}} input
   * @param {AbortSignal} signal
   */
  async function runTurn(input, signal) {
    const conv = await conversation();
    let userMessage = null;
    if (input.text !== undefined) {
      userMessage = reusable(conv.messages, input.text);
      if (!userMessage) {
        userMessage = await appendMessage(conv.id, { id: input.id, role: "user", text: input.text, source: input.source, at: input.at ?? now().getTime() });
      }
      failed.delete(userMessage.id);
      emitMessage(conv.id, userMessage, input.clientId);
    }
    const turnNow = now();
    const state = await readState();
    const lastSeenAt = Number(state.lastUserMessageAt) > 0 ? Number(state.lastUserMessageAt) : undefined;
    if (userMessage && HUMAN_SOURCES.has(input.source)) {
      await updateState({ lastUserMessageAt: userMessage.at });
      await deps.onUserMessage?.(userMessage)?.catch?.(() => undefined);
    }
    const replyTo = userMessage?.id ?? conv.messages.findLast((m) => m.role === "user")?.id;
    const settings = deps.readSettings ? await deps.readSettings() : {};
    const stream = !input.deferReply && settings.replyMode === "stream";
    if (!input.deferReply) broadcast("typing", { on: true });
    try {
      await deps.ensureLife?.(turnNow).catch((error) => log.warn("ensure life failed", { error: error?.message }));
      const messages = await readConversation(conv.id);
      // 修复：重新生成时（渠道占位之后），历史最后是她的占位话；以她的话结尾会被当成续写前缀。
      // 去掉最后一条他的话之后的她的话，改成在「现在」里告诉她已经先回过什么。
      const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
      const trailing = input.text === undefined && lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1).filter((m) => m.role === "assistant") : [];
      const history = trailing.length > 0 ? messages.slice(0, lastUserIndex + 1) : messages;
      const extraNow = [...(input.extraNow ?? []), ...(trailing.length > 0 ? [`你刚才已经先回了他一句：「${trailing.map((m) => m.text).join(" ")}」，现在有空了，接着好好回他。`] : [])];
      const prompt = await deps.buildPrompt({ now: turnNow, lastSeenAt, messages: history, extraNow, source: input.source });
      const reply = (
        await deps.complete({
          role: "chat",
          system: prompt.system,
          messages: buildModelMessages(history),
          stream: !input.deferReply,
          signal,
          onDelta: stream ? (text) => broadcast("delta", { text }) : undefined,
        })
      ).trim();
      if (signal.aborted) throw Object.assign(new Error("aborted"), { kind: "aborted" });
      let assistant = null;
      if (!input.deferReply) {
        assistant = await appendMessage(conv.id, { role: "assistant", text: reply, source: "chat", at: now().getTime() });
        emitMessage(conv.id, assistant);
        broadcast("typing", { on: false });
        broadcast("turn_done", { replyTo });
      }
      await prompt.afterTurn?.(reply).catch((error) => log.warn("afterTurn failed", { error: error?.message }));
      deps.afterTurn?.({ source: input.source, reply });
      return { ok: true, userMessage, reply, assistant, maxSegments: prompt.maxSegments };
    } catch (error) {
      if (replyTo) failed.add(replyTo);
      if (!input.deferReply) {
        broadcast("typing", { on: false });
        broadcast("turn_error", { replyTo, error: { kind: error?.kind ?? "error", message: error?.kind === "config" ? "还没连上她" : "消息未送达" } });
      }
      log.warn("turn failed", { source: input.source, kind: error?.kind, status: error?.status });
      return { ok: false, userMessage, error };
    }
  }

  return {
    queue,

    /**
     * 他说了一句话。立即返回预分配的消息 id 与这一轮的 Promise。
     * @param {string} text
      * @param {{source: "web"|"channel", clientId?: string, deferReply?: boolean, at?: number}} options
     */
    submitUserMessage(text, options) {
      const content = String(text ?? "").trim().slice(0, TEXT_MAX_CHARS);
      const id = newMessageId(options.at ?? now().getTime());
      const done = queue.enqueue((signal) => runTurn({ text: content, source: options.source, clientId: options.clientId, id, deferReply: options.deferReply, at: options.at }, signal), { kind: "turn" });
      done.catch(() => undefined);
      return { messageId: id, done };
    },

    /** 等这一轮结束再返回。 */
    sendUserMessage(text, options) {
      return this.submitUserMessage(text, options).done;
    },

    /** 不加新消息，按当前对话再生成一次（渠道待发期间他又说话、她醒来先回他）。 */
    regenerate(options = {}) {
      return queue.enqueue((signal) => runTurn({ source: options.source ?? "channel", deferReply: options.deferReply ?? true, extraNow: options.extraNow }, signal), { kind: "turn" });
    },

    /** 只记下他说的话、不生成回复（她睡着了：醒来后再 regenerate）。 */
    appendUser(text, { source = "channel", at } = {}) {
      return queue.enqueue(async () => {
        const conv = await conversation();
        const message = await appendMessage(conv.id, { role: "user", text: String(text).trim().slice(0, TEXT_MAX_CHARS), source, at: at ?? now().getTime() });
        emitMessage(conv.id, message);
        if (HUMAN_SOURCES.has(source)) {
          await updateState({ lastUserMessageAt: message.at });
          await deps.onUserMessage?.(message)?.catch?.(() => undefined);
        }
        return message;
      }, { kind: "append" });
    },

    /** 她说的一句话写进对话（主动消息、渠道的占位/正式回复）。走同一队列，不会插到别人一轮中间。 */
    appendAssistant(text, { source = "chat", at } = {}) {
      return queue.enqueue(async () => {
        const conv = await conversation();
        const message = await appendMessage(conv.id, { role: "assistant", text: String(text).trim(), source, at: at ?? now().getTime() });
        emitMessage(conv.id, message);
        if (source === "proactive") await updateState({ lastProactiveAt: message.at });
        return message;
      }, { kind: "append" });
    },

    /** 系统任务（日结、回档）。front=true 插队；force=true 在阻塞时也能跑。 */
    runSystemTask(fn, options = {}) {
      return queue.enqueue(fn, { kind: "system", front: options.front, force: options.force });
    },

    async startNewConversation() {
      return queue.enqueue(async () => {
        const id = await createConversation();
        failed.clear();
        broadcast("settings", { conversationId: id });
        return id;
      }, { kind: "system" });
    },

    failedIds: () => [...failed],
    clearFailed: () => failed.clear(),
    idle: () => queue.idle(),
  };
}
