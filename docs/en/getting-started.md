# Getting started

> This document was cleaned from a private instance; all examples are fictional. Three minutes from now, she will be talking to you in your browser.

## 1. Install Node.js

Real Netizen has zero third-party dependencies, but it needs **Node.js 22 or newer** (tested on 22 and 24).

```powershell
node --version   # v22.x or v24.x LTS recommended
```

- Windows: download the LTS installer from [nodejs.org](https://nodejs.org). Reopen PowerShell afterwards.
- macOS: `brew install node@22`.
- Linux: use your package manager, or [nvm](https://github.com/nvm-sh/nvm) with `nvm install 22`.

## 2. Get the code

```powershell
git clone https://github.com/xiaoanran0602-pixel/real-netizen.git
cd real-netizen
```

No Git? Download the ZIP from the GitHub page, extract it, and `cd` into it. The repository has no `data/` folder (only a `.gitkeep` placeholder); the directories are created automatically on first launch.

## 3. Launch

```powershell
node src/main.js
```

The terminal prints something like:

```text
  She is here: http://127.0.0.1:3030/?token=xxxxxxxx
  Phone (same network): http://192.168.x.x:3030/?token=xxxxxxxx
  Data directory: C:\...\real-netizen\data
```

Ctrl-click the **She is here** link (it carries the token) to open the web app. **The token is the only credential for the web UI**, stored at `data/secrets/access-token.txt` and generated on first launch. Listening on the LAN (`0.0.0.0`) requires a token; if you only want local access, add `--host 127.0.0.1`.

### Common flags

| Flag | Default | Description |
| --- | --- | --- |
| `--port <n>` | `3030` | Port |
| `--host <addr>` | `0.0.0.0` | `127.0.0.1` for local-only, `0.0.0.0` for LAN |
| `--data <dir>` | `./data` | Use a different data directory (e.g. a copy for rehearsal) |
| `--dry` | off | Skip background scheduling and never send channel messages (debugging) |
| `--channel-api-host <url>` | `https://api.telegram.org` | Point the Telegram base URL at a fake server |
| `--debug` | off | Verbose logs |

If the port is already in use, the process exits with code 2 and names the culprit.

## 4. Model settings

If no model is configured, the web app shows a banner. Open **Settings → Model** and fill in the form:

| Provider | Protocol | Endpoint | Chat model (example) | API key |
| --- | --- | --- | --- | --- |
| OpenAI | OpenAI compatible | `https://api.openai.com` | `gpt-5` | from OpenAI |
| Anthropic | Anthropic Messages | `https://api.anthropic.com` | `claude-sonnet-4-6` | from Anthropic |
| DeepSeek | OpenAI compatible | `https://api.deepseek.com` | `deepseek-chat` | from DeepSeek |
| OpenRouter | OpenAI compatible | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4-6` | from OpenRouter |
| Ollama (local) | OpenAI compatible | `http://127.0.0.1:11434/v1` | `qwen3:8b` | leave empty |

- **Endpoint**: with or without `/v1` both work; the path is completed for you.
- **API key**: stored only in `data/secrets/model.json` on your machine. The settings page never shows the full key, and leaving the field empty means "keep the existing key".
- **Background model**: used for memory curation, schedules, Moments, etc. Leave empty to reuse the chat model; a failure falls back to the chat model once.
- **Image model**: an OpenAI Images-compatible model name; defaults to `gpt-image-1` when empty. Turn off "Allow image generation" and she skips avatar changes, Moment images, and proactive photos, posting text-only Moments instead.

> See [`../examples/settings.example.json`](../examples/settings.example.json) for the exact field shapes.

## 5. Write a persona

Who she is and how she talks live in `data/persona.md`. **Settings → Persona** edits it online, and **the next message picks up the change**.

- Start by copying [`../examples/persona.md`](../examples/persona.md) to `data/persona.md`, then make it yours.
- The more concrete the persona, the more stable she feels. Include identity and backstory, speech habits (pet phrases, sentence length, emoji use), her relationship to the user, and sensitive topics. The example file has writing notes.
- "About him" (what she knows about you) lives in `data/core.md`; it grows as you chat. See [`../examples/core.example.md`](../examples/core.example.md) for a template.
- "About herself" defaults to a built-in text. To override it, create `data/core-self.md` (see [`../examples/core-self.example.md`](../examples/core-self.example.md)). It is independent of the user and ensures she is herself first.

## 6. Connect a chat channel (optional)

Without a channel, she only talks in the web page. To let her talk to you on Telegram / QQ / WeChat / etc., open **Settings → Chat channels** and fill in the credentials:

- **Telegram**: no public URL needed. Provide a bot token and your chat ID. The full flow (creating a bot with BotFather, getting your chat ID, testing) is in [channels.md](./channels.md) §3.
- **Webhook (self-built relay)**: for QQ / WeChat / Feishu / Discord and more; you run a small relay service. Payload and signature rules are in [channels.md](./channels.md) §4, and a field template is [`../examples/channels.example.json`](../examples/channels.example.json).

Press "Send test message" in the settings page — if the channel receives a "Are you there?", it works.

## 7. Run in the background

### Windows (lin.ps1)

The repo ships with `lin.ps1`, which already handles supervision:

```powershell
.\lin.ps1 -Install    # Register the "Lin" scheduled task (starts -Watch at logon) and start now
.\lin.ps1 -Restart    # Restart after code changes
.\lin.ps1 -Open       # Open the browser with the token
.\lin.ps1 -Stop       # Stop the watchdog
.\lin.ps1 -Uninstall  # Remove the scheduled task
```

In `-Watch` mode the service is restarted within 10 seconds if it crashes, and logs go to `data\logs\` (`server.log`, `server.err.log`, `watchdog.log`). `lin.ps1` is UTF-8 with BOM, run it directly. `-Pack` builds a zip without `data\secrets` or `data\logs`, for migration.

### macOS (launchd)

Create `~/Library/LaunchAgents/com.realnetizen.plist`:

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

Replace `/usr/local/bin/node` with the output of `which node`, and fix the paths. Load it:

```bash
launchctl load -w ~/Library/LaunchAgents/com.realnetizen.plist
launchctl unload -w ~/Library/LaunchAgents/com.realnetizen.plist   # to stop
```

### Linux (systemd --user)

Create `~/.config/systemd/user/real-netizen.service`:

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
loginctl enable-linger $USER   # only if it should run after logout
systemctl --user status real-netizen
```

## 8. Data, backup and migration

Everything lives in `data/`, and **nothing is uploaded**. To move to a new machine, copy that folder and point at it with `--data`.

```powershell
node src/main.js --data D:\backup\real-netizen-data
```

- See [data-and-migration.md](./data-and-migration.md) (Chinese) for the full data file table and rehearsal steps.
- Back up `data/secrets/` (model keys and channel credentials); `data/logs/` can be skipped.
- `data/secrets/` and `data/logs/` are excluded from Git by `.gitignore`. Missing `data/` is recreated on first launch.

## 9. FAQ

**Q: The web page will not open?**
Check the terminal for the `She is here` link. Make sure you use `http://` (not https). With `--host 127.0.0.1` your phone cannot connect — use the default `0.0.0.0`. Allow the port through your firewall. A wrong token blocks access; delete `data/secrets/access-token.txt` and restart to generate a fresh one, then reopen the new link.

**Q: The model returns 401/403?**
Wrong API key or endpoint. For Anthropic, choose "Anthropic Messages" and `https://api.anthropic.com`; for OpenAI-compatible relays, choose "OpenAI compatible" and give the full endpoint including `/v1`.

**Q: She does not reply, or replies oddly?**
Check `data/logs/server.log`. In `--dry` mode channel messages are not sent, but the web chat still works. If the model is unconfigured she stays silent — the settings page tells you. Persona changes take effect on the next message; no restart needed.

**Q: How do I update?**
`git pull` (or overwrite with a fresh ZIP — `data/` is not affected because it is git-ignored). After code changes, run `lin.ps1 -Restart`. Back up `data/` before updating to be safe.

**Q: How do I shut her down completely?**
Windows: `.\lin.ps1 -Stop` then `.\lin.ps1 -Uninstall`. macOS/Linux: `launchctl unload` / `systemctl --user disable --now`. In the foreground, press Ctrl+C.
