// ============================================================
// 聊天渠道桥：把任意渠道收到的消息合批后交给 chat-service，再把她的回复分段发回同一渠道；
//   也负责她主动找他（发到所有已启用渠道）。
//   - eventId 去重；只回复 ownerId 本人；对方 2.5 秒内连发合成一轮。
//   - 回复何时发、发几段由 replyTiming 决定；网页保持即时、不经过这里。
//   - 回复发完再 appendAssistant 写进对话（写入时间 = 实际发出时间）。
//   - 主动找他：先发所有启用渠道，成功后 appendAssistant(source:"proactive")，再写一条 self_daily 记忆。
// ============================================================

import { join } from "node:path";
import { paths } from "../config/paths.js";
import { readChannelSecrets, isChannelReady } from "../config/secrets.js";
import { channelById, CHANNELS, enabledChannels } from "./registry.js";
import { readBytes } from "../store/files.js";
import { createLogger } from "../util/log.js";
import { formatLocalDate, randomBetween } from "../util/time.js";
import { splitParagraphs } from "../util/text.js";
import { writeMomentMemory } from "../moments/store.js";

const log = createLogger("channels");
export const BATCH_WINDOW_MS = 2_500;
const SEEN_EVENT_LIMIT = 500;
const SEGMENT_DELAY_MIN_MS = 900;
const SEGMENT_DELAY_PER_CHAR_MS = 60;
const SEGMENT_DELAY_MAX_MS = 3_000;
const SEGMENT_JITTER_MS = 400;

/** 按空行拆段；maxSegments 截段数不截半句（多出的并进最后一段）。 */
export function splitSegments(text, maxSegments) {
  const segments = splitParagraphs(text);
  if (!maxSegments || segments.length <= maxSegments) return segments;
  return [...segments.slice(0, maxSegments - 1), segments.slice(maxSegments - 1).join("\n")];
}

export function segmentDelay(segment) {
  return Math.min(SEGMENT_DELAY_MAX_MS, SEGMENT_DELAY_MIN_MS + segment.length * SEGMENT_DELAY_PER_CHAR_MS) + randomBetween(0, SEGMENT_JITTER_MS);
}

/**
 * @param {{
 *   chatService: ReturnType<import("../chat/chat-service.js").createChatService>,
 *   onReplied?: (text: string) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   batchWindowMs?: number,
 *   replyTiming?: { onIncoming: (batch: {texts: string[], at: number, channelId: string}, ctx: any) => Promise<void> | void } | null,
 * }} deps
 */
export function createChannelBridge(deps) {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const batchWindowMs = deps.batchWindowMs ?? BATCH_WINDOW_MS;
  const seen = [];
  let pending = [];
  let batchTimer;
  let chain = Promise.resolve();

  /** 不带任何状态地发一段文字；渠道未启用或发送失败返回 false。 */
  async function sendTextVia(channelId, text) {
    const channel = channelById(channelId);
    if (!channel) return false;
    const secrets = await readChannelSecrets();
    if (!isChannelReady(channelId, secrets)) return false;
    await channel.sendText(secrets[channelId] ?? {}, text);
    return true;
  }

  /** 像真人一样一句一句发：按空行拆开，按长度停顿；发完写一段进对话。 */
  async function sendReply(text, { maxSegments, source = "channel", channelId } = {}) {
    if (!channelId) return false;
    const segments = splitSegments(text, maxSegments);
    for (const [index, segment] of segments.entries()) {
      if (index > 0) await sleep(segmentDelay(segment));
      if (!(await sendTextVia(channelId, segment))) return false;
    }
    await deps.chatService.appendAssistant(segments.join("\n\n"), { source, channelId });
    return true;
  }

  /** 缺省：立即生成、立即发。 */
  async function runImmediate(batch, { sendReply: deliver }) {
    const text = batch.texts.join("\n");
    const result = await deps.chatService.sendUserMessage(text, { source: "channel", deferReply: true, at: batch.at });
    if (!result.ok) return;
    await deliver(result.reply, { maxSegments: result.maxSegments });
    deps.onReplied?.(`他：${text}\n我：${result.reply}`);
  }

  function flush() {
    batchTimer = undefined;
    const items = pending.splice(0);
    if (items.length === 0) return;
    const channelId = items[0].channelId;
    const batch = { texts: items.map((item) => item.text), at: Date.now(), channelId };
    const deliver = (text, options = {}) => sendReply(text, { channelId, ...options });
    // 串行处理：上一轮回复发完再处理下一轮，保证消息顺序。
    chain = chain
      .then(() =>
        deps.replyTiming
          ? deps.replyTiming.onIncoming(batch, { sendReply: deliver, chatService: deps.chatService, onReplied: deps.onReplied })
          : runImmediate(batch, { sendReply: deliver }),
      )
      .catch((error) => log.warn("turn failed", { error: error?.message }));
  }

  /**
   * 收到一条渠道消息：去重、只理 owner，攒一小会儿合成一轮。立即返回（保证 1 秒内回 200）。
   * @param {import("./types.js").InboundMessage} message
   * @returns {Promise<"duplicate"|"not-owner"|"ignored"|"queued">}
   */
  async function handleIncoming(message) {
    const { channelId, eventId, senderId } = message;
    if (eventId) {
      if (seen.includes(eventId)) return "duplicate";
      seen.push(eventId);
      if (seen.length > SEEN_EVENT_LIMIT) seen.shift();
    }
    const secrets = await readChannelSecrets();
    const channel = channelById(channelId);
    const config = secrets[channelId] ?? {};
    const ownerKey = channel?.ownerKey;
    // 只回复主人；其他人（即便看得到这个机器人）一律不理。
    if (!config.enabled || !ownerKey || String(senderId ?? "") !== String(config[ownerKey] ?? "")) {
      log.info("ignored message from non-owner");
      return "not-owner";
    }
    const text = String(message.text ?? "").trim();
    if (!text) return "ignored";
    pending.push({ text, channelId });
    // 他习惯连发几条：攒一小会儿合成一轮，避免她每条都单独回。
    clearTimeout(batchTimer);
    batchTimer = setTimeout(flush, batchWindowMs);
    return "queued";
  }

  return {
    sendReply,
    handleIncoming,

    /**
     * 她主动发消息：先发到所有已启用渠道（可带一张她自己「拍」的图），成功后写进对话，再写一条她这几天的记忆。
     * caption 是这张图是什么（给她自己记），写进对话和记忆，聊天时她知道自己发过什么图。
     * @returns {Promise<boolean>}
     */
    async sendProactive(text, imageFile, reason, caption) {
      const secrets = await readChannelSecrets();
      const channels = enabledChannels(secrets);
      if (channels.length === 0) return false;
      let imageSent = false;
      let sentAny = false;
      for (const channel of channels) {
        const config = secrets[channel.id] ?? {};
        if (imageFile && channel.sendImage) {
          try {
            const bytes = await readBytes(join(paths.media(), imageFile));
            if (bytes) {
              await channel.sendImage(config, bytes, imageFile, caption);
              imageSent = true;
            }
          } catch (error) {
            log.warn("proactive image failed", { channel: channel.id, error: error?.message });
          }
        }
        const segments = splitSegments(text);
        let ok = true;
        for (const [index, segment] of segments.entries()) {
          if (index > 0) await sleep(segmentDelay(segment));
          try {
            ok = await sendTextVia(channel.id, segment);
          } catch (error) {
            log.warn("proactive send failed", { channel: channel.id, error: error?.message });
            ok = false;
          }
          if (!ok) break;
        }
        if (ok) sentAny = true;
      }
      if (!sentAny) return false;
      if (imageSent) await deps.chatService.appendAssistant(`[发了一张照片：${caption || "随手拍的"}]`, { source: "proactive" }).catch(() => undefined);
      await deps.chatService.appendAssistant(text, { source: "proactive" });
      await writeMomentMemory({
        kind: "self_daily",
        slug: `channel-${Date.now().toString(36)}`,
        description: `我主动给他发了消息：${text.slice(0, 30)}`,
        body: `${formatLocalDate()} 我主动在聊天渠道上找他${imageSent ? `，先发了一张照片（${caption || "随手拍的"}）` : ""}，说：「${text}」${reason ? `。因为${reason}` : ""}`,
      });
      return true;
    },

    /** 测试与回档用：清掉还没合批处理的消息，以及待回复队列。 */
    async clearPending() {
      clearTimeout(batchTimer);
      batchTimer = undefined;
      pending = [];
      await deps.replyTiming?.clear?.();
    },

    /** 重启后恢复待回复队列（过期的立即发）。 */
    async restorePending() {
      return (await deps.replyTiming?.restore?.({ sendReply, chatService: deps.chatService, onReplied: deps.onReplied })) ?? false;
    },

    /** 启动所有已启用的渠道（长轮询 / webhook 入站）。 */
    async start() {
      const secrets = await readChannelSecrets();
      for (const channel of enabledChannels(secrets)) {
        try {
          await channel.start({ secrets: secrets[channel.id] ?? {}, onMessage: (message) => handleIncoming(message) });
        } catch (error) {
          log.warn("channel start failed", { channel: channel.id, error: error?.message });
        }
      }
    },

    /** 停止所有渠道。 */
    async stop() {
      for (const channel of CHANNELS) {
        try {
          await channel.stop?.();
        } catch (error) {
          log.warn("channel stop failed", { channel: channel.id, error: error?.message });
        }
      }
    },

    idle: () => chain,
  };
}
