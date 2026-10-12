// ============================================================
// 聊天渠道契约：把「她」接到哪里去聊天（Telegram、Webhook 中转……）。
// 一个渠道就是一个文件目录（src/channels/<id>/），实现下面的 Channel，
// 再到 registry.js 里登记一行，设置页和 bridge 就自动认识它。
// ============================================================

/**
 * @typedef {object} InboundMessage
 * @property {string} channelId   渠道 id（"telegram" | "webhook" | 社区新增）
 * @property {string} eventId     渠道侧的事件唯一 id，用来去重
 * @property {string} senderId    发消息的人在该渠道的 id
 * @property {string} text       消息文字（非文字内容由渠道转成描述）
 * @property {number} at          消息时间戳（毫秒）
 */

/**
 * @typedef {object} Channel
 * @property {string} id
 * @property {string} label                                设置页显示名
 * @property {(secrets: object) => boolean} isReady       渠道凭据是否齐全（传入整个 channels.json 的内容）
 * @property {(ctx: {secrets: object, onMessage: (message: InboundMessage) => void}) => Promise<void>} start
 *   启动收消息（长轮询或监听 webhook 入站），把每条消息转成 InboundMessage 交给 onMessage
 * @property {() => Promise<void>} stop
 * @property {(secrets: object, text: string) => Promise<void>} sendText
 * @property {(secrets: object, bytes: Buffer, filename: string, caption?: string) => Promise<void>} [sendImage]
 * @property {(secrets: object, profile: {name?: string, signature?: string, avatar?: Buffer}) => Promise<void>} [updateProfile]
 * @property {{key: string, label: string, secret?: boolean, hint?: string}[]} fields
 *   设置页自动渲染该渠道的凭据表单；secret 字段只显示「已填 + 末 4 位」
 */
