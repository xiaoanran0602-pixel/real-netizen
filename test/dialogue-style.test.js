// 静态契约 + 可选真实模型语感回归。后者只打印样本，不写对话、不发渠道消息。
// PowerShell: $env:LIN_LIVE_STYLE_EVAL='1'; node --test test/dialogue-style.test.js
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASELINE, buildSystemPrompt, CORE_PREAMBLE, MEMORY_PREAMBLE, NOW_TITLE, PROFILE_TITLE, SAFETY_LINE, TRANSCRIBE_HEAD, TRANSCRIBE_TAIL, VOICE_LINE, describeNow } from "../src/companion/prompt.js";
import { DEFAULT_PROFILE, readProfile } from "../src/companion/persona.js";
import { digestTitles } from "../src/companion/memory.js";
import { formatLife } from "../src/companion/life.js";
import { formatWorldText } from "../src/companion/world-context.js";
import { express, formatStateSection, HINTS, STATE_PREAMBLE } from "../src/inner/express.js";
import { GUARD_HINTS } from "../src/inner/mapping.js";
import { PLACES, formatSituation, sceneOf } from "../src/inner/situation.js";
import { advanceConversation, ANSWERING, conversationLines, decisionState, DOING, NO_TIME, QUESTIONS, WHERE } from "../src/inner/conversation.js";
import { daySlots, slotAt } from "../src/inner/tags.js";
import { AROUND, attentionAfter, CHANCE, FREED, INTERRUPTED, ONE_LINE_ONLY, passingLines, rollPerturbation } from "../src/inner/perturbation.js";
import { formatThoughtsSection } from "../src/inner/thoughts.js";
import { decide } from "../src/model/systemone.js";
import { CORE_FRAGMENT_HINT, SEEN_LEAK_HINT } from "../src/inner/will.js";
import { isSafetyRisk } from "../src/inner/mapping.js";
import { initialPsyche } from "../src/inner/psyche.js";
import { lifeKeys } from "../src/util/time.js";
import { complete } from "../src/model/client.js";
const snap = (values, extra = {}) => ({ status: "ready", at: new Date(2026, 9, 11, 18).getTime(), values: { valence: 0, activation: 25, ...values }, bands: {}, psyche: initialPsyche(), segments: [], thoughts: [], ...extra });
const values = (table) => Object.values(table).flatMap((value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value : Object.values(value)));

/** 程序写进聊天提示词的所有固定文字（不含人设、core 这些手写资料）。 */
function fixedTexts() {
  const now = new Date(2026, 9, 13, 10, 35);
  const allHints = express(snap({ energy: 10, tension: 90 }));
  return {
    TRANSCRIBE_HEAD: TRANSCRIBE_HEAD("林澈"), PROFILE_TITLE: PROFILE_TITLE("林澈"), CORE_PREAMBLE, BASELINE, NOW_TITLE, SAFETY_LINE, MEMORY_PREAMBLE, TRANSCRIBE_TAIL, VOICE_LINE,
    describeNow: [describeNow(now, undefined, "阿澄"), describeNow(now, now.getTime() - 60_000, "阿澄"), describeNow(now, now.getTime() - 3 * 86_400_000, "阿澄")].join("\n"),
    STATE_PREAMBLE, hints: values(HINTS).join("\n"), guard: values(GUARD_HINTS).join("\n"), stateSection: formatStateSection(allHints) ?? "",
    CORE_FRAGMENT_HINT, SEEN_LEAK_HINT,
    places: Object.values(PLACES).flatMap((place) => [place.where, place.phone]).join("\n"),
    situation: formatSituation(sceneOf({ slot: { tag: "上班", text: "改稿", start: 600 }, slots: [{ tag: "上班", start: 600 }, { tag: "吃饭", start: 645 }], now })).join("\n"),
    safetyScene: sceneOf({ now, safety: true }).lines.join("\n"),
    where: values(WHERE).join("\n"), doing: values(DOING).join("\n"), ANSWERING, NO_TIME,
    interrupted: values(INTERRUPTED).join("\n"), ONE_LINE_ONLY, freed: values(FREED).join("\n"), around: values(AROUND).join("\n"),
    thoughts: formatThoughtsSection({ activated: [{ content: "甲" }], background: [{ content: "乙" }], unspoken: [{ content: "丙" }], avoided: [{ content: "丁" }] }) ?? "",
    life: formatLife({ year: "一", month: "二", week: "三", day: "四", future: "五", recentDays: [{ date: "2026-10-12", text: "六" }] }, lifeKeys(now)) ?? "",
    memoryTitles: digestTitles("阿澄").map(([, title]) => title).join("\n"),
    world: formatWorldText({ world: { weather: { city: "上海", description: "小雨", temperature: 18 }, news: ["一条新闻"] }, profile: { currentCity: "杭州", signature: { text: "签名" }, avatar: { query: "星空" } }, moments: { posts: [{ at: now.getTime(), text: "朋友圈", comments: [{ from: "me", text: "评论" }, { from: "her", text: "回复" }] }] }, userName: "阿澄" }) ?? "",
  };
}

// 进提示词的每句话都会被模型当成语体样本。对举句（不是 A，是 B / A 不等于 B）写多了，她说话也会变成对举句。
const CONTRAST = /不是[^。；？！\n]{1,16}[，,]\s*(而是|就是|只是|是)|不等于|与其说|谈不上/u;
// 对她下指令的第二人称句：以「你」开头。任务开头那一句是对补全者说的（「你负责补全」），不算对她下指令，单独豁免。
const SECOND_PERSON = /(^|[。！？；，,\n（(]|这些是|上面是)\s*你/u;

test("程序写进提示词的固定文字：没有以「你」开头的指令句，没有对举句，没有「意象」", () => {
  for (const [name, text] of Object.entries(fixedTexts())) {
    assert.ok(text.trim(), `${name} 是空的，覆盖不到`);
    const body = name === "TRANSCRIBE_HEAD" ? text.replace(/你负责补全/u, "") : text;
    for (const line of body.split("\n")) {
      assert.doesNotMatch(line, SECOND_PERSON, `${name} 里有以「你」开头的句子：${line}`);
      assert.doesNotMatch(line, CONTRAST, `${name} 里有对举句：${line}`);
    }
    assert.doesNotMatch(text, /意象/u, `${name} 不该出现意象`);
  }
});

test("整份提示词：只有任务开头那一处「你」，没有风格规则段落", () => {
  const now = new Date(2026, 9, 13, 10, 35);
  const body = express(snap({ energy: 20, tension: 80 }));
  const { stable, dynamic } = buildSystemPrompt({
    profile: DEFAULT_PROFILE, core: "她心里的一件事。", settings: { userName: "阿澄" }, now, lastSeenAt: now.getTime() - 86_400_000,
    extraNow: formatSituation(sceneOf({ slot: { tag: "上班", text: "改稿", start: 600 }, slots: [], now }), ["他们刚搭上话。"]),
    innerText: [formatStateSection(body), formatThoughtsSection({ activated: [{ content: "稿子周五交" }], background: [], unspoken: [], avoided: [] })].join("\n\n"),
    life: { day: "10:00 [上班] 改稿", recentDays: [] }, memories: [], recentText: "忙吗", memoryText: "阿澄这个人：\n- 在游戏公司做技术",
  });
  const all = `${stable}\n\n${dynamic}`;
  assert.equal(all.match(/你/gu)?.length, 1, "只有「你负责补全」");
  assert.doesNotMatch(all, /# 说话的方式|# 相处的姿态|# 时间和你的生活|你是林澈/u);
});

test("疲惫只写成她的状态，不写对他的要求", () => {
  const tired = express(snap({ energy: 20, tension: 80 }));
  assert.equal(tired.activeBudget, 1);
  const section = formatStateSection(tired);
  assert.ok(section.startsWith(STATE_PREAMBLE));
  assert.match(section, /很困/u);
  assert.doesNotMatch(section, /他想|用不着|就行|别/u, "没有指令句");
  assert.equal(isSafetyRisk("夜幕降临又要思考人生了"), false);
  assert.equal(isSafetyRisk("我不想活了，想伤害自己"), true);
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
  const profile = await readProfile("阿澄");
  const selected = process.env.LIN_STYLE_CASE_FILTER ? scenarios.filter((scenario) => new RegExp(process.env.LIN_STYLE_CASE_FILTER, "u").test(scenario.name)) : scenarios;
  assert.ok(selected.length, "筛选应至少命中一个场景");
  const run = async (scenario) => {
    const now = new Date(2026, 9, 11, 17, 45);
    const body = express(snap({ energy: scenario.tired ? 20 : 75, tension: scenario.tired ? 80 : 15 }, { at: now.getTime() }), { safety: isSafetyRisk(scenario.text) });
    const system = buildSystemPrompt({ profile, settings: { userName: "阿澄" }, now, lastSeenAt: now.getTime() - 60_000, memories: [], recentText: scenario.text,
      memoryText: "阿澄这个人：他喜欢聊理想和人生，有时夜里会想得多。今天出去吃饭，吃得挺开心。",
      innerText: formatStateSection(body), life: { day: "14:00 [天文台] 给孩子讲课\n17:30 [空闲] 下课回家\n23:30 [睡觉] 睡觉", recentDays: [] } });
    const history = scenario.text === returnHome ? earlier : [];
    const reply = await complete({ role: "chat", system, messages: [...history, { role: "user", content: scenario.text }], stream: false });
    assert.ok(reply.trim());
    console.log(JSON.stringify({ scenario: scenario.name, reply }));
  };
  // 两个一组，避免占满模型网关；所有样本都不进入真实聊天与记忆。
  for (let i = 0; i < selected.length; i += 2) await Promise.all(selected.slice(i, i + 2).map(run));
});

// ---- 情境矩阵（docs/19）：同一句话放进不同处境。看的是格子之间的差别，和同一格多次之间的变化。----
const WORKDAY = "08:00 [起床] 起床\n09:00 [上班] 改二校稿，周五要交\n12:00 [吃饭] 楼下吃面\n13:00 [上班] 接着改稿\n18:30 [通勤] 地铁回家\n19:30 [空闲] 在家\n23:30 [睡觉] 睡觉";
const SATURDAY = "09:00 [起床] 起床\n14:00 [天文台] 给小孩讲秋季星空\n17:30 [空闲] 下课回家\n23:30 [睡觉] 睡觉";
const smallTalk = [
  ["user", "今天食堂的鱼丸居然是真鱼做的"], ["assistant", "那你们食堂良心发现了"],
  ["user", "哈哈可能是换承包商了"], ["assistant", "珍惜吧 过两周就原形毕露"],
];
const matrix = [
  { name: "上班忙吗_工位改稿", text: "最近上班忙吗？", when: [13, 10, 35], day: WORKDAY },
  { name: "上班忙吗_夜里在家", text: "最近上班忙吗？", when: [13, 22, 40], day: WORKDAY },
  { name: "上班忙吗_天文台课间", text: "最近上班忙吗？", when: [17, 15, 10], day: SATURDAY },
  { name: "想辞职_工位改稿", text: "我今天又在想要不要辞职", when: [13, 15, 20], day: WORKDAY },
  { name: "想辞职_夜里闲扯之后", text: "其实我今天又在想要不要辞职", when: [13, 22, 40], day: WORKDAY, history: smallTalk, prev: { mode: "chatting", turns: 2, modeTurns: 2 } },
  { name: "碰到谁_下班路上", text: "哈哈哈你猜我今天碰到谁", when: [13, 18, 45], day: WORKDAY },
  { name: "碰到谁_夜里在家", text: "哈哈哈你猜我今天碰到谁", when: [13, 22, 40], day: WORKDAY },
];

test("可选真实模型情境矩阵：同一句话 × 不同处境，人工看差别", { skip: process.env.LIN_LIVE_STYLE_EVAL !== "1", timeout: 600_000 }, async () => {
  const profile = await readProfile("阿澄");
  const selected = process.env.LIN_STYLE_CASE_FILTER ? matrix.filter((cell) => new RegExp(process.env.LIN_STYLE_CASE_FILTER, "u").test(cell.name)) : matrix;
  const samples = Number(process.env.LIN_STYLE_SAMPLES) || 2;
  const bare = process.env.LIN_STYLE_NO_SITUATION === "1";
  for (const cell of selected) {
    const now = new Date(2026, 9, ...cell.when);
    const slots = daySlots(cell.day);
    const scene = sceneOf({ slot: slotAt(slots, now.getHours() * 60 + now.getMinutes()), slots, now });
    const history = (cell.history ?? []).map(([role, content]) => ({ role, content }));
    const prev = cell.prev ? { ...cell.prev, lastAt: now.getTime() - 60_000, lastMessageId: "prev", startedAt: now.getTime() - 600_000 } : null;
    const recent = history.map((message) => ({ role: message.role, text: message.content }));
    const reading = await decide({ state: decisionState({ scene: scene.brief, prev, at: now.getTime(), recent, text: cell.text }), questions: QUESTIONS });
    for (let n = 0; n < samples; n += 1) {
      const state = advanceConversation(prev, { messageId: `eval-${n}`, at: now.getTime(), text: cell.text, reading });
      // LIN_STYLE_FORCE_PASSING=interrupted|freed|around：强制这一轮发生某种小事，用来看它的效果（平时大多数轮没有）。
      const forced = process.env.LIN_STYLE_FORCE_PASSING;
      const roll = forced ? { interrupted: 0, freed: CHANCE.glance.interrupted, around: CHANCE.glance.interrupted + CHANCE.glance.freed }[forced] : null;
      const passing = rollPerturbation({ spot: scene.spot, attention: forced ? "glance" : scene.attention, mode: state.mode, register: state.register, ...(roll !== null && roll !== undefined ? { rng: (() => { let first = true; return () => (first ? ((first = false), roll + 0.001) : Math.random()); })() } : {}) });
      const extraNow = bare ? [] : formatSituation(scene, conversationLines(state, { attention: attentionAfter(scene.attention, passing) }), passingLines(passing));
      const system = buildSystemPrompt({ profile, settings: { userName: "阿澄" }, now, lastSeenAt: now.getTime() - (prev ? 60_000 : 2 * 86_400_000), memories: [], recentText: cell.text,
        memoryText: "阿澄这个人：他在游戏公司做技术，喜欢聊理想和人生。", life: { day: cell.day, recentDays: [] }, extraNow });
      const reply = await complete({ role: "chat", system, messages: [...history, { role: "user", content: cell.text }], stream: false });
      assert.ok(reply.trim());
      console.log(JSON.stringify({ cell: cell.name, n, mode: state.mode, register: state.register, decided: Boolean(reading), passing: passing?.kind ?? null, now: extraNow.join(" "), chars: [...reply].length, reply }));
    }
  }
});
