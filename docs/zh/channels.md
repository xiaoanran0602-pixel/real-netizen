# 聊天渠道

> 本文由私有版本清洗而来；示例均为虚构。她可以不接任何渠道，只在网页里聊天；接了渠道后，她就能在你常用的聊天软件里陪你，并主动发朋友圈式的消息。

## 1. 是什么

渠道（Channel）是她和外部聊天平台之间的适配器。程序内置两个：

| 渠道 | 适合谁 | 需要公网地址吗 | 凭据 |
| --- | --- | --- | --- |
| `telegram` | 有 Telegram 账号、想零成本接入 | 不需要（用 Bot Token 长轮询） | Bot Token、你的 Chat ID |
| `webhook` | 想接 QQ / 微信 / 飞书 / Discord 等任何平台 | 需要一个中转服务（可以是另一台便宜的云主机） | 签名密钥、出站地址、你的 ID |

渠道的接线统一经过 `channels/bridge.js`：

- **只回复主人**：收到消息后用该渠道的 owner 字段比对 `senderId`，不匹配的一律不理（别人能看到你的机器人也套不出话）。
- **合批**：你连发几条时攒 2.5 秒合成一轮，避免她每条都回（`BATCH_WINDOW_MS`）。
- **eventId 去重**：渠道重推也不重复处理。
- **分段发送**：她的长回复按空行拆成几段，按长度像真人一样停顿发出；**回复真正发出后**才写进对话。
- **主动消息**：她发朋友圈动态时，会发到所有已启用的渠道（可带一张她自己「拍」的图）。
- 网页聊天**不经过** bridge，保持即时。

## 2. 渠道契约

每个渠道就是一个目录（`src/channels/<id>/`），实现同一份 `Channel` 契约（见 `src/channels/types.js`），再到 `src/channels/registry.js` 登记一行，设置页和 bridge 就自动认识它。

```js
/** @typedef {object} InboundMessage
 *  @property {string} channelId  渠道 id
 *  @property {string} eventId    渠道侧的事件唯一 id，用来去重
 *  @property {string} senderId   发消息的人在该渠道的 id
 *  @property {string} text      消息文字（非文字内容由渠道转成描述）
 *  @property {number} at        消息时间戳（毫秒） */

/** @typedef {object} Channel
 *  @property {string} id
 *  @property {string} label
 *  @property {(secrets) => boolean} isReady          凭据是否齐全
 *  @property {(ctx) => Promise<void>} start          启动收消息（长轮询或监听 webhook）
 *  @property {() => Promise<void>} stop
 *  @property {(secrets, text) => Promise<void>} sendText
 *  @property {(secrets, bytes, filename, caption?) => Promise<void>} [sendImage]
 *  @property {{key, label, secret?, hint?}[]} fields  设置页自动渲染的凭据表单 */
```

几个要点：

- `start` 必须**尽快返回**（长轮询在后台跑），否则启动会卡住。`stop` 要能干净地停下来。
- 入站消息被转换成 `InboundMessage` 交给 `onMessage`（即 `bridge.handleIncoming`）；去重、只理主人、合批都由 bridge 负责，渠道只管收发。
- `fields` 是设置页表单的数据源：`secret: true` 的字段保存后只返回「是否已填 + 末 4 位」，永远不会整体返回。
- `isReady` 通常实现为 `isChannelReady(id, secrets)`，即「启用了并且该渠道所有必填字段非空」（必填字段表在 `src/config/secrets.js` 的 `CHANNEL_FIELDS`）。

## 3. Telegram 配置全流程

Telegram 渠道用长轮询（`getUpdates`），**不需要公网地址**，最适合个人部署。

### 3.1 创建机器人

1. 在 Telegram 里搜索 `@BotFather`，发送 `/newbot`。
2. 给机器人起个名字（显示名）和一个以 `bot` 结尾的用户名（如 `my_real_netizen_bot`）。
3. BotFather 会发给你一段 **HTTP API** 令牌，形如 `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`。这就是 `Bot Token`。
4. （可选）`/setdescription` 写简介，`/setuserpic` 换头像。程序也可以在她换头像/签名时自动调 `setMyDescription` / `setMyShortDescription`。

### 3.2 拿到你的 Chat ID

她只回复**你一个人**，所以需要你的 Telegram Chat ID：

1. 先给刚创建的机器人发一条任意消息（比如「在吗」）。
2. 浏览器打开（把 `<TOKEN>` 换成你的令牌）：
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. 在返回的 JSON 里找 `message.chat.id`，这就是你的 Chat ID（一串数字，可能是负数）。**不要**把机器人拉进群里，她只处理私聊（`chat.type === "private"`），群消息会被忽略。

### 3.3 填到设置页

打开网页 → 设置 → 聊天渠道 → Telegram：

- 勾选「启用」。
- `Bot Token` 粘贴令牌，`你的 Chat ID` 填上一步的 `chat.id`。
- 保存。点「发送测试消息」，你的 Telegram 应该会收到一条「在吗」。

或者直接 `PUT /api/lin/channels`：

```json
{ "telegram": { "enabled": true, "botToken": "123456:ABC-DEF", "ownerChatId": "987654321" } }
```

### 3.4 长轮询行为

- 每 30 秒一次 `getUpdates`，用 `offset` 确认已处理的 update；`--dry` 下不启动轮询。
- 409（同一 token 被另一个轮询占用）会退避 10 秒重试；网络错误指数退避到 60 秒。
- `--channel-api-host`（默认 `https://api.telegram.org`）可改成内网/代理地址，测试时指向假服务器。

## 4. Webhook 渠道：自建中转

Webhook 渠道没有自己的服务器，靠一个**中转服务**（你或社区写的）把外部平台（QQ / 微信 / 飞书 / Discord / LINE / Slack……）的消息转发给她。她暴露一个入站口 `POST /api/lin/channels/webhook`，该口**不走访问令牌**，靠 HMAC-SHA256 签名防伪。

### 4.1 入站（中转服务 → 她）

请求：

```
POST /api/lin/channels/webhook
Content-Type: application/json
x-rn-timestamp: 1730000000000
x-rn-signature: <hex hmac_sha256(secret, raw_body)>

{ "eventId": "msg-001", "senderId": "user-123", "text": "今天好累", "at": 1730000000000 }
```

- `timestamp` 必须在 5 分钟窗口内（防重放）。
- `signature` = `hex(hmac_sha256(secret, 原始 body 字符串))`，用 `timingSafeEqual` 常量时间比较，防时序攻击。
- body 字段：`eventId`（去重用，建议唯一）、`senderId`（代表发消息的人）、`text`（非空才处理）、`at`（毫秒时间戳，可省略）。
- 验签失败返回 `401 {"error":"bad signature"}`；body 不合法返回 `400 {"error":"invalid payload"}`。

Node.js 中转示例：

```js
import { createHmac } from "node:crypto";
import fetch from "node-fetch"; // 或任意 HTTP 客户端

const SECRET = "和她设置里填的签名密钥一致";

export async function forwardToHer(text, eventId, senderId) {
  const rawBody = JSON.stringify({
    eventId,
    senderId,
    text,
    at: Date.now(),
  });
  const timestamp = Date.now();
  const signature = createHmac("sha256", SECRET).update(rawBody).digest("hex");
  await fetch("https://你的域名/api/lin/channels/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-rn-timestamp": String(timestamp),
      "x-rn-signature": signature,
    },
    body: rawBody,
  });
}
```

Python 中转示例：

```python
import hashlib, hmac, json, time, requests

SECRET = "和她设置里填的签名密钥一致".encode()

def forward_to_her(text, event_id, sender_id):
    raw_body = json.dumps({
        "eventId": event_id,
        "senderId": sender_id,
        "text": text,
        "at": int(time.time() * 1000),
    }, ensure_ascii=False).encode()
    timestamp = str(int(time.time() * 1000))
    signature = hmac.new(SECRET, raw_body, hashlib.sha256).hexdigest()
    requests.post(
        "https://你的域名/api/lin/channels/webhook",
        data=raw_body,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "x-rn-timestamp": timestamp,
            "x-rn-signature": signature,
        },
        timeout=20,
    )
```

> 重要：签名必须对**原始 body 字节**计算，不要先解析再重新序列化，否则空白/键序变化会导致签名不一致。`Content-Type` 要和 body 一致，避免中转层改写 body。

### 4.2 出站（她 → 中转服务）

她主动说话或回复时，会 `POST outboundUrl`（你在设置里填的出站地址），带着**同样的签名**。中转服务按同规则验签即可。

文字消息：

```json
{ "type": "text", "text": "我刚煮了面", "ownerId": "user-123", "at": 1730000000000 }
```

图片消息：

```json
{
  "type": "image",
  "image": { "base64": "<base64>", "filename": "photo.jpg", "caption": "她端着面" },
  "ownerId": "user-123",
  "at": 1730000000000
}
```

中转服务收到后，把文字/图片发到对应的外部平台即可。`ownerId` 是设置里「你的 ID」，告诉你该发给谁。

### 4.3 Webhook 配置

| 字段 | 说明 |
| --- | --- |
| `secret` | 签名密钥，和中转服务约定一致（HMAC-SHA256） |
| `outboundUrl` | 中转服务接收她主动消息的 URL（POST） |
| `ownerId` | 代表你本人的 id；她只回复这个 `senderId` 的消息 |

Webhook 渠道没有长轮询，`start/stop` 是空操作；`--dry` 下不发出站请求。

## 5. 30 分钟接入一个新渠道

以「把另一个平台接到她」为例，步骤如下：

1. **选型**：如果平台有 Bot API 且支持长轮询（如 Telegram），优先走长轮询，省去公网回调；否则用 Webhook + 一个中转服务（可以是另一台有公网的便宜云主机）。
2. **建目录**：`src/channels/<id>/`，实现 `Channel` 契约（参考 `telegram/channel.js` 或 `webhook/channel.js`）。至少实现 `id`、`label`、`ownerKey`、`fields`、`isReady`、`start`、`stop`、`sendText`。
3. **入站**：收到平台消息后，把发送者 id 映射到 `senderId`，文字映射到 `text`，平台事件 id 映射到 `eventId`（去重用），时间戳转毫秒，调 `onMessage({ channelId, eventId, senderId, text, at })`。忽略非私聊和非文字消息（图片等转成文字描述后传入）。
4. **出站**：`sendText` 把文字发给 `ownerId` 对应的用户；有图片需求时实现 `sendImage`。
5. **登记**：在 `src/channels/registry.js` 的 `CHANNELS` 里加一行，并在 `src/config/secrets.js` 的 `CHANNEL_FIELDS` 里登记该渠道的 `required` 和 `secret` 字段。
6. **测试**：写一个假服务器（或用 `--channel-api-host` / 测试路由）覆盖「收消息 → 她回复 → 分段发出 → 写进对话」和「只理主人、重试、限流」；在 `test/channels.test.js` 里加用例。设置页会自动渲染字段表单，`POST /api/lin/channels/<id>/test` 可发测试消息。
7. **文档**：在本文末尾补一段该平台的接入提示（可选）。

## 6. 国内外平台接入提示

- **QQ / 微信 / 飞书**：一般没有本机长轮询，走 Webhook + 中转服务。可以用一台有公网 IP 的小云主机跑中转，QQ 机器人框架（如 NapCat / LLOneBot / Lagrange 等）把消息推给她的 `/api/lin/channels/webhook`，出站地址填回框架的 HTTP API。注意平台机器人合规与风控，避免高频。
- **Discord / LINE / Slack**：官方 Bot 支持 Webhook 回调和 REST 发消息，可以直接用 Webhook 渠道模式，中转服务转发 Interaction/Message 事件，`outboundUrl` 填中转的接收地址。
- **Telegram**：内置支持，零成本，首选。
- 任何平台都注意：`eventId` 保持唯一（平台重推时去重）、`senderId` 稳定标识用户、只把主人的 id 填到 owner 字段。

## 7. 安全与排障

- **她只回复主人**：不是主人的消息直接忽略，日志里会打 `ignored message from non-owner`。
- **令牌 / 密钥不外泄**：接口永远返回打码版本；日志不打印密钥。
- **局域网监听**：Web 页访问令牌 `data/secrets/access-token.txt`；Webhook 入站口不走令牌，靠签名防伪，请把 `secret` 设得足够长且随机。
- **收不到消息**：看 `data/logs/server.log` 里的 `[lin:channels]`、`[lin:telegram]`、`[lin:webhook]`。`webhook rejected` 是签名或时间戳不对（服务器时钟差太多也会失败，5 分钟窗口）；Telegram 收不到先用 `getUpdates` 确认 Chat ID 和令牌有效。
- **Webhook 公网穿透**：可以只把 `/api/lin/channels/webhook` 用反向代理（Caddy / nginx / frp）暴露出去，其他管理接口留在局域网。也可以改用 Telegram 长轮询，完全不用公网回调。
