// ============================================================
// 每轮聊天的提示词组装：从 data 读平实人设（profile.md）、基石、设置、日程、外界、记忆，交给 prompt.js。
// 记忆默认由 recall.js 按当前用户线索、清晰度与预算挑；底色只给轮廓。
// 内心状态部分由 innerProvider 提供（P1 起接入）。
// ============================================================

import { readSettings } from "../config/settings.js";
import { readLife } from "./life.js";
import { readMemories } from "./memory.js";
import { readCore, readProfile } from "./persona.js";
import { buildSystemPrompt } from "./prompt.js";
import { recallSelector } from "./recall.js";
import { buildWorldText } from "./world-context.js";
import { readCoreSelf } from "../inner/core-self.js";
import { isSafetyRisk } from "../inner/mapping.js";
import { currentExchange, planReply } from "./reply-plan.js";

/**
 * @param {{
 *   memorySelector?: (input: {memories: any[], now: Date, recentText: string, previousAssistantText: string, userName: string}) => Promise<{text: string | null, afterTurn?: (reply: string) => Promise<void>}>,
 *   innerProvider?: (input: {now: Date, messages: any[], source: string}) => Promise<{text?: string | null, maxSegments?: number, coreFragments?: boolean, extraNow?: string[]} | null>,
 *   coreSelf?: () => string | Promise<string>,
 *   mediaProvider?: (input: {messages: any[], now: Date}) => Promise<string | null>,
 * }} [options]
 */
export function createPromptBuilder(options = {}) {
  // 传 memorySelector: null 仍用相同呈现策略，但不读强度表、不执行想起加固。
  const memorySelector = options.memorySelector === undefined ? recallSelector : options.memorySelector;
  // 内心状态由 app.js 注入（inner/provider.js，需要内核）；不传就不注入内心小节。
  const innerProvider = options.innerProvider ?? null;
  // 「关于她自己的」基石只在代码里（docs/12 第 6.1 节），默认并入；传 coreSelf: null 关掉。
  const coreSelf = options.coreSelf === undefined ? readCoreSelf : options.coreSelf;
  return async function buildPrompt({ now, lastSeenAt, messages, extraNow, source }) {
    const [settings, coreFile, memories, life] = await Promise.all([readSettings(), readCore(), readMemories(), readLife(now)]);
    // 平实人设里的 {userName} 换成他的名字；core 的替换在 buildSystemPrompt 里做。
    const profile = await readProfile(settings.userName);
    const worldText = await buildWorldText(settings.userName);
    const history = messages ?? [];
    const { text, previousAssistantText } = currentExchange(history, now.getTime());
    const selected = memorySelector ? await memorySelector({ memories, now, recentText: text, previousAssistantText, userName: settings.userName }) : null;
    const inner = innerProvider ? await innerProvider({ now, messages, source }).catch(() => null) : null;
    const safety = Boolean(inner?.safety) || isSafetyRisk(text);
    const replyPlan = planReply({ messages: history, now: now.getTime(), conversation: inner?.conversation, situation: inner?.situation, expressed: inner?.expressed, safety });
    const mediaText = options.mediaProvider ? await options.mediaProvider({ messages: history, now }).catch(() => null) : null;
    const core = [coreFile, await coreSelf?.()].filter((part) => part?.trim()).join("\n\n");
    const system = buildSystemPrompt({
      profile,
      core,
      settings,
      now,
      lastSeenAt,
      worldText,
      life,
      memories,
      recentText: text,
      previousAssistantText,
      mediaText,
      ...(selected ? { memoryText: selected.text } : {}),
      innerText: replyPlan.need === "acknowledge" ? inner?.stateText ?? null : inner?.text ?? null,
      safety,
      replyPlan,
      // 先写她此刻的处境，再写这一轮特有的事（刚醒、刚忙完）。
      extraNow: [...(inner?.extraNow ?? []), ...(extraNow ?? [])],
    });
    return { system, afterTurn: selected?.afterTurn, maxSegments: replyPlan.maxSegments, replyPlan };
  };
}
