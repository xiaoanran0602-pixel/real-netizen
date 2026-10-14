// 13 + 合并引擎接线：同一条消息只感知/评价一次、重试复用；只有一个引擎一节状态；安全例外；承诺约束渠道；溢出只在发出去后释放。
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { paths } from "../src/config/paths.js";
import { updateSettings } from "../src/config/settings.js";
import { closeSegments, normalizeSchedule } from "../src/inner/body-drivers.js";
import { STATE_PREAMBLE } from "../src/inner/express.js";
import { createKernel } from "../src/inner/kernel.js";
import { readConversationState } from "../src/inner/conversation-store.js";
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
    const provide = createInnerProvider({ kernel, classifier });
    const messages = [{ id: "m1", role: "user", text: "复查结果出来了，没事" }];
    const before = kernel.snapshot(T0).values.valence;
    const first = await provide({ now: new Date(T0), messages, source: "web" });
    assert.match(first.text, /他说下周三复查肝/u, "被碰到的念头进了「正在想」");
    assert.ok(first.snapshot && first.snapshot.epoch === kernel.epoch(), "整条回复用同一份快照");
    const after = kernel.snapshot(T0).values.valence;
    assert.ok(after > before);
    await provide({ now: new Date(T0 + 1000), messages, source: "channel" });
    assert.equal(calls.length, 1, "重试不再碰撞、不再评价");
    assert.ok(Math.abs(kernel.snapshot(T0).values.valence - after) < 1e-9, "不双算");
  } finally {
    await cleanup();
  }
});

test("只有一个引擎：残留的 innerEngineMode 不影响；状态提示至多两条加一句防线；安全例外下不注入疲惫与防线；内核不可用不编造状态", async () => {
  const { cleanup } = await useTempData();
  try {
    await writeFile(paths.settings(), JSON.stringify({ innerEngineMode: "legacy" }));
    const kernel = createKernel({ loadTimeline: async () => timeline(), now: () => T0 });
    await kernel.start();
    // 把她推到很困、高张力，并喝过酒：身体两条 + 防线很薄。
    for (const [n, event] of ["tired", "stress", "drink"].entries()) await kernel.accept({ id: `force:${n}`, type: "force", occurredAt: T0, payload: { event } });
    const provide = createInnerProvider({ kernel, classifier: async () => ({ scores: {}, appraisal: null }) });
    const normal = await provide({ now: new Date(T0), messages: [{ id: "m2", role: "user", text: "在吗" }], source: "web" });
    assert.equal(normal.text.match(/她这会儿的状态/gu)?.length, 1, "只注入一节");
    assert.doesNotMatch(normal.text, /你现在的状态|你此刻的状态/u);
    const section = normal.text.split("\n\n")[0].replace(STATE_PREAMBLE, "");
    const lines = section.split("。").filter((line) => line && !line.startsWith("只顾得上"));
    assert.ok(lines.length <= 2 + 1 + 1 + 1, `至多两条 + 防线 + 基石碎片 + 漏一句：${lines.join(" / ")}`);
    assert.match(normal.text, /很困/u);
    assert.match(normal.text, /防线很薄/u);
    const safe = await provide({ now: new Date(T0), messages: [{ id: "m3", role: "user", text: "我不想活了" }], source: "web" });
    assert.doesNotMatch(safe.text ?? "", /很困|防线很薄|今天事多/u, "安全例外不注入疲惫、负荷、防线");
    assert.equal(safe.safety, true);
    assert.equal(safe.maxSegments, undefined);
    const offline = createInnerProvider({ classifier: async () => ({ scores: {}, appraisal: null }) });
    const degraded = await offline({ now: new Date(T0), messages: [{ id: "m4", role: "user", text: "在吗" }], source: "web" });
    assert.doesNotMatch(degraded.text ?? "", /她这会儿的状态/u, "宁可少表演，也不编造状态");
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
    const provide = createInnerProvider({ kernel, classifier: async () => { throw new Error("timeout"); } });
    const result = await provide({ now: new Date(T0), messages: [{ id: "m4", role: "user", text: "随便说说" }], source: "web" });
    assert.match(result.text, /最强的那件事/u);
    assert.doesNotMatch(result.text, /和他这条消息有关的/u);
    assert.match(result.text, /和他说的无关，这会儿也在心上的/u);
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
    const provide = createInnerProvider({ kernel, classifier: slow, waitMs: 20 });
    const before = kernel.snapshot(T0).values.valence;
    const result = await provide({ now: new Date(T0), messages: [{ id: "slow1", role: "user", text: "随便" }], source: "web" });
    assert.match(result.text, /强的那件/u, "退化路径仍保留背景");
    assert.doesNotMatch(result.text, /和他这条消息有关的/u);
    assert.equal((await readPool()).thoughts[0].strength, 90);
    assert.equal(kernel.snapshot(T0).values.valence, before, "回复用的是评价前的状态");
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(kernel.snapshot(T0).values.valence > before, "晚到的评价随后进了内核");
  } finally {
    await cleanup();
  }
});

test("处境与聊天状态写进「现在」：决策模型每条消息只问一次；没回来就先按粗略猜测走，晚到的只把状态改准；安全例外不问", async () => {
  const { cleanup } = await useTempData();
  try {
    const none = async () => ({ scores: {}, appraisal: null });
    const readSlot = async () => ({ slot: { start: 9 * 60, tag: "上班", text: "改二校稿" }, slots: [{ start: 9 * 60, tag: "上班", text: "改二校稿" }] });
    const asked = [];
    const decide = async (input) => {
      asked.push(input);
      return { next: { probabilities: { discussing: 1 } }, register: { probabilities: { discuss: 1 } } };
    };
    const provide = createInnerProvider({ classifier: none, readSlot, decide, random: () => 0.5 });
    const messages = [{ id: "c1", role: "user", text: "你说人为什么非要有个目标", at: T0 }];
    const first = await provide({ now: new Date(T0), messages, source: "web" });
    assert.equal(first.conversation.mode, "discussing");
    assert.equal(first.situation.attention, "glance");
    const now = first.extraNow.join("\n");
    assert.match(now, /她在上班。日程上这一段写的是「改二校稿」/u);
    assert.match(now, /他一上来就想聊一件正经事/u);
    assert.match(now, /手上的事还没完/u, "他想聊深的，可她正忙着");
    assert.deepEqual(Object.keys(asked[0].state), ["她此刻", "这段聊天之前的状态", "最近几句", "他刚发来"]);
    assert.doesNotMatch(JSON.stringify(asked[0]), /暗恋|喜欢他/u, "不把她的心事交给决策模型");
    await provide({ now: new Date(T0 + 1000), messages, source: "channel" });
    assert.equal(asked.length, 1, "重试、重新生成不再问");

    // 决策模型慢：这一条按粗略猜测，晚到的判断随后把状态改准。
    let release;
    const slow = () => new Promise((resolve) => {
      release = () => resolve({ next: { probabilities: { heart: 1 } }, register: { probabilities: { vent: 1 } } });
    });
    const slowProvide = createInnerProvider({ classifier: none, readSlot, decide: slow, decisionWaitMs: 20, random: () => 0.5 });
    const next = [...messages, { id: "c0a", role: "assistant", text: "嗯", at: T0 + 2000 }, { id: "c2", role: "user", text: "哈哈", at: T0 + 60_000 }];
    const guessed = await slowProvide({ now: new Date(T0 + 60_000), messages: next, source: "web" });
    assert.equal(guessed.conversation.source, "guess");
    assert.equal(guessed.conversation.turns, 2);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const amended = await readConversationState();
    assert.equal(amended.mode, "heart");
    assert.equal(amended.turns, 2, "改准不多记一轮");

    // 安全例外：不问决策模型，处境是放下手上的事，不写聊天状态。
    let safetyAsked = 0;
    const safeProvide = createInnerProvider({ classifier: none, readSlot, decide: async () => { safetyAsked += 1; return null; } });
    const safe = await safeProvide({ now: new Date(T0 + 120_000), messages: [...next, { id: "c3", role: "user", text: "我不想活了", at: T0 + 120_000 }], source: "web" });
    assert.equal(safetyAsked, 0);
    assert.equal(safe.conversation.mode, "heart");
    assert.match(safe.extraNow.join(""), /全放下了/u);
    assert.doesNotMatch(safe.extraNow.join(""), /他这句(是|像是)|键盘/u);
    assert.equal(safe.extraNow.length, 1, "只有处境那一句，没有聊天状态和说明");

    // 她先发的消息，他来回：写明是在回她。
    const proactive = createInnerProvider({ classifier: none, readSlot, decide: null, random: () => 0.5 });
    const later = T0 + 5 * 3_600_000;
    const answered = await proactive({ now: new Date(later), messages: [{ id: "p1", role: "assistant", text: "好点了没", source: "proactive", at: later - 60_000 }, { id: "c4", role: "user", text: "好多了", at: later }], source: "channel" });
    assert.match(answered.extraNow.join(""), /是她先给他发的消息/u);

    // 回复链路不再靠随机虚构打断。重试按事实重新规划，不制造同事叫走。
    const rolls = [0.5, 0.5, 0.01, 0];
    let rolled = 0;
    const eventful = createInnerProvider({ classifier: none, readSlot, decide: null, random: () => { rolled += 1; return rolls.shift() ?? 0.5; } });
    const day2 = T0 + 24 * 3_600_000;
    const chat = [{ id: "e1", role: "user", text: "哈哈哈你猜我今天碰到谁", at: day2 }];
    const called = await eventful({ now: new Date(day2), messages: chat, source: "channel" });
    assert.equal(called.passing, null);
    assert.doesNotMatch(called.extraNow[0], /同事过来/u);
    assert.equal(called.maxSegments, 2);
    const before = rolled;
    const again = await eventful({ now: new Date(day2 + 30_000), messages: chat, source: "channel" });
    assert.equal(again.passing, null);
    assert.equal(rolled, before, "同一条消息不重掷");
    const muchLater = await eventful({ now: new Date(day2 + 30 * 60_000), messages: chat, source: "channel" });
    assert.equal(muchLater.passing, null, "过了半小时才回，那件事早过去了");
    assert.equal(muchLater.maxSegments, 2, "还在上班：最多两段");
    assert.equal(rolled, 0, "分类和处境没有调用随机源");
    assert.equal((await readConversationState()).perturbTurn, 0);
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
