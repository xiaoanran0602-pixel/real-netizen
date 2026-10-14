// chat-service：串行顺序、失败不写回复、重发复用、主动消息入队、历史窗口、事件广播（假模型）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatService, stripSpeakerPrefix } from "../src/chat/chat-service.js";
import { buildModelMessages, HISTORY_MAX_MESSAGES } from "../src/chat/history.js";
import { getMainConversationId, readConversation } from "../src/store/conversation.js";
import { readState } from "../src/store/state.js";
import { useTempData } from "./helpers.js";
import { planReply } from "../src/companion/reply-plan.js";

/** 假模型：按最后一条 user 消息回复；可设延迟与失败词。 */
function fakeComplete({ delayMs = 0, failOn = "坏" } = {}) {
  const calls = [];
  const fn = async (options) => {
    calls.push(options);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const last = options.messages.at(-1).content;
    if (last.endsWith(failOn)) throw Object.assign(new Error("boom"), { kind: "http", status: 500 });
    options.onDelta?.("回：");
    return `回：${last.split("\n\n").at(-1)}`;
  };
  fn.calls = calls;
  return fn;
}

const buildPrompt = async () => ({ system: { stable: "S", dynamic: "D" } });

async function messages() {
  return readConversation(await getMainConversationId());
}

test("turns run strictly in order even when sent concurrently from web and channel", async () => {
  const { cleanup } = await useTempData();
  try {
    const complete = fakeComplete({ delayMs: 20 });
    const service = createChatService({ complete, buildPrompt });
    const a = service.submitUserMessage("一", { source: "web" });
    const b = service.submitUserMessage("二", { source: "channel" });
    const c = service.submitUserMessage("三", { source: "web" });
    await Promise.all([a.done, b.done, c.done]);
    assert.deepEqual((await messages()).map((m) => `${m.role}:${m.text}`), ["user:一", "assistant:回：一", "user:二", "assistant:回：二", "user:三", "assistant:回：三"]);
    // 第二轮看得到第一轮的结果。
    assert.deepEqual(complete.calls[1].messages.map((m) => m.content), ["一", "回：一", "二"]);
    assert.equal((await messages())[0].id, a.messageId);
  } finally {
    await cleanup();
  }
});

test("failure writes no reply, broadcasts turn_error and marks the message failed; retry reuses it", async () => {
  const { cleanup } = await useTempData();
  try {
    const events = [];
    let fail = true;
    const complete = async (options) => {
      if (fail) throw Object.assign(new Error("x"), { kind: "timeout" });
      return `好的 ${options.messages.at(-1).content}`;
    };
    const service = createChatService({ complete, buildPrompt, broadcast: (type, data) => events.push([type, data]) });
    const first = await service.sendUserMessage("在吗", { source: "web" });
    assert.equal(first.ok, false);
    assert.deepEqual((await messages()).map((m) => m.role), ["user"]);
    assert.deepEqual(service.failedIds(), [first.userMessage.id]);
    const error = events.find(([type]) => type === "turn_error");
    assert.equal(error[1].replyTo, first.userMessage.id);
    fail = false;
    const retry = await service.sendUserMessage("在吗", { source: "web" });
    assert.equal(retry.ok, true);
    assert.equal(retry.userMessage.id, first.userMessage.id);
    assert.deepEqual((await messages()).map((m) => `${m.role}:${m.text}`), ["user:在吗", "assistant:好的 在吗"]);
    assert.deepEqual(service.failedIds(), []);
    assert.ok(events.some(([type, data]) => type === "turn_done" && data.replyTo === first.userMessage.id));
  } finally {
    await cleanup();
  }
});

test("proactive messages go through the same queue and land between turns", async () => {
  const { cleanup } = await useTempData();
  try {
    const service = createChatService({ complete: fakeComplete({ delayMs: 30 }), buildPrompt });
    const turn = service.submitUserMessage("你好", { source: "web" });
    const proactive = service.appendAssistant("下雨了，你带伞没", { source: "proactive" });
    await Promise.all([turn.done, proactive]);
    const list = await messages();
    assert.deepEqual(list.map((m) => `${m.source}:${m.text}`), ["web:你好", "chat:回：你好", "proactive:下雨了，你带伞没"]);
    assert.ok((await readState()).lastProactiveAt > 0);
  } finally {
    await cleanup();
  }
});

test("lastUserMessageAt: previous value is given to the prompt, then updated; only web/channel update it", async () => {
  const { cleanup } = await useTempData();
  try {
    const seen = [];
    const service = createChatService({ complete: fakeComplete(), buildPrompt: async (input) => (seen.push(input.lastSeenAt), { system: "S" }) });
    await service.sendUserMessage("一", { source: "web", at: 1_000 });
    await service.sendUserMessage("二", { source: "channel", at: 5_000 });
    assert.deepEqual(seen, [undefined, 1_000]);
    assert.equal((await readState()).lastUserMessageAt, 5_000);
    await service.appendAssistant("我主动说一句", { source: "proactive" });
    assert.equal((await readState()).lastUserMessageAt, 5_000);
  } finally {
    await cleanup();
  }
});

test("stream mode broadcasts deltas; whole mode does not", async () => {
  const { cleanup } = await useTempData();
  try {
    const events = [];
    let mode = "stream";
    const service = createChatService({ complete: fakeComplete(), buildPrompt, broadcast: (type) => events.push(type), readSettings: async () => ({ replyMode: mode }) });
    await service.sendUserMessage("一", { source: "web" });
    assert.ok(events.includes("delta"));
    events.length = 0;
    mode = "whole";
    await service.sendUserMessage("二", { source: "web" });
    assert.equal(events.includes("delta"), false);
    assert.deepEqual(events.filter((e) => e !== "message"), ["typing", "typing", "turn_done"]);
  } finally {
    await cleanup();
  }
});

test("deferReply generates without writing; afterTurn hook runs", async () => {
  const { cleanup } = await useTempData();
  try {
    const after = [];
    const service = createChatService({ complete: fakeComplete(), buildPrompt: async () => ({ system: "S", afterTurn: async (reply) => after.push(reply) }), afterTurn: ({ source }) => after.push(source) });
    const result = await service.sendUserMessage("在干嘛", { source: "channel", deferReply: true });
    assert.equal(result.reply, "回：在干嘛");
    assert.deepEqual((await messages()).map((m) => m.role), ["user"]);
    assert.deepEqual(after, ["回：在干嘛", "channel"]);
  } finally {
    await cleanup();
  }
});

test("history window: budget, max messages, first message is user, same-role merge", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", text: `第${i}句` }));
  assert.ok(buildModelMessages(many).length <= HISTORY_MAX_MESSAGES);
  assert.equal(buildModelMessages(many)[0].role, "user");
  const budget = buildModelMessages([{ role: "user", text: "a".repeat(50) }, { role: "assistant", text: "b".repeat(50) }, { role: "user", text: "c" }], { charBudget: 60 });
  assert.deepEqual(budget.map((m) => m.content), ["c"]);
  const merged = buildModelMessages([{ role: "assistant", text: "主动1" }, { role: "assistant", text: "主动2" }, { role: "user", text: "嗯" }, { role: "user", text: "在" }]);
  assert.deepEqual(merged, [{ role: "user", content: "嗯\n\n在" }]);
});

test("system task jumps the queue when front=true and blocked queue only runs forced tasks", async () => {
  const { cleanup } = await useTempData();
  try {
    const order = [];
    const service = createChatService({ complete: fakeComplete({ delayMs: 20 }), buildPrompt });
    service.queue.block("restoring");
    const turn = service.submitUserMessage("一", { source: "web" });
    await service.runSystemTask(async () => order.push("restore"), { force: true });
    assert.equal((await messages()).length, 0);
    service.queue.unblock();
    await turn.done;
    order.push("turn");
    assert.deepEqual(order, ["restore", "turn"]);
  } finally {
    await cleanup();
  }
});

test("回复开头的「林澈：」前缀去掉；重新生成时已先回的那句用第三人称写进此刻", async () => {
  assert.equal(stripSpeakerPrefix("林澈：在呢"), "在呢");
  assert.equal(stripSpeakerPrefix("林澈: 在呢", "林澈"), "在呢");
  assert.equal(stripSpeakerPrefix("在呢，林澈：不是前缀"), "在呢，林澈：不是前缀");
  const { cleanup } = await useTempData();
  try {
    const prompts = [];
    const complete = async () => "林澈：好了，接着说";
    const service = createChatService({ complete, buildPrompt: async (input) => (prompts.push(input), { system: { stable: "S", dynamic: "D" } }) });
    await service.sendUserMessage("在吗", { source: "channel", deferReply: true });
    await service.appendAssistant("在开会，晚点说");
    const result = await service.regenerate({ source: "channel", deferReply: true });
    assert.equal(result.reply, "好了，接着说");
    const now = prompts.at(-1).extraNow.join("");
    assert.match(now, /她刚才已经先回了一句：「在开会，晚点说」/u);
    assert.doesNotMatch(now, /你/u);
  } finally {
    await cleanup();
  }
});

test("规划路径：网页只收到通过检查的正文，渠道延后写入也用同一正文", async () => {
  const { cleanup } = await useTempData();
  try {
    for (const source of ["web", "channel"]) {
      let calls = 0;
      const events = [];
      const after = [];
      const service = createChatService({ readSettings: async () => ({ replyMode: "stream" }), broadcast: (type, data) => events.push({ type, data }), buildPrompt: async ({ messages }) => ({ system: "S", replyPlan: planReply({ messages }), afterTurn: async (reply) => after.push(reply) }), complete: async (opts) => { calls += 1; opts.onDelta?.("不该露出的草稿"); return calls % 2 ? "早。\n\n我刚醒。\n\n今天头还疼吗？" : "早，刚醒"; } });
      const result = await service.sendUserMessage("早，", { source, deferReply: source === "channel" });
      assert.equal(result.ok, true);
      assert.equal(result.reply, "早，刚醒");
      assert.equal(result.replyCheck.rewritten, true);
      assert.deepEqual(after, ["早，刚醒"]);
      assert.ok(events.every((e) => !JSON.stringify(e).includes("草稿")));
      const deltas = events.filter((e) => e.type === "delta");
      assert.equal(deltas.length, source === "channel" ? 0 : 1);
      if (source === "channel") {
        assert.equal((await messages()).at(-1).role, "user");
        await service.appendAssistant(result.reply);
      }
      assert.equal((await messages()).at(-1).text, "早，刚醒");
    }
  } finally { await cleanup(); }
});
