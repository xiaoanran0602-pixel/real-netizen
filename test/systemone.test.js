// 决策模型客户端：地址拼接、答案规范化、失败一律返回 null、没配置不发请求。
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeJsonAtomic } from "../src/store/files.js";
import { paths } from "../src/config/paths.js";
import { DEFAULT_DECISION_MODEL, mergeModelPatch, normalizeModelSecrets } from "../src/config/secrets.js";
import { decide, normalizeAnswer, systemoneUrl } from "../src/model/systemone.js";
import { useTempData } from "./helpers.js";

test("systemone 地址拼接", () => {
  assert.equal(systemoneUrl("https://decide.example.com"), "https://decide.example.com/v1/systemone");
  assert.equal(systemoneUrl("https://decide.example.com/v1/"), "https://decide.example.com/v1/systemone");
  assert.equal(systemoneUrl("https://x/v1/systemone"), "https://x/v1/systemone");
});

test("决策模型：默认关闭，显式清空 = 不用", () => {
  assert.equal(normalizeModelSecrets({}).decisionModel, DEFAULT_DECISION_MODEL);
  assert.equal(normalizeModelSecrets({ decisionModel: "" }).decisionModel, "");
  const merged = mergeModelPatch(normalizeModelSecrets({ baseUrl: "https://a", chatModel: "c" }), { decisionModel: "" });
  assert.equal(merged.secrets.decisionModel, "");
});

test("答案规范化：choice 原样、score 下标换档位名、noul 转 yes/no", () => {
  const choice = normalizeAnswer({ type: "choice", choice: "chitchat", confidence: 0.7, probabilities: { greeting: 0.2, chitchat: 0.8 } }, {});
  assert.deepEqual(choice.probabilities, { greeting: 0.2, chitchat: 0.8 });
  const score = normalizeAnswer({ type: "score", probabilities: { 0: 0.4, 1: 0.6 } }, { criteria: ["随手", "认真"] });
  assert.deepEqual(score.probabilities, { 随手: 0.4, 认真: 0.6 });
  const noul = normalizeAnswer({ type: "noul", noul: 0.3 }, {});
  assert.equal(noul.p, 0.3);
  assert.ok(Math.abs(noul.probabilities.no - 0.7) < 1e-9);
  assert.equal(normalizeAnswer(null, {}), null);
  assert.equal(normalizeAnswer({ type: "choice" }, {}), null);
});

test("decide：成功解析；HTTP 错误、异常、没配置都返回 null", async () => {
  const { cleanup } = await useTempData();
  try {
    const questions = { r: { type: "choice", instructions: "?", criteria: { a: "A", b: "B" } } };
    // 没配置：不发请求
    let called = 0;
    const counting = async () => { called += 1; return new Response("{}"); };
    assert.equal(await decide({ state: "s", questions, fetchImpl: counting }), null);
    assert.equal(called, 0);

    await writeJsonAtomic(paths.modelSecrets(), { protocol: "openai", baseUrl: "https://gw", apiKey: "sk-x", chatModel: "c", decisionModel: "d-m" });
    let seen;
    const ok = async (url, init) => {
      seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
      return new Response(JSON.stringify({ answers: { r: { type: "choice", probabilities: { a: 0.9, b: 0.1 } } } }));
    };
    const result = await decide({ state: "s", questions, fetchImpl: ok });
    assert.deepEqual(result.r.probabilities, { a: 0.9, b: 0.1 });
    assert.equal(seen.url, "https://gw/v1/systemone");
    assert.equal(seen.body.model, "d-m");
    assert.equal(seen.auth, "Bearer sk-x");

    assert.equal(await decide({ state: "s", questions, fetchImpl: async () => new Response("no", { status: 403 }) }), null);
    assert.equal(await decide({ state: "s", questions, fetchImpl: async () => { throw new Error("boom"); } }), null);
  } finally {
    await cleanup();
  }
});
