// ============================================================
// 回档（design §12）：
//   GET    /api/lin/archive                   存档列表（新的在前）、占用、回档状态
//   POST   /api/lin/archive/restore {day, confirm}   confirm 必须等于 MM-DD；进度走 SSE archive
//   DELETE /api/lin/archive/before/:day      删除该日期之前的存档并回收对象
// ============================================================

import { deleteArchivesBefore } from "../../archive/restore.js";
import { archiveBytes, listArchiveDays, readManifest } from "../../archive/snapshot.js";
import { HttpError } from "../router.js";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** restore.js 抛的 {status} 错误转成 HTTP 状态码。 */
async function withStatus(work) {
  try {
    return await work();
  } catch (error) {
    if (error?.status) throw new HttpError(error.status, error.message);
    throw error;
  }
}

/**
 * @param {ReturnType<import("../router.js").createRouter>} router
 * @param {{restorer: ReturnType<import("../../archive/restore.js").createRestorer>}} deps
 */
export function registerArchiveRoutes(router, deps) {
  router.get("/api/lin/archive", async () => {
    const days = (await listArchiveDays()).reverse();
    const items = await Promise.all(days.map(async (day) => ({ day, summary: (await readManifest(day))?.summary ?? null })));
    return { days: items, bytes: await archiveBytes(), restore: deps.restorer.status() };
  });

  router.post("/api/lin/archive/restore", async (ctx) => {
    const body = await ctx.body();
    const day = typeof body.day === "string" ? body.day : "";
    if (!DAY_PATTERN.test(day)) throw new HttpError(400, "日期格式不对");
    const status = await withStatus(() => deps.restorer.restore(day, body.confirm));
    return { status };
  });

  router.delete("/api/lin/archive/before/:day", async (ctx) => {
    const day = ctx.params.day;
    if (!DAY_PATTERN.test(day)) throw new HttpError(400, "日期格式不对");
    if (deps.restorer.status().status === "running") throw new HttpError(409, "正在回档");
    return withStatus(() => deleteArchivesBefore(day));
  });
}
