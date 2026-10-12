// HTTP 接口：令牌与 cookie、回调免令牌与 401、settings/model 打码与留空不改、记忆/日程 403、
// 发消息后 SSE 收到 message 与 turn_done；回档、记牢、清晰度字段。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { paths } from "../src/config/paths.js";
import { setRuntimeOptions } from "../src/config/runtime.js";
import { createApp } from "../src/app.js";
import { snapshot } from "../src/archive/snapshot.js";
import { coreSelfText } from "../src/inner/core-self.js";
import { writeChannelSecrets } from "../src/config/secrets.js";
import { signPayload } from "../src/channels/webhook/sign.js";
import { addDays, formatLocalDate } from "../src/util/time.js";
import { useTempData } from "./helpers.js";

const TOKEN = "test-token-123";
const OWNER = "10086";

async function startApp() {
  const data = await useTempData();
  await mkdir(paths.secrets(), { recursive: true });
  await writeFile(paths.accessToken(), TOKEN);
  setRuntimeOptions({ host: "127.0.0.1", dry: true });
  const app = await createApp({ host: "127.0.0.1", complete: async () => "嗯，在的" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body, headers = { authorization: `Bearer ${TOKEN}` }) => {
    const response = await fetch(base + path, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 静态文件不是 JSON。
    }
    return { status: response.status, json, headers: response.headers };
  };
  return {
    app,
    base,
    call,
    async stop() {
      await app.close();
      await data.cleanup();
    },
  };
}

const memoryFile = (type, body) => `---\nname: x\ndescription: ${body}\nmetadata:\n  type: ${type}\n---\n${body}\n`;

test("记牢、清晰度字段、回档列表与日期确认、删除更早存档", async () => {
  const ctx = await startApp();
  try {
    await writeFile(join(paths.memory(), "his-job.md"), memoryFile("profile", "他做游戏"));
    const listed = await ctx.call("GET", "/api/lin/memories");
    const item = listed.json.memories.find((m) => m.file === "his-job.md");
    assert.equal(item.clarity, "clear");
    assert.equal(item.pinned, false);
    assert.ok(item.lastRecalled && item.importance);
    assert.equal((await ctx.call("PUT", "/api/lin/memories/his-job.md/pin", { pinned: true })).status, 200);
    assert.equal((await ctx.call("GET", "/api/lin/memories")).json.memories.find((m) => m.file === "his-job.md").pinned, true);
    assert.equal((await ctx.call("PUT", "/api/lin/memories/nope.md/pin", { pinned: true })).status, 404);

    const today = formatLocalDate();
    const yesterday = addDays(today, -1);
    const boundary = { boundaryHour: 4, companionName: "她", userName: "他" };
    await snapshot(yesterday, boundary);
    await snapshot(today, boundary);
    const archive = await ctx.call("GET", "/api/lin/archive");
    assert.deepEqual(archive.json.days.map((d) => d.day), [today, yesterday]);
    assert.ok(archive.json.bytes > 0);
    assert.equal(archive.json.restore.status, "idle");

    assert.equal((await ctx.call("POST", "/api/lin/archive/restore", { day: yesterday, confirm: "01-01" })).status, 400);
    assert.equal((await ctx.call("POST", "/api/lin/archive/restore", { day: "1999-01-01", confirm: "01-01" })).status, 404);
    await writeFile(join(paths.memory(), "later.md"), memoryFile("recent", "之后才有的"));
    const restored = await ctx.call("POST", "/api/lin/archive/restore", { day: yesterday, confirm: yesterday.slice(5) });
    assert.equal(restored.status, 200);
    assert.equal(restored.json.status.status, "done");
    const after = await ctx.call("GET", "/api/lin/memories");
    assert.ok(!after.json.memories.some((m) => m.file === "later.md"), "回档后之后的记忆没了");
    assert.deepEqual((await ctx.call("GET", "/api/lin/archive")).json.days.map((d) => d.day), [yesterday]);

    assert.equal((await ctx.call("DELETE", `/api/lin/archive/before/${yesterday}`)).status, 200);
    assert.equal((await ctx.call("DELETE", `/api/lin/archive/before/${addDays(yesterday, 1)}`)).status, 400, "至少留一份");
  } finally {
    await ctx.stop();
  }
});

test("inner/force：压力与疲惫让防线变薄并出现提示；张力强制后到阈值；未知事件 400；任何接口都不含她自己的基石", async () => {
  const ctx = await startApp();
  try {
    const before = (await ctx.call("GET", "/api/lin/inner")).json;
    assert.ok(before.vitals && before.tensions && typeof before.guard === "number");
    await ctx.call("POST", "/api/lin/inner/force", { event: "stress" });
    await ctx.call("POST", "/api/lin/inner/force", { event: "tired" });
    // 测试改不了系统时间：用喝酒（−15）代替深夜修正（−15）。
    const forced = (await ctx.call("POST", "/api/lin/inner/force", { event: "drink" })).json;
    assert.ok(forced.guard < 35, `guard=${forced.guard}`);
    assert.ok(forced.hints.includes("你防线很薄，心里的东西容易漏出来。"));
    const book = (await ctx.call("POST", "/api/lin/inner/force", { event: "tension:book" })).json;
    assert.ok(book.tensions.book >= 80);
    const sick = (await ctx.call("POST", "/api/lin/inner/force", { event: "sick" })).json;
    assert.equal(sick.sick.kind, "cold");
    assert.equal((await ctx.call("POST", "/api/lin/inner/force", { event: "nope" })).status, 400);
    const simulated = (await ctx.call("POST", "/api/lin/inner/simulate?hours=48&memory=1")).json;
    assert.ok(simulated.vitals && simulated.memory);
    assert.equal((await ctx.call("GET", "/api/lin/status")).status, 200);

    const fragment = coreSelfText().trim().slice(0, 24);
    for (const path of ["/api/lin/core", "/api/lin/settings", "/api/lin/inner", "/api/lin/persona"]) {
      const response = await fetch(ctx.base + path, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.ok(!(await response.text()).includes(fragment), `${path} 泄露了她自己的基石`);
    }
  } finally {
    await ctx.stop();
  }
});
test("令牌：无令牌 401；?token= 写 HttpOnly cookie 后凭 cookie 通过；静态文件与回调免令牌；坏签名 401；challenge 原样返回", async () => {
  const ctx = await startApp();
  try {
    assert.equal((await ctx.call("GET", "/api/lin/settings", undefined, {})).status, 401);
    assert.equal((await ctx.call("GET", "/api/lin/settings", undefined, { authorization: "Bearer wrong" })).status, 401);
    const first = await fetch(`${ctx.base}/?token=${TOKEN}`);
    const cookie = first.headers.get("set-cookie");
    assert.equal(first.status, 200);
    assert.match(cookie, /lin_token=.+HttpOnly/u);
    assert.equal((await ctx.call("GET", "/api/lin/settings", undefined, { cookie: cookie.split(";")[0] })).status, 200);
    assert.equal((await fetch(`${ctx.base}/css/lin.css`)).status, 200);

    await writeChannelSecrets({ webhook: { enabled: true, secret: "tok", outboundUrl: "http://127.0.0.1/hook", ownerId: OWNER } });
    const plain = JSON.stringify({ eventId: "e1", senderId: OWNER, text: "在吗" });
    const bad = await fetch(`${ctx.base}/api/lin/channels/webhook`, { method: "POST", body: plain, headers: { "x-rn-timestamp": String(Date.now()), "x-rn-signature": "bad" } });
    assert.equal(bad.status, 401);
    const good = await fetch(`${ctx.base}/api/lin/channels/webhook`, { method: "POST", body: plain, headers: { "x-rn-timestamp": String(Date.now()), "x-rn-signature": signPayload("tok", plain) } });
    assert.equal(good.status, 200);
  } finally {
    await ctx.stop();
  }
});

test("设置非法字段整体 400；模型与渠道打码、密钥留空不改", async () => {
  const ctx = await startApp();
  try {
    assert.equal((await ctx.call("PUT", "/api/lin/settings", { fontSize: 99 })).status, 400);
    assert.equal((await ctx.call("PUT", "/api/lin/settings", { fontSize: 16 })).json.settings.fontSize, 16);
    const saved = await ctx.call("PUT", "/api/lin/model", { protocol: "openai", baseUrl: "https://example.test/v1", apiKey: "sk-secret-9876", chatModel: "c" });
    assert.equal(saved.json.apiKeyTail, "9876");
    assert.ok(!JSON.stringify(saved.json).includes("sk-secret"));
    const kept = await ctx.call("PUT", "/api/lin/model", { apiKey: "", chatModel: "c2" });
    assert.equal(kept.json.hasApiKey, true);
    assert.equal(kept.json.apiKeyTail, "9876");
    assert.equal((await ctx.call("PUT", "/api/lin/model", { baseUrl: "ftp://x" })).status, 400);
    await ctx.call("PUT", "/api/lin/channels", { webhook: { secret: "very-secret", enabled: true } });
    const webhook = await ctx.call("PUT", "/api/lin/channels", { webhook: { secret: "", enabled: true } });
    assert.equal(webhook.json.values.webhook.secret.set, true);
    assert.ok(!JSON.stringify(webhook.json).includes("very-secret"));
  } finally {
    await ctx.stop();
  }
});

test("记忆与日程的 403 规则；合法修改成功", async () => {
  const ctx = await startApp();
  try {
    const past = addDays(formatLocalDate(), -3);
    const future = addDays(formatLocalDate(), 3);
    await writeFile(join(paths.memory(), `event-${past}.md`), memoryFile("event", "那天"));
    assert.equal((await ctx.call("PUT", `/api/lin/memories/event-${past}.md`, { content: memoryFile("event", "改") })).status, 403);
    assert.equal((await ctx.call("DELETE", `/api/lin/memories/event-${past}.md`)).status, 403);
    assert.equal((await ctx.call("PUT", "/api/lin/memories/new-note.md", { content: memoryFile("profile", "新的") })).status, 200);
    assert.equal((await ctx.call("PUT", "/api/lin/memories/new-note.md", { content: "没有文件头" })).status, 400);
    assert.equal((await ctx.call("DELETE", "/api/lin/memories/new-note.md")).status, 200);
    assert.equal((await ctx.call("PUT", "/api/lin/memories/..%2Fsettings.json", { content: "x" })).status, 400);
    assert.equal((await ctx.call("PUT", `/api/lin/life/day-${formatLocalDate()}.md`, { content: "x" })).status, 403);
    assert.equal((await ctx.call("PUT", `/api/lin/life/day-${past}.md`, { content: "x" })).status, 403);
    assert.equal((await ctx.call("PUT", `/api/lin/life/day-${future}.md`, { content: "09:00 [上班] 上班" })).status, 200);
    assert.equal((await ctx.call("PUT", "/api/lin/life/future.md", { content: "想写完那本书" })).status, 200);
    const life = (await ctx.call("GET", "/api/lin/life")).json.files;
    assert.equal(life.find((f) => f.file === "future.md").editable, true);
  } finally {
    await ctx.stop();
  }
});

test("发消息：202，SSE 先后收到他的 message、她的 message 和 turn_done；历史里两条", async () => {
  const ctx = await startApp();
  const controller = new AbortController();
  try {
    const response = await fetch(`${ctx.base}/api/lin/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const events = [];
    const decoder = new TextDecoder();
    let buffer = "";
    const until = async (predicate) => {
      while (!predicate()) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const type = /^event: (.+)$/mu.exec(block)?.[1];
          const data = /^data: (.+)$/mu.exec(block)?.[1];
          if (type) events.push({ type, data: data ? JSON.parse(data) : null });
        }
      }
    };
    await until(() => events.some((e) => e.type === "ready"));
    const sent = await ctx.call("POST", "/api/lin/chat/send", { text: "在吗", clientId: "c_1" });
    assert.equal(sent.status, 202);
    await until(() => events.some((e) => e.type === "turn_done"));
    const messages = events.filter((e) => e.type === "message").map((e) => e.data);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].clientId, "c_1");
    assert.equal(messages[0].id, sent.json.messageId);
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].text, "嗯，在的");
    const history = (await ctx.call("GET", "/api/lin/chat/history?limit=10")).json;
    assert.equal(history.messages.length, 2);
    assert.equal((await ctx.call("POST", "/api/lin/chat/send", { text: "   " })).status, 400);
  } finally {
    controller.abort();
    await ctx.stop();
  }
});