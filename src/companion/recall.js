// ============================================================
// 按预算挑选进提示词的记忆（design §11.4）：
//   默认只给轮廓；当前用户消息强相关/明确追问时，清晰记忆才展开；模糊/沉底仍只给概括。
//   分层与旧版一致（关于他 / 喜好 / 他最近 / 没聊完 / 往事 / 她自己 / 她这几天），每层配额，底色层优先保证；
//   层内按「清晰度 × 重要度权重 + 相关度」排序；总预算约 6000 字。
//   本轮结束后：只按当前用户的话加固，不能靠她自己的复述自我强化。没有线索不补最新往事。
// ============================================================

import { formatLocalDate } from "../util/time.js";
import { clip, sharedKeywordCount, tokenize } from "../util/text.js";
import { compareByDateDesc, digestTitles, formatEntry, isMemoryExpired, MEMORY_BODY_CHAR_LIMIT, relevanceScore, RELATED_MIN_SCORE } from "./memory.js";
import { annotate, readStrengthTable, recallMemories, syncStrength } from "./strength.js";

export const TOTAL_BUDGET_CHARS = 6000;
export const SUNK_RECALL_MIN_SCORE = RELATED_MIN_SCORE * 3;
export const RECALL_KEYWORD_MIN = 2;
export const OUTLINE_CHAR_LIMIT = 120;
export const DETAIL_RECALL_MIN_SCORE = 6;
const IMPORTANCE_WEIGHT = { normal: 1, care: 1.5, core: 2 };
const PINNED_BONUS = 0.5;
const RELEVANCE_WEIGHT = 0.3;
const SELF_DAILY_KEEP_DAYS = 3;
// 只调节细节展开，不凭这些词召回无关记忆；仍须通过相关性门槛。
const DETAIL_REQUEST = /[?？]|记得|记不记得|具体|细节|多少|哪[个里年天次家]|什么时候|怎么[去来做]|what|when|where|remember/iu;
// 起床、天冷、刚吃饭不自动授权健康/行程巡问。专题档案仍存盘，只是本轮不展示。
const ROUTINE_TOPICS = {
  commute: /公交|地铁|通勤|骑车|骑自行车|班车|怎么去公司|怎么回家/u,
  health: /身体|健康|头.{0,3}[疼痛]|感冒|生病|布洛芬|吃药|发烧|发热|咳嗽|嗓子|疼痛|伤口|晒伤|掉皮|复查|肝功能|医院|看病/u,
};
const ELLIPTIC_ANSWER = /^(好多了|好点了|好些了|已经好了|好了|不疼了|还疼|还没好|没好|还没|已经到了|到了|坐公交|坐地铁|还是公交|没有|没有了|是的|嗯)[，,。！!\s]*$/u;
function routineTopic(entry) {
  if (["self", "self_daily", "preference"].includes(entry.type)) return null;
  const subject = entry.description || String(entry.body ?? "").split(/[。\n]/u)[0];
  // “感冒所以坐公交”这条的主题是通勤，不能由“头不疼了”串出坐车问题。
  return Object.keys(ROUTINE_TOPICS).find((key) => ROUTINE_TOPICS[key].test(subject)) ?? null;
}
function routineCue(topic, text, previousAssistantText) {
  if (!topic) return null;
  const clauses = String(text ?? "").split(/[，,。；;\n]/u);
  const refusal = /(?:别|不要|不用|不想)(?:再|一直|老是)?(?:问|聊|管|提)|不聊这个/u;
  const allowed = clauses.filter((part) => !refusal.test(part)).join(" ");
  if (ROUTINE_TOPICS[topic].test(allowed)) return allowed;
  if (clauses.some((part) => refusal.test(part))) return null;
  // 仅当本轮确实是短回答，且上一条最后一个问句属于该主题，才承接。
  if (!ELLIPTIC_ANSWER.test(String(text ?? "").trim())) return null;
  const questions = String(previousAssistantText ?? "").match(/[^。！？!?\n]+[？?]|[^。！？!?\n]+(?:吗|没)[。]?$/gu) ?? [];
  const last = questions.at(-1) ?? "";
  return ROUTINE_TOPICS[topic].test(last) ? last : null;
}
/**
 * 每层配额（字）。底色层（关于他、喜好、她自己）排前面，先拿预算。
 * 修复：迁移演练发现「关于他」只有 9 条就已约 1900 字，1500 的硬配额把他身体、钱、近况几条挤掉了，
 * 她会突然“不记得”这些（旧版全都在）。底色层改为配额 + 可借用总预算的余量（design §11.4「优先保证」）。
 */
export const LAYER_QUOTA = Object.freeze({ aboutHim: 1500, hisPreferences: 900, aboutMe: 900, hisRecent: 900, openThreads: 600, related: 1200, myRecent: 600 });
const FOUNDATION_LAYERS = new Set(["aboutHim", "hisPreferences", "aboutMe"]);
/** 非底色层至少留这么多给它们（不被底色层借光）。 */
const RESERVED_FOR_OTHERS = 1800;
const LAYER_PRIORITY = ["aboutHim", "hisPreferences", "aboutMe", "hisRecent", "openThreads", "related", "myRecent"];

function layerOf(entry, today) {
  switch (entry.type) {
    case "profile":
      return "aboutHim";
    case "preference":
      return "hisPreferences";
    case "self":
      return "aboutMe";
    case "recent":
      return isMemoryExpired(entry, today) ? "related" : "hisRecent";
    case "thread":
      return entry.closed ? "related" : "openThreads";
    case "self_daily":
      return isMemoryExpired(entry, today) ? null : "myRecent";
    default:
      return "related";
  }
}

function withinDays(date, today, days) {
  if (!date) return true;
  const diff = (Date.parse(today) - Date.parse(date)) / 86_400_000;
  return Number.isNaN(diff) || diff < days;
}

/** 呈现轮廓不改变清晰度或磁盘记忆；老文件没有摘要时只取首句，避免退回整份档案。 */
function outlineOf(entry) {
  const firstSentence = String(entry.body ?? "").trim().match(/^[^。！？!?\n]+[。！？!?]?/u)?.[0];
  const text = [entry.record.gist, entry.description, firstSentence, entry.name].find((part) => String(part ?? "").trim());
  return clip(String(text ?? "").trim(), OUTLINE_CHAR_LIMIT);
}

/**
 * 纯函数：挑选并格式化。
 * @param {{memories: readonly any[], table: Record<string, any>, today: string, recentText: string, previousAssistantText?: string, userName: string, budget?: number}} input recentText 只含当前用户整条消息
 * @returns {{text: string | null, picked: any[]}}
 */
export function selectMemories(input) {
  const { today } = input;
  const budget = input.budget ?? TOTAL_BUDGET_CHARS;
  const query = tokenize(input.recentText);
  const wantsDetail = DETAIL_REQUEST.test(input.recentText ?? "");
  const annotated = annotate(input.memories, input.table, today);
  /** @type {Record<string, any[]>} */
  const layers = Object.fromEntries(LAYER_PRIORITY.map((key) => [key, []]));
  for (const entry of annotated) {
    const layer = layerOf(entry, today);
    if (!layer) continue;
    const topic = routineTopic(entry);
    const cue = routineCue(topic, input.recentText ?? "", input.previousAssistantText);
    if (topic && !cue) continue;
    if (layer === "myRecent" && !withinDays(entry.created ?? entry.updated, today, SELF_DAILY_KEEP_DAYS)) continue;
    const relevance = topic && cue ? relevanceScore(entry, tokenize(cue.replace(/头(?:还|不|有点|很|又|也|一直)*疼/gu, "头疼"))) : query.size > 0 ? relevanceScore(entry, query) : 0;
    if (topic && relevance < RELATED_MIN_SCORE) continue;
    const related = relevance >= RELATED_MIN_SCORE;
    // 底色常驻但只给轮廓；近况、未完话题和往事不再无条件挤进每一轮。
    if (!FOUNDATION_LAYERS.has(layer) && !entry.record.pinned && !related) continue;
    const alreadyMentioned = sharedKeywordCount(`${entry.description ?? ""} ${entry.body ?? ""}`, input.previousAssistantText ?? "") >= RECALL_KEYWORD_MIN;
    let mode = entry.clarity === "clear" && related && (wantsDetail || (relevance >= DETAIL_RECALL_MIN_SCORE && !alreadyMentioned)) ? "full" : "gist";
    if (entry.clarity === "sunk") {
      if (relevance < SUNK_RECALL_MIN_SCORE) continue;
      mode = "gist";
    }
    const weight = IMPORTANCE_WEIGHT[entry.record.importance] ?? 1;
    const score = entry.r * weight + (entry.record.pinned ? PINNED_BONUS : 0) + relevance * RELEVANCE_WEIGHT;
    const text = mode === "full" ? entry.body || entry.description || entry.name || "" : outlineOf(entry);
    if (!text.trim()) continue;
    layers[layer].push({ entry, mode, score, relevance, text });
  }
  // 对话历史负责上下文连续性，不能靠无关往事凑回忆。
  layers.related.sort((a, b) => b.relevance - a.relevance || b.score - a.score);
  for (const key of LAYER_PRIORITY) if (key !== "related") layers[key].sort((a, b) => b.score - a.score || compareByDateDesc(a.entry, b.entry));

  let remaining = budget;
  /** @type {Record<string, any[]>} */
  const chosen = {};
  const picked = [];
  for (const key of LAYER_PRIORITY) {
    const borrowable = FOUNDATION_LAYERS.has(key) ? Math.max(0, remaining - RESERVED_FOR_OTHERS) : 0;
    let quota = Math.min(Math.max(LAYER_QUOTA[key], borrowable), remaining);
    chosen[key] = [];
    for (const item of layers[key]) {
      const cost = Math.min(item.text.length, MEMORY_BODY_CHAR_LIMIT) + 16;
      if (cost > quota) continue;
      quota -= cost;
      remaining -= cost;
      chosen[key].push({ ...item.entry, recallText: item.text, showDate: item.mode === "full" });
      picked.push(item);
    }
  }
  const blocks = [];
  for (const [key, title, withDate] of digestTitles(input.userName)) {
    const entries = chosen[key] ?? [];
    if (entries.length > 0) blocks.push(`${title}\n${entries.map((entry) => `- ${formatEntry(entry, withDate && entry.showDate, entry.recallText)}`).join("\n")}`);
  }
  return { text: blocks.length > 0 ? blocks.join("\n\n") : null, picked };
}

/**
 * 当前用户的话确实触及哪些已有记忆；调用方不得混入助手复述或旧上下文。
 * @param {any[]} picked
 * @param {string} turnText
 */
export function recalledInTurn(picked, turnText) {
  return picked.filter((item) => sharedKeywordCount(`${item.entry.description} ${item.entry.body} ${item.text}`, turnText) >= RECALL_KEYWORD_MIN).map((item) => item.entry);
}

/** 给 context.js 用的选择器：读强度表、挑选、本轮结束后记想起。 */
export async function recallSelector({ memories, now, recentText, previousAssistantText, userName }) {
  const today = formatLocalDate(now);
  await syncStrength(memories);
  const table = await readStrengthTable();
  const { text, picked } = selectMemories({ memories, table, today, recentText, previousAssistantText, userName });
  return {
    text,
    afterTurn: async () => {
      const recalled = recalledInTurn(picked, recentText ?? "");
      if (recalled.length > 0) await recallMemories(recalled, today);
    },
  };
}
