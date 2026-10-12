// ============================================================
// 定时整理（design §11.5），相当于她睡觉时整理记忆：
//   每日：重算清晰度；为变模糊、还没有概括的记忆写一句 gist；合并当天新记忆里的重复项。
//   每周：写这一周的总结；从反复出现的事里提炼 profile/preference；合并重复。
//   每月：写这个月的总结；检查他的基本情况前后矛盾（以新为准）；把沉底很久又不重要的零碎一句带过。
// 后台模型一次请求输出 JSON（gists + ops），所有写入仍经写入守卫，且以「那一天」为今天判定。
// 每次只放需要的那部分记忆，有上限，超出按日期分批。
// ============================================================

import { readSettings } from "../config/settings.js";
import { complete, extractJsonObject } from "../model/client.js";
import { createLogger } from "../util/log.js";
import { addDays, isoWeekKey, parseLocalDate } from "../util/time.js";
import { clip, oneLine } from "../util/text.js";
import { compareByDateDesc, readMemories } from "./memory.js";
import { applyOps, validateOps } from "./memory-ops.js";
import { annotate, readStrengthTable, recordWritten, setGist, syncStrength } from "./strength.js";
import { parseMemoryFile } from "./memory.js";
import { outputFormatSection } from "./curator-prompt.js";

const log = createLogger("consolidate");
export const DAILY_GIST_LIMIT = 60;
export const PERIOD_LIMIT = 150;
const SUNK_PACK_DAYS = 30;
const OUTPUT_TOKENS = 4000;
const ENTRY_CHAR_LIMIT = 300;
const GIST_CHAR_LIMIT = 80;

/** 「那一天」的 23:59，用于写入守卫判定（补做时那天的日程不算过去）。 */
export function dayNow(day) {
  const date = parseLocalDate(day);
  date.setHours(23, 59, 0, 0);
  return date;
}

function entryLine(entry) {
  return `- ${entry.file} [${entry.type}]（${entry.updated ?? entry.created ?? ""}）：${oneLine(clip(entry.body || entry.description, ENTRY_CHAR_LIMIT))}`;
}

function inRange(entry, from, to) {
  const date = entry.created ?? entry.updated ?? "";
  return date >= from && date <= to;
}

function parseResult(text) {
  const json = extractJsonObject(text);
  if (!json) return null;
  const gists = json.gists && typeof json.gists === "object" ? json.gists : {};
  return { gists, ops: Array.isArray(json.ops) ? json.ops : [] };
}

async function run(kind, day, system, user) {
  const text = await complete({ role: "background", system, messages: [{ role: "user", content: user }], maxTokens: OUTPUT_TOKENS });
  const parsed = parseResult(text);
  if (!parsed) throw Object.assign(new Error(`${kind} output unparseable`), { kind: "empty" });
  const now = dayNow(day);
  const { ops, rejected: invalid } = validateOps(parsed.ops);
  const { applied, rejected } = await applyOps(ops, { now });
  for (const op of applied.filter((item) => item.op === "write")) {
    const entry = parseMemoryFile(op.content);
    if (entry) await recordWritten({ ...entry, file: op.file }, op.importance, day);
  }
  let gists = 0;
  for (const [file, gist] of Object.entries(parsed.gists)) {
    if (typeof gist !== "string" || !gist.trim()) continue;
    await setGist(file, clip(oneLine(gist), GIST_CHAR_LIMIT));
    gists += 1;
  }
  log.info(`${kind} done`, { day, applied: applied.map((op) => `${op.op}:${op.file}`), rejected: invalid.length + rejected.length, gists });
  return { applied, rejected: [...invalid, ...rejected], gists };
}

const COMMON_RULES = (settings, day) => [
  `你是${settings.companionName}的「记性」，现在是 ${day} 的深夜，她睡着了，你在帮她整理记忆。`,
  "规则：",
  "- 过去日期的 event-、day- 文件和已经过去的周/月是只读的，不要改也不要删。",
  "- 写成她自己的口吻，自然的中文短句，不要写成数据库条目。",
  "- 只整理下面给出的记忆，不推测、不编造没出现过的事。",
];

const GIST_FORMAT = '另外输出 "gists": {"文件名": "一句话"}，给每条「变模糊的记忆」写一句她现在还记得的样子：只留轮廓，二十字左右，她的口吻。';

/**
 * 每日整理。
 * @param {string} day YYYY-MM-DD
 */
export async function consolidateDaily(day) {
  const settings = await readSettings();
  const memories = await readMemories();
  await syncStrength(memories);
  const table = await readStrengthTable();
  const annotated = annotate(memories, table, day);
  const needGist = annotated.filter((entry) => entry.clarity === "blurry" && !entry.record.gist).sort((a, b) => b.r - a.r);
  const todays = memories.filter((entry) => inRange(entry, day, day));
  const results = [];
  for (let start = 0; start === 0 || start < needGist.length; start += DAILY_GIST_LIMIT) {
    const batch = needGist.slice(start, start + DAILY_GIST_LIMIT);
    if (batch.length === 0 && (start > 0 || todays.length < 2)) break;
    const system = [...COMMON_RULES(settings, day), "", "任务：", "1. 为每条「变模糊的记忆」写一句概括（gists）。", "2. 如果「今天新记住的」里有同一件事被记成了两条，合并：write 一条完整的，delete 其余的。没有重复就不动。", "", outputFormatSection(), GIST_FORMAT].join("\n");
    const user = ["## 变模糊的记忆", batch.length > 0 ? batch.map(entryLine).join("\n") : "（无）", "", "## 今天新记住的", start === 0 && todays.length > 0 ? todays.map(entryLine).join("\n") : "（无）"].join("\n");
    results.push(await run("daily", day, system, user));
  }
  return { gistsRequested: needGist.length, batches: results.length };
}

/**
 * 每周整理（day 是周日；整理这一周周一到周日）。
 * @param {string} day
 */
export async function consolidateWeekly(day) {
  const settings = await readSettings();
  const weekKey = isoWeekKey(parseLocalDate(day));
  const from = addDays(day, -6);
  const memories = (await readMemories()).filter((entry) => ["event", "self_daily", "recent", "thread"].includes(entry.type) && inRange(entry, from, day)).sort(compareByDateDesc);
  if (memories.length === 0) return { skipped: "nothing-this-week" };
  const foundation = (await readMemories()).filter((entry) => entry.type === "profile" || entry.type === "preference");
  const results = [];
  for (let start = 0; start < memories.length; start += PERIOD_LIMIT) {
    const batch = memories.slice(start, start + PERIOD_LIMIT);
    const system = [
      ...COMMON_RULES(settings, day),
      "",
      "任务：",
      `1. 写 week-summary-${weekKey}.md（type: event）：这一周你们之间、她自己过得怎么样，几句话，她的口吻。${start > 0 ? "已经写过的话就在原来的基础上补充。" : ""}`,
      `2. 这一周里反复出现的事如果说明了${settings.userName}新的长期特点或喜好，写进 profile / preference（改已有的或新建）。`,
      "3. 合并重复的记忆（write 一条 + delete 其余，不能动过去的 event）。",
      "",
      outputFormatSection(),
    ].join("\n");
    const user = [`## 这一周（${from} 到 ${day}）的记忆`, batch.map(entryLine).join("\n"), "", `## ${settings.userName}现在的底色和喜好`, foundation.length > 0 ? foundation.map(entryLine).join("\n") : "（无）"].join("\n");
    results.push(await run("weekly", day, system, user));
  }
  return { batches: results.length, applied: results.flatMap((r) => r.applied), rejected: results.flatMap((r) => r.rejected) };
}

/**
 * 每月整理（day 是月末）。
 * @param {string} day
 */
export async function consolidateMonthly(day) {
  const settings = await readSettings();
  const month = day.slice(0, 7);
  const all = await readMemories();
  await syncStrength(all);
  const table = await readStrengthTable();
  const summaries = all.filter((entry) => /^week-summary-/u.test(entry.file) && inRange(entry, `${month}-01`, day));
  const foundation = all.filter((entry) => entry.type === "profile" || entry.type === "preference").slice(0, PERIOD_LIMIT);
  const scraps = annotate(all, table, day)
    .filter((entry) => entry.clarity === "sunk" && entry.record.importance === "normal" && addDays(entry.record.lastRecalled, SUNK_PACK_DAYS) <= day)
    .slice(0, PERIOD_LIMIT);
  if (summaries.length === 0 && scraps.length === 0) return { skipped: "nothing-this-month" };
  const system = [
    ...COMMON_RULES(settings, day),
    "",
    "任务：",
    `1. 写 month-summary-${month}.md（type: event）：这个月大概发生了什么，几句话，只记轮廓。把下面「沉底的零碎」用一句话带过（原文件不要删）。`,
    `2. 检查${settings.userName}的底色和喜好里有没有前后矛盾：以较新的为准，旧说法改写成「以前……」。没有矛盾就不动。`,
    "",
    outputFormatSection(),
  ].join("\n");
  const user = ["## 这个月的周总结", summaries.length > 0 ? summaries.map(entryLine).join("\n") : "（无）", "", `## ${settings.userName}的底色和喜好`, foundation.length > 0 ? foundation.map(entryLine).join("\n") : "（无）", "", "## 沉底的零碎", scraps.length > 0 ? scraps.map(entryLine).join("\n") : "（无）"].join("\n");
  const result = await run("monthly", day, system, user);
  return { batches: 1, applied: result.applied.length };
}
