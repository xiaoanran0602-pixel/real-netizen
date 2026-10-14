// 合并引擎的慢层与派生读数（merge-inner-engines requirements「状态与时间尺度」「身体」「想念」「防线」）：
// 日结算与心跳频率、离线补算无关；跨 3 个午夜恰好结算 3 次；写作/喝酒只触发一次；感冒精力不超过 60；
// 派生的想念、饱腹、防线逐条对照 requirements 的数值。
import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceBody } from "../src/inner/body-advance.js";
import { closeSegments, normalizeSchedule } from "../src/inner/body-drivers.js";
import { createBody } from "../src/inner/body.js";
import { deriveFullness, deriveGuard, deriveMissing } from "../src/inner/derive.js";
import { activeCondition, applyPsycheEvents, canTurn, closeDay, enterSegment, initialPsyche, markTurning } from "../src/inner/psyche.js";
import { addDays, HOUR_MS, MINUTE_MS } from "../src/util/time.js";
import { at } from "./helpers.js";

const DAY1 = "2026-10-10";
const START = at(2026, 10, 10, 7, 0).getTime();
const DAY_SLOTS = [
  { start: 0, tag: "睡觉" },
  { start: 8 * 60, tag: "起床" },
  { start: 9 * 60, tag: "上班" },
  { start: 12 * 60, tag: "吃饭" },
  { start: 13 * 60, tag: "上班" },
  { start: 19 * 60, tag: "吃饭" },
  { start: 20 * 60, tag: "写作" },
  { start: 21 * 60, tag: "喝酒" },
  { start: 23 * 60, tag: "睡觉" },
];
const PLAIN_SLOTS = DAY_SLOTS.map((slot) => (slot.tag === "写作" || slot.tag === "喝酒" ? { ...slot, tag: "空闲" } : slot));

/** 四天的时间线：第一天有写作和喝酒，之后三天没有。 */
function timeline(extra = {}) {
  const segments = [];
  for (let i = 0; i < 4; i += 1) {
    const day = addDays(DAY1, i);
    segments.push(...normalizeSchedule(i === 0 ? DAY_SLOTS : PLAIN_SLOTS, { date: day, adoptedAt: new Date(`${day}T00:00:00`).getTime(), version: 1 }));
  }
  return { segments: closeSegments(segments), world: null, city: "上海", thoughts: [], ...extra };
}

function stepped(body, toMs, tl, stepMs) {
  let current = body;
  const reasons = [];
  for (let t = body.at + stepMs; t < toMs; t += stepMs) {
    const result = advanceBody(current, t, tl);
    current = result.body;
    reasons.push(...result.reasons);
  }
  const last = advanceBody(current, toMs, tl);
  return { body: last.body, reasons: [...reasons, ...last.reasons] };
}

const dayCloses = (reasons) => reasons.filter((reason) => reason.kind === "day");

test("日结算与调度频率无关：5 秒心跳、15 秒心跳、一次补算到底，慢层与四维完全一致", () => {
  const tl = timeline({ thoughts: [{ id: "a", source: "him", strength: 70, closed: false }] });
  const body = createBody(START, { energy: 80, tension: 15, psyche: { ...initialPsyche({ day: DAY1 }), seen: 62, selfWorth: 40 } });
  const to = at(2026, 10, 12, 1, 30).getTime();
  const once = advanceBody(body, to, tl);
  const every5 = stepped(body, to, tl, 5_000);
  const every15 = stepped(body, to, tl, 15_000);
  for (const run of [every5, every15]) {
    assert.deepEqual(run.body.psyche, once.body.psyche);
    for (const key of ["valence", "activation", "energy", "tension"]) assert.ok(Math.abs(run.body.values[key] - once.body.values[key]) < 1e-6, key);
    assert.deepEqual(dayCloses(run.reasons).map((r) => r.day), dayCloses(once.reasons).map((r) => r.day));
  }
  assert.deepEqual(dayCloses(once.reasons).map((r) => r.day), ["2026-10-10", "2026-10-11"]);
  assert.equal(once.body.psyche.closedDay, "2026-10-12");
  assert.equal(once.body.psyche.selfWorth, 42, "每天向 55 回归 1 点");
});

test("离线补算跨过 3 个午夜恰好结算 3 次；之后再推进不重复结算；超过 72 小时的粗网格同样停在午夜", () => {
  const tl = timeline();
  const body = createBody(START, { psyche: initialPsyche({ day: DAY1 }) });
  const to = at(2026, 10, 13, 9, 0).getTime();
  const run = advanceBody(body, to, tl);
  assert.deepEqual(dayCloses(run.reasons).map((r) => r.day), ["2026-10-10", "2026-10-11", "2026-10-12"]);
  assert.equal(run.body.psyche.closedDay, "2026-10-13");
  const again = advanceBody(run.body, to + HOUR_MS, tl);
  assert.equal(dayCloses(again.reasons).length, 0, "同一个午夜只结算一次");
  // 写书：第一天写作 −15（40→25），当天是写作日不 +2；之后两天各 +2。
  assert.equal(run.body.psyche.book, 25 + 2 + 2);
  const long = advanceBody(createBody(START, { psyche: initialPsyche({ day: DAY1 }) }), START + 80 * HOUR_MS, tl);
  assert.equal(long.catchupMode, "coarse");
  assert.equal(dayCloses(long.reasons).length, 3, "粗网格也停在午夜");
});

test("「写作」和「喝酒」时段的效果只触发一次（与心跳频率无关）", () => {
  const tl = timeline();
  const body = createBody(at(2026, 10, 10, 19, 50).getTime(), { psyche: initialPsyche({ day: DAY1 }) });
  const to = at(2026, 10, 10, 22, 30).getTime();
  for (const run of [advanceBody(body, to, tl), stepped(body, to, tl, 5_000), stepped(body, to, tl, 15_000)]) {
    assert.equal(run.body.psyche.book, 25, "写书张力 −15 只一次");
    assert.deepEqual(run.body.psyche.writingDays, [DAY1]);
    assert.equal(run.body.psyche.lastDrinkAt, at(2026, 10, 10, 21, 0).getTime(), "喝酒时刻是进入喝酒时段的时刻");
    assert.equal(run.reasons.filter((r) => r.kind === "slot" && r.tag === "写作").length, 1);
  }
  const p = initialPsyche({ day: DAY1 });
  const once = enterSegment(p, { slotId: "x#1#6", tag: "写作" }, START);
  assert.equal(enterSegment(once.psyche, { slotId: "x#1#6", tag: "写作" }, START + 1000).entered, false, "同一个 slotId 不再触发");
});

test("感冒：精力上限 60，清醒时消耗更快", () => {
  const tl = timeline();
  const sick = { ...initialPsyche({ day: DAY1 }), condition: { kind: "cold", from: DAY1, until: "2026-10-12" } };
  const night = createBody(at(2026, 10, 10, 23, 0).getTime(), { energy: 90, psyche: sick });
  const morning = advanceBody(night, at(2026, 10, 11, 8, 0).getTime(), tl).body;
  assert.ok(morning.values.energy <= 60, `energy=${morning.values.energy}`);
  const healthy = advanceBody(createBody(at(2026, 10, 11, 9).getTime(), { energy: 60 }), at(2026, 10, 11, 12).getTime(), tl).body;
  const coldDay = advanceBody(createBody(at(2026, 10, 11, 9).getTime(), { energy: 60, psyche: sick }), at(2026, 10, 11, 12).getTime(), tl).body;
  assert.ok(coldDay.values.energy < healthy.values.energy, "感冒时上班更耗精力");
  assert.equal(activeCondition(sick, "2026-10-13"), null, "过了 until 自动结束");
});

test("日结算规则：自我感觉回归、没写作 +2、想念 ≥ 50 被看见 +3、堵住时溢流 2 点到写书", () => {
  const p = { ...initialPsyche({ day: DAY1 }), selfWorth: 70, book: 40, seen: 59 };
  const { psyche, closed } = closeDay(p, DAY1, 55);
  assert.equal(closed, true);
  assert.equal(psyche.selfWorth, 69);
  // seen 59 + 3 = 62 ≥ 60 且当天没转折 → 溢流：seen 60，book 40 + 2 + 2。
  assert.equal(psyche.seen, 60);
  assert.equal(psyche.book, 44);
  assert.equal(closeDay(psyche, DAY1, 55).closed, false, "同一天不重复");
  const leaked = closeDay({ ...p, seen: 70, lastTurning: { seen: DAY1 } }, DAY1, 0).psyche;
  assert.equal(leaked.seen, 70, "当天漏过就不流");
});

test("事件：夸 +5、轻视 −8、岔开理想 写书 +5、玩笑 被看见 +5、深谈/问起她 −10 且深谈记时刻；窗口内玩笑盖过 → 转折 −40", () => {
  const p = initialPsyche({ day: DAY1 });
  const r = applyPsycheEvents(p, { praisedByHim: true, deflectedIdeal: true, deepTalk: true }, START);
  assert.equal(r.psyche.selfWorth, 60);
  assert.equal(r.psyche.book, 45);
  assert.equal(r.psyche.seen, 20);
  assert.equal(r.psyche.lastDeepTalkAt, START);
  assert.equal(applyPsycheEvents(p, { dismissedByHim: true }, START).psyche.selfWorth, 47);
  const offered = { ...p, seen: 85, leakOfferedAt: START };
  const turned = applyPsycheEvents(offered, { coveredWithJoke: true }, START + HOUR_MS);
  assert.equal(turned.turning, "seen");
  assert.equal(turned.psyche.seen, 85 + 5 - 40);
  assert.equal(turned.psyche.leakOfferedAt, 0);
  assert.equal(turned.psyche.lastTurning.seen, DAY1);
  assert.equal(applyPsycheEvents(offered, { coveredWithJoke: true }, START + 4 * HOUR_MS).turning, null, "窗口 3 小时");
  assert.equal(applyPsycheEvents(p, { coveredWithJoke: true }, START).turning, null, "没被允许过不算转折");
  assert.equal(canTurn(markTurning(p, "book", DAY1, 0, START), "book", "2026-10-20"), false);
  assert.equal(canTurn(markTurning(p, "book", DAY1, 0, START), "book", "2026-10-24"), true, "满 14 天");
});

test("想念：没有他的念头为 0；一条 60 约 39、两条约 63、三条约 78；闭合的不算；生病 × sickMissCap/70，上限 100", () => {
  const p = initialPsyche({ day: DAY1 });
  const him = (strength, extra = {}) => ({ source: "him", strength, ...extra });
  assert.equal(deriveMissing([], p, DAY1), 0);
  assert.equal(deriveMissing([{ source: "life", strength: 90 }], p, DAY1), 0);
  assert.equal(Math.round(deriveMissing([him(60)], p, DAY1)), 39);
  assert.equal(Math.round(deriveMissing([him(60), him(60)], p, DAY1)), 63);
  assert.equal(Math.round(deriveMissing([him(60), him(60), him(60)], p, DAY1)), 78);
  assert.equal(deriveMissing([him(60, { closed: true })], p, DAY1), 0, "闭合（回音了）就不想了");
  const sick = { ...p, condition: { kind: "cold", from: DAY1, until: DAY1 } };
  assert.ok(Math.abs(deriveMissing([him(60)], sick, DAY1, 85) - deriveMissing([him(60)], p, DAY1) * (85 / 70)) < 1e-9);
  assert.equal(deriveMissing([him(95), him(95), him(95), him(95), him(95)], sick, DAY1, 95), 100);
  const overtime = { ...p, condition: { kind: "overtime", from: DAY1, until: DAY1 } };
  assert.equal(deriveMissing([him(60)], overtime, DAY1, 85), deriveMissing([him(60)], p, DAY1), "只有生病放大");
});

test("饱腹：吃饭起点 90，清醒 −12/h、睡着 −3/h，夹在 0–100；找不到吃饭按 60", () => {
  const tl = timeline();
  assert.equal(deriveFullness(tl.segments, at(2026, 10, 10, 12, 0).getTime()), 90);
  assert.equal(deriveFullness(tl.segments, at(2026, 10, 10, 15, 0).getTime()), 90 - 12 * 3);
  // 19:00 吃饭 → 23:00 睡（醒 4 小时）→ 次日 3:00（睡 4 小时）。
  assert.equal(deriveFullness(tl.segments, at(2026, 10, 11, 3, 0).getTime()), 90 - 12 * 4 - 3 * 4);
  assert.equal(deriveFullness(tl.segments, at(2026, 10, 11, 11, 59).getTime()), 0, "夹在 0");
  assert.equal(deriveFullness(tl.segments, at(2026, 10, 10, 7, 0).getTime()), 60, "之前没吃过饭");
  assert.equal(deriveFullness([], START), 60);
});

test("防线：0.8·(T−20) 与 0.5·(60−E) 扣分；0–3 点 −15；喝酒后 3 小时 −15；深谈后 3 小时 −10；夹在 0–100", () => {
  const p = initialPsyche({ day: DAY1 });
  const afternoon = at(2026, 10, 10, 15).getTime();
  assert.equal(deriveGuard({ tension: 20, energy: 60 }, p, afternoon), 100);
  assert.equal(deriveGuard({ tension: 80, energy: 20 }, p, afternoon), 100 - 0.8 * 60 - 0.5 * 40);
  const midnight = at(2026, 10, 10, 0, 30).getTime();
  assert.equal(deriveGuard({ tension: 40, energy: 35 }, p, midnight), 56.5, "加班后的深夜：有点松");
  assert.equal(deriveGuard({ tension: 40, energy: 35 }, { ...p, lastDrinkAt: midnight - HOUR_MS }, midnight), 41.5, "再喝过酒 < 45");
  assert.ok(deriveGuard({ tension: 40, energy: 35 }, { ...p, lastDrinkAt: midnight - HOUR_MS, lastDeepTalkAt: midnight - 30 * MINUTE_MS }, midnight) < 35, "喝酒加深谈后 < 35");
  assert.equal(deriveGuard({ tension: 20, energy: 60 }, { ...p, lastDrinkAt: afternoon - 4 * HOUR_MS }, afternoon), 100, "3 小时后不再扣");
  assert.equal(deriveGuard({ tension: 20, energy: 60 }, { ...p, lastDeepTalkAt: afternoon - HOUR_MS }, afternoon), 90);
  assert.equal(deriveGuard({ tension: 100, energy: 0 }, { ...p, lastDrinkAt: midnight }, midnight), 0);
});
