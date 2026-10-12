// 14 内核运行时：事件去重 / 冲突 / 过期 / epoch、重放不双算、日志损坏、检查点、回档 rebase、心跳、映射。
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { paths } from "../src/config/paths.js";
import { closeSegments, normalizeSchedule } from "../src/inner/body-drivers.js";
import { activeBudget, createHeartbeat, formatBodySection, mapBody } from "../src/inner/heartbeat.js";
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

test("首次启动从旧版迁移 E/T；不把旧「想念」转换成不快", async () => {
  const { cleanup } = await useTempData();
  try {
    await writeFile(paths.inner(), JSON.stringify({ vitals: { energy: 33, stress: 77, missing: 90 } }));
    const kernel = createKernel({ loadTimeline: async () => timeline(), now: () => T0 });
    await kernel.start();
    const values = kernel.snapshot(T0).values;
    assert.equal(Math.round(values.energy), 33);
    assert.equal(Math.round(values.tension), 77);
    assert.equal(values.valence, 8);
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

test("映射：注意预算随精力与张力变；至多两条约束；安全例外去掉一切约束；正常区间不注入", () => {
  assert.equal(activeBudget({ energy: 100, tension: 0 }), 4);
  assert.equal(activeBudget({ energy: 70, tension: 10 }), 3);
  assert.equal(activeBudget({ energy: 10, tension: 90 }), 1);
  const tired = mapBody({ status: "ready", values: { valence: -30, activation: 70, energy: 20, tension: 70 }, bands: { lowEnergy: true, highTension: true, highActivation: true, valence: "subdued" } });
  assert.equal(tired.constraints.length, 2);
  assert.match(tired.constraints[0], /精力少，展开可以慢一点/u, "低精力只降低展开速度，不变成对用户不耐烦");
  assert.match(formatBodySection(tired), /不要说出来/u);
  assert.ok(!/\d/u.test(formatBodySection(tired)), "不注入数值");
  assert.deepEqual(mapBody({ status: "ready", values: { valence: -30, activation: 70, energy: 20, tension: 70 }, bands: { lowEnergy: true } }, { safety: true }).constraints, []);
  const calm = mapBody({ status: "ready", values: { valence: 8, activation: 25, energy: 70, tension: 10 }, bands: { lowEnergy: false, highTension: false, highActivation: false, valence: "neutral" } });
  assert.equal(formatBodySection(calm), null);
  assert.equal(mapBody({ status: "recovering", values: null }).degraded, true);
});
