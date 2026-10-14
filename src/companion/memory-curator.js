// ============================================================
// 聊完后整理记忆（替代旧版带工具的子代理）：
//   1. 触发：一轮聊天成功后 schedule()。游标 state.memoryCursor = 已整理到的消息 id。
//      他新增的话 < 3 个词（中文每字一词）时只推进游标、不调用模型。
//   2. 运行中再来的请求合并为结束后的一次。
//   3. 后台模型一次输出 JSON 操作 → 校验 → 经写入守卫执行；解析失败带着错误重试一次，仍失败放弃、游标不动。
//   4. recalled / events 解析后交给 hooks（C/D 阶段接强度表与内心）。
// ============================================================

import { readSettings } from "../config/settings.js";
import { complete, extractJsonObject } from "../model/client.js";
import { readConversation, getMainConversationId } from "../store/conversation.js";
import { readState, updateState } from "../store/state.js";
import { createLogger } from "../util/log.js";
import { countWords } from "../util/text.js";
import { lifeKeys } from "../util/time.js";
import { buildCuratorPrompt } from "./curator-prompt.js";
import { lifeFileNames } from "./life.js";
import { compareByDateDesc, pickRelated, readMemories } from "./memory.js";
import { applyOps, memoryFilePath, validateOps } from "./memory-ops.js";
import { readText } from "../store/files.js";
import { recalledInTurn } from "./recall.js";

const log = createLogger("curator");
export const MIN_NEW_USER_WORDS = 3;
const CONTEXT_MESSAGES = 20;
const RELATED_FILE_LIMIT = 8;
const CURATOR_OUTPUT_TOKENS = 4000;
const EVENT_KEYS = Object.freeze(["praisedByHim", "dismissedByHim", "deflectedIdeal", "coveredWithJoke", "deepTalk", "askedAboutHer"]);

/** 解析整理结果：ops / recalled / events。events 缺字段一律 false。 */
export function parseCuratorOutput(text) {
  const json = extractJsonObject(text);
  if (!json || !Array.isArray(json.ops)) return null;
  const recalled = Array.isArray(json.recalled) ? json.recalled.filter((file) => typeof file === "string") : [];
  const rawEvents = json.events && typeof json.events === "object" ? json.events : {};
  const events = Object.fromEntries(EVENT_KEYS.map((key) => [key, rawEvents[key] === true]));
  const mediaRequests = Array.isArray(json.mediaRequests) ? json.mediaRequests.slice(0, 4) : [];
  return { ops: json.ops, recalled, events, mediaRequests };
}

function formatConversation(messages, newFrom, names) {
  return messages
    .map((message, index) => `${index === newFrom ? "（以下是新的）\n" : ""}${message.role === "user" ? names.userName : names.companionName}：${message.text}`)
    .join("\n");
}

/**
 * @param {{now?: () => Date, hooks?: {onWritten?: Function, onRecalled?: Function, onEvents?: Function, onMediaRequests?: Function, selectManifest?: Function, selectRelated?: Function}}} [options]
 */
export function createMemoryCurator(options = {}) {
  const now = options.now ?? (() => new Date());
  const hooks = options.hooks ?? {};
  let running = null;
  let again = false;

  async function collect() {
    const conversationId = await getMainConversationId();
    const messages = await readConversation(conversationId);
    const state = await readState();
    const cursorIndex = state.memoryCursor ? messages.findIndex((message) => message.id === state.memoryCursor) : -1;
    const fresh = messages.slice(cursorIndex + 1);
    const context = messages.slice(Math.max(0, cursorIndex + 1 - CONTEXT_MESSAGES), cursorIndex + 1);
    return { messages, fresh, context, last: messages.at(-1) };
  }

  async function relatedFiles(memories, conversationText, at) {
    const keys = lifeKeys(at);
    const names = lifeFileNames(keys);
    const picked = hooks.selectRelated ? await hooks.selectRelated(memories, conversationText, at) : pickRelated(memories, conversationText, RELATED_FILE_LIMIT, 1);
    const files = [`life/${names.day}`, `life/${names.future}`, `life/${names.week}`, `life/${names.month}`, ...picked.slice(0, RELATED_FILE_LIMIT).map((entry) => entry.file)];
    const out = [];
    for (const file of new Set(files)) {
      const content = await readText(memoryFilePath(file));
      if (content !== null) out.push({ file, content });
    }
    return out;
  }

  async function callModel(prompt) {
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const user = attempt === 0 ? prompt.user : `${prompt.user}\n\n上一次的输出没法解析（${lastError}）。这次只输出一个 JSON 对象。`;
      const text = await complete({ role: "background", system: prompt.system, messages: [{ role: "user", content: user }], maxTokens: CURATOR_OUTPUT_TOKENS });
      const parsed = parseCuratorOutput(text);
      if (parsed) return parsed;
      lastError = "不是带 ops 数组的 JSON";
    }
    return null;
  }

  async function runOnce() {
    const at = now();
    const { fresh, context, last } = await collect();
    if (!last || fresh.length === 0) return { skipped: "nothing-new" };
    const userWords = fresh.filter((message) => message.role === "user").reduce((sum, message) => sum + countWords(message.text), 0);
    const userText = fresh.filter((message) => message.role === "user").map((message) => message.text).join("\n");
    if (userWords < MIN_NEW_USER_WORDS && !/《[^》]{1,70}》/u.test(userText)) {
      await updateState({ memoryCursor: last.id });
      return { skipped: "too-short" };
    }
    const settings = await readSettings();
    const memories = await readMemories();
    const conversationText = [...context, ...fresh].map((m) => m.text).join("\n");
    const manifest = hooks.selectManifest ? await hooks.selectManifest(memories, at) : [...memories].sort(compareByDateDesc).map((entry) => ({ entry }));
    const prompt = buildCuratorPrompt({
      companionName: settings.companionName,
      userName: settings.userName,
      today: lifeKeys(at).today,
      messageCount: fresh.length,
      manifest,
      files: await relatedFiles(memories, conversationText, at),
      conversation: formatConversation([...context, ...fresh], context.length, settings),
    });
    const result = await callModel(prompt);
    if (!result) {
      log.warn("curator output unparseable twice, giving up this round");
      return { failed: "unparseable" };
    }
    const { ops, rejected: invalid } = validateOps(result.ops);
    const { applied, rejected } = await applyOps(ops, { now: at });
    for (const item of [...invalid, ...rejected]) log.warn("op rejected", { op: item.op?.op, file: item.op?.file, reason: item.reason });
    log.info("curated", { applied: applied.map((op) => `${op.op}:${op.file}`), rejected: invalid.length + rejected.length });
    const contextUserText = context.filter((message) => message.role === "user").map((message) => message.text).join("\n");
    await hooks.onMediaRequests?.(result.mediaRequests, userText, contextUserText);
    await updateState({ memoryCursor: last.id });
    await hooks.onWritten?.(applied, at);
    // 后台的 recalled 也须有本轮用户证据，不能绕过前台保护把她的复述再强化一遍。
    const proposed = new Set(result.recalled);
    const recalled = recalledInTurn(memories.filter((entry) => proposed.has(entry.file)).map((entry) => ({ entry, text: entry.body })), userText).map((entry) => entry.file);
    await hooks.onRecalled?.(recalled, at);
    // runId：这一轮整理到的最后一条消息。重试同一轮时 id 不变，内核按它去重。
    await hooks.onEvents?.(result.events, at, { runId: last.id });
    return { applied, rejected: [...invalid, ...rejected], recalled, events: result.events };
  }

  /** 安排一次整理；运行中再来的请求合并为结束后的一次。返回本轮（或合并后那轮）的 Promise。 */
  function schedule() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let result;
      do {
        again = false;
        try {
          result = await runOnce();
        } catch (error) {
          log.warn("curator failed", { kind: error?.kind, error });
          result = { failed: error?.kind ?? "error" };
        }
      } while (again);
      return result;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return { schedule, runOnce, idle: () => running ?? Promise.resolve() };
}
