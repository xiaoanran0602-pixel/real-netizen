// ============================================================
// 她的动态：头像签名、朋友圈、点赞评论、图片、手动触发。
// 点赞、评论会唤醒动态调度器（她过一会儿可能回应）。
// ============================================================

import { addComment, deleteComment, toggleLike } from "../../moments/interact.js";
import { profileView } from "../../moments/execute.js";
import { readMoments, readProfile } from "../../moments/store.js";
import { MEDIA_FILE_PATTERN, mediaContentType, mediaUrl, readMedia } from "../../store/media.js";
import { HttpError, reply } from "../router.js";

const COMMENT_MAX_CHARS = 500;
const FORCE_ACTIONS = new Set(["post", "avatar", "signature", "message"]);
const MEDIA_CACHE = "private, max-age=31536000, immutable";

/**
 * @param {ReturnType<import("../router.js").createRouter>} router
 * @param {{moments: ReturnType<import("../../moments/scheduler.js").createMomentsScheduler>}} deps
 */
export function registerMomentsRoutes(router, deps) {
  router.get("/api/lin/profile", async () => profileView(await readProfile()));

  router.get("/api/lin/moments", async () => {
    const moments = await readMoments();
    return { posts: moments.posts.map((post) => ({ ...post, images: (post.images ?? []).map((file) => mediaUrl(file)) })) };
  });

  router.post("/api/lin/moments/tick", async (ctx) => {
    const force = ctx.query.get("force");
    if (force && !FORCE_ACTIONS.has(force)) throw new HttpError(400, "invalid force");
    return deps.moments.tick({ trigger: force ? "manual" : "idle", ...(force ? { force } : {}) });
  });

  router.post("/api/lin/moments/:id/like", async (ctx) => {
    const post = await toggleLike(ctx.params.id);
    if (!post) throw new HttpError(404, "not found");
    void deps.moments.nudge("like");
    return { likes: post.likes };
  });

  router.post("/api/lin/moments/:id/comments", async (ctx) => {
    const body = await ctx.body();
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > COMMENT_MAX_CHARS) throw new HttpError(400, "invalid text");
    const comment = await addComment(ctx.params.id, text, typeof body.replyTo === "string" ? body.replyTo : undefined);
    if (!comment) throw new HttpError(404, "not found");
    void deps.moments.nudge("comment");
    return { comment };
  });

  router.delete("/api/lin/moments/:id/comments/:commentId", async (ctx) => {
    const ok = await deleteComment(ctx.params.id, ctx.params.commentId);
    if (!ok) throw new HttpError(404, "not found");
    return { ok };
  });

  router.get("/api/lin/media/:file", async (ctx) => {
    const file = ctx.params.file;
    if (!MEDIA_FILE_PATTERN.test(file)) throw new HttpError(400, "invalid file");
    const bytes = await readMedia(file);
    if (!bytes) throw new HttpError(404, "not found");
    return reply(200, bytes, { "content-type": mediaContentType(file), "cache-control": MEDIA_CACHE });
  });
}
