// ============================================================
// 内心状态的变化记录（调试面板用）。状态的唯一写入者是内核（kernel.js），
// 这里只读 data/kernel-log.jsonl 里最近的 kernel_event，不写任何东西。
// ============================================================

import { paths } from "../config/paths.js";
import { readText } from "../store/files.js";

/** 最近几条内核事件（调试面板）：类型、时刻、载荷。 */
export async function readInnerLog(limit = 20) {
  const text = (await readText(paths.kernelLog())) ?? "";
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.recordType === "kernel_event") rows.push({ at: row.acceptedAt, kind: row.type, id: row.id, payload: row.payload });
    } catch {
      // 最后一行可能写到一半：跳过。
    }
  }
  return rows.slice(-limit);
}
