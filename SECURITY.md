# 安全策略

## 本地密钥与令牌

真实网友把所有敏感信息只保存在你**本地电脑**的 `data/secrets/` 下，**不上传任何云**：

| 文件 | 内容 | 说明 |
| --- | --- | --- |
| `model.json` | 模型接口地址与 API Key | 设置页只显示 Key 的末 4 位，留空 = 不改 |
| `channels.json` | 渠道凭据（Telegram Bot Token、Webhook secret 等） | 同上，secret 字段只显示末 4 位 |
| `access-token.txt` | 网页访问令牌 | 启动时自动生成，局域网监听必须有它 |

这些目录已被 `.gitignore` 排除（`data/secrets/`、`data/logs/`），正常情况下 `git status` 看不到它们。但如果你从别人的电脑上拷贝数据、或者用 `.zip` 迁移，**不要把 `data/secrets/` 传到公开的地方**（群聊、网盘外链、Issue 附件）。分享截图前请确认设置页没有露出完整 Key 或令牌。

你可以在 `data/secrets/` 里看到这些文件的明文。这意味着：**能登录你这台电脑的人就能看到它们**。请像保护其他密码一样保护你的电脑账户。如果怀疑 Key 泄露，直接去对应平台换一个新 Key 即可（Webhook secret 同理，换一个随机长串）。

## 网络暴露面

服务默认监听 `0.0.0.0`（局域网可访问），但**没有令牌就进不了网页**。如果你把端口通过反向代理或内网穿透暴露到公网：

- 务必使用强令牌（自动生成的 24 字节已足够），并用 HTTPS 包一层。
- Webhook 入站口 `/api/lin/channels/webhook` **不走令牌**，靠 HMAC-SHA256 签名防伪；一旦暴露公网，它就是唯一的公开口。请把 Webhook `secret` 设得足够长且随机，并限制中转服务的来源 IP（如果平台支持）。
- 其他管理接口（`/api/lin/*`）必须带令牌，不要把它们暴露到公网。

## 支持的版本

目前只有最新的 `v0.x` 主线版本接收安全修复。没有向后移植的资源，请尽量使用最新 Release。

## 报告安全漏洞

**请不要开公开的 GitHub Issue。** 请通过 GitHub 的 [Security Advisories](https://github.com/xiaoanran0602-pixel/real-netizen/security/advisories/new) 私下报告（需要 GitHub 账号）。

报告时请尽量包含：

- 漏洞类型（如：令牌绕过、签名可伪造、路径穿越、信息泄露）。
- 复现步骤（最好有最小请求示例）。
- 影响范围：是否需要公网暴露、是否需要已拿到局域网访问。

我们会在 **72 小时内**确认收到，并在修复后公开致谢（除非你希望匿名）。如果 72 小时内没有收到确认，请在 Advisories 里追加一条消息。
