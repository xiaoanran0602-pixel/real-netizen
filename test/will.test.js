// P3：基石进稳定段、防线很薄时的意志提示、写书转折事实、漏一句后的转折。
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { paths } from "../src/config/paths.js";
import { writeJsonAtomic } from "../src/store/files.js";
import { createPromptBuilder } from "../src/companion/context.js";
import { coreSelfText } from "../src/inner/core-self.js";
import { bookFacts, onCuratorEvents } from "../src/inner/hooks.js";
import { readInner } from "../src/inner/store.js";
import { innerPromptProvider } from "../src/inner/state.js";
import { initialInner } from "../src/inner/vitals.js";
import { BOOK_TURNING_FACT, CORE_FRAGMENT_HINT, SEEN_LEAK_HINT, willHints } from "../src/inner/will.js";
import { at, useTempData } from "./helpers.js";

async function seedInner(patch, nowMs) {
  const base = initialInner(nowMs);
  await writeJsonAtomic(paths.inner(), { ...base, ...patch, vitals: { ...base.vitals, ...patch.vitals }, tensions: { ...base.tensions, ...patch.tensions } });
}

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
  const state = { ...initialInner(), tensions: { book: 90, seen: 90 }, lastTurning: {} };
  assert.deepEqual(willHints(state, 60, at(2026, 10, 10, 2), false).hints, []);
  assert.deepEqual(willHints(state, 20, at(2026, 10, 10, 2), true).hints, []);
  const thin = willHints(state, 20, at(2026, 10, 10, 2), false);
  assert.ok(thin.hints.includes(CORE_FRAGMENT_HINT) && thin.hints.includes(SEEN_LEAK_HINT) && thin.leakOffered);
  const recent = willHints({ ...state, lastTurning: { seen: "2026-10-01" } }, 20, at(2026, 10, 10, 2), false);
  assert.ok(!recent.leakOffered, "14 天内不再转折");
});

test("深夜高压：状态小节出现防线很薄与漏一句；聊完用玩笑盖过 → 被看见张力 −40 并记转折", async () => {
  const { cleanup } = await useTempData();
  try {
    const now = at(2026, 10, 10, 1, 30);
    await seedInner({ vitals: { stress: 95, energy: 15 }, tensions: { seen: 85 } }, now.getTime());
    const result = await innerPromptProvider({ now, messages: [{ role: "user", text: "还没睡？" }] });
    assert.ok(result.text.includes(SEEN_LEAK_HINT));
    assert.ok(result.text.includes(CORE_FRAGMENT_HINT));
    const offered = await readInner();
    assert.equal(offered.leakOfferedAt, now.getTime());
    await onCuratorEvents({ coveredWithJoke: true }, new Date(now.getTime() + 60_000));
    const after = await readInner();
    assert.equal(after.lastTurning.seen, "2026-10-10");
    assert.equal(Math.round(after.tensions.seen), 85 + 5 - 40);
    assert.equal(after.leakOfferedAt, 0);
  } finally {
    await cleanup();
  }
});

test("没被允许过漏一句时，玩笑只加张力不算转折", async () => {
  const { cleanup } = await useTempData();
  try {
    const now = at(2026, 10, 10, 15);
    await seedInner({ tensions: { seen: 50 } }, now.getTime());
    await onCuratorEvents({ coveredWithJoke: true }, now);
    const after = await readInner();
    assert.equal(after.lastTurning.seen, undefined);
    assert.equal(Math.round(after.tensions.seen), 55);
  } finally {
    await cleanup();
  }
});

test("写书张力过阈值：日程事实里出现推掉事情去写，14 天内只一次", async () => {
  const { cleanup } = await useTempData();
  try {
    const now = at(2026, 10, 10, 7);
    await seedInner({ tensions: { book: 82 } }, now.getTime());
    assert.deepEqual(await bookFacts(now), [BOOK_TURNING_FACT]);
    assert.equal((await readInner()).lastTurning.book, "2026-10-10");
    assert.deepEqual(await bookFacts(at(2026, 10, 11, 7)), []);
  } finally {
    await cleanup();
  }
});
