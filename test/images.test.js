// 生图：请求形状（gpt-image-1、low、size 与 quality 成对）、拍摄质感、失败时不换头像、不再联网搜图。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { paths } from "../src/config/paths.js";
import { updateSettings } from "../src/config/settings.js";
import { updateModelSecrets } from "../src/config/secrets.js";
import { executeDecision } from "../src/moments/execute.js";
import { buildImagePrompt, generateImage, IMAGE_MODEL, imagesUrl, looksNight } from "../src/moments/images.js";
import { readProfile } from "../src/moments/store.js";
import { at, useTempData } from "./helpers.js";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("接口地址：沿用模型网关，去掉 /v1、/messages、/chat/completions 再拼", () => {
  assert.equal(imagesUrl("https://api.openai.com"), "https://api.openai.com/v1/images/generations");
  assert.equal(imagesUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1/images/generations");
  assert.equal(imagesUrl("https://api.openai.com/v1/messages"), "https://api.openai.com/v1/images/generations");
  assert.equal(imagesUrl("https://x.test/v1/chat/completions"), "https://x.test/v1/images/generations");
});

test("提示词：照片带手机随手拍的质感，夜景换夜拍；头像是干净方图；都不要文字水印", () => {
  const photo = buildImagePrompt("傍晚办公室窗边，桌上半杯冷掉的咖啡", { kind: "photo", random: () => 0 });
  assert.match(photo, /^傍晚办公室窗边/u);
  assert.match(photo, /iPhone 原厂相机|手机/u);
  assert.match(photo, /不要出现任何文字、水印/u);
  assert.match(buildImagePrompt("楼顶看星星", { kind: "photo", night: true }), /夜里用手机拍/u);
  const avatar = buildImagePrompt("一只趴在书页上的橘猫，水彩插画", { kind: "avatar" });
  assert.match(avatar, /头像的方图/u);
  assert.ok(!/手抖/u.test(avatar), "头像不用手抖");
  assert.equal(looksNight("楼顶的星空", at(2026, 10, 10, 14)), true);
  assert.equal(looksNight("午饭的面", at(2026, 10, 10, 13)), false);
});

test("请求：gpt-image-2、quality=low，size 非 auto 时 quality 一定在；返回的 PNG 存进 media", async () => {
  const { cleanup } = await useTempData();
  try {
    await updateModelSecrets({ protocol: "anthropic", baseUrl: "https://gw.test/v1", apiKey: "sk-test-1234", chatModel: "m" });
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const file = await generateImage("一只趴在书页上的橘猫", { kind: "avatar", fetchImpl });
    assert.match(file, /^[a-f0-9]{40}\.png$/u);
    assert.ok((await readFile(`${paths.media()}/${file}`)).length > 0);
    const [request] = requests;
    assert.equal(request.url, "https://gw.test/v1/images/generations");
    assert.equal(request.headers.authorization, "Bearer sk-test-1234");
    assert.equal(request.body.model, IMAGE_MODEL);
    assert.equal(request.body.quality, "low");
    assert.equal(request.body.size, "1024x1024");
    const photo = await generateImage("窗边的咖啡", { kind: "photo", fetchImpl });
    assert.ok(photo);
    assert.equal(requests[1].body.size, "1024x1536", "照片默认竖拍（像手机）");
  } finally {
    await cleanup();
  }
});

test("自定义 imageModel 进入请求体；默认用 gpt-image-1", async () => {
  const { cleanup } = await useTempData();
  try {
    await updateModelSecrets({ protocol: "openai", baseUrl: "https://gw.test/v1", apiKey: "sk-test-1234", chatModel: "m" });
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await generateImage("一只趴在书页上的橘猫", { kind: "avatar", fetchImpl });
    assert.equal(requests[0].model, IMAGE_MODEL, "默认 gpt-image-1");
    await updateSettings({ imageModel: "my-image-model" });
    await generateImage("窗边的咖啡", { kind: "photo", fetchImpl });
    assert.equal(requests[1].model, "my-image-model");
  } finally {
    await cleanup();
  }
});

test("imagesEnabled=false：不发起任何生图请求，直接返回 null", async () => {
  const { cleanup } = await useTempData();
  try {
    await updateModelSecrets({ protocol: "openai", baseUrl: "https://gw.test/v1", apiKey: "sk-test-1234", chatModel: "m" });
    await updateSettings({ imagesEnabled: false });
    let called = false;
    const fetchImpl = async () => {
      called = true;
      throw new Error("should not call");
    };
    assert.equal(await generateImage("一只猫", { kind: "avatar", fetchImpl }), null);
    assert.equal(called, false);
  } finally {
    await cleanup();
  }
});

test("生图失败（HTTP 错误、没返回图、没配模型）都返回 null，不抛错", async () => {
  const { cleanup } = await useTempData();
  try {
    assert.equal(await generateImage("没配模型", { fetchImpl: async () => { throw new Error("should not call"); } }), null);
    await updateModelSecrets({ protocol: "anthropic", baseUrl: "https://gw.test", apiKey: "sk-x", chatModel: "m" });
    assert.equal(await generateImage("x", { fetchImpl: async () => new Response("err", { status: 500 }) }), null);
    assert.equal(await generateImage("x", { fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) }), null);
    assert.equal(await generateImage("x", { fetchImpl: async () => { throw new Error("network"); } }), null);
    assert.equal(await generateImage("   ", { fetchImpl: async () => { throw new Error("should not call"); } }), null);
  } finally {
    await cleanup();
  }
});

test("换头像：生不出图就不换（资料、记忆都不动）；生成成功才换，并记下她写的是什么图", async () => {
  const { cleanup } = await useTempData();
  try {
    const failed = await executeDecision({ action: "avatar", imagePrompt: "雨夜窗玻璃上的水珠，方图" }, "manual", new Date(), { bridge: {}, generate: async () => null });
    assert.deepEqual(failed, { action: "none", detail: "image-failed" });
    assert.equal((await readProfile()).avatar, undefined);
    const ok = await executeDecision({ action: "avatar", imagePrompt: "雨夜窗玻璃上的水珠，蓝色调，方图", imageCaption: "雨夜窗上的水珠" }, "manual", new Date(), { bridge: {}, generate: async (prompt, options) => (options.kind === "avatar" ? "a".repeat(40) + ".png" : null) });
    assert.equal(ok.action, "avatar");
    const profile = await readProfile();
    assert.equal(profile.avatar.file, "a".repeat(40) + ".png");
    assert.equal(profile.avatar.query, "雨夜窗上的水珠");
    assert.equal(await executeDecision({ action: "avatar" }, "manual", new Date(), { bridge: {}, generate: async () => "x" }).then((r) => r.detail), "no-prompt");
  } finally {
    await cleanup();
  }
});

test("主动发图：先生图再交给渠道，带上她记的这张图是什么；朋友圈配图同样走生成", async () => {
  const { cleanup } = await useTempData();
  try {
    const calls = [];
    const bridge = { sendProactive: async (...args) => (calls.push(args), true) };
    const generate = async () => "b".repeat(40) + ".png";
    const result = await executeDecision({ action: "message", text: "你看这个云", imagePrompt: "办公室窗外一大团低云，手机随手拍", imageCaption: "窗外的低云" }, "idle", new Date(), { bridge, generate });
    assert.equal(result.action, "message");
    assert.deepEqual(calls[0], ["你看这个云", "b".repeat(40) + ".png", undefined, "窗外的低云"]);
    const post = await executeDecision({ action: "post", text: "今天的云", imagePrompt: "楼下的云" }, "idle", new Date(), { bridge, generate });
    assert.equal(post.action, "post");
    const moments = JSON.parse(await readFile(paths.moments(), "utf8"));
    assert.equal(moments.posts[0].images[0], "b".repeat(40) + ".png");
    assert.equal(moments.posts[0].imageCaption, "楼下的云");
  } finally {
    await cleanup();
  }
});

test("不再联网搜图：源码里没有必应搜图", async () => {
  const source = await readFile(new URL("../src/moments/images.js", import.meta.url), "utf8");
  assert.ok(!/bing\.com/u.test(source));
  assert.ok(!/findImage/u.test(source));
});
