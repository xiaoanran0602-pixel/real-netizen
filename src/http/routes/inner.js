// ============================================================
// 她的内心（只给他看的调试面板，docs/12 第 10、13 节；merge-inner-engines 合并视图）：
//   GET  /api/lin/inner                     合并后的视图：四维、心率、派生读数（饱腹/想念/防线）、慢层 psyche、
//                                           生病状态、档位、提示词、下一条待回复、她此刻的处境、这段聊天的状态（docs/19）
//   POST /api/lin/inner/simulate?hours=N    在副本上投影 N 小时（kernel.project + express），不落盘；&memory=1 时给记忆清晰度分布
//   POST /api/lin/inner/force {event}       强制事件：sick/cold、overtime、vacation、healthy → condition_set；
//                                           tension:book、tension:seen、stress、tired、drink → force（都写进内核事件日志）
//   GET  /api/lin/status                    聊天页标题下她的状态文字
// 这些接口不返回她自己那条基石的任何内容。
// ============================================================

import { readMemories } from "../../companion/memory.js";
import { annotate, readStrengthTable } from "../../companion/strength.js";
import { readSettings } from "../../config/settings.js";
import { SESSION_GAP_MS } from "../../inner/conversation.js";
import { readConversationState } from "../../inner/conversation-store.js";
import { forceCondition } from "../../inner/dice.js";
import { express, formatStateSection } from "../../inner/express.js";
import { FORCE_KINDS } from "../../inner/kernel.js";
import { sceneOf } from "../../inner/situation.js";
import { currentInner } from "../../inner/state.js";
import { readInnerLog } from "../../inner/store.js";
import { willHints } from "../../inner/will.js";
import { readState } from "../../store/state.js";
import { addDays, formatLocalDate, HOUR_MS } from "../../util/time.js";
import { HttpError } from "../router.js";

const MAX_SIMULATE_HOURS = 24 * 14;
const CONDITION_EVENTS = Object.freeze({ sick: "cold", cold: "cold", overtime: "overtime", vacation: "vacation", healthy: null });

const round = (value) => (Number.isFinite(value) ? Math.round(value) : null);

/** 慢层的调试视图（数字只给他看）。 */
function psycheView(psyche) {
  if (!psyche) return null;
  return {
    selfWorth: round(psyche.selfWorth),
    book: round(psyche.book),
    seen: round(psyche.seen),
    condition: psyche.condition ?? null,
    diceDay: psyche.diceDay ?? "",
    lastTurning: psyche.lastTurning ?? {},
    writingDays: psyche.writingDays ?? [],
    lastDrinkAt: psyche.lastDrinkAt || null,
    lastDeepTalkAt: psyche.lastDeepTalkAt || null,
    leakOfferedAt: psyche.leakOfferedAt || null,
    closedDay: psyche.closedDay ?? "",
  };
}

/**
 * 快照 + 表达 → 一套合并视图。
 * @param {any} snapshot kernel.snapshot / kernel.project
 * @param {any} expressed express(snapshot)
 * @param {Date} now
 */
function mergedView(snapshot, expressed, now) {
  const will = expressed.degraded ? { hints: [] } : willHints(snapshot.psyche, expressed.guard, now, false);
  const hints = [...expressed.hints, ...(expressed.guardHint ? [expressed.guardHint] : []), ...will.hints];
  return {
    status: snapshot?.status ?? "unavailable",
    values: snapshot?.values ? Object.fromEntries(Object.entries(snapshot.values).map(([key, value]) => [key, round(value)])) : null,
    heartRate: snapshot?.derived?.heartRate ?? null,
    derived: expressed.degraded ? null : { fullness: round(expressed.derived.fullness), missing: round(expressed.derived.missing), guard: round(expressed.derived.guard) },
    psyche: psycheView(snapshot?.psyche),
    sick: expressed.condition ? { kind: expressed.condition.kind, label: expressed.condition.label, from: expressed.condition.from, until: expressed.condition.until } : null,
    bands: expressed.bands,
    hints,
    prompt: formatStateSection({ ...expressed, hints: [...expressed.hints, ...will.hints] }),
    maxSegments: expressed.maxSegments,
    delayFactor: expressed.delayFactor,
    proactive: expressed.proactive,
    activeBudget: expressed.activeBudget,
  };
}

/** 记忆在 N 天后的清晰度分布（调遗忘参数用）。 */
async function memoryDistribution(day) {
  const annotated = annotate(await readMemories(), await readStrengthTable(), day);
  const counts = { clear: 0, blurry: 0, sunk: 0 };
  for (const entry of annotated) counts[entry.clarity] += 1;
  return { day, total: annotated.length, ...counts };
}

/**
 * @param {ReturnType<import("../router.js").createRouter>} router
 * @param {{replyTiming?: {next: () => any}, kernel?: any}} deps
 */
export function registerInnerRoutes(router, deps) {
  async function view(extra = {}) {
    const now = new Date();
    const current = await currentInner(now, { kernel: deps.kernel });
    // 处境与聊天状态（docs/19）：只读。聊天状态隔久了就算这会儿没在聊。
    const scene = sceneOf({ slot: current.slot, slots: current.slots, now });
    const talk = await readConversationState().catch(() => null);
    const live = talk && now.getTime() - talk.lastAt <= SESSION_GAP_MS ? talk : null;
    return {
      ...mergedView(current.snapshot, current.mapped, now),
      slot: { label: current.status.label, tag: current.status.tag, start: current.slot?.start ?? 0 },
      availability: current.status.availability,
      situation: { attention: scene.attention, text: scene.lines.join("") },
       conversation: live ? { mode: live.mode, turns: live.turns, modeTurns: live.modeTurns, register: live.register, need: live.need, followup: live.followup, source: live.source, lastAt: live.lastAt, passing: null } : null,
      nextReply: deps.replyTiming?.next() ?? null,
      ...extra,
    };
  }

  router.get("/api/lin/inner", async () => {
    const [state, log] = await Promise.all([readState(), readInnerLog(10)]);
    return view({ consolidationSkipped: state.consolidationSkipped ?? [], log });
  });

  router.post("/api/lin/inner/simulate", async (ctx) => {
    if (!deps.kernel) throw new HttpError(503, "kernel unavailable");
    const hours = Number(ctx.query.get("hours"));
    if (!Number.isFinite(hours) || hours < 0 || hours > MAX_SIMULATE_HOURS) throw new HttpError(400, "invalid hours");
    const toMs = Date.now() + hours * HOUR_MS;
    const projected = deps.kernel.project(toMs);
    if (!projected) throw new HttpError(503, "kernel unavailable");
    const settings = await readSettings();
    const snapshot = { ...projected, status: deps.kernel.status() };
    const expressed = express(snapshot, { now: toMs, sickMissCap: settings.sickMissCap });
    const memory = ctx.query.get("memory") === "1" ? await memoryDistribution(addDays(formatLocalDate(), Math.floor(hours / 24))) : undefined;
    return { at: toMs, ...mergedView(snapshot, expressed, new Date(toMs)), ...(memory ? { memory } : {}) };
  });

  // 事件 ID 是 force:<ms>：同一毫秒连点两次时往后挪 1ms，避免被当成冲突。
  let lastForceMs = 0;
  router.post("/api/lin/inner/force", async (ctx) => {
    if (!deps.kernel) throw new HttpError(503, "kernel unavailable");
    const body = await ctx.body();
    const event = String(body.event ?? ctx.query.get("event") ?? "");
    if (!(event in CONDITION_EVENTS) && !FORCE_KINDS.includes(event)) throw new HttpError(400, `unknown event: ${event}`);
    lastForceMs = Math.max(Date.now(), lastForceMs + 1);
    const result =
      event in CONDITION_EVENTS
        ? await forceCondition(deps.kernel, CONDITION_EVENTS[event], new Date(lastForceMs))
        : await deps.kernel.accept({ id: `force:${lastForceMs}`, type: "force", occurredAt: lastForceMs, payload: { event } });
    if (result?.result !== "accepted") throw new HttpError(503, `kernel ${result?.result ?? "unavailable"}`);
    return view({ forced: event });
  });

  router.get("/api/lin/status", async () => {
    const { status, condition } = await currentInner(new Date(), { kernel: deps.kernel });
    // 生病时不在睡觉也显示「不太舒服」（生病状态来自内核快照的慢层）。
    const text = condition?.kind === "cold" && status.availability !== "asleep" ? "不太舒服" : status.label;
    return { text, tag: status.tag, availability: status.availability };
  });
}
