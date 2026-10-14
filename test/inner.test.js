// 日程标签（docs/12 第 4 节）与合并引擎的接线（merge-inner-engines）：
// 一轮聊天只注入一节状态；念头预算随精力变化；记忆整理事件改变慢层；提示里只有文字没有数字；
// 兼容视图（reply-timing / 动态调度器读的 inner.vitals.*）来自内核快照与派生读数。
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSystemPrompt } from "../src/companion/prompt.js";
import { updateSettings } from "../src/config/settings.js";
import { closeSegments, normalizeSchedule } from "../src/inner/body-drivers.js";
import { createInnerHooks } from "../src/inner/hooks.js";
import { createKernel } from "../src/inner/kernel.js";
import { isSafetyRisk } from "../src/inner/mapping.js";
import { createInnerProvider } from "../src/inner/provider.js";
import { currentInner } from "../src/inner/state.js";
import { daySlots, parseSchedule, slotAt } from "../src/inner/tags.js";
import { seedPool } from "../src/inner/thought-store.js";
import { at, useTempData } from "./helpers.js";

const DAY = ["07:30 [起床] 起来", "08:30 [通勤] 地铁", "09:30 [上班] 改稿", "12:30 [吃饭] 楼下面馆", "13:30 [上班] 开工", "19:00 [吃饭] 晚饭", "20:00 [空闲] 看书", "23:30 [睡觉] 睡了"].join("\n");
const T0 = at(2026, 10, 10, 15, 0).getTime();
const timeline = (thoughts = []) => ({
  segments: closeSegments(normalizeSchedule([{ start: 0, tag: "睡觉" }, { start: 8 * 60, tag: "起床" }, { start: 9 * 60, tag: "上班" }, { start: 23 * 60, tag: "睡觉" }], { date: "2026-10-10", adoptedAt: at(2026, 10, 10).getTime(), version: 1 })),
  world: null,
  city: "上海",
  thoughts,
});

async function kernelAt(clock, thoughts) {
  const kernel = createKernel({ loadTimeline: async () => timeline(thoughts), now: () => clock.now });
  await kernel.start();
  return kernel;
}

const quietClassifier = async (_text, thoughts) => ({ scores: Object.fromEntries(thoughts.map((t) => [t.id, 0.9])), appraisal: null });

test("标签：不认识的忽略、斜杠取第一个认识的、没有任何标签的旧日程按兜底、实际覆盖时段", () => {
  const parsed = parseSchedule("09:00 [开会/加班] 周会\n10:00 [瞎写] 什么\n11:00 没标签");
  assert.deepEqual(parsed.slots.map((s) => s.tag), ["开会", "空闲", "空闲"]);
  const legacy = daySlots("09:00 上班\n18:00 下班");
  assert.equal(slotAt(legacy, 3 * 60).tag, "睡觉");
  assert.equal(slotAt(legacy, 15 * 60).tag, "空闲");
  const actual = daySlots(`${DAY}\n实际：15:20 [开会] 临时被叫去开会`);
  assert.equal(slotAt(actual, 15 * 60 + 30).tag, "开会");
  assert.equal(slotAt(actual, 19 * 60 + 10).tag, "吃饭");
  assert.ok(isSafetyRisk("我真的撑不下去了"));
});

test("一轮聊天只注入一行「她这会儿的状态」；提示里没有数字", async () => {
  const { cleanup } = await useTempData();
  try {
    const clock = { now: T0 };
    const kernel = await kernelAt(clock);
    await kernel.accept({ id: "force:1", type: "force", occurredAt: T0, payload: { event: "stress" } });
    await kernel.accept({ id: "force:2", type: "force", occurredAt: T0, payload: { event: "tired" } });
    const provide = createInnerProvider({ kernel, classifier: quietClassifier });
    const result = await provide({ now: new Date(T0), messages: [{ id: "m1", role: "user", text: "在吗" }], source: "web" });
    assert.equal(result.text.match(/她这会儿的状态/gu)?.length, 1);
    assert.doesNotMatch(result.text, /你现在的状态|你此刻的状态/u);
    assert.equal(result.maxSegments, 1, "很困只回一段");
    const section = result.text.split("\n\n")[0];
    assert.ok(!/\d/u.test(section), section);
    const prompt = buildSystemPrompt({ persona: "人设", settings: { userName: "阿澄" }, now: new Date(T0), life: { recentDays: [] }, memories: [], recentText: "", innerText: result.text });
    assert.ok(prompt.dynamic.includes(section));
    assert.ok(!prompt.stable.includes("她这会儿的状态"));
  } finally {
    await cleanup();
  }
});

test("念头注意预算随精力变化：精力足时「正在想」能放下更多条，困了只剩一条", async () => {
  const { cleanup } = await useTempData();
  try {
    await seedPool(["一", "二", "三", "四"].map((n) => ({ content: `念头${n}`, source: "life", strength: 50 })), T0);
    const clock = { now: T0 };
    const kernel = await kernelAt(clock);
    const countActive = (text) => {
      const block = text.split("和他这条消息有关的：")[1]?.split(/\n(?!- )/u)[0] ?? "";
      return block.split("\n").filter((line) => line.startsWith("- ")).length;
    };
    const fresh = await createInnerProvider({ kernel, classifier: quietClassifier })({ now: new Date(T0), messages: [{ id: "a1", role: "user", text: "随便" }], source: "web" });
    assert.equal(countActive(fresh.text), 3, "精力 70、张力 10：预算 3");
    await kernel.accept({ id: "force:t", type: "force", occurredAt: T0, payload: { event: "tired" } });
    await kernel.accept({ id: "force:s", type: "force", occurredAt: T0, payload: { event: "stress" } });
    const tired = await createInnerProvider({ kernel, classifier: quietClassifier })({ now: new Date(T0), messages: [{ id: "a2", role: "user", text: "随便" }], source: "web" });
    assert.equal(countActive(tired.text), 1, "困了：预算 1");
    const safe = await createInnerProvider({ kernel, classifier: quietClassifier })({ now: new Date(T0), messages: [{ id: "a3", role: "user", text: "我不想活了" }], source: "web" });
    assert.equal(countActive(safe.text), 4, "安全例外放开到 4");
    assert.doesNotMatch(safe.text, /她这会儿的状态/u, "安全例外不注入疲惫与防线");
  } finally {
    await cleanup();
  }
});

test("记忆整理事件改变慢层：夸她 → 自我感觉上升；同一轮重试不双算；没发生任何事不提交", async () => {
  const { cleanup } = await useTempData();
  try {
    const clock = { now: T0 };
    const kernel = await kernelAt(clock);
    const hooks = createInnerHooks({ kernel });
    const before = kernel.snapshot(T0).psyche;
    assert.equal((await hooks.onCuratorEvents({ praisedByHim: true, deflectedIdeal: true, askedAboutHer: true, dismissedByHim: false }, new Date(T0), { runId: "m7" })).result, "accepted");
    assert.equal((await hooks.onCuratorEvents({ praisedByHim: true, deflectedIdeal: true, askedAboutHer: true, dismissedByHim: false }, new Date(T0), { runId: "m7" })).result, "duplicate");
    const after = kernel.snapshot(T0).psyche;
    assert.equal(after.selfWorth, before.selfWorth + 5);
    assert.equal(after.book, before.book + 5);
    assert.equal(after.seen, before.seen - 10);
    assert.equal((await hooks.onCuratorEvents({ praisedByHim: false }, new Date(T0), { runId: "m8" })).result, "skipped");
  } finally {
    await cleanup();
  }
});

test("兼容视图：currentInner 来自内核快照；想念由他的念头派生（他只是很久没说话不会上涨）", async () => {
  const { cleanup } = await useTempData();
  try {
    await updateSettings({ sickMissCap: 85 });
    const clock = { now: T0 };
    const quiet = await kernelAt(clock);
    const idle = await currentInner(new Date(T0 + 3 * 86_400_000), { kernel: quiet });
    assert.equal(idle.inner.vitals.missing, 0, "没有他的念头 → 想念 0");
    const kernel = await kernelAt(clock, [{ id: "t1", source: "him", strength: 60, closed: false }, { id: "t2", source: "him", strength: 60, closed: false }]);
    const current = await currentInner(new Date(T0), { kernel });
    const snap = kernel.snapshot(T0);
    assert.equal(current.inner.vitals.energy, snap.values.energy);
    assert.equal(current.inner.vitals.stress, snap.values.tension, "旧「压力」读的是张力");
    assert.equal(Math.round(current.inner.vitals.missing), 63);
    assert.equal(current.inner.vitals.selfWorth, 55);
    assert.deepEqual(current.inner.tensions, { book: 40, seen: 30 });
    assert.equal(current.mapped.delayFactor, 0.5, "想念高时回他快一点");
    const none = await currentInner(new Date(T0), { kernel: null });
    assert.equal(none.inner, null);
    assert.equal(none.mapped.degraded, true);
  } finally {
    await cleanup();
  }
});
