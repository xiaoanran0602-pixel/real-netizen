// ============================================================
// 每日存档（design §12.1）：内容寻址、按天。
//   archive/objects/<sha256 前 2 位>/<sha256>   文件内容，所有存档共享，只存一份
//   archive/days/YYYY-MM-DD.json               清单：相对路径 → sha256，加 state 与摘要
// 存档范围由 config/paths.js 的 EXPERIENCE_PATHS 定义（存档与恢复共用）。
// 清单先写 .tmp 再改名，存档要么完整要么不存在。
// ============================================================

import { join } from "node:path";
import { dataPath, EXPERIENCE_PATHS, EXPERIENCE_STATE_KEYS, CLOCK_STATE_KEYS, paths } from "../config/paths.js";
import { fileExists, fileStat, listDir, listFilesRecursive, readBytes, readJson, sha256, writeBytesAtomic, writeJsonAtomic } from "../store/files.js";
import { readConversation } from "../store/conversation.js";
import { readState } from "../store/state.js";
import { clip, oneLine } from "../util/text.js";
import { dayEndsAt, experienceDay } from "./day.js";

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/u;
const LAST_LINE_LIMIT = 40;

export function objectPath(hash) {
  return join(paths.archiveObjects(), hash.slice(0, 2), hash);
}

export function manifestPath(day) {
  return join(paths.archiveDays(), `${day}.json`);
}

/** 存档范围内的所有文件（相对 data 目录，/ 分隔）。 */
export async function listExperienceFiles() {
  const out = [];
  for (const rel of EXPERIENCE_PATHS) {
    const full = dataPath(rel);
    const info = await fileStat(full);
    if (!info) continue;
    if (info.isDirectory()) out.push(...(await listFilesRecursive(full)).map((sub) => `${rel}/${sub}`));
    else out.push(rel);
  }
  return out.sort();
}

/** 把一个文件写进对象库（已存在就不写）。返回 sha256。 */
export async function storeObject(bytes) {
  const hash = sha256(bytes);
  const path = objectPath(hash);
  if (!(await fileExists(path))) await writeBytesAtomic(path, bytes);
  return hash;
}

function pickKeys(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

/**
 * 摘要：那天聊了多少条、最后一句、新记住几件事。
 * @param {string} day
 * @param {string[]} files
 * @param {{conversationId?: string, boundaryHour: number, companionName: string, userName: string}} input
 */
export async function summarizeDay(day, files, input) {
  let messages = 0;
  let lastLine = "";
  if (input.conversationId) {
    const all = await readConversation(input.conversationId);
    const ofDay = all.filter((message) => experienceDay(message.at, input.boundaryHour) === day);
    messages = ofDay.length;
    const last = ofDay.at(-1);
    if (last) lastLine = `${last.role === "user" ? input.userName : input.companionName}：${clip(oneLine(last.text), LAST_LINE_LIMIT)}`;
  }
  const previous = await latestManifestBefore(day);
  const before = new Set(Object.keys(previous?.files ?? {}).filter((rel) => isMemoryFile(rel)));
  const newMemories = files.filter((rel) => isMemoryFile(rel) && !before.has(rel)).length;
  return { messages, lastLine, newMemories };
}

function isMemoryFile(rel) {
  return rel.startsWith("memory/") && rel.endsWith(".md") && !rel.startsWith("memory/life/");
}

/**
 * 存一份 day 结束时的样子。同一天再存会覆盖清单（对象去重，不重复占空间）。
 * @param {string} day
 * @param {{boundaryHour: number, companionName: string, userName: string, now?: number}} deps
 */
export async function snapshot(day, deps) {
  const files = await listExperienceFiles();
  /** @type {Record<string, string>} */
  const manifestFiles = {};
  for (const rel of files) {
    const bytes = await readBytes(dataPath(rel));
    if (bytes === null) continue;
    manifestFiles[rel] = await storeObject(bytes);
  }
  const state = await readState();
  const summary = await summarizeDay(day, files, { conversationId: state.mainConversationId, boundaryHour: deps.boundaryHour, companionName: deps.companionName, userName: deps.userName });
  const manifest = {
    day,
    createdAt: deps.now ?? Date.now(),
    boundaryAt: dayEndsAt(day, deps.boundaryHour),
    files: manifestFiles,
    state: pickKeys(state, [...EXPERIENCE_STATE_KEYS, ...CLOCK_STATE_KEYS]),
    summary,
  };
  await writeJsonAtomic(manifestPath(day), manifest);
  return manifest;
}

/** 所有存档的日期（升序）。 */
export async function listArchiveDays() {
  return (await listDir(paths.archiveDays())).map((name) => DAY_FILE.exec(name)?.[1]).filter(Boolean).sort();
}

export async function readManifest(day) {
  const manifest = await readJson(manifestPath(day), null);
  return manifest && manifest.day === day && manifest.files ? manifest : null;
}

async function latestManifestBefore(day) {
  const days = (await listArchiveDays()).filter((item) => item < day);
  return days.length > 0 ? readManifest(days.at(-1)) : null;
}

/** 对象库总大小（字节）。 */
export async function archiveBytes() {
  let total = 0;
  for (const prefix of await listDir(paths.archiveObjects())) {
    for (const name of await listDir(join(paths.archiveObjects(), prefix))) {
      total += (await fileStat(join(paths.archiveObjects(), prefix, name)))?.size ?? 0;
    }
  }
  for (const name of await listDir(paths.archiveDays())) total += (await fileStat(join(paths.archiveDays(), name)))?.size ?? 0;
  return total;
}
