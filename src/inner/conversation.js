// ============================================================
// 这段聊天聊到了什么份上（docs/19）：搭话 / 闲扯 / 认真 / 走心 / 撩。
// 它是两个人一起定的，有惯性：聊深了不会因为他一句「哈哈」马上掉回闲扯。
//
//   判断来自决策模型给的分布（model/systemone.js）；没有就用很粗的猜测，形状相同。
//   取带惯性的最大权重；并列优先保留当前状态。相同输入不靠骰子变语气。
// 给模型的只有一两句「眼下聊成了什么样」，不含任何语气要求。
// 纯函数：不读盘、不调模型、不读系统时钟。
// ============================================================

import { MINUTE_MS } from "../util/time.js";

export const MODES = Object.freeze(["opening", "chatting", "discussing", "heart", "flirting"]);
export const MODE_CRITERIA = Object.freeze({
  opening: "刚起头，还没聊起来",
  chatting: "来回闲聊，说些有的没的",
  discussing: "在认真讨论一件事或一个问题",
  heart: "他在说难受的事，或者他很在意的事",
  flirting: "说话带暧昧或挑逗的意思（只是开玩笑、卖关子不算）",
});
export const REGISTERS = Object.freeze(["greeting", "chitchat", "share", "vent", "discuss", "ask_comfort", "flirt", "logistics"]);
export const REGISTER_CRITERIA = Object.freeze({
  greeting: "打个招呼、起个头",
  chitchat: "随口闲聊",
  share: "讲他自己的事",
  vent: "说难受的事",
  discuss: "想认真讨论一个问题",
  ask_comfort: "明确想被安慰",
  flirt: "带暧昧或挑逗的意思（开玩笑、卖关子、让她猜不算）",
  logistics: "约时间、问一件具体的事",
});

/** 问决策模型的问题。固定写在这里，不让模型自己出题，便于回归。 */
export const QUESTIONS = Object.freeze({
  next: { type: "choice", instructions: "算上他刚发来的这一条，这段聊天现在处在哪种状态？", criteria: MODE_CRITERIA },
  register: { type: "choice", instructions: "他刚发来的这一条是在做什么？", criteria: REGISTER_CRITERIA },
  need: { type: "choice", instructions: "他这一轮真正需要多少回应？依据最新消息和承接关系，不根据她以前回复很长来推断。短的‘为什么/没懂’需要解释；普通抱怨和倾诉不自动等于邀请她分析整个人生。", criteria: { acknowledge: "招呼、确认、结束，不需要展开", respond: "随口接话、分享或倾诉，回应眼前这件事即可", explain: "需要解释、观点，或明确请求安慰", explore: "明确要深入讨论、多项实质疑问，或双方已经在持续展开" } },
  followup: { type: "choice", instructions: "她本轮有必要主动向他提一个新问题吗？已知他的身体行程不算理由，不能为了续聊而问。拿不准选 none。", criteria: { none: "无必要的新问题，可以直接回应并停下", clarify: "他有请求但缺少直接影响回答的信息，需要澄清", invite: "他主动留下悬念或邀请她追问，顺着那个话头问" } },
});

/** 隔了这么久没人说话，就算另起一回。 */
export const SESSION_GAP_MS = 45 * MINUTE_MS;
/** 留在原来状态的倾向：认真和走心黏，搭话留不住。 */
export const STAY = Object.freeze({ opening: 0.6, chatting: 1.5, discussing: 2.5, heart: 2.5, flirting: 1.2 });
/** 占比低于这个的选项不参与抽取。 */
export const SAMPLE_FLOOR = 0.08;
/**
 * 看错了代价高的选项（把一句玩笑当成调情）：占比过半才算数，不从小概率里抽。
 * 已经在这个状态里接着聊不受限，那不是新的误判。
 */
export const CAUTIOUS = Object.freeze({ flirt: 0.5, flirting: 0.5 });
/** 占比到这个数才说「他这句是……」，不到就说「像是……」。 */
export const SURE_FROM = 0.6;
const LONG_CHAT_TURNS = 8;
const RECENT_MESSAGES = 6;
const RECENT_CHARS = 120;
const TEXT_CHARS = 600;

const REGISTER_TO_MODE = Object.freeze({ greeting: "opening", chitchat: "chatting", share: "chatting", logistics: "chatting", vent: "heart", ask_comfort: "heart", discuss: "discussing", flirt: "flirting" });
const DEEP = new Set(["discussing", "heart"]);

const GREETING = /^(在吗|在不在|在干嘛|哈喽|hello|hi|嗨|早|早安|早上好|中午好|下午好|晚上好|午安|晚安|睡了吗|睡了没|忙吗|忙不忙)[\s，,~～!！。.?？]*$/iu;
const COMFORT = /(哄哄我|哄我|哄一下|安慰(我|一下)|抱抱我|抱一下)/u;
const HURT = /(难受|崩溃|撑不住|想哭|哭了|好累|心累|烦死|睡不着|失眠|焦虑|害怕|委屈|难过)/u;
const THINK = /(为什么|意义|到底|你觉得|你怎么看|值不值|应不应该|该不该)/u;
const FACT = /(几点|哪天|什么时候|在哪|多少钱|地址|有空吗)/u;

/**
 * 决策模型不可用时的粗略猜测，形状和它的回答一样。宁可猜成闲聊，也不乱猜成调情。
 * @param {string} text
 * @returns {Record<string, number>}
 */
export function guessRegister(text) {
  const value = String(text ?? "").trim();
  const length = [...value].length;
  if (GREETING.test(value)) return { greeting: 0.7, chitchat: 0.3 };
  if (COMFORT.test(value)) return { ask_comfort: 0.7, vent: 0.3 };
  if (HURT.test(value)) return { vent: 0.6, share: 0.25, chitchat: 0.15 };
  if ((THINK.test(value) && length >= 12) || length >= 80) return { discuss: 0.6, share: 0.3, chitchat: 0.1 };
  if (FACT.test(value) && length <= 20) return { logistics: 0.6, chitchat: 0.4 };
  if (length <= 12) return { chitchat: 0.6, greeting: 0.2, share: 0.2 };
  return { share: 0.5, chitchat: 0.4, discuss: 0.1 };
}

/** 由「他这句在做什么」推「聊天处在哪种状态」（只在决策模型没给 next 时用）。 */
export function guessNext(registerDist) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [register, p] of Object.entries(registerDist ?? {})) {
    const mode = REGISTER_TO_MODE[register];
    if (mode) out[mode] = (out[mode] ?? 0) + p;
  }
  return out;
}

/** 去掉占比不够的高代价选项。keep 是不受限的那个键（当前所在的状态）。 */
export function guardCautious(dist, keep) {
  const total = Object.values(dist).reduce((sum, p) => sum + p, 0);
  if (total <= 0) return dist;
  return Object.fromEntries(Object.entries(dist).filter(([key, p]) => key === keep || !(key in CAUTIOUS) || p / total >= CAUTIOUS[key]));
}

/** 只留认识的键、非负的数。 */
function clean(dist, keys) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const key of keys) {
    const p = Number(dist?.[key]);
    if (Number.isFinite(p) && p > 0) out[key] = p;
  }
  return out;
}

/**
 * 按分布抽一个。占比低于 SAMPLE_FLOOR 的不参与；全空返回 fallback。
 * @param {Record<string, number>} dist
 * @param {() => number} rng
 * @param {string} fallback
 * @returns {{pick: string, share: number}} share 是抽中项在全部里的占比
 */
export function sample(dist, rng, fallback) {
  const entries = Object.entries(dist ?? {}).filter(([, p]) => Number.isFinite(p) && p > 0);
  const total = entries.reduce((sum, [, p]) => sum + p, 0);
  if (total <= 0) return { pick: fallback, share: 0 };
  const kept = entries.filter(([, p]) => p / total >= SAMPLE_FLOOR);
  const pool = kept.length > 0 ? kept : entries;
  const sum = pool.reduce((acc, [, p]) => acc + p, 0);
  let roll = Math.max(0, Math.min(0.999999, rng())) * sum;
  for (const [key, p] of pool) {
    roll -= p;
    if (roll < 0) return { pick: key, share: p / total };
  }
  const last = pool.at(-1);
  return { pick: last[0], share: last[1] / total };
}

/** 确定性选择；并列保留 fallback，否则使用键的稳定顺序。 */
export function choose(dist, fallback) {
  const entries = Object.entries(dist ?? {}).filter(([, p]) => Number.isFinite(p) && p > 0);
  const total = entries.reduce((sum, [, p]) => sum + p, 0);
  if (!total) return { pick: fallback, share: 0 };
  const maximum = Math.max(...entries.map(([, p]) => p));
  const tied = entries.filter(([, p]) => p === maximum);
  return { pick: tied.find(([key]) => key === fallback)?.[0] ?? tied[0][0], share: maximum / total };
}

function confidentChoice(result, keys, fallback) {
  const chosen = choose(clean(result?.probabilities, keys), fallback);
  return chosen.share >= SURE_FROM ? chosen.pick : fallback;
}

/**
 * 各状态的权重：这句话带来的分布 × 留在原状态的倾向。聊过两轮以后就不再是「刚起头」。
 * @param {Record<string, number>} nextDist
 * @param {{mode: string, turns: number} | null} base 同一回聊天里的上一个状态；另起一回时为 null
 */
export function modeWeights(nextDist, base) {
  const weights = clean(nextDist, MODES);
  if (base) {
    if (weights[base.mode]) weights[base.mode] *= STAY[base.mode] ?? 1;
    if (base.turns >= 2 || base.mode !== "opening") delete weights.opening;
  }
  return weights;
}

/** 这条消息和上一个状态是不是同一回聊天。 */
export function sameSession(prev, input) {
  const sentAt = Number.isFinite(input.sentAt) ? input.sentAt : input.at;
  return Boolean(prev) && sentAt - prev.lastAt <= SESSION_GAP_MS;
}

/**
 * 他发来一条消息后，聊天状态往前走一步。同一条消息只走一次（重试、重新生成复用）。
 * @param {any} prev 上一次的状态；没有为 null
 * @param {{messageId: string, at: number, sentAt?: number, text: string, reading?: {next?: {probabilities: any}, register?: {probabilities: any}} | null, safety?: boolean, answering?: boolean, rng?: () => number}} input
 *   at：她看到这条消息的时刻（记成 lastAt，约等于她回他的时刻）。
 *   sentAt：他发出这条消息的时刻。是不是同一回聊天，看「他发出」距「她上次回他」多久：
 *     她回得晚不会把一回聊天切成两回；她睡着时他连发几条，也不会被算成接着昨天聊。
 *   answering：这一回是她先发的消息，他这条是在回她。
 */
export function advanceConversation(prev, input) {
  if (prev && prev.lastMessageId === input.messageId) return prev;
  const base = prev && sameSession(prev, input) ? prev : null;
  const fromModel = clean(input.reading?.register?.probabilities, REGISTERS);
  const registerDist = guardCautious(Object.keys(fromModel).length > 0 ? fromModel : guessRegister(input.text));
  const nextFromModel = clean(input.reading?.next?.probabilities, MODES);
  const nextDist = guardCautious(Object.keys(nextFromModel).length > 0 ? nextFromModel : guessNext(registerDist), base?.mode);
  const mode = input.safety ? "heart" : choose(modeWeights(nextDist, base), base?.mode ?? "chatting").pick;
  const register = input.safety ? { pick: "vent", share: 1 } : choose(registerDist, "chitchat");
  return {
    mode,
    prevMode: base?.mode ?? null,
    turns: (base?.turns ?? 0) + 1,
    modeTurns: base && base.mode === mode ? base.modeTurns + 1 : 1,
    register: register.pick,
    need: confidentChoice(input.reading?.need, ["acknowledge", "respond", "explain", "explore"], null),
    followup: confidentChoice(input.reading?.followup, ["none", "clarify", "invite"], "none"),
    sure: register.share >= SURE_FROM,
    asks: /[?？]|[吗呢么]\s*$/u.test(String(input.text ?? "").trim()),
    answering: !base && Boolean(input.answering),
    source: Object.keys(nextFromModel).length > 0 || Object.keys(fromModel).length > 0 ? "decision" : "guess",
    startedAt: base?.startedAt ?? input.at,
    lastAt: input.at,
    lastMessageId: input.messageId,
    perturbTurn: base?.perturbTurn ?? 0,
  };
}

/** 眼下聊成了什么样（第三人称事实）。start = 这一回的头一句，first = 刚转到这个状态，on = 已经这样聊了几轮。 */
export const WHERE = Object.freeze({
  opening: { start: "他刚发来这一条，他们这回还没聊起来。", first: "他们刚搭上话。", on: "他们刚搭上话。" },
  chatting: { start: "他刚发来这一条，他们这回还没聊起来。", first: "他们这会儿在闲扯。", on: "他们来回说了几句，都是些有的没的。", long: "他们东一句西一句，聊了好一阵了。" },
  discussing: { start: "他一上来就想聊一件正经事。", first: "聊着聊着，说到一件正经事上了。", on: "他们在聊一件正经事，已经来回了几轮。" },
  heart: { start: "他一上来说的就是心里的事。", first: "聊着聊着，他说起心里的事了。", on: "他在跟她说心里的事，已经说了一会儿。" },
  flirting: { start: "他一上来就在逗她。", first: "他们说着说着开始没正经了。", on: "他们这会儿说话没个正经，互相在逗。" },
});
export const DOING = Object.freeze({
  greeting: "打个招呼",
  chitchat: "随口说的",
  share: "在讲他自己的事",
  vent: "在说难受的事",
  discuss: "想认真聊这个",
  ask_comfort: "想听她说两句安慰的话",
  flirt: "在逗她",
  logistics: "在问一件具体的事",
});
export const ANSWERING = "是她先给他发的消息，他这条是在回她。";
export const NO_TIME = "她手上的事还没完。";

/**
 * 给提示词的一两句。安全例外不写（那时只有一件事，处境那句已经说了）。
 * @param {any} state advanceConversation 的结果
 * @param {{attention?: string, safety?: boolean}} [ctx]
 * @returns {string[]}
 */
export function conversationLines(state, ctx = {}) {
  if (!state || ctx.safety) return [];
  const table = WHERE[state.mode] ?? WHERE.chatting;
  const variant = state.turns === 1 ? "start" : state.modeTurns === 1 ? "first" : state.mode === "chatting" && state.modeTurns >= LONG_CHAT_TURNS ? "long" : "on";
  const lines = [state.turns === 1 && state.answering ? ANSWERING : table[variant] ?? table.on];
  // 他这句和眼下的状态是一回事时不重复说；不是一回事（聊着正经事他忽然开了句玩笑）才值得写。
  const sameThing = REGISTER_TO_MODE[state.register] === state.mode && state.mode !== "opening" && state.mode !== "chatting";
  if (!sameThing && DOING[state.register]) {
    const doing = state.register === "chitchat" && state.asks ? "随口问的" : DOING[state.register];
    lines.push(`他这句${state.sure ? "是" : "像是"}${doing}。`);
  }
  if (ctx.attention === "glance" && DEEP.has(state.mode)) lines.push(NO_TIME);
  return lines;
}

/**
 * 交给决策模型看的材料：只有判断这段聊天需要的最少信息，不含记忆、人设和她的心事。
 * @param {{scene?: string, prev?: any, at: number, sentAt?: number, recent?: {role: string, text: string}[], text: string}} input
 */
export function decisionState(input) {
  const cut = (text, limit) => {
    const chars = [...String(text ?? "").replace(/\s+/gu, " ").trim()];
    return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : chars.join("");
  };
  const continuing = sameSession(input.prev, input);
  return {
    她此刻: input.scene || "不清楚",
    这段聊天之前的状态: continuing ? `${MODE_CRITERIA[input.prev.mode] ?? "闲聊"}（已经 ${input.prev.turns} 轮）` : "还没开始，这是隔了一阵之后的第一条",
    最近几句: (input.recent ?? []).slice(-RECENT_MESSAGES).map((message) => `${message.role === "user" ? "他" : "她"}：${cut(message.text, RECENT_CHARS)}`),
    他刚发来: cut(input.text, TEXT_CHARS),
  };
}
