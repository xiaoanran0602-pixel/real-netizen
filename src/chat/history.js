// ============================================================
// 把对话转成模型消息：从最新往前取，直到字符预算或条数上限；
// 首条必须是 user（Anthropic 要求）；连续同角色合并为一条（比如主动消息后紧跟主动消息）。
// 另外提供网页翻历史用的分页。
// ============================================================

export const HISTORY_CHAR_BUDGET = 24_000;
export const HISTORY_MAX_MESSAGES = 80;
const MERGE_SEPARATOR = "\n\n";

/**
 * @param {readonly {role: string, text: string}[]} messages 按时间升序
 * @param {{charBudget?: number, maxMessages?: number}} [options]
 * @returns {{role: "user"|"assistant", content: string}[]}
 */
export function buildModelMessages(messages, options = {}) {
  const charBudget = options.charBudget ?? HISTORY_CHAR_BUDGET;
  const maxMessages = options.maxMessages ?? HISTORY_MAX_MESSAGES;
  const picked = [];
  let chars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const text = String(message.text ?? "").trim();
    if (!text || (message.role !== "user" && message.role !== "assistant")) continue;
    if (picked.length >= maxMessages) break;
    if (picked.length > 0 && chars + text.length > charBudget) break;
    picked.push({ role: message.role, content: text });
    chars += text.length;
  }
  picked.reverse();
  return normalizeTurns(picked);
}

/**
 * 首条 user + 同角色合并。窗口开头是她的话时丢掉，直到第一条 user。
 * @param {{role: "user"|"assistant", content: string}[]} turns
 */
export function normalizeTurns(turns) {
  const merged = [];
  for (const turn of turns) {
    if (!turn.content) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.content = `${last.content}${MERGE_SEPARATOR}${turn.content}`;
    else merged.push({ role: turn.role, content: turn.content });
  }
  while (merged.length > 0 && merged[0].role !== "user") merged.shift();
  return merged;
}

/** 最近几句真实对话文本（用于挑相关往事）。 */
export function recentText(messages, entryLimit = 6, charLimit = 1200) {
  const texts = [];
  for (let index = messages.length - 1; index >= 0 && texts.length < entryLimit; index -= 1) {
    const text = String(messages[index].text ?? "").trim();
    if (text) texts.push(text);
  }
  return texts.join("\n").slice(0, charLimit);
}

/**
 * 网页分页：after（某 id 之后的全部，补齐用）或 before（某 id 之前的 limit 条，往前翻）或最新 limit 条。
 * after 的 id 不在列表里时返回 reset=true（对话换了或回档了，网页应整页重载）。
 * @template {{id: string}} T
 * @param {readonly T[]} messages
 * @param {{limit?: number, after?: string, before?: string}} query
 */
export function pageMessages(messages, query) {
  const limit = Math.max(1, Math.min(1000, Number(query.limit) || 200));
  if (query.after) {
    const index = messages.findIndex((message) => message.id === query.after);
    if (index < 0) return { messages: [], hasMore: false, reset: true };
    return { messages: messages.slice(index + 1), hasMore: false, reset: false };
  }
  let end = messages.length;
  if (query.before) {
    const index = messages.findIndex((message) => message.id === query.before);
    end = index < 0 ? messages.length : index;
  }
  const start = Math.max(0, end - limit);
  return { messages: messages.slice(start, end), hasMore: start > 0, reset: false };
}
