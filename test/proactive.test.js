// P4：主动消息判断接入唯一表达出口与生病状态（docs/12 第 5、9 节；merge-inner-engines）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeJsonAtomic } from "../src/store/files.js";
import { paths } from "../src/config/paths.js";
import { writeChannelSecrets } from "../src/config/secrets.js";
import { forceCondition } from "../src/inner/dice.js";
import { express } from "../src/inner/express.js";
import { createKernel } from "../src/inner/kernel.js";
import { initialPsyche } from "../src/inner/psyche.js";
import { currentInner } from "../src/inner/state.js";
import { canMessage, considerProbability, createMomentsScheduler, IDLE_CONSIDER_PROBABILITY } from "../src/moments/scheduler.js";
import { useFakeModel } from "./fake-model.js";
import { at, useTempData } from "./helpers.js";

const base = { now: at(2026, 10, 10, 15), channelReady: true, perDay: 2, proactiveToday: 0 };

test("对照表：很困时不主动；压力大时按系数概率放行；平时放行", () => {
  assert.equal(canMessage({ ...base, inner: { allowed: false, factor: 1 } }), false);
  assert.equal(canMessage({ ...base, inner: { allowed: true, factor: 0.5 }, random: () => 0.9 }), false);
  assert.equal(canMessage({ ...base, inner: { allowed: true, factor: 0.5 }, random: () => 0.1 }), true);
  assert.equal(canMessage({ ...base, inner: { allowed: true, factor: 1 } }), true);
});

test("生病：主动系数上调、醒来想一想的概率上调；加班周下调；想念不再上调", () => {
  const now = at(2026, 10, 10, 15).getTime();
  const snap = (psyche, thoughts = []) => ({ status: "ready", at: now, values: { valence: 8, activation: 25, energy: 80, tension: 10 }, bands: {}, psyche, segments: [], thoughts });
  const cold = express(snap({ ...initialPsyche(), condition: { kind: "cold", from: "2026-10-10", until: "2026-10-11" } }));
  const overtime = express(snap({ ...initialPsyche(), condition: { kind: "overtime", from: "2026-10-10", until: "2026-10-11" } }));
  assert.ok(cold.proactive.factor > 1);
  assert.ok(cold.hints.some((hint) => hint.includes("感冒")));
  assert.ok(considerProbability(cold.proactive) > IDLE_CONSIDER_PROBABILITY);
  assert.ok(overtime.proactive.factor < 1);
  assert.equal(considerProbability(overtime.proactive), IDLE_CONSIDER_PROBABILITY, "下调只在 canMessage 里扣一次");
  const missing = express(snap(initialPsyche(), [{ source: "him", strength: 90 }, { source: "him", strength: 90 }]));
  assert.equal(considerProbability(missing.proactive), IDLE_CONSIDER_PROBABILITY, "主动的来由只有念头溢出");
});

test("强制感冒后醒来：决定提示里有「感冒了、身上难受」，模型选主动找他时经 bot 发出", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel(() => ({ text: '{"action":"message","text":"嗓子疼死了","reason":"难受"}' }));
  try {
    const now = at(2026, 10, 10, 15);
    await writeChannelSecrets({ webhook: { enabled: true, secret: "s3cret", outboundUrl: "http://127.0.0.1/hook", ownerId: "o" } });
    await writeJsonAtomic(paths.world(), { fetchedAt: Date.now(), city: "上海", news: [] });
    const kernel = createKernel({ loadTimeline: async () => ({ segments: [], world: null, city: "上海", thoughts: [] }), now: () => now.getTime() });
    await kernel.start();
    await forceCondition(kernel, "cold", now);
    const sent = [];
    const bridge = { sendProactive: async (text) => (sent.push(text), true) };
    const scheduler = createMomentsScheduler({ bridge, innerState: (when) => currentInner(when, { kernel }), now: () => now, random: () => 0 });
    const result = await scheduler.tick({ trigger: "idle" });
    assert.equal(result.action, "message");
    assert.deepEqual(sent, ["嗓子疼死了"]);
    const prompt = fake.requests[0].body.messages.at(-1).content;
    const text = typeof prompt === "string" ? prompt : prompt.map((part) => part.text).join("");
    assert.match(text, /你感冒了，身上难受/u);
    assert.match(text, /感冒了，身上没什么力气/u);
  } finally {
    await fake.close();
    await cleanup();
  }
});
