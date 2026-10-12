// ============================================================
// 她对「外面」和「自己动态」的感知：world.json（天气、新闻）、profile.json（签名、头像、所在城市）、
// moments.json（朋友圈）→ 提示词片段。只读；这些文件由动态调度器写。读失败一律当作没有。
// 她主动发的消息已经在对话历史里，这里不再单独写（旧版的「主动消息」段已删除）。
// ============================================================

import { paths } from "../config/paths.js";
import { readJson } from "../store/files.js";
import { displayUserName } from "../util/text.js";

const RECENT_POST_LIMIT = 3;
const NEWS_LIMIT = 5;
const POST_CHAR_LIMIT = 120;

/**
 * @param {{world?: any, profile?: any, moments?: any, userName: string}} input
 * @returns {string | null}
 */
export function formatWorldText({ world, profile, moments, userName }) {
  const name = displayUserName(userName);
  const lines = [];
  const weather = world?.weather;
  if (weather) {
    const range = weather.todayMin !== undefined && weather.todayMax !== undefined ? `，今天 ${weather.todayMin}–${weather.todayMax}°C` : "";
    const tomorrow = weather.tomorrowDescription ? `，明天${weather.tomorrowDescription}` : "";
    lines.push(`你所在的${weather.city}：${weather.description}，${weather.temperature}°C${range}${tomorrow}。`);
  }
  if (profile?.currentCity) lines.push(`你这几天不在家，人在${profile.currentCity}。`);
  if (profile?.signature?.text) lines.push(`你现在的个性签名：${profile.signature.text}`);
  if (profile?.avatar?.query) lines.push(`你现在的头像：${profile.avatar.query}。`);
  const posts = (Array.isArray(moments?.posts) ? moments.posts : []).slice(0, RECENT_POST_LIMIT);
  if (posts.length > 0) {
    lines.push("你最近发的朋友圈：");
    for (const post of posts) {
      const liked = post.likes?.includes("me") ? `，${name}点了赞` : "";
      const comments = (post.comments ?? []).map((comment) => `${comment.from === "me" ? name : "你"}：${comment.text}`).join(" / ");
      const when = new Date(post.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      lines.push(`- ${when}「${String(post.text ?? "").slice(0, POST_CHAR_LIMIT)}」${post.images?.length ? `（配了张照片${post.imageCaption ? `：${post.imageCaption}` : ""}）` : ""}${liked}${comments ? `；评论：${comments}` : ""}`);
    }
  }
  const news = (Array.isArray(world?.news) ? world.news : []).slice(0, NEWS_LIMIT);
  if (news.length > 0) lines.push(`今天刷到的新闻（大多和你无关，聊到了才提）：${news.join("；")}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

/** 从 data 目录读三个文件并格式化。 */
export async function buildWorldText(userName) {
  const [world, profile, moments] = await Promise.all([
    readJson(paths.world(), {}),
    readJson(paths.profile(), {}),
    readJson(paths.moments(), {}),
  ]);
  return formatWorldText({ world, profile, moments, userName });
}
