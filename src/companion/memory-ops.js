// ============================================================
// 记忆操作：校验 + 经写入守卫执行。记忆整理（每轮聊完）与定时整理（consolidation）共用。
//   write  新建或整篇改写（非 life 文件的内容必须能解析出文件头）
//   append 在文件末尾追加一行（今天的日程只能这样改）
//   delete 删除
// 拒绝的操作记原因返回，其余照常执行。
// ============================================================

import { join } from "node:path";
import { paths } from "../config/paths.js";
import { appendText, fileExists, readText, removeFile, writeTextAtomic } from "../store/files.js";
import { evaluateMemoryOp, LIFE_PREFIX } from "./write-guard.js";
import { invalidateMemoryCache, parseMemoryFile } from "./memory.js";

// 修复：ISO 周文件名里有大写 W（week-2026-W41.md、week-summary-2026-W40.md），只允许小写会把它们全拒掉。
export const OP_FILE_PATTERN = /^(life\/)?[a-z0-9][a-zA-Z0-9._-]{0,80}\.md$/u;
export const OPS = Object.freeze(["write", "append", "delete"]);
const CONTENT_MAX_CHARS = 8_000;
const APPEND_MAX_CHARS = 500;

/**
 * 校验并规范化模型给的操作列表。
 * @param {unknown} raw
 * @returns {{ops: {op: string, file: string, content?: string, text?: string, importance?: string}[], rejected: {op: any, reason: string}[]}}
 */
export function validateOps(raw) {
  const ops = [];
  const rejected = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== "object") {
      rejected.push({ op: item, reason: "不是对象" });
      continue;
    }
    const { op, file } = item;
    if (!OPS.includes(op)) {
      rejected.push({ op: item, reason: "未知操作" });
      continue;
    }
    if (typeof file !== "string" || !OP_FILE_PATTERN.test(file) || file.includes("..")) {
      rejected.push({ op: item, reason: "文件名不合法" });
      continue;
    }
    if (op === "write") {
      if (typeof item.content !== "string" || !item.content.trim() || item.content.length > CONTENT_MAX_CHARS) {
        rejected.push({ op: item, reason: "内容为空或太长" });
        continue;
      }
      if (!file.startsWith(LIFE_PREFIX) && !parseMemoryFile(item.content)) {
        rejected.push({ op: item, reason: "内容没有合法的文件头" });
        continue;
      }
    }
    if (op === "append" && (typeof item.text !== "string" || !item.text.trim() || item.text.length > APPEND_MAX_CHARS)) {
      rejected.push({ op: item, reason: "追加内容为空或太长" });
      continue;
    }
    ops.push({ op, file, ...(op === "write" ? { content: item.content } : {}), ...(op === "append" ? { text: item.text.trim() } : {}), ...(typeof item.importance === "string" ? { importance: item.importance } : {}) });
  }
  return { ops, rejected };
}

export function memoryFilePath(file) {
  return join(paths.memory(), ...file.split("/"));
}

/**
 * 逐条经写入守卫执行。
 * @param {ReturnType<typeof validateOps>["ops"]} ops
 * @param {{now: Date}} options 以 now 为“今天”判定过去/今天
 */
export async function applyOps(ops, { now }) {
  const applied = [];
  const rejected = [];
  for (const op of ops) {
    const decision = evaluateMemoryOp({ file: op.file, op: op.op, now });
    if (!decision.allowed) {
      rejected.push({ op, reason: decision.reason });
      continue;
    }
    const path = memoryFilePath(op.file);
    try {
      if (op.op === "write") {
        await writeTextAtomic(path, op.content.endsWith("\n") ? op.content : `${op.content}\n`);
      } else if (op.op === "append") {
        if (!(await fileExists(path))) {
          rejected.push({ op, reason: "要追加的文件不存在" });
          continue;
        }
        const current = (await readText(path)) ?? "";
        await appendText(path, `${current.endsWith("\n") || current === "" ? "" : "\n"}${op.text}\n`);
      } else {
        await removeFile(path);
      }
      applied.push(op);
    } catch (error) {
      rejected.push({ op, reason: `写入失败：${error.message}` });
    }
  }
  if (applied.length > 0) invalidateMemoryCache();
  return { applied, rejected };
}
