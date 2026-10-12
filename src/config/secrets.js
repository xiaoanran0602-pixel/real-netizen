// ============================================================
// data/secrets/：模型接入（model.json）、聊天渠道凭据（channels.json）、网页访问令牌（access-token.txt）。
// 规矩：接口永远不返回完整 Key；保存时密钥类字段留空 = 不改；日志不打印。
// ============================================================

import { randomBytes } from "node:crypto";
import { paths } from "./paths.js";
import { readCached, readJson, readText, writeJsonAtomic, writeTextAtomic } from "../store/files.js";

export const MODEL_PROTOCOLS = Object.freeze(["anthropic", "openai"]);
const FIELD_MAX_CHARS = 300;
const KEY_TAIL_CHARS = 4;
const TOKEN_BYTES = 24;

// ---------------- 模型 ----------------

/**
 * @typedef {{protocol: "anthropic"|"openai", baseUrl: string, apiKey: string, chatModel: string, backgroundModel: string}} ModelSecrets
 */

/** @returns {ModelSecrets} */
export function normalizeModelSecrets(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const str = (key) => (typeof input[key] === "string" ? input[key].trim() : "");
  return {
    protocol: MODEL_PROTOCOLS.includes(input.protocol) ? input.protocol : "anthropic",
    baseUrl: str("baseUrl"),
    apiKey: str("apiKey"),
    chatModel: str("chatModel"),
    backgroundModel: str("backgroundModel"),
  };
}

export async function readModelSecrets() {
  const raw = await readCached(paths.modelSecrets(), (text) => JSON.parse(text.replace(/^\uFEFF/u, "")));
  return normalizeModelSecrets(raw);
}

export function isModelReady(secrets) {
  return Boolean(secrets.baseUrl && secrets.apiKey && secrets.chatModel);
}

/** 给设置页看的版本：Key 只给有没有填和末 4 位。 */
export function maskModelSecrets(secrets) {
  return {
    protocol: secrets.protocol,
    baseUrl: secrets.baseUrl,
    chatModel: secrets.chatModel,
    backgroundModel: secrets.backgroundModel,
    hasApiKey: Boolean(secrets.apiKey),
    apiKeyTail: secrets.apiKey ? secrets.apiKey.slice(-KEY_TAIL_CHARS) : "",
  };
}

/**
 * 合并保存。apiKey 留空不改；backgroundModel 允许清空（清空 = 后台用聊天模型）。
 * @returns {{secrets?: ModelSecrets, rejected: string[]}}
 */
export function mergeModelPatch(current, patch) {
  const rejected = [];
  const next = { ...current };
  const input = patch && typeof patch === "object" ? patch : {};
  if (input.protocol !== undefined) {
    if (MODEL_PROTOCOLS.includes(input.protocol)) next.protocol = input.protocol;
    else rejected.push("protocol");
  }
  for (const key of ["baseUrl", "chatModel", "backgroundModel", "apiKey"]) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > FIELD_MAX_CHARS) {
      rejected.push(key);
      continue;
    }
    const trimmed = value.trim();
    if (key === "apiKey" && !trimmed) continue;
    if ((key === "baseUrl" || key === "chatModel") && !trimmed) continue;
    if (key === "baseUrl" && !/^https?:\/\//iu.test(trimmed)) {
      rejected.push(key);
      continue;
    }
    next[key] = trimmed;
  }
  return rejected.length > 0 ? { rejected } : { secrets: next, rejected };
}

export async function updateModelSecrets(patch) {
  const current = normalizeModelSecrets(await readJson(paths.modelSecrets(), {}));
  const result = mergeModelPatch(current, patch);
  if (result.secrets) await writeJsonAtomic(paths.modelSecrets(), result.secrets);
  return result;
}

// ---------------- 聊天渠道 ----------------

/** 每个渠道哪些字段必填、哪些字段是密钥（只显示末 4 位）。 */
const CHANNEL_FIELDS = Object.freeze({
  telegram: Object.freeze({ required: Object.freeze(["botToken", "ownerChatId"]), secret: Object.freeze(["botToken"]) }),
  webhook: Object.freeze({ required: Object.freeze(["secret", "outboundUrl", "ownerId"]), secret: Object.freeze(["secret"]) }),
});

/** 读全部渠道凭据（没有就给空对象）。 */
export async function readChannelSecrets() {
  return readJson(paths.channelSecrets(), {});
}

/**
 * 某个渠道凭据是否齐全：启用了，且该渠道所有必填字段非空。
 * @param {string} id 渠道 id
 * @param {Record<string, any>} secrets channels.json 的完整内容
 */
export function isChannelReady(id, secrets) {
  const config = (secrets ?? {})[id] ?? {};
  if (!config.enabled) return false;
  const required = CHANNEL_FIELDS[id]?.required ?? [];
  return required.every((key) => String(config[key] ?? "").trim().length > 0);
}

/**
 * 给设置页看的版本：普通字段原样返回，密钥字段只返回「是否已填 + 末 4 位」。
 * @param {Record<string, any>} secrets
 */
export function maskChannelSecrets(secrets) {
  const out = {};
  for (const [id, raw] of Object.entries(secrets ?? {})) {
    const config = raw && typeof raw === "object" ? raw : {};
    const secretKeys = new Set(CHANNEL_FIELDS[id]?.secret ?? []);
    const masked = { enabled: Boolean(config.enabled) };
    for (const [key, value] of Object.entries(config)) {
      if (key === "enabled") continue;
      if (secretKeys.has(key)) {
        const text = String(value ?? "");
        masked[key] = { set: text.length > 0, tail: text ? text.slice(-KEY_TAIL_CHARS) : "" };
      } else {
        masked[key] = value ?? "";
      }
    }
    out[id] = masked;
  }
  return out;
}

/**
 * 从接口请求体里挑出可改的字段：密钥类留空不改，未知字段、超长字段丢弃。
 * patch 形如 { telegram: { botToken: "..." }, webhook: { enabled: true } }。
 * @param {Record<string, any>} body
 */
export function pickChannelPatch(body) {
  const patch = {};
  const input = body && typeof body === "object" ? body : {};
  for (const [id, raw] of Object.entries(input)) {
    if (!CHANNEL_FIELDS[id] || !raw || typeof raw !== "object") continue;
    const next = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === "enabled") {
        if (typeof value === "boolean") next.enabled = value;
        continue;
      }
      if (typeof value !== "string" || value.length > FIELD_MAX_CHARS) continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      next[key] = trimmed;
    }
    patch[id] = next;
  }
  return patch;
}

/** 同一进程里串行写 channels.json（多个接口可能同时保存）。 */
let channelChain = Promise.resolve();
export function writeChannelSecrets(patch) {
  const run = async () => {
    const current = await readChannelSecrets();
    const next = { ...current };
    for (const [id, fields] of Object.entries(patch ?? {})) {
      next[id] = { ...(current[id] ?? {}), ...fields };
    }
    await writeJsonAtomic(paths.channelSecrets(), next);
    return next;
  };
  const next = channelChain.then(run, run);
  channelChain = next.catch(() => undefined);
  return next;
}

// ---------------- 访问令牌 ----------------

export async function readAccessToken() {
  const text = await readText(paths.accessToken());
  return text?.trim() || "";
}

/** 没有令牌时生成一个（局域网监听必须有令牌）。 */
export async function ensureAccessToken() {
  const existing = await readAccessToken();
  if (existing) return existing;
  const token = randomBytes(TOKEN_BYTES).toString("base64").replace(/[+/=]/gu, "");
  await writeTextAtomic(paths.accessToken(), token);
  return token;
}
