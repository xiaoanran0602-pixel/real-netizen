// ============================================================
// Telegram Bot API 薄封装：长轮询 getUpdates、发文字/图片、读机器人信息、改简介。
//   - 基址取 runtime 的 channelApiHost（默认 https://api.telegram.org），方便联调指到假服务器。
//   - 网络错误指数退避（至 60 秒）；被限流（429/409）退避 10 秒后重试；请求本身有错直接抛。
//   - --dry 时所有发送类方法直接返回，不真发。
// ============================================================

import { isDry, runtimeOptions } from "../../config/runtime.js";
import { createLogger } from "../../util/log.js";

const log = createLogger("telegram");
const LONG_POLL_TIMEOUT_S = 30;
const REQUEST_TIMEOUT_MS = 20_000;
const LONG_POLL_REQUEST_TIMEOUT_MS = 40_000;
const RATE_LIMIT_BACKOFF_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const DEFAULT_RETRIES = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 请求有明确的对错之分（Token 错、Chat 不存在），重试没用。网络抖动/限流才重试。 */
class TelegramError extends Error {
  constructor(message) {
    super(message);
    this.name = "TelegramError";
  }
}

function apiUrl(token, method) {
  const host = String(runtimeOptions().channelApiHost || "https://api.telegram.org").replace(/\/+$/u, "");
  return `${host}/bot${token}/${method}`;
}

function backoff(attempt) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

/**
 * @param {string} method       Telegram 方法名（sendMessage 等）
 * @param {string} token       机器人令牌
 * @param {{query?: URLSearchParams, form?: FormData, timeoutMs?: number, maxRetries?: number}} [options]
 */
async function call(method, token, options = {}) {
  const { query, form, timeoutMs = REQUEST_TIMEOUT_MS, maxRetries = DEFAULT_RETRIES, signal } = options;
  let url = apiUrl(token, method);
  if (query) url += `?${query}`;
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(url, {
        method: "POST",
        ...(form ? { body: form } : {}),
        signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429 || response.status === 409) {
        const body = await response.json().catch(() => ({}));
        const wait = response.status === 429 && Number(body?.parameters?.retry_after) ? Number(body.parameters.retry_after) * 1000 : RATE_LIMIT_BACKOFF_MS;
        log.warn("rate limited, backing off", { method, wait });
        await sleep(wait);
        continue;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok === false) {
        throw new TelegramError(`Telegram ${method} 失败：${body?.error_code ?? response.status} ${body?.description ?? response.statusText}`.trim());
      }
      return body;
    } catch (error) {
      if (error instanceof TelegramError || error?.name === "AbortError") throw error;
      if (attempt >= maxRetries) throw error;
      const delay = backoff(attempt++);
      log.warn("request failed, backing off", { method, attempt, delay, error: error?.message });
      await sleep(delay);
    }
  }
}

/** 拉一轮消息；offset 用来确认已处理过的 updateId，timeout 30 秒长轮询。网络断了自动退避重连。 */
export async function getUpdates(token, offset, { signal } = {}) {
  if (isDry()) return [];
  const query = new URLSearchParams({ timeout: String(LONG_POLL_TIMEOUT_S), limit: "10" });
  if (offset) query.set("offset", String(offset));
  const body = await call("getUpdates", token, { query, timeoutMs: LONG_POLL_REQUEST_TIMEOUT_MS, maxRetries: Number.POSITIVE_INFINITY, signal });
  return Array.isArray(body?.result) ? body.result : [];
}

/** 发一段纯文字。 */
export async function sendMessage(token, chatId, text) {
  if (isDry()) return null;
  const query = new URLSearchParams({ chat_id: String(chatId), text: String(text ?? "") });
  const body = await call("sendMessage", token, { query });
  return body?.result ?? null;
}

/** 发一张图（手工 multipart），caption 可选。 */
export async function sendPhoto(token, chatId, bytes, filename, caption) {
  if (isDry()) return null;
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([bytes], { type: "image/jpeg" }), filename || "photo.jpg");
  if (caption) form.append("caption", String(caption));
  const body = await call("sendPhoto", token, { form });
  return body?.result ?? null;
}

/** 读机器人自己的信息（验证令牌是否有效）。 */
export async function getMe(token) {
  if (isDry()) return null;
  const body = await call("getMe", token, {});
  return body?.result ?? null;
}

/** 改机器人的「关于」简介。 */
export async function setMyDescription(token, description) {
  if (isDry()) return null;
  const query = new URLSearchParams({ description: String(description ?? "") });
  const body = await call("setMyDescription", token, { query });
  return body?.result ?? true;
}

/** 改机器人的一句话简介。 */
export async function setMyShortDescription(token, description) {
  if (isDry()) return null;
  const query = new URLSearchParams({ short_description: String(description ?? "") });
  const body = await call("setMyShortDescription", token, { query });
  return body?.result ?? true;
}

/** 验证凭据：能拿到自己的信息就算通。 */
export async function checkTelegramCredentials(token) {
  return getMe(token);
}
