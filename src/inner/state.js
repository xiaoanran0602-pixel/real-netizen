// ============================================================
// 内心状态 → 提示词与行为的接线（给 companion/context.js 与聊天渠道、动态调度器用）。
//   current(now)        结算到现在，返回 {inner, slot, mapped, condition}
//   promptProvider      context.js 的 innerProvider：「# 你现在的状态」小节 + 段数上限
// ============================================================

import { join } from "node:path";
import { paths } from "../config/paths.js";
import { readText } from "../store/files.js";
import { formatLocalDate } from "../util/time.js";
import { describeSlot, formatStateSection, isSafetyRisk, mapInner } from "./mapping.js";
import { mutateInner, readInner, settleNow } from "./store.js";
import { willHints } from "./will.js";
import { daySlots, slotAt } from "./tags.js";
import { activeCondition } from "./vitals.js";

/** 现在的日程时段。 */
export async function currentSlot(now) {
  const day = formatLocalDate(now);
  const yesterday = formatLocalDate(new Date(now.getTime() - 86_400_000));
  const previous = daySlots(await readText(join(paths.life(), `day-${yesterday}.md`)));
  const slots = daySlots(await readText(join(paths.life(), `day-${day}.md`)), previous.at(-1)?.tag);
  return { slots, slot: slotAt(slots, now.getHours() * 60 + now.getMinutes()) };
}

/**
 * @param {Date} now
 * @param {{settle?: boolean, safety?: boolean}} [options]
 */
export async function currentInner(now, options = {}) {
  const inner = options.settle === false ? await readInner() : await settleNow(now.getTime());
  const { slot, slots } = await currentSlot(now);
  const condition = activeCondition(inner, formatLocalDate(now));
  const mapped = mapInner(inner, { now: now.getTime(), condition, safety: options.safety });
  return { inner, slot, slots, condition, mapped, status: describeSlot(slot) };
}

/** context.js 的 innerProvider。防线很薄时并入意志的提示（基石碎片 / 漏一句）。 */
export async function innerPromptProvider({ now, messages }) {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const safety = isSafetyRisk(lastUser?.text);
  const { inner, mapped } = await currentInner(now, { safety });
  const will = willHints(inner, mapped.guard, now, safety);
  if (will.leakOffered) {
    // 记下“这一轮允许过漏一句”，聊完的事件判断里 coveredWithJoke 才算数（will.afterEvents）。
    await mutateInner((state) => ({ state: { ...state, leakOfferedAt: now.getTime() }, reason: { kind: "leak_offered" } }));
  }
  const text = formatStateSection({ ...mapped, hints: [...mapped.hints, ...will.hints] });
  return { text, maxSegments: mapped.maxSegments ?? undefined, safety };
}
