[中文](README.md) · [English](README.en.md) · [日本語](README.ja.md)

# Real Netizen

> An AI companion who lives on your own computer. Zero dependencies, all data stays local, and she starts talking once you write a persona.

[![CI](https://github.com/xiaoanran0602-pixel/real-netizen/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaoanran0602-pixel/real-netizen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## What she can do

- **Web chat**: a build-free single page app with SSE streaming. Open it in a browser to talk. Phone-friendly, reachable on your LAN.
- **Remembers you**: a layered memory system (recall, clarity, strength, day/week/month consolidation). She remembers what you said and decides whether to bring it up or let it settle. The past is immutable, today is append-only, the future can change.
- **Has an inner life**: a four-dimensional kernel plus a thought pool. She has moods, a daily schedule, and messages you first. Optional inner modes (observe / body); curves are visible under Settings → Advanced → Her inner state.
- **Reaches out**: Moments (a social feed), avatar/signature changes, and proactive messages, illustrated with the built-in image model. Not a cron job: random intervals plus event triggers, and most of the time she does nothing.
- **Multiple channels**: Telegram works out of the box (long polling, no public URL needed). The webhook channel can connect QQ / WeChat / Feishu / Discord / LINE / Slack and more — and she only replies to you.
- **Your data, your rules**: everything lives in `data/` on your machine. Nothing is uploaded. Move to a new computer by copying that folder.
- **Zero dependencies**: runs on Node.js 22+ with no npm packages to install and no build step.

## Three-minute start

```powershell
git clone https://github.com/xiaoanran0602-pixel/real-netizen.git
cd real-netizen
node src/main.js
```

The terminal prints a link with an access token. Ctrl-click it to open the web app. Then:

1. **Settings → Model**: fill in the endpoint and API key (OpenAI / Anthropic / DeepSeek / OpenRouter / Ollama all work).
2. **Settings → Persona**: write who she is. Start from [`examples/persona.md`](./examples/persona.md).
3. **(Optional) Settings → Chat channels**: connect Telegram so she can talk to you in your messaging app.
4. **(Optional) Run in the background**: on Windows, `lin.ps1 -Install` registers a scheduled task.

See [Getting started](./docs/en/getting-started.md) for the full walkthrough.

## Screenshots

> Screenshot placeholder: planned shots of the chat view, her Moments feed, and the settings pages. PRs welcome.

## Documentation

- [Getting started](./docs/en/getting-started.md)
- [Architecture and module map](./docs/en/architecture.md)
- [Chat channels (Telegram / Webhook / adding a channel)](./docs/en/channels.md)

The deeper design documents (memory, kernel, moments, archive, tuning) are currently available in Chinese only under `docs/zh/`. English and Japanese versions are being added — translation PRs are very welcome, tagged `i18n`. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Roadmap

- [ ] Configurable gender (she / he / they)
- [ ] More built-in channels (QQ / WeChat / Feishu / Discord / LINE / Slack adapters)
- [ ] Docker image for one-command deployment
- [ ] Desktop wrapper (Electron / Tauri)
- [ ] Better mobile support and PWA

## Contributing

Issues and PRs are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) first: dev environment, `npm test`, the 400-line limit, the privacy-word test, commit conventions, and how to add a channel.

Especially welcome:

- **New channels**: implement the `Channel` contract and register one line. See [channels.md](./docs/en/channels.md) §5. Use the `channel_proposal` issue template.
- **Translations**: translate `docs/zh/` into English or Japanese, tagged `i18n`.

## License

[MIT License](./LICENSE) © 2026 xiaoanran0602-pixel.
