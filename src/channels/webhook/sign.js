// ============================================================
// Webhook 渠道签名：和中转服务约定的 HMAC-SHA256 签名。
//   入站：x-rn-signature = hex(hmac_sha256(secret, 原始 body))，x-rn-timestamp 5 分钟窗口防重放。
//   出站：用同一个 secret 给中转服务签同样的名，中转服务按同规则验。
// ============================================================

import { createHmac, timingSafeEqual } from "node:crypto";

const TIMESTAMP_WINDOW_MS = 5 * 60_000;

/** 对原始 body 签名（十六进制）。 */
export function signPayload(secret, rawBody) {
  return createHmac("sha256", String(secret ?? "")).update(String(rawBody ?? "")).digest("hex");
}

/** 常量时间比较，防时序攻击。长度不同直接返回 false。 */
export function verifySignature(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const expected = Buffer.from(signPayload(secret, rawBody), "hex");
  const given = Buffer.from(String(signature), "hex");
  if (expected.length === 0 || expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** 时间戳是否在 5 分钟窗口内（防重放）。 */
export function verifyTimestamp(timestamp, now = Date.now()) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return Math.abs(now - ts) <= TIMESTAMP_WINDOW_MS;
}

/** 入站请求一次性验完：时间戳窗口 + 签名。 */
export function verifyWebhook({ secret, rawBody, signature, timestamp, now }) {
  return verifyTimestamp(timestamp, now) && verifySignature(secret, rawBody, signature);
}
