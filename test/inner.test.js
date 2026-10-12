// P1：日程标签、惰性结算、对照表、防线公式（docs/12 第 3–7、13 节），以及 P1 验收：
// 12:30 后饱腹回满；凌晨精力低时出现"很困"；提示里只有文字没有数字；结算结果与心跳频率无关。
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSystemPrompt } from "../src/companion/prompt.js";
import { formatStateSection, GUARD_HINTS, isSafetyRisk, mapInner } from "../src/inner/mapping.js";
import { daySlots, parseSchedule, slotAt } from "../src/inner/tags.js";
import { applyEvents, applyUserTurn, BASELINE, computeGuard, initialInner, settle } from "../src/inner/vitals.js";
import { at } from "./helpers.js";

const DAY = ["07:30 [起床] 起来", "08:30 [通勤] 地铁", "09:30 [上班] 改稿", "12:30 [吃饭] 楼下面馆", "13:30 [上班] 开工", "19:00 [吃饭] 晚饭", "20:00 [空闲] 看书", "23:30 [睡觉] 睡了"].join("\n");
const slotsFor = () => daySlots(DAY);

test("标签：不认识的忽略、斜杠取第一个认识的、没有任何标签的旧日程按兜底、实际覆盖时段", () => {
  const parsed = parseSchedule("09:00 [开会/加班] 周会\n10:00 [瞎写] 什么\n11:00 没标签");
  assert.deepEqual(parsed.slots.map((s) => s.tag), ["开会", "空闲", "空闲"]);
  const legacy = daySlots("09:00 上班\n18:00 下班");
  assert.equal(slotAt(legacy, 3 * 60).tag, "睡觉");
  assert.equal(slotAt(legacy, 15 * 60).tag, "空闲");
  const actual = daySlots(`${DAY}\n实际：15:20 [开会] 临时被叫去开会`);
  assert.equal(slotAt(actual, 15 * 60 + 30).tag, "开会");
  assert.equal(slotAt(actual, 19 * 60 + 10).tag, "吃饭");
});

test("饱腹：12:30 进入吃饭时段后回满；睡觉时精力恢复", () => {
  const start = at(2026, 10, 12, 11, 0).getTime();
  const state = { ...initialInner(start), vitals: { ...initialInner().vitals, fullness: 20 } };
  const lunch = settle(state, at(2026, 10, 12, 12, 45).getTime(), { slotsFor }).state;
  assert.ok(lunch.vitals.fullness >= 85, `fullness=${lunch.vitals.fullness}`);
  const tired = { ...initialInner(at(2026, 10, 12, 23, 30).getTime()), vitals: { ...initialInner().vitals, energy: 20 } };
  const morning = settle(tired, at(2026, 10, 13, 7, 0).getTime(), { slotsFor }).state;
  assert.ok(morning.vitals.energy > 70, `energy=${morning.vitals.energy}`);
});

test("结算与心跳频率无关：一次结算到底 = 每 7 分钟结算一次", () => {
  const from = at(2026, 10, 12, 6, 3).getTime();
  const to = at(2026, 10, 14, 9, 41).getTime();
  const options = { slotsFor, lastUserMessageAt: at(2026, 10, 12, 8, 17).getTime() };
  const once = settle(initialInner(from), to, options).state;
  let stepped = initialInner(from);
  for (let t = from + 7 * 60_000; t < to; t += 7 * 60_000) stepped = settle(stepped, t, options).state;
  stepped = settle(stepped, to, options).state;
  for (const key of Object.keys(once.vitals)) assert.ok(Math.abs(once.vitals[key] - stepped.vitals[key]) < 1e-6, key);
  for (const key of Object.keys(once.tensions)) assert.ok(Math.abs(once.tensions[key] - stepped.tensions[key]) < 1e-6, key);
});

test("想念：沉默 4 小时后才开始涨，上限 70；他来一轮 −10，同一会话最多 −30", () => {
  const lastUser = at(2026, 10, 12, 9, 0).getTime();
  const state = initialInner(lastUser);
  const early = settle(state, at(2026, 10, 12, 12, 59).getTime(), { slotsFor, lastUserMessageAt: lastUser }).state;
  assert.equal(early.vitals.missing, state.vitals.missing);
  const long = settle(state, at(2026, 10, 15, 9, 0).getTime(), { slotsFor, lastUserMessageAt: lastUser }).state;
  assert.equal(long.vitals.missing, 70);
  let current = long;
  for (let i = 0; i < 5; i += 1) current = applyUserTurn(current, lastUser + 3 * 86_400_000 + i * 60_000).state;
  assert.equal(current.vitals.missing, 40);
});

test("自我感觉与张力：事件判断加减；缺字段当 false", () => {
  const state = initialInner();
  const { state: next } = applyEvents(state, { praisedByHim: true, deflectedIdeal: true, deepTalk: true }, Date.now());
  assert.equal(next.vitals.selfWorth, BASELINE.selfWorth + 5);
  assert.equal(next.tensions.book, state.tensions.book + 5);
  assert.equal(next.tensions.seen, state.tensions.seen - 10);
  assert.equal(applyEvents(state, {}, Date.now()).reason, null);
});

test("防线公式：基线 100；压力与疲惫扣分；深夜 −15；喝酒后 3 小时 −15", () => {
  const day = at(2026, 10, 12, 15).getTime();
  assert.equal(computeGuard({ stress: 30, energy: 70 }, day), 100);
  assert.equal(computeGuard({ stress: 80, energy: 20 }, day), 100 - 50 * 0.6 - 40 * 0.5);
  assert.equal(computeGuard({ stress: 30, energy: 70 }, at(2026, 10, 12, 1).getTime()), 85);
  assert.equal(computeGuard({ stress: 30, energy: 70 }, day, day - 60 * 60_000), 85);
  assert.equal(computeGuard({ stress: 30, energy: 70 }, day, day - 4 * 60 * 60_000), 100);
});

test("对照表：凌晨精力低出现「很困」并限一段；最多两句状态提示 + 防线；安全例外去掉疲惫与防线", () => {
  const night = at(2026, 10, 12, 1, 30).getTime();
  const inner = { ...initialInner(), vitals: { energy: 15, fullness: 15, stress: 85, missing: 60, selfWorth: 30 } };
  const mapped = mapInner(inner, { now: night });
  assert.ok(mapped.hints.some((hint) => hint.startsWith("你很困，")));
  assert.equal(mapped.maxSegments, 1);
  assert.ok(mapped.hints.length <= 2);
  assert.equal(mapped.guardHint, GUARD_HINTS.thin);
  assert.ok(!mapped.hints.some((hint) => hint.includes("想找他")), "生存优先：想念不参与");
  const safe = mapInner(inner, { now: night, safety: true });
  assert.equal(safe.guardHint, null);
  assert.ok(!safe.hints.some((hint) => hint.startsWith("你很困，")));
  assert.equal(safe.maxSegments, null);
  assert.ok(isSafetyRisk("我真的撑不下去了"));
});

test("提示词里的状态小节只有文字，没有任何数字", () => {
  const inner = { ...initialInner(), vitals: { energy: 40, fullness: 25, stress: 70, missing: 55, selfWorth: 80 } };
  const section = formatStateSection(mapInner(inner, { now: at(2026, 10, 12, 21).getTime() }));
  assert.match(section, /^# 你现在的状态/u);
  assert.ok(!/\d/u.test(section), section);
  const prompt = buildSystemPrompt({ persona: "人设", settings: { userName: "阿澄" }, now: at(2026, 10, 12, 21), life: { recentDays: [] }, memories: [], recentText: "", innerText: section });
  assert.ok(prompt.dynamic.includes(section));
  assert.ok(!prompt.stable.includes("你现在的状态"));
});

test("叔本华溢流：被看见在高位却漏不出来 → 每天 2 点流进写书；当天漏过就不流", () => {
  const from = at(2026, 10, 12, 10).getTime();
  const to = at(2026, 10, 13, 10).getTime();
  const base = { ...initialInner(from), vitals: { ...initialInner().vitals, missing: 30 }, tensions: { book: 40, seen: 70 }, writingDays: ["2026-10-12"] };
  const blocked = settle(base, to, { slotsFor, lastUserMessageAt: to }).state;
  assert.equal(blocked.tensions.seen, 68);
  assert.equal(blocked.tensions.book, 42);
  const leaked = settle({ ...base, lastTurning: { seen: "2026-10-12" } }, to, { slotsFor, lastUserMessageAt: to }).state;
  assert.equal(leaked.tensions.seen, 70);
  assert.equal(leaked.tensions.book, 40);
});
