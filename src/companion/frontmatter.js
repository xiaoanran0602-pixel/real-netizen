// ============================================================
// 记忆文件头（frontmatter）的小型解析与生成，替代 yaml 依赖。
// 只支持记忆文件实际用到的子集：
//   ---
//   name: sunburn-2026-10
//   description: "一句话"            ← 可带双引号（JSON 转义）或单引号
//   metadata:
//     type: recent
//     created: 2026-10-05
//     closed: true
//   ---
//   正文
// 不认识的行在生成时原样保留，保证“记忆文件格式与现有完全一致”。
// ============================================================

/**
 * @typedef {{front: Record<string, unknown>, meta: Record<string, unknown>, extraTop: string[], extraMeta: string[], body: string}} ParsedFrontmatter
 */

const TOP_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/u;
const NESTED_LINE = /^\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/u;
const KNOWN_TOP = new Set(["name", "description", "metadata", "type"]);
const KNOWN_META = new Set(["type", "created", "updated", "expires", "closed"]);

/** 解析一个标量：引号字符串、true/false、数字、其余原样。 */
export function parseScalar(raw) {
  const value = String(raw ?? "").trim();
  if (value === "") return "";
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/gu, "'");
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+(\.\d+)?$/u.test(value) && !/^\d{4}-/u.test(value)) return Number(value);
  return value;
}

/**
 * 解析文件。没有 frontmatter 时返回 null。
 * @param {string} content
 * @returns {ParsedFrontmatter | null}
 */
export function parseFrontmatter(content) {
  const normalized = String(content ?? "").replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return null;
  /** @type {Record<string, unknown>} */
  const front = {};
  /** @type {Record<string, unknown>} */
  const meta = {};
  const extraTop = [];
  const extraMeta = [];
  let inMeta = false;
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const top = TOP_LINE.exec(line);
    if (top) {
      const [, key, rawValue] = top;
      inMeta = key === "metadata" && rawValue.trim() === "";
      if (!inMeta) front[key] = parseScalar(rawValue);
      if (!KNOWN_TOP.has(key)) extraTop.push(line);
      continue;
    }
    const nested = NESTED_LINE.exec(line);
    if (inMeta && nested) {
      const [, key, rawValue] = nested;
      meta[key] = parseScalar(rawValue);
      if (!KNOWN_META.has(key)) extraMeta.push(line);
      continue;
    }
    // 认不出的行（比如多行值）：挂在当前区块，生成时原样保留。
    (inMeta ? extraMeta : extraTop).push(line);
  }
  const body = lines.slice(end + 1).join("\n").trim();
  return { front, meta, extraTop, extraMeta, body };
}

/** 生成字符串值：含特殊字符或中文时用 JSON 双引号。 */
function formatValue(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value ?? "");
  if (/^[A-Za-z0-9._-]+$/u.test(text)) return text;
  return JSON.stringify(text);
}

function formatDateValue(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(String(value)) ? String(value) : formatValue(value);
}

/**
 * 生成记忆文件。与旧网页的 serializeMemory 输出一致。
 * @param {{name: string, description: string, type: string, created?: string, updated?: string, expires?: string, closed?: boolean, body: string, extraTop?: string[], extraMeta?: string[]}} memory
 */
export function serializeMemoryFile(memory) {
  const meta = [
    `  type: ${memory.type}`,
    ...(memory.created ? [`  created: ${formatDateValue(memory.created)}`] : []),
    ...(memory.updated ? [`  updated: ${formatDateValue(memory.updated)}`] : []),
    ...(memory.expires ? [`  expires: ${formatDateValue(memory.expires)}`] : []),
    ...(memory.closed ? ["  closed: true"] : []),
    ...(memory.extraMeta ?? []),
  ];
  return [
    "---",
    `name: ${formatValue(memory.name)}`,
    `description: ${JSON.stringify(memory.description ?? "")}`,
    ...(memory.extraTop ?? []),
    "metadata:",
    ...meta,
    "---",
    String(memory.body ?? "").trim(),
    "",
  ].join("\n");
}
