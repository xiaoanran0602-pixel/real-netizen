// ============================================================
// Anthropic Messages：地址、请求头、请求体（推理强度、system 分段缓存）、流解析、非流解析。
// ============================================================

import { readSse } from "./sse.js";

export const ANTHROPIC_VERSION = "2023-06-01";

/** 地址拼接：去掉末尾 /；以 /messages 结尾原样用；以 /v1 结尾拼 /messages；否则拼 /v1/messages。 */
export function anthropicUrl(baseUrl) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/u, "");
  if (/\/messages$/u.test(base)) return base;
  if (/\/v1$/u.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

export function anthropicHeaders(apiKey) {
  return { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION };
}

/**
 * @param {{model: string, system?: {stable?: string, dynamic?: string} | string, messages: {role: string, content: string}[], maxTokens: number, reasoning: string, stream: boolean, withReasoning: boolean}} input
 */
export function anthropicBody(input) {
  /** @type {Record<string, unknown>} */
  const body = { model: input.model, max_tokens: input.maxTokens, messages: input.messages.map((m) => ({ role: m.role, content: m.content })) };
  const system = systemBlocks(input.system);
  if (system) body.system = system;
  // 现网实测形态：自适应思考 + output_config.effort。「关闭」不带思考参数。
  if (input.withReasoning && input.reasoning && input.reasoning !== "off") {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: input.reasoning };
  }
  if (input.stream) body.stream = true;
  return body;
}

/** system 拆两段：稳定段（人设+规则）带 cache_control，动态段不带。 */
function systemBlocks(system) {
  if (!system) return undefined;
  if (typeof system === "string") return system.trim() ? system : undefined;
  const blocks = [];
  if (system.stable?.trim()) blocks.push({ type: "text", text: system.stable, cache_control: { type: "ephemeral" } });
  if (system.dynamic?.trim()) blocks.push({ type: "text", text: system.dynamic });
  return blocks.length > 0 ? blocks : undefined;
}

/** 非流式：只取 text 块，忽略 thinking。 */
export function anthropicParseResponse(json) {
  return (Array.isArray(json?.content) ? json.content : [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * 流式：yield 文本增量。遇到 error 事件抛出。
 * @param {ReadableStream<Uint8Array>} body
 */
export async function* anthropicStream(body) {
  for await (const { event, data } of readSse(body)) {
    if (!data || data === "[DONE]") continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const type = payload.type ?? event;
    if (type === "error") {
      const error = new Error(payload.error?.message ?? "stream error");
      error.streamError = true;
      throw error;
    }
    if (type === "content_block_delta" && payload.delta?.type === "text_delta" && payload.delta.text) yield payload.delta.text;
  }
}
