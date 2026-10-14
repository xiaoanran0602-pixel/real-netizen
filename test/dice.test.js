// P4：掷骰（生病/加班周/假期）、「她会生病」开关、生病时想念的放大。掷骰与强制都以 condition_set 事件进内核。
import assert from "node:assert/strict";
import { test } from "node:test";
import { updateSettings } from "../src/config/settings.js";
import { conditionFact, diceFacts, forceCondition, rollCondition, startCondition } from "../src/inner/dice.js";
import { deriveMissing } from "../src/inner/derive.js";
import { createInnerHooks } from "../src/inner/hooks.js";
import { createKernel } from "../src/inner/kernel.js";
import { initialPsyche } from "../src/inner/psyche.js";
import { at, useTempData } from "./helpers.js";

const sequence = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

async function kernelAt(clock) {
  const kernel = createKernel({ loadTimeline: async () => ({ segments: [], world: null, city: "上海", thoughts: [] }), now: () => clock.now });
  await kernel.start();
  return kernel;
}

test("掷骰：概率命中按顺序开始事件，持续天数在范围内", () => {
  const psyche = initialPsyche();
  assert.equal(rollCondition(psyche, "2026-10-10", { canGetSick: true }, sequence(0.5)), null);
  const cold = rollCondition(psyche, "2026-10-10", { canGetSick: true }, sequence(0.001, 0.99));
  assert.deepEqual(cold, { kind: "cold", from: "2026-10-10", until: "2026-10-13" });
  const overtime = rollCondition(psyche, "2026-10-10", { canGetSick: true }, sequence(0.5, 0.01, 0));
  assert.deepEqual(overtime, { kind: "overtime", from: "2026-10-10", until: "2026-10-12" });
});

test("开关关掉不掷；事件生效中不再掷", () => {
  assert.equal(rollCondition(initialPsyche(), "2026-10-10", { canGetSick: false }, () => 0), null);
  const sick = { ...initialPsyche(), condition: startCondition("cold", "2026-10-09", () => 0) };
  assert.equal(rollCondition(sick, "2026-10-10", { canGetSick: true }, () => 0), null);
});

test("事实文字带第几天", () => {
  const condition = { kind: "cold", from: "2026-10-09", until: "2026-10-11" };
  assert.match(conditionFact(condition, "2026-10-10"), /感冒.*第 2 天.*3 天.*生病/u);
  assert.equal(conditionFact(condition, "2026-10-12"), null);
});

test("同一天只掷一次（dice:<day> 去重）；掷中后日程事实里有生病；写进内核事件日志", async () => {
  const { cleanup } = await useTempData();
  try {
    const clock = { now: at(2026, 10, 10, 7).getTime() };
    const kernel = await kernelAt(clock);
    assert.deepEqual(await diceFacts(kernel, at(2026, 10, 10, 7), () => 0.9), []);
    assert.deepEqual(await diceFacts(kernel, at(2026, 10, 10, 7), () => 0), [], "今天已经掷过");
    assert.equal(kernel.snapshot(clock.now).psyche.diceDay, "2026-10-10");
    assert.equal((await kernel.accept({ id: "dice:2026-10-10", type: "condition_set", occurredAt: clock.now, payload: { diceDay: "2026-10-10" } })).result, "duplicate");
    clock.now = at(2026, 10, 11, 7).getTime();
    const facts = await diceFacts(kernel, at(2026, 10, 11, 7), sequence(0.001, 0));
    assert.equal(facts.length, 1);
    assert.match(facts[0], /生病/u);
    assert.equal(kernel.snapshot(clock.now).psyche.condition.kind, "cold");
    clock.now = at(2026, 10, 12, 7).getTime();
    assert.match((await createInnerHooks({ kernel }).lifeFacts(at(2026, 10, 12, 7))).join("\n"), /感冒/u);
  } finally {
    await cleanup();
  }
});

test("设置关掉「她会生病」后 diceFacts 不再掷", async () => {
  const { cleanup } = await useTempData();
  try {
    await updateSettings({ canGetSick: false });
    const clock = { now: at(2026, 10, 10, 7).getTime() };
    const kernel = await kernelAt(clock);
    assert.deepEqual(await diceFacts(kernel, at(2026, 10, 10, 7), () => 0), []);
    assert.equal(kernel.snapshot(clock.now).psyche.condition, null);
  } finally {
    await cleanup();
  }
});

test("强制感冒走内核；生病期间想念按 sickMissCap/70 放大，病好就恢复；恢复健康也是事件", async () => {
  const { cleanup } = await useTempData();
  try {
    const clock = { now: at(2026, 10, 10, 9).getTime() };
    const kernel = await kernelAt(clock);
    assert.equal((await forceCondition(kernel, "cold", at(2026, 10, 10, 9))).result, "accepted");
    const psyche = kernel.snapshot(clock.now).psyche;
    assert.equal(psyche.condition.kind, "cold");
    const thoughts = [{ source: "him", strength: 60 }];
    const healthy = deriveMissing(thoughts, initialPsyche(), "2026-10-10", 85);
    assert.ok(Math.abs(deriveMissing(thoughts, psyche, "2026-10-10", 85) - healthy * (85 / 70)) < 1e-9);
    assert.ok(Math.abs(deriveMissing(thoughts, psyche, "2026-10-10", 90) - healthy * (90 / 70)) < 1e-9);
    assert.equal(deriveMissing(thoughts, psyche, "2026-10-20", 85), healthy, "病好后不再放大");
    assert.equal((await forceCondition(kernel, null, at(2026, 10, 10, 10))).result, "accepted");
    assert.equal(kernel.snapshot(clock.now).psyche.condition, null);
  } finally {
    await cleanup();
  }
});
