// 14 内核运行时：事件去重 / 冲突 / 过期 / epoch、重放不双算、日志损坏、检查点、回档 rebase、心跳；
// 合并引擎：v1 → v2 迁移、旧 vitals 迁移、备份只写一次、慢层事件去重、重启重放恢复 psyche。
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { paths } from "../src/config/paths.js";
import { closeSegments, normalizeSchedule } from "../src/inner/body-drivers.js";
import { createHeartbeat } from "../src/inner/heartbeat.js";
import { createKernel, parseKernelLog, validateEvent } from "../src/inner/kernel.js";
import { at, useTempData } from "./helpers.js";

const T0 = at(2026, 10, 10, 15, 0).getTime();
const DAY = "2026-10-10";
const timeline = () => ({
  segments: closeSegments(normalizeSchedule([{ start: 0, tag: "睡觉" }, { start: 8 * 60, tag: "起床" }, { start: 9 * 60, tag: "上班" }, { start: 23 * 60, tag: "睡觉" }], { date: DAY, adoptedAt: at(2026, 10, 10).getTime(), version: 1 })),
  world: null,
  city: "上海",
  thoughts: [],
});
const appraisal = (extra = {}) => ({ valence: 1, activation: 0.6, tension: -0.5, importance: 0.8, confidence: 0.9, surprise: 0.5, ...extra });

async function kernelAt(clock) {
  const kernel = createKernel({ loadTimeline: async () => timeline(), now: () => clock.now });
  await kernel.start();
  return kernel;
}

test("事件校验：未知类型、缺 id、非法数值都拒绝；不靠夹取把非法输出洗成有效情绪", () => {
  assert.equal(validateEvent({ id: "x", type: "nope", occurredAt: 1, payload: {} }), "unknown-type");
  assert.equal(validateEvent({ type: "chat_appraisal", occurredAt: 1, payload: appraisal() }), "no-id");
  assert.equal(validateEvent({ id: "x", type: "chat_appraisal", occurredAt: 1, payload: appraisal({ valence: 2 }) }), "bad-valence");
  assert.equal(validateEvent({ id: "x", type: "chat_appraisal", occurredAt: 1, payload: appraisal({ importance: "0.8" }) }), "bad-importance");
  assert.equal(validateEvent({ id: "x", type: "chat_appraisal", occurredAt: 1, payload: appraisal({ activation: Number.NaN }) }), "bad-activation");
  assert.equal(validateEvent({ id: "x", type: "chat_appraisal", occurredAt: 1, payload: null }), null, "明确的 null 评价是合法的零冲击");
});

test("同一 ID：相同载荷是幂等重放，不同载荷冲突并保留首次结果；重试不双算", async () => {
  const { cleanup } = await useTempData();
  try {
    const clock = { now: T0 };
    const kernel = await kernelAt(clock);
    const before = kernel.snapshot(T0).values.valence;
    const event = { id: "chat:m1:appraisal-v1", type: "chat_appraisal", occurredAt: T0, payload: appraisal() };
    assert.equal((await kernel.accept(event)).result, "accepted");
    const after = kernel.snapshot(T0).values.valence;
    assert.ok(after > before);
    assert.equal((await kernel.accept(event)).result, "duplicate");
    assert.equal((await kernel.accept({ ...event, payload: appraisal({ valence: -1 }) })).result, "conflict");
    assert.equal(kernel.snapshot(T0).values.valence, after, "重复与冲突都不再施加");
  } finally {
    await cleanup();
  }
});

test("旧 epoch 的晚到结果丢弃；超过 7 天的事件拒收；晚到 30 分钟以上只补记、不制造尖峰", async () => {
  const { cleanup } = await useTempData();
  try {
    const clock = { now: T0 };
    const kernel = await kernelAt(clock);
    assert.equal((await kernel.accept({ id: "a", type: "chat_appraisal", epoch: 99, occurredAt: T0, payload: appraisal() })).result, "stale");
    assert.equal((await kernel.accept({ id: "b", type: "chat_appraisal", occurredAt: T0 - 8 * 86_400_000, payload: appraisal() })).result, "stale");
    const before = kernel.snapshot(T0).values.valence;
    const late = await kernel.accept({ id: "c", type: "chat_appraisal", occurredAt: T0, payload: { ...appraisal(), perceivedAt: T0 - 40 * 60_000 } });
    assert.equal(late.result, "accepted");
    assert.equal(late.applied, null);
    assert.equal(late.reason, "late");
    assert.equal(kernel.snapshot(T0).values.valence, before);
  } finally {
    await cleanup();
  }
});

test("冲击后重启：已提交事件重放一次，状态不归零、不双算", async () => {
  const { cleanup } = await useTempData();
  try {
    const clock = { now: T0 };
    const first = await kernelAt(clock);
    // 事件前的检查点留一份，下面用它模拟「日志已写、检查点没写」。
    const beforeEvent = await readFile(paths.inner(), "utf8");
    await first.accept({ id: "chat:m1:appraisal-v1", type: "chat_appraisal", occurredAt: T0, payload: appraisal() });
    const live = first.snapshot(T0 + 60_000).values;
    await writeFile(paths.inner(), beforeEvent);
    clock.now = T0 + 60_000;
    const second = await kernelAt(clock);
    const replayed = second.snapshot(T0 + 60_000).values;
    for (const key of ["valence", "activation", "tension"]) assert.ok(Math.abs(replayed[key] - live[key]) < 1e-6, `${key}: ${replayed[key]} vs ${live[key]}`);
    clock.now = T0 + 120_000;
    const third = await kernelAt(clock);
    assert.ok(Math.abs(third.snapshot(T0 + 120_000).values.valence - second.snapshot(T0 + 120_000).values.valence) < 1e-6, "再启动不会第二次施加");
  } finally {
    await cleanup();
  }
});

test("日志尾行损坏按规则忽略；中段损坏显式报错停用，不悄悄恢复初始人格", async () => {
  assert.deepEqual(parseKernelLog('{"a":1}\n{"b":2}\n{"c":'), [{ a: 1 }, { b: 2 }]);
  assert.throws(() => parseKernelLog('{"a":1}\n{bad\n{"c":3}\n'), /corrupted/u);
  const { cleanup } = await useTempData();
  try {
    await writeFile(paths.kernelLog(), '{"recordType":"kernel_event","seq":1}\n{bad\n{"recordType":"kernel_event","seq":2}\n');
    const kernel = createKernel({ loadTimeline: async () => timeline(), now: () => T0 });
    assert.equal((await kernel.start()).status, "unavailable");
    assert.equal((await kernel.accept({ id: "x", type: "chat_appraisal", occurredAt: T0, payload: appraisal() })).result, "unavailable");
  } finally {
    await cleanup();
  }
});

test("迁移①：旧 inner.json 只有 vitals → 迁精力与张力、搬慢层、不把旧想念转成不快；备份只写一次", async () => {
  const { cleanup } = await useTempData();
  try {
    const legacy = { vitals: { energy: 33, stress: 77, missing: 90, fullness: 10, selfWorth: 40 }, tensions: { book: 70, seen: 65 }, condition: { kind: "cold", from: DAY, until: "2026-10-12" }, lastTurning: { seen: "2026-10-01" }, diceDay: DAY, lastDrinkAt: T0 - 3600_000, leakOfferedAt: T0 - 60_000, writingDays: ["2026-10-09"] };
    await writeFile(paths.inner(), JSON.stringify(legacy));
    const kernel = createKernel({ loadTimeline: async () => timeline(), now: () => T0 });
    assert.equal((await kernel.start()).migrated, "legacy");
    const snap = kernel.snapshot(T0);
    assert.equal(Math.round(snap.values.energy), 33);
    assert.equal(Math.round(snap.values.tension), 77);
    assert.equal(snap.values.valence, 8, "旧想念不转换成不快");
    assert.deepEqual(
      { selfWorth: snap.psyche.selfWorth, book: snap.psyche.book, seen: snap.psyche.seen, condition: snap.psyche.condition, lastTurning: snap.psyche.lastTurning, diceDay: snap.psyche.diceDay, lastDrinkAt: snap.psyche.lastDrinkAt, leakOfferedAt: snap.psyche.leakOfferedAt, writingDays: snap.psyche.writingDays },
      { selfWorth: 40, book: 70, seen: 65, condition: legacy.condition, lastTurning: legacy.lastTurning, diceDay: DAY, lastDrinkAt: legacy.lastDrinkAt, leakOfferedAt: legacy.leakOfferedAt, writingDays: legacy.writingDays },
    );
    assert.equal(snap.psyche.closedDay, DAY, "不把过去的天重新结算");
    assert.equal(snap.psyche.lastSlotId, `${DAY}#1#2`, "当前段的效果不重复触发");
    assert.deepEqual(JSON.parse(await readFile(paths.innerLegacyBackup(), "utf8")), legacy);
    const saved = JSON.parse(await readFile(paths.inner(), "utf8"));
    assert.equal(saved.body.schemaVersion, 2);
    assert.ok(saved.vitals, "旧顶层字段保留给人眼对照");
    const backupAt = (await stat(paths.innerLegacyBackup())).mtimeMs;
    await writeFile(paths.innerLegacyBackup(), JSON.stringify({ marker: true }));
    const again = createKernel({ loadTimeline: async () => timeline(), now: () => T0 + 60_000 });
    assert.equal((await again.start()).migrated, "none", "再次启动不再迁移");
    assert.deepEqual(JSON.parse(await readFile(paths.innerLegacyBackup(), "utf8")), { marker: true }, "也不再改动备份");
    assert.ok(backupAt > 0);
  } finally {
    await cleanup();
  }
});

test("迁移②：v1 body + 旧顶层字段 → v2，四维/dedup/epoch/seq 原样保留；迁移③：已是 v2 原样；未知版本停用", async () => {
  const { cleanup } = await useTempData();
  try {
    const v1 = { schemaVersion: 1, paramsVersion: "body-v1", at: T0, epoch: 4, lastEventSeq: 7, dedup: [{ id: "chat:old", hash: "h", acceptedAt: T0 }], values: { valence: 12, activation: 30, energy: 44, tension: 22 }, impulseWindow: [], inputVersions: { schedule: 1, weather: 0, thoughts: 0 }, bands: { lowEnergy: false }, segment: null };
    await writeFile(paths.inner(), JSON.stringify({ vitals: { energy: 99, stress: 99, selfWorth: 30 }, tensions: { book: 81, seen: 20 }, body: v1 }));
    const kernel = createKernel({ loadTimeline: async () => timeline(), now: () => T0 });
    assert.equal((await kernel.start()).migrated, "v1");
    const snap = kernel.snapshot(T0);
    assert.deepEqual(snap.values, v1.values, "四维用影子期一直在算的，不用旧 vitals");
    assert.equal(snap.epoch, 4);
    assert.equal(snap.seq, 7);
    assert.equal(snap.psyche.selfWorth, 30);
    assert.equal(snap.psyche.book, 81);
    assert.equal((await kernel.accept({ id: "chat:old", type: "chat_appraisal", occurredAt: T0, payload: null })).result, "conflict", "dedup 保留");
    assert.ok(JSON.parse(await readFile(paths.innerLegacyBackup(), "utf8")).body, "备份是原文件");

    const saved = JSON.parse(await readFile(paths.inner(), "utf8"));
    assert.equal(saved.body.paramsVersion, "body-v2");
    const v2 = createKernel({ loadTimeline: async () => timeline(), now: () => T0 });
    assert.equal((await v2.start()).migrated, "none");
    assert.equal(v2.snapshot(T0).psyche.book, 81);

    await writeFile(paths.inner(), JSON.stringify({ body: { ...saved.body, paramsVersion: "body-v9" } }));
    const unknown = createKernel({ loadTimeline: async () => timeline(), now: () => T0 });
    assert.equal((await unknown.start()).status, "unavailable", "不认识的版本仍然停用，防止写坏");
  } finally {
    await cleanup();
  }
});

test("慢层事件：校验形状；同一天重复掷骰 duplicate；记忆整理、转折、漏一句、强制都写进日志并能去重", async () => {
  assert.equal(validateEvent({ id: "p", type: "psyche_events", occurredAt: 1, payload: { praisedByHim: "yes" } }), "bad-praisedByHim");
  assert.equal(validateEvent({ id: "p", type: "psyche_events", occurredAt: 1, payload: { hacked: true } }), "unknown-hacked");
  assert.equal(validateEvent({ id: "d", type: "condition_set", occurredAt: 1, payload: { condition: { kind: "flu", from: DAY, until: DAY } } }), "bad-condition");
  assert.equal(validateEvent({ id: "d", type: "condition_set", occurredAt: 1, payload: { condition: null } }), null, "null 表示恢复健康");
  assert.equal(validateEvent({ id: "t", type: "turning", occurredAt: 1, payload: { will: "seen", day: DAY } }), "bad-will");
  assert.equal(validateEvent({ id: "l", type: "leak_offered", occurredAt: 1, payload: {} }), "bad-leak");
  assert.equal(validateEvent({ id: "f", type: "force", occurredAt: 1, payload: { event: "rm -rf" } }), "bad-force");
  const { cleanup } = await useTempData();
  try {
    const kernel = await kernelAt({ now: T0 });
    const dice = { id: `dice:${DAY}`, type: "condition_set", occurredAt: T0, payload: { condition: { kind: "cold", from: DAY, until: "2026-10-12" }, diceDay: DAY } };
    assert.equal((await kernel.accept(dice)).result, "accepted");
    assert.equal((await kernel.accept(dice)).result, "duplicate", "同一天第二次生成日程");
    assert.equal(kernel.snapshot(T0).psyche.condition.kind, "cold");
    assert.equal((await kernel.accept({ id: "psyche:run1", type: "psyche_events", occurredAt: T0, payload: { praisedByHim: true } })).result, "accepted");
    assert.equal((await kernel.accept({ id: "psyche:run1", type: "psyche_events", occurredAt: T0, payload: { praisedByHim: true } })).result, "duplicate");
    assert.equal(kernel.snapshot(T0).psyche.selfWorth, 60, "只加一次");
    assert.equal((await kernel.accept({ id: "force:1", type: "force", occurredAt: T0, payload: { event: "tension:book" } })).result, "accepted");
    assert.equal((await kernel.accept({ id: `turning:book:${DAY}`, type: "turning", occurredAt: T0, payload: { will: "book", day: DAY } })).result, "accepted");
    assert.equal((await kernel.accept({ id: `turning:book:${DAY}`, type: "turning", occurredAt: T0, payload: { will: "book", day: DAY } })).result, "duplicate");
    assert.equal(kernel.snapshot(T0).psyche.lastTurning.book, DAY);
    assert.equal((await kernel.accept({ id: "leak:m1", type: "leak_offered", occurredAt: T0, payload: { at: T0 } })).result, "accepted");
    const rows = parseKernelLog(await readFile(paths.kernelLog(), "utf8")).filter((row) => row.recordType === "kernel_event");
    assert.deepEqual(rows.map((row) => row.type), ["condition_set", "psyche_events", "force", "turning", "leak_offered"]);
  } finally {
    await cleanup();
  }
});

test("重启后重放恢复慢层：检查点丢了，日志里的事件把 psyche 恢复到同一处，不双算", async () => {
  const { cleanup } = await useTempData();
  try {
    const clock = { now: T0 };
    const first = await kernelAt(clock);
    const beforeEvents = await readFile(paths.inner(), "utf8");
    await first.accept({ id: "psyche:a", type: "psyche_events", occurredAt: T0, payload: { praisedByHim: true, deepTalk: true } });
    await first.accept({ id: `dice:${DAY}`, type: "condition_set", occurredAt: T0, payload: { condition: { kind: "overtime", from: DAY, until: "2026-10-12" }, diceDay: DAY } });
    await first.accept({ id: "leak:m9", type: "leak_offered", occurredAt: T0, payload: { at: T0 } });
    const live = first.snapshot(T0 + 60_000).psyche;
    await writeFile(paths.inner(), beforeEvents);
    clock.now = T0 + 60_000;
    const second = await kernelAt(clock);
    assert.deepEqual(second.snapshot(T0 + 60_000).psyche, live);
    clock.now = T0 + 120_000;
    const third = await kernelAt(clock);
    assert.equal(third.snapshot(T0 + 120_000).psyche.selfWorth, 60, "再启动不第二次施加");
  } finally {
    await cleanup();
  }
});

test("project：只读投影返回 body 副本，带慢层与推算用的输入；不改权威状态", async () => {
  const { cleanup } = await useTempData();
  try {
    const kernel = await kernelAt({ now: T0 });
    const before = kernel.snapshot(T0);
    const projected = kernel.project(T0 + 50 * 3600_000);
    assert.equal(projected.at, T0 + 50 * 3600_000);
    assert.equal(projected.psyche.closedDay, "2026-10-12", "投影跨过两个午夜");
    assert.ok(Array.isArray(projected.segments) && Array.isArray(projected.thoughts));
    projected.psyche.book = 0;
    assert.deepEqual(kernel.snapshot(T0).psyche, before.psyche, "改副本不影响内核");
    assert.ok(Array.isArray(before.segments) && Array.isArray(before.thoughts) && before.psyche);
  } finally {
    await cleanup();
  }
});

test("回档 rebase：epoch 递增，旧世界的晚到结果因 epoch 不符被丢弃", async () => {
  const { cleanup } = await useTempData();
  try {
    const clock = { now: T0 };
    const kernel = await kernelAt(clock);
    const oldEpoch = kernel.epoch();
    const { epoch } = await kernel.rebase();
    assert.equal(epoch, oldEpoch + 1);
    assert.equal((await kernel.accept({ id: "late", type: "chat_appraisal", epoch: oldEpoch, occurredAt: T0, payload: appraisal() })).result, "stale");
    assert.equal(kernel.snapshot(T0).psyche.closedDay, DAY, "回档后 closedDay 设为今天");
  } finally {
    await cleanup();
  }
});

test("回档到只有旧格式的 inner.json：走迁移流程", async () => {
  const { cleanup } = await useTempData();
  try {
    const kernel = await kernelAt({ now: T0 });
    await writeFile(paths.inner(), JSON.stringify({ vitals: { energy: 20, stress: 60 }, tensions: { book: 77, seen: 11 } }));
    await kernel.rebase();
    const snap = kernel.snapshot(T0);
    assert.equal(snap.status, "ready");
    assert.equal(Math.round(snap.values.energy), 20);
    assert.equal(snap.psyche.book, 77);
    assert.ok(JSON.parse(await readFile(paths.innerLegacyBackup(), "utf8")).vitals);
  } finally {
    await cleanup();
  }
});

test("读快照不改权威状态：每秒读与完全不读，最终一致", async () => {
  const { cleanup } = await useTempData();
  try {
    const clockA = { now: T0 };
    const a = await kernelAt(clockA);
    for (let i = 1; i <= 60; i += 1) a.snapshot(T0 + i * 1000);
    clockA.now = T0 + 60 * 60_000;
    await a.tick();
    const aValues = a.snapshot(clockA.now).values;
    const { cleanup: cleanupB } = await useTempData();
    try {
      const clockB = { now: T0 };
      const b = await kernelAt(clockB);
      clockB.now = T0 + 60 * 60_000;
      await b.tick();
      const bValues = b.snapshot(clockB.now).values;
      for (const key of Object.keys(aValues)) assert.ok(Math.abs(aValues[key] - bValues[key]) < 1e-9, key);
    } finally {
      await cleanupB();
    }
  } finally {
    await cleanup();
  }
});

test("心跳：只做推进；一次异常不终止；停止后不再跳", async () => {
  const timers = [];
  let ticks = 0;
  let fail = true;
  const kernel = {
    tick: async () => {
      ticks += 1;
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
    },
    refreshTimeline: async () => undefined,
  };
  const heartbeat = createHeartbeat({ kernel, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => undefined, intervalMs: 5000 });
  heartbeat.start();
  await timers.shift()();
  await timers.shift()();
  assert.equal(ticks, 2, "异常后继续跳");
  heartbeat.stop();
  assert.equal(heartbeat.running(), false);
});
