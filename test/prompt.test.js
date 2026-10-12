// 系统提示词：各段存在与顺序、时间描述、无人设兜底、稳定/动态分段。
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { buildSystemPrompt, CHAT_GUARDRAILS, describeNow, FALLBACK_PERSONA } from "../src/companion/prompt.js";
import { createPromptBuilder } from "../src/companion/context.js";
import { readCoreSelf, coreSelfText } from "../src/inner/core-self.js";
import { paths } from "../src/config/paths.js";
import { at, useTempData } from "./helpers.js";

const now = at(2026, 10, 10, 14, 30);
const settings = { userName: "阿澄" };

test("describeNow reports real time and gap", () => {
  const text = describeNow(now, now.getTime() - 3 * 86_400_000, "阿澄");
  assert.match(text, /2026-10-10 星期六 14:30（下午）/u);
  assert.match(text, /阿澄上一次找你是3 天前/u);
  assert.match(describeNow(now, undefined, "阿澄"), /第一次聊/u);
  assert.match(describeNow(now, now.getTime() - 60_000, "阿澄"), /刚刚，你们还在聊着/u);
});

test("stable segment: persona, then core, then guardrails", () => {
  const { stable } = buildSystemPrompt({ persona: "# 林澈\n你是她", core: "顶楼的那个晚上", settings, now, memories: [], recentText: "" });
  const persona = stable.indexOf("你是她");
  const core = stable.indexOf("顶楼的那个晚上");
  const rules = stable.indexOf("# 说话的方式");
  assert.ok(persona >= 0 && core > persona && rules > core);
  assert.ok(stable.endsWith(CHAT_GUARDRAILS));
});

test("missing persona falls back, never an assistant identity", () => {
  const { stable } = buildSystemPrompt({ persona: "", settings, now, memories: [], recentText: "" });
  assert.ok(stable.startsWith(FALLBACK_PERSONA));
  assert.doesNotMatch(stable, /你心里最底下的东西/u);
});

test("聊天规则允许选择性回应，生活是背景而非固定尾巴，分段不按话题分配", () => {
  const { stable, dynamic } = buildSystemPrompt({
    persona: "你是林澈。",
    settings, now, memories: [], recentText: "软件能不能赚钱，就当一个盼头吧",
    innerText: "# 她此刻脑子里的事\n锅里的蛋",
    life: { day: "14:00 [吃饭] 做饭", recentDays: [] },
  });
  assert.match(stable, /不必把他提到的每件事逐项回应/u);
  assert.match(stable, /明确的问题和重要的求助仍要认真接/u);
  assert.match(stable, /不要按话题分配气泡/u);
  assert.match(stable, /不固定放在结尾/u);
  assert.match(stable, /旧回复是发生过的对话，不是措辞或结构范例/u);
  assert.doesNotMatch(stable, /每段一两句/u);
  assert.match(dynamic, /背景，不是本轮要说的内容清单/u);
  assert.match(dynamic, /14:00 \[吃饭\] 做饭/u, "保留日程事实，不靠移除上下文假装自然");
});

test("dynamic segment order: now → state → world → life → memories", () => {
  const { dynamic } = buildSystemPrompt({
    persona: "P",
    settings,
    now,
    lastSeenAt: now.getTime() - 3600_000,
    innerText: "# 你现在的状态\n你有点累",
    worldText: "你所在的上海：下雨",
    life: { day: "08:30 [起床] 起床", recentDays: [] },
    memories: [{ file: "k.md", type: "profile", body: "他在做动画", description: "", closed: false, mtimeMs: 0 }],
    recentText: "",
  });
  const order = ["# 现在", "# 你现在的状态", "# 外面和你的动态", "# 你的日子", "# 你记得的事"].map((title) => dynamic.indexOf(title));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((index) => index >= 0));
  assert.match(dynamic, /今天（2026-10-10 星期六）的日程：\n08:30 \[起床\] 起床/u);
  assert.match(dynamic, /关于阿澄：\n- 他在做动画/u);
  assert.match(dynamic, /1 小时前/u);
});

test("empty sections are omitted", () => {
  const { dynamic } = buildSystemPrompt({ persona: "P", settings, now, memories: [], recentText: "" });
  assert.doesNotMatch(dynamic, /# 你记得的事|# 你的日子|# 外面和你的动态/u);
});

test("precomputed memory text (from recall) replaces basic digest", () => {
  const { dynamic } = buildSystemPrompt({ persona: "P", settings, now, memories: [{ file: "k.md", type: "profile", body: "不该出现", closed: false, mtimeMs: 0 }], recentText: "", memoryText: "关于阿澄：\n- 选好的" });
  assert.match(dynamic, /选好的/u);
  assert.doesNotMatch(dynamic, /不该出现/u);
});

test("readCoreSelf：data/core-self.md 存在且非空时覆盖，否则用内置", async () => {
  const { cleanup } = await useTempData();
  try {
    assert.equal(await readCoreSelf(), coreSelfText());
    await writeFile(paths.coreSelf(), "她自己的另一段基石。");
    assert.equal(await readCoreSelf(), "她自己的另一段基石。");
    await writeFile(paths.coreSelf(), "   \n  ");
    assert.equal(await readCoreSelf(), coreSelfText(), "空白文件回退内置");
  } finally {
    await cleanup();
  }
});

test("prompt builder：coreSelf 从 data/core-self.md 读取", async () => {
  const { cleanup } = await useTempData();
  try {
    const build = createPromptBuilder({ memorySelector: null, innerProvider: null });
    const without = await build({ now, messages: [] });
    assert.match(without.system.stable, /土星/u);
    await writeFile(paths.coreSelf(), "自定义基石：她喜欢深夜听雨。");
    const withFile = await build({ now, messages: [] });
    assert.match(withFile.system.stable, /自定义基石/u);
    assert.doesNotMatch(withFile.system.stable, /土星/u);
  } finally {
    await cleanup();
  }
});

test("检索只用当前用户整条消息，旧助手回复只用于避免重复", async () => {
  const { cleanup } = await useTempData();
  try {
    let input;
    const build = createPromptBuilder({ coreSelf: null, innerProvider: null, memorySelector: async (value) => { input = value; return { text: null }; } });
    await build({ now, messages: [
      { role: "user", text: "昨天复查了" },
      { role: "assistant", text: "别忘了复查肝功能" },
      { role: "user", text: "我在写软件\n想试试新功能" },
    ] });
    assert.equal(input.recentText, "我在写软件\n想试试新功能");
    assert.equal(input.previousAssistantText, "别忘了复查肝功能");
  } finally {
    await cleanup();
  }
});

test("基础召回也不补无关往事；记忆提示不把熟悉感变成引用要求", () => {
  const { dynamic } = buildSystemPrompt({ persona: "朋友", settings, now, recentText: "哈哈", memories: [
    { file: "old.md", type: "event", body: "昨天医院的检查", created: "2026-10-09" },
    { file: "p.md", type: "profile", body: "他做动画。详细职业经历。", description: "他从事动画" },
  ] });
  assert.match(dynamic, /他从事动画/u);
  assert.doesNotMatch(dynamic, /医院|详细职业经历/u);
  assert.match(dynamic, /记得不等于要提起/u);
  assert.match(dynamic, /不必复原日期、数字或原话/u);
});
