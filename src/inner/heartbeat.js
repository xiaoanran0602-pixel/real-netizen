// ============================================================
// 身体内核的常驻部分（docs/14 第 7、9、10 节）：
//   loadTimeline(now)   读前一天、今天、明天的日程（采用时刻 = 文件实际写入时刻）、天气、念头池
//   createHeartbeat     5 秒一拍；用「上一拍结束后再挂」避免重入；异常记录后继续
//   mapBody(snapshot)   注意预算 + 至多两条表达约束；不注入数值、不写心情自述
// 关闭网页、聊天渠道不在线、朋友圈关掉都不影响心跳；服务停了就没有后台运行，恢复时是补算。
// ============================================================

import { join } from "node:path";
import { paths } from "../config/paths.js";
import { readSettings } from "../config/settings.js";
import { fileStat, readJson, readText } from "../store/files.js";
import { createLogger } from "../util/log.js";
import { addDays, formatLocalDate } from "../util/time.js";
import { closeSegments, normalizeSchedule } from "./body-drivers.js";
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

/** 时间线：昨天、今天、明天三天的段 + 天气 + 念头池。 */
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
    thoughts: pool.thoughts ?? [],
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

/** 注意预算（docs/14 第 9.2 节）：activeBudget = clamp(floor(2 + 2E/100 − T/60), 1, 4)。 */
export function activeBudget(values) {
  if (!values) return 2;
  return Math.max(1, Math.min(4, Math.floor(2 + (2 * values.energy) / 100 - values.tension / 60)));
}

const CONSTRAINTS = Object.freeze({
  lowEnergy: "精力少，展开可以慢一点；这不是对他不耐烦，不必赶着给结论。",
  highTension: "先跟住眼前这一点，允许暂时没有答案；不替他收掉话题。",
  highActivation: "说得集中、直接一些（是兴奋还是紧张，看你此刻在想的事）。",
  relaxed: "还有一点刚才的轻松余韵，语气可以松一点，不用硬开玩笑，也不用说出来。",
  subdued: "还有一点低落的余韵，语气收一点，但仍认真接住他的话，不要把它归到他身上。",
});

/**
 * 快照 → 提示词里的表达约束（至多两条）与注意预算。
 * 优先级固定：安全例外 → 低精力 → 高张力 → 高激活 → 余韵（docs/14 第 9.2 节）。
 * @param {any} snapshot kernel.snapshot()
 * @param {{safety?: boolean}} context
 */
export function mapBody(snapshot, context = {}) {
  if (!snapshot?.values || snapshot.status !== "ready") return { constraints: [], activeBudget: 2, degraded: true };
  if (context.safety) return { constraints: [], activeBudget: 4, degraded: false };
  const bands = snapshot.bands ?? {};
  const picks = [];
  if (bands.lowEnergy) picks.push(CONSTRAINTS.lowEnergy);
  if (bands.highTension) picks.push(CONSTRAINTS.highTension);
  if (bands.highActivation) picks.push(CONSTRAINTS.highActivation);
  if (bands.valence === "relaxed") picks.push(CONSTRAINTS.relaxed);
  if (bands.valence === "subdued") picks.push(CONSTRAINTS.subdued);
  return { constraints: picks.slice(0, 2), activeBudget: activeBudget(snapshot.values), degraded: false };
}

/** 表达约束的提示词小节（没有约束时不注入，不为凑数量表演）。 */
export function formatBodySection(mapped) {
  if (!mapped?.constraints?.length) return null;
  return ["# 你此刻的状态（只影响你怎么说，不要说出来）", ...mapped.constraints.map((line) => `- ${line}`)].join("\n");
}
