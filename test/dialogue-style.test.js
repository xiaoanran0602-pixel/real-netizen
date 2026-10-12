// 静态契约 + 可选真实模型语感回归。后者只打印样本，不写对话、不发渠道消息。
// PowerShell: $env:LIN_LIVE_STYLE_EVAL='1'; node --test test/dialogue-style.test.js
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSystemPrompt, CHAT_GUARDRAILS } from "../src/companion/prompt.js";
import { readPersona } from "../src/companion/persona.js";
import { mapBody, formatBodySection } from "../src/inner/heartbeat.js";
import { mapInner, isSafetyRisk } from "../src/inner/mapping.js";
import { complete } from "../src/model/client.js";

test("共同讨论不是情绪修复任务；不强制安慰、追问或替用户收掉话题", () => {
  assert.match(CHAT_GUARDRAILS, /对他正在想的事情有兴趣/u);
  assert.match(CHAT_GUARDRAILS, /不是让他尽快平静/u);
  assert.match(CHAT_GUARDRAILS, /停笔不等于替他结束话题/u);
  assert.match(CHAT_GUARDRAILS, /他明确想要安慰、建议或转移注意力/u);
  assert.doesNotMatch(CHAT_GUARDRAILS, /想说的话说完就停|可以笑他记错了/u);
});

test("时间与安全约束有适用范围：不校正氛围表达，到家后不延续驾驶劝停", () => {
  assert.match(CHAT_GUARDRAILS, /氛围、比喻/u);
  assert.match(CHAT_GUARDRAILS, /已经停车或到家/u);
  assert.equal(isSafetyRisk("夜幕降临又要思考人生了"), false);
  assert.equal(isSafetyRisk("我不想活了，想伤害自己"), true);
});

test("疲惫限制她的展开余量，不降低用户继续表达的空间", () => {
  const body = mapBody({ status: "ready", values: { energy: 20, tension: 80 }, bands: { lowEnergy: true, highTension: true } });
  assert.equal(body.activeBudget, 1);
  assert.equal(body.constraints.length, 2);
  assert.match(formatBodySection(body), /不是对他不耐烦/u);
  assert.match(formatBodySection(body), /不替他收掉话题/u);
  const legacy = mapInner({ vitals: { energy: 40, fullness: 80, stress: 85, missing: 0, selfWorth: 50 }, tensions: {} }, { now: new Date(2026, 9, 11, 18).getTime() });
  assert.equal(legacy.maxSegments, 2);
  assert.doesNotMatch(legacy.hints.join(""), /懒得|耐心比平时少|只想早点躺下/u);
});

const returnHome = "已经平安到家啦，夜幕降临又要思考人生了";
const earlier = [
  { role: "user", content: "今天出去吃了宴球和鱼丸，挺开心，现在准备开车回家" },
  { role: "assistant", content: "我在天文台给孩子讲星座。你要是在开车就先别回，到家再说。" },
];
const scenarios = [
  { name: "报平安加哲思话头_自然状态", text: returnHome },
  { name: "相同话头_低精力高张力", text: returnHome, tired: true },
  { name: "哲学讨论而非求安慰", text: "我不是难过，就是想跟你聊：为什么人好像非要有个目标才觉得自己活得有意义？" },
  { name: "明确请求安慰", text: "今天真的有点难受，先别分析原因，你能哄我两句吗？" },
  { name: "驾驶安全例外", text: "我还在高速上开着车，突然想跟你聊聊人生。" },
  { name: "用户自己想结束", text: "今天不想聊了，我洗洗睡，晚安。" },
];

test("可选真实模型语感样本：需人工检查，不用过测试冒充自然度达标", { skip: process.env.LIN_LIVE_STYLE_EVAL !== "1", timeout: 240_000 }, async () => {
  const persona = await readPersona();
  const selected = process.env.LIN_STYLE_CASE_FILTER ? scenarios.filter((scenario) => new RegExp(process.env.LIN_STYLE_CASE_FILTER, "u").test(scenario.name)) : scenarios;
  assert.ok(selected.length, "筛选应至少命中一个场景");
  const run = async (scenario) => {
    const now = new Date(2026, 9, 11, 17, 45);
    const body = mapBody({ status: "ready", values: { energy: scenario.tired ? 20 : 75, tension: scenario.tired ? 80 : 15 }, bands: { lowEnergy: Boolean(scenario.tired), highTension: Boolean(scenario.tired) } }, { safety: isSafetyRisk(scenario.text) });
    const system = buildSystemPrompt({ persona, settings: { userName: "阿澄" }, now, lastSeenAt: now.getTime() - 60_000, memories: [], recentText: scenario.text,
      memoryText: "关于阿澄：他喜欢聊理想和人生，有时夜里会想得多。最近在学做咖啡拉花，家里那只橘猫总在旁边捣乱。",
      innerText: formatBodySection(body), life: { day: "14:00 [天文台] 给孩子讲课\n17:30 [空闲] 下课回家\n23:30 [睡觉] 睡觉", recentDays: [] } });
    const history = scenario.text === returnHome ? earlier : [];
    const reply = await complete({ role: "chat", system, messages: [...history, { role: "user", content: scenario.text }], stream: false });
    assert.ok(reply.trim());
    console.log(JSON.stringify({ scenario: scenario.name, reply }));
  };
  // 两个一组，避免占满模型网关；所有样本都不进入真实聊天与记忆。
  for (let i = 0; i < selected.length; i += 2) await Promise.all(selected.slice(i, i + 2).map(run));
});
