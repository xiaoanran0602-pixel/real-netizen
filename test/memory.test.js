// 记忆与写入守卫测试（移植旧核心测试用例，补齐 write/append/delete 各分支）。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { paths } from "../src/config/paths.js";
import { parseFrontmatter, serializeMemoryFile } from "../src/companion/frontmatter.js";
import {
  buildMemoryDigest,
  formatMemoryDigest,
  invalidateMemoryCache,
  isMemoryExpired,
  normalizeMemoryType,
  parseMemoryFile,
  pickRelated,
  readMemories,
} from "../src/companion/memory.js";
import { useTempData } from "./helpers.js";

function entry(partial) {
  return { file: "x.md", name: "x", description: "", type: "profile", body: "", closed: false, mtimeMs: 0, ...partial };
}

test("parse memory frontmatter with nested metadata", () => {
  const parsed = parseMemoryFile('---\nname: sunburn\ndescription: "晒伤"\nmetadata:\n  type: recent\n  created: 2026-10-05\n  expires: 2026-10-12\n---\n背上晒伤。\n');
  assert.equal(parsed?.type, "recent");
  assert.equal(parsed?.expires, "2026-10-12");
  assert.equal(parsed?.body, "背上晒伤。");
  assert.equal(parsed?.description, "晒伤");
});

test("frontmatter roundtrip keeps unknown lines", () => {
  const source = '---\nname: x\ndescription: "说过的话：\\"嗯\\""\nmetadata:\n  node_type: memory\n  type: event\n  created: 2026-10-09\n  originSessionId: s_1\n---\n正文\n';
  const parsed = parseFrontmatter(source);
  const memory = parseMemoryFile(source);
  const out = serializeMemoryFile({ ...memory, extraTop: parsed.extraTop, extraMeta: parsed.extraMeta });
  assert.deepEqual(parseMemoryFile(out), memory);
  assert.match(out, /node_type: memory/u);
  assert.match(out, /originSessionId: s_1/u);
  assert.equal(memory.description, '说过的话："嗯"');
});

test("no frontmatter → null; CRLF and BOM tolerated", () => {
  assert.equal(parseMemoryFile("就一句话"), null);
  const parsed = parseMemoryFile("\uFEFF---\r\nname: a\r\nmetadata:\r\n  type: self\r\n  closed: true\r\n---\r\n她养猫\r\n");
  assert.equal(parsed?.type, "self");
  assert.equal(parsed?.closed, true);
  assert.equal(parsed?.body, "她养猫");
});

test("legacy memory types map to companion categories", () => {
  assert.equal(normalizeMemoryType("feedback"), "preference");
  assert.equal(normalizeMemoryType("project"), "recent");
  assert.equal(normalizeMemoryType("user"), "profile");
  assert.equal(normalizeMemoryType("thread"), "thread");
});

test("expired recent moves out of 近况 and can be recalled as 往事", () => {
  const sunburn = entry({ file: "sunburn.md", type: "recent", body: "他从普吉回来背上晒伤", expires: "2026-10-09" });
  assert.equal(isMemoryExpired(sunburn, "2026-10-10"), true);
  const digest = buildMemoryDigest({ memories: [sunburn], today: "2026-10-10", recentText: "" });
  assert.equal(digest.hisRecent.length, 0);
  const related = buildMemoryDigest({ memories: [sunburn], today: "2026-10-10", recentText: "普吉晒伤那次" }).related;
  assert.equal(related[0]?.file, "sunburn.md");
});

test("chinese bigram relevance", () => {
  const pool = [entry({ file: "liver.md", body: "他下周三要去复查肝" }), entry({ file: "cat.md", body: "她养了一只猫" })];
  assert.deepEqual(pickRelated(pool, "复查结果出来了，肝还行").map((item) => item.file), ["liver.md"]);
});

test("digest layers: open threads, self_daily keeps 3 days, latest events fill in", () => {
  const memories = [
    entry({ file: "t1.md", type: "thread", body: "他答应讲完那个故事" }),
    entry({ file: "t2.md", type: "thread", body: "聊完了", closed: true }),
    entry({ file: "d-old.md", type: "self_daily", body: "很久以前", created: "2026-10-01" }),
    entry({ file: "d-new.md", type: "self_daily", body: "昨天", created: "2026-10-09" }),
    entry({ file: "e1.md", type: "event", body: "聊了仙女座", updated: "2026-10-09" }),
  ];
  const digest = buildMemoryDigest({ memories, today: "2026-10-10", recentText: "" });
  assert.deepEqual(digest.openThreads.map((e) => e.file), ["t1.md"]);
  assert.deepEqual(digest.myRecent.map((e) => e.file), ["d-new.md"]);
  assert.deepEqual(digest.related.map((e) => e.file), ["e1.md"]);
  const text = formatMemoryDigest(digest, "阿澄");
  assert.match(text, /你们之前聊过、还没聊完的：\n- 他答应讲完那个故事/u);
  assert.match(text, /你想起来的往事：\n- （2026-10-09）聊了仙女座/u);
});

test("readMemories reads data/memory, skips broken files and MEMORY.md", async () => {
  const { cleanup } = await useTempData();
  try {
    await mkdir(paths.life(), { recursive: true });
    await writeFile(join(paths.memory(), "a.md"), "---\nname: a\nmetadata:\n  type: self\n---\n她养猫\n");
    await writeFile(join(paths.memory(), "broken.md"), "没有头");
    await writeFile(join(paths.memory(), "MEMORY.md"), "---\nname: idx\n---\n");
    await writeFile(join(paths.life(), "day-2026-10-10.md"), "08:00 起床");
    invalidateMemoryCache();
    const memories = await readMemories();
    assert.deepEqual(memories.map((m) => m.file), ["a.md"]);
  } finally {
    await cleanup();
  }
});
