// ============================================================
// Webhook 渠道：没有自己的服务器，靠一个中转服务（QQ / 微信 / 飞书……）转发消息。
//   入站：中转服务 POST 到 /api/lin/channels/webhook，body {eventId, senderId, text, at?}，
//         带 x-rn-signature + x-rn-timestamp；路由验签后交给 bridge。
//   出站：她主动说话或回复时，POST outboundUrl（同样签名），body {type, text|image, ownerId, at}。
//   「启动」无需做任何事（没有长轮询），所以 start/stop 都是空操作。
// ============================================================

import { isChannelReady } from "../../config/secrets.js";
import { isDry } from "../../config/runtime.js";
import { createLogger } from "../../util/log.js";
import { signPayload, verifyWebhook } from "./sign.js";

const log = createLogger("webhook");
const CHANNEL_ID = "webhook";
const REQUEST_TIMEOUT_MS = 20_000;

/** 中转服务把消息推给她的入口路径（免访问令牌，靠签名）。 */
export const WEBHOOK_PATH = "/api/lin/channels/webhook";

/** 把中转服务的 body 解析成统一的入站消息；字段不全返回 null。 */
export function parseInbound(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return null;
  return {
    channelId: CHANNEL_ID,
    eventId: payload.eventId ? String(payload.eventId) : "",
    senderId: payload.senderId ? String(payload.senderId) : "",
    text,
    at: Number(payload.at) || Date.now(),
  };
}

/** 带签名地把消息推给中转服务。 */
async function postOutbound(secrets, payload) {
  if (isDry()) return null;
  if (!secrets?.outboundUrl) throw new Error("webhook 未配置出站地址");
  const rawBody = JSON.stringify(payload);
  const timestamp = Date.now();
  const response = await fetch(secrets.outboundUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-rn-timestamp": String(timestamp),
      "x-rn-signature": signPayload(secrets.secret, rawBody),
    },
    body: rawBody,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`webhook 出站失败：${response.status}`);
}

export const webhookChannel = {
  id: CHANNEL_ID,
  label: "Webhook（自建中转）",
  hint: "把她的入口暴露给一个中转服务，由它转发 QQ / 微信 / 飞书等任意平台。",
  ownerKey: "ownerId",
  fields: Object.freeze([
    { key: "secret", label: "签名密钥", secret: true, hint: "HMAC-SHA256 签名用，和中转服务约定一致。" },
    { key: "outboundUrl", label: "出站地址", hint: "中转服务接收她主动消息的 URL（POST）。" },
    { key: "ownerId", label: "你的 ID", hint: "中转服务里代表你本人的 id；只回复这个人的消息。" },
  ]),

  isReady(secrets) {
    return isChannelReady(CHANNEL_ID, secrets);
  },

  /** 入站由 HTTP 路由直接推给 bridge，这里无需启动任何轮询。 */
  async start() {},

  async stop() {},

  async sendText(secrets, text) {
    await postOutbound(secrets, { type: "text", text, ownerId: secrets.ownerId ?? "", at: Date.now() });
  },

  async sendImage(secrets, bytes, filename, caption) {
    await postOutbound(secrets, {
      type: "image",
      image: { base64: Buffer.from(bytes).toString("base64"), filename: filename || "photo.jpg", caption: caption ?? "" },
      ownerId: secrets.ownerId ?? "",
      at: Date.now(),
    });
  },

  /** 校验中转服务推过来的入站请求（时间戳窗口 + 签名）。 */
  verifyInbound({ secret, rawBody, signature, timestamp }) {
    return verifyWebhook({ secret, rawBody, signature, timestamp });
  },

  parseInbound,
};
