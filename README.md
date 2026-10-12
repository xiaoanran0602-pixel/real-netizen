[中文](README.md) · [English](README.en.md) · [日本語](README.ja.md)

# 真实网友（Real Netizen）

> 一个活在你电脑里的 AI 聊天伙伴。零第三方依赖，数据全在本地，写好人设她就开口说话。

[![CI](https://github.com/xiaoanran0602-pixel/real-netizen/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaoanran0602-pixel/real-netizen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## 她能做什么

- **网页聊天**：免构建单页网页，SSE 流式输出，打开浏览器就能聊。界面适配手机，同一局域网可访问。
- **记得你**：多层记忆系统（召回、清晰度、强度、日 / 周 / 月整理），她会记住你说过的事，并按重要程度决定提起还是沉底。过去不可改、今天只追加、未来可变。
- **有内心**：四维内核 + 念头池，她有情绪起伏、日程、会主动想你。可选的内心模式（观察 / 身体式），曲线在「设置 → 高级 → 她的内心」可看。
- **会主动**：朋友圈、换头像签名、主动发消息，用内置的生图模型配图。不是定时任务，是随机间隔加事件触发，大多数时候什么都不做。
- **多渠道**：Telegram 开箱即用（长轮询，无需公网地址），Webhook 渠道可接 QQ / 微信 / 飞书 / Discord / LINE / Slack 等任意平台，只回复你一个人。
- **你的数据你做主**：所有数据在本地 `data/`，不上传任何云。换电脑拷走整个目录即可。
- **零依赖**：Node.js 22+ 直接跑，没有 npm 依赖要装，也没有构建步骤。

## 三分钟上手

```powershell
git clone https://github.com/xiaoanran0602-pixel/real-netizen.git
cd real-netizen
node src/main.js
```

启动后终端会打印带令牌的链接，按住 Ctrl 点击打开网页。然后：

1. **设置 → 模型**：填接口地址和 API Key（OpenAI / Anthropic / DeepSeek / OpenRouter / Ollama 都行）。
2. **设置 → 人设**：写她是谁。可从 [`examples/persona.md`](./examples/persona.md) 起步。
3. **（可选）设置 → 聊天渠道**：接 Telegram 等，让她在聊天软件里陪你。
4. **（可选）后台常驻**：Windows 用 `lin.ps1 -Install` 注册计划任务。

完整步骤见 [快速开始](./docs/zh/getting-started.md)。

## 截图

> 截图占位：计划放入聊天界面、她的动态（朋友圈）与设置页截图，欢迎 PR 补充。

## 文档

- [快速开始](./docs/zh/getting-started.md)
- [架构与模块地图](./docs/zh/architecture.md)
- [聊天渠道（Telegram / Webhook / 接入新渠道）](./docs/zh/channels.md)
- [记忆系统](./docs/zh/memory-system.md)
- [模型调校](./docs/zh/model-tuning.md)
- [她的动态](./docs/zh/moments.md)
- [内核（活人感 / 念头池 / 情绪身体）](./docs/zh/inner-kernel.md)
- [数据、迁移与回档](./docs/zh/data-and-migration.md)
- [存档与遗忘](./docs/zh/archive-and-forgetting.md)
- [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md) · [Code of Conduct](./CODE_OF_CONDUCT.md)

英文与日文文档目前只有入门 / 架构 / 渠道三篇（位于 `docs/en/`、`docs/ja/`），深度文档暂为中文；欢迎翻译 PR，标签 `i18n`。

## Roadmap

- [ ] 性别可配置（她 / 他 / TA）
- [ ] 更多内置渠道（QQ / 微信 / 飞书 / Discord / LINE / Slack 的现成中转）
- [ ] Docker 镜像，一键部署
- [ ] 桌面端（Electron / Tauri）封装
- [ ] 移动端适配与 PWA

## 贡献

欢迎 Issue 和 PR。开始前请看 [CONTRIBUTING.md](./CONTRIBUTING.md)：开发环境、`npm test`、400 行限制、隐私禁词测试、提交信息约定、新渠道贡献步骤都在里面。

特别欢迎：

- **新渠道**：实现 `Channel` 契约 + 登记一行即可，详见 [channels.md](./docs/zh/channels.md) 第 5 节。提 PR 时可附 `channel_proposal` 模板。
- **翻译**：把 `docs/zh/` 的文档译成英文 / 日文，标签 `i18n`。

## 许可

[MIT License](./LICENSE) © 2026 xiaoanran0602-pixel。
