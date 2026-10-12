// ============================================================
// 内心状态的读写：data/inner.json（当前状态）、data/inner-log.jsonl（变化原因，只追加）。
// 唯一写入者；聊天事件、心跳、调试接口都调这里。全部在同一进程内，串行，不会互相覆盖。
// 结算是惰性的：settleNow 按“上次结算 → 现在”经过的日程时段补算。
// ============================================================

import { join } from "node:path";
import { paths } from "../config/paths.js";
import { readSettings } from "../config/settings.js";
import { appendText, createSerializer, readJson, readText, writeJsonAtomic } from "../store/files.js";
import { readState } from "../store/state.js";
import { addDays, DAY_MS, formatLocalDate } from "../util/time.js";
import { daySlots, lastTag } from "./tags.js";
import { applyEvents, applyUserTurn, initialInner, settle } from "./vitals.js";

const serialize = createSerializer();
const LOG_REASON_LIMIT = 40;
const MAX_PREFETCH_DAYS = 800;

export async function readInner() {
  const raw = await readJson(paths.inner(), null);
  if (!raw || !raw.vitals) return initialInner();
  return { ...initialInner(raw.lastSettledAt ?? Date.now()), ...raw, vitals: { ...initialInner().vitals, ...raw.vitals }, tensions: { ...initialInner().tensions, ...raw.tensions } };
}

async function appendLog(entry) {
  await appendText(paths.innerLog(), `${JSON.stringify(entry)}\n`);
}

/**
 * 预读 from..to 每天的日程，返回 slotsFor(day)。没有日程或没有标签 → 兜底。
 * 前一天最后的状态延续到今天 0 点（睡着的人过了零点还睡着）。
 */
export async function loadSlots(fromMs, toMs) {
  const from = formatLocalDate(new Date(Math.max(fromMs, toMs - MAX_PREFETCH_DAYS * DAY_MS)));
  const to = formatLocalDate(new Date(toMs));
  const map = new Map();
  let previous = "睡觉";
  for (let day = addDays(from, -1); day <= to; day = addDays(day, 1)) {
    const text = await readText(join(paths.life(), `day-${day}.md`));
    const slots = daySlots(text, previous);
    map.set(day, slots);
    previous = lastTag(slots);
  }
  return (day) => map.get(day) ?? daySlots(null);
}

async function settleOptions(fromMs, toMs) {
  const [state, settings] = await Promise.all([readState(), readSettings()]);
  return { slotsFor: await loadSlots(fromMs, toMs), lastUserMessageAt: Number(state.lastUserMessageAt) || 0, sickMissCap: settings.sickMissCap };
}

/** 只读模拟：从当前状态推到 to，不落盘。 */
export async function simulate(toMs) {
  const current = await readInner();
  const { state } = settle(current, toMs, await settleOptions(current.lastSettledAt, toMs));
  return state;
}

/** 结算到 now 并落盘。 */
export function settleNow(nowMs = Date.now()) {
  return serialize(async () => {
    const current = await readInner();
    if (nowMs <= current.lastSettledAt) return current;
    const { state, reasons } = settle(current, nowMs, await settleOptions(current.lastSettledAt, nowMs));
    await writeJsonAtomic(paths.inner(), state);
    const notable = reasons.filter((reason) => reason.kind !== "slot" || reasons.length < LOG_REASON_LIMIT).slice(-LOG_REASON_LIMIT);
    if (notable.length > 0) await appendLog({ at: nowMs, kind: "settle", from: current.lastSettledAt, reasons: notable });
    return state;
  });
}

/** 他来聊了一轮。 */
export function recordUserTurn(atMs = Date.now()) {
  return serialize(async () => {
    const { state, reason } = applyUserTurn(await readInner(), atMs);
    await writeJsonAtomic(paths.inner(), state);
    await appendLog(reason);
    return state;
  });
}

/** 聊天后事件判断（解析失败当作都没发生）。 */
export function recordEvents(events, atMs = Date.now()) {
  return serialize(async () => {
    const { state, reason } = applyEvents(await readInner(), events ?? {}, atMs);
    if (!reason) return state;
    await writeJsonAtomic(paths.inner(), state);
    await appendLog(reason);
    return state;
  });
}

/**
 * 任意修改（掷骰、转折、调试强制）。mutate 返回 {state, reason}。
 * @param {(state: any) => {state: any, reason?: any}} mutate
 */
export function mutateInner(mutate) {
  return serialize(async () => {
    const { state, reason } = mutate(await readInner());
    await writeJsonAtomic(paths.inner(), state);
    if (reason) await appendLog({ at: Date.now(), ...reason });
    return state;
  });
}

/** 最近几条变化原因（调试面板）。 */
export async function readInnerLog(limit = 20) {
  const text = (await readText(paths.innerLog())) ?? "";
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
