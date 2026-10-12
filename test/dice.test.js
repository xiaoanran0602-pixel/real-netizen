// P4：掷骰（生病/加班周/假期）、「她会生病」开关、生病期间想念上限。
import assert from "node:assert/strict";
import { test } from "node:test";
import { updateSettings } from "../src/config/settings.js";
import { conditionFact, diceFacts, forceCondition, rollCondition, startCondition } from "../src/inner/dice.js";
import { lifeFacts } from "../src/inner/hooks.js";
import { readInner } from "../src/inner/store.js";
import { daySlots } from "../src/inner/tags.js";
import { initialInner, missingCap, MISSING_CAP, settle } from "../src/inner/vitals.js";
import { at, useTempData } from "./helpers.js";

const sequence = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test("掷骰：概率命中按顺序开始事件，持续天数在范围内", () => {
  const state = initialInner();
  assert.equal(rollCondition(state, "2026-10-10", { canGetSick: true }, sequence(0.5)), null);
  const cold = rollCondition(state, "2026-10-10", { canGetSick: true }, sequence(0.001, 0.99));
  assert.deepEqual(cold, { kind: "cold", from: "2026-10-10", until: "2026-10-13" });
  const overtime = rollCondition(state, "2026-10-10", { canGetSick: true }, sequence(0.5, 0.01, 0));
  assert.deepEqual(overtime, { kind: "overtime", from: "2026-10-10", until: "2026-10-12" });
});

test("开关关掉不掷；事件生效中不再掷", () => {
  assert.equal(rollCondition(initialInner(), "2026-10-10", { canGetSick: false }, () => 0), null);
  const sick = { ...initialInner(), condition: startCondition("cold", "2026-10-09", () => 0) };
  assert.equal(rollCondition(sick, "2026-10-10", { canGetSick: true }, () => 0), null);
});

test("事实文字带第几天", () => {
  const condition = { kind: "cold", from: "2026-10-09", until: "2026-10-11" };
  assert.match(conditionFact(condition, "2026-10-10"), /感冒.*第 2 天.*3 天.*生病/u);
  assert.equal(conditionFact(condition, "2026-10-12"), null);
});

test("同一天只掷一次；掷中后日程事实里有生病", async () => {
  const { cleanup } = await useTempData();
  try {
    const now = at(2026, 10, 10, 7);
    assert.deepEqual(await diceFacts(now, () => 0.9), []);
    assert.deepEqual(await diceFacts(now, () => 0), [], "今天已经掷过");
    const facts = await diceFacts(at(2026, 10, 11, 7), sequence(0.001, 0));
    assert.equal(facts.length, 1);
    assert.match(facts[0], /生病/u);
    assert.equal((await readInner()).condition.kind, "cold");
    assert.match((await lifeFacts(at(2026, 10, 12, 7))).join("\n"), /感冒/u);
  } finally {
    await cleanup();
  }
});

test("设置关掉「她会生病」后 diceFacts 不再掷", async () => {
  const { cleanup } = await useTempData();
  try {
    await updateSettings({ canGetSick: false });
    assert.deepEqual(await diceFacts(at(2026, 10, 10, 7), () => 0), []);
    assert.equal((await readInner()).condition, null);
  } finally {
    await cleanup();
  }
});

test("强制感冒：生病期间想念上限按设置（默认 85），病好当天回到 70", async () => {
  const { cleanup } = await useTempData();
  try {
    await forceCondition("cold", at(2026, 10, 10, 9));
    const state = await readInner();
    assert.equal(missingCap(state, "2026-10-10", 85), 85);
    assert.equal(missingCap(state, "2026-10-10", 90), 90);
    assert.equal(missingCap(state, state.condition.until, 85), 85);
    assert.equal(missingCap(state, "2026-10-20", 85), MISSING_CAP);
    // 结算：沉默很久，生病中想念涨到 85 封顶；病好后被夹回 70。
    const start = at(2026, 10, 10, 9).getTime();
    const base = { ...state, vitals: { ...state.vitals, missing: 60 }, lastSettledAt: start };
    const slotsFor = () => daySlots(null);
    const sickEnd = settle(base, at(2026, 10, 11, 23).getTime(), { slotsFor, lastUserMessageAt: 0, sickMissCap: 85 }).state;
    assert.equal(Math.round(sickEnd.vitals.missing), 85);
    const after = settle(sickEnd, at(2026, 10, 20, 12).getTime(), { slotsFor, lastUserMessageAt: 0, sickMissCap: 85 }).state;
    assert.equal(Math.round(after.vitals.missing), MISSING_CAP);
  } finally {
    await cleanup();
  }
});
