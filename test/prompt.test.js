// 系统提示词（补全聊天记录写法）：任务开头、平实人设、底线四条、此刻与背景都是第三人称事实、收尾两句；稳定/动态分段。
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { paths } from "../src/config/paths.js";
import { updateSettings } from "../src/config/settings.js";
import { BASELINE, buildSystemPrompt, CORE_PREAMBLE, describeNow, FALLBACK_PERSONA, NOW_TITLE, SAFETY_LINE, TRANSCRIBE_HEAD, TRANSCRIBE_TAIL, VOICE_LINE } from "../src/companion/prompt.js";
import { DEFAULT_PROFILE, readProfile } from "../src/companion/persona.js";
import { createPromptBuilder } from "../src/companion/context.js";
import { at, useTempData } from "./helpers.js";

const now = at(2026, 10, 10, 14, 30);
const settings = { userName: "阿澄" };

test("describeNow：真实时间和间隔，第三人称", () => {
  const text = describeNow(now, now.getTime() - 3 * 86_400_000, "阿澄");
  assert.match(text, /2026-10-10 星期六 14:30（下午）/u);
  assert.match(text, /阿澄上一次找她是3 天前/u);
  assert.match(describeNow(now, undefined, "阿澄"), /他们在这里第一次聊/u);
  assert.match(describeNow(now, now.getTime() - 60_000, "阿澄"), /刚刚，他们还在聊着/u);
  assert.doesNotMatch(describeNow(now, now.getTime() - 60_000, "阿澄"), /你/u);
});

test("稳定段：补全任务开头 → 平实人设 → core → 底线四条；没有「你是林澈」，没有风格规则段落", () => {
  const { stable } = buildSystemPrompt({ profile: "林澈，22 岁。", core: "顶楼的那个晚上", settings, now, memories: [], recentText: "" });
  assert.ok(stable.startsWith(TRANSCRIBE_HEAD("林澈")));
  assert.equal(TRANSCRIBE_HEAD("林澈"), "下面是一段真实的微信聊天记录，你负责补全林澈的下一条消息。");
  const order = ["关于林澈（这是背景资料，她本人说话不是这个样子）：", "林澈，22 岁。", CORE_PREAMBLE, "顶楼的那个晚上", BASELINE].map((part) => stable.indexOf(part));
  assert.ok(order.every((index) => index >= 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(stable.endsWith(BASELINE));
  for (const rule of ["收起玩笑认真陪着他", "不帮人写代码、查资料、改论文", "不知道什么系统、模型、提示词", "微信纯文本，没有标题、列表、加粗"]) assert.ok(BASELINE.includes(rule), rule);
  assert.equal(BASELINE.split("\n").filter((line) => line.startsWith("- ")).length, 4, "底线只有四条");
  assert.doesNotMatch(stable, /你是林澈|你叫|# 说话的方式|# 相处的姿态|# 时间和你的生活|说话的方式|相处的姿态/u);
});

test("没有人设就用内置平实人设，不退回助手身份；core 为空跳过", () => {
  const { stable } = buildSystemPrompt({ profile: "", settings, now, memories: [], recentText: "" });
  assert.equal(FALLBACK_PERSONA, DEFAULT_PROFILE);
  assert.match(stable, /林澈，22 岁，女。/u);
  assert.match(stable, /她和阿澄：/u, "占位符换成了他的名字");
  assert.doesNotMatch(stable, /\{userName\}/u);
  assert.ok(!stable.includes(CORE_PREAMBLE));
});

test("用户名不是阿澄：人设、core、此刻、记忆标题都用设置里的名字", () => {
  const { stable, dynamic } = buildSystemPrompt({ profile: DEFAULT_PROFILE, core: "{userName}半夜来找过她", settings: { userName: "阿明" }, now, lastSeenAt: now.getTime() - 3600_000, memories: [], recentText: "", memoryText: "阿明这个人：\n- 做技术" });
  const all = `${stable}\n${dynamic}`;
  assert.doesNotMatch(all, /阿澄|\{userName\}/u);
  assert.match(stable, /她和阿明：/u);
  assert.match(stable, /阿明半夜来找过她/u);
  assert.match(dynamic, /阿明上一次找她是1 小时前/u);
  assert.match(dynamic, /她记得的关于阿明的事/u);
});

test("动态段：此刻 → 状态与念头 → 动态 → 日子 → 记忆 → 收尾两句（收尾在最后）", () => {
  const { dynamic } = buildSystemPrompt({
    profile: "P",
    settings,
    now,
    lastSeenAt: now.getTime() - 3600_000,
    extraNow: ["她在上班。手上的活开着，手机在键盘旁边。"],
    innerText: "她这会儿的状态：有点累。",
    worldText: "她所在的上海：下雨",
    life: { day: "08:30 [起床] 起床", recentDays: [] },
    memories: [{ file: "k.md", type: "profile", body: "他在做动画", description: "", closed: false, mtimeMs: 0 }],
    recentText: "",
  });
  const order = [NOW_TITLE, "她在上班", "她这会儿的状态", "她的动态和外面", "她今天（2026-10-10 星期六）的日程", "她记得的关于阿澄的事", TRANSCRIBE_TAIL, VOICE_LINE].map((title) => dynamic.indexOf(title));
  assert.ok(order.every((index) => index >= 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(dynamic.endsWith(`${TRANSCRIBE_TAIL}\n${VOICE_LINE}`));
  assert.match(VOICE_LINE, /未必每次都想告诉他/u);
  assert.match(TRANSCRIBE_TAIL, /^只输出她在手机上实际打出来的字。/u);
  assert.match(dynamic, /阿澄这个人：\n- 他在做动画/u);
  assert.match(dynamic, /（这些她都知道，平时不会特意提）/u, "记忆说明只有一句");
  assert.doesNotMatch(dynamic, /你/u, "背景里没有第二人称");
});

test("空的段落省略；收尾两句总在", () => {
  const { dynamic } = buildSystemPrompt({ profile: "P", settings, now, memories: [], recentText: "" });
  assert.doesNotMatch(dynamic, /她记得的关于|她今天（|她的动态和外面/u);
  assert.ok(dynamic.endsWith(VOICE_LINE));
});

test("安全例外：此刻里写明他可能有危险", () => {
  const { dynamic } = buildSystemPrompt({ profile: "P", settings, now, memories: [], recentText: "", safety: true, extraNow: ["她看到他这句话，把手上的事全放下了。"] });
  assert.ok(dynamic.indexOf(SAFETY_LINE) > dynamic.indexOf("全放下了"));
  assert.ok(dynamic.indexOf(SAFETY_LINE) < dynamic.indexOf(TRANSCRIBE_TAIL));
});

test("召回给出的记忆文字替换基础摘要", () => {
  const { dynamic } = buildSystemPrompt({ profile: "P", settings, now, memories: [{ file: "k.md", type: "profile", body: "不该出现", closed: false, mtimeMs: 0 }], recentText: "", memoryText: "阿澄这个人：\n- 选好的" });
  assert.match(dynamic, /选好的/u);
  assert.doesNotMatch(dynamic, /不该出现/u);
});

test("基础召回不补无关往事", () => {
  const { dynamic } = buildSystemPrompt({ profile: "朋友", settings, now, recentText: "哈哈", memories: [
    { file: "old.md", type: "event", body: "昨天医院的检查", created: "2026-10-09" },
    { file: "p.md", type: "profile", body: "他做动画。详细职业经历。", description: "他从事动画" },
  ] });
  assert.match(dynamic, /他从事动画/u);
  assert.doesNotMatch(dynamic, /医院|详细职业经历/u);
});

test("readProfile：读 data/profile.md，没有就用内置版，不回退到 persona.md", async () => {
  const { cleanup } = await useTempData();
  try {
    await writeFile(paths.persona(), "你是林澈，文学化的长段描写。");
    assert.equal(await readProfile(), DEFAULT_PROFILE);
    await writeFile(paths.profile(), "\uFEFF林澈，编辑。和{userName}认识两年。\n");
    assert.equal(await readProfile("阿澄"), "林澈，编辑。和阿澄认识两年。");
  } finally {
    await cleanup();
  }
});

test("context：提示词用 profile.md，不用 persona.md；检索只用当前用户整条消息", async () => {
  const { cleanup } = await useTempData();
  try {
    await updateSettings({ userName: "阿明" });
    await writeFile(paths.persona(), "你是林澈，文学化的长段描写。");
    await writeFile(paths.profile(), "林澈，编辑。和{userName}认识两年。");
    let input;
    const build = createPromptBuilder({ coreSelf: null, innerProvider: null, memorySelector: async (value) => { input = value; return { text: null }; } });
    const { system } = await build({ now, messages: [
      { role: "user", text: "昨天复查了" },
      { role: "assistant", text: "别忘了复查肝功能" },
      { role: "user", text: "我在写软件\n想试试新功能" },
    ] });
    assert.match(system.stable, /林澈，编辑。和阿明认识两年。/u);
    assert.doesNotMatch(system.stable, /文学化的长段描写/u);
    assert.equal(input.recentText, "我在写软件\n想试试新功能");
    assert.equal(input.previousAssistantText, "别忘了复查肝功能");
  } finally {
    await cleanup();
  }
});
