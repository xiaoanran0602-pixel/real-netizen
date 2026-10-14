// ============================================================
// 决策模型（可选的结构化判断端点；默认关闭，谁需要谁在设置里填）：给一段情境 + 一组具名问题，返回每个问题的分布。
// 它不写话，只做判断；聊天回复仍由聊天模型生成（docs/zh/situation-and-register.md）。
//
//   请求：{model, state, questions: {name: {type: noul|choice|score, instructions, criteria?}}}
//   响应：{answers: {name: {type, noul? | choice?+probabilities | score?+probabilities}}, usage}
//
// 规矩：失败/超时/没配置一律返回 null，调用方退回启发式；绝不阻塞回复，绝不抛到聊天链路上。
// ============================================================

import { readModelSecrets } from "../config/secrets.js";
import { createLogger } from "../util/log.js";

const log = createLogger("decision");
export const DECISION_TIMEOUT_MS = 5_000;

/** 地址拼接：以 /systemone 结尾原样用；以 /v1 结尾拼 /systemone；否则拼 /v1/systemone。 */
export function systemoneUrl(baseUrl) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/u, "");
  if (/\/systemone$/u.test(base)) return base;
  if (/\/v1$/u.test(base)) return `${base}/systemone`;
  return `${base}/v1/systemone`;
}

/**
 * 把一个回答规范成 {probabilities: {label: p}}（noul → {yes, no}）。不认识的格式返回 null。
 * score 的 probabilities 键是档位下标，这里换回档位名，便于调用方按名字查。
 * @param {any} answer
 * @param {any} question
 */
export function normalizeAnswer(answer, question) {
  if (!answer || typeof answer !== "object") return null;
  if (answer.type === "noul" || typeof answer.noul === "number") {
    const p = Math.max(0, Math.min(1, Number(answer.noul)));
    return Number.isFinite(p) ? { probabilities: { yes: p, no: 1 - p }, p } : null;
  }
  const raw = answer.probabilities;
  if (!raw || typeof raw !== "object") return null;
  const tiers = Array.isArray(question?.criteria) ? question.criteria : null;
  /** @type {Record<string, number>} */
  const probabilities = {};
  for (const [key, value] of Object.entries(raw)) {
    const p = Number(value);
    if (!Number.isFinite(p) || p < 0) continue;
    const label = tiers && /^\d+$/u.test(key) ? tiers[Number(key)] ?? key : key;
    probabilities[label] = p;
  }
  return Object.keys(probabilities).length > 0 ? { probabilities, confidence: Number(answer.confidence) || 0 } : null;
}

/**
 * @param {{state: string | object | string[], questions: Record<string, {type: string, instructions: string, criteria?: any}>, model?: string, signal?: AbortSignal, timeoutMs?: number, fetchImpl?: typeof fetch}} input
 * @returns {Promise<Record<string, {probabilities: Record<string, number>, p?: number, confidence?: number}> | null>}
 */
export async function decide(input) {
  const secrets = await readModelSecrets().catch(() => null);
  const model = input.model ?? secrets?.decisionModel;
  if (!secrets?.baseUrl || !secrets.apiKey || !model) return null;
  const doFetch = input.fetchImpl ?? fetch;
  const signals = [AbortSignal.timeout(input.timeoutMs ?? DECISION_TIMEOUT_MS), ...(input.signal ? [input.signal] : [])];
  try {
    const response = await doFetch(systemoneUrl(secrets.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secrets.apiKey}` },
      body: JSON.stringify({ model, state: input.state, questions: input.questions }),
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) {
      log.warn("decision model rejected", { status: response.status });
      return null;
    }
    const json = await response.json();
    /** @type {Record<string, any>} */
    const out = {};
    for (const [name, question] of Object.entries(input.questions)) {
      const answer = normalizeAnswer(json?.answers?.[name], question);
      if (answer) out[name] = answer;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch (error) {
    log.info("decision model unavailable", { error: error?.name === "TimeoutError" ? "timeout" : String(error?.message ?? error).slice(0, 120) });
    return null;
  }
}
