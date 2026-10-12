// ============================================================
// 朋友圈互动：他点赞、评论、删自己的评论；她过一会儿回复评论（随机延迟，像真人刷到了才回）。
// 评论和回复写进 event 记忆，聊天时她记得。点赞、评论会唤醒动态调度器（由路由调用 nudge）。
// ============================================================

import { readSettings } from "../config/settings.js";
import { complete } from "../model/client.js";
import { createLogger } from "../util/log.js";
import { randomBetween } from "../util/time.js";
import { readPersona } from "../companion/persona.js";
import { newId, readMoments, updateMoments, writeMomentMemory } from "./store.js";
import { displayUserName } from "../util/text.js";

const log = createLogger("moments");
export const REPLY_DELAY_MIN_MS = 30_000;
export const REPLY_DELAY_MAX_MS = 6 * 60_000;
const PERSONA_CHAR_LIMIT = 2500;
const REPLY_MAX_TOKENS = 300;

export async function toggleLike(postId) {
  return updateMoments((moments) => {
    const post = moments.posts.find((item) => item.id === postId);
    if (!post) return null;
    post.likes = post.likes.includes("me") ? post.likes.filter((who) => who !== "me") : [...post.likes, "me"];
    return post;
  });
}

/**
 * @param {string} postId
 * @param {string} text
 * @param {string} [replyTo]
 * @param {{replyDelayMs?: number}} [options]
 */
export async function addComment(postId, text, replyTo, options = {}) {
  const comment = { id: newId(), from: "me", text, at: Date.now(), ...(replyTo ? { replyTo } : {}) };
  const post = await updateMoments((moments) => {
    const target = moments.posts.find((item) => item.id === postId);
    if (!target) return null;
    target.comments.push(comment);
    return target;
  });
  if (!post) return null;
  const delay = options.replyDelayMs ?? randomBetween(REPLY_DELAY_MIN_MS, REPLY_DELAY_MAX_MS);
  setTimeout(() => {
    void replyToComment(postId, comment.id).catch((error) => log.warn("reply failed", { error: error?.message }));
  }, delay).unref?.();
  return comment;
}

export async function deleteComment(postId, commentId) {
  return updateMoments((moments) => {
    const post = moments.posts.find((item) => item.id === postId);
    if (!post) return false;
    const before = post.comments.length;
    post.comments = post.comments.filter((item) => !(item.id === commentId && item.from === "me"));
    return post.comments.length < before;
  });
}

/** 她回复他的评论（后台模型）。他删了评论就不回。 */
export async function replyToComment(postId, commentId) {
  const moments = await readMoments();
  const post = moments.posts.find((item) => item.id === postId);
  const comment = post?.comments.find((item) => item.id === commentId);
  if (!post || !comment) return null;
  const settings = await readSettings();
  const name = settings.companionName || "林澈";
  const userName = displayUserName(settings.userName);
  const persona = (await readPersona()).slice(0, PERSONA_CHAR_LIMIT);
  const thread = post.comments.map((item) => `${item.from === "me" ? userName : name}：${item.text}`).join("\n");
  const prompt = [
    `你是「${name}」本人。人设：`,
    persona,
    "",
    `你在朋友圈发了：「${post.text}」${post.images.length > 0 ? "（配了图）" : ""}${post.location ? `，定位${post.location}` : ""}`,
    `${userName}在下面评论了，评论区现在是：`,
    thread,
    "",
    `回复${userName}最新那条评论。朋友圈评论的语气：短，一句话，最多两句，纯文本，不用表情符号也行。只输出回复内容本身。`,
  ].join("\n");
  const text = (await complete({ role: "background", messages: [{ role: "user", content: prompt }], maxTokens: REPLY_MAX_TOKENS })).replace(/^["「]|["」]$/gu, "").trim();
  if (!text) return null;
  const reply = { id: newId(), from: "her", text, at: Date.now(), replyTo: comment.id };
  const saved = await updateMoments((draft) => {
    const target = draft.posts.find((item) => item.id === postId);
    if (!target || !target.comments.some((item) => item.id === commentId)) return false;
    target.comments.push(reply);
    return true;
  });
  if (!saved) return null;
  await writeMomentMemory({
    kind: "event",
    slug: reply.id.slice(0, 8),
    description: `${userName}在我朋友圈下评论「${comment.text.slice(0, 30)}」`,
    body: `我发朋友圈「${post.text}」，${userName}评论：「${comment.text}」，我回他：「${text}」。`,
  });
  return reply;
}
