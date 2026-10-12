[中文](README.md) · [English](README.en.md) · [日本語](README.ja.md)

# Real Netizen（リアル・ネティゼン）

> あなたのパソコンの中に住む AI チャットパートナー。依存パッケージゼロ、データはすべてローカルに保存され、ペルソナを書くだけで話しかけてきます。

[![CI](https://github.com/xiaoanran0602-pixel/real-netizen/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaoanran0602-pixel/real-netizen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## できること

- **Web チャット**：ビルド不要のシングルページアプリ、SSE ストリーミング。ブラウザを開くだけで会話できます。スマホ対応、同一 LAN 内ならアクセス可能。
- **あなたを覚えている**：多層的な記憶システム（想起、鮮明度、強度、日/週/月の整理）。言ったことを覚え、重要度に応じて話題にするか沈めてかを決めます。過去は不変、今日は追記のみ、未来は変更可能。
- **内面がある**：4 次元カーネル + 念頭池。気分の起伏があり、予定を管理し、自分から話しかけてきます。内心モード（観察 / ボディ）は「設定 → 詳細 → 彼女の内心」で確認できます。
- **自発的に行動**：投稿（Moments）、アイコン/署名の変更、自発メッセージ。内蔵の画像生成モデルで挿絵も作ります。定期実行ではなく、ランダム間隔 + イベントトリガーで、ほとんどの時間は何もしません。
- **マルチチャネル**：Telegram はすぐに使え（長時間ポーリング、公网 URL 不要）。Webhook チャネルで QQ / WeChat / Feishu / Discord / LINE / Slack などに接続でき、あなただけに返信します。
- **データはあなたのもの**：すべて `data/` に保存され、クラウドには何も送られません。引っ越しはこのフォルダごとコピーするだけ。
- **依存ゼロ**：Node.js 22+ があれば npm パッケージもビルドもいりません。

## 3 分で始める

```powershell
git clone https://github.com/xiaoanran0602-pixel/real-netizen.git
cd real-netizen
node src/main.js
```

起動するとトークン付きのリンクが表示されるので、Ctrl を押しながらクリックして Web アプリを開きます。その後：

1. **設定 → モデル**：エンドポイントと API Key を入力（OpenAI / Anthropic / DeepSeek / OpenRouter / Ollama などに対応）。
2. **設定 → ペルソナ**：彼女の人物像を書く。[`examples/persona.md`](./examples/persona.md) をベースに。
3. **（任意）設定 → チャットチャネル**：Telegram などを接続し、メッセンジャーでも話せるようにする。
4. **（任意）常駐化**：Windows では `lin.ps1 -Install` でスケジュールタスクを登録。

詳細は [はじめに](./docs/ja/getting-started.md) を参照。

## スクリーンショット

> スクリーンショットのプレースホルダー：チャット画面、Moments、設定ページの画像を予定しています。PR での追加を歓迎します。

## ドキュメント

- [はじめに](./docs/ja/getting-started.md)
- [アーキテクチャとモジュール図](./docs/ja/architecture.md)
- [チャットチャネル（Telegram / Webhook / チャネル追加）](./docs/ja/channels.md)

記憶システム、カーネル、Moments、アーカイブ、モデル調整などの詳細ドキュメントは現在中国語のみ（`docs/zh/`）です。日本語への翻訳 PR を歓迎します（`i18n` タグ）。[CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

## ロードマップ

- [ ] 性別の設定可能（彼女 / 彼 / その他）
- [ ] さらに多くの組み込みチャネル（QQ / WeChat / Feishu / Discord / LINE / Slack のアダプタ）
- [ ] Docker イメージでワンコマンドデプロイ
- [ ] デスクトップアプリ（Electron / Tauri）
- [ ] モバイル対応と PWA

## コントリビューション

Issue や PR を歓迎します。始める前に [CONTRIBUTING.md](./CONTRIBUTING.md) を読んでください：開発環境、`npm test`、400 行制限、プライバシー語テスト、コミット規約、チャネル追加方法が書かれています。

特に歓迎：

- **新チャネル**：`Channel` 契約を実装して 1 行登録するだけ。[channels.md](./docs/ja/channels.md) §5 参照。`channel_proposal` テンプレートを使用。
- **翻訳**：`docs/zh/` のドキュメントを日本語に翻訳（`i18n` タグ）。

## ライセンス

[MIT License](./LICENSE) © 2026 xiaoanran0602-pixel。
