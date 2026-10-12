# 快速开始

> 本文由私有版本清洗而来；示例均为虚构。三分钟后她就能在你的浏览器里开口说话。

## 1. 安装 Node.js

真实网友零第三方依赖，但需要 **Node.js 22 或更高版本**（`node --test` 在 22/24 下验证过）。

```powershell
node --version   # 建议 v22.x 或 v24.x LTS
```

- Windows：从 [nodejs.org](https://nodejs.org) 下载 LTS 安装包。装完重新打开 PowerShell。
- macOS：`brew install node@22`。
- Linux：用发行版包管理器或 [nvm](https://github.com/nvm-sh/nvm) `nvm install 22`。

## 2. 获取代码

```powershell
git clone https://github.com/xiaoanran0602-pixel/real-netizen.git
cd real-netizen
```

没有 Git 也可以在 GitHub 页面点 **Code → Download ZIP**，解压后 `cd` 进目录。仓库里没有 `data/`（里面有 `.gitkeep` 占位），第一次启动时程序会自动建好目录结构。

## 3. 启动

```powershell
node src/main.js
```

启动后终端会打印：

```text
  她在这里：http://127.0.0.1:3030/?token=xxxxxxxx
  手机（同一网络）：http://192.168.x.x:3030/?token=xxxxxxxx
  数据目录：C:\...\real-netizen\data
```

按住 Ctrl 点击 `她在这里` 那行链接（带令牌），浏览器就打开了。**令牌是访问网页的唯一凭据**，存在 `data/secrets/access-token.txt`，第一次启动自动生成。局域网监听（`0.0.0.0`）必须有令牌；只想本机用可以加 `--host 127.0.0.1`。

### 常用启动参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port <n>` | `3030` | 端口 |
| `--host <addr>` | `0.0.0.0` | `127.0.0.1` 只本机，`0.0.0.0` 局域网可访问 |
| `--data <目录>` | `./data` | 用数据副本演练时换目录 |
| `--dry` | 关 | 不跑后台调度、不向任何渠道发消息（调试用） |
| `--channel-api-host <url>` | `https://api.telegram.org` | 把 Telegram 基址指到假服务器 |
| `--debug` | 关 | 打开调试日志 |

端口被占时会以退出码 2 退出，并提示占用者。

## 4. 模型设置

网页打开后，如果还没配模型，顶部会有提示。点 **设置 → 模型**，按下表填：

| 服务商 | 协议 | 接口地址 | 聊天模型（示例） | API Key |
| --- | --- | --- | --- | --- |
| OpenAI | OpenAI 兼容 | `https://api.openai.com` | `gpt-5` | 官网申请 |
| Anthropic | Anthropic Messages | `https://api.anthropic.com` | `claude-sonnet-4-6` | 官网申请 |
| DeepSeek | OpenAI 兼容 | `https://api.deepseek.com` | `deepseek-chat` | 官网申请 |
| OpenRouter | OpenAI 兼容 | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4-6` | 官网申请 |
| Ollama（本地） | OpenAI 兼容 | `http://127.0.0.1:11434/v1` | `qwen3:8b` | 留空 |

- **接口地址**：带不带 `/v1` 都可以，程序会自己拼路径。
- **API Key**：只保存在你电脑的 `data/secrets/model.json`，设置页上永远只显示末 4 位，留空表示不改。
- **后台模型**：记忆整理、日程、朋友圈等后台任务用；留空就用聊天模型，失败会退回聊天模型重试一次。
- **生图模型**：OpenAI Images 兼容的模型名，留空默认 `gpt-image-1`。关掉「允许她生成图片」后，换头像、朋友圈配图、主动发图都会跳过，朋友圈改发纯文字。

> 也可以直接看示例文件 [`../examples/settings.example.json`](../examples/settings.example.json) 里的字段形状。

## 5. 写人设

她是谁、怎么说话，全在 `data/persona.md`。设置页 → 人设可以在线编辑，**保存后下一句话立刻生效**。

- 起步可以复制 [`../examples/persona.md`](../examples/persona.md) 到 `data/persona.md`，再改成你想要的样子。
- 人设写得越具体，她越稳定。建议包含：身份与经历、说话习惯（口头禅、句长、会不会用 emoji）、和用户的关系、哪些话题敏感。详细写法见该示例文件的注释。
- 「关于他」（她对你的了解）在 `data/core.md`，可写可不写，边聊边长。结构模板见 [`../examples/core.example.md`](../examples/core.example.md)。
- 「关于她自己」的基石默认内置，如果你想覆盖，新建 `data/core-self.md`（参考 [`../examples/core-self.example.md`](../examples/core-self.example.md)）。它和用户无关，保证她首先是她自己。

## 6. 接聊天渠道（可选）

不接渠道时，她只在网页里陪你。想让她在 Telegram / QQ / 微信等地方陪你，到 **设置 → 聊天渠道** 里启用并填凭据：

- **Telegram**：不需要公网地址，填 Bot Token 和你的 Chat ID 即可。全流程（BotFather 建机器人、拿 Chat ID、测试）见 [`channels.md`](./channels.md) 第 3 节。
- **Webhook（自建中转）**：适合 QQ / 微信 / 飞书 / Discord 等，需要一个小中转服务。payload 与签名规范见 [`channels.md`](./channels.md) 第 4 节，字段模板见 [`../examples/channels.example.json`](../examples/channels.example.json)。

点设置页里的「发送测试消息」，对应渠道收到一条「在吗」就说明通了。

## 7. 后台常驻

### Windows（lin.ps1）

仓库自带 `lin.ps1`，已经写好守护逻辑：

```powershell
.\lin.ps1 -Install    # 注册计划任务「Lin」（登录时自动以 -Watch 启动），并立即启动
.\lin.ps1 -Restart    # 改完代码后重启服务
.\lin.ps1 -Open       # 带令牌打开浏览器
.\lin.ps1 -Stop       # 停掉守护
.\lin.ps1 -Uninstall  # 移除计划任务
```

`-Watch` 模式下服务崩了会在 10 秒内被拉起，日志写到 `data\logs\`（`server.log`、`server.err.log`、`watchdog.log`）。`lin.ps1` 是 UTF-8 带 BOM 的，直接执行即可。`-Pack` 可以打一个不含 `data\secrets` 和 `data\logs` 的 zip 包用于迁移。

### macOS（launchd）

新建 `~/Library/LaunchAgents/com.realnetizen.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.realnetizen</string>
  <key>WorkingDirectory</key><string>/你的路径/real-netizen</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>src/main.js</string>
    <string>--host</string><string>0.0.0.0</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/你的路径/real-netizen/data/logs/server.log</string>
  <key>StandardErrorPath</key><string>/你的路径/real-netizen/data/logs/server.err.log</string>
</dict>
</plist>
```

把 `/usr/local/bin/node` 换成 `which node` 的结果，路径改成实际路径。加载：

```bash
launchctl load -w ~/Library/LaunchAgents/com.realnetizen.plist
launchctl unload -w ~/Library/LaunchAgents/com.realnetizen.plist   # 停止
```

### Linux（systemd --user）

新建 `~/.config/systemd/user/real-netizen.service`：

```ini
[Unit]
Description=Real Netizen
After=network.target

[Service]
Type=simple
WorkingDirectory=/你的路径/real-netizen
ExecStart=/usr/bin/node src/main.js --host 0.0.0.0
Restart=on-failure
RestartSec=10
StandardOutput=append:/你的路径/real-netizen/data/logs/server.log
StandardError=append:/你的路径/real-netizen/data/logs/server.err.log

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now real-netizen
loginctl enable-linger $USER   # 希望注销后仍运行时执行一次
systemctl --user status real-netizen
```

## 8. 数据、备份与迁移

所有数据都在 `data/`，**不上传任何云**。换电脑时把这个目录整个拷走，再用 `--data` 指过去即可。

```powershell
# 在新电脑上用旧数据启动
node src/main.js --data D:\backup\real-netizen-data
```

- 完整的数据文件表、迁移演练步骤见 [`data-and-migration.md`](./data-and-migration.md)。
- 备份时**别忘了 `data/secrets/`**（模型 Key 和渠道凭据）；`data/logs/` 可以不备份。
- `data/secrets/` 和 `data/logs/` 默认不进 Git（`.gitignore` 已处理）。第一次启动若没有 `data/`，程序会自动建目录。

## 9. FAQ

**Q：启动后网页打不开？**
先看终端有没有打印 `她在这里` 的链接。打不开时检查：地址是不是 `http://`（不是 https）；如果加了 `--host 127.0.0.1`，手机就不能访问，要用默认的 `0.0.0.0`；防火墙放行对应端口。令牌错了会进不去，删 `data/secrets/access-token.txt` 重启会生成新的（网页需重新用新链接打开）。

**Q：模型报 401/403？**
API Key 或接口地址填错。Anthropic 协议要选「Anthropic Messages」，地址填 `https://api.anthropic.com`；OpenAI 兼容的第三方站要选「OpenAI 兼容」并把地址填全（含 `/v1`）。

**Q：她不回消息 / 回答很怪？**
先看 `data/logs/server.log`。`--dry` 模式下渠道不会真的发消息，但网页照常。模型没配好时她不会说话，设置页会提示。改了人设后下一句就生效，不用重启。

**Q：怎么更新版本？**
`git pull`（或下载新 zip 覆盖，`data/` 不会被覆盖，因为 `.gitignore` 排除了数据目录）。改了代码后 `lin.ps1 -Restart` 一下。更新前备份 `data/` 更稳。

**Q：怎么彻底关掉她？**
Windows：`.\lin.ps1 -Stop` 再 `.\lin.ps1 -Uninstall`。macOS/Linux：`launchctl unload` / `systemctl --user disable --now`。前台运行时按 Ctrl+C。
