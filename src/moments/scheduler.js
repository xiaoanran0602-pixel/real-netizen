// ============================================================
// 她的动态调度器：随机间隔（7–23 分钟）醒来，看天气、新闻、她今天的日程、最近聊的天，
// 交给模型决定要不要发朋友圈、换头像、换签名、主动找他。不是整点定时：大多数时候什么都不做。
// 深夜（2–7 点）静默；每日上限；聊天结束（turn_done）、点赞、评论会唤醒它（有冷却）。
// 每次醒来先结算内心状态（惰性）；主动找他的条件接入对照表与生病状态（docs/12 第 5、9 节）。
// --dry 时不启动（main.js 决定）。
// ============================================================

import { readSettings } from "../config/settings.js";
import { readChannelSecrets } from "../config/secrets.js";
import { enabledChannels } from "../channels/registry.js";
import { getMainConversationId, readConversation } from "../store/conversation.js";
import { readState } from "../store/state.js";
import { createLogger } from "../util/log.js";
import { HOUR_MS, MINUTE_MS, randomBetween, sameLocalDay } from "../util/time.js";
import { decide } from "./decide.js";
import { executeDecision } from "./execute.js";
import { countToday, readMoments, readProfile, updateProfile } from "./store.js";
import { DEFAULT_CITY, formatWeather, getWorld, weatherKind } from "./world.js";

const log = createLogger("moments");
export const MIN_INTERVAL_MS = 7 * MINUTE_MS;
export const MAX_INTERVAL_MS = 23 * MINUTE_MS;
export const QUIET_START_HOUR = 2;
export const QUIET_END_HOUR = 7;
export const POSTS_PER_DAY = 3;
export const AVATAR_COOLDOWN_MS = 3 * 24 * HOUR_MS;
export const SIGNATURE_PER_DAY = 1;
/** 没有事件时，醒来后真去问模型的概率；大多数醒来什么都不做。 */
export const IDLE_CONSIDER_PROBABILITY = 0.18;
const MAX_CONSIDER_FACTOR = 3;
export const CHAT_NUDGE_COOLDOWN_MS = 20 * MINUTE_MS;
export const DEFAULT_PROACTIVE_PER_DAY = 2;
/** 主动找他之前，他至少多久没说话；刚聊完就主动发显得很怪。 */
export const PROACTIVE_MIN_SILENCE_MS = 2 * HOUR_MS;
export const PROACTIVE_MIN_GAP_MS = 4 * HOUR_MS;
export const PROACTIVE_START_HOUR = 9;
export const PROACTIVE_END_HOUR = 23;
const NUDGE_DELAY_MIN_MS = 60_000;
const NUDGE_DELAY_MAX_MS = 6 * 60_000;
const CHAT_TEXT_MESSAGES = 8;

export function inQuietHours(now) {
  const hour = now.getHours();
  return hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;
}

export function allowedActions(now, profile, posts) {
  const allowed = [];
  if (countToday(posts.filter((post) => post.trigger !== "manual"), now) < POSTS_PER_DAY) allowed.push("post");
  if (!profile.avatar || now.getTime() - profile.avatar.at > AVATAR_COOLDOWN_MS) allowed.push("avatar");
  if (countToday(profile.history.filter((item) => item.kind === "signature"), now) < SIGNATURE_PER_DAY) allowed.push("signature");
  return allowed;
}

/**
 * 主动找他的条件（纯函数）：有可用聊天渠道、白天、未超每日上限、离上次主动够久、他沉默够久；再按对照表控制。
 * @param {{now: Date, channelReady: boolean, perDay: number, proactiveToday: number, lastProactiveAt?: number, lastUserMessageAt?: number, inner?: {allowed: boolean, factor: number}, random?: () => number}} input
 */
export function canMessage(input) {
  if (!input.channelReady) return false;
  const hour = input.now.getHours();
  if (hour < PROACTIVE_START_HOUR || hour >= PROACTIVE_END_HOUR) return false;
  if (input.proactiveToday >= input.perDay) return false;
  if (input.lastProactiveAt && input.now.getTime() - input.lastProactiveAt < PROACTIVE_MIN_GAP_MS) return false;
  if (input.lastUserMessageAt && input.now.getTime() - input.lastUserMessageAt <= PROACTIVE_MIN_SILENCE_MS) return false;
  if (input.inner && !input.inner.allowed) return false;
  // 对照表系数 < 1 时按概率放行（压力大、加班周更少主动）；≥ 1 一律放行，交给模型和醒来概率决定。
  if (input.inner && input.inner.factor < 1) return (input.random ?? Math.random)() < input.inner.factor;
  return true;
}

/**
 * 没有事件时醒来真去想一想的概率：对照表系数 > 1（想念高、生病）时上调。
 * 修复：原来系数 ≥ 1 时什么都不变，生病“主动概率上调”（docs/12 第 9 节）没有效果。
 * 系数 < 1 只在 canMessage 里生效一次，这里不再下调，避免同一个原因被扣两遍。
 * @param {{factor: number} | undefined} proactive
 */
export function considerProbability(proactive) {
  const factor = Math.max(1, Math.min(MAX_CONSIDER_FACTOR, proactive?.factor ?? 1));
  return IDLE_CONSIDER_PROBABILITY * factor;
}

/**
 * @param {{bridge: ReturnType<import("../channels/bridge.js").createChannelBridge>, innerState?: (now: Date) => Promise<any>, now?: () => Date, random?: () => number}} deps
 */
export function createMomentsScheduler(deps) {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  let timer;
  let running = false;
  let paused = false;
  let lastChatNudgeAt = 0;

  async function proactiveFacts(at, inner) {
    const [settings, secrets, state] = await Promise.all([readSettings(), readChannelSecrets(), readState()]);
    const messages = await readConversation(await getMainConversationId());
    const proactive = messages.filter((m) => m.source === "proactive");
    return {
      now: at,
      channelReady: enabledChannels(secrets).length > 0,
      perDay: settings.proactivePerDay ?? DEFAULT_PROACTIVE_PER_DAY,
      proactiveToday: proactive.filter((m) => sameLocalDay(m.at, at.getTime())).length,
      lastProactiveAt: proactive.at(-1)?.at,
      lastUserMessageAt: Number(state.lastUserMessageAt) || undefined,
      inner: inner?.mapped?.proactive,
      random,
    };
  }

  /** 溢出念头 → 出口。返回发出去的那一个动作；都没发出去返回 null（照常走原来的判断）。 */
  async function routeThoughts(at) {
    let done = null;
    const inner = deps.innerState ? await deps.innerState(at).catch(() => null) : null;
    const results = await deps.thoughts.drainOutlets({
      sendMessage: async (candidate) => {
        if (done) return false;
        const facts = await proactiveFacts(at, inner);
        if (!canMessage(facts)) return false;
        const result = await runDecision({ trigger: "thought", force: "message", thought: candidate }, at, inner);
        if (result.action !== "message") return false;
        done = result;
        return true;
      },
      addPost: async (candidate) => {
        if (done) return false;
        const [profile, moments] = await Promise.all([readProfile(), readMoments()]);
        if (!allowedActions(at, profile, moments.posts).includes("post")) return false;
        const result = await runDecision({ trigger: "thought", force: "post", thought: candidate }, at, inner);
        if (result.action !== "post") return false;
        done = result;
        return true;
      },
    });
    if (done) log.info("thought overflowed", { outlet: results.find((item) => item.status === "sent")?.outlet });
    return done;
  }

  async function runTick(input) {
    const at = now();
    const settings = await readSettings();
    if (settings.momentsEnabled === false && !input.force) return { action: "none", detail: "disabled" };
    if (inQuietHours(at) && !input.force) return { action: "none", detail: "quiet" };
    // 念头池溢出（docs/13 第 2.3 节）：主动消息和朋友圈的来由永远是一条具体的念头，不是随机触发。
    // 出口仍受现有节流（深夜、每日上限）；只有真正发出去才释放念头（docs/14 第 1.2 节）。
    if (!input.force && deps.thoughts && settings.thoughtsEnabled !== false) {
      const routed = await routeThoughts(at).catch((error) => {
        log.warn("thought outlet failed", { error: error?.message });
        return null;
      });
      if (routed) return routed;
    }
    const inner = deps.innerState ? await deps.innerState(at).catch(() => null) : null;
    return runDecision(input, at, inner, settings);
  }

  /** 原有的醒来判断（事件 + 概率 + 模型决定）。input.thought 是溢出的念头时，把它当成这次的来由。 */
  async function runDecision(input, at, inner, settingsIn) {
    const settings = settingsIn ?? (await readSettings());
    const [profile, moments] = await Promise.all([readProfile(), readMoments()]);
    const homeCity = settings.city?.trim() || DEFAULT_CITY;
    const city = profile.currentCity?.trim() || homeCity;
    const world = await getWorld(city).catch(() => null);
    const events = [];
    if (input.thought) events.push(`你心里一直挂着这件事，忍不住了：${input.thought.content}`);
    if (input.trigger === "chat") events.push("刚和他聊完天");
    if (input.trigger === "like" || input.trigger === "comment") events.push("他刚在你的朋友圈互动了");
    if (world?.weather && world.previousWeatherKind && world.previousWeatherKind !== weatherKind(world.weather.code)) events.push(`变天了：现在${world.weather.description}`);
    if (inner?.condition?.kind === "cold") events.push("你感冒了，身上难受");
    if (events.length === 0 && !input.force && random() > considerProbability(inner?.mapped?.proactive)) return { action: "none", detail: "idle-skip" };

    const allowed = allowedActions(at, profile, moments.posts);
    const facts = await proactiveFacts(at, inner);
    if (input.force === "message" ? facts.channelReady : canMessage(facts)) allowed.push("message");
    if (input.force) {
      if (input.force !== "message" && !allowed.includes(input.force)) allowed.push(input.force);
      if (!allowed.includes(input.force)) return { action: "none", detail: "channel-not-ready" };
    }
    const decision = await decide({
      now: at,
      settings,
      city,
      homeCity,
      weather: formatWeather(world?.weather),
      news: world?.news ?? [],
      events,
      allowed,
      chatText: input.chatText,
      recentPosts: moments.posts.slice(0, 3),
      signature: profile.signature?.text,
      force: input.force,
      moodHints: inner?.mapped?.hints ?? [],
    });
    if (!decision || decision.action === "none" || !allowed.includes(decision.action)) return { action: "none", detail: decision?.reason ?? "model-none" };
    if (decision.location && decision.location !== profile.currentCity) {
      await updateProfile((draft) => {
        draft.currentCity = decision.location === homeCity ? undefined : decision.location;
      });
    }
    return executeDecision(decision, input.trigger, at, { bridge: deps.bridge });
  }

  async function tick(input = { trigger: "idle" }) {
    if (running) return { action: "none", detail: "busy" };
    if (paused && !input.force) return { action: "none", detail: "paused" };
    running = true;
    try {
      return await runTick(input);
    } finally {
      running = false;
    }
  }

  function scheduleNext() {
    timer = setTimeout(() => {
      void tick({ trigger: "idle" })
        .catch((error) => log.warn("tick failed", { error: error?.message }))
        .finally(() => {
          if (timer) scheduleNext();
        });
    }, randomBetween(MIN_INTERVAL_MS, MAX_INTERVAL_MS));
    timer.unref?.();
  }

  /** 事件唤醒：冷却期内忽略；不会立刻发，像真人一样过一会儿。 */
  async function nudge(reason, chatText) {
    if (reason === "chat") {
      if (Date.now() - lastChatNudgeAt < CHAT_NUDGE_COOLDOWN_MS) return;
      lastChatNudgeAt = Date.now();
    }
    let text = chatText;
    if (reason === "chat" && !text) {
      const messages = (await readConversation(await getMainConversationId())).slice(-CHAT_TEXT_MESSAGES);
      text = messages.map((m) => `${m.role === "user" ? "他" : "我"}：${m.text}`).join("\n");
    }
    setTimeout(() => void tick({ trigger: reason, chatText: text }).catch(() => undefined), randomBetween(NUDGE_DELAY_MIN_MS, NUDGE_DELAY_MAX_MS)).unref?.();
  }

  return {
    tick,
    nudge,
    start() {
      if (timer) return;
      scheduleNext();
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
    },
    pause: () => (paused = true),
    resume: () => (paused = false),
  };
}
