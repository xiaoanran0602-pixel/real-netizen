// 13 念头池：每小时衰减与溢出、容量挤出（她会真的忘事）、碰撞分组、抽取、注入块、时间承诺。
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOUR_MS } from "../src/util/time.js";
import { advancePool, busyState, collide, seedPool, setBusyUntil, takeAnnounceQuota } from "../src/inner/thought-store.js";
import {
  advanceThoughts,
  applyExtract,
  createThought,
  formatThoughtsSection,
  groupCollide,
  himLoad,
  overflowCandidates,
  releaseThought,
  selectForPrompt,
  THOUGHTS_CAPACITY,
  worthRemembering,
} from "../src/inner/thoughts.js";
import { parsePromise, promiseToBusyUntil, scheduleBoundaryUntil, shouldReplyWhileBusy, stagedCharLimit } from "../src/inner/promises.js";
import { at, useTempData } from "./helpers.js";

const T0 = at(2026, 10, 10, 21, 30).getTime();

function poolWith(list) {
  return { at: T0, thoughts: list.map((item, index) => createThought({ id: `t_${index}`, ...item }, T0)) };
}

test("每小时衰减：open_loop 升高、fade 下降、slow_fade 每天降、spike 第一天快降之后放缓", () => {
  const pool = poolWith([
    { content: "等他回话", source: "him", decay: "open_loop", strength: 50 },
    { content: "一件小事", source: "life", decay: "fade", strength: 50 },
    { content: "他大概不喜欢我这么说", source: "infer", decay: "slow_fade", strength: 50 },
    { content: "他刚才那句话刺到我了", source: "him", decay: "spike", strength: 60 },
  ]);
  const after2h = advanceThoughts(pool, T0, T0 + 2 * HOUR_MS).state.thoughts;
  assert.deepEqual(after2h.map((t) => Math.round(t.strength)), [52, 46, 50, 40]);
  const after2d = advanceThoughts(pool, T0, T0 + 48 * HOUR_MS).state.thoughts;
  assert.deepEqual(after2d.map((t) => `${t.id}:${Math.round(t.strength)}`), ["t_0:95", "t_2:44"]);
});

test("强度到 5 以下就消失；容量 15 挤掉最弱的（她会真的忘事）", () => {
  const weak = poolWith([{ content: "很淡的事", source: "life", strength: 6 }]);
  assert.equal(advanceThoughts(weak, T0, T0 + 2 * HOUR_MS).state.thoughts.length, 0);
  const many = poolWith(Array.from({ length: 17 }, (_, index) => ({ content: `第 ${index} 件事`, source: "life", strength: 40 + index })));
  const { state, evicted } = advanceThoughts(many, T0, T0 + HOUR_MS);
  assert.equal(state.thoughts.length, THOUGHTS_CAPACITY, "挤出到容量上限");
  assert.ok(evicted.length >= 2, "被挤出去的最弱几条");
  assert.ok(!state.thoughts.some((t) => t.id === "t_0"), "最弱的那条先走");
});

test("溢出：够强度的可说念头排出口候选，但入队不减强度；确认发出去才减 30", () => {
  const pool = poolWith([
    { content: "他说下周三复查肝，还没说结果", source: "him", strength: 85 },
    { content: "她不想说的心事", source: "him", strength: 95, speakable: false },
    { content: "今天看到的云", source: "world", strength: 82 },
  ]);
  const candidates = overflowCandidates(pool.thoughts);
  assert.deepEqual(candidates.map((c) => `${c.outlet}:${c.source}`).sort(), ["message:him", "post:world"]);
  assert.equal(pool.thoughts[0].strength, 85, "入队不减");
  const released = releaseThought(pool.thoughts, candidates[0].id);
  assert.equal(released.strength, 55);
  assert.equal(released.candidate, undefined);
  assert.equal(releaseThought(pool.thoughts, candidates[0].id), null, "只释放一次");
  assert.equal(himLoad(pool.thoughts), 55 + 95, "想念是他留下的念头的强度总和（说出来那件已经轻了）");
});

test("碰撞分组：高相关激活 +5、回避命中 +10 且不激活、无关但强度高的进背景集", () => {
  const pool = poolWith([
    { content: "他在问复查结果", source: "him", strength: 60 },
    { content: "不想提的那件事", source: "him", strength: 40, avoid: true },
    { content: "校样第四遍", source: "life", strength: 65 },
    { content: "无关的小事", source: "life", strength: 20 },
  ]);
  const groups = groupCollide(pool.thoughts, { t_0: 0.9, t_1: 0.7, t_2: 0.1, t_3: 0.0 }, T0 + 1000);
  assert.deepEqual(groups.activated.map((t) => t.content), ["他在问复查结果"]);
  assert.equal(groups.activated[0].strength, 65);
  assert.equal(groups.activated[0].activations, 1);
  assert.deepEqual(groups.avoided.map((t) => t.content), ["不想提的那件事"]);
  assert.equal(groups.avoided[0].strength, 50);
  assert.deepEqual(groups.background.map((t) => t.content), ["校样第四遍"]);
});

test("抽取：新念头进去、闭合的减 40 并转 fade、被碰到的加 5", () => {
  const pool = poolWith([
    { content: "等他回音", source: "him", strength: 80, decay: "open_loop", demand: 0.6 },
    { content: "别的事", source: "life", strength: 50 },
  ]);
  const { state, added, closedIds } = applyExtract(
    pool,
    { new: [{ content: "他推荐的那本书，读了三十页", source: "him", speakable: true, closes_on: "她看完", decay: "open_loop", strength: 90 }], closed: ["t_0"], touched: ["t_1"] },
    T0 + 60_000,
  );
  assert.equal(added.length, 1);
  assert.equal(added[0].strength, 70, "初始强度截到 30–70");
  assert.deepEqual(closedIds, ["t_0"]);
  const closed = state.thoughts.find((t) => t.id === "t_0");
  assert.equal(closed.strength, 40);
  assert.equal(closed.decay, "fade");
  assert.equal(closed.affect, undefined, "闭合后退出持续负荷");
  assert.equal(state.thoughts.find((t) => t.id === "t_1").strength, 55);
});

test("挤出去的他留下、且被反复想起的念头，值得写进长期记忆", () => {
  const thoughts = [
    createThought({ id: "a", content: "他答应讲的事", source: "him", strength: 10, activations: 3 }, T0),
    createThought({ id: "b", content: "只想起过一次", source: "him", strength: 10, activations: 1 }, T0),
    createThought({ id: "c", content: "她自己的事", source: "life", strength: 10, activations: 5 }, T0),
  ];
  assert.deepEqual(worthRemembering(thoughts).map((t) => t.id), ["a"]);
});

test("注入块：激活集受注意预算限制、背景至多 1 条、不可说的单独列出且不进激活集", () => {
  const pool = poolWith([
    { content: "相关的一", source: "him", strength: 60 },
    { content: "相关的二", source: "him", strength: 60 },
    { content: "相关的三", source: "him", strength: 60 },
    { content: "背景里那件事", source: "life", strength: 70 },
    { content: "说不出口的", source: "him", strength: 55, speakable: false },
  ]);
  const groups = groupCollide(pool.thoughts, { t_0: 0.9, t_1: 0.8, t_2: 0.7, t_3: 0.1, t_4: 0.9 }, T0);
  const selection = selectForPrompt(groups, { activeBudget: 2 });
  assert.deepEqual(selection.activated.map((t) => t.content), ["相关的一", "相关的二"]);
  assert.deepEqual(selection.background.map((t) => t.content), ["背景里那件事"]);
  const text = formatThoughtsSection(selection);
  assert.match(text, /# 她此刻脑子里的事/u);
  assert.ok(text.indexOf("相关的三") < 0, "超出预算的念头不进提示词");
  assert.match(text, /她不会说出来的/u);
  assert.match(text, /不是待答清单，也不是消息顺序/u);
  assert.match(text, /可以一个也不说/u);
  assert.match(text, /不必交代或在结尾补报/u);
  assert.doesNotMatch(text, /回复从被打断的状态出发，不是从他的问题出发/u);
});

test("池子持久化：advancePool 按小时推进且只推进一次；busy_until 与宣告式结尾计数落盘", async () => {
  const { cleanup } = await useTempData();
  try {
    await seedPool([{ content: "等他回话", source: "him", decay: "open_loop", strength: 50 }], T0);
    const advanced = await advancePool(T0 + 3 * HOUR_MS);
    assert.equal(Math.round(advanced.thoughts[0].strength), 53);
    const again = await advancePool(T0 + 3 * HOUR_MS);
    assert.equal(Math.round(again.thoughts[0].strength), 53, "同一时刻不重复推进");
    await setBusyUntil(T0 + 20 * 60_000);
    assert.deepEqual(await busyState(T0 + 5 * 60_000), { busy: true, remainingMs: 15 * 60_000 });
    assert.deepEqual(await busyState(T0 + 30 * 60_000), { busy: false, remainingMs: 0 });
    assert.equal((await takeAnnounceQuota("2026-10-10")).allowed, true);
    assert.equal((await takeAnnounceQuota("2026-10-10")).allowed, false, "一天一次");
    assert.equal((await takeAnnounceQuota("2026-10-11")).allowed, true);
  } finally {
    await cleanup();
  }
});

test("分类失败或超时：高强度不等于相关，不误激活、不强化、不触发回避", async () => {
  const { cleanup } = await useTempData();
  try {
    await seedPool([
      { id: "related", content: "他写的软件", source: "him", strength: 55 },
      { id: "cooking", content: "锅里的蛋", source: "life", strength: 90 },
      { id: "private", content: "不想提的事", source: "life", strength: 95, avoid: true },
    ], T0);
    for (const classifier of [
      async () => { throw new Error("unavailable"); },
      () => new Promise(() => {}),
    ]) {
      const result = await collide("我写的软件不知道能不能赚钱", { nowMs: T0 + 1000, waitMs: 5, classifier });
      assert.equal(result.degraded, true);
      assert.equal(result.appraisal, undefined);
      assert.deepEqual(result.groups.activated, []);
      assert.deepEqual(result.groups.avoided, []);
      assert.ok(result.groups.background.some((thought) => thought.id === "cooking"), "背景仍保留，不清空她的生活");
      assert.deepEqual(result.pool.thoughts.map((thought) => thought.strength), [55, 90, 95]);
      assert.ok(result.pool.thoughts.every((thought) => thought.activations === 0 && thought.last_touched === new Date(T0).toISOString()));
    }
    const matched = await collide("软件的事", { nowMs: T0 + 1000, classifier: async () => ({ scores: { related: 0.9, cooking: 0.1 }, appraisal: null }) });
    assert.equal(matched.degraded, false);
    assert.deepEqual(matched.groups.activated.map((thought) => thought.id), ["related"]);
    assert.equal(matched.groups.activated[0].strength, 60, "有相关证据时仍正常强化");
  } finally {
    await cleanup();
  }
});

test("时间承诺：分钟数、收尾、睡觉三种说法；带偏差兑现；拿不准不约束", () => {
  assert.deepEqual(parsePromise("还剩二十分钟"), { kind: "minutes", minutes: 20 });
  assert.deepEqual(parsePromise("我还有 15 分钟就下课了"), { kind: "minutes", minutes: 15 });
  assert.deepEqual(parsePromise("再有一个小时就好了"), { kind: "minutes", minutes: 60 });
  assert.deepEqual(parsePromise("我收尾了"), { kind: "wrap-up" });
  assert.deepEqual(parsePromise("我先睡了，晚安"), { kind: "sleep" });
  assert.equal(parsePromise("今天有点累"), null, "拿不准就不约束");
  const now = at(2026, 10, 10, 16, 0);
  const slots = [{ start: 0, tag: "睡觉" }, { start: 7 * 60, tag: "起床" }, { start: 16 * 60 + 30, tag: "上班" }];
  assert.equal(promiseToBusyUntil({ kind: "minutes", minutes: 20 }, { now, slots, random: () => 1 }) - now.getTime(), 40 * 60_000, "偏差最多 2 倍");
  assert.equal(promiseToBusyUntil({ kind: "minutes", minutes: 20 }, { now, slots, random: () => 0 }) - now.getTime(), 14 * 60_000, "偏差最少 0.7 倍");
  assert.equal(promiseToBusyUntil({ kind: "sleep" }, { now, slots, random: () => 0 }) - now.getTime(), ((7 + 24 - 16) * 60) * 60_000, "睡了就到次日起床");
  assert.equal(scheduleBoundaryUntil(slots, now), at(2026, 10, 10, 16, 30).getTime(), "日程硬边界");
});

test("忙时分期回复：剩余越少字数上限越小；>10 分钟不回", () => {
  assert.equal(stagedCharLimit(45 * 60_000), 0, "超过 30 分钟不限");
  assert.equal(stagedCharLimit(20 * 60_000), 60);
  assert.equal(stagedCharLimit(5 * 60_000), 15);
  assert.equal(shouldReplyWhileBusy(30 * 60_000, () => 0), false, "剩余多就进待回队列，不回");
  assert.equal(shouldReplyWhileBusy(5 * 60_000, () => 0.1), true);
  assert.equal(shouldReplyWhileBusy(5 * 60_000, () => 0.9), false);
});
