// ============================================================
// 内心状态的读取接线（给 reply-timing、动态调度器、调试接口用）。
//   currentSlot(now)               现在的日程时段（读日程文件）
//   currentInner(now, {kernel})    内核快照 + express → {inner, slot, slots, condition, mapped, status, snapshot}
//     inner 是兼容视图：{vitals: {energy, stress(=张力), missing, fullness, selfWorth}, tensions, lastTurning}
//     mapped 是 express 的结果（delayFactor、proactive、hints、maxSegments、guard……）
// 提示词接线（每轮聊天）在 provider.js；这里只读、不写任何状态。
// ============================================================

import { join } from "node:path";
import { paths } from "../config/paths.js";
import { readSettings } from "../config/settings.js";
import { readText } from "../store/files.js";
import { formatLocalDate } from "../util/time.js";
import { express } from "./express.js";
import { describeSlot } from "./mapping.js";
import { daySlots, slotAt } from "./tags.js";

/** 现在的日程时段。 */
export async function currentSlot(now) {
  const day = formatLocalDate(now);
  const yesterday = formatLocalDate(new Date(now.getTime() - 86_400_000));
  const previous = daySlots(await readText(join(paths.life(), `day-${yesterday}.md`)));
  const slots = daySlots(await readText(join(paths.life(), `day-${day}.md`)), previous.at(-1)?.tag);
  return { slots, slot: slotAt(slots, now.getHours() * 60 + now.getMinutes()) };
}

/**
 * 快照 + 表达 → 兼容视图（旧调用方读 inner.vitals.* 的地方不用改）。内核不可用时为 null。
 * @param {any} snapshot
 * @param {any} expressed
 */
export function compatView(snapshot, expressed) {
  if (!snapshot?.values || expressed?.degraded) return null;
  const psyche = snapshot.psyche ?? {};
  return {
    vitals: { energy: snapshot.values.energy, stress: snapshot.values.tension, missing: expressed.derived.missing, fullness: expressed.derived.fullness, selfWorth: psyche.selfWorth },
    tensions: { book: psyche.book, seen: psyche.seen },
    lastTurning: psyche.lastTurning ?? {},
  };
}

/**
 * @param {Date} now
 * @param {{kernel?: {snapshot: Function} | null, safety?: boolean}} [options]
 */
export async function currentInner(now, options = {}) {
  const nowMs = now.getTime();
  const [settings, { slot, slots }] = await Promise.all([readSettings(), currentSlot(now)]);
  const snapshot = options.kernel ? options.kernel.snapshot(nowMs) : { status: "unavailable", values: null };
  const mapped = express(snapshot, { safety: options.safety, now: nowMs, sickMissCap: settings.sickMissCap });
  return { inner: compatView(snapshot, mapped), slot, slots, condition: mapped.condition, mapped, status: describeSlot(slot), snapshot };
}
