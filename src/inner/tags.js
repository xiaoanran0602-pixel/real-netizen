// ============================================================
// 日程标签（docs/12 第 4 节）：每行「HH:MM [标签] 内容」。程序只认固定小集合，不认识的忽略。
// 没有标签的行当作「空闲」；旧日程（没有任何标签）按“白天空闲、23:30–08:00 睡着”兜底，不回改旧文件。
// 今天日程追加的「实际：HH:MM [标签] …」以追加内容为准覆盖当前时段。
// 时段序列是一天里按时间排列的 {start(分钟), tag, text}，覆盖从 0 点到 24 点。
// ============================================================

export const TAGS = Object.freeze(["起床", "睡觉", "吃饭", "上班", "加班", "截止", "开会", "运动", "通勤", "出门", "洗澡", "天文台", "写作", "喝酒", "生病", "空闲"]);
const TAG_SET = new Set(TAGS);
export const DEFAULT_TAG = "空闲";

/** 可回复性：空闲 / 忙 / 很忙 / 睡着。 */
export const AVAILABILITY = Object.freeze({
  起床: "free",
  睡觉: "asleep",
  吃饭: "free",
  上班: "busy",
  加班: "busy",
  截止: "busy",
  开会: "very_busy",
  运动: "very_busy",
  通勤: "free",
  出门: "free",
  洗澡: "very_busy",
  天文台: "very_busy",
  写作: "busy",
  喝酒: "free",
  生病: "busy",
  空闲: "free",
});

/** 网页标题下的状态文字。 */
export const STATUS_TEXT = Object.freeze({
  起床: "在线",
  睡觉: "睡了",
  吃饭: "在吃饭",
  上班: "在上班",
  加班: "在加班",
  截止: "在赶稿",
  开会: "在开会",
  运动: "在运动",
  通勤: "在路上",
  出门: "在路上",
  洗澡: "在洗澡",
  天文台: "在天文台",
  写作: "在写东西",
  喝酒: "在外面",
  生病: "不太舒服",
  空闲: "在线",
});

const LINE = /^\s*(?:实际[:：]\s*)?(\d{1,2})[:：](\d{2})\s*(?:\[([^\]]*)\])?\s*(.*)$/u;
const ACTUAL = /^\s*实际[:：]/u;
const FALLBACK_SLEEP_START = 23 * 60 + 30;
const FALLBACK_WAKE = 8 * 60;

/**
 * 解析一份日程文本。
 * @param {string} text
 * @returns {{slots: {start: number, tag: string, text: string, actual: boolean}[], tagged: boolean}}
 */
export function parseSchedule(text) {
  const plan = [];
  const actual = [];
  let tagged = false;
  for (const raw of String(text ?? "").split(/\r?\n/u)) {
    const match = LINE.exec(raw);
    if (!match) continue;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 24 || minute > 59) continue;
    const label = (match[3] ?? "").trim();
    // 解析容错：标签不认识就忽略，当作空闲；也认「[ 开会 ]」「[开会/加班]」取第一个认识的。
    const known = label.split(/[\/、,，\s]+/u).find((part) => TAG_SET.has(part));
    if (known) tagged = true;
    const slot = { start: Math.min(hour * 60 + minute, 24 * 60 - 1), tag: known ?? DEFAULT_TAG, text: match[4].trim(), actual: ACTUAL.test(raw) };
    (slot.actual ? actual : plan).push(slot);
  }
  plan.sort((a, b) => a.start - b.start);
  // 「实际」覆盖计划：从实际那一刻起替换，直到计划里的下一个时间点。
  for (const item of actual) {
    const index = plan.findIndex((slot) => slot.start > item.start);
    if (index < 0) plan.push(item);
    else plan.splice(index, 0, item);
  }
  return { slots: plan, tagged };
}

/** 旧日程兜底：白天空闲、23:30–08:00 睡着。 */
export function fallbackSlots() {
  return [
    { start: 0, tag: "睡觉", text: "", actual: false },
    { start: FALLBACK_WAKE, tag: "起床", text: "", actual: false },
    { start: FALLBACK_WAKE + 1, tag: DEFAULT_TAG, text: "", actual: false },
    { start: FALLBACK_SLEEP_START, tag: "睡觉", text: "", actual: false },
  ];
}

/**
 * 一天的时段序列（从 0 点开始）。没有标签的日程或没有日程 → 兜底。
 * 第一项之前的时间沿用前一天最后的状态（previousLastTag，默认睡着）。
 * @param {string | null | undefined} text
 * @param {string} [previousLastTag]
 */
export function daySlots(text, previousLastTag = "睡觉") {
  const parsed = text ? parseSchedule(text) : { slots: [], tagged: false };
  const slots = parsed.tagged ? parsed.slots : fallbackSlots();
  if (slots.length === 0 || slots[0].start > 0) slots.unshift({ start: 0, tag: previousLastTag, text: "", actual: false });
  return slots;
}

/** 某分钟所在的时段。 */
export function slotAt(slots, minuteOfDay) {
  let current = slots[0];
  for (const slot of slots) {
    if (slot.start <= minuteOfDay) current = slot;
    else break;
  }
  return current;
}

/** 睡觉标签之后、下一个起床之前都算睡着。 */
export function isAsleep(tag) {
  return AVAILABILITY[tag] === "asleep";
}

/** 当天下一个「起床」的分钟数；没有返回 null。 */
export function nextWake(slots, minuteOfDay) {
  return slots.find((slot) => slot.start > minuteOfDay && slot.tag === "起床")?.start ?? null;
}

export function lastTag(slots) {
  return slots.at(-1)?.tag ?? DEFAULT_TAG;
}
