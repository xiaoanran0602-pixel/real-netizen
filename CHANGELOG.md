# 更新日志（Changelog）

本项目的所有重要变更都会记录在这个文件里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [v0.2.0] - 2026-10-14 — 一副身体，三种时间尺度；她终于有「此刻」

把主程序自 v0.1.0 以来的两波大更新移过来：合并两套内心引擎、加上情境与语域，并重新做了一遍开源清洗（去个人化 / 去公司化、保留渠道抽象、单文件 ≤400 行、测试全绿）。

### 新增
- 情境系统（`src/inner/situation.js`）：日程时段换算成她此刻在哪、手上的活、手机和她的关系，写进提示词「此刻」，说话方式是处境的副产品而不是规则。
- 碰巧发生的小事（`src/inner/perturbation.js`）：被叫走 / 手上的事告一段落 / 身边的动静，每条消息掷一次；被叫走时这一条只回一句，段数上限取处境与身体更紧的那个。
- 聊天状态机（`src/inner/conversation.js`）：五种状态 + 八种语域，带惯性，晚到的判断只改状态不改已发的回复；状态落在 `data/conversation-state.json`，不进回档。
- 可选的决策模型（`src/model/systemone.js`）：设置里填一个 `/v1/systemone` 兼容端点与模型名，用来判断聊天状态与回应需求；默认关闭，没配 / 不通时退回启发式，不阻塞回复。
- 确定性话轮规划（`src/companion/reply-plan.js`）：回应前先算好回应范围、段数与字数参考、追问许可；生成后语义检查，不合范围最多重生一次。网页先显示「正在输入」再整段给出。
- 调试面板（设置 → 她的内心）显示她的处境、这段聊天的状态和判断来源。

### 变更
- 合并两套内心引擎为一副身体：快层愉悦 / 激活、中层精力 / 张力、慢层自我感觉 / 写书 / 被看见；想念、饱腹、防线改为实时派生（`src/inner/derive.js`），不再存储。旧 `inner.json` 首次启动自动迁移到 `body-v2` 并备份 `inner.legacy-backup.json`。
- 表达出口唯一（`src/inner/express.js`）：状态提示、段数上限、回复延迟、主动放行、念头注意预算全部从同一份快照算出，提示词只注入一节「# 你现在的状态」。
- 提示词写法：人设改用 `data/profile.md`（内置平实默认，可覆盖，见 `examples/profile.example.md`）；背景文字只写第三人称事实，不写她该怎么说话；记忆与周总结改平实写法；回复去掉「林澈：」前缀；底线四条与收尾两句。
- 「她在哪里」读日程标签；日程读不到就不写处境，不编。

### 移除
- 废弃 `vitals.js`、惰性结算 `settle/settleNow`、`innerEngineMode` 切换开关与旧版 shadow 模式；表达出口不再有第二套状态源。

<details>
<summary>English summary</summary>

### Added
- Situation system: turns the current schedule slot into where she is, what she is doing, and how reachable her phone is, written into the "now" section of the prompt.
- Perturbations: small chance events (called away, a task wrapping up, nearby noise) that can shorten a reply to a single line.
- Chat state machine with five states and eight registers, with inertia; late judgments only correct the stored state, not already-sent replies.
- Optional decision model endpoint (`src/model/systemone.js`, default off) for chat state and response needs, with heuristic fallback.
- Deterministic reply planning (`src/companion/reply-plan.js`): scope, segment/length budget and follow-up permission decided before generation, plus a post-generation semantic check with at most one rewrite.
- Debug panel (Settings → Her Inner World) showing situation, chat state and judgment source.

### Changed
- Merged the two inner engines into one body: fast valence/activation, load energy/tension, slow self-feeling/writing/being-seen; missing/fullness/defenses are now derived in real time. Old `inner.json` auto-migrates to `body-v2` with a backup.
- Single expression outlet (`express.js`) computes status hints, segment caps, reply delay, proactive permission and thought attention budget from one snapshot.
- Prompt writing: persona from `data/profile.md` (neutral built-in default, overridable), third-person background text, plain memory writing, no leading speaker prefix, four guardrails and a two-line coda.

### Removed
- `vitals.js`, `settle/settleNow`, the `innerEngineMode` switch and the legacy shadow mode.

</details>

<details>
<summary>日本語サマリ</summary>

### 追加
- 状況システム：現在の予定から「どこにいて、何をしていて、携帯が手元か」を提示詞の「今」に書き込む。
- ささいな出来事：呼び出される / 作業が一段落する / 周囲の音など、メッセージごとに振り分け、呼び出されたときは一言だけ返す。
- チャット状態機：5 状態・8 語域、慣性付き。遅れて来た判断は保存される状態を直すだけで、送信済みの返信までは変えない。
- 任意の判断モデル（`src/model/systemone.js`、デフォルト無効）：チャット状態と返信の必要量を判断し、未設定や不通時はヒューリスティクスにフォールバック。
- 確定的な返信計画（`src/companion/reply-plan.js`）：生成前に範囲・段数・字数・追加質問の可否を決め、生成後に意味チェック、不適合なら最大 1 回再生成。
- デバッグパネル（設定 → 彼女の内面）で状況・チャット状態・判断ソースを表示。

### 変更
- 二つの内面エンジンを一つの身体に統合：速い層（快 / 活性）、負荷（精力 / 紧张）、遅い層（自己感覚 / 书き物 / 见られること）。惚れ、満腹、防线は实时导出に変更し保存しない。旧 inner.json は起动时 body-v2 へ自动移行しバックアップ。
- 表현の出口を一本化（`express.js`）：状态ヒント、段数上限、返信遅延、主动的な许可、念头の注意予算を同一スナップショットから算出。
- 提示詞：`data/profile.md`（中性的な内蔵既定、上書き可）から人設を読み、背景は三人称の事実のみ、記憶は平実に、返信の「林澈：」接頭辞を削除。

### 削除
- `vitals.js`、`settle/settleNow`、`innerEngineMode` 切り替えスイッチ、旧 shadow モード。

</details>

## [v0.1.0] - 2026-10-12 — 首个开源版本

真实网友从一个单人使用的私人实例中清洗而来，作为**零第三方依赖**的开源项目发布。这个版本是「能跑、能记、能接渠道」的最小完整形态。

### 新增
- 零依赖的 Node.js 22+ 服务 + 免构建单页网页聊天界面（SSE 流式输出，手机可用）。
- 多层记忆系统：召回、清晰度（清晰 / 模糊 / 沉底）、强度与遗忘曲线、日 / 周 / 月整理、写入守卫（过去不可改、今天只追加、未来可变）。
- 内心系统：四维内核（愉悦 / 激活 / 精力 / 张力）+ 念头池，每 5 秒推进，可选观察（shadow）或身体（body）模式。
- 她的动态：朋友圈、头像 / 签名更换、主动消息，用内置生图模型配图（生成失败则发纯文字）。
- 渠道抽象：Telegram（长轮询，无需公网地址）与 Webhook（自建中转），只回复主人，支持合批与分段发送。社区可按契约自行扩展渠道。
- 数据全在本地 `data/`，`lin.ps1` 守护脚本（Windows 计划任务，崩溃 10 秒内拉起）。
- 三语文档（中 / 英 / 日）与 GitHub 治理（CI、Issue / PR 模板、Contributor Covenant 行为准则、安全策略）。

### 变更
- 原私人实例中的人格化默认值全部改为中性默认值与虚构示例（人设、称谓、记忆、示例念头等）。
- 原专属机器人渠道替换为可扩展的渠道抽象（`src/channels/`），网页与渠道共用同一套对话与记忆。
- 模型网关中性化：支持 OpenAI 与 Anthropic 两种协议，地址和 Key 在设置页自填，可接任何兼容服务或本地 Ollama。

### 移除
- 所有作者个人信息、真实记忆与对话数据、内部网关地址与凭据。

## 史前（2026-10-09 ～ 2026-10-11）

> 这是项目还作为私人实例时的长程推进记录，去人名、去特定平台名后浓缩在此，作为 v0.1.0 的前身。

- 2026-10-09：作为独立程序开工（零第三方依赖的 Node 服务 + 免构建网页），数据目录固定为 `data/`，密钥只放在本机 `data/secrets/`。
- 2026-10-10：去编程化（发消息的请求体里没有工具，系统提示词是人设）；全局记忆目录、中文写入门槛、写入守卫；网页外壳；二维码、固定端口与令牌；PWA。
- 2026-10-10：「她的日子」设置（过去和今天的日程只读，零点后预生成当天日程）；她的动态（朋友圈、自己找图换头像 / 换签名 / 发圈，点赞评论会回复，随机间隔加事件触发）。
- 2026-10-10：接入聊天机器人（与网页共用一段对话和同一份记忆，只理主人，偶尔主动找他，头像和签名同步到机器人资料）；以计划任务常驻后台，挂了自动拉起。
- 2026-10-10：回档与遗忘（遗忘曲线、聊到加固、底色不沉底；日 / 周 / 月整理并存档，可回到任何一天）。
- 2026-10-10：活人感内核（日程带标签；五体征惰性结算，只给模型一两句话不给数字；不秒回，醒着最晚 30 分钟、生病 / 加班周 45 分钟；两条基石进稳定段；写书与「被看见」的张力和转折；生病 / 加班周 / 假期掷骰）。
- 2026-10-10：念头池与持续情绪内核（心里一池具体的念头每小时涨落，被碰到才可能主动找你或发圈；四维状态每 5 秒推进、聊天只是一次有上限的冲击；新内核默认只观察，设置里可切）。
- 2026-10-10：她的图改为自己「拍」（她写画面描述，程序补随手拍质感后用生图模型生成），不再联网搜图。
- 2026-10-11：媒体检索与共同作品推荐等后台能力；随后开始开源清洗与三语发布。
