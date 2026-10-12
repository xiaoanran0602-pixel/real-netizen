// ============================================================
// 渠道不秒回，但有限度（docs/12 第 10 节）。只作用于聊天渠道；网页保持即时。
//   可回复性（当前日程标签）→ 基础延迟 × 对照表系数；醒着不超过硬上限（30 分钟，生病/加班周 45）；
//   预计超过 10 分钟：1–5 分钟内先发一句占位（一个忙碌时段最多一次，计入对话）；
//   他急了（连发 ≥ 3 条，或带问号的第二次追问）延迟除以 3；
//   睡着：不回不占位，记下来，醒来（起床 + 0–20 分钟）先回他，并告诉她他几点发的；
//   23 点后日程显示还醒着：按空闲，想念高时倾向秒回；
//   安全例外（自伤、轻生）最高优先：忽略一切延迟立即回；
//   待发期间他又说话：作废未发出的回复，合并后重新生成；
//   队列落盘 data/pending-replies.json，重启后按原定时间继续，过期的立即发；回档时清空。
// ============================================================

import { paths } from "../config/paths.js";
import { readJson, removeFile, writeJsonAtomic } from "../store/files.js";
import { createLogger } from "../util/log.js";
import { formatHM, MINUTE_MS } from "../util/time.js";
import { isSafetyRisk } from "./mapping.js";
import { SHORT_REPLY_CHARS, shouldReplyWhileBusy } from "./promises.js";
import { AVAILABILITY, nextWake } from "./tags.js";

const pickBetween = (random, min, max) => min + (random ?? Math.random)() * (max - min);

const log = createLogger("reply-timing");
export const DELAY_RANGE_MIN = Object.freeze({ free: [5 / 60, 2], busy: [3, 20], very_busy: [10, 30] });
export const HARD_CAP_MIN = Object.freeze({ busy: 30, very_busy: 30 });
export const HARD_CAP_SICK_MIN = 45;
export const PLACEHOLDER_THRESHOLD_MIN = 10;
export const PLACEHOLDER_DELAY_MIN = [1, 5];
export const URGENT_DIVISOR = 3;
export const URGENT_BURST = 3;
export const WAKE_JITTER_MIN = [0, 20];
const LATE_NIGHT_HOUR = 23;
const MISSING_HIGH = 50;
const CHECK_INTERVAL_MS = 15_000;

/**
 * 纯函数：算这一批消息什么时候回。
 * @param {{now: Date, slot: {tag: string, start: number}, slots: any[], mapped: any, condition: any, texts: string[], recentUserTexts?: string[], random?: () => number}} input
 * @returns {{mode: "now"|"later"|"asleep", delayMs: number, placeholderAtMs?: number, reason: string}}
 */
export function planReply(input) {
  const rand = input.random ?? Math.random;
  const pick = ([min, max]) => min + rand() * (max - min);
  const text = input.texts.join("\n");
  if (isSafetyRisk(text)) return { mode: "now", delayMs: 0, reason: "safety" };
  const minute = input.now.getHours() * 60 + input.now.getMinutes();
  let availability = AVAILABILITY[input.slot?.tag] ?? "free";
  const lateAwake = input.now.getHours() >= LATE_NIGHT_HOUR && availability !== "asleep";
  if (lateAwake) availability = "free";
  if (availability === "asleep") {
    const wake = nextWake(input.slots ?? [], minute);
    const wakeMinute = wake ?? 24 * 60 + 8 * 60;
    const delayMs = Math.max(0, (wakeMinute - minute + pick(WAKE_JITTER_MIN)) * MINUTE_MS);
    return { mode: "asleep", delayMs, reason: "asleep" };
  }
  let delayMin = pick(DELAY_RANGE_MIN[availability] ?? DELAY_RANGE_MIN.free) * (input.mapped?.delayFactor ?? 1);
  if (lateAwake && (input.mapped?.inner?.missing ?? 0) >= MISSING_HIGH) delayMin = Math.min(delayMin, 1);
  const questions = [...(input.recentUserTexts ?? []), ...input.texts].filter((t) => /[?？]/u.test(t)).length;
  const urgent = input.texts.length >= URGENT_BURST || questions >= 2;
  if (urgent) delayMin /= URGENT_DIVISOR;
  const cap = input.condition && (input.condition.kind === "cold" || input.condition.kind === "overtime") ? HARD_CAP_SICK_MIN : HARD_CAP_MIN[availability];
  if (cap) delayMin = Math.min(delayMin, cap);
  const delayMs = Math.round(delayMin * MINUTE_MS);
  const placeholderAtMs = delayMin > PLACEHOLDER_THRESHOLD_MIN ? Math.round(pick(PLACEHOLDER_DELAY_MIN) * MINUTE_MS) : undefined;
  return { mode: delayMs < 1000 ? "now" : "later", delayMs, ...(placeholderAtMs !== undefined ? { placeholderAtMs } : {}), reason: urgent ? "urgent" : availability };
}

/**
 * @param {{
 *   chatService: any,
 *   innerState: (now: Date) => Promise<{slot: any, slots: any[], mapped: any, condition: any, inner: any}>,
 *   generatePlaceholder: (now: Date, slotText: string) => Promise<string>,
 *   busyState?: (nowMs: number) => Promise<{busy: boolean, remainingMs: number}>,
 *   now?: () => Date, random?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void,
 * }} deps
 */
export function createReplyTiming(deps) {
  const now = deps.now ?? (() => new Date());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  /** @type {{dueAt: number, placeholderAt?: number, placeholderSent?: boolean, firstAt: number, texts: string[], asleep: boolean, slotKey: string} | null} */
  let pending = null;
  let timer;
  let ctxRef = null;
  let placeholderSlots = new Set();

  async function persist() {
    if (pending) await writeJsonAtomic(paths.pendingReplies(), { pending, placeholderSlots: [...placeholderSlots] });
    else await removeFile(paths.pendingReplies());
  }

  function arm() {
    clearTimer(timer);
    if (!pending) return;
    const target = !pending.placeholderSent && pending.placeholderAt ? Math.min(pending.placeholderAt, pending.dueAt) : pending.dueAt;
    timer = setTimer(() => void fire().catch((error) => log.warn("fire failed", { error: error?.message })), Math.max(0, Math.min(target - now().getTime(), CHECK_INTERVAL_MS * 40)));
    timer?.unref?.();
  }

  async function fire() {
    if (!pending || !ctxRef) return;
    const at = now().getTime();
    if (!pending.placeholderSent && pending.placeholderAt && at >= pending.placeholderAt && at < pending.dueAt) {
      const state = await deps.innerState(now());
      const text = await deps.generatePlaceholder(now(), state.slot?.text ?? "").catch(() => "");
      pending.placeholderSent = true;
      placeholderSlots.add(pending.slotKey);
      await persist();
      if (text) await ctxRef.sendReply(text, { maxSegments: 1 });
      arm();
      return;
    }
    if (at < pending.dueAt) return arm();
    const job = pending;
    pending = null;
    await persist();
    const extraNow = job.asleep ? [`他在你睡着的时候给你发了消息（${formatHM(new Date(job.firstAt))} 发的），你刚醒，先回他。`] : [];
    // 忙完了回他（docs/13 第 9.2 节）：回来接队列里那条，不新开话题。
    if (job.busyReturn) extraNow.push(`你刚忙完。他在 ${formatHM(new Date(job.firstAt))} 给你发了消息，回来接着他那句说，不要另开话题。`);
    if (job.maxChars) extraNow.push(`你这会儿还在忙，只能回一句，不超过 ${job.maxChars} 个字。`);
    const result = await deps.chatService.regenerate({ source: "channel", deferReply: true, extraNow });
    // 生成期间他又发了消息：这份作废，等新的那一批。
    if (pending) return;
    if (result.ok) {
      // 字数硬上限：提示词里写了，输出后再截断兜底（docs/13 第 9.7 节）。
      const reply = job.maxChars ? truncateChars(result.reply, job.maxChars) : result.reply;
      await ctxRef.sendReply(reply, { maxSegments: job.maxChars ? 1 : result.maxSegments });
      ctxRef.onReplied?.(`他：${job.texts.join("\n")}\n我：${reply}`);
    }
  }

  async function onIncoming(batch, ctx) {
    ctxRef = ctx;
    const current = now();
    for (const text of batch.texts) await deps.chatService.appendUser(text, { source: "channel", at: batch.at });
    const state = await deps.innerState(current);
    const texts = [...(pending?.texts ?? []), ...batch.texts];
    let plan = planReply({ now: current, slot: state.slot, slots: state.slots, mapped: { ...state.mapped, inner: state.inner?.vitals }, condition: state.condition, texts, recentUserTexts: pending?.texts ?? [], random: deps.random });
    // 承诺即约束（docs/13 第 9.1 节）：她说过要走、还没到点 → 不回，等她忙完再回（安全例外仍立即回）。
    // 剩余 ≤ 10 分钟按概率回一句，字数硬上限 15（由 provider 写进提示词并在发送时截断）。
    const busy = deps.busyState ? await deps.busyState(current.getTime()).catch(() => null) : null;
    if (busy?.busy && plan.reason !== "safety" && plan.mode !== "asleep") {
      const replyNow = shouldReplyWhileBusy(busy.remainingMs, deps.random);
      if (!replyNow) plan = { mode: "later", delayMs: Math.max(plan.delayMs, busy.remainingMs + Math.round(pickBetween(deps.random, 0, 3) * MINUTE_MS)), reason: "promised-busy" };
      else plan = { ...plan, maxChars: SHORT_REPLY_CHARS, reason: "promised-short" };
    }
    const slotKey = `${current.toDateString()}|${state.slot?.start ?? 0}`;
    const placeholderAllowed = !placeholderSlots.has(slotKey) && !pending?.placeholderSent && plan.reason !== "promised-busy";
    const base = pending?.firstAt ?? batch.at;
    if (plan.mode === "now") {
      pending = { dueAt: current.getTime(), firstAt: base, texts, asleep: false, slotKey, ...(plan.maxChars ? { maxChars: plan.maxChars } : {}) };
    } else {
      const dueAt = current.getTime() + plan.delayMs;
      // 合并：等待期间他又说话 → 用新的计划，但不晚于原定时间（不重复占位）。
      // 她说过要走时例外：不能因为他又发了一条就提前回来（说走了就必须真的消失）。
      pending = {
        dueAt: pending && plan.reason !== "promised-busy" ? Math.min(pending.dueAt, dueAt) : dueAt,
        firstAt: base,
        texts,
        asleep: plan.mode === "asleep",
        slotKey,
        ...(plan.reason === "promised-busy" ? { busyReturn: true } : {}),
        ...(plan.maxChars ? { maxChars: plan.maxChars } : {}),
        ...(plan.placeholderAtMs !== undefined && placeholderAllowed ? { placeholderAt: current.getTime() + plan.placeholderAtMs } : {}),
        ...(pending?.placeholderSent ? { placeholderSent: true } : {}),
      };
    }
    log.info("reply planned", { mode: plan.mode, reason: plan.reason, inMin: Math.round((pending.dueAt - current.getTime()) / MINUTE_MS) });
    await persist();
    if (pending.dueAt <= current.getTime()) await fire();
    else arm();
  }

  return {
    onIncoming,
    planReply,
    next: () => (pending ? { dueAt: pending.dueAt, placeholderAt: pending.placeholderAt ?? null, asleep: pending.asleep, count: pending.texts.length } : null),
    /** 重启后恢复：按原定时间继续，过期的立即发。 */
    async restore(ctx) {
      ctxRef = ctx;
      const saved = await readJson(paths.pendingReplies(), null);
      if (!saved?.pending) return false;
      pending = saved.pending;
      placeholderSlots = new Set(saved.placeholderSlots ?? []);
      if (pending.dueAt <= now().getTime()) await fire();
      else arm();
      return true;
    },
    /** 回档时清空。 */
    async clear() {
      clearTimer(timer);
      pending = null;
      placeholderSlots = new Set();
      await persist();
    },
    tick: () => fire(),
    stop: () => clearTimer(timer),
  };
}

/** 按字数截断（中文按字符），尽量停在标点后。 */
export function truncateChars(text, limit) {
  const chars = [...String(text ?? "").replace(/\n+/gu, " ").trim()];
  if (chars.length <= limit) return chars.join("");
  const cut = chars.slice(0, limit);
  const lastPunct = cut.findLastIndex((char) => /[，。！？,.!?、…]/u.test(char));
  return (lastPunct >= Math.floor(limit / 2) ? cut.slice(0, lastPunct + 1) : cut).join("");
}

/**
 * 占位消息：按当前日程用后台模型写一句很短的话（"在开会，晚点说"）。
 * @param {(opts: any) => Promise<string>} complete
 */
export function createPlaceholderGenerator(complete, readPersonaName) {
  return async (now, slotText) => {
    const name = (await readPersonaName?.()) || "林澈";
    const prompt = [
      `你是「${name}」。现在 ${formatHM(now)}，你正在：${slotText || "忙"}。`,
      "他在微信上找你，你暂时没空细聊。回一句很短的话让他知道你看到了、晚点说（比如「在开会，晚点说」），不超过十五个字，纯文本，只输出这一句。",
    ].join("\n");
    const text = await complete({ role: "background", messages: [{ role: "user", content: prompt }], maxTokens: 100 });
    return text.replace(/^["「]|["」]$/gu, "").split("\n")[0].trim();
  };
}
