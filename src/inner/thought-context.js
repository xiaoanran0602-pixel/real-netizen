// ============================================================
// 念头池 → 提示词与出口的接线（docs/13 第 3、4 节）。
//   thoughtsPromptProvider  聊天前：相关度碰撞 → 「她此刻脑子里的事」小节
//   drainOutlets            溢出候选交给出口（主动消息 / 朋友圈），成功才释放
//   rememberEvicted         被挤出的、他留下且反复想起过的念头写进长期记忆
// 当前日程不作为内容注入（docs/13 第 9.4 节），只决定能不能回、回多长。
// ============================================================

import { join } from "node:path";
import { paths } from "../config/paths.js";
import { writeMomentMemory } from "../moments/store.js";
import { createLogger } from "../util/log.js";
import { formatLocalDate } from "../util/time.js";
import { collide, confirmRelease, dropCandidate, readPool, routeOverflow } from "./thought-store.js";
import { formatThoughtsSection, selectForPrompt, worthRemembering } from "./thoughts.js";

const log = createLogger("thoughts");

/**
 * 聊天前的注入块。模型打不了分（超时/失败）就退化成按强度取前 N，绝不阻塞回复。
 * @param {{now: Date, messages: any[]}} input
 */
export async function thoughtsPromptProvider(input) {
  const lastUser = [...(input.messages ?? [])].reverse().find((message) => message.role === "user");
  if (!lastUser?.text) return null;
  const { groups, degraded } = await collide(lastUser.text, { nowMs: input.now.getTime() });
  const selection = selectForPrompt(groups, { activeBudget: input.activeBudget });
  const text = formatThoughtsSection(selection);
  return text ? { text, degraded, selection } : { text: null, degraded, selection };
}

/**
 * 溢出出口：把够强度的念头交出去。候选入队不等于说出口——只有出口确认成功才 release。
 * @param {{sendMessage?: (candidate: any) => Promise<boolean>, addPost?: (candidate: any) => Promise<boolean>, nowMs?: number, remember?: boolean}} deps
 */
export async function drainOutlets(deps = {}) {
  const nowMs = deps.nowMs ?? Date.now();
  const { candidates, pool } = await routeOverflow(nowMs);
  const results = [];
  for (const candidate of candidates) {
    if (candidate.outlet === "message" && !deps.sendMessage) {
      await dropCandidate(candidate.id);
      results.push({ id: candidate.id, outlet: candidate.outlet, status: "no-outlet" });
      continue;
    }
    let ok = false;
    try {
      ok = candidate.outlet === "message" ? await deps.sendMessage(candidate) : deps.addPost ? await deps.addPost(candidate) : false;
    } catch (error) {
      log.warn("outlet failed", { outlet: candidate.outlet, error: error?.message });
    }
    // 失败或结果未知都不释放，强度保持（docs/14 第 1.2 节）。
    // 修复：原来失败后候选标记还留着，overflowCandidates 会跳过它，这条念头就永远出不去了。
    // 没发出去就清掉候选（不动强度），下次醒来还能再试。
    if (ok) await confirmRelease(candidate.id);
    else await dropCandidate(candidate.id);
    results.push({ id: candidate.id, outlet: candidate.outlet, status: ok ? "sent" : "skipped" });
  }
  void pool;
  return results;
}

/**
 * 被挤出的念头里，他留下且被反复想起过的，写一条长期记忆（docs/13 第 4 节）。
 * @param {any[]} evicted
 * @param {Date} now
 */
export async function rememberEvicted(evicted, now) {
  const remembered = worthRemembering(evicted ?? []);
  for (const thought of remembered) {
    await writeMomentMemory({
      kind: "event",
      slug: `thought-${thought.id}`,
      description: `他一直没回音的事：${thought.content}`,
      body: `${formatLocalDate(now)} 这件事一直在我心里：${thought.content}。`,
      now,
    }).catch((error) => log.warn("remember failed", { error: error?.message }));
  }
  return remembered.length;
}

/** 调试：池子概览（不含给模型看的正文排版）。 */
export async function poolSummary() {
  const pool = await readPool();
  return {
    count: pool.thoughts.length,
    at: pool.at,
    busyUntil: pool.busyUntil ?? 0,
    items: pool.thoughts.map((thought) => ({ id: thought.id, strength: Math.round(thought.strength), source: thought.source, speakable: thought.speakable, avoid: thought.avoid, decay: thought.decay, candidate: thought.candidate?.outlet ?? null })),
  };
}

export { paths, join };
