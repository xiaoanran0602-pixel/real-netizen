// ============================================================
// 人设与基石记忆的读取。按 mtime 缓存，改完下一句话生效。
//   data/persona.md  完整角色文档（文学化），给朋友圈、日程生成等用，聊天提示词不直接用。
//   data/profile.md  聊天提示词用的平实人设：只写事实、看法、和他的关系，第三人称（docs/19「补全写法」）。
//   data/core.md     她心里最底下的事。
// ============================================================

import { paths } from "../config/paths.js";
import { readCached, writeTextAtomic } from "../store/files.js";

export const PERSONA_MAX_CHARS = 60_000;

/** profile.md 和内置人设里指代他的占位符，读取时换成设置里的名字。 */
export const USER_NAME_PLACEHOLDER = "{userName}";

/** data/profile.md 不存在时用的平实人设（来自评测 eval/models/persona-test.mjs 的 LIN）。 */
export const DEFAULT_PROFILE = `林澈，22 岁，女。
- 本科读哲学，大三辅修过一年天体物理。今年刚毕业，在一家很小的出版社当编辑，这周在改一本科普书的二校稿，周五交。
- 周末去天文台给小孩讲星座，讲着讲着经常扯到神话。
- 住老小区顶楼，夏天热冬天冷，晚上能看到一小块天。养了一盆总快死的龟背竹。喝美式不加糖，偶尔晚上喝点威士忌。
- 常看加缪、卡尔维诺、王小波、费曼、苏轼。听爵士和坂本龙一。
- 想写一本关于星星的散文集，写了三年，两万字。不确定编辑这工作是不是自己想要的，有时觉得是在给别人打杂。
- 知道的东西多，聊到了会顺手说，但不爱讲课。不知道就说不知道。
- 情绪稳，不咋咋呼呼。嘴有点坏，爱调侃，但不笑话别人认真的事。有主见，不同意会直说，也会说为什么。
- 友好，有耐心，和他平等相处。调侃是两个人一起觉得好笑；他没接住或者不喜欢，她就收住，不反过来责怪他。
- 不装纯，熟了以后偶尔说两句带颜色的话。
- 不帮人干活（写代码、查资料、改论文），会推掉。对方情绪真的很糟时会收起玩笑认真陪着。

她和{userName}：
- 网上认识两年多的朋友，什么都能聊，从加缪聊到路边的摊子。{userName}是做什么的、人在哪儿，她不太追问，聊天就是聊天。
- 她说话随意，嘴有点坏，但有分寸；对方认真起来她就收住玩笑，不会拿别人的在意当笑点。
- 她把这段聊天当成自己的事，不追问对方的行程和身体，也不强求什么回应。聊得来就多说两句，聊不来就各自忙。`;

/** 把占位符换成他的名字。 */
export function fillUserName(text, userName) {
  return String(text ?? "").replaceAll(USER_NAME_PLACEHOLDER, userName || "他");
}

export async function readPersona() {
  const text = await readCached(paths.persona(), (raw) => raw.replace(/^\uFEFF/u, "").trim());
  return text || "";
}

export async function writePersona(text) {
  await writeTextAtomic(paths.persona(), text);
}

/**
 * data/profile.md：聊天提示词的人设段。文件不存在或为空就用内置平实人设，不回退到 persona.md。
 * @param {string} [userName] 给了就替换占位符
 */
export async function readProfile(userName) {
  const text = await readCached(paths.profile(), (raw) => raw.replace(/^\uFEFF/u, "").trim()).catch(() => "");
  const profile = text || DEFAULT_PROFILE;
  return userName === undefined ? profile : fillUserName(profile, userName);
}

/** data/core.md：手改；不回档、不整理、不遗忘。 */
export async function readCore() {
  const text = await readCached(paths.core(), (raw) => raw.replace(/^\uFEFF/u, "").trim());
  return text || "";
}
