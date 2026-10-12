// ============================================================
// 设置、模型接入、人设、基石（data/core.md，只读）。
//   GET/PUT /api/lin/settings      PUT 只收合法字段，有不合法的整体 400
//   GET/PUT /api/lin/model         GET 打码；PUT 字段留空 = 不改
//   POST    /api/lin/model/test    两个角色各发一句极短的话
//   GET/PUT /api/lin/persona
//   GET     /api/lin/core          只给 data/core.md；她自己的那条基石只在代码里，任何接口都不返回
// ============================================================

import { getDataDir } from "../../config/paths.js";
import { isDry } from "../../config/runtime.js";
import { maskModelSecrets, readModelSecrets, updateModelSecrets } from "../../config/secrets.js";
import { readSettings, updateSettings } from "../../config/settings.js";
import { PERSONA_MAX_CHARS, readCore, readPersona, writePersona } from "../../companion/persona.js";
import { testModels } from "../../model/client.js";
import { readState } from "../../store/state.js";
import { HttpError } from "../router.js";

/** 设置页看得到的程序状态（不含游标等内部细节）。 */
const VISIBLE_STATE_KEYS = Object.freeze(["lastUserMessageAt", "lastProactiveAt", "mainConversationId", "lastSnapshotDay", "consolidationSkipped"]);

/**
 * @param {ReturnType<import("../router.js").createRouter>} router
 * @param {{broadcast: (type: string, data: any) => void}} deps
 */
export function registerSettingsRoutes(router, deps) {
  router.get("/api/lin/settings", async () => {
    const [settings, state] = await Promise.all([readSettings(), readState()]);
    const visible = Object.fromEntries(VISIBLE_STATE_KEYS.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
    return { settings, state: visible, dataDir: getDataDir(), dry: isDry() };
  });

  router.put("/api/lin/settings", async (ctx) => {
    const body = await ctx.body();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid body");
    const { settings, rejected } = await updateSettings(body);
    if (!settings) throw new HttpError(400, `invalid fields: ${rejected.join(",")}`);
    deps.broadcast("settings", { changed: Object.keys(body) });
    return { settings };
  });

  router.get("/api/lin/model", async () => maskModelSecrets(await readModelSecrets()));

  router.put("/api/lin/model", async (ctx) => {
    const result = await updateModelSecrets(await ctx.body());
    if (!result.secrets) throw new HttpError(400, `invalid fields: ${result.rejected.join(",")}`);
    return maskModelSecrets(result.secrets);
  });

  router.post("/api/lin/model/test", () => testModels());

  router.get("/api/lin/persona", async () => ({ persona: await readPersona() }));

  router.put("/api/lin/persona", async (ctx) => {
    const body = await ctx.body();
    if (typeof body.persona !== "string" || body.persona.length > PERSONA_MAX_CHARS) throw new HttpError(400, "invalid persona");
    await writePersona(body.persona);
    return { ok: true };
  });

  router.get("/api/lin/core", async () => ({ core: await readCore() }));
}
