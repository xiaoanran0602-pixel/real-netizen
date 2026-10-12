// ============================================================
// 她的生活调度：每天第一句话前确保今天（以及本周/本月/今年/未来）的安排已经存在；
// 服务常驻时零点过 2 分钟预生成，第一句话就不用等（修复：原来每天第一句话要等 25–40 秒）。
// 同一天只允许一个生成在跑（手机和电脑同时发消息时不会生成两份）。生成失败不影响聊天，下一轮再试。
// 生成前先问 factsProvider（掷骰：生病/加班周/假期，见 inner/dice.js），作为事实写进提示词。
// ============================================================

import { readSettings } from "../config/settings.js";
import { complete } from "../model/client.js";
import { createLogger } from "../util/log.js";
import { lifeKeys, MINUTE_MS, msUntilNextMidnight } from "../util/time.js";
import { buildLifeGenerationPrompt, missingLifeLayers, parseLifeGeneration, readLife, writeMissingLifeFiles } from "./life.js";
import { readMemories } from "./memory.js";
import { readPersona } from "./persona.js";

const log = createLogger("life");
const LIFE_OUTPUT_TOKENS = 3000;
export const PREWARM_DELAY_AFTER_MIDNIGHT_MS = 2 * MINUTE_MS;

/** @type {Map<string, Promise<string[]>>} */
const inflight = new Map();
let prewarmTimer;
/** @type {(now: Date) => Promise<string[]>} */
let factsProvider = async () => [];

/** 掷骰等模块注册：生成当天日程前要告诉模型的事实。 */
export function setLifeFactsProvider(provider) {
  factsProvider = provider;
}

/** 距离下一个本地零点（加余量）还有多少毫秒。 */
export function msUntilNextLifePrewarm(now) {
  return msUntilNextMidnight(now) + PREWARM_DELAY_AFTER_MIDNIGHT_MS;
}

/**
 * 确保今天的生活文件齐全；缺了就用后台模型生成。返回写入的层。
 * @param {Date} [now]
 */
export async function ensureLife(now = new Date()) {
  const missing = await missingLifeLayers(now);
  if (missing.length === 0) return [];
  const key = lifeKeys(now).today;
  const existing = inflight.get(key);
  if (existing) return existing;
  const task = generateLife(missing, now).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

async function generateLife(missing, now) {
  const keys = lifeKeys(now);
  try {
    const [settings, persona, memories, existing] = await Promise.all([readSettings(), readPersona(), readMemories(), readLife(now)]);
    const selfMemories = memories
      .filter((entry) => entry.type === "self" || entry.type === "self_daily")
      .map((entry) => `- ${entry.body || entry.description}`)
      .join("\n");
    const facts = missing.includes("day") ? await factsProvider(now).catch(() => []) : [];
    const prompt = buildLifeGenerationPrompt({ persona, companionName: settings.companionName, userName: settings.userName, keys, missing, existing, selfMemories, facts });
    const text = await complete({ role: "background", messages: [{ role: "user", content: prompt }], maxTokens: LIFE_OUTPUT_TOKENS });
    const written = await writeMissingLifeFiles(keys, parseLifeGeneration(text));
    log.info("life generated", { requested: missing, written });
    return written;
  } catch (error) {
    log.warn("life generation failed", { kind: error?.kind, error });
    return [];
  }
}

/** 零点过后预生成；之后每天续挂。--dry 时不启动。 */
export function startLifePrewarm() {
  if (prewarmTimer) return;
  const schedule = () => {
    prewarmTimer = setTimeout(() => {
      void ensureLife(new Date()).finally(schedule);
    }, msUntilNextLifePrewarm(new Date()));
    prewarmTimer.unref?.();
  };
  schedule();
}

export function stopLifePrewarm() {
  clearTimeout(prewarmTimer);
  prewarmTimer = undefined;
}
