// 写入守卫：过去 / 今天 / 未来各类文件的 write / append / delete 判定，以及网页接口用的判定。
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateMemoryOp, evaluateWebLifeEdit, evaluateWebMemoryEdit, isEditableLifeFile } from "../src/companion/write-guard.js";
import { at } from "./helpers.js";

const now = at(2026, 10, 10, 14, 30); // 2026-10-10 周六，2026-W41
const decide = (file, op) => evaluateMemoryOp({ file, op, now }).allowed;

test("past is read-only for write, append and delete", () => {
  for (const op of ["write", "append", "delete"]) {
    assert.equal(decide("life/day-2026-10-09.md", op), false, `day ${op}`);
    assert.equal(decide("event-2026-10-09.md", op), false, `event ${op}`);
    assert.equal(decide("life/week-2026-W40.md", op), false, `week ${op}`);
    assert.equal(decide("life/month-2026-09.md", op), false, `month ${op}`);
    assert.equal(decide("life/year-2025.md", op), false, `year ${op}`);
  }
});

test("today's schedule is append-only", () => {
  assert.equal(decide("life/day-2026-10-10.md", "append"), true);
  assert.equal(decide("life/day-2026-10-10.md", "write"), false);
  assert.equal(decide("life/day-2026-10-10.md", "delete"), false);
  const reason = evaluateMemoryOp({ file: "life/day-2026-10-10.md", op: "write", now });
  assert.match(reason.reason, /只能在末尾追加/u);
});

test("present, future and ordinary memories can change", () => {
  for (const op of ["write", "append", "delete"]) {
    assert.equal(decide("life/week-2026-W41.md", op), true);
    assert.equal(decide("life/week-2026-W42.md", op), true);
    assert.equal(decide("life/month-2026-10.md", op), true);
    assert.equal(decide("life/year-2026.md", op), true);
    assert.equal(decide("life/future.md", op), true);
    assert.equal(decide("life/day-2026-10-11.md", op), true);
    assert.equal(decide("event-2026-10-10.md", op), true);
    assert.equal(decide("user-sunburn.md", op), true);
    assert.equal(decide("week-summary-2026-W40.md", op), true);
  }
});

test("a dated day- file outside life/ follows the past rule but has no append-only rule today", () => {
  assert.equal(decide("day-2026-10-09.md", "write"), false);
  assert.equal(decide("day-2026-10-10.md", "write"), true);
});

test("web memory edits: 403 reasons for past files", () => {
  const write = evaluateWebMemoryEdit({ file: "event-2026-10-09.md", op: "write", now });
  const remove = evaluateWebMemoryEdit({ file: "event-2026-10-09.md", op: "delete", now });
  assert.equal(write.allowed, false);
  assert.equal(write.reason, "过去的事不能改");
  assert.equal(remove.reason, "过去的事不能删");
  assert.equal(evaluateWebMemoryEdit({ file: "user-job.md", op: "delete", now }).allowed, true);
});

test("web life edits: only future and future.md", () => {
  assert.equal(isEditableLifeFile("future.md", now), true);
  assert.equal(isEditableLifeFile("day-2026-10-10.md", now), false);
  assert.equal(isEditableLifeFile("day-2026-10-11.md", now), true);
  assert.equal(isEditableLifeFile("week-2026-W41.md", now), true);
  assert.equal(isEditableLifeFile("week-2026-W40.md", now), false);
  assert.equal(isEditableLifeFile("month-2026-09.md", now), false);
  assert.equal(isEditableLifeFile("year-2026.md", now), true);
  assert.equal(isEditableLifeFile("random.md", now), false);
  assert.equal(evaluateWebLifeEdit("day-2026-10-09.md", now).allowed, false);
});
