// ============================================================
// OpenAI 兼容 Chat Completions：地址、请求头、请求体（reasoning_effort）、流解析、非流解析。
// ============================================================

import { readSse } from "./sse.js";

/** 地址拼接：以 /chat/completions 结尾原样用；以 /v1 结尾拼 /chat/completions；否则拼 /v1/chat/completions。 */
export function openaiUrl(baseUrl) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/u, "");
  if (/\/chat\/completions$/u.test(base)) return base;
  if (/\/v1$/u.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function openaiHeaders(apiKey) {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

/**
 * @param {{model: string, system?: {stable?: string, dynamic?: string} | string, messages: {role: string, content: string}[], maxTokens: number, reasoning: string, stream: boolean, withReasoning: boolean}} input
 */
export function openaiBody(input) {
  const systemText = typeof input.system === "string" ? input.system : [input.system?.stable, input.system?.dynamic].filter((part) => part?.trim()).join("\n\n");
  const messages = [...(systemText?.trim() ? [{ role: "system", content: systemText }] : []), ...input.messages.map((m) => ({ role: m.role, content: m.content }))];
  /** @type {Record<string, unknown>} */
  const body = { model: input.model, max_tokens: input.maxTokens, messages };
  if (input.withReasoning && input.reasoning && input.reasoning !== "off") body.reasoning_effort = input.reasoning;
  if (input.stream) body.stream = true;
  return body;
}

export function openaiParseResponse(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
  return "";
}

/** @param {ReadableStream<Uint8Array>} body */
export async function* openaiStream(body) {
  for await (const { data } of readSse(body)) {
    if (!data || data === "[DONE]") continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (payload.error) {
      const error = new Error(payload.error.message ?? "stream error");
      error.streamError = true;
      throw error;
    }
    const delta = payload.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) yield delta;
  }
}
