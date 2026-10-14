// 写进记忆、念头的生成提示词：平实地写事实，不再要求「她的口吻」（免得文学腔从记忆回流进聊天提示词）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMON_RULES, GIST_FORMAT, weekSummaryTask } from "../src/companion/consolidation.js";
import { extractPrompt } from "../src/inner/thought-store.js";

const settings = { companionName: "林澈", userName: "阿澄" };

test("记忆整理：通用规则、模糊轮廓、周总结都要求平实地写，不提她的口吻", () => {
  const texts = [COMMON_RULES(settings, "2026-10-13").join("\n"), GIST_FORMAT, weekSummaryTask("2026-W42", false), weekSummaryTask("2026-W42", true)];
  for (const text of texts) {
    assert.doesNotMatch(text, /口吻/u, text);
  }
  assert.match(GIST_FORMAT, /平实地写，不修辞不打比方/u);
  assert.match(weekSummaryTask("2026-W42", false), /平实地写，不修辞不打比方/u);
  assert.match(COMMON_RULES(settings, "2026-10-13").join("\n"), /不修辞不打比方/u);
});

test("念头抽取：一句平实的话，写具体的事，不提她的口吻", () => {
  const prompt = extractPrompt("他：周五交稿吗\n她：嗯", [{ id: "t1", strength: 40, content: "稿子周五交" }]);
  assert.doesNotMatch(prompt, /口吻/u);
  assert.match(prompt, /一句平实的话，写具体的事/u);
});
