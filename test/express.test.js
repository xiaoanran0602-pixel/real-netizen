// 唯一表达出口（merge-inner-engines requirements「表达出口」）：提示条数与层级顺序、档位滞回、安全例外、
// 降级快照、提示词里不出现数字、主动系数各分支、念头注意预算。
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeSegments, normalizeSchedule } from "../src/inner/body-drivers.js";
import { activeBudget, express, formatStateSection, HINTS, STATE_PREAMBLE } from "../src/inner/express.js";
import { GUARD_HINTS } from "../src/inner/mapping.js";
import { initialPsyche } from "../src/inner/psyche.js";
import { at } from "./helpers.js";

const DAY = "2026-10-10";
const AFTERNOON = at(2026, 10, 10, 15).getTime();
const calm = { valence: 8, activation: 25, energy: 80, tension: 10 };

function snap(values = {}, extra = {}) {
  return { status: "ready", at: AFTERNOON, values: { ...calm, ...values }, bands: {}, psyche: initialPsyche({ day: DAY }), segments: [], thoughts: [], ...extra };
}
const him = (strength) => ({ source: "him", strength, closed: false });
const sick = (kind) => ({ ...initialPsyche({ day: DAY }), condition: { kind, from: DAY, until: DAY } });

test("平静时不注入状态小节；回复延迟系数 1、主动放行", () => {
  const e = express(snap());
  assert.deepEqual(e.hints, []);
  assert.equal(e.guardHint, null);
  assert.equal(formatStateSection(e), null);
  assert.equal(e.delayFactor, 1);
  assert.deepEqual(e.proactive, { allowed: true, factor: 1, newTopic: true });
});

test("层级顺序 身体 → 负荷 → 关系 → 自我 → 余韵，至多两条，再加至多一句防线", () => {
  const meal = closeSegments(normalizeSchedule([{ start: 0, tag: "睡觉" }, { start: 8 * 60, tag: "吃饭" }, { start: 9 * 60, tag: "上班" }], { date: DAY, adoptedAt: at(2026, 10, 10).getTime(), version: 1 }));
  // 很饿（08:00 吃饭 → 15:00，90 − 84 = 6）+ 高张力 + 想念 + 低自我 + 余韵：只取身体两条，没有身体时依次往后。
  const all = express(snap({ tension: 80, valence: -40, activation: 80 }, { segments: meal, thoughts: [him(90), him(90)], psyche: { ...sick("cold"), selfWorth: 30 } }));
  assert.deepEqual(all.hints, [HINTS.cold, HINTS.hungry]);
  const noBody = express(snap({ tension: 80, valence: -40 }, { thoughts: [him(90), him(90)], psyche: { ...initialPsyche(), selfWorth: 30 } }));
  assert.deepEqual(noBody.hints, [HINTS.highTension, HINTS.missing]);
  const relation = express(snap({ valence: 30 }, { thoughts: [him(90), him(90)], psyche: { ...initialPsyche(), selfWorth: 80 } }));
  assert.deepEqual(relation.hints, [HINTS.missing, HINTS.highSelf]);
  const afterglow = express(snap({ valence: 30 }));
  assert.deepEqual(afterglow.hints, [HINTS.relaxed], "余韵只在前面都没话说时出现");
  const thin = express(snap({ tension: 80, energy: 20 }, { psyche: { ...initialPsyche(), lastDrinkAt: AFTERNOON - 3600_000 } }));
  assert.equal(thin.hints.length, 2);
  assert.equal(thin.guardHint, GUARD_HINTS.thin);
  const loose = express(snap({ tension: 60, energy: 40 }));
  assert.equal(loose.guard, 100 - 0.8 * 40 - 0.5 * 20);
  assert.equal(loose.guardHint, GUARD_HINTS.loose);
});

test("档位与滞回：很困（<25 进、>30 出）一段、×1.6、不主动；累（<55 进、>60 出）两段、×1.3、不开新话题；高张力（>65 进、<55 出）两段、主动 ×0.5", () => {
  const exhausted = express(snap({ energy: 20 }));
  assert.equal(exhausted.maxSegments, 1);
  assert.ok(Math.abs(exhausted.delayFactor - 1.6) < 1e-9);
  assert.equal(exhausted.proactive.allowed, false);
  assert.equal(exhausted.hints[0], HINTS.exhausted);
  const stillExhausted = express(snap({ energy: 28 }, { bands: exhausted.bands }));
  assert.equal(stillExhausted.maxSegments, 1, "滞回带内保持很困");
  assert.equal(express(snap({ energy: 28 })).maxSegments, 2, "没进过很困时 28 只是累");
  const tired = express(snap({ energy: 50 }));
  assert.equal(tired.maxSegments, 2);
  assert.ok(Math.abs(tired.delayFactor - 1.3) < 1e-9);
  assert.equal(tired.proactive.newTopic, false);
  assert.equal(express(snap({ energy: 58 }, { bands: tired.bands })).maxSegments, 2, "58 仍在累的滞回带里");
  assert.equal(express(snap({ energy: 58 })).maxSegments, null);
  assert.equal(express(snap({ energy: 61 }, { bands: tired.bands })).maxSegments, null, "> 60 退出");
  const tense = express(snap({ tension: 70 }));
  assert.equal(tense.maxSegments, 2);
  assert.equal(tense.proactive.factor, 0.5);
  assert.equal(express(snap({ tension: 60 }, { bands: tense.bands })).proactive.factor, 0.5, "60 仍在高张力的滞回带里");
  assert.equal(express(snap({ tension: 60 })).proactive.factor, 1);
});

test("主动系数：感冒 ×1.5、加班周 ×0.5、高张力 ×0.5、自我感觉 ≤ 35 时 ×0.7；想念不再上调主动，只让回复快一点", () => {
  assert.equal(express(snap({}, { psyche: sick("cold") })).proactive.factor, 1.5);
  assert.equal(express(snap({}, { psyche: sick("overtime") })).proactive.factor, 0.5);
  assert.equal(express(snap({}, { psyche: sick("vacation") })).proactive.factor, 1);
  assert.ok(Math.abs(express(snap({}, { psyche: { ...initialPsyche(), selfWorth: 35 } })).proactive.factor - 0.7) < 1e-9);
  assert.ok(Math.abs(express(snap({ tension: 80 }, { psyche: { ...sick("overtime"), selfWorth: 30 } })).proactive.factor - 0.5 * 0.7 * 0.5) < 1e-9);
  const missing = express(snap({}, { thoughts: [him(90), him(90)] }));
  assert.ok(missing.derived.missing >= 50);
  assert.equal(missing.proactive.factor, 1, "想念不上调主动");
  assert.equal(missing.delayFactor, 0.5);
  const survival = express(snap({ energy: 20 }, { thoughts: [him(90), him(90)] }));
  assert.ok(!survival.hints.includes(HINTS.missing), "很困时想念不参与");
  assert.ok(Math.abs(survival.delayFactor - 1.6) < 1e-9);
});

test("转折后 24 小时内：心里反而有点空；很困或很饿时不提", () => {
  const turned = { ...initialPsyche(), lastTurning: { book: DAY, bookAt: AFTERNOON - 3600_000 } };
  assert.ok(express(snap({}, { psyche: turned })).hints.includes(HINTS.afterTurning));
  assert.ok(!express(snap({ energy: 20 }, { psyche: turned })).hints.includes(HINTS.afterTurning));
  assert.ok(!express(snap({}, { psyche: { ...turned, lastTurning: { bookAt: AFTERNOON - 25 * 3600_000 } } })).hints.includes(HINTS.afterTurning));
});

test("安全例外：去掉疲惫、负荷、防线类提示，不限段数，注意预算 4，立即回复", () => {
  const e = express(snap({ energy: 15, tension: 90 }, { at: at(2026, 10, 10, 1).getTime(), psyche: { ...sick("cold"), lastDrinkAt: at(2026, 10, 10, 0).getTime() } }), { safety: true });
  assert.ok(!e.hints.some((hint) => [HINTS.cold, HINTS.exhausted, HINTS.tired, HINTS.hungry, HINTS.highTension].includes(hint)));
  assert.equal(e.guardHint, null);
  assert.equal(e.maxSegments, null);
  assert.equal(e.activeBudget, 4);
  assert.equal(e.delayFactor, 0);
});

test("内核不可用：降级快照不注入状态小节、预算 2、延迟 1、主动放行", () => {
  for (const snapshot of [null, { status: "unavailable", values: null }, { status: "recovering", values: null }, { ...snap(), status: "checkpoint-failed" }]) {
    const e = express(snapshot);
    assert.equal(e.degraded, true);
    assert.equal(formatStateSection(e), null);
    assert.equal(e.activeBudget, 2);
    assert.equal(e.delayFactor, 1);
    assert.deepEqual(e.proactive, { allowed: true, factor: 1, newTopic: true });
  }
});

test("提示词里不出现任何数字", () => {
  const meal = closeSegments(normalizeSchedule([{ start: 0, tag: "睡觉" }, { start: 8 * 60, tag: "吃饭" }], { date: DAY, adoptedAt: at(2026, 10, 10).getTime(), version: 1 }));
  const cases = [
    snap({ energy: 15, tension: 90, valence: -50, activation: 90 }, { at: at(2026, 10, 10, 1).getTime(), segments: meal, thoughts: [him(95)], psyche: { ...sick("cold"), selfWorth: 20 } }),
    snap({ energy: 50, tension: 70 }, { thoughts: [him(90), him(80)] }),
    snap({ valence: 40 }, { psyche: { ...initialPsyche(), selfWorth: 90, lastTurning: { seenAt: AFTERNOON - 1000 } } }),
  ];
  for (const snapshot of cases) {
    const section = formatStateSection(express(snapshot));
    assert.ok(section && section.startsWith(STATE_PREAMBLE));
    assert.doesNotMatch(section, /你/u, "状态只写她自己，没有第二人称");
    assert.ok(!/\d/u.test(section), section);
  }
});

test("念头注意预算 = clamp(floor(2 + 2E/100 − T/60), 1, 4)", () => {
  assert.equal(activeBudget({ energy: 100, tension: 0 }), 4);
  assert.equal(activeBudget({ energy: 70, tension: 10 }), 3);
  assert.equal(activeBudget({ energy: 10, tension: 90 }), 1);
  assert.equal(activeBudget(null), 2);
  assert.equal(express(snap({ energy: 100, tension: 0 })).activeBudget, 4);
  assert.equal(express(snap({ energy: 10, tension: 90 })).activeBudget, 1);
});
