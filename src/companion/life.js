// ============================================================
// 她的生活：让她有稳定、按真实时间推进的日常。
//
// 目录 data/memory/life/：
//   year-YYYY.md          今年的大方向（很少变）
//   month-YYYY-MM.md      这个月的安排
//   week-YYYY-Www.md      这一周的安排
//   day-YYYY-MM-DD.md     当天日程表：每天第一次聊天前生成，之后只能在末尾追加「实际发生」
//   future.md             她的理想、想做的事（会随聊天和她自己的想法慢慢变）
//
// 规则：
//   - 时间只认系统时钟，不被对方的说法带偏。
//   - 过去不可改：已过去的日期文件、event 记忆只读。
//   - 当下可小改：今天的日程可以追加临时变动，但原计划不删。
//   - 未来可变：future.md、未到的周/月计划可以被记忆整理更新。
//   - 生成只补缺：已存在的文件一律不覆盖。
// ============================================================

import { join } from "node:path";
import { paths } from "../config/paths.js";
import { ensureDir, fileExists, readText, writeTextExclusive } from "../store/files.js";
import { DAY_MS, lifeKeys } from "../util/time.js";
import { oneLine, displayUserName } from "../util/text.js";

export const LIFE_DIR_NAME = "life";
const RECENT_DAY_COUNT = 3;
const RECENT_DAY_CHAR_LIMIT = 600;
const FILE_CHAR_LIMIT = 4000;
export const LIFE_LAYERS = Object.freeze(["year", "month", "week", "day", "future"]);

export function lifeFileNames(keys) {
  return {
    year: `year-${keys.year}.md`,
    month: `month-${keys.month}.md`,
    week: `week-${keys.week}.md`,
    day: `day-${keys.today}.md`,
    future: "future.md",
  };
}

export function lifePath(name) {
  return join(paths.life(), name);
}

async function readOptional(name) {
  const text = (await readText(lifePath(name)))?.trim();
  return text ? text.slice(0, FILE_CHAR_LIMIT) : undefined;
}

/** 读取当前时间对应的各层生活文件。 @param {Date} now */
export async function readLife(now) {
  const keys = lifeKeys(now);
  const names = lifeFileNames(keys);
  const recentDays = [];
  for (let offset = 1; offset <= RECENT_DAY_COUNT; offset += 1) {
    const date = lifeKeys(new Date(now.getTime() - offset * DAY_MS)).today;
    const text = await readOptional(`day-${date}.md`);
    if (text) recentDays.push({ date, text: text.slice(0, RECENT_DAY_CHAR_LIMIT) });
  }
  const life = { recentDays };
  for (const layer of LIFE_LAYERS) {
    const text = await readOptional(names[layer]);
    if (text) life[layer] = text;
  }
  return life;
}

export function formatLife(life, keys) {
  const blocks = [];
  if (life.year) blocks.push(`今年（${keys.year}）你的大方向：\n${life.year}`);
  if (life.month) blocks.push(`这个月（${keys.month}）：\n${life.month}`);
  if (life.week) blocks.push(`这一周（${keys.week}）：\n${life.week}`);
  if (life.day) blocks.push(`今天（${keys.today} ${keys.weekday}）的日程：\n${life.day}`);
  if (life.recentDays.length > 0) blocks.push(`前几天你过的日子：\n${life.recentDays.map((day) => `- ${day.date}：${oneLine(day.text)}`).join("\n")}`);
  if (life.future) blocks.push(`你对以后的想法：\n${life.future}`);
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/** 当天日程缺失时需要生成；年/月/周/未来缺失时一起补。 */
export async function missingLifeLayers(now) {
  const names = lifeFileNames(lifeKeys(now));
  const missing = [];
  for (const layer of LIFE_LAYERS) if (!(await fileExists(lifePath(names[layer])))) missing.push(layer);
  return missing;
}

/** 生成提示词里对日程每一行的格式要求（带标签，见 inner/tags.js）。 */
export const DAY_LINE_RULE = "按时间段列，从起床到睡觉，每段一行，形如「08:30 [起床] 龟背竹又黄了一片叶子」。时间后面的方括号标签只能从这些里选：起床、睡觉、吃饭、上班、加班、截止、开会、运动、通勤、出门、洗澡、天文台、写作、喝酒、生病、空闲；最后一行是「[睡觉]」。";

/**
 * @param {{persona: string, companionName: string, userName: string, keys: ReturnType<typeof lifeKeys>, missing: readonly string[], existing: any, selfMemories: string, facts?: string[]}} input
 */
export function buildLifeGenerationPrompt(input) {
  const { keys } = input;
  const userName = displayUserName(input.userName);
  const existing = formatLife(input.existing, keys) ?? "（还没有）";
  const sections = {
    year: `=== YEAR ===\n${keys.year} 年的大方向：三到五条，工作、写作、生活、身体、心事各一句左右。`,
    month: `=== MONTH ===\n${keys.month} 这个月的安排：三到六条，具体到大概哪几天有什么事。必须落在年的方向里。`,
    week: `=== WEEK ===\n${keys.week} 这一周（周一到周日）的安排：按天一两句，工作日上班、周末天文台之类要符合人设。必须落在月的安排里。`,
    day: `=== DAY ===\n${keys.today} ${keys.weekday} 今天的日程表：${DAY_LINE_RULE}要具体、生活化、有一点小狼狈，和这一周的安排一致，和前几天不重复。`,
    future: `=== FUTURE ===\n她对以后的想法：三到五条，理想、想做又不敢做的事、对自己的怀疑。`,
  };
  const facts = (input.facts ?? []).filter(Boolean);
  return [
    `你在替「${input.companionName}」安排她自己的生活。她是一个真实生活着的人，下面是她的人设：`,
    "",
    input.persona,
    "",
    "她自己记得的事：",
    input.selfMemories || "（无）",
    "",
    "已经定下来的安排（不能改，只能在它们的框架里继续往下写）：",
    existing,
    "",
    ...(facts.length > 0 ? ["这几天的实际情况（已经发生了，安排要照着写）：", ...facts.map((fact) => `- ${fact}`), ""] : []),
    `现在是 ${keys.today} ${keys.weekday}。请补写下面缺的部分。`,
    "要求：",
    `- 只写她自己的生活，不写和${userName}有关的事（他们只在网上聊天）。`,
    "- 和人设、季节、星期几、已有安排严格一致；年 → 月 → 周 → 日层层落实，不矛盾。",
    "- 纯文本，短句，像她自己的备忘。不要解释，不要写额外内容。",
    "- 严格按下面的分隔标记输出，每个标记独占一行，只输出要求的部分：",
    "",
    ...input.missing.map((key) => sections[key]).filter(Boolean),
  ].join("\n");
}

export function parseLifeGeneration(text) {
  const result = {};
  const pattern = /^===\s*(YEAR|MONTH|WEEK|DAY|FUTURE)\s*===\s*$/gmu;
  const marks = [...String(text ?? "").matchAll(pattern)];
  marks.forEach((mark, index) => {
    const start = (mark.index ?? 0) + mark[0].length;
    const end = index + 1 < marks.length ? marks[index + 1].index ?? text.length : text.length;
    const body = text.slice(start, end).trim();
    if (body) result[mark[1].toLowerCase()] = body;
  });
  return result;
}

/** 只写缺失的文件，已存在的一律不覆盖（过去不可改、当天定了就不变）。 */
export async function writeMissingLifeFiles(keys, generated) {
  const names = lifeFileNames(keys);
  await ensureDir(paths.life());
  const written = [];
  for (const layer of LIFE_LAYERS) {
    const body = generated[layer];
    if (!body || (await fileExists(lifePath(names[layer])))) continue;
    // 独占创建：同时有两处在写时只有第一个成功，绝不覆盖。
    if (await writeTextExclusive(lifePath(names[layer]), `${body}\n`)) written.push(layer);
  }
  return written;
}
