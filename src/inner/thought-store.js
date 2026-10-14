// ============================================================
// 念头池的持久化与模型接线（docs/13）。
//   data/thoughts.jsonl      一行一条念头；同一 id 后写的覆盖先写的，删除用 {id, deleted:true}
//   data/thoughts-state.json 池子元数据：上次推进时间、序号、busy_until、宣告式结尾计数
//
// 写入在同一进程里串行（createSerializer）：聊天、小时推进、溢出路由、调试接口共用。
// 两处模型调用都不会阻塞回复：
//   collide  主模型调用前给相关度打分，800ms 超时 → 退化成按强度取前 N
//   extract  聊天后异步抽新念头、闭合、标记被碰到的（与记忆整理同一轮）
// 池子内容不进 Wave，也不自动进网页（调试面板默认折叠，docs/13 第 4 节）。
// ============================================================

import { paths } from "../config/paths.js";
import { complete, extractJsonObject } from "../model/client.js";
import { appendText, createSerializer, readJson, readText, writeJsonAtomic, writeTextAtomic } from "../store/files.js";
import { createLogger } from "../util/log.js";
import { formatLocalDate } from "../util/time.js";
import {
  advanceThoughts,
  applyExtract,
  createThought,
  groupCollide,
  overflowCandidates,
  releaseThought,
  selectForPrompt,
  THOUGHTS_CAPACITY,
} from "./thoughts.js";

const log = createLogger("thoughts");
export const COLLIDE_TIMEOUT_MS = 800;
/** 分类请求本身的上限：超过等待预算的结果仍可以晚到，只影响之后（docs/14 第 6.3 节）。 */
const CLASSIFIER_HARD_TIMEOUT_MS = 20_000;
const COLLIDE_MAX_TOKENS = 600;
const EXTRACT_MAX_TOKENS = 900;
/** 一天最多几次宣告式结尾（docs/13 第 9.6 节）。 */
export const ANNOUNCE_PER_DAY_LIMIT = 1;

const serialize = createSerializer();
const EMPTY_META = Object.freeze({ at: 0, seq: 0, busyUntil: 0, announceDay: null, announceCount: 0, lastExtractAt: 0 });

/** jsonl 按 id 折叠：后写的覆盖先写的，deleted 行删掉。 */
function foldRows(text) {
  const order = [];
  const byId = new Map();
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row?.id) continue;
    if (row.deleted) {
      if (byId.delete(row.id)) order.splice(order.indexOf(row.id), 1);
      continue;
    }
    if (!byId.has(row.id)) order.push(row.id);
    byId.set(row.id, row);
  }
  return order.map((id) => byId.get(id));
}

function metaOf(pool) {
  return { at: pool.at, seq: pool.seq, busyUntil: pool.busyUntil ?? 0, announceDay: pool.announceDay ?? null, announceCount: pool.announceCount ?? 0, lastExtractAt: pool.lastExtractAt ?? 0 };
}

async function readPoolUnsafe() {
  const [text, meta] = await Promise.all([readText(paths.thoughts()), readJson(paths.thoughtsMeta(), EMPTY_META)]);
  const thoughts = foldRows(text);
  return { ...EMPTY_META, ...meta, thoughts, seq: Number(meta.seq) || thoughts.length };
}

/** 追加若干行的最新状态（正常路径：只写变化过的念头）。 */
async function flush(pool, rows) {
  if (rows.length > 0) await appendText(paths.thoughts(), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  await writeJsonAtomic(paths.thoughtsMeta(), metaOf(pool));
}

/** 整池写回（初始化、调试写入用）。 */
async function flushSnapshot(pool, thoughts) {
  const text = thoughts.map((thought) => JSON.stringify(thought)).join("\n");
  await writeTextAtomic(paths.thoughts(), text ? `${text}\n` : "");
  await writeJsonAtomic(paths.thoughtsMeta(), metaOf(pool));
}

export function readPool() {
  return serialize(readPoolUnsafe);
}

/** 推进到 now（纯代码，按整点逐小时）。池子自己跑，和他来不来无关。 */
export function advancePool(nowMs = Date.now(), { persist = true } = {}) {
  return serialize(async () => {
    const pool = await readPoolUnsafe();
    if (nowMs <= pool.at) return pool;
    const from = pool.at || nowMs;
    const { state, evicted } = advanceThoughts({ at: pool.at, thoughts: pool.thoughts }, from, nowMs);
    const next = { ...pool, at: state.at, thoughts: state.thoughts };
    if (persist) {
      // 强度普遍变了，整池写回；池子小（≤15 条），代价可接受。
      await flushSnapshot(next, state.thoughts);
    }
    if (evicted.length > 0) log.debug("evicted", { count: evicted.length });
    return { ...next, evicted };
  });
}

/** 溢出路由：够强度的念头排进出口候选。只入队，不减强度（docs/14 第 1.2 节）。 */
export function routeOverflow(nowMs = Date.now()) {
  return serialize(async () => {
    const pool = await readPoolUnsafe();
    const before = new Map(pool.thoughts.map((thought) => [thought.id, JSON.stringify(thought.candidate ?? null)]));
    const candidates = overflowCandidates(pool.thoughts);
    const rows = pool.thoughts.filter((thought) => JSON.stringify(thought.candidate ?? null) !== before.get(thought.id));
    await flush(pool, rows);
    return { candidates, pool };
  });
}

/** 出口确认成功：这时才减 30。之后不再重复入队。 */
export function confirmRelease(id) {
  return serialize(async () => {
    const pool = await readPoolUnsafe();
    const thought = releaseThought(pool.thoughts, id);
    if (!thought) return null;
    await flush(pool, [thought]);
    return thought;
  });
}

/** 候选没能出去（取消、失败、结果未知）：清掉候选、不动强度，之后还能再来。 */
export function dropCandidate(id) {
  return serialize(async () => {
    const pool = await readPoolUnsafe();
    const thought = pool.thoughts.find((item) => item.id === id);
    if (!thought?.candidate) return null;
    delete thought.candidate;
    await flush(pool, [thought]);
    return thought;
  });
}

/**
 * 前置分类（docs/13 第 2.2 节 + docs/14 第 6.1 节）：一次调用同时拿到
 *   scores     他这条消息 × 每条念头的相关度
 *   appraisal  对她的一次性评价（愉悦/激活/张力方向 + 重要度/把握/意外），或 null
 * 不为身体系统另加第三次常规模型调用。
 */
async function classify(userText, thoughts) {
  const raw = await complete({
    role: "background",
    messages: [
      {
        role: "user",
        content: [
          "下面是一个人此刻心里的一组念头，和她刚收到的一条消息。",
          "1. 给每条念头打 0–1 分，表示这条消息会不会让她想起这个念头（被戳到、被牵动）。",
          "2. 评价这条消息对她有什么一次性的影响：valence（−1 不快 … 1 愉悦）、activation（−1 平静 … 1 兴奋/警觉）、tension（−1 释然 … 1 增加负荷）、importance（0–1）、confidence（0–1，你有多确定）、surprise（0–1）。",
          "   普通的问候、他没回、他晚回都不算拒绝或冷落；证据不足就把 appraisal 写成 null。",
          '只输出 JSON：{"scores": {"念头id": 0.0}, "appraisal": {"valence": 0, "activation": 0, "tension": 0, "importance": 0, "confidence": 0, "surprise": 0} 或 null}',
          "",
          "## 她心里的念头",
          ...(thoughts.length > 0 ? thoughts.map((thought) => `- ${thought.id}：${thought.content}`) : ["（没有）"]),
          "",
          "## 她刚收到的消息",
          userText,
        ].join("\n"),
      },
    ],
    maxTokens: COLLIDE_MAX_TOKENS,
    // 分类是要快的小活：关掉推理。请求本身给宽一点的上限（晚到的评价还要用），等待预算在 collide 里控制。
    reasoning: "off",
    signal: AbortSignal.timeout(CLASSIFIER_HARD_TIMEOUT_MS),
  });
  const json = extractJsonObject(raw);
  if (!json || typeof json !== "object") throw new Error("bad classifier output");
  const scores = {};
  for (const [id, value] of Object.entries(json.scores ?? {})) {
    const score = Number(value);
    if (Number.isFinite(score)) scores[id] = Math.max(0, Math.min(1, score));
  }
  return { scores, appraisal: json.appraisal ?? null };
}

/**
 * 碰撞：他这条消息会让她想起哪些念头（docs/13 第 2.2 节）。
 * 等待预算 800ms：到点还没回就不判相关性，只保留背景，回复照常（不能让小模型阻塞回复）。
 * 晚到的结果不倒写这条回复，只把评价交给 onLateAppraisal（内核按时效折减或丢弃，docs/14 第 6.3 节）。
 * @param {string} userText
 * @param {{nowMs?: number, waitMs?: number, classifier?: (text: string, thoughts: any[]) => Promise<{scores: any, appraisal: any}>, onLateAppraisal?: (appraisal: any) => void}} [options]
 */
export function collide(userText, options = {}) {
  return serialize(async () => {
    const nowMs = options.nowMs ?? Date.now();
    const pool = await readPoolUnsafe();
    const advanced = nowMs > pool.at ? advanceThoughts({ at: pool.at, thoughts: pool.thoughts }, pool.at || nowMs, nowMs) : { state: { at: pool.at, thoughts: pool.thoughts }, evicted: [] };
    const classifier = options.classifier ?? classify;
    const running = classifier(userText, advanced.state.thoughts);
    const TIMED_OUT = Symbol("timeout");
    let timer;
    const budget = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), options.waitMs ?? COLLIDE_TIMEOUT_MS);
    });
    const result = await Promise.race([running, budget])
      .catch((error) => {
        log.warn("classifier failed, keeping background only", { error: error?.message });
        return null;
      })
      .finally(() => clearTimeout(timer));
    if (result === TIMED_OUT) {
      log.info("classifier over budget, keeping background only");
      running.then((late) => options.onLateAppraisal?.(late?.appraisal)).catch(() => undefined);
    }
    const degraded = result === null || result === TIMED_OUT;
    // 强度不是相关证据。伪造分数会误激活/触发回避，每轮又 +5/+10，形成自我强化。
    // 空分数仍让高强度念头进入背景，但不会冒充被他说中，也不改变触碰次数。
    const effective = degraded ? {} : result.scores;
    const groups = groupCollide(advanced.state.thoughts, effective, nowMs);
    const next = { ...pool, at: advanced.state.at, thoughts: advanced.state.thoughts };
    await flushSnapshot(next, next.thoughts);
    return { pool: next, groups, degraded, appraisal: degraded ? undefined : result.appraisal, evicted: advanced.evicted };
  });
}

/** 注入块用的选择（注意预算与不可说的处理见 docs/14 第 9.2 节）。 */
export function selectThoughts(groups, options = {}) {
  return selectForPrompt(groups, options);
}

/** 念头抽取的提示词（导出给测试用）。 */
export function extractPrompt(conversation, thoughts) {
  return [
    "下面是一个人和她的聊天，以及她此刻心里的念头。",
    "整理这批念头：新出现的、已经被回应而闭合的、被这轮聊天碰到的。",
    '只输出 JSON：{"new": [{"content": "…", "source": "him|life|world|infer", "speakable": true, "avoid": false, "closes_on": "… 或 null", "decay": "open_loop|fade|slow_fade|spike", "strength": 30-70, "demand": 0-1}], "closed": ["id"], "touched": ["id"]}',
    "",
    "规则：",
    "- 他说的事实、约定、没回音的话 → source=him，大多 speakable=true，decay=open_loop，closes_on 写清什么算闭合。",
    "- 他对她说重话、冷落她 → source=him，speakable=false，decay=spike。她不会说，但它在。",
    "- 她对他的判断（比如「他说不在乎的时候都在乎」）→ source=infer，decay=slow_fade；他反驳时不删，只降强度。",
    "- 他推荐的东西 → source=him，closes_on 写「她看了/听了」。",
    "- 她生活里的事 → source=life；外面的世界 → source=world。",
    "- 一句平实的话，写具体的事，不超过 40 字；不修辞不打比方，不要写情绪标签。",
    "- 可说与不可说大约 7:3：不可说太少她就透明，太多会显得冷。",
    "- demand 是这件事有多少待处理的负荷（0–1）；纯愉快的期待写低值或省略。",
    "- 没有值得记的就给空的 new。",
    "",
    "## 这轮聊天",
    conversation,
    "",
    "## 她此刻心里的念头",
    thoughts.length > 0 ? thoughts.map((thought) => `- ${thought.id}（强度 ${Math.round(thought.strength)}）：${thought.content}`).join("\n") : "（池子是空的）",
  ].join("\n");
}

/**
 * 聊天后异步抽取。失败就让池子照原样跑，下一次再补（docs/13 第 0 节）。
 * @param {string} conversation
 * @param {{nowMs?: number}} [options]
 */
export function extractThoughts(conversation, options = {}) {
  return serialize(async () => {
    const nowMs = options.nowMs ?? Date.now();
    const pool = await readPoolUnsafe();
    const raw = await complete({ role: "background", messages: [{ role: "user", content: extractPrompt(conversation, pool.thoughts) }], maxTokens: EXTRACT_MAX_TOKENS });
    const json = extractJsonObject(raw);
    if (!json) return { added: [], closedIds: [], evicted: [], skipped: "bad-output" };
    const { state, added, closedIds, evicted } = applyExtract({ at: pool.at, thoughts: pool.thoughts }, json, nowMs);
    const before = new Map(pool.thoughts.map((thought) => [thought.id, JSON.stringify(thought)]));
    const kept = new Set(state.thoughts.map((thought) => thought.id));
    const rows = [
      ...state.thoughts.filter((thought) => !before.has(thought.id) || before.get(thought.id) !== JSON.stringify(thought)),
      ...pool.thoughts.filter((thought) => !kept.has(thought.id)).map((thought) => ({ id: thought.id, deleted: true })),
    ];
    await flush({ ...pool, at: nowMs, seq: pool.seq + added.length, lastExtractAt: nowMs }, rows);
    return { added, closedIds, evicted, skipped: null };
  });
}

/** 她说出口的时间反向约束程序（docs/13 第 9 节）。 */
export function setBusyUntil(untilMs) {
  return serialize(async () => {
    const pool = await readPoolUnsafe();
    const next = { ...pool, busyUntil: Math.max(0, untilMs) };
    await flush(next, []);
    return next;
  });
}

/** 她是不是正在「说了要走」的时段。 */
export async function busyState(nowMs = Date.now()) {
  const pool = await readPool();
  return pool.busyUntil > nowMs ? { busy: true, remainingMs: pool.busyUntil - nowMs } : { busy: false, remainingMs: 0 };
}

/** 宣告式结尾的每日限额（docs/13 第 9.6 节）。 */
export function takeAnnounceQuota(today = formatLocalDate()) {
  return serialize(async () => {
    const pool = await readPoolUnsafe();
    const used = pool.announceDay === today ? pool.announceCount : 0;
    if (used >= ANNOUNCE_PER_DAY_LIMIT) return { allowed: false, remaining: 0 };
    await flush({ ...pool, announceDay: today, announceCount: used + 1 }, []);
    return { allowed: true, remaining: ANNOUNCE_PER_DAY_LIMIT - used - 1 };
  });
}

/** 测试与调试用：直接写一整池。 */
export function seedPool(thoughts, nowMs = Date.now(), extra = {}) {
  return serialize(async () => {
    const rows = thoughts.map((thought, index) => createThought({ id: thought.id ?? `t_seed_${index}`, ...thought }, nowMs));
    const pool = { ...EMPTY_META, at: nowMs, seq: rows.length, thoughts: rows, ...extra };
    await flushSnapshot(pool, rows);
    return pool;
  });
}

export { THOUGHTS_CAPACITY };
