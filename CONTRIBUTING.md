# 贡献指南

感谢你愿意为真实网友（Real Netizen）做贡献。本指南分三段：**开发环境**、**质量门槛**、**贡献流程**（含新渠道和翻译）。

## 一、开发环境

- 你需要 **Node.js 22+**（推荐 22 或 24 LTS）。本项目零第三方依赖，无需 `npm install`（`package.json` 里没有 dependencies）。
- 克隆后直接可跑：

```powershell
git clone https://github.com/xiaoanran0602-pixel/real-netizen.git
cd real-netizen
node src/main.js          # 启动
node --test test/         # 跑测试
```

- 启动后终端会打印带令牌的链接。`--dry` 模式不发渠道消息、不跑后台，适合调试。改了代码用 `lin.ps1 -Restart` 重启（Windows）；其他平台用 `node src/main.js` 前台或你自己的守护进程。
- 编辑器：仓库根有 `.editorconfig`（utf-8、lf、2 空格；`*.ps1` 保留 BOM）。请保持它声明的风格。`lin.ps1` 是 UTF-8 带 BOM 的，改它请保持 BOM，否则中文/日文会乱码。

## 二、质量门槛

在提 PR 前，请确认：

1. **`npm test`（即 `node --test test/`）全部通过。** 目前 220+ 用例，覆盖模型协议、记忆、内心、渠道、归档等。
2. **单文件不超过 400 行。** 这是硬限制，`test/privacy.test.js` 会检查 `src/`、`web/`、`test/` 下的源文件。如果一个文件快到 400 行，把它拆成更小的模块（这通常也是更好的设计）。
3. **隐私禁词测试通过。** `test/privacy.test.js` 会扫描全仓文本文件和文件名，确保没有作者的隐私信息（旧仓库名、真实姓名、账号、内部网关名等）。写文档或示例时，**所有示例一律虚构**。如果必须提到某个概念，不要带真实的个人或内部系统名字。
4. **不引入 `data/`。** `data/secrets/` 和 `data/logs/` 已被 `.gitignore` 排除。PR 里不应该出现任何真实数据文件。示例文件放 `examples/`（保证虚构）。
5. **零依赖原则。** 不要添加第三方 npm 包或 CDN。如果必须加，先在 Issue 里讨论。

## 三、贡献流程

### 提交信息约定

使用 [Conventional Commits](https://www.conventionalcommits.org/) 的简化版：

```
<type>: <subject>

[可选 body]
```

`type` 取值：

- `feat`: 新功能（新渠道、新设置项）
- `fix`: 修 bug
- `docs`: 文档（`README`、`docs/`、注释）
- `refactor`: 重构（不改行为）
- `test`: 加测试或改测试
- `chore`: 构建/CI/杂务

`subject` 用中文或英文都可以，祈使语气，不加句号，70 字以内。例如：

```
feat: telegram 渠道支持发送贴纸
fix: 修复日结时区偏移一天
docs: 补充 channels.md 的 Python 示例
test: 覆盖 webhook 时间戳窗口边界
```

### PR 流程

1. 从 `main` 开分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
2. 做改动，跑通 `node --test test/`。
3. 推分支，开 PR。PR 模板里的四项勾选请如实填写（已跑测试、未提交 data/、未引入个人信息、文档已同步三语）。
4. 维护者会审。可能来回几轮。合并后你的名字会出现在 Release Notes 里。

### 贡献一个新渠道

这是最受欢迎的贡献方向。步骤：

1. 先开一个 Issue，用 `channel_proposal` 模板介绍你想接的平台（官方 API 是否支持长轮询/ webhook、是否需要公网等）。
2. 新建 `src/channels/<id>/` 目录，实现 `Channel` 契约（见 `src/channels/types.js` 和 [docs/zh/channels.md](./docs/zh/channels.md) 第 2 节）。至少：`id`、`label`、`ownerKey`、`fields`、`isReady`、`start`（尽快返回）、`stop`、`sendText`，图片平台实现 `sendImage`。
3. 在 `src/channels/registry.js` 的 `CHANNELS` 里登记一行；在 `src/config/secrets.js` 的 `CHANNEL_FIELDS` 里登记该渠道的 `required` 与 `secret` 字段。
4. 在 `test/channels.test.js` 里加测试：假服务器或 `--channel-api-host`，覆盖收消息 → 她回复 → 分段发出 → 写进对话、只理主人、重试/限流。
5. 在 [docs/zh/channels.md](./docs/zh/channels.md) 末尾补一段该平台的接入提示（中英日三语都要有，可以先写中文，再补英文和日文，或在 PR 里说明需要翻译帮助）。
6. 更新 `README` 的渠道列表（如果需要）。

### 贡献翻译（i18n）

- 深度文档目前只有中文（`docs/zh/`）。英文和日文只有入门/架构/渠道三篇，且部分段落从中文版同步即可。
- 请建 PR，把 `docs/zh/` 的某篇译成 `docs/en/` 或 `docs/ja/` 的对应文件，保持章节结构一一对应（链接和代码块一致）。
- 术语请参考 `docs/en/architecture.md` 末尾的术语表（glossary）。
- 机翻堆砌会被打回；请像写给该语言的开发者那样自然地写。翻译类 PR 请打上 `i18n` 标签。

## 行为准则

本仓库采用 [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md)，请尊重每一位贡献者。

## 安全

发现安全问题（令牌泄露、密钥处理缺陷）请不要开公开 Issue，见 [SECURITY.md](./SECURITY.md)。
