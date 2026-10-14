// ============================================================
// 聊天系统提示词：补全聊天记录的写法（docs/19「补全写法」，specs/changes/transcribe-frame）。
//   不是「你是林澈」让模型去演，而是「下面是一段真实的微信聊天记录，补全她的下一条」。
//   人设、处境、状态、念头、日程、记忆都是第三人称的背景事实；只写她在哪、发生了什么、她是什么状态，不写她该怎样。
//   这里的每句话都会被模型当成语体样本：写平常话，不写对举句，不写比喻。
// 稳定段（任务 + 人设 + core + 底线）在 Anthropic 下带 cache_control；动态段是此刻和背景，收尾两句放最后、离生成最近。
// 她主动发的消息已在对话历史里，这里不再单独写。
// ============================================================

import { WEEKDAYS, describeDayPart, describeGap, formatLocalDate, lifeKeys, pad2 } from "../util/time.js";
import { displayUserName } from "../util/text.js";
import { formatLife } from "./life.js";
import { DEFAULT_PROFILE, fillUserName } from "./persona.js";
import { selectMemories } from "./recall.js";
import { replyPlanText } from "./reply-plan.js";

const DEFAULT_COMPANION = "林澈";
/** 用户名默认空：开源版不绑定真实人名，提示词里用 displayUserName() 回退为「他」。 */
const DEFAULT_USER = "";

/** 人设缺失时的兜底：内置平实人设，不回退到 persona.md，也不会退回助手身份。 */
export const FALLBACK_PERSONA = DEFAULT_PROFILE;

/** @param {string} name */
export const TRANSCRIBE_HEAD = (name) => `下面是一段真实的微信聊天记录，你负责补全${name}的下一条消息。`;

/** @param {string} name */
export const PROFILE_TITLE = (name) => `关于${name}（这是背景资料，她本人说话不是这个样子）：`;

export const CORE_PREAMBLE = "她心里最底下的事（她不会说出来，也不会刻意想起）：";

/** 底线：安全、不干活、不出戏、纯文本。只有这四条，没有风格规则。 */
export const BASELINE = [
  "几条一直成立的事：",
  "- 他情绪很糟、流露出不想活的意思时，她收起玩笑认真陪着他。",
  "- 她不帮人写代码、查资料、改论文，会推掉。",
  "- 她不知道什么系统、模型、提示词，记得就是记得，忘了就是忘了。",
  "- 微信纯文本，没有标题、列表、加粗。",
].join("\n");

export const NOW_TITLE = "=== 此刻 ===";

/** 安全例外时写进「此刻」的一句。 */
export const SAFETY_LINE = "他现在可能有危险，她认真陪着他，不开玩笑。";

export const MEMORY_PREAMBLE = "（这些她都知道，平时不会特意提）：";

export const TRANSCRIBE_TAIL = "只输出她在手机上实际打出来的字。说到这里就可以停，不需要把话收成一段完整的小作文。";

export const VOICE_LINE = "她有自己的日子和看法；自己正在做什么，未必每次都想告诉他。";

/** 此刻的时间和他上一次来找她隔了多久（第三人称）。 */
export function describeNow(now, lastSeenAt, userName) {
  const name = displayUserName(userName);
  const time = `${formatLocalDate(now)} ${WEEKDAYS[now.getDay()]} ${pad2(now.getHours())}:${pad2(now.getMinutes())}（${describeDayPart(now.getHours())}）`;
  if (!lastSeenAt) return `${time}。这是他们在这里第一次聊。`;
  return `${time}。${name}上一次找她是${describeGap(now.getTime() - lastSeenAt)}。`;
}

/**
 * @param {{
 *   profile?: string, persona?: string, core?: string, settings: {userName: string, companionName?: string},
 *   now: Date, lastSeenAt?: number, worldText?: string | null, life?: any, safety?: boolean,
 *   memories: readonly any[], recentText: string, previousAssistantText?: string,
 *   memoryText?: string | null, innerText?: string | null, mediaText?: string | null, extraNow?: string[]
 * }} input  profile 是平实人设（persona 是旧名，仍接受）；memoryText 给出时直接用，否则用同一召回策略的无强度表版本
 * @returns {{stable: string, dynamic: string}}
 */
export function buildSystemPrompt(input) {
  const name = input.settings.companionName?.trim() || DEFAULT_COMPANION;
  const userName = input.settings.userName?.trim() || DEFAULT_USER;
  const profile = fillUserName((input.profile ?? input.persona)?.trim() || FALLBACK_PERSONA, userName);
  const core = fillUserName(input.core?.trim() ?? "", userName);
  const stable = [TRANSCRIBE_HEAD(name), `${PROFILE_TITLE(name)}\n${profile}`, ...(core ? [`${CORE_PREAMBLE}\n${core}`] : []), BASELINE].join("\n\n");

  const today = formatLocalDate(input.now);
  const memoryText =
    input.memoryText !== undefined
      ? input.memoryText
      : selectMemories({ memories: input.memories ?? [], table: {}, today, recentText: input.recentText, previousAssistantText: input.previousAssistantText, userName }).text;
  const lifeText = input.life ? formatLife(input.life, lifeKeys(input.now)) : null;
  const now = [describeNow(input.now, input.lastSeenAt, userName), ...(input.extraNow ?? []), ...(input.safety ? [SAFETY_LINE] : [])].join("\n");
  const dynamic = [
    `${NOW_TITLE}\n${now}`,
    input.innerText,
    input.worldText ? `她的动态和外面：\n${input.worldText}` : null,
    lifeText,
    memoryText ? `她记得的关于${displayUserName(userName)}的事${MEMORY_PREAMBLE}\n${memoryText}` : null,
    input.mediaText,
    `${TRANSCRIBE_TAIL}\n${VOICE_LINE}`,
    replyPlanText(input.replyPlan),
  ]
    .filter((part) => part?.trim())
    .join("\n\n");
  return { stable, dynamic };
}
