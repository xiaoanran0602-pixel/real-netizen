// ============================================================
// 对话文件：data/conversations/<对话id>/YYYY-MM.jsonl，按月分片，一行一条消息，只追加不改写。
//   {"id":"m_lt3k9x_ab12","role":"user","text":"在干嘛？","at":1791610760945,"source":"channel"}
// 主对话指针在 state.json.mainConversationId。
// 内存里缓存每段对话的全部消息（个人聊天量一年也只有几 MB）；回档后 invalidateConversations() 整体重读。
// 唯一写入者是 chat-service（以及一次性导出脚本）。
// ============================================================

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import { appendText, ensureDir, listDir, readText } from "./files.js";
import { readState, updateState } from "./state.js";
import { pad2 } from "../util/time.js";

export const ROLES = Object.freeze(["user", "assistant"]);
export const SOURCES = Object.freeze(["web", "channel", "chat", "proactive", "import"]);
const SHARD_PATTERN = /^(\d{4}-\d{2})\.jsonl$/u;
const ID_PATTERN = /^c_[a-z0-9_]{4,40}$/u;

/** @typedef {{id: string, role: "user"|"assistant", text: string, at: number, source: string}} Message */

/** @type {Map<string, Message[]>} */
const cache = new Map();

export function invalidateConversations() {
  cache.clear();
}

function randomSuffix(bytes = 2) {
  return randomBytes(bytes).toString("hex");
}

/** 消息 id：m_<时间 base36>_<随机>，按时间大致有序。 */
export function newMessageId(at = Date.now()) {
  return `m_${at.toString(36)}_${randomSuffix()}`;
}

export function newConversationId(at = Date.now()) {
  return `c_${at.toString(36)}_${randomSuffix(3)}`;
}

export function isConversationId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/** 时间戳 → 所在月份分片名 YYYY-MM（本地时间）。 */
export function shardOf(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function parseLine(line) {
  try {
    const value = JSON.parse(line);
    if (!value || typeof value.id !== "string" || !ROLES.includes(value.role) || typeof value.text !== "string") return null;
    return { id: value.id, role: value.role, text: value.text, at: Number(value.at) || 0, source: typeof value.source === "string" ? value.source : "chat" };
  } catch {
    return null;
  }
}

/** 列出一段对话的分片（按月升序）。 */
export async function listShards(conversationId) {
  return (await listDir(paths.conversationDir(conversationId)))
    .filter((name) => SHARD_PATTERN.test(name))
    .sort();
}

/**
 * 读一段对话的全部消息（按时间升序）。坏行跳过。
 * @returns {Promise<Message[]>}
 */
export async function readConversation(conversationId) {
  if (!isConversationId(conversationId)) return [];
  const hit = cache.get(conversationId);
  if (hit) return hit;
  /** @type {Message[]} */
  const messages = [];
  for (const shard of await listShards(conversationId)) {
    const text = await readText(join(paths.conversationDir(conversationId), shard));
    for (const line of (text ?? "").split("\n")) {
      if (!line.trim()) continue;
      const message = parseLine(line);
      if (message) messages.push(message);
    }
  }
  messages.sort((a, b) => a.at - b.at);
  cache.set(conversationId, messages);
  return messages;
}

/**
 * 追加一条消息到对应月份分片。
 * @param {string} conversationId
 * @param {{role: "user"|"assistant", text: string, source: string, at?: number, id?: string}} input
 * @returns {Promise<Message>}
 */
export async function appendMessage(conversationId, input) {
  if (!isConversationId(conversationId)) throw new Error("invalid conversation id");
  if (!ROLES.includes(input.role)) throw new Error("invalid role");
  const at = input.at ?? Date.now();
  /** @type {Message} */
  const message = { id: input.id ?? newMessageId(at), role: input.role, text: input.text, at, source: SOURCES.includes(input.source) ? input.source : "chat" };
  const messages = await readConversation(conversationId);
  await appendText(join(paths.conversationDir(conversationId), `${shardOf(at)}.jsonl`), `${JSON.stringify(message)}\n`);
  messages.push(message);
  if (messages.length > 1 && messages[messages.length - 2].at > at) messages.sort((a, b) => a.at - b.at);
  return message;
}

/** 新建一段对话并设为主对话；旧对话文件保留。 */
export async function createConversation() {
  const id = newConversationId();
  await ensureDir(paths.conversationDir(id));
  cache.set(id, []);
  await updateState({ mainConversationId: id });
  return id;
}

/** 当前主对话 id；没有（或目录丢了且为空）时新建。 */
export async function getMainConversationId() {
  const state = await readState();
  if (isConversationId(state.mainConversationId)) return state.mainConversationId;
  return createConversation();
}
