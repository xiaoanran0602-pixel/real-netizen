// ============================================================
// 她的动态：让模型决定此刻要不要发朋友圈、换头像、换签名、主动找他（后台模型）。
// 提示词文字沿用旧版。
// ============================================================

import { join } from "node:path";
import { paths } from "../config/paths.js";
import { complete, extractJsonObject } from "../model/client.js";
import { listDir, readText, readJson } from "../store/files.js";
import { formatLocalDate, pad2 } from "../util/time.js";
import { readPersona } from "../companion/persona.js";
import { formatMediaContext } from "../companion/media-library.js";
import { displayUserName } from "../util/text.js";

export const ACTIONS = Object.freeze(["none", "post", "avatar", "signature", "message"]);
const PERSONA_CHAR_LIMIT = 2500;
const RECENT_MEMORY_LIMIT = 6;
const MEMORY_SNIPPET_CHARS = 200;
const DECIDE_MAX_TOKENS = 1200;

async function readTodayLife(now) {
  return (await readText(join(paths.life(), `day-${formatLocalDate(now)}.md`)))?.trim() ?? "";
}

async function readRecentSelfMemories() {
  const names = (await listDir(paths.memory()))
    .filter((name) => /^(self-daily|moment|event)-\d{4}-\d{2}-\d{2}/u.test(name))
    .sort()
    .slice(-RECENT_MEMORY_LIMIT);
  const bodies = await Promise.all(names.map(async (name) => `- ${((await readText(join(paths.memory(), name))) ?? "").replace(/^---[\s\S]*?---\s*/u, "").trim().slice(0, MEMORY_SNIPPET_CHARS)}`));
  return bodies.join("\n");
}

/**
 * @param {{now: Date, settings: any, city: string, homeCity: string, weather: string, news: string[], events: string[], allowed: string[], chatText?: string, recentPosts: any[], signature?: string, force?: string, moodHints?: string[]}} input
 */
export async function buildDecisionPrompt(input) {
  const name = input.settings.companionName || "林澈";
  const userName = displayUserName(input.settings.userName);
  const persona = (await readPersona()).slice(0, PERSONA_CHAR_LIMIT);
  const [todayLife, selfMemories, media] = await Promise.all([readTodayLife(input.now), readRecentSelfMemories(), readJson(paths.mediaLibrary(), { works: [] })]);
  const recentlyFinished = media.works.filter((work) => work.history?.at(-1)?.at >= input.now.getTime() - 86_400_000).slice(0, 2);
  const mediaText = formatMediaContext({ works: recentlyFinished }, [{ role: "user", text: recentlyFinished.map((work) => work.title).join(" ") }]);
  const time = `${formatLocalDate(input.now)} ${pad2(input.now.getHours())}:${pad2(input.now.getMinutes())}`;
  const actionHelp = {
    none: "none：什么都不做（大多数时候应该选这个）",
    post: "post：发一条朋友圈。text 是配文（一两句，像她自己会发的，可以很短，可以没头没尾）；想配一张自己拍的照片就写 imagePrompt，不想配图就留空",
    avatar: "avatar：换头像。imagePrompt 写你想要的头像画面（她这种人会用的头像：风景、星空、植物、书页、动物、插画，不用真人自拍），text 留空",
    signature: "signature：换个性签名。text 是新签名（一句，二十字以内）",
    message: `message：主动给${userName}发条消息（他好一阵没找你了）。像真人想起一个人时随手发的：分享此刻看到的、想到的，或者问一句他的事；一两句，别客套别问「在吗」。text 是消息；想顺手拍一张你此刻看到的东西发给他就写 imagePrompt，否则留空`,
  };
  const imageHelp = [
    "imagePrompt 是给画图模型的画面描述，用中文写，像你在描述自己手机里这张照片：",
    "- 拍的是什么、在哪、什么光线、什么角度、画面里有哪些具体的东西（比如「傍晚办公室窗边，桌上半杯冷掉的咖啡和摊开的校样，窗外是灰蓝的天」）。",
    "- 要是你自己手机随手拍的样子，写出这张照片该有的随意感（比如有点歪、有点糊、手抖、光线不好），按画面来，不用每张都一样。",
    "- 不要拍真人正脸，不要出现文字，不要写得像海报或商业摄影。",
    "- 头像写清是方图、主体是什么、什么风格（照片还是插画）。",
  ].join("\n");
  return [
    `你是「${name}」本人。下面是你的人设：`,
    persona,
    "",
    `现在是 ${time}。你家在${input.homeCity}，现在人在${input.city}。`,
    input.weather ? `天气：${input.weather}` : "",
    todayLife ? `你今天的日程：\n${todayLife}` : "",
    selfMemories ? `你最近的事：\n${selfMemories}` : "",
    mediaText || "",
    "推荐作品的看/读/听进度只以已记录的模拟段落为准，不凭日程计划或旧聊天宣称看完。它只是可选话头，不要求主动分享、不反复播报进度，也不编造剧照或歌词。",
    input.moodHints?.length ? `你现在的状态（只影响你想不想做、做什么，不要写出来）：${input.moodHints.join(" ")}` : "",
    input.news.length > 0 ? `今天刷到的新闻标题（大部分你不会在意，除非真的触动你）：\n${input.news.map((t) => `- ${t}`).join("\n")}` : "",
    input.recentPosts.length > 0 ? `你最近发过的朋友圈（不要重复同样的意思）：\n${input.recentPosts.map((p) => `- ${new Date(p.at).toLocaleString("zh-CN")}：${p.text}`).join("\n")}` : "你还没发过朋友圈。",
    input.signature ? `你现在的签名：${input.signature}` : "",
    input.chatText ? `你刚和${userName}聊过（他是你的网友，朋友圈里不要直接写和他聊了什么）：\n${input.chatText}` : "",
    input.events.length > 0 ? `刚发生的事：${input.events.join("；")}` : "",
    "",
    input.force ? `这次请做：${input.force}。` : "想一想：此刻的你会不会想发点什么、换个头像或签名？真人大多数时候什么都不发，只有心情、天气、正在做的事真的触动你时才会。",
    "可以选的动作：",
    ...input.allowed.concat(input.force ? [] : ["none"]).map((action) => `- ${actionHelp[action]}`),
    "",
    imageHelp,
    "",
    "如果你按日程现在不在家（出差、旅行），location 写你现在所在的城市（国内外都行）；否则不写。",
    '只输出一个 JSON：{"action": "...", "text": "...", "imagePrompt": "...", "imageCaption": "这张图一句话是什么（给你自己记）", "location": "...", "reason": "一句话为什么"}',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** @returns {Promise<{action: string, text?: string, imagePrompt?: string, imageCaption?: string, location?: string, reason?: string} | null>} */
export async function decide(input) {
  const prompt = await buildDecisionPrompt(input);
  const raw = await complete({ role: "background", messages: [{ role: "user", content: prompt }], maxTokens: DECIDE_MAX_TOKENS });
  const json = extractJsonObject(raw);
  if (!json) return null;
  const pick = (key) => (typeof json[key] === "string" && json[key].trim() ? json[key].trim() : undefined);
  const action = String(json.action ?? "none");
  const out = { action: ACTIONS.includes(action) ? action : "none" };
  // 兼容：模型偶尔还按旧格式给 imageQuery，当作画面描述用。
  const imagePrompt = pick("imagePrompt") ?? pick("imageQuery");
  if (imagePrompt) out.imagePrompt = imagePrompt;
  for (const key of ["text", "imageCaption", "location", "reason"]) {
    const value = pick(key);
    if (value) out[key] = value;
  }
  return out;
}
