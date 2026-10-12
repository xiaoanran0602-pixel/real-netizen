// src/util/text.js 的纯函数单测（含 displayUserName 称呼回退）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, countWords, displayUserName, oneLine, overlapScore, sharedKeywordCount, splitParagraphs, tokenize } from "../src/util/text.js";

test("displayUserName：空白回退为「他」", () => {
  assert.equal(displayUserName(""), "他");
  assert.equal(displayUserName("   "), "他");
  assert.equal(displayUserName(null), "他");
  assert.equal(displayUserName(undefined), "他");
});

test("displayUserName：有名字时原样返回（去首尾空格）", () => {
  assert.equal(displayUserName("阿澄"), "阿澄");
  assert.equal(displayUserName("  阿澄  "), "阿澄");
});

test("countWords：中文按字数，英文按空白数", () => {
  assert.equal(countWords("你好世界"), 4);
  assert.equal(countWords("hello world"), 2);
});

test("tokenize 与 overlapScore：关键词重叠给分", () => {
  const query = tokenize("今天下雨");
  assert.ok(overlapScore(query, "今天下雨了") > overlapScore(query, "明天晴天"));
  assert.equal(overlapScore(query, ""), 0);
});

test("sharedKeywordCount 只算词重大于等于 1 的", () => {
  assert.ok(sharedKeywordCount("下雨了", "下雨天") >= 1);
});

test("clip / oneLine / splitParagraphs", () => {
  assert.equal(clip("abcdef", 3), "abc…");
  assert.equal(clip("abc", 3), "abc");
  assert.equal(oneLine("a\n\nb"), "a b");
  assert.deepEqual(splitParagraphs("a\n\nb\n\n  \n\nc"), ["a", "b", "c"]);
});
