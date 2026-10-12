// ============================================================
// 写入守卫：「过去不能改」在代码层面强制执行，不靠提示词自觉。记忆整理和网页接口共用这一套规则。
//
//   life/day-<过去日期>.md、life/ 已过去的周/月/年、event-<过去日期>.md：只读（write/append/delete 都拒绝）。
//   life/day-<今天>.md：只能往后追加（append），不能整篇重写或删除。
//   其他（recent、thread、profile、future.md、未来的周/月……）：可以改。
//   网页手改日程（life/）：只能改 future.md 和未到的日/周/月/年；今天的日程只由她自己追加。
// ============================================================

import { lifeKeys } from "../util/time.js";

export const LIFE_PREFIX = "life/";
const DATED_FILE = /^(day|event)-(\d{4}-\d{2}-\d{2})\.md$/u;
const WEEK_FILE = /^week-(\d{4}-W\d{2})\.md$/u;
const MONTH_FILE = /^month-(\d{4}-\d{2})\.md$/u;
const YEAR_FILE = /^year-(\d{4})\.md$/u;

/** @typedef {{allowed: true} | {allowed: false, reason: string}} WriteDecision */

const ALLOW = Object.freeze({ allowed: true });
const deny = (reason) => ({ allowed: false, reason });

/**
 * 记忆整理（她自己）对 memory/ 下文件的操作是否允许。
 * @param {{file: string, op: "write"|"append"|"delete", now?: Date}} input  file 相对 memory/，如 "life/day-2026-10-10.md"
 * @returns {WriteDecision}
 */
export function evaluateMemoryOp(input) {
  const keys = lifeKeys(input.now ?? new Date());
  const inLife = input.file.startsWith(LIFE_PREFIX);
  const name = inLife ? input.file.slice(LIFE_PREFIX.length) : input.file;

  const dated = DATED_FILE.exec(name);
  if (dated) {
    const [, kind, date] = dated;
    if (date < keys.today) return deny(`${name} 是过去的事，不能改。`);
    if (kind === "day" && date === keys.today && inLife) {
      if (input.op === "append") return ALLOW;
      return deny(`今天的日程 ${name} 已经定了，只能在末尾追加「实际发生」，不能整篇重写或删除。`);
    }
    return ALLOW;
  }
  if (inLife) {
    const week = WEEK_FILE.exec(name);
    if (week && week[1] < keys.week) return deny(`${name} 这一周已经过去了。`);
    const month = MONTH_FILE.exec(name);
    if (month && month[1] < keys.month) return deny(`${name} 这个月已经过去了。`);
    const year = YEAR_FILE.exec(name);
    if (year && year[1] < keys.year) return deny(`${name} 这一年已经过去了。`);
  }
  return ALLOW;
}

/**
 * 网页接口改/删一条记忆（memory/ 根目录下）。规则与上面一致：过去日期的 event/day 不能改不能删。
 * @param {{file: string, op: "write"|"delete", now?: Date}} input
 * @returns {WriteDecision}
 */
export function evaluateWebMemoryEdit(input) {
  const decision = evaluateMemoryOp({ file: input.file, op: input.op, now: input.now });
  if (decision.allowed) return decision;
  return deny(input.op === "delete" ? "过去的事不能删" : "过去的事不能改");
}

/**
 * 网页「她的日子」能不能手改这份 life 文件。
 * 日程每天第一次聊天前定下，当天和过去都不让手改，只能由她追加「实际」。
 * @param {string} name life/ 下的文件名
 * @param {Date} [now]
 */
export function isEditableLifeFile(name, now = new Date()) {
  const keys = lifeKeys(now);
  if (name === "future.md") return true;
  const day = /^day-(\d{4}-\d{2}-\d{2})\.md$/u.exec(name)?.[1];
  if (day) return day > keys.today;
  const week = WEEK_FILE.exec(name)?.[1];
  if (week) return week >= keys.week;
  const month = MONTH_FILE.exec(name)?.[1];
  if (month) return month >= keys.month;
  const year = YEAR_FILE.exec(name)?.[1];
  if (year) return year >= keys.year;
  return false;
}

/** @returns {WriteDecision} */
export function evaluateWebLifeEdit(name, now = new Date()) {
  return isEditableLifeFile(name, now) ? ALLOW : deny("这份安排已经过去或已经定下，不能改");
}
