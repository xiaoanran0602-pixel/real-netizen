# チャットチャネル

> 本文書は個人利用版を浄化したもので、すべての例は架空です。チャネルは未接続でも Web チャットだけ使えます。接続すると、お好みのメッセンジャーアプリで彼女と会話し、彼女からも話しかけてもらえます。

## 1. 概要

チャネル（Channel）は、彼女と外部チャットプラットフォームの間のアダプタです。2 つが内蔵されています：

| チャネル | 向いている人 | 公网 URL が必要？ | 認証情報 |
| --- | --- | --- | --- |
| `telegram` | Telegram アカウントをお持ちの方 | 不要（Bot Token による長時間ポーリング） | Bot Token、チャット ID |
| `webhook` | QQ / WeChat / Feishu / Discord / LINE / Slack など | あり — 自前のリレーサービス（安価な VPS でも可） | 署名シークレット、送信先 URL、あなたの ID |

すべてのチャネルは `channels/bridge.js` を通じて結線されます：

- **オーナーのみ返信**：受信 `senderId` をチャネルのオーナーフィールドと比較し、不一致は無視（他の人が bot を見えても話されない）。
- **バッチ処理**：2.5 秒以内の連続送信を 1 ターンにまとめる（`BATCH_WINDOW_MS`）。
- **重複排除**：`eventId` で再配信を 2 回処理しない。
- **分割送信**：長い返信は空行で分割し、人間らしい間隔で送信。**実際に送信された後**に会話へ書き込まれる。
- **自発メッセージ**：Moments 投稿時に、全 enabled チャネルへ送信（写真付き可）。
- Web チャットはブリッジを**通過しない**ので即時。

## 2. チャネル契約

各チャネルはディレクトリ（`src/channels/<id>/`）で、同一の `Channel` 契約（`src/channels/types.js` 参照）を実装します。`src/channels/registry.js` に 1 行登録すると、設定ページとブリッジに認識されます。

```ts
interface InboundMessage {
  channelId: string;   // チャネル id
  eventId: string;     // 重複排除用イベント id
  senderId: string;    // 送信者のチャネル上 id
  text: string;        // メッセージ文字（非文字は説明文に変換）
  at: number;          // タイムスタンプ（ミリ秒）
}

interface Channel {
  id: string;
  label: string;
  isReady(secrets: object): boolean;          // 認証情報が揃っているか
  start(ctx: { secrets: object; onMessage(msg: InboundMessage): void }): Promise<void>;
  stop(): Promise<void>;
  sendText(secrets: object, text: string): Promise<void>;
  sendImage?(secrets: object, bytes: Buffer, filename: string, caption?: string): Promise<void>;
  fields: Array<{ key: string; label: string; secret?: boolean; hint?: string }>;
}
```

ポイント：

- `start` は**即座に返る**（長時間ポーリングはバックグラウンドで動く）必要がある。`stop` は確実に停止。
- 受信メッセージは `InboundMessage` に変換して `onMessage`（すなわち `bridge.handleIncoming`）へ渡す。重複排除、オーナーチェック、バッチ処理はブリッジの責務で、チャネルは送受信のみ。
- `fields` が設定フォームのデータソース。`secret: true` のフィールドは保存後「設定済み + 末尾 4 文字」のみ表示。
- `isReady` は通常 `isChannelReady(id, secrets)`、すなわち enabled かつ当該チャネルの全 required フィールドが非空（required/secret の一覧は `src/config/secrets.js` の `CHANNEL_FIELDS`）。

## 3. Telegram の設定手順

Telegram チャネルは長時間ポーリング（`getUpdates`）を使うため**公网 URL 不要**で、個人利用に最適。

### 3.1 bot の作成

1. Telegram で `@BotFather` を開き、`/newbot` を送信。
2. 表示名と、`bot` で終わるユーザー名（例：`my_real_netizen_bot`）を入力。
3. BotFather が **HTTP API** トークン（例：`123456789:ABCdefGHIjklMNOpqrsTUVwxyz`）を発行。これが `Bot Token`。
4. （任意）`/setdescription` で紹介文、`/setuserpic` でアイコンを設定。プログラムも `setMyDescription` / `setMyShortDescription` で自動更新可能。

### 3.2 チャット ID の取得

彼女は**あなただけに**返信するので、Telegram チャット ID が必要：

1. 作成した bot に任意のメッセージ（例：「いる？」）を送信。
2. ブラウザで `<TOKEN>` を実際のトークンに差し替えて開く：
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. JSON 内の `message.chat.id` がチャット ID（負数のこともある）。bot をグループに追加しないこと：プライベートチャット（`chat.type === "private"`）のみ処理し、グループメッセージは無視。

### 3.3 設定ページへ入力

Web アプリ → 設定 → チャットチャネル → Telegram：

- 有効化。
- `Bot Token` にトークン、`チャット ID` に前ステップの `chat.id` を入力。
- 保存。「テストメッセージ送信」を押すと Telegram に「いる？」が届く。

または `PUT /api/lin/channels` で直接：

```json
{ "telegram": { "enabled": true, "botToken": "123456:ABC-DEF", "ownerChatId": "987654321" } }
```

### 3.4 長時間ポーリングの挙動

- `getUpdates` は 30 秒ごと、`offset` で処理済み update を確認。`--dry` ではポーリング停止。
- 409（同一 token が別クライアントからポーリング）は 10 秒バックオフしてリトライ。ネットワークエラーは指数バックオフで最大 60 秒。
- `--channel-api-host`（デフォルト `https://api.telegram.org`）でプロキシーやテスト用偽サーバを指定可能。

## 4. Webhook チャネル：自前のリレー

Webhook チャネルは独自のサーバがなく、**リレーサービス**（自作やコミュニティ製）が QQ / WeChat / Feishu / Discord / LINE / Slack などのメッセージを彼女の受信口 `POST /api/lin/channels/webhook` へ転送します。この口はアクセストークン**不要**で、HMAC-SHA256 署名で真正性を確認します。

### 4.1 受信（リレー → 彼女）

リクエスト：

```
POST /api/lin/channels/webhook
Content-Type: application/json
x-rn-timestamp: 1730000000000
x-rn-signature: <hex hmac_sha256(secret, raw_body)>

{ "eventId": "msg-001", "senderId": "user-123", "text": "今日は疲れた", "at": 1730000000000 }
```

- `timestamp` は 5 分ウィンドウ内が必要（リプレイ防止）。
- `signature` = `hex(hmac_sha256(secret, リクエストボディ生文字列))`、`timingSafeEqual` で定数時間比較（タイミング攻撃対策）。
- ボディフィールド：`eventId`（重複排除、一意に）、`senderId`（送信者）、`text`（非空のみ処理）、`at`（ミリ秒、省略可）。
- 署名失敗は `401 {"error":"bad signature"}`、ボディ不正は `400 {"error":"invalid payload"}`。

Node.js リレー例：

```js
import { createHmac } from "node:crypto";

const SECRET = "彼女の設定と同じシークレット";

export async function forwardToHer(text, eventId, senderId) {
  const rawBody = JSON.stringify({
    eventId,
    senderId,
    text,
    at: Date.now(),
  });
  const timestamp = Date.now();
  const signature = createHmac("sha256", SECRET).update(rawBody).digest("hex");
  await fetch("https://あなたのホスト/api/lin/channels/webhook", {
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

Python リレー例：

```python
import hashlib, hmac, json, time, requests

SECRET = "彼女の設定と同じシークレット".encode()

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
        "https://あなたのホスト/api/lin/channels/webhook",
        data=raw_body,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "x-rn-timestamp": timestamp,
            "x-rn-signature": signature,
        },
        timeout=20,
    )
```

> 重要：署名は**生のボディバイト**に対して計算すること。パース→再シリアライズをしない（空白/キー順序の変化で署名不一致）。`Content-Type` はボディと一致させ、リレー層に改変されないよう配慮。

### 4.2 送信（彼女 → リレー）

彼女が話し出したり返信したりするとき、`outboundUrl`（設定した送信先 URL）へ**同一の署名**で POST する。リレー側は同じ規則で検証する。

テキストメッセージ：

```json
{ "type": "text", "text": "今、麺を作った", "ownerId": "user-123", "at": 1730000000000 }
```

画像メッセージ：

```json
{
  "type": "image",
  "image": { "base64": "<base64>", "filename": "photo.jpg", "caption": "彼女が椀を持っている" },
  "ownerId": "user-123",
  "at": 1730000000000
}
```

リレーはテキストや画像を外部プラットフォームに転送。`ownerId` は設定の「あなたの ID」で、誰に送るかを示す。

### 4.3 Webhook 設定フィールド

| フィールド | 意味 |
| --- | --- |
| `secret` | HMAC-SHA256 署名シークレット（リレーと同一） |
| `outboundUrl` | 彼女の自発メッセージを受ける URL（リレー） |
| `ownerId` | プラットフォーム上でのあなたの ID。この `senderId` に一致するメッセージにのみ返信 |

Webhook チャネルに長時間ポーリングはないので `start`/`stop` は空操作。`--dry` では送信されない。

## 5. 30 分で新しいチャネルを追加

「別のプラットフォームを彼女に接続する」を例に：

1. **通信方式の選択**：長時間ポーリング対応の bot API があればそれ（Telegram のように公网不要）。なければ webhook + リレー（公网 IP の安価な VPS）。
2. **ディレクトリ作成**：`src/channels/<id>/` に `Channel` 契約を実装（`telegram/channel.js` か `webhook/channel.js` を参考）。最低限 `id`、`label`、`ownerKey`、`fields`、`isReady`、`start`、`stop`、`sendText`。
3. **受信**：プラットフォームの送信者 id → `senderId`、本文 → `text`、イベント id → `eventId`（重複排除）、タイムスタンプ → `at`（ミリ秒）に変換し `onMessage({ channelId, eventId, senderId, text, at })` を呼ぶ。プライベート以外/非文字は無視（画像は説明文に）。
4. **送信**：`sendText` で `ownerId` のユーザーに送信。画像対応なら `sendImage`。
5. **登録**：`src/channels/registry.js` の `CHANNELS` に 1 行追加し、`src/config/secrets.js` の `CHANNEL_FIELDS` に required/secret フィールドを登録。
6. **テスト**：偽サーバ（または `--channel-api-host` / テストルート）で「受信 → 彼女が返信 → 分割送信 → 会話に書き込み」、オーナー限定、リトライ、レート制限をテストし `test/channels.test.js` に追加。設定フォームは `fields` から自動生成。`POST /api/lin/channels/:id/test` でテスト送信。
7. **文書化**（任意）：本文末尾にプラットフォームの注意を追記。

## 6. プラットフォーム別ヒント

- **QQ / WeChat / Feishu**：通常、自前の長時間ポーリング不可。webhook + リレーで対応。公网 IP の小さな VPS がリレーを動かし、QQ bot フレームワーク（NapCat / LLOneBot / Lagrange など）が彼女の `/api/lin/channels/webhook` に push、その HTTP API が `outboundUrl` になる。各プラットフォームの bot 規約とレート制限を守り、高頻度投稿は避ける。
- **Discord / LINE / Slack**：公式 bot が webhook コールバックと REST メッセージ送信をサポート。webhook チャネル方式で、リレーが Interaction/Message イベントを転送し、`outboundUrl` はリレーの受信口。
- **Telegram**：内蔵、コストゼロ。最初のチャネルとして推奨。
- どのプラットフォームでも：`eventId` は一意に保つ（再配信対策）、`senderId` はユーザーに対して安定、オーナーフィールドには自分の id を設定。

## 7. セキュリティとトラブルシューティング

- **オーナーのみ**：他人のメッセージは破棄。ログに `ignored message from non-owner`。
- **シークレット不漏洩**：API はマスキング後の値のみ返却。ログにシークレットを出力しない。
- **LAN 公開**：Web トークンは `data/secrets/access-token.txt`。Webhook 受信口はトークン不要で署名に依存 — `secret` は長くランダムに。
- **返信がない**：`data/logs/server.log` の `[lin:channels]`、`[lin:telegram]`、`[lin:webhook]` を確認。`webhook rejected` は署名/タイムスタンプ誤り（時計ずれが大きいと 5 分ウィンドウで失敗）。Telegram は `getUpdates` でトークンとチャット ID を再確認。
- **Webhook の公開**：リバースプロキシ（Caddy / nginx / frp）で `/api/lin/channels/webhook` のみ公网に露出し、管理 API は LAN に留めることもできる。または Telegram 長時間ポーリングに切り替え、公网コールバック不要。
