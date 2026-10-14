// ============================================================
// 对外唯一的模型入口：complete({role:'chat'|'background', system, messages, stream, onDelta})。
// 每次调用都重新读 secrets/model.json 与 settings（按 mtime 缓存），设置页保存后下一次调用生效。
// 错误统一为 ModelError{kind:'http'|'network'|'timeout'|'empty'|'config', status?, message}，不含 Key。
// ============================================================

import { readModelSecrets, isModelReady } from "../config/secrets.js";
import { readSettings } from "../config/settings.js";
import { createLogger } from "../util/log.js";
import { normalizeTurns } from "../chat/history.js";
import { anthropicBody, anthropicHeaders, anthropicParseResponse, anthropicStream, anthropicUrl } from "./anthropic.js";
import { openaiBody, openaiHeaders, openaiParseResponse, openaiStream, openaiUrl } from "./openai.js";

const log = createLogger("model");
export const CHAT_TIMEOUT_MS = 120_000;
export const BACKGROUND_TIMEOUT_MS = 60_000;
const BACKGROUND_DEFAULT_MAX_TOKENS = 3000;
const ERROR_MESSAGE_LIMIT = 300;
const TEST_PROMPT = "只回复一个字：在";
const TEST_MAX_TOKENS = 32;

/**
 * 思考余量：调用方给的 maxTokens 只算「正文」，发请求时再按推理强度加上思考可能用掉的部分。
 * 思考 token 也计入 max_tokens；有的模型（如 Gemini 3.x）思考关不掉，"off" 也会先想一阵，
 * 不留余量正文就会被截成空。max_tokens 只是上限，不思考的模型用不到这部分，不多花钱。
 */
const THINKING_HEADROOM = Object.freeze({ off: 1024, low: 2048, medium: 4096, high: 8192 });

export function withThinkingHeadroom(maxTokens, reasoning) {
  return maxTokens + (THINKING_HEADROOM[reasoning] ?? THINKING_HEADROOM.medium);
}

export class ModelError extends Error {
  /** @param {"http"|"network"|"timeout"|"empty"|"config"} kind */
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }

  toJSON() {
    return { kind: this.kind, ...(this.status !== undefined ? { status: this.status } : {}), message: this.message };
  }
}

const ADAPTERS = {
  anthropic: { url: anthropicUrl, headers: anthropicHeaders, body: anthropicBody, parse: anthropicParseResponse, stream: anthropicStream },
  openai: { url: openaiUrl, headers: openaiHeaders, body: openaiBody, parse: openaiParseResponse, stream: openaiStream },
};

/** 把错误文本里的 Key 打掉，并截短。 */
function scrub(text, apiKey) {
  let value = String(text ?? "").slice(0, ERROR_MESSAGE_LIMIT);
  if (apiKey) value = value.split(apiKey).join("***");
  return value;
}

/** 400 且看起来是推理参数不被接受时，去掉推理参数重试一次。 */
function isReasoningRejection(status, text) {
  return status === 400 && /(thinking|output_config|effort|reasoning)/iu.test(text);
}

/**
 * 发一次请求（含 400 回退）。
 * @param {{protocol: string, baseUrl: string, apiKey: string, model: string, system: any, messages: any[], maxTokens: number, reasoning: string, stream: boolean, onDelta?: (t: string) => void, timeoutMs: number, signal?: AbortSignal}} input
 */
async function request(input) {
  const adapter = ADAPTERS[input.protocol] ?? ADAPTERS.anthropic;
  let withReasoning = input.reasoning !== "off";
  input = { ...input, maxTokens: withThinkingHeadroom(input.maxTokens, input.reasoning) };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const signals = [AbortSignal.timeout(input.timeoutMs), ...(input.signal ? [input.signal] : [])];
    let response;
    try {
      response = await fetch(adapter.url(input.baseUrl), {
        method: "POST",
        headers: adapter.headers(input.apiKey),
        body: JSON.stringify(adapter.body({ ...input, withReasoning })),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new ModelError("timeout", "请求超时");
      throw new ModelError("network", scrub(error?.cause?.message ?? error?.message ?? "网络错误", input.apiKey));
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (withReasoning && isReasoningRejection(response.status, text)) {
        log.warn("gateway rejected reasoning params, retrying without them", { status: response.status, model: input.model });
        withReasoning = false;
        continue;
      }
      throw new ModelError("http", scrub(text, input.apiKey) || `HTTP ${response.status}`, response.status);
    }
    let text = "";
    try {
      if (input.stream && response.body) {
        for await (const delta of adapter.stream(response.body)) {
          text += delta;
          input.onDelta?.(delta);
        }
      } else {
        text = adapter.parse(await response.json());
      }
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new ModelError("timeout", "请求超时");
      throw new ModelError(error?.streamError ? "http" : "network", scrub(error?.message, input.apiKey));
    }
    if (!text.trim()) throw new ModelError("empty", "模型返回为空");
    return text;
  }
  throw new ModelError("http", "推理参数回退后仍失败", 400);
}

/**
 * @param {{role?: "chat"|"background", system?: any, messages: {role: "user"|"assistant", content: string}[], stream?: boolean, onDelta?: (t: string) => void, maxTokens?: number, signal?: AbortSignal, reasoning?: string}} options
 *   reasoning：只给分类这类要快的后台小活用（比如 "off"），覆盖设置里的后台推理强度。
 * @returns {Promise<string>}
 */
export async function complete(options) {
  const role = options.role ?? "chat";
  const [secrets, settings] = await Promise.all([readModelSecrets(), readSettings()]);
  if (!isModelReady(secrets)) throw new ModelError("config", "还没有配置模型接口");
  const messages = normalizeTurns(options.messages.map((m) => ({ role: m.role, content: String(m.content ?? "") })));
  if (messages.length === 0) throw new ModelError("config", "没有可发送的消息");
  const chatCall = {
    protocol: secrets.protocol,
    baseUrl: secrets.baseUrl,
    apiKey: secrets.apiKey,
    system: options.system,
    messages,
    stream: Boolean(options.stream),
    onDelta: options.onDelta,
    signal: options.signal,
  };
  if (role === "chat") {
    return request({ ...chatCall, model: secrets.chatModel, maxTokens: options.maxTokens ?? settings.maxOutputTokens, reasoning: settings.reasoningLevel, timeoutMs: CHAT_TIMEOUT_MS });
  }
  const backgroundModel = secrets.backgroundModel || secrets.chatModel;
  const background = { ...chatCall, maxTokens: options.maxTokens ?? BACKGROUND_DEFAULT_MAX_TOKENS, reasoning: options.reasoning ?? settings.backgroundReasoningLevel, timeoutMs: BACKGROUND_TIMEOUT_MS };
  try {
    return await request({ ...background, model: backgroundModel });
  } catch (error) {
    // 后台模型失败时退回聊天模型重试一次，不能让记忆和日程整个失效。
    if (backgroundModel === secrets.chatModel || error.kind === "config") throw error;
    log.warn("background model failed, falling back to chat model", { kind: error.kind, status: error.status });
    return request({ ...background, model: secrets.chatModel });
  }
}

/** 测试连接：两个角色各发一句极短的话，返回各自 ok/错误/耗时。不做回退，便于看清哪个不通。 */
export async function testModels() {
  const secrets = await readModelSecrets();
  if (!isModelReady(secrets)) {
    const error = new ModelError("config", "还没有配置模型接口").toJSON();
    return { chat: { ok: false, error }, background: { ok: false, error } };
  }
  const run = async (model, reasoning) => {
    const started = Date.now();
    try {
      await request({ protocol: secrets.protocol, baseUrl: secrets.baseUrl, apiKey: secrets.apiKey, model, system: undefined, messages: [{ role: "user", content: TEST_PROMPT }], maxTokens: TEST_MAX_TOKENS, reasoning, stream: false, timeoutMs: BACKGROUND_TIMEOUT_MS });
      return { ok: true, ms: Date.now() - started, model };
    } catch (error) {
      return { ok: false, ms: Date.now() - started, model, error: error instanceof ModelError ? error.toJSON() : { kind: "network", message: String(error?.message ?? error) } };
    }
  };
  // 测试时不带推理参数；关不掉思考的模型靠 THINKING_HEADROOM.off 兜住。
  const [chat, background] = await Promise.all([run(secrets.chatModel, "off"), run(secrets.backgroundModel || secrets.chatModel, "off")]);
  return { chat, background };
}

/** 从模型输出里取第一个 JSON 对象；模型偶尔会包一层 ```json。 */
export function extractJsonObject(text) {
  const start = String(text ?? "").indexOf("{");
  const end = String(text ?? "").lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
