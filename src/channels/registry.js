// ============================================================
// 内置渠道表：登记所有开箱即用的聊天渠道。每个渠道在自己的目录里实现 Channel 契约
// （start / stop / sendText / sendImage / fields），到这里加一行即可被全系统认识：
// 设置页字段、bridge 的启用判断与启动、/api/lin/channels 都从这里来。
// ============================================================

import { telegramChannel } from "./telegram/channel.js";
import { webhookChannel } from "./webhook/channel.js";

export const CHANNELS = Object.freeze([telegramChannel, webhookChannel]);

/** 按 id 取渠道实现（不存在返回 undefined）。 */
export function channelById(id) {
  return CHANNELS.find((channel) => channel.id === id);
}

/** 当前已启用且凭据齐全的渠道（设置页和 bridge 各取所需）。 */
export function enabledChannels(secrets) {
  return CHANNELS.filter((channel) => channel.isReady(secrets ?? {}));
}
