// 13 + 14 接线：同一条消息只感知/评价一次、重试复用；模式互斥；安全例外；承诺约束渠道回复；溢出只在发出去后释放。
import assert from "node:assert/strict";
import { test } from "node:test";
import { updateSettings } from "../src/config/settings.js";
import { closeSegments, normalizeSchedule } from "../src/inner/body-drivers.js";
import { createKernel } from "../src/inner/kernel.js";
import { createInnerProvider } from "../src/inner/provider.js";
import { createReplyTiming, truncateChars } from "../src/inner/reply-timing.js";
import { drainOutlets } from "../src/inner/thought-context.js";
import { readPool, seedPool } from "../src/inner/thought-store.js";
import { createThoughtsRuntime } from "../src/inner/thoughts-runtime.js";
import { parsePromise } from "../src/inner/promises.js";
import { daySlots, slotAt } from "../src/inner/tags.js";
import { at, useTempData } from "./helpers.js";

const T0 = at(2026, 10, 10, 15, 0).getTime();
const timeline = () => ({ segments: closeSegments(normalizeSchedule([{ start: 0, tag: "睡觉" }, { start: 8 * 60, tag: "起床" }, { start: 9 * 60, tag: "上班" }, { start: 23 * 60, tag: "睡觉" }], { date: "2026-10-10", adoptedAt: at(2026, 10, 10).getTime(), version: 1 })), world: null, city: "上海", thoughts: [] });
const legacy = async () => ({ text: "# 你现在的状态\n旧版的一句", maxSegments: undefined });

function countingClassifier(appraisal) {
  const calls = [];
  const classifier = async (text, thoughts) => {
    calls.push(text);
    return { scores: Object.fromEntries(thoughts.map((t) => [t.id, t.content.includes("复查") ? 0.9 : 0.1])), appraisal };
  };
  return { classifier, calls };
}

test("同一条消息只碰撞、只评价一次；重试与重新生成复用；评价进内核且不双算", async () => {
  const { cleanup } = await useTempData();
  try {
    await seedPool([{ content: "他说下周三复查肝，还没说结果", source: "him", strength: 60 }], T0);
    const kernel = createKernel({ loadTimeline: async () => timeline(), now: () => T0 });
    await kernel.start();
    const { classifier, calls } = countingClassifier({ valence: 0.8, activation: 0.3, tension: -0.4, importance: 0.7, confidence: 0.9, surprise: 0.2 });
    const provide = createInnerProvider({ kernel, legacy, classifier });
    const messages = [{ id: "m1", role: "user", text: "复查结果出来了，没事" }];
    const before = kernel.snapshot(T0).values.valence;
    const first = await provide({ now: new Date(T0), messages, source: "web" });
    assert.match(first.text, /他说下周三复查肝/u, "被碰到的念头进了「正在想」");
    assert.match(first.text, /旧版的一句/u, "shadow 模式下旧版仍控制");
    const after = kernel.snapshot(T0).values.valence;
    assert.ok(after > before);
    await provide({ now: new Date(T0 + 1000), messages, source: "channel" });
    assert.equal(calls.length, 1, "重试不再碰撞、不再评价");
    assert.ok(Math.abs(kernel.snapshot(T0).values.valence - after) < 1e-9, "不双算");
  } finally {
    await cleanup();
  }
});

test("body 模式：旧版状态小节不再注入；表达约束至多两条；安全例外下不注入约束", async () => {
  const { cleanup } = await useTempData();
  try {
    await updateSettings({ innerEngineMode: "body" });
    const kernel = createKernel({ loadTimeline: async () => timeline(), now: () => T0 });
    await kernel.start();
    // 把她推到低精力高张力，档位应进入低精力 + 高张力。
    await kernel.accept({ id: "x", type: "chat_appraisal", occurredAt: T0, payload: { valence: -1, activation: 1, tension: 1, importance: 1, confidence: 1, surprise: 1 } });
    const provide = createInnerProvider({ kernel, legacy, classifier: async () => ({ scores: {}, appraisal: null }) });
    const normal = await provide({ now: new Date(T0), messages: [{ id: "m2", role: "user", text: "在吗" }], source: "web" });
    assert.ok(!/旧版的一句/u.test(normal.text ?? ""), "body 模式不再注入旧版状态");
    const safe = await provide({ now: new Date(T0), messages: [{ id: "m3", role: "user", text: "我不想活了" }], source: "web" });
    assert.ok(!/不要说出来/u.test(safe.text ?? ""), "安全例外不注入任何状态约束");
    assert.equal(safe.safety, true);
  } finally {
    await cleanup();
  }
});

test("分类器失败：不编造情绪事件，高强度念头只留在背景", async () => {
  const { cleanup } = await useTempData();
  try {
    await seedPool([{ content: "最强的那件事", source: "life", strength: 90 }, { content: "很弱的事", source: "life", strength: 10 }], T0);
    const kernel = createKernel({ loadTimeline: async () => timeline(), now: () => T0 });
    await kernel.start();
    const before = kernel.snapshot(T0).values;
    const provide = createInnerProvider({ kernel, legacy, classifier: async () => { throw new Error("timeout"); } });
    const result = await provide({ now: new Date(T0), messages: [{ id: "m4", role: "user", text: "随便说说" }], source: "web" });
    assert.match(result.text, /最强的那件事/u);
    assert.doesNotMatch(result.text, /正在想（和他这条消息有关）/u);
    assert.match(result.text, /同时占着心的/u);
    assert.deepEqual((await readPool()).thoughts.map((thought) => thought.strength), [90, 10]);
    assert.deepEqual(kernel.snapshot(T0).values, before, "没有评价就不改状态");
  } finally {
    await cleanup();
  }
});

test("溢出：只有出口确认成功才释放；失败保持强度；同一念头不重复入队", async () => {
  const { cleanup } = await useTempData();
  try {
    await seedPool([{ id: "a", content: "他说要给我讲城隍第三章，一直没讲", source: "him", strength: 85 }], T0);
    const failed = await drainOutlets({ sendMessage: async () => false });
    assert.deepEqual(failed.map((r) => r.status), ["skipped"]);
    let pool = await readPool();
    assert.equal(pool.thoughts[0].strength, 85, "没发出去不释放");
    const sent = [];
    const ok = await drainOutlets({ sendMessage: async (candidate) => (sent.push(candidate.content), true) });
    assert.deepEqual(ok.map((r) => r.status), ["sent"]);
    pool = await readPool();
    assert.equal(pool.thoughts[0].strength, 55, "说出来就轻了（只减一次）");
    assert.equal((await drainOutlets({ sendMessage: async () => true })).length, 0, "降到阈值以下后不再入队");
    assert.deepEqual(sent, ["他说要给我讲城隍第三章，一直没讲"]);
  } finally {
    await cleanup();
  }
});

test("承诺即约束：她说「还剩二十分钟」后，渠道消息不回、等她忙完再回来接那一句", async () => {
  const { cleanup } = await useTempData();
  try {
    const now = at(2026, 10, 10, 15, 0);
    const runtime = createThoughtsRuntime({ now: () => now.getTime(), random: () => 0.5, extractor: async () => ({}) });
    await updateSettings({ thoughtsEnabled: true });
    await runtime.afterReply("还剩二十分钟，我先把这堂课上完", { source: "channel" });
    const busy = await runtime.busyState(now.getTime() + 60_000);
    assert.equal(busy.busy, true);
    const slots = daySlots("09:00 [上班] 上班\n18:00 [空闲] 回家\n23:30 [睡觉] 睡");
    const regenerated = [];
    const timing = createReplyTiming({
      chatService: { appendUser: async () => undefined, regenerate: async (opts) => (regenerated.push(opts), { ok: true, reply: "好了，你刚才问的那个：其实我觉得挺好" }) },
      innerState: async (date) => ({ slot: slotAt(slots, date.getHours() * 60 + date.getMinutes()), slots, mapped: { delayFactor: 1 }, condition: null, inner: { vitals: {} } }),
      generatePlaceholder: async () => "在忙",
      busyState: runtime.busyState,
      now: () => new Date(now.getTime() + 60_000),
      random: () => 0.9,
      setTimer: () => ({}),
      clearTimer: () => undefined,
    });
    const sent = [];
    await timing.onIncoming({ texts: ["在吗"], at: now.getTime() + 60_000 }, { sendReply: async (text) => sent.push(text) });
    assert.equal(sent.length, 0, "说走了就真的消失：不回、不占位");
    const due = timing.next().dueAt;
    assert.ok(due >= now.getTime() + 60_000 + busy.remainingMs - 60_000, "等到她说的时间之后");
    assert.equal(timing.next().placeholderAt, null);
  } finally {
    await cleanup();
  }
});

test("字数硬上限：输出后再截断兜底，尽量停在标点", () => {
  assert.equal(truncateChars("马上就好，你等我一下，我还在收尾", 15), "马上就好，你等我一下，");
  assert.equal(truncateChars("好", 15), "好");
});

test("分类超过 800ms 预算：不伪造相关性；晚到的评价仍按同一 id 进内核", async () => {
  const { cleanup } = await useTempData();
  try {
    await seedPool([{ content: "强的那件", source: "life", strength: 90 }], T0);
    const clock = { now: T0 };
    const kernel = createKernel({ loadTimeline: async () => timeline(), now: () => clock.now });
    await kernel.start();
    let release;
    const slow = () => new Promise((resolve) => {
      release = () => resolve({ scores: {}, appraisal: { valence: 1, activation: 0, tension: 0, importance: 1, confidence: 1, surprise: 0 } });
    });
    const provide = createInnerProvider({ kernel, legacy, classifier: slow, waitMs: 20 });
    const before = kernel.snapshot(T0).values.valence;
    const result = await provide({ now: new Date(T0), messages: [{ id: "slow1", role: "user", text: "随便" }], source: "web" });
    assert.match(result.text, /强的那件/u, "退化路径仍保留背景");
    assert.doesNotMatch(result.text, /正在想（和他这条消息有关）/u);
    assert.equal((await readPool()).thoughts[0].strength, 90);
    assert.equal(kernel.snapshot(T0).values.valence, before, "回复用的是评价前的状态");
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(kernel.snapshot(T0).values.valence > before, "晚到的评价随后进了内核");
  } finally {
    await cleanup();
  }
});

test("时间承诺只认她说自己的事、只看结尾：劝他「车里就别睡了」不算她要睡", () => {
  assert.equal(parsePromise("开过去一个多小时，回来别太晚。累的话，车里就别睡了。你那背还在掉皮吧，别晒。"), null);
  assert.equal(parsePromise("你也早点休息，我还有二十分钟这堂课才完\n\n回头说"), null, "时间在倒数第二段，结尾不是承诺");
  assert.deepEqual(parsePromise("今天累死了，我先睡了"), { kind: "sleep" });
  assert.deepEqual(parsePromise("好啦。晚安"), { kind: "sleep" });
  assert.deepEqual(parsePromise("别急，我还剩二十分钟"), { kind: "minutes", minutes: 20 });
});
