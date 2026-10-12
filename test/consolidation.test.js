// 定时整理：分界时刻与补做顺序（日→周→月）、补做时的「今天」、失败不推进与跳过记录、写入守卫仍生效（假模型）。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { paths } from "../src/config/paths.js";
import { createChatService } from "../src/chat/chat-service.js";
import { createDailyClock } from "../src/clock/daily.js";
import { consolidateDaily, consolidateWeekly, dayNow } from "../src/companion/consolidation.js";
import { readStrengthTable, updateStrengthTable } from "../src/companion/strength.js";
import { experienceDay, isMonthEnd, isWeekEnd, pendingDays } from "../src/archive/day.js";
import { readState, updateState } from "../src/store/state.js";
import { useFakeModel } from "./fake-model.js";
import { at, useTempData } from "./helpers.js";

const MEMORY = (name, type, date, body) => `---\nname: ${name}\ndescription: "${body}"\nmetadata:\n  type: ${type}\n  created: ${date}\n  updated: ${date}\n---\n${body}\n`;

test("day boundary: 1am belongs to the previous day; pending days in order", () => {
  assert.equal(experienceDay(at(2026, 10, 4, 1), 4), "2026-10-03");
  assert.equal(experienceDay(at(2026, 10, 4, 4), 4), "2026-10-04");
  assert.deepEqual(pendingDays("2026-10-01", at(2026, 10, 5, 5), 4), ["2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.deepEqual(pendingDays("2026-10-04", at(2026, 10, 5, 3), 4), []);
  assert.equal(isWeekEnd("2026-10-04"), true);
  assert.equal(isMonthEnd("2026-10-31"), true);
  assert.equal(dayNow("2026-10-03").getDate(), 3);
});

function fakeService() {
  return createChatService({ complete: async () => "x", buildPrompt: async () => ({ system: "S" }) });
}

test("clock catches up missed days in order: daily → weekly (Sunday) → monthly (month end) → snapshot", async () => {
  const { cleanup } = await useTempData();
  try {
    const calls = [];
    await updateState({ lastSnapshotDay: "2026-09-29", lastConsolidated: { day: "2026-09-29" } });
    const clock = createDailyClock({
      chatService: fakeService(),
      consolidate: { daily: async (d) => calls.push(`daily:${d}`), weekly: async (d) => calls.push(`weekly:${d}`), monthly: async (d) => calls.push(`monthly:${d}`) },
      snapshot: async (d) => calls.push(`snap:${d}`),
      now: () => at(2026, 10, 5, 9),
    });
    const results = await clock.tick();
    assert.deepEqual(results.map((r) => r.day), ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    assert.deepEqual(calls, [
      "daily:2026-09-30", "monthly:2026-09-30", "snap:2026-09-30",
      "daily:2026-10-01", "snap:2026-10-01",
      "daily:2026-10-02", "snap:2026-10-02",
      "daily:2026-10-03", "snap:2026-10-03",
      "daily:2026-10-04", "weekly:2026-10-04", "snap:2026-10-04",
    ]);
    const state = await readState();
    assert.equal(state.lastSnapshotDay, "2026-10-04");
    assert.equal(state.lastConsolidated.day, "2026-10-04");
    assert.equal(state.lastConsolidated.week, "2026-10-04");
    assert.equal(state.lastConsolidated.month, "2026-09-30");
    assert.deepEqual(await clock.tick(), []);
  } finally {
    await cleanup();
  }
});

test("failure: not advanced and retried; given up only after the next boundary, then snapshot anyway", async () => {
  const { cleanup } = await useTempData();
  try {
    let fail = true;
    const snaps = [];
    await updateState({ lastSnapshotDay: "2026-10-02", lastConsolidated: { day: "2026-10-02" } });
    let clockNow = at(2026, 10, 4, 9);
    const clock = createDailyClock({
      chatService: fakeService(),
      consolidate: { daily: async () => { if (fail) throw Object.assign(new Error("x"), { kind: "http" }); }, weekly: async () => {}, monthly: async () => {} },
      snapshot: async (d) => snaps.push(d),
      now: () => clockNow,
    });
    // 10-03 刚结束、还没到下一个分界：失败就停，不存档，等下次。
    let results = await clock.tick();
    assert.deepEqual(results.map((r) => [r.day, r.snapshot]), [["2026-10-03", false]]);
    assert.deepEqual(snaps, []);
    assert.equal((await readState()).lastSnapshotDay, "2026-10-02");
    // 又过了一个分界仍失败：跳过 10-03 的整理、照常存档并记下；10-04 继续等。
    clockNow = at(2026, 10, 5, 9);
    results = await clock.tick();
    assert.deepEqual(results.map((r) => [r.day, r.skipped, r.snapshot]), [["2026-10-03", true, true], ["2026-10-04", false, false]]);
    assert.deepEqual((await readState()).consolidationSkipped, ["2026-10-03"]);
    fail = false;
    results = await clock.tick();
    assert.deepEqual(results.map((r) => [r.day, r.consolidated]), [["2026-10-04", true]]);
    assert.deepEqual(snaps, ["2026-10-03", "2026-10-04"]);
  } finally {
    await cleanup();
  }
});

test("daily consolidation writes gists for newly blurry memories and respects the write guard on 'that day'", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel(() => ({
    text: JSON.stringify({
      gists: { "event-2026-09-20.md": "好像聊过星座" },
      ops: [
        { op: "delete", file: "event-2026-09-20.md" },
        { op: "append", file: "life/day-2026-10-03.md", text: "实际：23:00 [写作] 写了一页" },
        { op: "write", file: "life/day-2026-10-03.md", content: "重写" },
      ],
    }),
  }));
  try {
    await mkdir(paths.life(), { recursive: true });
    await writeFile(join(paths.memory(), "event-2026-09-20.md"), MEMORY("e", "event", "2026-09-20", "聊了仙女座的神话"));
    await writeFile(join(paths.life(), "day-2026-10-03.md"), "08:00 [起床] 起\n");
    await updateStrengthTable((table) => {
      table["event-2026-09-20.md"] = { importance: "care", stability: 14, lastRecalled: "2026-09-20", recallDays: [], pinned: false, gist: "" };
    });
    const result = await consolidateDaily("2026-10-03");
    assert.equal(result.gistsRequested, 1);
    assert.equal((await readStrengthTable())["event-2026-09-20.md"].gist, "好像聊过星座");
    // 过去的 event 删不掉；那一天的日程只能追加，不能重写（以 10-03 为今天）。
    assert.match(await readFile(join(paths.memory(), "event-2026-09-20.md"), "utf8"), /仙女座/u);
    assert.equal(await readFile(join(paths.life(), "day-2026-10-03.md"), "utf8"), "08:00 [起床] 起\n实际：23:00 [写作] 写了一页\n");
    assert.equal(fake.requests[0].body.model, "bg-m");
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("weekly consolidation writes a week summary with summary stability", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel(() => ({ text: JSON.stringify({ ops: [{ op: "write", file: "week-summary-2026-W40.md", content: MEMORY("w", "event", "2026-10-04", "这周聊了猫和星星") }] }) }));
  try {
    await mkdir(paths.memory(), { recursive: true });
    await writeFile(join(paths.memory(), "event-2026-10-02.md"), MEMORY("e", "event", "2026-10-02", "聊了猫"));
    const result = await consolidateWeekly("2026-10-04");
    assert.deepEqual(result.applied.map((op) => op.file), ["week-summary-2026-W40.md"]);
    assert.equal((await readStrengthTable())["week-summary-2026-W40.md"].stability, 30);
    assert.match(fake.requests[0].body.messages[0].content, /event-2026-10-02\.md/u);
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("nothing to do → no model call", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel(() => ({ text: "{}" }));
  try {
    await mkdir(paths.memory(), { recursive: true });
    assert.deepEqual(await consolidateDaily("2026-10-03"), { gistsRequested: 0, batches: 0 });
    assert.deepEqual(await consolidateWeekly("2026-10-04"), { skipped: "nothing-this-week" });
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
    await cleanup();
  }
});
