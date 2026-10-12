// ============================================================
// 聊天渠道接口：
//   GET  /api/lin/channels            设置页用：每个渠道的字段描述 + 打码后的已存值
//   PUT  /api/lin/channels            保存渠道凭据（留空不改、密钥只显示末 4 位）
//   POST /api/lin/channels/webhook    中转服务入站（免令牌、验签），交给 bridge
//   POST /api/lin/channels/:id/test   用该渠道给自己发一条「在吗」验证连通
// ============================================================

import { CHANNELS, channelById } from "../../channels/registry.js";
import { WEBHOOK_PATH } from "../../channels/webhook/channel.js";
import { isChannelReady, maskChannelSecrets, pickChannelPatch, readChannelSecrets, writeChannelSecrets } from "../../config/secrets.js";
import { createLogger } from "../../util/log.js";
import { HttpError, reply } from "../router.js";

const log = createLogger("channels");

/**
 * @param {ReturnType<import("../router.js").createRouter>} router
 * @param {{bridge: ReturnType<import("../../channels/bridge.js").createChannelBridge>}} deps
 */
export function registerChannelRoutes(router, deps) {
  router.get("/api/lin/channels", async () => {
    const secrets = await readChannelSecrets();
    const masked = maskChannelSecrets(secrets);
    return {
      channels: CHANNELS.map((channel) => ({
        id: channel.id,
        label: channel.label,
        hint: channel.hint,
        fields: channel.fields,
        ready: channel.isReady(secrets),
        values: masked[channel.id] ?? { enabled: false },
      })),
    };
  });

  router.put("/api/lin/channels", async (ctx) => {
    const body = await ctx.body();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid body");
    const next = await writeChannelSecrets(pickChannelPatch(body));
    return { values: maskChannelSecrets(next) };
  });

  // 中转服务把外部平台的消息推过来；回调路径靠签名防伪，不走访问令牌，处理放到后台。
  router.post(WEBHOOK_PATH, async (ctx) => {
    const raw = await ctx.rawBody();
    const secrets = await readChannelSecrets();
    const channel = channelById("webhook");
    const ok = channel?.verifyInbound({
      secret: secrets.webhook?.secret ?? "",
      rawBody: raw,
      signature: ctx.header("x-rn-signature"),
      timestamp: ctx.header("x-rn-timestamp"),
    });
    if (!ok) {
      log.warn("webhook rejected", { bodyLength: raw.length });
      return reply(401, { error: "bad signature" });
    }
    const message = channel.parseInbound(raw);
    if (!message) return reply(400, { error: "invalid payload" });
    await deps.bridge.handleIncoming(message);
    return {};
  });

  router.post("/api/lin/channels/:id/test", async (ctx) => {
    const channel = channelById(ctx.params.id);
    if (!channel) throw new HttpError(404, "unknown channel");
    const secrets = await readChannelSecrets();
    if (!isChannelReady(channel.id, secrets)) return reply(400, { error: "channel not ready" });
    try {
      await channel.sendText(secrets[channel.id] ?? {}, "在吗");
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });
}
