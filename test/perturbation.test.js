// 这一刻碰巧发生的小事：大多数时候没有；挂在日程标签上；他说心里的事时不安排人把她叫走；安全例外什么都不安排。
import assert from "node:assert/strict";
import { test } from "node:test";
import { AROUND, attentionAfter, CHANCE, FREED, INTERRUPTED, MIN_QUIET_TURNS, ONE_LINE_ONLY, passingLines, rollPerturbation, segmentCap } from "../src/inner/perturbation.js";
import { PLACES } from "../src/inner/situation.js";

/** 依次给出这些数的随机源。 */
const seq = (...values) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
};
/** 可复现的伪随机（统计用）。 */
function lcg(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

test("每件事都挂在认识的地点上；句子是画面，不带语气要求和对举句", () => {
  const spots = new Set([...Object.keys(PLACES), "夜里在家"]);
  const all = [];
  for (const table of [INTERRUPTED, FREED, AROUND]) {
    for (const [spot, lines] of Object.entries(table)) {
      assert.ok(spots.has(spot), `不认识的地点：${spot}`);
      assert.ok(lines.length > 0);
      all.push(...lines);
    }
  }
  assert.doesNotMatch([...all, ONE_LINE_ONLY].join(""), /随意|简短一点|口语|语气|不是[^。]{1,16}[，,](而是|就是|只是|是)/u);
  for (const chance of Object.values(CHANCE)) assert.ok(Object.values(chance).reduce((sum, p) => sum + p, 0) <= 0.25, "大多数时候什么都不发生");
});

test("掷骰：按机会表落到被叫走 / 空下来 / 身边的动静 / 什么都没有", () => {
  const at = (roll) => rollPerturbation({ spot: "上班", attention: "glance", rng: seq(roll, 0) });
  assert.equal(at(0.01).kind, "interrupted");
  assert.equal(at(0.1).kind, "freed");
  assert.equal(at(0.18).kind, "around");
  assert.equal(at(0.5), null);
  assert.equal(rollPerturbation({ spot: "夜里在家", attention: "full", rng: seq(0.01, 0) }).kind, "around", "在家没有人来把她叫走");
  assert.equal(rollPerturbation({ spot: "洗澡", attention: "half", rng: seq(0.01, 0) }), null, "这个地方没有可发生的事就不发生");
});

test("刚发生过就先不再有；安全例外、没有处境都不安排", () => {
  const base = { spot: "上班", attention: "glance", rng: seq(0.01, 0) };
  assert.equal(rollPerturbation({ ...base, quietTurns: MIN_QUIET_TURNS - 1 }), null);
  assert.ok(rollPerturbation({ ...base, quietTurns: MIN_QUIET_TURNS }));
  assert.ok(rollPerturbation({ ...base, quietTurns: Infinity }));
  assert.equal(rollPerturbation({ ...base, safety: true }), null);
  assert.equal(rollPerturbation({ ...base, spot: null }), null);
});

test("他在说心里的事、想被安慰时，不安排人把她叫走（那一格的机会作废，不挪给别的事）", () => {
  for (const tender of [{ mode: "heart" }, { register: "vent" }, { register: "ask_comfort" }]) {
    assert.equal(rollPerturbation({ spot: "上班", attention: "glance", ...tender, rng: seq(0.01, 0) }), null);
    assert.equal(rollPerturbation({ spot: "上班", attention: "glance", ...tender, rng: seq(0.1, 0) }).kind, "freed", "空下来照常可以发生");
  }
});

test("统计：上班时每轮有事发生的比例和机会表对得上，同一处境不是每次一样", () => {
  const rng = lcg(20261013);
  const counts = { interrupted: 0, freed: 0, around: 0, none: 0 };
  const lines = new Set();
  const rounds = 20000;
  for (let i = 0; i < rounds; i += 1) {
    const result = rollPerturbation({ spot: "上班", attention: "glance", rng });
    counts[result?.kind ?? "none"] += 1;
    if (result) lines.add(result.line);
  }
  for (const kind of ["interrupted", "freed", "around"]) assert.ok(Math.abs(counts[kind] / rounds - CHANCE.glance[kind]) < 0.01, `${kind}: ${counts[kind] / rounds}`);
  assert.ok(counts.none / rounds > 0.75);
  assert.ok(lines.size >= 4);
});

test("写进处境的句子、对注意力和段数的影响", () => {
  assert.deepEqual(passingLines(null), []);
  assert.deepEqual(passingLines({ kind: "around", line: "车厢里人很多。" }), ["车厢里人很多。"]);
  assert.deepEqual(passingLines({ kind: "interrupted", line: "快轮到她说话了。" }), ["快轮到她说话了。", ONE_LINE_ONLY]);
  assert.equal(attentionAfter("glance", { kind: "freed" }), "full");
  assert.equal(attentionAfter("glance", { kind: "around" }), "glance");
  assert.equal(attentionAfter("glance", null), "glance");

  assert.equal(segmentCap({ attention: "glance" }), 2, "抽空看的手机：最多两段");
  assert.equal(segmentCap({ attention: "glance", passing: { kind: "freed" } }), null, "空下来就不限");
  assert.equal(segmentCap({ attention: "full", passing: { kind: "interrupted" } }), 1, "被叫走：一段");
  assert.equal(segmentCap({ attention: "full" }), null);
  assert.equal(segmentCap({ attention: "glance", passing: { kind: "interrupted" }, safety: true }), null, "安全例外不限");
});
