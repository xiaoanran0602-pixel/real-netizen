// recall：预算截断、分层配额、沉底只在强提示时以概括浮现、「放进提示词但没聊到」不算想起。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { paths } from "../src/config/paths.js";
import { recalledInTurn, recallSelector, selectMemories, SUNK_RECALL_MIN_SCORE } from "../src/companion/recall.js";
import { readStrengthTable, updateStrengthTable } from "../src/companion/strength.js";
import { readMemories } from "../src/companion/memory.js";
import { at, useTempData } from "./helpers.js";

const today = "2026-10-10";
const m = (file, type, body, extra = {}) => ({ file, name: file, description: extra.description ?? "", type, body, closed: false, mtimeMs: 0, created: "2026-10-01", ...extra });
const rec = (stability, lastRecalled, extra = {}) => ({ importance: "care", stability, lastRecalled, recallDays: [], pinned: false, gist: "", ...extra });

test("相关记忆按清晰度呈现，沉底记忆没有强线索不浮现", () => {
  const memories = [
    m("clear.md", "event", "上周聊了仙女座的神话"),
    m("blurry.md", "event", "他泰国回来晒伤了，背上掉皮像蜥蜴", { description: "晒伤那次" }),
    m("sunk.md", "event", "很久以前他说过想学吉他，买了一把雅马哈"),
  ];
  const table = { "clear.md": rec(30, "2026-10-08"), "blurry.md": rec(5, "2026-10-04", { gist: "他好像晒伤过" }), "sunk.md": rec(3, "2025-01-01") };
  const { text } = selectMemories({ memories, table, today, recentText: "仙女座", userName: "阿澄" });
  assert.match(text, /上周聊了仙女座的神话/u);
  assert.doesNotMatch(text, /吉他/u);
  const blurry = selectMemories({ memories, table, today, recentText: "晒伤", userName: "阿澄" }).text;
  assert.match(blurry, /他好像晒伤过/u);
  assert.doesNotMatch(blurry, /掉皮像蜥蜴/u);
});

test("sunk memory surfaces only on a strong cue, as gist", () => {
  const memories = [m("guitar.md", "event", "他说想学吉他，买了一把雅马哈吉他放在角落", { description: "他买过吉他" })];
  const table = { "guitar.md": rec(3, "2025-01-01", { gist: "他好像弹过吉他" }) };
  const weak = selectMemories({ memories, table, today, recentText: "音乐", userName: "阿澄" });
  assert.equal(weak.text, null);
  const strong = selectMemories({ memories, table, today, recentText: "我把那把雅马哈吉他翻出来了，想重新学吉他", userName: "阿澄" });
  assert.match(strong.text, /他好像弹过吉他/u);
  assert.ok(SUNK_RECALL_MIN_SCORE >= 6);
});

test("foundation never sinks; budget truncates and foundation layer keeps priority", () => {
  const long = "很长的一段关于他的事".repeat(20);
  const memories = [m("p.md", "profile", "他在做动画，住上海"), ...Array.from({ length: 40 }, (_, i) => m(`e${i}.md`, "event", `${long}${i}`, { updated: `2026-10-0${(i % 9) + 1}` }))];
  const table = { "p.md": rec(1, "2020-01-01", { importance: "core", gist: "他好像在做动画" }) };
  const { text } = selectMemories({ memories, table, today, recentText: "很长的一段关于他的事", userName: "阿澄", budget: 1200 });
  assert.match(text, /阿澄这个人：\n- 他好像在做动画/u);
  assert.ok(text.length < 1500, `text length ${text.length}`);
});

test("pinned outranks unpinned and stays at least blurry", () => {
  const memories = [m("a.md", "event", "很久以前的一件小事甲"), m("b.md", "event", "很久以前的一件小事乙")];
  const table = { "a.md": rec(1, "2020-01-01", { pinned: true, gist: "甲的轮廓" }), "b.md": rec(1, "2020-01-01") };
  const { text } = selectMemories({ memories, table, today, recentText: "", userName: "阿澄" });
  assert.match(text ?? "", /甲的轮廓/u);
  assert.doesNotMatch(text ?? "", /乙/u);
});

test("闲聊只带熟悉的轮廓，不自动补最新往事、近况或未完话题", () => {
  const memories = [
    m("work.md", "profile", "他做动画。十年前在甲公司，后来跳槽乙公司，参与项目丙。", { description: "他做动画，也想做自己的作品" }),
    m("taste.md", "preference", "他爱电影，尤其《甲》《乙》《丙》。", { description: "他喜欢电影" }),
    m("event.md", "event", "昨天说了复查肝功能，周三去医院", { updated: today }),
    m("recent.md", "recent", "背上晒伤了", { expires: "2026-10-17" }),
    m("thread.md", "thread", "答应讲旅行的事"),
  ];
  const { text, picked } = selectMemories({ memories, table: {}, today, recentText: "哈哈", userName: "阿澄" });
  assert.match(text, /他做动画，也想做自己的作品/u);
  assert.match(text, /他喜欢电影/u);
  assert.doesNotMatch(text, /甲公司|项目丙|医院|晒伤|旅行/u);
  assert.ok(picked.every((item) => item.mode === "gist"));
});

test("概括不等于遗忘：明确追问时仍能取回清晰的细节，刚讲过则不重复展开", () => {
  const memory = m("trip.md", "event", "那次北海道旅行去了神威岬，坐巴士过去，在海边等了很久。", { description: "那次北海道旅行很难忘" });
  const input = { memories: [memory], table: {}, today, userName: "阿澄" };
  const weak = selectMemories({ ...input, recentText: "旅行" });
  assert.match(weak.text, /旅行很难忘/u);
  assert.doesNotMatch(weak.text, /巴士|等了很久/u);
  const repeated = selectMemories({ ...input, recentText: "北海道神威岬的旅行真好", previousAssistantText: memory.body });
  assert.equal(repeated.picked[0].mode, "gist");
  const asked = selectMemories({ ...input, recentText: "你还记得北海道神威岬那次怎么过去的吗？", previousAssistantText: memory.body });
  assert.equal(asked.picked[0].mode, "full");
  assert.match(asked.text, /坐巴士过去/u);
});

test("没有摘要的旧记忆用短轮廓兜底，不把长正文原样塞回去", () => {
  const body = "他喜欢做自己的作品。" + "很长的具体经历和日期。".repeat(30);
  const { text, picked } = selectMemories({ memories: [m("old.md", "profile", body)], table: {}, today, recentText: "嗯", userName: "阿澄" });
  assert.match(text, /他喜欢做自己的作品/u);
  assert.ok(picked[0].text.length <= 121);
  assert.doesNotMatch(text, /很长的具体经历/u);
});

test("recalled only when the turn actually mentions it (≥2 keywords)", () => {
  const picked = [{ entry: m("liver.md", "event", "他下周三要去复查肝功能"), text: "他下周三要去复查肝功能" }, { entry: m("cat.md", "self", "她养了一只橘猫"), text: "她养了一只橘猫" }];
  const recalled = recalledInTurn(picked, "复查结果出来了吗\n肝功能还行就好");
  assert.deepEqual(recalled.map((e) => e.file), ["liver.md"]);
});

test("recallSelector: afterTurn reinforces only memories that came up", async () => {
  const { cleanup } = await useTempData();
  try {
    await mkdir(paths.memory(), { recursive: true });
    await writeFile(join(paths.memory(), "liver.md"), "---\nname: liver\nmetadata:\n  type: event\n  created: 2026-10-01\n---\n他下周三要去复查肝功能\n");
    await writeFile(join(paths.memory(), "cat.md"), "---\nname: cat\nmetadata:\n  type: self\n  created: 2026-10-01\n---\n她养了一只橘猫\n");
    const memories = await readMemories();
    const selector = await recallSelector({ memories, now: at(2026, 10, 10, 12), recentText: "复查肝功能的结果出来了", userName: "阿澄" });
    assert.match(selector.text, /复查肝功能/u);
    assert.match(selector.text, /橘猫/u);
    await updateStrengthTable(() => false);
    await selector.afterTurn("肝功能正常就好，复查辛苦了");
    const table = await readStrengthTable();
    assert.equal(table["liver.md"].lastRecalled, "2026-10-10");
    assert.notEqual(table["cat.md"].lastRecalled, "2026-10-10");
  } finally {
    await cleanup();
  }
});

test("她自己复述不强化；用户当前消息第二行提到的事仍正常强化", async () => {
  const { cleanup } = await useTempData();
  try {
    const memories = [m("liver.md", "profile", "他下周三复查肝功能", { description: "他担心身体" })];
    await updateStrengthTable((table) => { table["liver.md"] = rec(30, "2026-10-01"); });
    const unrelated = await recallSelector({ memories, now: at(2026, 10, 10, 12), recentText: "刚吃完饭", userName: "阿澄" });
    await unrelated.afterTurn("记得下周三复查肝功能");
    assert.equal((await readStrengthTable())["liver.md"].lastRecalled, "2026-10-01");
    const related = await recallSelector({ memories, now: at(2026, 10, 10, 12), recentText: "刚吃完饭\n复查肝功能的结果出来了", userName: "阿澄" });
    await related.afterTurn("那就好");
    assert.equal((await readStrengthTable())["liver.md"].lastRecalled, today);
  } finally {
    await cleanup();
  }
});

test("身体与通勤不从基础档案或置顶绕过门控；模糊承接只接最近一个问题", () => {
  const memories = [m("health.md", "profile", "他昨天感冒头疼", { description: "他的身体和头疼" }), m("commute.md", "recent", "感冒时坐公交，不骑自行车", { description: "最近坐公交上下班", expires: "2026-10-20" })];
  const input = { memories, table: { "commute.md": rec(30, today, { pinned: true }) }, today, userName: "阿澄" };
  assert.equal(selectMemories({ ...input, recentText: "早，" }).text, null);
  assert.equal(selectMemories({ ...input, recentText: "天气凉了不好起床" }).text, null);
  const answer = selectMemories({ ...input, recentText: "好多了", previousAssistantText: "今天头还疼吗？" });
  assert.match(answer.text, /头疼/u);
  assert.doesNotMatch(answer.text, /公交/u);
  assert.equal(selectMemories({ ...input, recentText: "不聊这个了", previousAssistantText: "今天头还疼吗？" }).text, null);
  assert.match(selectMemories({ ...input, recentText: "今天继续坐公交" }).text, /公交/u);
});

test("聊头疼不解锁所有健康档案，也不把拒绝聊健康当成健康线索", () => {
  const memories = [m("head.md", "recent", "昨天感冒头疼", { description: "昨天感冒头疼" }), m("liver.md", "profile", "去年复查肝功能", { description: "以前的肝功能复查" })];
  const input = { memories, table: {}, today, userName: "阿澄" };
  const text = selectMemories({ ...input, recentText: "今天头疼好多了" }).text;
  assert.match(text, /头疼/u);
  assert.doesNotMatch(text, /肝功能/u);
  assert.equal(selectMemories({ ...input, recentText: "别再问我头疼了" }).text, null);
});
