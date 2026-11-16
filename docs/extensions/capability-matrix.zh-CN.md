# 能力矩阵：四个新增来源对照飞书与 GitHub

> 语言：[中文](capability-matrix.zh-CN.md) · [English](capability-matrix.md)

关于「对齐」意味着什么的参照。飞书与 GitHub 是上游 superagent 自带的两个来源；另外四个是本 bundle 新增的。✅ 具备 · ➖ 该平台不适用 · ❌ 后端不可能（如实说明，绝不伪造）。

| 能力 | 飞书（官方） | GitHub（官方） | 微信 | 企业微信 | 钉钉 | 云效 Projex |
| --- | --- | --- | --- | --- | --- | --- |
| 接收消息 | ✅ 轮询历史 + 事件 | ✅ 轮询通知 | ✅ sidecar 轮询 | ✅ 签名回调（插件挂载 `/wecom/<instance>`） | ✅ 流（需注入 `connect`；未随附 SDK） | ✅ 轮询工作项/评论 |
| 评估 / 判定 / 执行 / 回复循环 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 结构化 `@` 判定 | ✅ open_id | ➖ | ✅ `ats`（markup 回退，强度见 facts） | ✅ `mentionsAgent` | ✅ `ats` staffId | ➖ |
| 单聊 | ✅ | ➖ | ✅ | ✅ | ✅ | ➖ |
| 出站文本 | ✅ markdown | ✅ 评论 | ✅ + 回复时 @ 回去 | ✅ 纯文本 2048 | ✅ markdown 5000 | ✅ RICHTEXT/Markdown 评论 |
| 出站文件 | ➖（CLI） | ➖ | ✅ `sendFiles` | ❌ API 仅文本 | ➖（webhook） | ✅ 附件 |
| 幂等发送 | ✅ 带键 | ✅ 标记 | ✅ 带键 | ❌ 无（已说明） | ❌ 无（已说明） | ✅ 标记 |
| 供评估使用的线程上下文 | ✅ thread/root/parent | ✅ PR/issue | ✅ thread/parent；`root`→`no_root` | ✅ thread；`root`/`parent`→`no_*` | ✅ thread；`root`/`parent`→`no_*` | ✅ 工作项正文 + 评论 |
| worker 读取原文 | ✅ `feishu/<t>/…` | ✅ `github/<t>/…` | ✅ `weixin/<t>/…` | ✅ `wecom/<t>/message` | ✅ `dingtalk/<t>/message` | ✅ `projex/<t>/item`、`/comments` |
| 供评估使用的入站图片 | ✅ | ➖ | ✅ `[image:<id>]`、`/media` | ✅ `MediaId`、`/cgi-bin/media/get` | ➖（文本流） | ✅ 工作项/评论图片已归档 |
| 面板检索 | ✅ 消息 id | ✅ issue/PR 编号 | ✅ 原生 id | ✅ 十进制 `MsgId` | ✅ `msgId` | ✅ 流水号或页面 URL |
| 回复→父消息映射 | ✅ | ✅ | ✅（引用 id） | ➖ 回调不带引用 | ➖ | ➖ |
| 显示名刷新 | ✅ 会话名 | ✅ 仓库名 | ✅ 房间/成员 | ✅ 部门用户（`refreshLabels`） | ❌ 需要通讯录权限 API，未提供 | ✅ 状态词表 |
| 成员/名册同步进策略 | ✅ 会话成员 | ✅ 协作者 | ✅ 群成员 | ❌ 群成员不可读；用户列表只填名字 | ❌ 同上 | ✅ 项目成员 |
| 健康条目 | `feishu` + `history` | `github` | `weixin` | `wecom` | `dingtalk` | `projex` |
| 历史回填 | ✅ 会话历史 | ✅ 通知 | ✅ 重挂后追赶（标记 `historical`） | ❌ 仅回调 | ❌ 仅流 | ✅ 首见评论 |
| 消息深链 | ✅ AppLink | ✅ issue/PR URL | ❌ | ❌ | ❌ | ✅ 工作项页面 |
| 多实例 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## 微信两个 profile（personal / team）+ 可选非默认 wxauto

上表的「微信」列描述微信来源的通用能力面。实际发布为**两个 profile**（`profile` 字段），默认 `personal`；`wxauto-bridge`（`pc-uia` / wxautox4）与 `gate-guard` 是**非默认、不随包发布**的可选外部后端，仅在最后一列作对照（✅ 具备 · ⚠️ 有条件 · ❌ 不具备 / 不适用）。

| 能力 | `personal`（**默认**）= `weixin-ilink-bridge`（ilink） | `team` = `weixin-db-bridge`（pc-db / wechatauto-replica） | （可选，不随包发布）`wxauto-bridge`（pc-uia / wxautox4） |
| --- | --- | --- | --- |
| OS / 费用 | **任意 OS（无需桌面微信）**；**免费**（官方 iLink） | 仅 Windows（微信 **4.1.12+**）；**免费**（Apache-2.0） | 仅 Windows；**需 wxautox4 商业授权** |
| 群 / 私聊 | ⚠️ **仅单聊**（无群、无群成员表、无 @） | ✅ 群 + 私聊（DB 读库触发群消息） | ✅ 群 + 私聊 |
| 入站结构化 `@` | ❌ `none` | ❌ `none`（`ats` 恒空，靠 Policy/关键词准入） | ⚠️ `markup`（客户端标记，可伪造） |
| 群成员名册 | ⚠️ `observed`（仅对端） | ✅ `full`（全量名册） | ⚠️ `observed`（只见发过言的人） |
| 历史回填 | ❌ 仅实时 | ✅ 全量 DB 历史、可分页 | ⚠️ UI 滚动补读 |
| 入站图片 / 媒体 | ✅ CDN + AES 解密 | ✅ `MediaDownloader` 可用时 | ✅ 取决于构建 `download()` |
| 出站发送 | ✅ 文本（回传 `context_token`），keyed 幂等 | ✅ 文本 / 文件 / 群 @（需 `--profile team`；走 `wechatauto` UIA/OCR）；默认只读 `501` | ✅ 文本/文件/语音/@ |
| 语音 / 朋友圈 / 好友 / 建群 | ➖（单聊助手） | ❌ **均不支持**（voice/Moments/friend/create-group 未接入，不声称） | ✅ 取决于构建 |
| 收消息 / 触发 | 长轮询 `getUpdates` | DB 读库触发（Node 轮询 `/messages`；`/listen` 不抢 UI） | 监听回调（抢桌面界面） |
| 4.1.12.55 | ✅ 与客户端版本无关 | ✅ DB 只读全通、可上生产；发送需完整 UIA | ⚠️ 冷启动 gate=0 attach 失败，需热激活+授权+复测 |

**4.1.12.55 结论**：该版把微信 4.x 的 Qt 无障碍 gate 默认关掉（`mmui` 树冷启动不物化）。`wechatauto` 自带热激活，故 **`team`（replica）的 DB 只读在 4.1.12.55 全通、可上生产**，其 `--profile team` 发送走 UIA/OCR；`personal`（iLink）不受客户端版本影响；`wxautox4` 无热激活，冷启动 attach 失败，故不作为发布后端（详见 `docs/research/compat-4.1.12.55.md`）。启动、互斥与版本要求见 `sidecar/README.md`。

### 选一个 profile、它的默认值，以及桥地址

- **任选其一即可**：一张来源卡片跑 `personal` **或** `team`，单跑其一就能用微信通道，从不两个同时跑。
- **默认值随 profile**：`baseUrl` 默认 `personal` = `http://127.0.0.1:9300`、`team` = `http://127.0.0.1:8788`；`timeoutSeconds` 默认 180 秒（`team` 的发送走桌面 UI，较慢）；`pollSeconds` 默认 5 秒。多数参数不用手填，且都能改。
- **`team` 有版本按钮**：选中 `team` 会出现 **安装指定版本微信(4.1.12.55)** 按钮，点击在浏览器打开 <https://github.com/Rodert/wechat-win-versions/releases/tag/v4.1.12.55>。
- **端口占用有兜底**：所选端口被占用且占用者不是本桥时，sidecar 会用系统分配的空闲端口启动；面板只读的 **当前桥地址** fact 显示实际生效的 `http://127.0.0.1:<端口>`，无需手改端口。
- **停用字段已移除**：`autoReplies`、`acknowledge`、`ackText`、`progressAfterSeconds` 不再在卡片上渲染。schema 保留它们的旧默认值以便旧配置仍能解析，但它们不是可用配置。

## 平台限制，以及为什么它们不是 bug

- 微信、企业微信与钉钉**没有深链**：三者都不暴露按消息的 URL；面板只报出来源。
- 企业微信与钉钉**没有历史**：两者都以推送方式投递（回调 / 流），且不提供回读端点，所以没有回填、也没有 `/thread` 分页。微信通过它的 sidecar 读取历史；飞书通过历史 API；Projex 通过工作项 API。
- **钉钉传输**：WebSocket 客户端是 `dingtalk-stream` SDK，本 bundle 有意不内置它。部署时注入 `connect()`（见 `src/sources/dingtalk-watch.ts`）；没有它，kind 会被注册但没有任何东西在监听，健康状态会说明这一点。流下游的一切（触发、ThreadContext、worker 读取、回复、策略）都已对齐。
- **企业微信 / 钉钉成员同步**：自建应用无法枚举一个会话的成员；企业微信从它被允许读取的一个部门填充策略里的*名字*，而两者都拒绝把一份可见用户列表当作会话名册。
- **企业微信 / 钉钉 / 微信图片**：微信与企业微信投递图片时带一个部署方可下载的媒体 id；钉钉的流事件携带文本，所以不声称有图片。

## 本轮新增了什么

1. `projex/<trigger-id>/item` 与 `/comments` 的 worker 读取（`src/sources/work/projex/read.ts`），带分页，且 agent 自己的评论被标记为 `bot`。
2. `dingtalk/<trigger-id>/message` 的 worker 读取与一个钉钉 ThreadContext（`thread` = 那一条消息，`no_root`、`no_parent`）——`src/sources/chat/dingtalk/{read,kind}.ts`。
3. 企业微信在通讯录用户列表上的 `refreshLabels`，外加一个 `departmentId` 设置，于是策略的行能显示名字。
4. 一个 `dsh-superagent-dingtalk` 技能，且 Projex 技能现在点名它的两个资源。
5. 测试：`tests/projex-read.spec.ts`、`tests/dingtalk-read.spec.ts`，外加既有的企业微信/微信/Projex 套件。
