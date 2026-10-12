// 记忆强度：清晰度分档、初始稳定度表、间隔效应加固、底色类不沉底、pinned 下限、迁移补默认值、清理。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  annotate,
  clarityOf,
  defaultRecord,
  INITIAL_STABILITY,
  initialStability,
  readStrengthTable,
  recallMemories,
  recordWritten,
  reinforce,
  retention,
  S_MAX,
  setPinned,
  syncStrength,
} from "../src/companion/strength.js";
import { useTempData } from "./helpers.js";

const event = { file: "event-2026-10-01.md", type: "event" };

test("clarity thresholds", () => {
  assert.equal(clarityOf(1), "clear");
  assert.equal(clarityOf(0.5), "clear");
  assert.equal(clarityOf(0.49), "blurry");
  assert.equal(clarityOf(0.15), "blurry");
  assert.equal(clarityOf(0.149), "sunk");
});

test("initial stability table by type × importance; summaries", () => {
  assert.equal(initialStability(event, "normal"), 3);
  assert.equal(initialStability(event, "core"), 365);
  assert.equal(initialStability({ file: "x.md", type: "self_daily" }, "care"), 7);
  assert.equal(initialStability({ file: "x.md", type: "profile" }, "core"), 3650);
  assert.equal(initialStability({ file: "week-summary-2026-W40.md", type: "event" }, "normal"), 30);
  assert.equal(initialStability({ file: "month-summary-2026-09.md", type: "event" }, "normal"), 180);
  assert.equal(INITIAL_STABILITY.recent.care, 20);
});

test("retention decays exponentially: normal event blurs in days", () => {
  const record = { stability: 3, lastRecalled: "2026-10-01" };
  assert.equal(retention(event, record, "2026-10-01"), 1);
  assert.equal(clarityOf(retention(event, record, "2026-10-03")), "clear");
  assert.equal(clarityOf(retention(event, record, "2026-10-05")), "blurry");
  assert.equal(clarityOf(retention(event, record, "2026-10-10")), "sunk");
});

test("live recent / open thread stay clear; expired recent decays from expiry", () => {
  const recent = { file: "r.md", type: "recent", expires: "2026-10-15" };
  const record = { stability: 5, lastRecalled: "2026-10-01" };
  assert.equal(retention(recent, record, "2026-10-14"), 1);
  assert.ok(retention(recent, record, "2026-10-16") > 0.8);
  assert.equal(retention({ file: "t.md", type: "thread", closed: false }, record, "2027-01-01"), 1);
  assert.ok(retention({ file: "t.md", type: "thread", closed: true }, record, "2027-01-01") < 0.15);
});

test("foundation types and pinned never sink", () => {
  const old = { stability: 1, lastRecalled: "2020-01-01" };
  for (const type of ["profile", "preference", "self"]) assert.equal(clarityOf(retention({ file: "x.md", type }, old, "2026-10-10")), "blurry");
  assert.equal(clarityOf(retention(event, { ...old, pinned: true }, "2026-10-10")), "blurry");
  assert.equal(clarityOf(retention(event, old, "2026-10-10")), "sunk");
});

test("spacing effect: recalling near-forgotten adds more; same day counts once", () => {
  const base = { importance: "care", stability: 10, lastRecalled: "2026-10-01", recallDays: [] };
  const soon = reinforce(event, base, "2026-10-02").record.stability;
  const late = reinforce(event, base, "2026-10-30").record.stability;
  assert.ok(late > soon * 1.5, `late ${late} should be much larger than soon ${soon}`);
  const once = reinforce(event, base, "2026-10-30");
  assert.equal(once.record.lastRecalled, "2026-10-30");
  const twice = reinforce(event, once.record, "2026-10-30");
  assert.equal(twice.changed, false);
  assert.equal(twice.record.stability, once.record.stability);
});

test("reinforce caps at S_MAX unless pinned; core grows faster", () => {
  const big = { importance: "care", stability: 3000, lastRecalled: "2020-01-01", recallDays: [] };
  assert.equal(reinforce(event, big, "2026-10-10").record.stability, S_MAX);
  assert.ok(reinforce(event, { ...big, pinned: true }, "2026-10-10").record.stability > S_MAX);
  const care = reinforce(event, { importance: "care", stability: 10, lastRecalled: "2026-10-01", recallDays: [] }, "2026-10-20").record.stability;
  const core = reinforce(event, { importance: "core", stability: 10, lastRecalled: "2026-10-01", recallDays: [] }, "2026-10-20").record.stability;
  assert.ok(core > care);
});

test("migration defaults: foundation=core, others=care; lastRecalled from updated/created", () => {
  assert.equal(defaultRecord({ file: "k.md", type: "profile", created: "2026-10-01" }).importance, "core");
  const rec = defaultRecord({ file: "e.md", type: "event", created: "2026-10-01", updated: "2026-10-05" });
  assert.equal(rec.importance, "care");
  assert.equal(rec.stability, 14);
  assert.equal(rec.lastRecalled, "2026-10-05");
});

test("table: sync fills missing and drops deleted; recall/write/pin persist", async () => {
  const { cleanup } = await useTempData();
  try {
    await recordWritten({ file: "gone.md", type: "event" }, "normal", "2026-10-01");
    await syncStrength([{ file: "a.md", type: "self", created: "2026-10-01" }, { file: "b.md", type: "event", created: "2026-10-01" }]);
    let table = await readStrengthTable();
    assert.deepEqual(Object.keys(table).sort(), ["a.md", "b.md"]);
    await recallMemories([{ file: "b.md", type: "event" }], "2026-10-08");
    table = await readStrengthTable();
    assert.equal(table["b.md"].lastRecalled, "2026-10-08");
    assert.deepEqual(table["b.md"].recallDays, ["2026-10-08"]);
    await setPinned({ file: "b.md", type: "event" }, true);
    table = await readStrengthTable();
    assert.equal(table["b.md"].pinned, true);
    const [annotated] = annotate([{ file: "b.md", type: "event" }], table, "2030-01-01");
    assert.equal(annotated.clarity, "blurry");
    await recordWritten({ file: "c.md", type: "event" }, "core", "2026-10-09");
    assert.equal((await readStrengthTable())["c.md"].stability, 365);
  } finally {
    await cleanup();
  }
});
