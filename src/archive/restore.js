// ============================================================
// 回档（design §12.2）：可重复执行的恢复。
//   Idle → Pausing（意图写进 state.restoring，暂停调度，作废正在生成的回复，清空待回复）
//        → Restoring（使存档范围内的文件 = 清单：内容不同就用对象覆盖，多余的删掉；写回经历相关 state 键，时钟键设为目标日）
//        → Pruning（删掉目标日之后的存档，回收没人引用的对象）
//        → Resuming（清除 restoring，缓存全部失效，头像签名变了同步到聊天渠道，恢复调度，广播 archive:done）
//   任一步出错 → Failed：保留 restoring，聊天队列保持阻塞，等用户重试（重试从头再来，结果相同）。
//   启动时看到 restoring 键 → 直接进 Failed，不处理消息（保证断电后不会以“半回档”继续聊天）。
//   回档是主人的操作，不经写入守卫。
// ============================================================

import { join } from "node:path";
import { CLOCK_STATE_KEYS, dataPath, EXPERIENCE_STATE_KEYS, paths } from "../config/paths.js";
import { invalidateAllCaches, listDir, readBytes, removeFile, sha256, writeBytesAtomic, fileStat } from "../store/files.js";
import { invalidateConversations } from "../store/conversation.js";
import { readState, replaceState, updateState } from "../store/state.js";
import { invalidateMemoryCache } from "../companion/memory.js";
import { createLogger } from "../util/log.js";
import { listArchiveDays, listExperienceFiles, manifestPath, objectPath, readManifest } from "./snapshot.js";

const log = createLogger("archive");

/** 确认串：日期的 MM-DD。 */
export function confirmationFor(day) {
  return day.slice(5);
}

/** 使存档范围内的文件等于清单。可重复执行。 */
export async function applyManifest(manifest) {
  let written = 0;
  let removed = 0;
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const path = dataPath(...rel.split("/"));
    const current = await readBytes(path);
    if (current !== null && sha256(current) === hash) continue;
    const bytes = await readBytes(objectPath(hash));
    if (bytes === null) throw new Error(`存档缺少对象：${rel}`);
    await writeBytesAtomic(path, bytes);
    written += 1;
  }
  const wanted = new Set(Object.keys(manifest.files));
  for (const rel of await listExperienceFiles()) {
    if (wanted.has(rel)) continue;
    await removeFile(dataPath(...rel.split("/")));
    removed += 1;
  }
  return { written, removed };
}

/** state.json：经历相关键写回存档里的值（存档里没有的删掉），时钟键设为目标日，其余键不动。 */
export async function restoreStateKeys(manifest) {
  const current = await readState();
  const next = { ...current };
  for (const key of EXPERIENCE_STATE_KEYS) {
    if (manifest.state?.[key] !== undefined) next[key] = manifest.state[key];
    else delete next[key];
  }
  next.lastSnapshotDay = manifest.day;
  next.lastConsolidated = { day: manifest.day, week: manifest.day, month: manifest.day };
  for (const key of CLOCK_STATE_KEYS) if (next[key] === undefined) delete next[key];
  await replaceState(next);
  return next;
}

/** 标记-清除：删掉 days 中不需要的清单后，回收没有任何清单引用的对象。返回释放字节数。 */
export async function sweepObjects() {
  const referenced = new Set();
  for (const day of await listArchiveDays()) {
    const manifest = await readManifest(day);
    for (const hash of Object.values(manifest?.files ?? {})) referenced.add(hash);
  }
  let freed = 0;
  for (const prefix of await listDir(paths.archiveObjects())) {
    for (const name of await listDir(join(paths.archiveObjects(), prefix))) {
      if (referenced.has(name)) continue;
      const path = join(paths.archiveObjects(), prefix, name);
      freed += (await fileStat(path))?.size ?? 0;
      await removeFile(path);
    }
  }
  return freed;
}

/** 删除某日期之前的存档（只能从最早的往后删，剩下的每份都完整）。 */
export async function deleteArchivesBefore(day) {
  const days = await listArchiveDays();
  const remove = days.filter((item) => item < day);
  if (remove.length === days.length) throw Object.assign(new Error("至少要留一份存档"), { status: 400 });
  for (const item of remove) await removeFile(manifestPath(item));
  const freedBytes = await sweepObjects();
  return { removedDays: remove.length, freedBytes };
}

/**
 * @param {{
 *   chatService: ReturnType<import("../chat/chat-service.js").createChatService>,
 *   broadcast?: (type: string, data: any) => void,
 *   pauseSchedulers?: () => Promise<void> | void, resumeSchedulers?: () => void,
 *   clearPendingReplies?: () => Promise<void> | void,
 *   syncChannelProfile?: (before: any, after: any) => Promise<void>,
 *   readProfile?: () => Promise<any>,
 *   onRestored?: () => Promise<void> | void,
 * }} deps
 */
export function createRestorer(deps) {
  const broadcast = deps.broadcast ?? (() => {});
  let status = { status: "idle" };

  function setStatus(next) {
    status = { ...next, at: Date.now() };
    broadcast("archive", status);
  }

  async function pause() {
    deps.chatService.queue.block("restoring");
    deps.chatService.queue.abortCurrent();
    await deps.pauseSchedulers?.();
    await deps.clearPendingReplies?.();
  }

  async function doRestore(day) {
    const manifest = await readManifest(day);
    if (!manifest) throw Object.assign(new Error(`没有 ${day} 的存档`), { status: 404 });
    const profileBefore = await deps.readProfile?.().catch(() => null);
    setStatus({ status: "running", day, step: "恢复文件" });
    const result = await applyManifest(manifest);
    await restoreStateKeys(manifest);
    setStatus({ status: "running", day, step: "清理之后的存档" });
    for (const later of (await listArchiveDays()).filter((item) => item > day)) await removeFile(manifestPath(later));
    await sweepObjects();
    invalidateAllCaches();
    invalidateConversations();
    invalidateMemoryCache();
    deps.chatService.clearFailed();
    await updateState({ restoring: undefined });
    const profileAfter = await deps.readProfile?.().catch(() => null);
    await deps.syncChannelProfile?.(profileBefore, profileAfter).catch((error) => log.warn("channel profile sync after restore failed", { error: error?.message }));
    await deps.onRestored?.();
    log.info("restored", { day, ...result });
    return result;
  }

  return {
    status: () => status,

    /** 启动时检查：有未完成的回档就进入失败态，阻塞聊天。 */
    async checkOnStartup() {
      const state = await readState();
      if (!state.restoring?.day) return false;
      await pause();
      setStatus({ status: "failed", day: state.restoring.day, error: "上次回档没有完成（程序中途退出），请重试。" });
      return true;
    },

    /**
     * 回到某一天。confirm 必须等于 MM-DD。重试也走这里。
     * @param {string} day
     * @param {string} confirm
     */
    async restore(day, confirm) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw Object.assign(new Error("日期格式不对"), { status: 400 });
      if (String(confirm ?? "").trim() !== confirmationFor(day)) throw Object.assign(new Error("确认日期没对上"), { status: 400 });
      if (status.status === "running") throw Object.assign(new Error("正在回档"), { status: 409 });
      if (!(await readManifest(day))) throw Object.assign(new Error(`没有 ${day} 的存档`), { status: 404 });
      await updateState({ restoring: { day, startedAt: Date.now() } });
      setStatus({ status: "running", day, step: "暂停" });
      await pause();
      try {
        // 作为强制系统任务插队：等正在进行的那一轮结束（已作废）后立即执行，后面的消息都排着。
        const result = await deps.chatService.runSystemTask(() => doRestore(day), { front: true, force: true });
        deps.chatService.queue.unblock();
        deps.resumeSchedulers?.();
        setStatus({ status: "done", day, ...result });
        return status;
      } catch (error) {
        log.error("restore failed", { day, error });
        setStatus({ status: "failed", day, error: error.message });
        return status;
      }
    },
  };
}
