// ============================================================
// 她的内心（只给他看的调试面板，docs/12 第 10、13 节）：
//   GET  /api/lin/inner                     当前全部内部状态 + 下一条待回复
//   POST /api/lin/inner/simulate?hours=N    只读模拟 N 小时后的数值（不落盘）；&memory=1 时给记忆清晰度分布
//   POST /api/lin/inner/force {event}       强制事件：sick/cold、overtime、vacation、healthy、
//                                           tension:book、tension:seen、stress、tired、drink（只在调试时用）
//   GET  /api/lin/status                    聊天页标题下她的状态文字
// 这些接口不返回她自己那条基石的任何内容。
// ============================================================

import { readMemories } from "../../companion/memory.js";
import { annotate, readStrengthTable } from "../../companion/strength.js";
import { forceCondition } from "../../inner/dice.js";
import { formatStateSection, mapInner } from "../../inner/mapping.js";
import { currentInner } from "../../inner/state.js";
import { mutateInner, readInnerLog, simulate } from "../../inner/store.js";
import { activeCondition, TURNING_THRESHOLD } from "../../inner/vitals.js";
import { willHints } from "../../inner/will.js";
import { readState } from "../../store/state.js";
import { addDays, formatLocalDate, HOUR_MS } from "../../util/time.js";
import { HttpError } from "../router.js";

const MAX_SIMULATE_HOURS = 24 * 800;
const FORCED_TENSION = TURNING_THRESHOLD + 5;
const FORCED_STRESS = 90;
const FORCED_ENERGY = 15;

/** 强制事件 → 对 inner 状态的修改。 */
const FORCE_EVENTS = Object.freeze({
  "tension:book": (state) => ({ ...state, tensions: { ...state.tensions, book: FORCED_TENSION } }),
  "tension:seen": (state) => ({ ...state, tensions: { ...state.tensions, seen: FORCED_TENSION } }),
  stress: (state) => ({ ...state, vitals: { ...state.vitals, stress: FORCED_STRESS } }),
  tired: (state) => ({ ...state, vitals: { ...state.vitals, energy: FORCED_ENERGY } }),
  drink: (state) => ({ ...state, lastDrinkAt: Date.now() }),
  healthy: (state) => ({ ...state, condition: null }),
});
const CONDITION_EVENTS = Object.freeze({ sick: "cold", cold: "cold", overtime: "overtime", vacation: "vacation" });

function view(current, nextReply, extra = {}) {
  const { inner, slot, condition, mapped, status } = current;
  const will = willHints(inner, mapped.guard, new Date(), false);
  return {
    vitals: inner.vitals,
    tensions: inner.tensions,
    guard: Math.round(mapped.guard),
    slot: { label: status.label, tag: status.tag, start: slot?.start ?? 0 },
    availability: status.availability,
    sick: condition ? { kind: condition.kind, until: condition.until } : null,
    hints: [...mapped.hints, ...(mapped.guardHint ? [mapped.guardHint] : []), ...will.hints],
    maxSegments: mapped.maxSegments,
    lastTurning: inner.lastTurning ?? {},
    nextReply,
    ...extra,
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
 * @param {{replyTiming?: {next: () => any}}} deps
 */
export function registerInnerRoutes(router, deps) {
  router.get("/api/lin/inner", async () => {
    const [current, state, log] = await Promise.all([currentInner(new Date()), readState(), readInnerLog(10)]);
    return view(current, deps.replyTiming?.next() ?? null, { consolidationSkipped: state.consolidationSkipped ?? [], log });
  });

  router.post("/api/lin/inner/simulate", async (ctx) => {
    const hours = Number(ctx.query.get("hours"));
    if (!Number.isFinite(hours) || hours < 0 || hours > MAX_SIMULATE_HOURS) throw new HttpError(400, "invalid hours");
    const toMs = Date.now() + hours * HOUR_MS;
    const state = await simulate(toMs);
    const condition = activeCondition(state, formatLocalDate(new Date(toMs)));
    const mapped = mapInner(state, { now: toMs, condition });
    const memory = ctx.query.get("memory") === "1" ? await memoryDistribution(addDays(formatLocalDate(), Math.floor(hours / 24))) : undefined;
    return { at: toMs, vitals: state.vitals, tensions: state.tensions, guard: Math.round(mapped.guard), sick: condition ? { kind: condition.kind, until: condition.until } : null, prompt: formatStateSection(mapped), ...(memory ? { memory } : {}) };
  });

  router.post("/api/lin/inner/force", async (ctx) => {
    const body = await ctx.body();
    const event = String(body.event ?? ctx.query.get("event") ?? "");
    if (CONDITION_EVENTS[event]) await forceCondition(CONDITION_EVENTS[event]);
    else if (FORCE_EVENTS[event]) await mutateInner((state) => ({ state: FORCE_EVENTS[event](state), reason: { kind: "force", event } }));
    else throw new HttpError(400, `unknown event: ${event}`);
    return view(await currentInner(new Date(), { settle: false }), deps.replyTiming?.next() ?? null, { forced: event });
  });

  router.get("/api/lin/status", async () => {
    const { status, condition } = await currentInner(new Date(), { settle: false });
    // 生病时不在睡觉也显示「不太舒服」。
    const text = condition?.kind === "cold" && status.availability !== "asleep" ? "不太舒服" : status.label;
    return { text, tag: status.tag, availability: status.availability };
  });
}
