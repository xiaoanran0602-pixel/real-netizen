// 记忆整理：中文计词门槛、游标、合并调度、JSON 解析与非法项过滤、过去文件被拒、今天日程只追加（假模型）。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { paths } from "../src/config/paths.js";
import { updateSettings } from "../src/config/settings.js";
import { createMemoryCurator, parseCuratorOutput } from "../src/companion/memory-curator.js";
import { validateOps } from "../src/companion/memory-ops.js";
import { appendMessage, getMainConversationId } from "../src/store/conversation.js";
import { readState } from "../src/store/state.js";
import { countWords } from "../src/util/text.js";
import { useFakeModel } from "./fake-model.js";
import { at, useTempData } from "./helpers.js";

const now = at(2026, 10, 10, 14, 30);
const MEMORY = (name, type, body) => `---\nname: ${name}\ndescription: "${body}"\nmetadata:\n  type: ${type}\n  created: 2026-10-10\n  updated: 2026-10-10\n---\n${body}\n`;

async function seed(texts) {
  const id = await getMainConversationId();
  let t = now.getTime() - 60_000 * texts.length;
  for (const [role, text] of texts) await appendMessage(id, { role, text, source: role === "user" ? "web" : "chat", at: (t += 60_000) });
  return id;
}

test("chinese counts each character as a word", () => {
  assert.equal(countWords("嗯"), 1);
  assert.equal(countWords("好的"), 2);
  assert.equal(countWords("ok fine"), 2);
  assert.equal(countWords("我今天去复查了 ok"), 8);
});

test("parse curator output; events default false; missing ops → null", () => {
  const parsed = parseCuratorOutput('好的```json\n{"ops":[],"recalled":["a.md",3],"events":{"deepTalk":true,"praisedByHim":"yes"}}\n```');
  assert.deepEqual(parsed.recalled, ["a.md"]);
  assert.equal(parsed.events.deepTalk, true);
  assert.equal(parsed.events.praisedByHim, false);
  assert.equal(parsed.events.askedAboutHer, false);
  assert.equal(parseCuratorOutput("Nothing to save."), null);
  assert.equal(parseCuratorOutput('{"recalled":[]}'), null);
});

test("invalid ops are filtered before execution", () => {
  const { ops, rejected } = validateOps([
    { op: "write", file: "../etc.md", content: MEMORY("x", "event", "x") },
    { op: "write", file: "ok.md", content: "没有文件头" },
    { op: "rename", file: "a.md" },
    { op: "append", file: "life/day-2026-10-10.md", text: "" },
    { op: "write", file: "fine.md", content: MEMORY("fine", "recent", "他感冒了"), importance: "care" },
    "nonsense",
  ]);
  assert.deepEqual(ops.map((op) => op.file), ["fine.md"]);
  assert.equal(rejected.length, 5);
});

test("short new user text only advances the cursor, no model call", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel(() => ({ text: '{"ops":[]}' }));
  try {
    await seed([["user", "嗯"], ["assistant", "怎么了"]]);
    const curator = createMemoryCurator({ now: () => now });
    assert.deepEqual(await curator.schedule(), { skipped: "too-short" });
    assert.equal(fake.requests.length, 0);
    const state = await readState();
    assert.ok(state.memoryCursor);
    assert.deepEqual(await curator.schedule(), { skipped: "nothing-new" });
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("applies ops through the write guard: past rejected, today's day append-only, cursor advances", async () => {
  const { cleanup } = await useTempData();
  const output = {
    ops: [
      { op: "write", file: "user-cold.md", content: MEMORY("user-cold", "recent", "他感冒了"), importance: "care" },
      { op: "write", file: "event-2026-10-09.md", content: MEMORY("event-2026-10-09", "event", "改过去") },
      { op: "write", file: "life/day-2026-10-10.md", content: "整篇重写" },
      { op: "append", file: "life/day-2026-10-10.md", text: "实际：15:20 [开会] 临时被叫去开会" },
      { op: "delete", file: "life/day-2026-10-09.md" },
    ],
    recalled: ["user-job.md"],
    events: { askedAboutHer: true },
  };
  const fake = await useFakeModel(() => ({ text: JSON.stringify(output) }));
  const seen = {};
  try {
    await mkdir(paths.life(), { recursive: true });
    await writeFile(join(paths.life(), "day-2026-10-10.md"), "08:30 [起床] 起床\n");
    await writeFile(join(paths.life(), "day-2026-10-09.md"), "昨天\n");
    await writeFile(join(paths.memory(), "event-2026-10-09.md"), MEMORY("event-2026-10-09", "event", "原来的"));
    await updateSettings({ userName: "阿澄" });
    await seed([["user", "我今天有点感冒，嗓子疼"], ["assistant", "多喝水"]]);
    const curator = createMemoryCurator({ now: () => now, hooks: { onWritten: (ops) => (seen.written = ops), onRecalled: (r) => (seen.recalled = r), onEvents: (e) => (seen.events = e) } });
    const result = await curator.schedule();
    assert.deepEqual(result.applied.map((op) => `${op.op}:${op.file}`), ["write:user-cold.md", "append:life/day-2026-10-10.md"]);
    assert.equal(result.rejected.length, 3);
    assert.equal(await readFile(join(paths.life(), "day-2026-10-10.md"), "utf8"), "08:30 [起床] 起床\n实际：15:20 [开会] 临时被叫去开会\n");
    assert.match(await readFile(join(paths.memory(), "event-2026-10-09.md"), "utf8"), /原来的/u);
    assert.equal(await readFile(join(paths.life(), "day-2026-10-09.md"), "utf8"), "昨天\n");
    assert.deepEqual(seen.recalled, [], "不存在或用户未谈及的旧事不强化");
    assert.equal(seen.events.askedAboutHer, true);
    assert.equal(seen.written.length, 2);
    // 提示词：后台模型、包含今天日程全文与新消息标记。
    const request = fake.requests[0];
    assert.equal(request.body.model, "bg-m");
    assert.match(request.body.messages[0].content, /### life\/day-2026-10-10\.md\n08:30 \[起床\] 起床/u);
    assert.match(request.body.messages[0].content, /（以下是新的）\n阿澄：我今天有点感冒/u);
    const state = await readState();
    assert.ok(state.memoryCursor);
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("unparseable output retries once with the error, then gives up without moving the cursor", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel(() => ({ text: "Nothing to save." }));
  try {
    await seed([["user", "今天天气不错我出去走了走"], ["assistant", "去哪了"]]);
    const curator = createMemoryCurator({ now: () => now });
    assert.deepEqual(await curator.schedule(), { failed: "unparseable" });
    assert.equal(fake.requests.length, 2);
    assert.match(fake.requests[1].body.messages[0].content, /没法解析/u);
    assert.equal((await readState()).memoryCursor, undefined);
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("requests during a run merge into one follow-up run", async () => {
  const { cleanup } = await useTempData();
  let calls = 0;
  const fake = await useFakeModel(() => {
    calls += 1;
    return { text: '{"ops":[]}', delayMs: 80 };
  });
  try {
    const id = await seed([["user", "第一句话说得比较长一点"]]);
    const curator = createMemoryCurator({ now: () => now });
    const first = curator.schedule();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await appendMessage(id, { role: "user", text: "第二句也挺长的一句话", source: "web", at: now.getTime() + 1 });
    const second = curator.schedule();
    const third = curator.schedule();
    assert.equal(second, first);
    assert.equal(third, first);
    await first;
    assert.equal(calls, 2);
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("strength hooks: new memory gets importance, recalled reinforces, manifest excludes sunk", async () => {
  const { strengthHooks } = await import("../src/companion/curator-hooks.js");
  const { readStrengthTable, updateStrengthTable } = await import("../src/companion/strength.js");
  const { cleanup } = await useTempData();
  const fake = await useFakeModel(() => ({
    text: JSON.stringify({ ops: [{ op: "write", file: "user-cat.md", content: MEMORY("user-cat", "profile", "他养了一只猫"), importance: "core" }], recalled: ["user-job.md"], events: {} }),
  }));
  try {
    await mkdir(paths.memory(), { recursive: true });
    await writeFile(join(paths.memory(), "user-job.md"), MEMORY("user-job", "event", "他在做动画").replace("2026-10-10", "2026-09-01").replace("2026-10-10", "2026-09-01"));
    await writeFile(join(paths.memory(), "old-scrap.md"), MEMORY("old-scrap", "event", "很久以前的零碎").replace("2026-10-10", "2025-01-01").replace("2026-10-10", "2025-01-01"));
    await updateStrengthTable((table) => {
      table["old-scrap.md"] = { importance: "normal", stability: 3, lastRecalled: "2025-01-01", recallDays: [], pinned: false, gist: "" };
      table["user-job.md"] = { importance: "care", stability: 14, lastRecalled: "2026-09-20", recallDays: [], pinned: false, gist: "他好像在做动画" };
    });
    await seed([["user", "我还在做动画，我家猫今天又把杯子推下去了"], ["assistant", "它在练习物理"]]);
    const curator = createMemoryCurator({ now: () => now, hooks: strengthHooks() });
    await curator.schedule();
    const table = await readStrengthTable();
    assert.equal(table["user-cat.md"].importance, "core");
    assert.equal(table["user-cat.md"].stability, 3650);
    assert.equal(table["user-job.md"].lastRecalled, "2026-10-10");
    assert.ok(table["user-job.md"].stability > 14);
    const prompt = fake.requests[0].body.messages[0].content;
    assert.doesNotMatch(prompt, /old-scrap\.md/u);
    assert.match(prompt, /user-job\.md: 他好像在做动画/u);
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("后台 recalled 不能用她单方面的旧事复述给记忆加固", async () => {
  const { cleanup } = await useTempData();
  const fake = await useFakeModel(() => ({ text: '{"ops":[],"recalled":["liver.md"],"events":{}}' }));
  try {
    await mkdir(paths.memory(), { recursive: true });
    await writeFile(join(paths.memory(), "liver.md"), MEMORY("liver", "profile", "他下周三复查肝功能"));
    await seed([["user", "软件终于跑起来了"], ["assistant", "记得下周三复查肝功能"]]);
    let recalled;
    const curator = createMemoryCurator({ now: () => now, hooks: { onRecalled: (files) => { recalled = files; } } });
    await curator.schedule();
    assert.deepEqual(recalled, []);
  } finally {
    await fake.close();
    await cleanup();
  }
});

test("作品推荐随整理交给后台队列，带书名号的短标题不被寒暄门槛吞掉", async () => {
  const { cleanup } = await useTempData();
  const requests = [{ title: "活着", kind: "book", evidence: "《活着》" }];
  const fake = await useFakeModel(() => ({ text: JSON.stringify({ ops: [], mediaRequests: requests }) }));
  try {
    await seed([["user", "《活着》"], ["assistant", "记下了"]]);
    let received;
    const curator = createMemoryCurator({ now: () => now, hooks: { onMediaRequests: (...args) => { received = args; } } });
    await curator.schedule();
    assert.deepEqual(received[0], requests);
    assert.equal(received[1], "《活着》");
    assert.equal(received[2], "");
    assert.equal(fake.requests.length, 1, "复用原有整理调用，不增加每轮额外提取模型");
  } finally { await fake.close(); await cleanup(); }
});
