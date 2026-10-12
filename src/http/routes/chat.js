// ============================================================
// 聊天与实时事件。
//   GET  /api/lin/chat/history?limit&after&before   → {conversationId, messages, hasMore, failed, reset}
//   POST /api/lin/chat/send {text, clientId}       → 202 {messageId}，结果走 SSE
//   POST /api/lin/chat/new                         开始新对话
//   GET  /api/lin/events                           SSE
// ============================================================

import { pageMessages } from "../../chat/history.js";
import { TEXT_MAX_CHARS } from "../../chat/chat-service.js";
import { getMainConversationId, readConversation } from "../../store/conversation.js";
import { attachClient } from "../events.js";
import { HttpError, reply } from "../router.js";

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * @param {ReturnType<import("../router.js").createRouter>} router
 * @param {{chatService: ReturnType<import("../../chat/chat-service.js").createChatService>}} deps
 */
export function registerChatRoutes(router, deps) {
  router.get("/api/lin/chat/history", async (ctx) => {
    const conversationId = await getMainConversationId();
    const messages = await readConversation(conversationId);
    const page = pageMessages(messages, {
      limit: ctx.query.get("limit") ?? undefined,
      after: ctx.query.get("after") ?? undefined,
      before: ctx.query.get("before") ?? undefined,
    });
    return { conversationId, ...page, failed: deps.chatService.failedIds() };
  });

  router.post("/api/lin/chat/send", async (ctx) => {
    const body = await ctx.body();
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new HttpError(400, "empty text");
    if (text.length > TEXT_MAX_CHARS) throw new HttpError(400, "text too long");
    const clientId = typeof body.clientId === "string" && CLIENT_ID_PATTERN.test(body.clientId) ? body.clientId : undefined;
    const { messageId } = deps.chatService.submitUserMessage(text, { source: "web", clientId });
    return reply(202, { messageId });
  });

  router.post("/api/lin/chat/new", async () => ({ conversationId: await deps.chatService.startNewConversation() }));

  router.get("/api/lin/events", (ctx) => {
    attachClient(ctx.req, ctx.res, ctx.cookieHeader);
  });
}
