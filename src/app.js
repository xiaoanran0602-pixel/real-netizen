// ============================================================
// 组装：把各模块接起来，返回一个可启动/可关闭的程序对象。main.js 和 http 测试共用。
//
//   chat-service（唯一对话写入者）
//     ├─ 提示词：companion/context.js（记忆 recall + 内心状态 + 两条基石）
//     ├─ 每轮他说话 → inner 想念下降；每轮结束 → 记忆整理 + 动态唤醒
//   记忆整理 → 强度表 + 事件判断（自我感觉、张力、被看见的转折）
//   日程生成前 → 掷骰 + 写书转折事实
//   聊天渠道 bridge ← reply-timing（不秒回）；动态调度器 → 主动找他
//   日结时钟 → 整理 → 存档；回档器（暂停以上全部）
// ============================================================

import { normalizeSettings, readSettings } from "./config/settings.js";
import { ensureAccessToken, readAccessToken } from "./config/secrets.js";
import { isDry } from "./config/runtime.js";
import { paths, requiredDirs } from "./config/paths.js";
import { createChatService } from "./chat/chat-service.js";
import { createPromptBuilder } from "./companion/context.js";
import { createMemoryCurator } from "./companion/memory-curator.js";
import { createMediaRuntime } from "./companion/media-runtime.js";
import { strengthHooks } from "./companion/curator-hooks.js";
import { consolidateDaily, consolidateMonthly, consolidateWeekly } from "./companion/consolidation.js";
import { ensureLife, setLifeFactsProvider, startLifePrewarm, stopLifePrewarm } from "./companion/life-scheduler.js";
import { createDailyClock } from "./clock/daily.js";
import { snapshot } from "./archive/snapshot.js";
import { createRestorer } from "./archive/restore.js";
import { complete } from "./model/client.js";
import { createChannelBridge } from "./channels/bridge.js";
import { createMomentsScheduler } from "./moments/scheduler.js";
import { syncProfileAfterRestore } from "./moments/execute.js";
import { readProfile } from "./moments/store.js";
import { currentInner } from "./inner/state.js";
import { settleNow } from "./inner/store.js";
import { lifeFacts, onCuratorEvents, onUserTurn } from "./inner/hooks.js";
import { createPlaceholderGenerator, createReplyTiming } from "./inner/reply-timing.js";
import { createKernel } from "./inner/kernel.js";
import { createHeartbeat, loadTimeline } from "./inner/heartbeat.js";
import { createInnerProvider } from "./inner/provider.js";
import { createThoughtsRuntime } from "./inner/thoughts-runtime.js";
import { broadcast, closeAllClients } from "./http/events.js";
import { buildRoutes } from "./http/routes/index.js";
import { createLinServer } from "./http/server.js";
import { ensureDir, fileExists, writeJsonAtomic } from "./store/files.js";
import { createLogger } from "./util/log.js";

const log = createLogger("app");

/**
 * @param {{host: string, complete?: typeof complete}} options
 */
export async function createApp(options) {
  for (const dir of requiredDirs()) await ensureDir(dir);
  // 首次启动写一份带默认值的 settings.json，方便手改（已有的不动）。
  if (!(await fileExists(paths.settings()))) await writeJsonAtomic(paths.settings(), normalizeSettings({}));
  // 只监听本机且没有令牌文件时可不设令牌；局域网监听必须有。
  const localOnly = options.host === "127.0.0.1" || options.host === "localhost" || options.host === "::1";
  const token = localOnly ? await readAccessToken() : await ensureAccessToken();
  const model = options.complete ?? complete;
  const innerState = (now) => currentInner(now);
  // 14：常驻的身体内核（权威状态在内存，事件日志 + 检查点）与 5 秒心跳。
  const kernel = createKernel({ loadTimeline });
  const heartbeat = createHeartbeat({ kernel });
  // 13：念头池的后台部分（小时推进、聊天后抽取、溢出出口、时间承诺）。
  const thoughts = createThoughtsRuntime({ kernel, classifier: options.classifier, extractor: options.extractor });
  const mediaLibrary = createMediaRuntime({ complete: model });

  let moments = null;
  const curator = createMemoryCurator({ hooks: strengthHooks({ onEvents: (events, at) => onCuratorEvents(events, at), onMediaRequests: (requests, text, context) => mediaLibrary.recommend(requests, text, context) }) });
  const chatService = createChatService({
    complete: model,
    buildPrompt: createPromptBuilder({ innerProvider: createInnerProvider({ kernel, classifier: options.classifier }), mediaProvider: mediaLibrary.context }),
    ensureLife,
    broadcast,
    readSettings,
    onUserMessage: onUserTurn,
    afterTurn: ({ source, reply }) => {
      // 渠道的回复要等 reply-timing 真正发出才写进对话，整理放到 bridge 的 onReplied 里，否则会漏掉她那句。
      if (source === "channel") return;
      void curator.schedule();
      void thoughts.afterReply(reply, { source }).catch(() => undefined);
      if (source === "web") void moments?.nudge("chat");
    },
  });
  const replyTiming = createReplyTiming({ chatService, innerState, generatePlaceholder: createPlaceholderGenerator(model, async () => (await readSettings()).companionName), busyState: thoughts.busyState });
  const bridge = createChannelBridge({
    chatService,
    replyTiming,
    onReplied: (text) => {
      void curator.schedule();
      void thoughts.afterReply(text, { source: "channel" }).catch(() => undefined);
      void moments?.nudge("chat", text);
    },
  });
  moments = createMomentsScheduler({ bridge, innerState, thoughts });
  setLifeFactsProvider(async (now) => [...(await lifeFacts(now)), ...(await thoughts.lifeFacts(now)), ...(await mediaLibrary.lifeFacts())]);

  let restoring = false;
  const clock = createDailyClock({
    chatService,
    consolidate: { daily: consolidateDaily, weekly: consolidateWeekly, monthly: consolidateMonthly },
    snapshot: async (day) => {
      const current = await readSettings();
      return snapshot(day, { boundaryHour: current.dayBoundaryHour, companionName: current.companionName, userName: current.userName });
    },
    isRestoring: () => restoring,
    // 心跳顺带结算内心状态（惰性结算，心跳只是让它更及时）。
    onBeat: (now) => settleNow(now.getTime()).then(() => undefined),
  });
  const restorer = createRestorer({
    chatService,
    broadcast,
    pauseSchedulers: async () => {
      restoring = true;
      moments.pause();
      heartbeat.pause();
      thoughts.pause();
      await mediaLibrary.pause();
      await curator.idle();
    },
    resumeSchedulers: () => {
      restoring = false;
      moments.resume();
      heartbeat.resume();
      thoughts.resume();
      mediaLibrary.resume();
    },
    clearPendingReplies: () => bridge.clearPending(),
    syncChannelProfile: syncProfileAfterRestore,
    readProfile,
    // 回档后：内核 epoch 递增、锚点设为现在，丢弃旧世界的晚到结果（docs/14 第 8.3 节）。
    onRestored: () => kernel.rebase().then(() => undefined),
  });

  const router = buildRoutes({ chatService, bridge, moments, broadcast, token, restorer, clock, replyTiming, kernel, thoughts, mediaLibrary });
  const server = createLinServer({ router, token });

  return {
    token,
    server,
    chatService,
    bridge,
    moments,
    clock,
    restorer,
    curator,
    kernel,
    thoughts,
    mediaLibrary,
    /** 启动后台：回档检查、待回复恢复、内核恢复与心跳、日程预生成、动态调度、日结时钟。--dry 下只恢复不启动调度。 */
    async startBackground() {
      if (await restorer.checkOnStartup()) restoring = true;
      await kernel.start().catch((error) => log.warn("kernel start failed", { error: error?.message }));
      await bridge.restorePending().catch((error) => log.warn("restore pending failed", { error: error?.message }));
      // 心跳在 --dry 下也跑：它只做算术，不发任何东西（关掉网页、聊天渠道不在线都不影响它）。
      heartbeat.start();
      thoughts.start();
      if (isDry()) return;
      mediaLibrary.start();
      startLifePrewarm();
      moments.start();
      clock.start();
      // 启动已启用的聊天渠道（长轮询 / webhook 入站）。
      await bridge.start().catch((error) => log.warn("channel start failed", { error: error?.message }));
    },
    async close() {
      stopLifePrewarm();
      moments.stop();
      clock.stop();
      heartbeat.stop();
      thoughts.stop();
      replyTiming.stop();
      await bridge.stop().catch((error) => log.warn("channel stop failed", { error: error?.message }));
      closeAllClients();
      await new Promise((resolve) => server.close(() => resolve()));
      await chatService.idle().catch(() => undefined);
      // 修复：聊完一轮后的记忆整理在后台跑，关闭时不等它会在退出（或测试清理目录）时写到一半。
      await curator.idle().catch(() => undefined);
      await mediaLibrary.stop().catch(() => undefined);
      await thoughts.idle().catch(() => undefined);
      // 退出前强制落盘内核状态（docs/14 第 8.1 节）。
      await kernel.checkpoint().catch(() => undefined);
    },
  };
}
