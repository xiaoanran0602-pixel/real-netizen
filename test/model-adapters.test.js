// 模型适配层：两种协议的 URL、请求体、流解析、错误归一化与回退（本地假 http 服务）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicUrl } from "../src/model/anthropic.js";
import { openaiUrl } from "../src/model/openai.js";
import { complete, ModelError, testModels } from "../src/model/client.js";
import { updateSettings } from "../src/config/settings.js";
import { useFakeModel } from "./fake-model.js";
import { useTempData } from "./helpers.js";

test("url joining for both protocols", () => {
  assert.equal(anthropicUrl("https://gw.test"), "https://gw.test/v1/messages");
  assert.equal(anthropicUrl("https://gw.test/"), "https://gw.test/v1/messages");
  assert.equal(anthropicUrl("https://gw.test/v1"), "https://gw.test/v1/messages");
  assert.equal(anthropicUrl("https://gw.test/v1/messages"), "https://gw.test/v1/messages");
  assert.equal(openaiUrl("https://gw.test"), "https://gw.test/v1/chat/completions");
  assert.equal(openaiUrl("https://gw.test/v1/"), "https://gw.test/v1/chat/completions");
  assert.equal(openaiUrl("https://gw.test/openai/chat/completions"), "https://gw.test/openai/chat/completions");
});

test("anthropic: headers, adaptive thinking, system split with cache_control, first user + merge, streaming", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel(() => ({ text: "在地铁上，你呢" }), { suffix: "/v1" });
  try {
    const deltas = [];
    const text = await complete({
      role: "chat",
      system: { stable: "人设", dynamic: "现在" },
      messages: [
        { role: "assistant", content: "早" },
        { role: "user", content: "在干嘛" },
        { role: "user", content: "人呢" },
      ],
      stream: true,
      onDelta: (d) => deltas.push(d),
    });
    assert.equal(text, "在地铁上，你呢");
    assert.equal(deltas.join(""), text);
    const [request] = fake.requests;
    assert.equal(request.url, "/v1/messages");
    assert.equal(request.headers["x-api-key"], "sk-test-secret-1234");
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(request.body.model, "chat-m");
    assert.deepEqual(request.body.thinking, { type: "adaptive" });
    assert.deepEqual(request.body.output_config, { effort: "low" });
    assert.equal(request.body.max_tokens, 2048);
    assert.deepEqual(request.body.system, [
      { type: "text", text: "人设", cache_control: { type: "ephemeral" } },
      { type: "text", text: "现在" },
    ]);
    assert.deepEqual(request.body.messages, [{ role: "user", content: "在干嘛\n\n人呢" }]);
    assert.equal(request.body.stream, true);
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("anthropic non-stream ignores thinking blocks; reasoning off sends no thinking", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel(() => ({ text: "嗯" }));
  try {
    await updateSettings({ reasoningLevel: "off" });
    assert.equal(await complete({ messages: [{ role: "user", content: "hi" }] }), "嗯");
    assert.equal(fake.requests[0].url, "/v1/messages");
    assert.equal("thinking" in fake.requests[0].body, false);
    assert.equal("output_config" in fake.requests[0].body, false);
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("openai: bearer, system message first, reasoning_effort, stream parsing", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel(() => ({ text: "好的好的" }), { protocol: "openai" });
  try {
    await updateSettings({ backgroundReasoningLevel: "high" });
    const text = await complete({ role: "background", system: { stable: "A", dynamic: "B" }, messages: [{ role: "user", content: "x" }], stream: true });
    assert.equal(text, "好的好的");
    const [request] = fake.requests;
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer sk-test-secret-1234");
    assert.equal(request.body.model, "bg-m");
    assert.equal(request.body.reasoning_effort, "high");
    assert.deepEqual(request.body.messages[0], { role: "system", content: "A\n\nB" });
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("400 on reasoning params → retry once without them", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel((req) => (req.body.output_config ? { status: 400, text: "unknown field output_config" } : { text: "ok" }));
  try {
    assert.equal(await complete({ messages: [{ role: "user", content: "hi" }] }), "ok");
    assert.equal(fake.requests.length, 2);
    assert.equal("thinking" in fake.requests[1].body, false);
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("errors normalize to kinds without leaking the key", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel(() => ({ status: 500, raw: "boom key=sk-test-secret-1234" }));
  try {
    await assert.rejects(complete({ messages: [{ role: "user", content: "hi" }] }), (error) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.kind, "http");
      assert.equal(error.status, 500);
      assert.equal(error.message.includes("sk-test-secret-1234"), false);
      return true;
    });
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("empty reply → kind empty; unreachable → kind network; missing config → kind config", async () => {
  const { cleanup } = await useTempData();
  try {
    await assert.rejects(complete({ messages: [{ role: "user", content: "hi" }] }), (e) => e.kind === "config");
    const fake = await useFakeModel(() => ({ text: "" }));
    await assert.rejects(complete({ messages: [{ role: "user", content: "hi" }] }), (e) => e.kind === "empty");
    await fake.close();
    await assert.rejects(complete({ messages: [{ role: "user", content: "hi" }] }), (e) => e.kind === "network");
  } finally {
    await cleanup();
  }
});

test("background failure falls back to chat model once", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel((req) => (req.body.model === "bg-m" ? { status: 404, text: "no such model" } : { text: "from chat model" }));
  try {
    assert.equal(await complete({ role: "background", messages: [{ role: "user", content: "x" }] }), "from chat model");
    assert.deepEqual(fake.requests.map((r) => r.body.model), ["bg-m", "chat-m"]);
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("testModels reports each role separately", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel((req) => (req.body.model === "bg-m" ? { status: 401, text: "bad key" } : { text: "在" }));
  try {
    const result = await testModels();
    assert.equal(result.chat.ok, true);
    assert.equal(result.background.ok, false);
    assert.equal(result.background.error.kind, "http");
    assert.equal(result.background.error.status, 401);
    assert.equal(fake.requests[0].body.max_tokens, 32);
  } finally {
    await fake.close();
    await cleanup();
  }
});
