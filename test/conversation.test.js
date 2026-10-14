// 聊天状态：粗略猜测、按分布抽、惯性、另起一回、同一条消息只推进一次、给提示词的句子、给决策模型的材料。
import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceConversation, conversationLines, decisionState, guardCautious, guessNext, guessRegister, MODES, modeWeights, QUESTIONS, REGISTERS, sample, SESSION_GAP_MS, STAY } from "../src/inner/conversation.js";
import { amendConversation, readConversationState, stepConversation } from "../src/inner/conversation-store.js";
import { MINUTE_MS } from "../src/util/time.js";
import { useTempData } from "./helpers.js";

const T0 = new Date(2026, 9, 13, 10, 35).getTime();
const fixed = (value) => () => value;
const reading = (next, register) => ({ next: { probabilities: next }, register: { probabilities: register } });
const top = (dist) => Object.entries(dist).sort((a, b) => b[1] - a[1])[0][0];

test("问决策模型的问题覆盖全部状态和语域", () => {
  assert.deepEqual(Object.keys(QUESTIONS.next.criteria), [...MODES]);
  assert.deepEqual(Object.keys(QUESTIONS.register.criteria), [...REGISTERS]);
  for (const mode of MODES) assert.ok(STAY[mode] > 0);
});

test("粗略猜测：招呼、求安慰、难受、想讨论、问具体的事；拿不准就当闲聊，不猜成调情", () => {
  assert.equal(top(guessRegister("在吗")), "greeting");
  assert.equal(top(guessRegister("你能哄我两句吗")), "ask_comfort");
  assert.equal(top(guessRegister("今天真的好难受")), "vent");
  assert.equal(top(guessRegister("为什么人非要有个目标才觉得活得有意义")), "discuss");
  assert.equal(top(guessRegister("周六几点见")), "logistics");
  assert.equal(top(guessRegister("最近上班忙吗？")), "chitchat");
  for (const text of ["在吗", "哈哈", "今天吃了鱼丸", "", "想你了"]) assert.equal(guessRegister(text).flirt, undefined);
  assert.equal(top(guessNext({ vent: 0.6, share: 0.4 })), "heart");
});

test("按分布抽：分布尖时抽不出别的；两可时两种都会出现；占比太小的不参与", () => {
  const sharp = { heart: 0.96, discussing: 0.04 };
  for (const roll of [0, 0.3, 0.6, 0.99]) assert.equal(sample(sharp, fixed(roll), "chatting").pick, "heart");
  const loose = { chatting: 0.72, opening: 0.26, flirting: 0.02 };
  assert.equal(sample(loose, fixed(0.1), "chatting").pick, "chatting");
  assert.equal(sample(loose, fixed(0.9), "chatting").pick, "opening");
  assert.equal(sample({}, fixed(0.5), "chatting").pick, "chatting");
  const share = sample(loose, fixed(0.1), "chatting").share;
  assert.ok(Math.abs(share - 0.72) < 1e-9, "占比按全部算，不按留下的算");
});

test("惯性：聊深了，他一句玩笑不会马上掉回闲扯；一直是闲聊才慢慢回去", () => {
  const deep = { mode: "discussing", turns: 5, modeTurns: 3 };
  const joke = { chatting: 0.6, discussing: 0.4 };
  const weights = modeWeights(joke, deep);
  assert.ok(weights.discussing > weights.chatting, "留在原状态的倾向把它托住了");
  const clearlyOver = modeWeights({ chatting: 0.9, discussing: 0.1 }, deep);
  assert.ok(clearlyOver.chatting > clearlyOver.discussing, "他明显换了话头就跟着换");
  assert.equal(modeWeights({ opening: 0.5, chatting: 0.5 }, { mode: "chatting", turns: 3, modeTurns: 3 }).opening, undefined, "聊过几轮就不再是刚起头");
});

test("推进：轮数、同状态轮数、另起一回、同一条消息只推进一次", () => {
  const loose = reading({ chatting: 0.72, opening: 0.26 }, { chitchat: 0.8, greeting: 0.2 });
  const first = advanceConversation(null, { messageId: "m1", at: T0, text: "最近上班忙吗？", reading: loose, rng: fixed(0.5) });
  assert.equal(first.mode, "chatting");
  assert.equal(advanceConversation(null, { messageId: "m1", at: T0, text: "最近上班忙吗？", reading: loose, rng: () => { throw new Error("不能掷骰"); } }).mode, first.mode, "相同证据确定性选择，不因随机数改变");
  assert.equal(first.turns, 1);
  assert.equal(first.source, "decision");
  assert.equal(first.asks, true);
  assert.equal(advanceConversation(first, { messageId: "m1", at: T0 + 5000, text: "最近上班忙吗？", rng: fixed(0.9) }), first, "重试、重新生成复用");

  const second = advanceConversation(first, { messageId: "m2", at: T0 + 2 * MINUTE_MS, text: "哈哈", reading: reading({ chatting: 1 }, { chitchat: 1 }), rng: fixed(0.5) });
  assert.equal(second.turns, 2);
  assert.equal(second.modeTurns, 2);
  assert.equal(second.startedAt, first.startedAt);

  const turned = advanceConversation(second, { messageId: "m3", at: T0 + 4 * MINUTE_MS, text: "其实我最近一直在想要不要辞职", reading: reading({ heart: 0.96, discussing: 0.04 }, { vent: 0.62, share: 0.3 }), rng: fixed(0.5) });
  assert.equal(turned.mode, "heart");
  assert.equal(turned.prevMode, "chatting");
  assert.equal(turned.modeTurns, 1);

  const later = advanceConversation(turned, { messageId: "m4", at: turned.lastAt + SESSION_GAP_MS + 1, text: "在吗", rng: fixed(0.1) });
  assert.equal(later.turns, 1, "隔久了另起一回");
  assert.equal(later.prevMode, null);
  assert.equal(later.source, "guess");
});

test("她回得晚不把一回聊天切成两回；她睡着时他发的消息不算接着昨天聊", () => {
  const prev = advanceConversation(null, { messageId: "m1", at: T0, text: "哈哈", rng: fixed(0.5) });
  const lateReply = advanceConversation(prev, { messageId: "m2", at: T0 + 90 * MINUTE_MS, sentAt: T0 + 3 * MINUTE_MS, text: "那你觉得呢", rng: fixed(0.5) });
  assert.equal(lateReply.turns, 2);
  const nextMorning = advanceConversation(prev, { messageId: "m3", at: T0 + 600 * MINUTE_MS, sentAt: T0 + 300 * MINUTE_MS, text: "醒了吗", rng: fixed(0.5) });
  assert.equal(nextMorning.turns, 1);
});

test("看错了代价高的不从小概率里抽：两成像调情的一句玩笑不会被当成调情；已经在那个状态里接着聊不受限", () => {
  const joke = reading({ opening: 0.9, flirting: 0.1 }, { share: 0.4, chitchat: 0.28, flirt: 0.2, greeting: 0.12 });
  for (const roll of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) {
    const state = advanceConversation(null, { messageId: "m1", at: T0, text: "哈哈哈你猜我今天碰到谁", reading: joke, rng: fixed(roll) });
    assert.notEqual(state.register, "flirt");
    assert.notEqual(state.mode, "flirting");
  }
  const clear = advanceConversation(null, { messageId: "m1", at: T0, text: "想你了", reading: reading({ flirting: 0.7, chatting: 0.3 }, { flirt: 0.7, chitchat: 0.3 }), rng: fixed(0.5) });
  assert.equal(clear.mode, "flirting", "过半才算数");
  assert.deepEqual(guardCautious({ flirting: 0.3, chatting: 0.7 }, "flirting"), { flirting: 0.3, chatting: 0.7 });
  assert.deepEqual(guardCautious({ flirting: 0.3, chatting: 0.7 }), { chatting: 0.7 });
});

test("安全例外：不抽，就是走心；提示词里不写聊天状态", () => {
  const state = advanceConversation(null, { messageId: "m1", at: T0, text: "我不想活了", safety: true, reading: reading({ chatting: 1 }, { chitchat: 1 }), rng: fixed(0.1) });
  assert.equal(state.mode, "heart");
  assert.equal(state.register, "vent");
  assert.deepEqual(conversationLines(state, { safety: true }), []);
});

test("给提示词的句子：只说聊成了什么样，不含语气要求", () => {
  const opening = advanceConversation(null, { messageId: "m1", at: T0, text: "最近上班忙吗？", reading: reading({ chatting: 1 }, { chitchat: 0.9, greeting: 0.1 }), rng: fixed(0.1) });
  assert.deepEqual(conversationLines(opening), ["他刚发来这一条，他们这回还没聊起来。", "他这句是随口问的。"]);

  const unsure = advanceConversation(null, { messageId: "m1", at: T0, text: "今天吃了鱼丸", reading: reading({ chatting: 1 }, { share: 0.5, chitchat: 0.5 }), rng: fixed(0.1) });
  assert.match(conversationLines(unsure).join(""), /像是/u, "两可时不说死");

  let deep = advanceConversation(opening, { messageId: "m2", at: T0 + MINUTE_MS, text: "你说人为什么非要有目标", reading: reading({ discussing: 1 }, { discuss: 1 }), rng: fixed(0.1) });
  assert.deepEqual(conversationLines(deep), ["聊着聊着，说到一件正经事上了。"], "他这句和眼下是一回事就不重复说");
  deep = advanceConversation(deep, { messageId: "m3", at: T0 + 2 * MINUTE_MS, text: "哈哈哈你这么说我就放心了", reading: reading({ discussing: 0.7, chatting: 0.3 }, { chitchat: 1 }), rng: fixed(0.5) });
  assert.deepEqual(conversationLines(deep), ["他们在聊一件正经事，已经来回了几轮。", "他这句是随口说的。"]);
  assert.match(conversationLines(deep, { attention: "glance" }).join(""), /手上的事还没完/u, "想聊深的可她正忙着");
  assert.doesNotMatch(conversationLines(deep, { attention: "full" }).join(""), /手上的事/u);

  const answering = advanceConversation(null, { messageId: "m1", at: T0, text: "好多了", answering: true, rng: fixed(0.5) });
  assert.match(conversationLines(answering)[0], /是她先给他发的消息/u);

  const every = [];
  for (const mode of MODES) for (const turns of [1, 2]) for (const modeTurns of [1, 3, 9]) for (const register of REGISTERS) {
    every.push(...conversationLines({ mode, turns, modeTurns, register, sure: true, asks: true }, { attention: "glance" }));
  }
  assert.doesNotMatch(every.join(""), /随意一点|简短|口语|语气|少说|多说|认真一点|不是[^。]{1,16}[，,](而是|就是|只是|是)/u);
});

test("给决策模型的材料只有眼下这段聊天", () => {
  const prev = { mode: "chatting", turns: 6, lastAt: T0 };
  const state = decisionState({ scene: "23:10，她在家，已经窝下了", prev, at: T0 + MINUTE_MS, recent: [{ role: "user", text: "哈哈" }, { role: "assistant", text: "嗯" }], text: "其实我在想要不要辞职" });
  assert.deepEqual(Object.keys(state), ["她此刻", "这段聊天之前的状态", "最近几句", "他刚发来"]);
  assert.match(state.这段聊天之前的状态, /已经 6 轮/u);
  assert.deepEqual(state.最近几句, ["他：哈哈", "她：嗯"]);
  assert.match(decisionState({ prev, at: T0 + SESSION_GAP_MS + 1, text: "在吗" }).这段聊天之前的状态, /还没开始/u);
});

test("落盘：推进一次写一次；晚到的判断只改当前这条的状态，他又说话了就作废", async () => {
  const { cleanup } = await useTempData();
  try {
    assert.equal(await readConversationState(), null);
    const input = { messageId: "m1", at: T0, text: "其实我在想要不要辞职", rng: fixed(0.5) };
    const stepped = await stepConversation(input);
    assert.equal(stepped.fresh, true);
    assert.equal(stepped.prev, null);
    assert.equal((await readConversationState()).lastMessageId, "m1");
    assert.equal((await stepConversation({ ...input, rng: fixed(0.99) })).fresh, false);

    const amended = await amendConversation("m1", () => advanceConversation(stepped.prev, { ...input, reading: reading({ heart: 1 }, { vent: 1 }) }));
    assert.equal(amended.mode, "heart");
    assert.equal(amended.source, "decision");
    assert.equal((await readConversationState()).turns, 1, "重算不多记一轮");

    await stepConversation({ messageId: "m2", at: T0 + MINUTE_MS, text: "算了", rng: fixed(0.5) });
    assert.equal(await amendConversation("m1", () => ({ ...amended, mode: "flirting" })), null);
    assert.equal((await readConversationState()).lastMessageId, "m2");
  } finally {
    await cleanup();
  }
});
