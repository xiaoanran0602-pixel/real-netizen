// ============================================================
// 13 / 14 的调试接口（只给他看，不进她的认知，聊天渠道上永远看不到）：
//   GET  /api/lin/body              新内核的快照（四维、档位、模拟心率、状态、模式）
//   POST /api/lin/body/event        手工提交一条评价事件（P1 纯核心验收用；走同一个去重入口）
//   POST /api/lin/body/simulate     只读投影 N 小时后的四维（hours=N）
//   GET  /api/lin/thoughts          念头池概览（网页默认折叠：他看到池子，黑箱就没了）
//   POST /api/lin/thoughts/hourly   立即推进一次（调试）
// ============================================================

import { readSettings } from "../../config/settings.js";
import { projectBody } from "../../inner/body-advance.js";
import { poolSummary } from "../../inner/thought-context.js";
import { HOUR_MS } from "../../util/time.js";
import { HttpError } from "../router.js";

const MAX_SIMULATE_HOURS = 24 * 14;

/**
 * @param {ReturnType<import("../router.js").createRouter>} router
 * @param {{kernel?: any, thoughts?: any}} deps
 */
export function registerKernelRoutes(router, deps) {
  router.get("/api/lin/body", async () => {
    const settings = await readSettings();
    if (!deps.kernel) return { status: "unavailable", mode: settings.innerEngineMode };
    return { ...deps.kernel.snapshot(Date.now()), mode: settings.innerEngineMode };
  });

  router.post("/api/lin/body/event", async (ctx) => {
    if (!deps.kernel) throw new HttpError(503, "kernel unavailable");
    const body = await ctx.body();
    const event = { id: String(body.id ?? `manual:${Date.now()}`), type: "chat_appraisal", occurredAt: Date.now(), payload: body.payload ?? null };
    return deps.kernel.accept(event);
  });

  router.post("/api/lin/body/simulate", async (ctx) => {
    if (!deps.kernel) throw new HttpError(503, "kernel unavailable");
    const hours = Number(ctx.query.get("hours"));
    if (!Number.isFinite(hours) || hours < 0 || hours > MAX_SIMULATE_HOURS) throw new HttpError(400, "invalid hours");
    const snapshot = deps.kernel.snapshot(Date.now());
    if (!snapshot.values) return snapshot;
    const projected = projectBody({ ...snapshot, at: Date.now(), values: snapshot.values, bands: snapshot.bands }, Date.now() + hours * HOUR_MS, deps.kernel.timeline());
    return { at: projected.at, values: projected.values, bands: projected.bands };
  });

  router.get("/api/lin/thoughts", async () => poolSummary());

  router.post("/api/lin/thoughts/hourly", async () => {
    if (!deps.thoughts) throw new HttpError(503, "thoughts unavailable");
    await deps.thoughts.hourly();
    return poolSummary();
  });
}
