// 记忆文件的解析与序列化（网页侧；与服务端 frontmatter.js 输出格式一致）。
const KNOWN_META = new Set(["type", "created", "updated", "expires", "closed"]);
const KNOWN_TOP = new Set(["name", "description", "metadata", "type"]);

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

export function parseMemory(file, content) {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  const result = { file, name: file.replace(/\.md$/u, ""), description: "", type: "profile", closed: false, body: normalized.trim(), extraTop: [], extraMeta: [] };
  if (lines[0]?.trim() !== "---") return result;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return result;
  let inMeta = false;
  for (const line of lines.slice(1, end)) {
    const top = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (top) {
      inMeta = top[1] === "metadata";
      if (top[1] === "name") result.name = unquote(top[2] ?? "");
      if (top[1] === "description") result.description = unquote(top[2] ?? "");
      if (top[1] === "type") result.type = unquote(top[2] ?? "");
      if (!KNOWN_TOP.has(top[1])) result.extraTop.push(line);
      continue;
    }
    const nested = /^\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (inMeta && nested) {
      const key = nested[1];
      const value = unquote(nested[2] ?? "");
      if (key === "type") result.type = value;
      else if (key === "created") result.created = value;
      else if (key === "updated") result.updated = value;
      else if (key === "expires") result.expires = value;
      else if (key === "closed") result.closed = value === "true";
      if (!KNOWN_META.has(key)) result.extraMeta.push(line);
    }
  }
  result.body = lines.slice(end + 1).join("\n").trim();
  return result;
}

export function serializeMemory(memory) {
  const meta = [
    `  type: ${memory.type}`,
    ...(memory.created ? [`  created: ${memory.created}`] : []),
    ...(memory.updated ? [`  updated: ${memory.updated}`] : []),
    ...(memory.expires ? [`  expires: ${memory.expires}`] : []),
    ...(memory.closed ? ["  closed: true"] : []),
    ...(memory.extraMeta ?? []),
  ];
  const name = /^[A-Za-z0-9._-]+$/u.test(memory.name) ? memory.name : JSON.stringify(memory.name);
  return ["---", `name: ${name}`, `description: ${JSON.stringify(memory.description)}`, ...(memory.extraTop ?? []), "metadata:", ...meta, "---", memory.body.trim(), ""].join("\n");
}

export function todayText(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
