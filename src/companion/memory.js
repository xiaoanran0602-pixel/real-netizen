// ============================================================
// 她的记忆：读取 data/memory/*.md，按类型分层，相关度挑往事，格式化成「她记得的事」。
//
// 记忆文件格式（一条一个 md，frontmatter + 正文）：
//   ---
//   name: sunburn-2026-10
//   description: 他泰国回来晒伤，10 月 9 日说好多了在掉皮
//   metadata:
//     type: recent            # 见 MEMORY_TYPES
//     created: 2026-10-05
//     updated: 2026-10-09
//     expires: 2026-10-16     # recent / self_daily 用；过期后降级为往事
//     closed: true            # thread 聊完后标记
//   ---
//   正文
//
// 目录很小（个人自用，几十到几千条），按文件名+mtime 签名缓存。
// ============================================================

import { join } from "node:path";
import { paths } from "../config/paths.js";
import { fileStat, listDir, readText } from "../store/files.js";
import { DAY_MS, parseLocalDate } from "../util/time.js";
import { clip, displayUserName, oneLine, overlapScore, tokenize } from "../util/text.js";
import { parseFrontmatter } from "./frontmatter.js";

export const MEMORY_TYPES = Object.freeze(["profile", "preference", "self", "recent", "self_daily", "thread", "event"]);
export const MEMORY_FILE_PATTERN = /^[a-z0-9][a-zA-Z0-9._-]{0,80}\.md$/u;
const INDEX_FILE = "MEMORY.md";

const RELATED_MEMORY_LIMIT = 5;
const RECENT_EVENT_LIMIT = 3;
export const MEMORY_BODY_CHAR_LIMIT = 600;
const SELF_DAILY_KEEP_DAYS = 3;
export const RELATED_MIN_SCORE = 2;

/**
 * @typedef {{file: string, name: string, description: string, type: string, body: string, created?: string, updated?: string, expires?: string, closed: boolean, mtimeMs: number}} MemoryEntry
 */

/** @type {{signature: string, entries: MemoryEntry[]} | undefined} */
let dirCache;

export function invalidateMemoryCache() {
  dirCache = undefined;
}

/**
 * 兼容早期记忆类型（user/feedback/project/reference），映射到现在的分类。
 * @param {unknown} value
 */
export function normalizeMemoryType(value) {
  if (typeof value === "string" && MEMORY_TYPES.includes(value)) return value;
  if (value === "feedback") return "preference";
  if (value === "project") return "recent";
  return "profile";
}

function dateField(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 10) : undefined;
}

function str(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * @param {string} content
 * @returns {Omit<MemoryEntry, "file" | "mtimeMs"> | null}
 */
export function parseMemoryFile(content) {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  const { front, meta, body } = parsed;
  const entry = {
    name: str(front.name),
    description: str(front.description),
    type: normalizeMemoryType(meta.type ?? front.type),
    body,
    closed: meta.closed === true,
  };
  for (const key of ["created", "updated", "expires"]) {
    const value = dateField(meta[key]);
    if (value) entry[key] = value;
  }
  return entry;
}

/** 扫描记忆目录（不含 life/）。目录不存在返回空数组。 */
export async function readMemories() {
  const root = paths.memory();
  const names = (await listDir(root)).filter((name) => name.endsWith(".md") && name !== INDEX_FILE);
  const stats = await Promise.all(names.map(async (name) => ({ name, mtimeMs: (await fileStat(join(root, name)))?.mtimeMs ?? 0 })));
  const signature = `${root}|${stats.map((s) => `${s.name}:${s.mtimeMs}`).join("|")}`;
  if (dirCache?.signature === signature) return dirCache.entries;
  /** @type {MemoryEntry[]} */
  const entries = [];
  for (const { name, mtimeMs } of stats) {
    const text = await readText(join(root, name));
    if (text === null) continue;
    const parsed = parseMemoryFile(text);
    // 单个文件坏了不影响其他记忆。
    if (parsed) entries.push({ ...parsed, file: name, mtimeMs });
  }
  dirCache = { signature, entries };
  return entries;
}

/** @param {MemoryEntry} entry @param {string} today */
export function isMemoryExpired(entry, today) {
  return Boolean(entry.expires && entry.expires < today);
}

export function compareByDateDesc(a, b) {
  const left = a.updated ?? a.created ?? "";
  const right = b.updated ?? b.created ?? "";
  return right.localeCompare(left) || b.mtimeMs - a.mtimeMs;
}

function withinDays(date, today, days) {
  if (!date) return true;
  const diff = (parseLocalDate(today).getTime() - parseLocalDate(date).getTime()) / DAY_MS;
  return Number.isNaN(diff) || diff < days;
}

/** 一条记忆和当前聊天的相关度。 */
export function relevanceScore(entry, query) {
  return overlapScore(query, `${entry.description} ${entry.body}`);
}

/**
 * 关键词相关度：中文二字切片 + 英文单词做重叠计数。
 * @param {readonly MemoryEntry[]} pool
 * @param {string} text
 */
export function pickRelated(pool, text, limit = RELATED_MEMORY_LIMIT, minScore = RELATED_MIN_SCORE) {
  const query = tokenize(text);
  if (query.size === 0) return [];
  return pool
    .map((entry) => ({ entry, score: relevanceScore(entry, query) }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score || compareByDateDesc(a.entry, b.entry))
    .slice(0, limit)
    .map((item) => item.entry);
}

/** 往事池：event、过期的 recent、聊完的 thread。 */
export function pastPool(memories, today) {
  return [
    ...memories.filter((entry) => entry.type === "event"),
    ...memories.filter((entry) => entry.type === "recent" && isMemoryExpired(entry, today)),
    ...memories.filter((entry) => entry.type === "thread" && entry.closed),
  ];
}

/**
 * 按召回规则分层（未接入遗忘曲线的基础版；recall.js 在此之上加清晰度与预算）。
 * @param {{memories: readonly MemoryEntry[], today: string, recentText: string}} input
 */
export function buildMemoryDigest(input) {
  const { memories, today } = input;
  const byType = (type) => memories.filter((entry) => entry.type === type);
  const live = (entries) => entries.filter((entry) => !isMemoryExpired(entry, today));
  const myRecent = live(byType("self_daily"))
    .filter((entry) => withinDays(entry.created ?? entry.updated, today, SELF_DAILY_KEEP_DAYS))
    .sort(compareByDateDesc);
  const related = pickRelated(pastPool(memories, today), input.recentText);
  const relatedFiles = new Set(related.map((entry) => entry.file));
  // 没有关键词命中时，也给她最近几件一起经历的事，保证有「上次聊到哪」的连续感。
  const latestEvents = byType("event")
    .filter((entry) => !relatedFiles.has(entry.file))
    .sort(compareByDateDesc)
    .slice(0, RECENT_EVENT_LIMIT);
  return {
    aboutHim: byType("profile"),
    hisPreferences: byType("preference"),
    aboutMe: byType("self"),
    hisRecent: live(byType("recent")).sort(compareByDateDesc),
    myRecent,
    openThreads: byType("thread").filter((entry) => !entry.closed),
    related: [...related, ...latestEvents],
  };
}

/** 一条记忆在提示词里的样子。 */
export function formatEntry(entry, withDate, textOverride) {
  const text = textOverride ?? (entry.body || entry.description || entry.name);
  const date = withDate ? entry.updated ?? entry.created : undefined;
  return (date ? `（${date}）` : "") + oneLine(clip(text, MEMORY_BODY_CHAR_LIMIT));
}

/** 分层标题（顺序就是提示词里的顺序）。 */
export function digestTitles(userName) {
  const name = displayUserName(userName);
  return [
    ["aboutHim", `${name}这个人：`, false],
    ["hisPreferences", `${name}的脾气和喜好：`, false],
    ["hisRecent", `${name}最近：`, true],
    ["openThreads", "他们之前聊过、还没聊完的：", true],
    ["related", "她想起来的往事：", true],
    ["aboutMe", "她自己：", false],
    ["myRecent", "她自己这几天：", true],
  ];
}

export function formatMemoryDigest(digest, userName) {
  const blocks = [];
  for (const [key, title, withDate] of digestTitles(userName)) {
    const entries = digest[key] ?? [];
    if (entries.length === 0) continue;
    blocks.push(`${title}\n${entries.map((entry) => `- ${formatEntry(entry, withDate, entry.recallText)}`).join("\n")}`);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/** 整理用的记忆清单一行。 */
export function manifestLine(entry, textOverride) {
  const state = [entry.expires ? `expires ${entry.expires}` : "", entry.closed ? "closed" : ""].filter(Boolean).join(", ");
  const description = clip(textOverride ?? (entry.description || entry.body), 120);
  return `- [${entry.type}] ${entry.file}${state ? ` (${state})` : ""}: ${oneLine(description)}`;
}
