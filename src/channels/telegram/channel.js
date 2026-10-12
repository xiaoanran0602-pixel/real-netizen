// ============================================================
// Telegram 渠道：用 Bot Token 长轮询收私聊消息，转成 InboundMessage 交给 bridge；
//   发文字/图片直接调 Telegram Bot API。忽略群消息和没有文字的消息。
//   凭据：botToken（调 API）、ownerChatId（只回复这个人）。
//   --dry 下不启动轮询；测试时把 channelApiHost 指到假服务器。
// ============================================================

import { isChannelReady } from "../../config/secrets.js";
import { createLogger } from "../../util/log.js";
import { getUpdates, sendMessage, sendPhoto, setMyDescription, setMyShortDescription } from "./api.js";

const log = createLogger("telegram");
const CHANNEL_ID = "telegram";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把一条 update 转成统一的入站消息；不是私聊文字消息返回 null（bridge 只看文字）。 */
function toInbound(update) {
  const message = update?.message ?? update?.edited_message ?? null;
  if (!message?.chat || message.chat.type !== "private") return null;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) return null;
  return {
    channelId: CHANNEL_ID,
    eventId: String(update.update_id),
    senderId: String(message.chat.id),
    text,
    at: Number(message.date) * 1000 || Date.now(),
  };
}

let running = false;
let controller = null;
let offset;
let pollTask = null;

/** 长轮询主循环：offset 递增确认已处理的 update，stop/abort 后退出。 */
async function pollLoop(secrets, onMessage, signal) {
  while (running) {
    try {
      const updates = await getUpdates(secrets.botToken, offset, { signal });
      for (const update of updates) {
        if (Number.isFinite(update.update_id)) offset = update.update_id + 1;
        const message = toInbound(update);
        if (message) onMessage(message);
      }
    } catch (error) {
      if (!running || error?.name === "AbortError") return;
      log.warn("poll failed, retrying", { error: error?.message });
      await sleep(1000);
    }
  }
}

export const telegramChannel = {
  id: CHANNEL_ID,
  label: "Telegram",
  hint: "无需公网地址，用 Bot Token 长轮询收消息。",
  ownerKey: "ownerChatId",
  fields: Object.freeze([
    { key: "botToken", label: "Bot Token", secret: true, hint: "BotFather 发给你的令牌，形如 123456:ABC-DEF。" },
    { key: "ownerChatId", label: "你的 Chat ID", hint: "只回复这个账号的消息。给机器人发一条消息后可从 getUpdates 里看到。" },
  ]),

  isReady(secrets) {
    return isChannelReady(CHANNEL_ID, secrets);
  },

  /** 启动长轮询；立即返回，轮询在后台进行。stop 后退出循环。 */
  async start({ secrets, onMessage }) {
    if (running) return;
    if (!secrets?.botToken) return;
    running = true;
    controller = new AbortController();
    const { signal } = controller;
    // 后台跑轮询，不阻塞 start；pollLoop 内部处理错误与退避，这里只兜底未捕获的拒绝。
    pollTask = pollLoop(secrets, onMessage, signal).catch((error) => {
      if (error?.name !== "AbortError") log.warn("poll loop ended with error", { error: error?.message });
    });
  },

  async stop() {
    running = false;
    controller?.abort();
    controller = null;
    await pollTask;
    pollTask = null;
  },

  async sendText(secrets, text) {
    await sendMessage(secrets.botToken, secrets.ownerChatId, text);
  },

  async sendImage(secrets, bytes, filename, caption) {
    await sendPhoto(secrets.botToken, secrets.ownerChatId, bytes, filename, caption);
  },

  /** 签名 → 机器人「关于」；名字 → 一句话简介。 */
  async updateProfile(secrets, profile) {
    if (profile.signature) await setMyDescription(secrets.botToken, profile.signature);
    if (profile.name) await setMyShortDescription(secrets.botToken, profile.name);
  },
};
