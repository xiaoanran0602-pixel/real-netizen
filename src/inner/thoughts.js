// ============================================================
// 念头池（docs/13）：她此刻脑子里的事。这里全是纯函数，不读盘、不调模型。
//   tick   每小时按 decay 类型调整 strength（和他在不在完全无关）
//   容量   15 条；超了挤掉最弱的 —— 她会真的忘事，不做任何提醒
//   溢出   strength ≥ 80 的念头按 source 路由到出口（主动消息 / 日程素材 / 朋友圈）
//   碰撞   他这条消息 × 每条念头的相关度 → 激活集 / 回避命中 / 背景集
//   抽取   聊天后异步加新念头、闭合旧念头、标记被碰到的
//
// 14 号文档对这里的收紧（docs/14 第 1.2 节）也在本文件落实：
//   - 候选入队不等于说出口：只有出口确认成功才减 30（releaseThought），入队本身不减。
//   - 同一条消息最多影响一次（去重由 store 按消息 id 负责）。
//   - 不因高张力自动授权泄露不可说内容；「漏半句」仍只由 12 的防线机制决定。
//   - 不可说念头把 20% 分给别人：首版不启用。
// 另外每个念头带一个可选的 affect.demand（docs/14 第 3.3 节），供身体内核算负荷 U；
// 它只能由事件或校验过的抽取结果修改，tick 不让它自增。
// ============================================================

import { formatLocalDate, HOUR_MS } from "../util/time.js";

export const THOUGHTS_CAPACITY = 15;
export const THRESHOLDS = Object.freeze({ overflow: 80, background: 60, relevance: 0.5, drop: 5 });
export const SOURCES = Object.freeze(["him", "life", "world", "infer"]);
export const DECAYS = Object.freeze(["open_loop", "fade", "slow_fade", "spike"]);
export const CONTENT_MAX_CHARS = 40;
export const EXTRACT_STRENGTH_RANGE = Object.freeze([30, 70]);
/** 说出去了就轻了：出口确认成功时减这么多。 */
export const RELEASE_DROP = 30;
/** 退出池子前若 source=him 且被激活过这么多次，值得写进长期记忆。 */
export const REMEMBER_ACTIVATIONS = 3;
const SPIKE_HOURS = 24;

/** 每条念头的每小时变化。open_loop 未闭合时升高（有期限的等待才允许），其余下降。 */
const RATE_PER_HOUR = Object.freeze({ open_loop: 1, fade: -2, slow_fade: -3 / 24, spike: -10 });
const DYNAMIC_RATE = { ...RATE_PER_HOUR, spike: -2 };

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));

export function createThought(fields, nowMs = Date.now()) {
  const at = new Date(nowMs).toISOString();
  return {
    id: fields.id,
    content: String(fields.content ?? "").slice(0, CONTENT_MAX_CHARS),
    strength: clamp(Number(fields.strength) || 0),
    source: SOURCES.includes(fields.source) ? fields.source : "infer",
    speakable: fields.speakable !== false,
    avoid: fields.avoid === true,
    closes_on: fields.closes_on ? String(fields.closes_on).slice(0, 80) : null,
    born: fields.born ?? at,
    last_touched: fields.last_touched ?? at,
    decay: DECAYS.includes(fields.decay) ? fields.decay : "fade",
    activations: Number(fields.activations) || 0,
    ...(Number(fields.demand) > 0 ? { affect: { demand: Math.min(1, Number(fields.demand)) } } : {}),
    ...(fields.candidate ? { candidate: fields.candidate } : {}),
    ...(fields.evidenceEventId ? { evidenceEventId: fields.evidenceEventId } : {}),
  };
}

export function thoughtId(nowMs, seq) {
  return `t_${formatLocalDate(new Date(nowMs)).replace(/-/gu, "")}_${String(seq).padStart(3, "0")}`;
}

/** 每小时的变化量。strength 高时上限 95（open_loop 也不会无限涨）。 */
function hourDelta(thought, atMs) {
  let rate = RATE_PER_HOUR[thought.decay] ?? -2;
  if (thought.decay === "spike") {
    const ageHours = (atMs - Date.parse(thought.born)) / HOUR_MS;
    if (ageHours > SPIKE_HOURS) rate = DYNAMIC_RATE.spike;
  }
  if (rate > 0 && thought.strength >= 95) return 0;
  return rate;
}

/**
 * 推进到 to。按对齐的整点逐小时结算，所以调用频率不影响结果（docs/14 第 7.2 节的要求）。
 * @param {{at: number, thoughts: any[]}} input
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {{state: {at: number, thoughts: any[]}, evicted: any[], closedByDecay: any[]}}
 */
export function advanceThoughts(input, fromMs, toMs) {
  const thoughts = input.thoughts.map((thought) => ({ ...thought }));
  const evicted = [];
  const byId = new Map(thoughts.map((thought) => [thought.id, thought]));
  const firstHour = Math.ceil(fromMs / HOUR_MS) * HOUR_MS;
  const lastHour = Math.floor(toMs / HOUR_MS) * HOUR_MS;
  for (let at = firstHour; at <= lastHour; at += HOUR_MS) {
    for (const thought of thoughts) {
      const next = clamp(thought.strength + hourDelta(thought, at));
      if (next !== thought.strength) {
        thought.strength = next;
        thought.decayedAt = at;
      }
    }
    for (const thought of [...thoughts]) {
      if (thought.strength > THRESHOLDS.drop) continue;
      thoughts.splice(thoughts.indexOf(thought), 1);
      byId.delete(thought.id);
      evicted.push(thought);
    }
    // 容量挤出：她会真的忘事。挤出去的若是他留下且被反复想起的，值得写进记忆。
    while (thoughts.length > THOUGHTS_CAPACITY) {
      let weakest = 0;
      for (let index = 1; index < thoughts.length; index += 1) if (thoughts[index].strength < thoughts[weakest].strength) weakest = index;
      const [gone] = thoughts.splice(weakest, 1);
      byId.delete(gone.id);
      evicted.push(gone);
    }
  }
  return { state: { at: Math.max(input.at ?? 0, toMs), thoughts }, evicted, closedByDecay: evicted.filter((thought) => thought.strength <= THRESHOLDS.drop) };
}

/** 他自己留下的事还没回音：这些念头的强度总和就是「想念」（docs/13 第 5 节）。 */
export function himLoad(thoughts) {
  return thoughts.filter((thought) => thought.source === "him").reduce((sum, thought) => sum + thought.strength, 0);
}

/**
 * 溢出路由（docs/13 第 2.3 节）。只入队候选，不减强度；真正说出去由 releaseThought 负责。
 * @param {any[]} thoughts
 */
export function overflowCandidates(thoughts) {
  const candidates = [];
  for (const thought of thoughts) {
    if (thought.candidate || thought.strength < THRESHOLDS.overflow) continue;
    if (!thought.speakable) continue;
    const outlet = thought.source === "him" ? "message" : "post";
    thought.candidate = { outlet, queuedAt: Date.now() };
    candidates.push({ id: thought.id, outlet, content: thought.content, source: thought.source });
  }
  return candidates;
}

/**
 * 出口确认成功后调用：同一念头只减一次，之后不再重复入队。
 * 取消、失败、结果未知都不释放（docs/14 第 1.2 节）。
 */
export function releaseThought(thoughts, id) {
  const thought = thoughts.find((item) => item.id === id);
  if (!thought || !thought.candidate) return null;
  thought.strength = clamp(thought.strength - RELEASE_DROP);
  delete thought.candidate;
  thought.last_touched = new Date().toISOString();
  return thought;
}

/**
 * 碰撞的分组规则（docs/13 第 2.2 节）。scores 是 id → 0–1 的相关度。
 * 返回三组，并就地改强度与 last_touched。
 */
export function groupCollide(thoughts, scores, nowMs = Date.now()) {
  const at = new Date(nowMs).toISOString();
  const activated = [];
  const avoided = [];
  const background = [];
  for (const thought of thoughts) {
    const score = Number(scores?.[thought.id]);
    if (Number.isFinite(score) && score >= THRESHOLDS.relevance) {
      if (thought.avoid) {
        // 他碰到了她不想说的东西：不激活、涨强度，但表面绕开。
        thought.strength = clamp(thought.strength + 10);
        avoided.push(thought);
        continue;
      }
      thought.strength = clamp(thought.strength + 5);
      thought.last_touched = at;
      thought.activations = (thought.activations ?? 0) + 1;
      activated.push(thought);
      continue;
    }
    if (thought.strength >= THRESHOLDS.background) background.push(thought);
  }
  activated.sort((a, b) => (Number(scores?.[b.id]) || 0) - (Number(scores?.[a.id]) || 0) || b.strength - a.strength);
  background.sort((a, b) => b.strength - a.strength);
  avoided.sort((a, b) => b.strength - a.strength);
  return { activated, avoided, background };
}

/**
 * 小模型或记忆整理返回的抽取结果（docs/13 第 2.4 节）。
 * @param {{at: number, thoughts: any[]}} input
 * @param {{new?: any[], closed?: string[], touched?: string[]}} result
 */
export function applyExtract(input, result, nowMs = Date.now()) {
  const thoughts = input.thoughts.map((thought) => ({ ...thought }));
  let seq = thoughts.length;
  const added = [];
  for (const item of result?.new ?? []) {
    if (!item?.content) continue;
    const strength = clamp(Number(item.strength) || 50, EXTRACT_STRENGTH_RANGE[0], EXTRACT_STRENGTH_RANGE[1]);
    seq += 1;
    const thought = createThought({ ...item, strength, id: thoughtId(nowMs, seq) }, nowMs);
    added.push(thought);
    thoughts.push(thought);
  }
  const closedIds = [];
  for (const id of result?.closed ?? []) {
    const thought = thoughts.find((item) => item.id === id);
    if (!thought) continue;
    // 闭合不等于忘掉：改衰减曲线、掉一截强度，之后按时间退去（docs/14 第 3.3 节）。
    thought.decay = "fade";
    thought.strength = clamp(thought.strength - 40);
    // 标记已闭合：想念只算「还没回音」的念头（merge-inner-engines design §5）。不影响涨落。
    thought.closed = true;
    delete thought.candidate;
    delete thought.affect;
    closedIds.push(id);
  }
  for (const id of result?.touched ?? []) {
    const thought = thoughts.find((item) => item.id === id);
    if (!thought) continue;
    thought.strength = clamp(thought.strength + 5);
    thought.last_touched = new Date(nowMs).toISOString();
  }
  // 修复（演练发现）：闭合后掉到 5 以下的念头原来要等下一个整点才删，期间还会被当成激活候选；现在当场清掉。
  const alive = thoughts.filter((thought) => thought.strength > THRESHOLDS.drop);
  const dropped = thoughts.filter((thought) => thought.strength <= THRESHOLDS.drop);
  const trimmed = trimToCapacity(alive);
  return { state: { at: input.at ?? nowMs, thoughts: trimmed.thoughts }, added, closedIds, evicted: [...dropped, ...trimmed.evicted] };
}

function trimToCapacity(thoughts) {
  const evicted = [];
  const kept = [...thoughts];
  while (kept.length > THOUGHTS_CAPACITY) {
    let weakest = 0;
    for (let index = 1; index < kept.length; index += 1) if (kept[index].strength < kept[weakest].strength) weakest = index;
    evicted.push(...kept.splice(weakest, 1));
  }
  return { thoughts: kept, evicted };
}

/**
 * 该写进长期记忆的念头（被别人挤出去，但他留下的、她反复想起过的）。
 * @param {any[]} evicted
 */
export function worthRemembering(evicted) {
  return evicted.filter((thought) => thought.source === "him" && (thought.activations ?? 0) >= REMEMBER_ACTIVATIONS);
}

/**
 * 进提示词的挑选（docs/13 第 3 节 + docs/14 第 9.2 节）：
 * 说得出、且被这条消息碰到的念头进「正在想」，受注意预算限制；背景至多 1 条。
 * 说不出口的（speakable=false）一律不进「正在想」，只单独列出（docs/13 第 3 节）。
 */
export function selectForPrompt(groups, options = {}) {
  const budget = Math.max(1, Math.min(4, options.activeBudget ?? 2));
  const activated = groups.activated.filter((thought) => thought.speakable).slice(0, budget);
  const activatedIds = new Set(activated.map((thought) => thought.id));
  const background = groups.background.filter((thought) => thought.speakable && !activatedIds.has(thought.id)).slice(0, 1);
  const unspoken = [...groups.activated, ...groups.avoided, ...groups.background]
    .filter((thought) => !thought.speakable)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, options.unspokenLimit ?? 3);
  return { activated, background, avoided: groups.avoided.slice(0, 2), unspoken };
}

/** 提示词注入块（docs/13 第 3 节，当前日程不作为内容，见第 9.4 节）。只列事实，不附对她的说明。 */
export function formatThoughtsSection(selection) {
  const lines = [];
  const block = (title, items) => {
    if (items.length === 0) return;
    lines.push(`${title}：`, ...items.map((thought) => `- ${thought.content}`));
  };
  block("和他这条消息有关的", selection.activated);
  block("和他说的无关，这会儿也在心上的", selection.background);
  block("她不会说出来的", selection.unspoken);
  block("他刚碰到、她想绕开的", selection.avoided);
  if (lines.length === 0) return null;
  return ["她心里在转的事：", ...lines].join("\n");
}

/** 空池/未接入时的版本号，让身体内核知道没有念头输入（docs/14 第 3.3 节）。 */
export const EMPTY_POOL = Object.freeze({ at: 0, thoughts: [] });
