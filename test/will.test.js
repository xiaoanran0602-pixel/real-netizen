// P3：基石进稳定段、防线很薄时的意志提示、写书转折事实、漏一句后的转折——全部基于合并引擎（读 psyche 与派生防线，写走内核）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { paths } from "../src/config/paths.js";
import { createPromptBuilder } from "../src/companion/context.js";
import { coreSelfText } from "../src/inner/core-self.js";
import { createInnerHooks } from "../src/inner/hooks.js";
import { createKernel } from "../src/inner/kernel.js";
import { createInnerProvider } from "../src/inner/provider.js";
import { initialPsyche } from "../src/inner/psyche.js";
import { BOOK_TURNING_FACT, CORE_FRAGMENT_HINT, SEEN_LEAK_HINT, willHints } from "../src/inner/will.js";
import { at, useTempData } from "./helpers.js";

async function kernelAt(clock) {
  const kernel = createKernel({ loadTimeline: async () => ({ segments: [], world: null, city: "上海", thoughts: [] }), now: () => clock.now });
  await kernel.start();
  return kernel;
}

const force = (kernel, event, ms, n = 0) => kernel.accept({ id: `force:${ms}:${n}`, type: "force", occurredAt: ms, payload: { event } });

test("两条基石都进稳定段", async () => {
  const { cleanup } = await useTempData();
  try {
    await writeFile(paths.core(), "关于他的基石正文", "utf8");
    const build = createPromptBuilder({ memorySelector: null, innerProvider: null });
    const { system } = await build({ now: at(2026, 10, 10, 15), messages: [], source: "web" });
    assert.match(system.stable, /关于他的基石正文/u);
    assert.ok(system.stable.includes(coreSelfText().trim().slice(0, 20)));
    assert.ok(!system.dynamic.includes(coreSelfText().trim().slice(0, 20)));
  } finally {
    await cleanup();
  }
});

test("防线不薄时没有意志提示；安全例外时也没有", () => {
  const psyche = { ...initialPsyche(), book: 90, seen: 90, lastTurning: {} };
  assert.deepEqual(willHints(psyche, 60, at(2026, 10, 10, 2), false).hints, []);
  assert.deepEqual(willHints(psyche, 20, at(2026, 10, 10, 2), true).hints, []);
  const thin = willHints(psyche, 20, at(2026, 10, 10, 2), false);
  assert.ok(thin.hints.includes(CORE_FRAGMENT_HINT) && thin.hints.includes(SEEN_LEAK_HINT) && thin.leakOffered);
  const recent = willHints({ ...psyche, lastTurning: { seen: "2026-10-01" } }, 20, at(2026, 10, 10, 2), false);
  assert.ok(!recent.leakOffered, "14 天内不再转折");
  assert.deepEqual(willHints(null, 20, at(2026, 10, 10, 2), false).hints, [], "内核不可用不给");
});

test("深夜防线很薄：状态小节出现防线很薄与漏一句（提交 leak_offered）；聊完用玩笑盖过 → 被看见张力 −40 并记转折", async () => {
  const { cleanup } = await useTempData();
  try {
    const now = at(2026, 10, 10, 1, 30);
    const clock = { now: now.getTime() };
    const kernel = await kernelAt(clock);
    await force(kernel, "stress", clock.now, 1);
    await force(kernel, "tired", clock.now, 2);
    await force(kernel, "tension:seen", clock.now, 3);
    const provide = createInnerProvider({ kernel, classifier: async () => ({ scores: {}, appraisal: null }) });
    const result = await provide({ now, messages: [{ id: "m1", role: "user", text: "还没睡？" }] });
    assert.ok(result.text.includes(SEEN_LEAK_HINT));
    assert.ok(result.text.includes(CORE_FRAGMENT_HINT));
    assert.ok(result.text.includes("防线很薄"));
    assert.equal(kernel.snapshot(clock.now).psyche.leakOfferedAt, now.getTime());
    clock.now += 60_000;
    const accepted = await createInnerHooks({ kernel }).onCuratorEvents({ coveredWithJoke: true }, new Date(clock.now), { runId: "m1" });
    assert.equal(accepted.turning, "seen");
    const after = kernel.snapshot(clock.now).psyche;
    assert.equal(after.lastTurning.seen, "2026-10-10");
    assert.equal(after.seen, 85 + 5 - 40);
    assert.equal(after.leakOfferedAt, 0);
  } finally {
    await cleanup();
  }
});

test("没被允许过漏一句时，玩笑只加张力不算转折", async () => {
  const { cleanup } = await useTempData();
  try {
    const clock = { now: at(2026, 10, 10, 15).getTime() };
    const kernel = await kernelAt(clock);
    await createInnerHooks({ kernel }).onCuratorEvents({ coveredWithJoke: true }, new Date(clock.now), { runId: "x" });
    const after = kernel.snapshot(clock.now).psyche;
    assert.equal(after.lastTurning.seen, undefined);
    assert.equal(after.seen, 35);
  } finally {
    await cleanup();
  }
});

test("写书张力过阈值：日程事实里出现推掉事情去写，14 天内只一次；同一天第二次生成日程不重复记转折", async () => {
  const { cleanup } = await useTempData();
  try {
    const clock = { now: at(2026, 10, 10, 7).getTime() };
    const kernel = await kernelAt(clock);
    await force(kernel, "tension:book", clock.now);
    const hooks = createInnerHooks({ kernel });
    assert.deepEqual(await hooks.bookFacts(at(2026, 10, 10, 7)), [BOOK_TURNING_FACT]);
    assert.equal(kernel.snapshot(clock.now).psyche.lastTurning.book, "2026-10-10");
    const seq = kernel.snapshot(clock.now).seq;
    assert.deepEqual(await hooks.bookFacts(at(2026, 10, 10, 7)), [], "转折已记过，张力还在但 14 天内不再转");
    assert.equal(kernel.snapshot(clock.now).seq, seq, "没有新事件");
    clock.now = at(2026, 10, 11, 7).getTime();
    assert.deepEqual(await hooks.bookFacts(at(2026, 10, 11, 7)), []);
  } finally {
    await cleanup();
  }
});
