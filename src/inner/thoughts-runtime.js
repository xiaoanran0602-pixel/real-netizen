// ============================================================
// 念头池的后台运行（docs/13 第 2、4、9 节）。
//   start/stop           每小时推进一次（整点对齐，纯代码，和他在不在无关）；推进后把念头版本告诉身体内核
//   afterReply(reply)    她说完一句：抽取新念头（异步，失败下次补）；解析时间承诺 → busy_until
//   drainOutlets(deps)   动态调度器醒来时调用：溢出的念头交给出口，成功才释放
//   lifeFacts(now)       生成当天日程时的素材（可说的 life/him 念头、昨晚最后一条消息时间、这周的吞吐量）
//   interruptions        日程块里按泊松过程生成细粒度中断：busy_until 往后推，小概率生出一条 life 念头
//   busyState(now)       给 reply-timing：她说过要走、还没到点
// ============================================================

import { readSettings } from "../config/settings.js";
import { getMainConversationId, readConversation } from "../store/conversation.js";
import { createLogger } from "../util/log.js";
import { formatHM, HOUR_MS, MINUTE_MS } from "../util/time.js";
import { kernelThoughts } from "./derive.js";
import { promiseFromReply, promiseToBusyUntil } from "./promises.js";
import { currentSlot } from "./state.js";
import { drainOutlets as drain, rememberEvicted } from "./thought-context.js";
import { advancePool, busyState, extractThoughts, readPool, seedPool, setBusyUntil } from "./thought-store.js";
import { createThought, THOUGHTS_CAPACITY } from "./thoughts.js";

const log = createLogger("thoughts");
const EXTRACT_MESSAGES = 8;
/** 日程块里每小时平均几次中断（泊松强度）。只在忙的时段生效。 */
export const INTERRUPT_PER_HOUR = 0.6;
export const INTERRUPT_PUSH_MIN = [3, 15];
export const INTERRUPT_THOUGHT_PROBABILITY = 0.2;
const BUSY_TAGS = new Set(["上班", "加班", "截止", "开会", "写作", "天文台"]);
const LIFE_FACT_MIN_STRENGTH = 50;
const LIFE_FACT_LIMIT = 4;
const INTERRUPTIONS = Object.freeze(["有人临时过来找她说事", "手上的活出了点小岔子", "被一个电话打断了", "旁边的人问了她一个问题"]);

/**
 * @param {{kernel?: any, classifier?: Function, extractor?: Function, now?: () => number, random?: () => number, setTimer?: Function, clearTimer?: Function}} deps
 */
export function createThoughtsRuntime(deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  let timer = null;
  let paused = false;
  let pending = Promise.resolve();
  let lastInterruptCheck = 0;

  function track(promise) {
    pending = pending.then(() => promise).catch(() => undefined);
    return promise;
  }

  async function notifyKernel(pool) {
    if (!deps.kernel) return;
    const version = pool.at || now();
    await deps.kernel
      .accept({ id: `thoughts:${version}:${pool.thoughts.length}`, type: "thoughts_changed", occurredAt: now(), payload: { version, thoughts: kernelThoughts(pool.thoughts) } })
      .catch(() => undefined);
  }

  async function hourly() {
    if (paused) return;
    const pool = await advancePool(now());
    if (pool.evicted?.length) await rememberEvicted(pool.evicted, new Date(now()));
    await notifyKernel(pool);
    await maybeInterrupt();
  }

  function scheduleNext() {
    const delay = HOUR_MS - (now() % HOUR_MS) + 1000;
    timer = setTimer(() => {
      void track(hourly().catch((error) => log.warn("hourly failed", { error: error?.message }))).finally(() => {
        if (timer) scheduleNext();
      });
    }, delay);
    timer?.unref?.();
  }

  /** 泊松中断（docs/13 第 9.5 节）：只在忙的日程块里；每次都有一件具体的事，大部分永远不会被说出来。 */
  async function maybeInterrupt() {
    const at = now();
    const elapsedHours = lastInterruptCheck ? Math.min(2, (at - lastInterruptCheck) / HOUR_MS) : 1;
    lastInterruptCheck = at;
    const { slot } = await currentSlot(new Date(at));
    if (!BUSY_TAGS.has(slot?.tag)) return null;
    const probability = 1 - Math.exp(-INTERRUPT_PER_HOUR * elapsedHours);
    if (random() >= probability) return null;
    const pushMin = INTERRUPT_PUSH_MIN[0] + random() * (INTERRUPT_PUSH_MIN[1] - INTERRUPT_PUSH_MIN[0]);
    const busy = await busyState(at);
    const base = busy.busy ? at + busy.remainingMs : at;
    await setBusyUntil(base + pushMin * MINUTE_MS);
    if (random() < INTERRUPT_THOUGHT_PROBABILITY) {
      const pool = await readPool();
      const content = INTERRUPTIONS[Math.floor(random() * INTERRUPTIONS.length)];
      if (pool.thoughts.length < THOUGHTS_CAPACITY) {
        await seedPool([...pool.thoughts, createThought({ id: `t_int_${at}`, content: `${formatHM(new Date(at))} ${content}`, source: "life", strength: 40, decay: "fade" }, at)], pool.at || at, { busyUntil: base + pushMin * MINUTE_MS, seq: pool.seq + 1 });
      }
    }
    return { pushMin };
  }

  return {
    start() {
      if (timer) return;
      void track(hourly().catch(() => undefined));
      scheduleNext();
    },
    stop() {
      clearTimer(timer);
      timer = null;
    },
    pause: () => (paused = true),
    resume: () => (paused = false),
    idle: () => pending,
    hourly,
    maybeInterrupt,
    busyState: (atMs = now()) => busyState(atMs),

    /** 她说完一句：解析时间承诺；异步抽取念头（失败下次补）。 */
    async afterReply(reply, { source } = {}) {
      const settings = await readSettings();
      const at = now();
      const { slot, slots } = await currentSlot(new Date(at));
      const promise = promiseFromReply(reply, { slot });
      if (promise) {
        const until = promiseToBusyUntil(promise, { now: new Date(at), slots, random });
        await setBusyUntil(until);
        log.info("promise noted", { kind: promise.kind, inMin: Math.round((until - at) / MINUTE_MS), source });
      }
      if (settings.thoughtsEnabled === false) return;
      await track(
        (async () => {
          const messages = (await readConversation(await getMainConversationId())).slice(-EXTRACT_MESSAGES);
          const conversation = messages.map((message) => `${message.role === "user" ? "他" : "她"}：${message.text}`).join("\n");
          const extractor = deps.extractor ?? extractThoughts;
          const result = await extractor(conversation, { nowMs: at });
          if (result?.evicted?.length) await rememberEvicted(result.evicted, new Date(at));
          await notifyKernel(await readPool());
        })().catch((error) => log.warn("extract failed", { error: error?.message })),
      );
    },

    /** 动态调度器醒来时：溢出的念头交给出口。 */
    drainOutlets: (outlets) => drain(outlets),

    /** 生成当天日程时的素材（docs/13 第 4 节）。 */
    async lifeFacts(nowDate) {
      const settings = await readSettings();
      if (settings.thoughtsEnabled === false) return [];
      const pool = await readPool();
      const facts = [];
      const material = pool.thoughts
        .filter((thought) => thought.speakable && (thought.source === "life" || thought.source === "him") && thought.strength >= LIFE_FACT_MIN_STRENGTH)
        .sort((a, b) => b.strength - a.strength)
        .slice(0, LIFE_FACT_LIMIT);
      if (material.length > 0) facts.push(`她最近心里挂着的事（日程可以从这里取材，不用全写）：${material.map((thought) => thought.content).join("；")}`);
      const messages = await readConversation(await getMainConversationId()).catch(() => []);
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      if (lastUser && nowDate.getTime() - lastUser.at < 36 * HOUR_MS) facts.push(`昨晚他最后一条消息是 ${formatHM(new Date(lastUser.at))} 发的（聊得晚，第二天的作息会受影响）。`);
      return facts;
    },
  };
}
