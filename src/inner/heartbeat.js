// ============================================================
// 身体内核的常驻部分（docs/14 第 7、10 节）：
//   loadTimeline(now)   读前一天、今天、明天的日程（采用时刻 = 文件实际写入时刻）、天气、念头池
//   createHeartbeat     5 秒一拍；用「上一拍结束后再挂」避免重入；异常记录后继续
// 状态 → 提示词的表达在 express.js（唯一出口）。
// 关闭网页、Wave 不在线、朋友圈关掉都不影响心跳；服务停了就没有后台运行，恢复时是补算。
// ============================================================

import { join } from "node:path";
import { paths } from "../config/paths.js";
import { readSettings } from "../config/settings.js";
import { fileStat, readJson, readText } from "../store/files.js";
import { createLogger } from "../util/log.js";
import { addDays, formatLocalDate } from "../util/time.js";
import { closeSegments, normalizeSchedule } from "./body-drivers.js";
import { kernelThoughts } from "./derive.js";
import { daySlots, fallbackSlots } from "./tags.js";
import { readPool } from "./thought-store.js";

const log = createLogger("heartbeat");
export const HEARTBEAT_MS = 5_000;

/** 一天的段：有日程用日程（采用时刻 = 文件写入时刻），没有就用兜底作息（采用时刻 = 当天零点）。 */
async function daySegments(day) {
  const file = join(paths.life(), `day-${day}.md`);
  const [text, stat] = await Promise.all([readText(file), fileStat(file)]);
  const dayStart = new Date(`${day}T00:00:00`).getTime();
  const fallback = normalizeSchedule(fallbackSlots(), { date: day, adoptedAt: dayStart, version: 0, provenance: "fallback" });
  if (!text) return fallback;
  const slots = daySlots(text);
  const adoptedAt = Math.max(dayStart, stat?.mtimeMs ?? dayStart);
  // 兜底段保留：计划采用之前（比如中午才生成）那几小时仍按兜底作息推进，不被新计划倒灌。
  return [...fallback, ...normalizeSchedule(slots, { date: day, adoptedAt, version: 1 })];
}

/** 时间线：昨天、今天、明天三天的段 + 天气 + 念头池（精简）+ 想念的生病放大系数。 */
export async function loadTimeline(nowMs) {
  const today = formatLocalDate(new Date(nowMs));
  const days = [addDays(today, -1), today, addDays(today, 1)];
  const segments = [];
  for (const day of days) segments.push(...(await daySegments(day)));
  const [world, settings, pool] = await Promise.all([readJson(paths.world(), null), readSettings(), readPool().catch(() => ({ thoughts: [] }))]);
  return {
    segments: closeSegments(segments.sort((a, b) => a.startAt - b.startAt || a.version - b.version)),
    world,
    city: settings.city,
    thoughts: kernelThoughts(pool.thoughts ?? []),
    thoughtsEnabled: settings.thoughtsEnabled !== false,
    sickMissCap: settings.sickMissCap,
  };
}

/**
 * 心跳（docs/14 第 7.1 节）。只调用内核推进；天气抓取和日程生成在别处完成。
 * @param {{kernel: {tick: () => Promise<any>, refreshTimeline: () => Promise<any>}, setTimer?: Function, clearTimer?: Function, intervalMs?: number, refreshEvery?: number}} deps
 */
export function createHeartbeat(deps) {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const intervalMs = deps.intervalMs ?? HEARTBEAT_MS;
  // 每 60 拍（约 5 分钟）重读一次输入：日程是否改了、天气是否更新、念头池是否变了。
  const refreshEvery = deps.refreshEvery ?? 60;
  let timer = null;
  let running = false;
  let paused = false;
  let beats = 0;

  async function beat() {
    if (paused) return;
    try {
      if (beats % refreshEvery === 0) await deps.kernel.refreshTimeline();
      beats += 1;
      await deps.kernel.tick();
    } catch (error) {
      // 一次异常不能终止内核（docs/14 第 7.1 节）。
      log.warn("beat failed", { error: error?.message });
    }
  }

  function schedule() {
    timer = setTimer(async () => {
      await beat();
      if (running) schedule();
    }, intervalMs);
    timer?.unref?.();
  }

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      clearTimer(timer);
      timer = null;
    },
    pause: () => (paused = true),
    resume: () => (paused = false),
    beat,
    running: () => running,
  };
}
