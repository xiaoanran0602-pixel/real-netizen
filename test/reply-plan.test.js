import assert from "node:assert/strict";
import { test } from "node:test";
import { planReply, replyPlanText, replyViolations, generatePlannedReply, reviewPlannedReply } from "../src/companion/reply-plan.js";

const at = new Date(2026, 9, 14, 8, 25).getTime();
const msg = (role, text, i = 0) => ({ role, text, at: at + i * 60_000 });
const plan = (text, extra = {}) => planReply({ messages: [msg("user", text)], now: at, ...extra });

test("招呼、收尾不因空闲或想念扩张，重复输入计划完全相同", () => {
  for (const text of ["早，", "早", "嗯", "哈哈", "晚安", "今天不想聊了，我睡了"]) {
    const input = { situation: { attention: "full" }, expressed: { activeBudget: 4, derived: { missing: 99 } } };
    const p = plan(text, input);
    assert.equal(p.maxSegments, 1, text);
    assert.equal(p.followup, "none", text);
    assert.ok(p.targetChars <= 60);
    assert.deepEqual(p, plan(text, input));
  }
});

test("截图：报好转不是求医，不自动转到通勤；双问之后先让出话轮", () => {
  const messages = [msg("user", "早，", -2), msg("assistant", "早。\n\n刚起床。\n\n你感冒好点没？今天头还疼吗。", -1), msg("user", "昨天吃完布洛芬就不疼了，应该是好了，是呢，天气凉了，不好起床了")];
  const p = planReply({ messages, now: at, situation: { attention: "half" } });
  assert.equal(p.maxSegments, 1);
  assert.equal(p.followup, "none");
  assert.ok(p.reasons.includes("question-pressure"));
  assert.match(replyPlanText(p), /不追加/u);
});

test("短的解释请求不能当敷衍；投入的多问允许连发，疲惫只压表达不丢答案", () => {
  const input = { messages: [msg("user", "我想聊聊平等", -4), msg("assistant", "机会和结果是两回事。", -3), msg("user", "为什么天赋不同又要求平等？劳动价值不同，尊严还相同吗？", -2), msg("assistant", "我觉得需要分开看。", -1), msg("user", "展开讲讲")], now: at, situation: { attention: "full" }, conversation: { mode: "discussing", modeTurns: 3, need: "explore" }, expressed: { activeBudget: 4 } };
  const p = planReply(input);
  assert.ok(p.maxSegments >= 3);
  const tired = planReply({ ...input, situation: { attention: "glance" }, expressed: { activeBudget: 1, maxSegments: 1 } });
  assert.equal(tired.maxSegments, 1);
  assert.ok(tired.targetChars >= 160);
  assert.match(replyPlanText(tired), /回答/u);
  assert.ok(plan("什么意思").targetChars >= 160);
});

test("追问要有来由：留悬念可接，连续追问或明确拒绝停止，安全不设短聊限制", () => {
  assert.equal(plan("你猜我今天碰到谁了").followup, "invite");
  assert.equal(plan("别问我了，换个话题").followup, "none");
  const safe = plan("我想伤害自己", { safety: true, expressed: { maxSegments: 1, activeBudget: 1 } });
  assert.equal(safe.maxSegments, undefined);
  assert.deepEqual(replyViolations("长话".repeat(1000), safe), []);
  assert.ok(plan("能陪我聊会吗，我真的撑不住了").targetChars >= 100);
});

test("模型超预算只重写一次；失败保留完整回答，不裁尾段，不泄漏草稿", async () => {
  const p = plan("早，");
  const calls = [];
  const result = await generatePlannedReply({ plan: p, system: { stable: "S", dynamic: "D" }, messages: [{ role: "user", content: "早，" }], complete: async (opts) => { calls.push(opts); return calls.length === 1 ? "早。\n\n刚起床。\n\n你今天头疼吗？" : "早，刚醒"; } });
  assert.equal(calls.length, 2);
  assert.equal(result.reply, "早，刚醒");
  assert.equal(result.rewritten, true);
  assert.deepEqual(calls[0].messages, calls[1].messages);
  let attempts = 0;
  const long = "第一段。\n\n真正的答案在这里。\n\n还有必要的补充。";
  const fallback = await generatePlannedReply({ plan: p, system: "S", messages: [], complete: async () => { if (++attempts === 2) throw new Error("unavailable"); return long; } });
  assert.equal(attempts, 2);
  assert.match(fallback.reply, /真正的答案在这里/u);
  assert.match(fallback.reply, /还有必要的补充/u);
  assert.ok(fallback.violations.length);
});

test("边界不抹掉同一条中的真实请求；缺状态保守降级；将要忙只压容量", () => {
  assert.doesNotThrow(() => planReply({ messages: null }));
  const p = plan("别问我几点吃饭，详细解释一下你刚才的观点");
  assert.equal(p.followup, "none");
  assert.ok(p.targetChars >= 160);
  const soon = plan("展开讲讲", { situation: { attention: "full", minutesToNext: 3 }, expressed: { activeBudget: 4 } });
  assert.ok(soon.reasons.includes("next-activity-soon"));
  assert.ok(soon.targetChars >= 160);
});

test("有来由的邀请在两次问话后仍能接；不因历史话多强迫继续", () => {
  const messages = [msg("user", "你好", -4), msg("assistant", "今天头疼吗？", -3), msg("user", "好了", -2), msg("assistant", "坐公交吗？", -1), msg("user", "你猜我今天碰到谁了")];
  assert.equal(planReply({ messages, now: at }).followup, "invite");
  messages[messages.length - 1].text = "嗯";
  assert.equal(planReply({ messages, now: at, conversation: { mode: "discussing", need: "explore" } }).maxSegments, 1);
});

test("双方都在展开的闲聊可以两条，不必强行转成严肃讨论", () => {
  const messages = [msg("user", "今天在路上看见一只猫在公交站牌下面睡觉", -4), msg("assistant", "它也在等公交。", -3), msg("user", "司机下来摸了它一会儿，我还以为是他养的", -2), msg("assistant", "原来是站长。", -1), msg("user", "结果它直接跑去下一辆车了，好像每个司机都认识它")];
  const p = planReply({ messages, now: at, situation: { attention: "full" }, conversation: { mode: "chatting", register: "share" }, expressed: { activeBudget: 3 } });
  assert.equal(p.maxSegments, 2);
  assert.equal(p.need, "respond");
});

test("短倾诉不自动变长篇分析；具体没懂不因谈过几轮就扩成长篇", () => {
  assert.equal(plan("今天上班要上吐了", { conversation: { register: "vent", need: "explain" } }).need, "respond");
  const p = plan("什么意思", { conversation: { register: "discuss", need: "explore", mode: "discussing" } });
  assert.equal(p.need, "explain");
});

test("语义审查有阈值且失败明示；命中未请求的管理会触发一次重写", async () => {
  const p = plan("刚到公司");
  const input = { reply: "先休息，别一来就干活", plan: p, messages: [{ role: "user", content: "刚到公司" }] };
  assert.deepEqual(await reviewPlannedReply({ ...input, judge: async () => null }), { issues: [], checked: false });
  assert.deepEqual((await reviewPlannedReply({ ...input, judge: async () => ({ issue: { probabilities: { management: 0.9, clear: 0.1 } } }) })).issues, ["semantic-management"]);
  assert.deepEqual((await reviewPlannedReply({ ...input, judge: async () => ({ issue: { probabilities: { management: 0.55, clear: 0.45 } } }) })).issues, []);
  let calls = 0;
  const result = await generatePlannedReply({ plan: p, system: "S", messages: [], complete: async () => ++calls === 1 ? "先休息，别一来就干活" : "我还在路上呢", review: async ({ reply }) => ({ checked: true, issues: reply.includes("别一来") ? ["semantic-management"] : [] }) });
  assert.equal(calls, 2);
  assert.equal(result.rewritten, true);
  assert.equal(result.reply, "我还在路上呢");
  assert.equal(result.semanticChecked, true);
});

test("连续两轮附带生活动作后不给第三轮汇报额度；问到她时正常回答", () => {
  const messages = [msg("user", "早，", -4), msg("assistant", "早，刚醒。我还没起。", -3), msg("user", "天冷不好起床", -2), msg("assistant", "是啊，我刚才闹钟按掉三遍。", -1), msg("user", "刚到公司")];
  const p = planReply({ messages, now: at });
  assert.equal(p.selfDisclosureBlocked, true);
  assert.ok(replyViolations("我这边水才刚烧上，一会儿出门", p).includes("repeated-self-report"));
  messages.at(-1).text = "你在干嘛呢";
  assert.equal(planReply({ messages, now: at }).selfDisclosureBlocked, false);
});
