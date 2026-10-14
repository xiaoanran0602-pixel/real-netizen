// 情境：日程时段 → 她此刻的处境（第三人称画面）；安全例外；快到下一件事；提示词里只有画面没有形容词和说明。
import assert from "node:assert/strict";
import { test } from "node:test";
import { TAGS } from "../src/inner/tags.js";
import { ATTENTION, formatSituation, PLACES, sceneOf } from "../src/inner/situation.js";
import { at } from "./helpers.js";

const slots = [
  { start: 0, tag: "睡觉", text: "" },
  { start: 8 * 60, tag: "起床", text: "" },
  { start: 9 * 60, tag: "上班", text: "改二校稿" },
  { start: 12 * 60, tag: "吃饭", text: "楼下吃面" },
  { start: 13 * 60, tag: "上班", text: "" },
  { start: 19 * 60, tag: "空闲", text: "" },
  { start: 23 * 60 + 30, tag: "睡觉", text: "" },
];
const slotAtHour = (hour, minute = 0) => slots.findLast((slot) => slot.start <= hour * 60 + minute);

test("每个日程标签都有画面，注意力只取三档", () => {
  for (const tag of TAGS) {
    assert.ok(PLACES[tag], `缺少标签：${tag}`);
    assert.ok(ATTENTION.includes(PLACES[tag].attention));
  }
});

test("同一个人，上班时和夜里是两种处境", () => {
  const work = sceneOf({ slot: slotAtHour(10, 35), slots, now: at(2026, 10, 13, 10, 35) });
  assert.equal(work.attention, "glance");
  assert.match(work.lines.join(""), /她在上班/u);
  assert.match(work.lines.join(""), /改二校稿/u, "日程里写的具体的事带进画面");
  assert.match(work.lines.join(""), /手机在键盘旁边/u);
  assert.doesNotMatch(work.lines.join(""), /抽空/u, "不写她的内心视角");

  const night = sceneOf({ slot: slotAtHour(22), slots, now: at(2026, 10, 13, 22, 0) });
  assert.equal(night.attention, "full");
  assert.match(night.lines.join(""), /窝下了/u);

  const evening = sceneOf({ slot: slotAtHour(19, 30), slots, now: at(2026, 10, 13, 19, 30) });
  assert.match(evening.lines.join(""), /没什么事/u, "晚饭后还没到夜里：只是没事");
});

test("快到下一件事时多一句；还早或下一段是同一件事就不说", () => {
  const soon = sceneOf({ slot: slotAtHour(11, 50), slots, now: at(2026, 10, 13, 11, 50) });
  assert.match(soon.lines.join(""), /再过十来分钟她就要去吃饭/u);
  const early = sceneOf({ slot: slotAtHour(10), slots, now: at(2026, 10, 13, 10, 0) });
  assert.equal(early.lines.length, 1);
  const last = sceneOf({ slot: slots.at(-1), slots, now: at(2026, 10, 13, 23, 40) });
  assert.equal(last.lines.length, 1, "后面没有时段了");
});

test("安全例外：不管在干嘛，都是放下手上的事", () => {
  const scene = sceneOf({ slot: slotAtHour(10), slots, now: at(2026, 10, 13, 10, 0), safety: true });
  assert.equal(scene.attention, "full");
  assert.match(scene.lines.join(""), /全放下了/u);
  assert.doesNotMatch(scene.lines.join(""), /键盘/u);
});

test("没有日程时段、不认识的标签都退回空闲", () => {
  assert.match(sceneOf({ slot: null, slots: [], now: at(2026, 10, 13, 15, 0) }).lines.join(""), /没什么事/u);
  assert.match(sceneOf({ slot: { tag: "跳伞", start: 0 }, slots: [], now: at(2026, 10, 13, 15, 0) }).lines.join(""), /没什么事/u);
});

test("给模型的是第三人称画面，不是语气指令，也不追加说明", () => {
  const all = Object.values(PLACES).flatMap((place) => [place.where, place.phone]).join("");
  assert.doesNotMatch(all, /随意|简短|口语|语气|自然一点|少说|多说/u);
  assert.doesNotMatch(all, /你/u, "处境里没有第二人称");
  assert.deepEqual(formatSituation(null), []);
  const lines = formatSituation(sceneOf({ slot: slotAtHour(10), slots, now: at(2026, 10, 13, 10, 0) }));
  assert.equal(lines.length, 1, "只有画面，没有「用不着讲出来」这类说明");
  assert.deepEqual(formatSituation(null, ["他们刚搭上话。"]), ["他们刚搭上话。"]);
});
