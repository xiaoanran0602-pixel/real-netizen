# Chat channels

> This document was cleaned from a private instance; all examples are fictional. She works fine with no channel at all (web chat only); once connected, she can talk to you on your favorite messaging app and reach out first.

## 1. Overview

A channel is an adapter between her and an external chat platform. Two are built in:

| Channel | Best for | Public URL needed? | Credentials |
| --- | --- | --- | --- |
| `telegram` | Anyone with a Telegram account | No (long polling with a bot token) | Bot token, your Chat ID |
| `webhook` | QQ / WeChat / Feishu / Discord / LINE / Slack, etc. | Yes — a relay you run (even a cheap VPS) | Secret, outbound URL, your ID |

All channels are wired through `channels/bridge.js`:

- **Owner only**: inbound `senderId` is compared with the channel's owner field; non-matching senders are ignored (others cannot trick her into talking).
- **Batching**: several messages within 2.5 seconds become one turn (`BATCH_WINDOW_MS`), so she does not reply to each one.
- **Dedup**: `eventId` keeps retries/replays from being processed twice.
- **Segmented delivery**: long replies are split on blank lines and sent with human-like pauses; the reply is written to the dialog **only after it is actually sent**.
- **Proactive messages**: when she posts a Moment, it goes to every enabled channel (optionally with a photo she "took").
- Web chat does **not** go through the bridge, so it stays instant.

## 2. Channel contract

Each channel is a directory (`src/channels/<id>/`) implementing the same `Channel` contract (see `src/channels/types.js`); one registration line in `src/channels/registry.js` makes it known to the settings page and the bridge.

```ts
interface InboundMessage {
  channelId: string;   // channel id
  eventId: string;     // unique event id for dedup
  senderId: string;    // sender's id on that channel
  text: string;        // message text (non-text content described in words)
  at: number;          // timestamp in ms
}

interface Channel {
  id: string;
  label: string;
  isReady(secrets: object): boolean;          // credentials complete?
  start(ctx: { secrets: object; onMessage(msg: InboundMessage): void }): Promise<void>;
  stop(): Promise<void>;
  sendText(secrets: object, text: string): Promise<void>;
  sendImage?(secrets: object, bytes: Buffer, filename: string, caption?: string): Promise<void>;
  fields: Array<{ key: string; label: string; secret?: boolean; hint?: string }>;
}
```

Notes:

- `start` must **return quickly** (long polling runs in the background), otherwise startup blocks. `stop` must terminate cleanly.
- Inbound messages are converted to `InboundMessage` and handed to `onMessage` (i.e. `bridge.handleIncoming`); dedup, owner check, and batching all live in the bridge — the channel only sends and receives.
- `fields` drives the settings form: fields with `secret: true` are stored but only ever shown as "set + last 4 chars".
- `isReady` is usually `isChannelReady(id, secrets)`: enabled and all required fields for that channel non-empty (the required/secret field lists live in `src/config/secrets.js` `CHANNEL_FIELDS`).

## 3. Telegram, end to end

The Telegram channel uses long polling (`getUpdates`) — **no public URL required**, which makes it the easiest personal setup.

### 3.1 Create the bot

1. In Telegram, open `@BotFather` and send `/newbot`.
2. Give a display name and a username ending in `bot` (for example `my_real_netizen_bot`).
3. BotFather replies with an **HTTP API** token like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`. This is the `Bot Token`.
4. (Optional) `/setdescription` for the bio, `/setuserpic` for the avatar. The program can also update them automatically via `setMyDescription` / `setMyShortDescription`.

### 3.2 Get your Chat ID

She replies only to **you**, so she needs your Telegram Chat ID:

1. Send any message to your new bot (for example "are you there?").
2. Open in a browser (replace `<TOKEN>` with your token):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. Find `message.chat.id` in the JSON; that is your Chat ID (a number, possibly negative). **Do not** add the bot to a group: she only handles private chats (`chat.type === "private"`); group messages are ignored.

### 3.3 Fill in the settings

Open the web app → Settings → Chat channels → Telegram:

- Enable the channel.
- Paste the `Bot Token`, and fill `Your Chat ID` with the value from the previous step.
- Save. Press "Send test message" — you should receive "Are you there?" on Telegram.

Or `PUT /api/lin/channels` directly:

```json
{ "telegram": { "enabled": true, "botToken": "123456:ABC-DEF", "ownerChatId": "987654321" } }
```

### 3.4 Long polling behavior

- `getUpdates` every 30 seconds with `offset` to acknowledge processed updates; `--dry` disables polling.
- A 409 (the same token polled by another client) backs off 10 seconds and retries; network errors back off exponentially up to 60 seconds.
- `--channel-api-host` (default `https://api.telegram.org`) can point at a proxy or a fake server for testing.

## 4. Webhook channel: bring your own relay

The webhook channel has no server of its own; a **relay service** (written by you or the community) forwards messages from an external platform (QQ / WeChat / Feishu / Discord / LINE / Slack, ...) to her inbound endpoint `POST /api/lin/channels/webhook`. That endpoint skips the access token and relies on an HMAC-SHA256 signature for authenticity.

### 4.1 Inbound (relay → her)

Request:

```
POST /api/lin/channels/webhook
Content-Type: application/json
x-rn-timestamp: 1730000000000
x-rn-signature: <hex hmac_sha256(secret, raw_body)>

{ "eventId": "msg-001", "senderId": "user-123", "text": "I'm tired today", "at": 1730000000000 }
```

- `timestamp` must be within a 5-minute window (replay protection).
- `signature` = `hex(hmac_sha256(secret, raw body string))`, compared with `timingSafeEqual` (timing-attack safe).
- Body fields: `eventId` (dedup; make it unique), `senderId` (who sent it), `text` (only non-empty text is processed), `at` (ms timestamp, optional).
- Verification failure returns `401 {"error":"bad signature"}`; invalid body returns `400 {"error":"invalid payload"}`.

Node.js relay example:

```js
import { createHmac } from "node:crypto";

const SECRET = "the same secret configured in her settings";

export async function forwardToHer(text, eventId, senderId) {
  const rawBody = JSON.stringify({
    eventId,
    senderId,
    text,
    at: Date.now(),
  });
  const timestamp = Date.now();
  const signature = createHmac("sha256", SECRET).update(rawBody).digest("hex");
  await fetch("https://your.host/api/lin/channels/webhook", {
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

Python relay example:

```python
import hashlib, hmac, json, time, requests

SECRET = "the same secret configured in her settings".encode()

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
        "https://your.host/api/lin/channels/webhook",
        data=raw_body,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "x-rn-timestamp": timestamp,
            "x-rn-signature": signature,
        },
        timeout=20,
    )
```

> Important: sign the **raw body bytes**. Do not parse and re-serialize, or whitespace/key-order changes will break the signature. Keep `Content-Type` consistent with the body so the relay layer does not rewrite it.

### 4.2 Outbound (her → relay)

When she speaks or replies, she `POST`s to `outboundUrl` (the URL you configured) signed with the **same signature**, which your relay verifies the same way.

Text message:

```json
{ "type": "text", "text": "I just made noodles", "ownerId": "user-123", "at": 1730000000000 }
```

Image message:

```json
{
  "type": "image",
  "image": { "base64": "<base64>", "filename": "photo.jpg", "caption": "her holding the bowl" },
  "ownerId": "user-123",
  "at": 1730000000000
}
```

Your relay forwards the text or image to the external platform. `ownerId` is the "your ID" from settings, telling the relay who should receive it.

### 4.3 Webhook settings

| Field | Meaning |
| --- | --- |
| `secret` | HMAC-SHA256 signing secret, shared with your relay |
| `outboundUrl` | URL where her proactive messages are POSTed (your relay) |
| `ownerId` | The id that represents you on the platform; she only replies to messages whose `senderId` matches it |

The webhook channel has no long polling: `start`/`stop` are no-ops, and `--dry` skips outbound requests.

## 5. Add a new channel in 30 minutes

Use "connect another platform to her" as the example:

1. **Choose the transport**: if the platform has a bot API with long polling (like Telegram), prefer it — no public callback needed. Otherwise use webhook + a relay (a small VPS with a public IP).
2. **Create the directory** `src/channels/<id>/` implementing the `Channel` contract (copy `telegram/channel.js` or `webhook/channel.js`). At minimum: `id`, `label`, `ownerKey`, `fields`, `isReady`, `start`, `stop`, `sendText`.
3. **Inbound**: map the platform's sender id → `senderId`, message text → `text`, platform event id → `eventId` (for dedup), and the timestamp (ms) → `at`; call `onMessage({ channelId, eventId, senderId, text, at })`. Ignore non-private and non-text messages (describe images in text).
4. **Outbound**: `sendText` sends to the user identified by `ownerId`; implement `sendImage` if the platform supports images.
5. **Register**: add a row to `src/channels/registry.js` `CHANNELS`, and list the channel's `required` and `secret` fields in `src/config/secrets.js` `CHANNEL_FIELDS`.
6. **Test**: write a fake server (or use `--channel-api-host` / the test route) covering "receive → she replies → segmented send → written to dialog" plus owner-only, retry, and rate-limit cases; add tests to `test/channels.test.js`. The settings form renders from `fields`, and `POST /api/lin/channels/:id/test` sends a test message.
7. **Document** (optional): add a platform note to the end of this file.

## 6. Platform notes

- **QQ / WeChat / Feishu**: usually no local long polling; use webhook + a relay. Run the relay on a small VPS with a public IP: a QQ bot framework (such as NapCat / LLOneBot / Lagrange) pushes messages to her `/api/lin/channels/webhook`, and its HTTP API is the `outboundUrl`. Respect each platform's bot compliance and rate limits; avoid high-frequency posting.
- **Discord / LINE / Slack**: official bots support webhook callbacks and REST messaging; use the webhook channel pattern, with the relay forwarding Interaction/Message events and `outboundUrl` pointing at the relay's receiver.
- **Telegram**: built in, zero cost — the recommended first channel.
- For any platform: keep `eventId` unique (dedup on redelivery), keep `senderId` stable for a user, and set the owner field to your own id.

## 7. Security and troubleshooting

- **Owner only**: messages from anyone else are dropped; the log line is `ignored message from non-owner`.
- **No secret leakage**: endpoints always return masked secrets, and logs never print them.
- **LAN listening**: the web token is `data/secrets/access-token.txt`; the webhook inbound path skips the token and relies on the signature — make `secret` long and random.
- **No reply?** Check `data/logs/server.log` for `[lin:channels]`, `[lin:telegram]`, `[lin:webhook]`. `webhook rejected` means a wrong signature or timestamp (a large clock skew also fails the 5-minute window). For Telegram, first confirm the token and Chat ID via `getUpdates`.
- **Exposing the webhook**: you can expose only `/api/lin/channels/webhook` through a reverse proxy (Caddy / nginx / frp) and keep the management API on the LAN. Or use Telegram long polling and avoid a public callback entirely.
