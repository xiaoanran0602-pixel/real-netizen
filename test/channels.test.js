// 聊天渠道：bridge（非主忽略、去重、合批、分段写回、主动消息）+ Telegram 假 API + Webhook 签名。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { setRuntimeOptions } from "../src/config/runtime.js";
import { writeChannelSecrets } from "../src/config/secrets.js";
import { createChatService } from "../src/chat/chat-service.js";
import { readMemories } from "../src/companion/memory.js";
import { getMainConversationId, readConversation } from "../src/store/conversation.js";
import { createChannelBridge } from "../src/channels/bridge.js";
import { telegramChannel } from "../src/channels/telegram/channel.js";
import { webhookChannel } from "../src/channels/webhook/channel.js";
import { signPayload, verifyWebhook } from "../src/channels/webhook/sign.js";
import { useTempData } from "./helpers.js";

const OWNER = "10086";

// ---------- 假 Telegram 服务器 ----------

/** 记录 sendMessage、按需返回 getUpdates 队列里的 update。 */
async function startFakeTelegram() {
  const sent = [];
  const updates = [];
  const timers = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (url.pathname.includes("sendMessage")) {
        sent.push({ chat_id: url.searchParams.get("chat_id"), text: url.searchParams.get("text") });
        res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
        return;
      }
      if (url.pathname.includes("getUpdates")) {
        const batch = updates.splice(0);
        // 空响应慢一点，避免长轮询在测试里空转打满 CPU。
        if (batch.length === 0) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            res.end(JSON.stringify({ ok: true, result: [] }));
          }, 5);
          timers.add(timer);
        } else {
          res.end(JSON.stringify({ ok: true, result: batch }));
        }
        return;
      }
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () =>
    new Promise((resolve) => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      // 销毁 keep-alive / 在途连接，server.close 才会立刻回调，测试进程不会卡在退出上。
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return { sent, updates, base, close };
}

function telegramUpdate(id, text, sender = OWNER) {
  return { update_id: id, message: { message_id: id, chat: { id: Number(sender), type: "private" }, from: { id: Number(sender) }, text } };
}

function message(id, text, sender = OWNER) {
  return { channelId: "telegram", eventId: String(id), senderId: String(sender), text, at: Date.now() };
}

const conversation = async () => readConversation(await getMainConversationId());

async function setupBridge(reply) {
  const data = await useTempData();
  const fake = await startFakeTelegram();
  setRuntimeOptions({ channelApiHost: fake.base, dry: false });
  await writeChannelSecrets({ telegram: { enabled: true, botToken: "tok", ownerChatId: OWNER } });
  const prompts = [];
  const complete = async (options) => {
    prompts.push(options.messages.at(-1).content);
    return reply;
  };
  const chatService = createChatService({ complete, buildPrompt: async () => ({ system: { stable: "S", dynamic: "D" } }) });
  const bridge = createChannelBridge({ chatService, sleep: async () => undefined, batchWindowMs: 20 });
  return {
    fake,
    bridge,
    prompts,
    cleanup: async () => {
      await bridge.clearPending();
      await fake.close();
      setRuntimeOptions({ channelApiHost: "https://api.telegram.org" });
      await data.cleanup();
    },
  };
}

// ---------- bridge ----------

test("非主人消息忽略；重复事件去重；主人连发合成一轮、回复分段发出并整体写入对话", async () => {
  const ctx = await setupBridge("嗯\n\n在的\n\n怎么了");
  try {
    assert.equal(await ctx.bridge.handleIncoming(message("x1", "你好", "stranger")), "not-owner");
    assert.equal(await ctx.bridge.handleIncoming(message("a1", "在吗")), "queued");
    assert.equal(await ctx.bridge.handleIncoming(message("a1", "在吗")), "duplicate");
    assert.equal(await ctx.bridge.handleIncoming(message("a2", "有事问你")), "queued");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.bridge.idle();
    assert.equal(ctx.prompts.length, 1, "两条合成一轮");
    assert.match(ctx.prompts[0], /在吗\n有事问你/u);
    assert.deepEqual(
      ctx.fake.sent.map((body) => body.text),
      ["嗯", "在的", "怎么了"],
    );
    assert.ok(ctx.fake.sent.every((body) => body.chat_id === OWNER));
    const messages = await conversation();
    assert.deepEqual(messages.map((m) => `${m.role}:${m.source}`), ["user:channel", "assistant:channel"]);
    assert.equal(messages[1].text, "嗯\n\n在的\n\n怎么了");
  } finally {
    await ctx.cleanup();
  }
});

test("主动消息：发到所有已启用渠道后写入对话（source=proactive）并记一条她的记忆", async () => {
  const ctx = await setupBridge("unused");
  try {
    assert.equal(await ctx.bridge.sendProactive("今天的云好低", null, "下班路上看到了"), true);
    assert.equal(ctx.fake.sent[0].text, "今天的云好低");
    const messages = await conversation();
    assert.equal(messages.at(-1).source, "proactive");
    assert.equal(messages.at(-1).text, "今天的云好低");
    const memories = await readMemories();
    assert.ok(memories.some((entry) => entry.type === "self_daily" && entry.body.includes("今天的云好低")));
  } finally {
    await ctx.cleanup();
  }
});

test("渠道没配好时主动消息不发也不写", async () => {
  const data = await useTempData();
  try {
    const chatService = createChatService({ complete: async () => "x", buildPrompt: async () => ({ system: { stable: "S", dynamic: "D" } }) });
    const bridge = createChannelBridge({ chatService, sleep: async () => undefined });
    assert.equal(await bridge.sendProactive("hi"), false);
    assert.equal((await conversation()).length, 0);
  } finally {
    await data.cleanup();
  }
});

// ---------- Telegram 渠道 ----------

test("Telegram 轮询：update 转成 InboundMessage，忽略非私聊与非文字", async () => {
  const data = await useTempData();
  const fake = await startFakeTelegram();
  setRuntimeOptions({ channelApiHost: fake.base, dry: false });
  try {
    const received = [];
    await telegramChannel.start({ secrets: { botToken: "tok", ownerChatId: OWNER }, onMessage: (m) => received.push(m) });
    fake.updates.push(telegramUpdate(1, "在吗"));
    fake.updates.push({ update_id: 2, message: { chat: { id: 1, type: "group" }, text: "群消息" } });
    fake.updates.push({ update_id: 3, message: { chat: { id: Number(OWNER), type: "private" }, photo: [{}] } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await telegramChannel.stop();
    assert.equal(received.length, 1);
    assert.deepEqual({ channelId: received[0].channelId, eventId: received[0].eventId, senderId: received[0].senderId, text: received[0].text }, { channelId: "telegram", eventId: "1", senderId: OWNER, text: "在吗" });
  } finally {
    await telegramChannel.stop();
    await fake.close();
    setRuntimeOptions({ channelApiHost: "https://api.telegram.org" });
    await data.cleanup();
  }
});

test("Telegram 发文字：通过假 API 发到 ownerChatId", async () => {
  const data = await useTempData();
  const fake = await startFakeTelegram();
  setRuntimeOptions({ channelApiHost: fake.base, dry: false });
  try {
    await telegramChannel.sendText({ botToken: "tok", ownerChatId: OWNER }, "在吗");
    assert.deepEqual(fake.sent.map((body) => [body.chat_id, body.text]), [[OWNER, "在吗"]]);
  } finally {
    await fake.close();
    setRuntimeOptions({ channelApiHost: "https://api.telegram.org" });
    await data.cleanup();
  }
});

// ---------- Webhook 渠道 ----------

test("Webhook 签名：正确通过，篡改或过期（5 分钟）拒绝", () => {
  const secret = "s3cret";
  const raw = JSON.stringify({ eventId: "e1", senderId: OWNER, text: "在吗" });
  const signature = signPayload(secret, raw);
  assert.equal(verifyWebhook({ secret, rawBody: raw, signature, timestamp: String(Date.now()) }), true);
  assert.equal(verifyWebhook({ secret, rawBody: raw, signature: "deadbeef", timestamp: String(Date.now()) }), false);
  assert.equal(verifyWebhook({ secret, rawBody: `${raw}x`, signature, timestamp: String(Date.now()) }), false);
  assert.equal(verifyWebhook({ secret, rawBody: raw, signature, timestamp: String(Date.now() - 6 * 60_000) }), false);
  assert.equal(verifyWebhook({ secret, rawBody: raw, signature, timestamp: "" }), false);
});

test("Webhook 入站 payload 解析为 InboundMessage，字段缺失返回 null", () => {
  assert.deepEqual(webhookChannel.parseInbound(JSON.stringify({ eventId: "e1", senderId: OWNER, text: " 在吗 " })), {
    channelId: "webhook",
    eventId: "e1",
    senderId: OWNER,
    text: "在吗",
    at: webhookChannel.parseInbound(JSON.stringify({ eventId: "e1", senderId: OWNER, text: "在吗" })).at,
  });
  assert.equal(webhookChannel.parseInbound("{bad json"), null);
  assert.equal(webhookChannel.parseInbound(JSON.stringify({ eventId: "e2", text: "  " })), null);
});

test("Webhook 出站：POST outboundUrl 并带上签名", async () => {
  const data = await useTempData();
  const posted = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      posted.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/in`;
  try {
    await webhookChannel.sendText({ secret: "s3cret", outboundUrl: url, ownerId: OWNER }, "在吗");
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.type, "text");
    assert.equal(posted[0].body.text, "在吗");
    assert.equal(posted[0].body.ownerId, OWNER);
    assert.ok(posted[0].headers["x-rn-signature"]);
    assert.ok(verifyWebhook({ secret: "s3cret", rawBody: JSON.stringify(posted[0].body), signature: posted[0].headers["x-rn-signature"], timestamp: posted[0].headers["x-rn-timestamp"] }));
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await data.cleanup();
  }
});
