// ============================================================
// state.json：程序状态（lastUserMessageAt、mainConversationId、memoryCursor、lastConsolidated、
// lastSnapshotDay、restoring …）。全部在同一进程内，所有写入都经这里串行合并，不会互相覆盖。
// ============================================================

import { paths } from "../config/paths.js";
import { createSerializer, readJson, writeJsonAtomic } from "./files.js";

const serialize = createSerializer();

export async function readState() {
  return readJson(paths.state(), {});
}

/**
 * 合并修改；值为 undefined 的键会被删除。
 * @param {Record<string, unknown> | ((state: Record<string, any>) => Record<string, unknown>)} patch
 */
export function updateState(patch) {
  return serialize(async () => {
    const current = await readState();
    const changes = typeof patch === "function" ? patch(current) : patch;
    const next = { ...current };
    for (const [key, value] of Object.entries(changes ?? {})) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    await writeJsonAtomic(paths.state(), next);
    return next;
  });
}

/** 整体替换（回档写回时用）。 */
export function replaceState(next) {
  return serialize(async () => {
    await writeJsonAtomic(paths.state(), next);
    return next;
  });
}
