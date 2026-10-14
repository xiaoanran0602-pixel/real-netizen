// ============================================================
// 她的动态数据：头像/签名（profile.json）和朋友圈（moments.json）。唯一写入入口；路由和调度器都只调这里。
// ============================================================

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import { createSerializer, readJson, writeJsonAtomic, writeTextAtomic } from "../store/files.js";
import { invalidateMemoryCache } from "../companion/memory.js";
import { serializeMemoryFile } from "../companion/frontmatter.js";
import { addDays, formatLocalDate } from "../util/time.js";

const POST_LIMIT = 200;
const HISTORY_LIMIT = 50;
const SELF_DAILY_KEEP_DAYS = 3;

export async function readProfile() {
  const profile = await readJson(paths.momentsProfile(), { history: [] });
  return { ...profile, history: Array.isArray(profile.history) ? profile.history : [] };
}

export async function readMoments() {
  const moments = await readJson(paths.moments(), { posts: [] });
  return { posts: Array.isArray(moments.posts) ? moments.posts : [] };
}

/** 同一进程内串行化写操作，避免评论和调度器同时改 moments.json 互相覆盖。 */
const serialize = createSerializer();

export function updateProfile(mutate) {
  return serialize(async () => {
    const profile = await readProfile();
    mutate(profile);
    profile.history = profile.history.slice(-HISTORY_LIMIT);
    await writeJsonAtomic(paths.momentsProfile(), profile);
    return profile;
  });
}

export function updateMoments(mutate) {
  return serialize(async () => {
    const moments = await readMoments();
    const result = mutate(moments);
    moments.posts = moments.posts.sort((a, b) => b.at - a.at).slice(0, POST_LIMIT);
    await writeJsonAtomic(paths.moments(), moments);
    return result;
  });
}

export function newId() {
  return randomUUID();
}

export function countToday(items, now = new Date()) {
  const today = formatLocalDate(now);
  return items.filter((item) => formatLocalDate(new Date(item.at)) === today).length;
}

/**
 * 把她的动态写成一条记忆，让聊天时她记得自己发过什么、他说过什么。
 * self_daily 3 天后过期降级；event 永久保留（过去不可改）。
 * @param {{kind: "self_daily"|"event", slug: string, description: string, body: string, now?: Date}} input
 */
export async function writeMomentMemory(input) {
  const now = input.now ?? new Date();
  const today = formatLocalDate(now);
  const name = `${input.kind === "event" ? "moment-event" : "moment"}-${today}-${input.slug}`;
  const content = serializeMemoryFile({
    name,
    description: input.description,
    type: input.kind,
    created: today,
    updated: today,
    ...(input.kind === "self_daily" ? { expires: addDays(today, SELF_DAILY_KEEP_DAYS) } : {}),
    body: input.body,
    extraMeta: ["  node_type: memory"],
  });
  await writeTextAtomic(join(paths.memory(), `${name}.md`), content);
  invalidateMemoryCache();
  return `${name}.md`;
}
