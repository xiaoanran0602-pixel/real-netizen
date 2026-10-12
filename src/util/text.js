// ============================================================
// 文本：中英计词（记忆整理的门槛）与二字切片分词（记忆相关度）。
// 中文没有空格，用二字切片（bigram）+ 英文单词做重叠计数。个人记忆量小，这个精度够用。
// ============================================================

export const BIGRAM_WEIGHT = 1;
// 单字权重低：「肝」「猫」这类单字名词很关键，但单字也容易碰巧重合。
export const UNIGRAM_WEIGHT = 0.5;
const STOP_BIGRAMS = new Set(["我们", "你们", "他们", "什么", "怎么", "这个", "那个", "一个", "没有", "就是", "还是", "不是", "可以"]);
const STOP_UNIGRAMS = new Set("的了是我你他她它在有和就也都很又还不没吗呢吧啊呀哦嗯着过个这那么去来说要会到把被让给一上下里");
const CJK_RUN = /[\u3400-\u9fff]+/gu;
const CJK_CHAR = /[\u3400-\u9fff]/gu;
const LATIN_WORD = /[a-z0-9]{2,}/gu;

/**
 * 计词：中文每个字算一个词，其余按空白分词。
 * 修复旧问题：原来按空白数词，中文整句只算 1 个词，导致中文聊天永远达不到整理门槛。
 * @param {string} text
 */
export function countWords(text) {
  const source = String(text ?? "");
  const cjk = source.match(CJK_CHAR)?.length ?? 0;
  const rest = source.replace(CJK_CHAR, " ").split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  return cjk + rest;
}

/**
 * 分词成「词 → 权重」。
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function tokenize(text) {
  /** @type {Map<string, number>} */
  const tokens = new Map();
  const lower = String(text ?? "").toLowerCase();
  for (const word of lower.match(LATIN_WORD) ?? []) tokens.set(word, BIGRAM_WEIGHT);
  for (const run of lower.match(CJK_RUN) ?? []) {
    for (const char of run) {
      if (!STOP_UNIGRAMS.has(char) && !tokens.has(char)) tokens.set(char, UNIGRAM_WEIGHT);
    }
    for (let index = 0; index + 1 < run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!STOP_BIGRAMS.has(bigram)) tokens.set(bigram, BIGRAM_WEIGHT);
    }
  }
  return tokens;
}

/**
 * query 与文本的重叠分。
 * @param {Map<string, number>} query
 * @param {string} text
 */
export function overlapScore(query, text) {
  if (query.size === 0) return 0;
  const tokens = tokenize(text);
  let score = 0;
  for (const [token, weight] of query) if (tokens.has(token)) score += weight;
  return score;
}

/** 两段文字里共同出现的「关键词」（二字词或英文词）个数。 */
export function sharedKeywordCount(a, b) {
  const left = tokenize(a);
  const right = tokenize(b);
  let count = 0;
  for (const [token, weight] of left) if (weight >= BIGRAM_WEIGHT && right.has(token)) count += 1;
  return count;
}

/** 截断并加省略号。 */
export function clip(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** 多行压成一行。 */
export function oneLine(text) {
  return String(text ?? "").replace(/\s*\n+\s*/gu, " ").trim();
}

/** 按空行拆段。 */
export function splitParagraphs(text) {
  return String(text ?? "")
    .split(/\n\s*\n/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * 称呼回退：提示词里需要称呼「用户名」时，没有就用「他」。
 * 用户名默认空字符串（开源版不再绑定任何真实人名）。
 * @param {string | null | undefined} name
 * @returns {string}
 */
export function displayUserName(name) {
  const value = String(name ?? "").trim();
  return value ? value : "他";
}
