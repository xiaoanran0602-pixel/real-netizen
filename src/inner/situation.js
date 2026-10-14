// ============================================================
// 情境（docs/19）：她此刻在哪、手上在干嘛、手机和她是什么关系。
// 说话方式不靠规则规定，而是处境的副产品：在工位上抽空回一句，和夜里窝着聊，本来就是两种话。
//
//   程序决定事实（日程时段、离下一件事还有多久），翻成一两句具体的画面给模型；
//   只给画面，不给「随意一点」「简短一点」这类形容词——形容词就是滑条。
//   attention 是给代码用的（段数、扰动查表），不进提示词。
// 纯函数：不读盘、不调模型、不读系统时钟。
// ============================================================

import { pad2 } from "../util/time.js";

/** 她此刻能分给手机多少：glance 夹在事情中间 / half 半心半意 / full 完全在手里。 */
export const ATTENTION = Object.freeze(["glance", "half", "full"]);
const SOON_MINUTES = 15;
const NIGHT_FROM_HOUR = 21;
const NIGHT_UNTIL_HOUR = 5;

/**
 * 日程标签 → 画面。where 是她在哪/在干嘛，phone 是手机和她的关系，soon 是「马上要去……」的说法。
 * 全部是第三人称事实，只写她在哪、是什么状态，不写她该怎样（docs/19「补全写法」）。这些字会被模型当成语体样本，写平常话。
 */
export const PLACES = Object.freeze({
  起床: { where: "她刚起来没多久", phone: "人还没完全醒，手机拿在手里。", attention: "half" },
  睡觉: { where: "她已经躺下了，灯关着", phone: "还没睡着，手机在手里。", attention: "half", soon: "睡了" },
  吃饭: { where: "她在吃饭", phone: "手机放在碗旁边。", attention: "half", soon: "去吃饭" },
  上班: { where: "她在上班", phone: "手上的活开着，手机在键盘旁边。", attention: "glance", soon: "开始干活" },
  加班: { where: "她还在加班", phone: "手上的活没完。", attention: "glance", soon: "接着加班" },
  截止: { where: "她在赶稿，今天要交", phone: "稿子开着，手机在旁边。", attention: "glance", soon: "去赶稿" },
  开会: { where: "她在开会", phone: "手机放在桌子下面。", attention: "glance", soon: "去开会" },
  运动: { where: "她在运动，停下来喝水", phone: "还有点喘。", attention: "glance", soon: "去运动" },
  通勤: { where: "她在路上", phone: "站着，一只手拿手机。", attention: "half", soon: "出门" },
  出门: { where: "她在外面", phone: "边走边看手机。", attention: "half", soon: "出门" },
  洗澡: { where: "她刚洗完澡出来", phone: "头发还湿着。", attention: "half", soon: "去洗澡" },
  天文台: { where: "她在天文台带小孩的课，这会儿是课间", phone: "一会儿还要回去。", attention: "glance", soon: "去天文台讲课" },
  写作: { where: "她在写自己的东西", phone: "文档开着。", attention: "glance", soon: "去写自己的东西" },
  喝酒: { where: "她喝了一点酒", phone: "手机在手里。", attention: "full" },
  生病: { where: "她不舒服，窝着", phone: "手机在手里，没什么力气。", attention: "half" },
  空闲: { where: "她这会儿没什么事", phone: "手机在手里。", attention: "full" },
});

const FREE_AT_NIGHT = Object.freeze({ where: "她在家，已经窝下了", phone: "今晚没别的事。", attention: "full" });
const SAFETY_SCENE = Object.freeze({ where: "她看到他这句话，把手上的事全放下了", phone: "", attention: "full" });

const isNight = (hour) => hour >= NIGHT_FROM_HOUR || hour < NIGHT_UNTIL_HOUR;

/** 紧跟在当前时段后面的那个时段；没有返回 null。 */
function nextSlot(slots, slot) {
  const index = (slots ?? []).indexOf(slot);
  return index >= 0 ? slots[index + 1] ?? null : (slots ?? []).find((item) => item.start > (slot?.start ?? 0)) ?? null;
}

/**
 * 她此刻的处境。
 * @param {{slot?: {tag: string, text?: string, start?: number} | null, slots?: any[], now: Date, safety?: boolean}} input
 * @returns {{attention: "glance"|"half"|"full", tag: string, lines: string[], brief: string}}
 */
export function sceneOf(input) {
  const tag = input.slot?.tag ?? "空闲";
  if (input.safety) return { attention: "full", tag, spot: null, lines: [`${SAFETY_SCENE.where}。${SAFETY_SCENE.phone}`], brief: SAFETY_SCENE.where };
  const hour = input.now.getHours();
  const place = tag === "空闲" && isNight(hour) ? FREE_AT_NIGHT : PLACES[tag] ?? PLACES.空闲;
  const detail = String(input.slot?.text ?? "").trim();
  const lines = [`${place.where}。${detail ? `日程上这一段写的是「${detail}」。` : ""}${place.phone}`];
  const minute = hour * 60 + input.now.getMinutes();
  const next = nextSlot(input.slots, input.slot);
  const left = next ? next.start - minute : null;
  const soon = next && next.tag !== tag ? PLACES[next.tag]?.soon : null;
  if (soon && left !== null && left > 0 && left <= SOON_MINUTES) lines.push(`再过${left <= 5 ? "几分钟" : "十来分钟"}她就要${soon}。`);
  // brief：给决策模型看的一句（第三人称，带钟点）。spot：扰动查表用的地点键。
  const brief = `${pad2(hour)}:${pad2(input.now.getMinutes())}，${place.where}${detail ? `（${detail}）` : ""}`;
  const spot = place === FREE_AT_NIGHT ? "夜里在家" : PLACES[tag] ? tag : "空闲";
  return { attention: place.attention, tag, spot, lines, brief, minutesToNext: soon && left > 0 ? left : null };
}

/**
 * 提示词「此刻」下面的几行。只有事实，不追加说明。
 * @param {{lines: string[]} | null} situation 她在哪、手上在干嘛
 * @param {string[]} [conversation] 这段聊天聊到了什么份上（conversation.conversationLines）
 * @param {string[]} [passing] 这一刻碰巧发生的小事（perturbation）
 * @returns {string[]}
 */
export function formatSituation(situation, conversation = [], passing = []) {
  return [[...(situation?.lines ?? []), ...passing].join(""), conversation.join("")].filter(Boolean);
}
