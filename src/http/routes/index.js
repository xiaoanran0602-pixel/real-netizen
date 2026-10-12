// ============================================================
// 汇总全部 /api/lin/* 路由。main.js 组装好各模块后调用一次。
// ============================================================

import { createRouter } from "../router.js";
import { registerArchiveRoutes } from "./archive.js";
import { registerChannelRoutes } from "./channels.js";
import { registerChatRoutes } from "./chat.js";
import { registerInnerRoutes } from "./inner.js";
import { registerKernelRoutes } from "./kernel.js";
import { registerLanRoutes } from "./lan.js";
import { registerMemoryRoutes } from "./memories.js";
import { registerMomentsRoutes } from "./moments.js";
import { registerSettingsRoutes } from "./settings.js";

/**
 * @param {{
 *   chatService: ReturnType<import("../../chat/chat-service.js").createChatService>,
 *   bridge: ReturnType<import("../../channels/bridge.js").createChannelBridge>,
 *   moments: ReturnType<import("../../moments/scheduler.js").createMomentsScheduler>,
 *   broadcast: (type: string, data: any) => void,
 *   token: string,
 *   restorer?: ReturnType<import("../../archive/restore.js").createRestorer>,
 *   clock?: ReturnType<import("../../clock/daily.js").createDailyClock>,
 *   replyTiming?: {next: () => any},
 * }} deps
 */
export function buildRoutes(deps) {
  const router = createRouter();
  registerSettingsRoutes(router, deps);
  registerChatRoutes(router, deps);
  registerMemoryRoutes(router);
  registerMomentsRoutes(router, deps);
  registerChannelRoutes(router, deps);
  registerLanRoutes(router, deps);
  registerInnerRoutes(router, deps);
  registerKernelRoutes(router, deps);
  if (deps.mediaLibrary) router.get("/api/lin/media", async () => ({ ...(await deps.mediaLibrary.status()), simulation: true }));
  if (deps.restorer) registerArchiveRoutes(router, deps);
  return router;
}
