// P2：渠道不秒回（docs/12 第 10 节）。开会时段先占位、30 分钟内正式回；睡着时醒来先回且知道几点发的；
// 轻生关键词立即回；待发期间他又说话合并重生成；重启后按原定时间继续。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReplyTiming, HARD_CAP_MIN, HARD_CAP_SICK_MIN, planReply } from "../src/inner/reply-timing.js";
import { daySlots, slotAt } from "../src/inner/tags.js";
import { at, useTempData } from "./helpers.js";

const SCHEDULE = ["07:30 [起床] 起来", "09:00 [上班] 到公司", "14:00 [开会] 评审会", "16:00 [上班] 改稿", "19:00 [空闲] 回家", "23:40 [睡觉] 睡了"].join("\n");
const slots = daySlots(SCHEDULE);
const mid = () => 0.5;

function stateAt(date, extra = {}) {
  return { slot: slotAt(slots, date.getHours() * 60 + date.getMinutes()), slots, mapped: { delayFactor: 1, inner: { missing: 30 } }, condition: null, inner: { vitals: { missing: 30 } }, ...extra };
}

test("开会时段：延迟不超过 30 分钟，超过 10 分钟时 1–5 分钟内先占位", () => {
  for (const r of [0, 0.5, 0.99]) {
    const now = at(2026, 10, 10, 14, 10);
    const plan = planReply({ ...stateAt(now), now, texts: ["在吗"], random: () => r });
    assert.equal(plan.mode, "later");
    assert.ok(plan.delayMs <= HARD_CAP_MIN.very_busy * 60_000);
    if (plan.delayMs > 10 * 60_000) assert.ok(plan.placeholderAtMs >= 60_000 && plan.placeholderAtMs <= 5 * 60_000);
  }
});

test("生病/加班周：硬上限放宽到 45 分钟，但不会更久", () => {
  const now = at(2026, 10, 10, 14, 10);
  const plan = planReply({ ...stateAt(now), now, condition: { kind: "cold" }, mapped: { delayFactor: 3 }, texts: ["在吗"], random: () => 0.99 });
  assert.ok(plan.delayMs <= HARD_CAP_SICK_MIN * 60_000 && plan.delayMs > HARD_CAP_MIN.very_busy * 60_000);
});

test("睡着：等到起床后再回；轻生关键词：立即回；他急了缩短", () => {
  const night = at(2026, 10, 10, 3, 0);
  const asleep = planReply({ ...stateAt(night), now: night, texts: ["睡了吗"], random: () => 0 });
  assert.equal(asleep.mode, "asleep");
  assert.equal(asleep.delayMs, (7 * 60 + 30 - 3 * 60) * 60_000);
  assert.equal(planReply({ ...stateAt(night), now: night, texts: ["我真的不想活了"], random: mid }).mode, "now");
  const busy = at(2026, 10, 10, 14, 10);
  const calm = planReply({ ...stateAt(busy), now: busy, texts: ["在吗"], random: mid });
  const urgent = planReply({ ...stateAt(busy), now: busy, texts: ["在吗", "在吗", "回我"], random: mid });
  assert.ok(urgent.delayMs < calm.delayMs / 2);
});

/** 可控时钟 + 假 chat-service + 假发送。 */
function harness(startAt, stateFor) {
  let clock = startAt.getTime();
  const sent = [];
  const regenerated = [];
  const appended = [];
  const chatService = {
    appendUser: async (text, opts) => appended.push({ text, ...opts }),
    regenerate: async (opts) => {
      regenerated.push(opts);
      return { ok: true, reply: `回复${regenerated.length}`, maxSegments: null };
    },
  };
  const timing = createReplyTiming({
    chatService,
    innerState: async (now) => stateFor(now),
    generatePlaceholder: async () => "在开会，晚点说",
    now: () => new Date(clock),
    random: mid,
    setTimer: () => ({}),
    clearTimer: () => undefined,
  });
  const ctx = { sendReply: async (text, opts) => sent.push({ text, at: clock, ...opts }), chatService };
  return {
    timing,
    ctx,
    sent,
    regenerated,
    appended,
    advance: async (minutes) => {
      clock += minutes * 60_000;
      await timing.tick();
    },
    now: () => clock,
  };
}

test("开会时段完整流程：先占位一次，正式回复在 30 分钟内；等待期间再发合并且不再占位", async () => {
  const { cleanup } = await useTempData();
  try {
    const h = harness(at(2026, 10, 10, 14, 10), (now) => ({ ...stateAt(now), mapped: { delayFactor: 2, inner: { missing: 30 } } }));
    await h.timing.onIncoming({ texts: ["下午有空吗"], at: h.now() }, h.ctx);
    assert.equal(h.appended.length, 1, "他的话立刻记进对话（她看到了）");
    const next = h.timing.next();
    assert.ok(next.placeholderAt && next.dueAt - h.now() <= 30 * 60_000);
    await h.advance((next.placeholderAt - h.now()) / 60_000);
    assert.deepEqual(h.sent.map((s) => s.text), ["在开会，晚点说"]);
    await h.timing.onIncoming({ texts: ["忙完说"], at: h.now() }, h.ctx);
    assert.ok(!h.timing.next().placeholderAt || h.sent.length === 1);
    await h.advance(31);
    assert.deepEqual(h.sent.map((s) => s.text), ["在开会，晚点说", "回复1"], "一个时段只占位一次，合并后只回一次");
    assert.equal(h.timing.next(), null);
  } finally {
    await cleanup();
  }
});

test("睡觉时段：不回不占位；醒来后先回，并在提示里告诉她他几点发的", async () => {
  const { cleanup } = await useTempData();
  try {
    const h = harness(at(2026, 10, 10, 2, 5), (now) => stateAt(now));
    await h.timing.onIncoming({ texts: ["睡不着"], at: h.now() }, h.ctx);
    await h.advance(60);
    assert.equal(h.sent.length, 0);
    await h.advance(6 * 60);
    assert.equal(h.sent.length, 1);
    assert.match(h.regenerated[0].extraNow[0], /02:05 发的/u);
  } finally {
    await cleanup();
  }
});

test("轻生关键词：忽略日程立即回", async () => {
  const { cleanup } = await useTempData();
  try {
    const h = harness(at(2026, 10, 10, 3, 0), (now) => stateAt(now));
    await h.timing.onIncoming({ texts: ["我不想活了"], at: h.now() }, h.ctx);
    assert.equal(h.sent.length, 1);
  } finally {
    await cleanup();
  }
});

test("重启恢复：过期的立即发，没到的按原定时间", async () => {
  const { cleanup } = await useTempData();
  try {
    const h = harness(at(2026, 10, 10, 14, 10), (now) => stateAt(now));
    await h.timing.onIncoming({ texts: ["在吗"], at: h.now() }, h.ctx);
    const due = h.timing.next().dueAt;
    const restarted = harness(new Date(due + 60_000), (now) => stateAt(now));
    assert.equal(await restarted.timing.restore(restarted.ctx), true);
    assert.equal(restarted.sent.at(-1).text, "回复1");
  } finally {
    await cleanup();
  }
});
