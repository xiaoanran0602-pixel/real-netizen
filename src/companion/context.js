// ============================================================
// 每轮聊天的提示词组装：从 data 读人设、基石、设置、日程、外界、记忆，交给 prompt.js。
// 记忆默认由 recall.js 按当前用户线索、清晰度与预算挑；底色只给轮廓。
// 内心状态部分由 innerProvider 提供（P1 起接入）。
// ============================================================

import { readSettings } from "../config/settings.js";
import { readLife } from "./life.js";
import { readMemories } from "./memory.js";
import { readCore, readPersona } from "./persona.js";
import { buildSystemPrompt } from "./prompt.js";
import { recallSelector } from "./recall.js";
import { buildWorldText } from "./world-context.js";
import { innerPromptProvider } from "../inner/state.js";
import { readCoreSelf } from "../inner/core-self.js";

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
  // 内心状态默认接 inner/state.js；传 innerProvider: null 关掉。
  const innerProvider = options.innerProvider === undefined ? innerPromptProvider : options.innerProvider;
  // 「关于她自己的」基石只在代码里（docs/12 第 6.1 节），默认并入；传 coreSelf: null 关掉。
  const coreSelf = options.coreSelf === undefined ? readCoreSelf : options.coreSelf;
  return async function buildPrompt({ now, lastSeenAt, messages, extraNow, source }) {
    const [settings, persona, coreFile, memories, life] = await Promise.all([readSettings(), readPersona(), readCore(), readMemories(), readLife(now)]);
    const worldText = await buildWorldText(settings.userName);
    const history = messages ?? [];
    const lastUserIndex = history.findLastIndex((message) => message.role === "user");
    // 检索线索不能混进她的旧回复，否则会「自己提旧事 → 再次召回 → 再次提起」。
    const text = lastUserIndex < 0 ? "" : String(history[lastUserIndex].text ?? "");
    const previousAssistantText = lastUserIndex < 0 ? "" : history.slice(0, lastUserIndex).findLast((message) => message.role === "assistant")?.text ?? "";
    const selected = memorySelector ? await memorySelector({ memories, now, recentText: text, previousAssistantText, userName: settings.userName }) : null;
    const inner = innerProvider ? await innerProvider({ now, messages, source }).catch(() => null) : null;
    const mediaText = options.mediaProvider ? await options.mediaProvider({ messages: history, now }).catch(() => null) : null;
    const core = [coreFile, await coreSelf?.()].filter((part) => part?.trim()).join("\n\n");
    const system = buildSystemPrompt({
      persona,
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
      innerText: inner?.text ?? null,
      extraNow: [...(extraNow ?? []), ...(inner?.extraNow ?? [])],
    });
    return { system, afterTurn: selected?.afterTurn, maxSegments: inner?.maxSegments };
  };
}
