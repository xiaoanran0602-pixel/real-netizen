# はじめに

> 本文書は個人利用版を浄化したもので、すべての例は架空です。3 分後にはブラウザの中で彼女と話ができるようになります。

## 1. Node.js のインストール

Real Netizen は依存パッケージゼロですが、**Node.js 22 以上**が必要です（22 と 24 でテスト済み）。

```powershell
node --version   # v22.x または v24.x LTS を推奨
```

- Windows：[nodejs.org](https://nodejs.org) から LTS インストーラをダウンロードし、PowerShell を再起動。
- macOS：`brew install node@22`。
- Linux：パッケージマネージャ、または [nvm](https://github.com/nvm-sh/nvm) で `nvm install 22`。

## 2. コードの取得

```powershell
git clone https://github.com/xiaoanran0602-pixel/real-netizen.git
cd real-netizen
```

Git がない場合：GitHub ページの **Code → Download ZIP** から ZIP をダウンロードして展開し、そのディレクトリに `cd`。リポジトリには `data/` フォルダはなく（`.gitkeep` のみ）、必要なディレクトリは初回起動時に自動生成されます。

## 3. 起動

```powershell
node src/main.js
```

起動すると次のような表示が出ます：

```text
  はい、ここにいます：http://127.0.0.1:3030/?token=xxxxxxxx
  スマホ（同じネットワーク）：http://192.168.x.x:3030/?token=xxxxxxxx
  データディレクトリ：C:\...\real-netizen\data
```

**はい、ここにいます**のリンク（トークン付き）を Ctrl クリックして Web アプリを開きます。**トークンは Web UI への唯一の認証情報**で、`data/secrets/access-token.txt` に保存され、初回起動時に生成されます。LAN 公開（`0.0.0.0`）ではトークン必須です。ローカルのみの場合は `--host 127.0.0.1` を追加。

### 主な起動オプション

| オプション | デフォルト | 説明 |
| --- | --- | --- |
| `--port <n>` | `3030` | ポート番号 |
| `--host <addr>` | `0.0.0.0` | `127.0.0.1` でローカル限定、`0.0.0.0` で LAN 公開 |
| `--data <dir>` | `./data` | データディレクトリを変更（コピーでのリハーサル用） |
| `--dry` | 無効 | バックグラウンド処理とチャネル送信を停止（デバッグ用） |
| `--channel-api-host <url>` | `https://api.telegram.org` | Telegram のベース URL をテスト用サーバに向ける |
| `--debug` | 無効 | 詳細ログを有効化 |

ポートが使用中の場合、終了コード 2 で原因を表示して終了します。

## 4. モデル設定

モデル未設定の場合、Web アプリにバナーが表示されます。**設定 → モデル**を開いて入力：

| プロバイダ | プロトコル | エンドポイント | チャットモデル（例） | API Key |
| --- | --- | --- | --- | --- |
| OpenAI | OpenAI 互換 | `https://api.openai.com` | `gpt-5` | OpenAI で取得 |
| Anthropic | Anthropic Messages | `https://api.anthropic.com` | `claude-sonnet-4-6` | Anthropic で取得 |
| DeepSeek | OpenAI 互換 | `https://api.deepseek.com` | `deepseek-chat` | DeepSeek で取得 |
| OpenRouter | OpenAI 互換 | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4-6` | OpenRouter で取得 |
| Ollama（ローカル） | OpenAI 互換 | `http://127.0.0.1:11434/v1` | `qwen3:8b` | 空欄 |

- **エンドポイント**：`/v1` の有無は問いません（プログラムが補完します）。
- **API Key**：`data/secrets/model.json` に保存され、設定画面には末尾 4 文字のみ表示。空欄 = 既存を維持。
- **バックグラウンドモデル**：記憶整理、予定、Moments などに使用。空欄でチャットモデルを流用し、失敗時にチャットモデルで 1 回リトライ。
- **画像モデル**：OpenAI Images 互換のモデル名。空欄で `gpt-image-1`。画像生成を無効にすると、アイコン変更、Moments 画像、自発写真をスキップし、テキストのみの投稿になります。

> フィールドの形状は [`../examples/settings.example.json`](../examples/settings.example.json) を参照。

## 5. ペルソナの作成

彼女の人物像と話し方は `data/persona.md` に書きます。**設定 → ペルソナ**でオンライン編集でき、**次のメッセージから即反映**されます。

- [`../examples/persona.md`](../examples/persona.md) を `data/persona.md` にコピーしてから自分好みに修改するのが始めやすい。
- ペルソナが具体的ほど安定。身分・経歴、話し方（口癖、文長、絵文字の使用）、ユーザーとの関係、敏感な話題を含めるとよい。記述のコツは同ファイルの注記を参照。
- 「彼について」（彼女があなたを知っていること）は `data/core.md` に保存され、会話しながら成長します。テンプレートは [`../examples/core.example.md`](../examples/core.example.md)。
- 「彼女自身について」は内蔵テキストがデフォルト。上書きする場合は `data/core-self.md` を作成（[`../examples/core-self.example.md`](../examples/core-self.example.md) 参照）。ユーザーとは独立していて、彼女がまず彼女自身であることを保証します。

## 6. チャットチャネルの接続（任意）

チャネルを接続しない場合、彼女は Web ページでのみ会話します。Telegram / QQ / WeChat などで話しかけてもらうには、**設定 → チャットチャネル**で有効化と認証情報を入力：

- **Telegram**：公网 URL 不要。Bot Token とチャット ID を入力。BotFather での bot 作成、チャット ID の取得、テストは [channels.md](./channels.md) §3。
- **Webhook（自前リレー）**：QQ / WeChat / Feishu / Discord など向け。自作のリレーサービスが必要。ペイロードと署名規則は [channels.md](./channels.md) §4、フィールドテンプレートは [`../examples/channels.example.json`](../examples/channels.example.json)。

設定画面の「テストメッセージ送信」を押して、チャネルに「いる？」が届けば接続成功です。

## 7. 常駐化

### Windows（lin.ps1）

リポジトリ同梱の `lin.ps1` に監視機能がついています：

```powershell
.\lin.ps1 -Install    # スケジュールタスク「Lin」を登録（ログオン時に -Watch 起動）し、即座に開始
.\lin.ps1 -Restart    # コード変更後に再起動
.\lin.ps1 -Open       # トークン付きでブラウザを開く
.\lin.ps1 -Stop       # 監視を停止
.\lin.ps1 -Uninstall  # スケジュールタスクを削除
```

`-Watch` 中はクラッシュ時に 10 秒以内に再起動され、ログは `data\logs\` に（`server.log`、`server.err.log`、`watchdog.log`）。`lin.ps1` は UTF-8 BOM 付き。`-Pack` で `data\secrets` と `data\logs` を除外した zip を作成し、移行に使えます。

### macOS（launchd）

`~/Library/LaunchAgents/com.realnetizen.plist` を作成：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.realnetizen</string>
  <key>WorkingDirectory</key><string>/path/to/real-netizen</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>src/main.js</string>
    <string>--host</string><string>0.0.0.0</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/path/to/real-netizen/data/logs/server.log</string>
  <key>StandardErrorPath</key><string>/path/to/real-netizen/data/logs/server.err.log</string>
</dict>
</plist>
```

`/usr/local/bin/node` を `which node` の結果に差し替え、パスを修正してから：

```bash
launchctl load -w ~/Library/LaunchAgents/com.realnetizen.plist
launchctl unload -w ~/Library/LaunchAgents/com.realnetizen.plist   # 停止時
```

### Linux（systemd --user）

`~/.config/systemd/user/real-netizen.service` を作成：

```ini
[Unit]
Description=Real Netizen
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/real-netizen
ExecStart=/usr/bin/node src/main.js --host 0.0.0.0
Restart=on-failure
RestartSec=10
StandardOutput=append:/path/to/real-netizen/data/logs/server.log
StandardError=append:/path/to/real-netizen/data/logs/server.err.log

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now real-netizen
loginctl enable-linger $USER   # ログアウト後も動かす場合のみ
systemctl --user status real-netizen
```

## 8. データとバックアップ、移行

すべてが `data/` に保存され、**クラウドには何も送られません**。新いパソコンへはこのフォルダごとコピーし、`--data` で指定するだけです。

```powershell
node src/main.js --data D:\backup\real-netizen-data
```

- データファイル一覧と移行リハーサル手順は [data-and-migration.md](./data-and-migration.md)（中国語）を参照。
- `data/secrets/`（モデル Key とチャネル認証情報）を忘れずにバックアップ。`data/logs/` は不要。
- `data/secrets/` と `data/logs/` は `.gitignore` で Git 管理外。`data/` がない場合は初回起動時に生成されます。

## 9. FAQ

**Q：Web ページが開けない**
ターミナルに表示されたリンクを確認。`http://`（https ではない）を使用。`--host 127.0.0.1` ではスマホから接続できないので、デフォルトの `0.0.0.0` を使用。ファイアウォールでポートを許可。トークンが異なると入れません。`data/secrets/access-token.txt` を削除して再起動すると新しく生成され、新しいリンクから開けます。

**Q：モデルが 401/403 を返す**
API Key またはエンドポイントが間違っている。Anthropic は「Anthropic Messages」と `https://api.anthropic.com`。OpenAI 互換 API は「OpenAI 互換」を選択し、`/v1` を含む完全な URL を入力。

**Q：返信がない、または返信がおかしい**
`data/logs/server.log` を確認。`--dry` モードではチャネル送信は行われますが、Web チャットは正常。モデル未設定では無言。設定ページに案内が表示される。ペルソナ変更は次メッセージから効くので再起動不要。

**Q：アップデート方法**
`git pull`（または新しい ZIP で上書き。`data/` は git-ignored のため影響なし）。コード変更後は `lin.ps1 -Restart`。更新前に `data/` をバックアップしておくと安全。

**Q：完全に停止する方法**
Windows：`.\lin.ps1 -Stop` のち `.\lin.ps1 -Uninstall`。macOS/Linux：`launchctl unload` / `systemctl --user disable --now`。フォアグラウンドの場合は Ctrl+C。
