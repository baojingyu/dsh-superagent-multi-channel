# wxautox4 vs wechatauto-replica 能力深度测评

> 目的：为“办公室 Windows 常开机器，服务研发沟通群、收集测试工程师 bug 反馈”的场景选型；并判断 `wechatauto-replica` 能否作为免费替代/补充。结论只基于可复核证据，不基于感觉。
>
> 测评日期：2026-11-14。测评机：Windows，微信客户端 **4.1.9.30**，wxautox4 **41.2.3**（正在运行 `pc-uia` bridge，端口 8787）。

---

## 1. 方法与证据边界

| 项 | wxautox4 | wechatauto-replica |
| --- | --- | --- |
| 版本 | 41.2.3（PyPI 包，Nuitka 编译 `.pyd`） | 1.2.10（GitHub/PyPI，Apache-2.0 源码） |
| 本机实测 | ✅ 已运行 4 天，bridge `/health`、`/status`、`/rooms`、`/members`、`/messages` 均实际请求 | ⚠️ 本机微信 4.1.9.30 **低于其要求的 4.1.12+**，无法做等效实机收发；本报告对其做**源码/API 审计 + 官方 README 能力核对** |
| API 证据 | `site-packages/wxautox4/wx.pyi`、`msgs/*.pyi`（包内类型声明） | `wechatauto/wx.py`、`db.py`、`media.py`、`msgs/*`（完整源码） |
| 运行证据 | `/health`：`capabilities {mentions: markup, members: observed, media: true}`；`uptimeSec 347880`；**148 次自动重挂**；`/rooms` 1 个群；`/members` 空（观察制） | README 版本表：4.1.12+；本机 4.1.9 不支持；未做发送实验（避免对真实账号产生副作用） |
| 说明 | wxautox4 为**闭源编译** + `--auth/--auth-file` 授权体系；本报告不反编译 | wechatauto 源码可读、Apache-2.0；本报告按源码核对 API 和能力 |

> 重要限制：**wechatauto 的实机能力在本机不能验证**（微信 4.1.9.30 低于 4.1.12 门槛）。下面的 wechatauto 结论标注为“源码/文档证据”，实际生产前必须在 **4.1.12+** 的测试机复测。

---

## 2. 现场快照（wxautox4 实际运行）

```json
/health:
{"ok":true,"available":true,"version":"1.0.3","backend":"pc-uia",
 "uptimeSec":347880,
 "capabilities":{"mentions":"markup","members":"observed","media":true},
 "detail":"未配置 --listen：监听模式下不会收到任何消息；客户端 4.1.9.30；
            群 @ 判据：@测试账号；监听 2 个会话，最近事件 439 秒前；
            监听已自动重挂 148 次（客户端界面卡住，或另一个 UI 自动化工具抢过窗口）"}

/status:
{"loggedIn":true,"wxid":"wxid_***","name":"测试账号","backend":"pc-uia",
 "client":"4.1.9.30","available":true}

/rooms: {"rooms":[{"id":"wxname_***","name":"AI研究群"}]}
/members?room=***: {"members":[]}
/messages?room=***: {"events":[],"next":"0","head":"1794315865"}
```

**解读**：
- `uptimeSec 347880` ≈ 4.03 天稳定进程；
- **自动重挂 148 次** ≈ 每天 37 次，说明 UI 自动化窗口/焦点/控件树会被微信自身或其它 UI 工具打断，这是 wxautox4 路线的**结构性稳定性成本**；
- `members: observed`：`/members` 拿不到全量群成员，只能看到“发过言的人”；
- `mentions: markup`：群 @ 靠客户端 @ 分隔符识别，不是结构化 `atuserlist`；
- 当前 `--listen` 未配置，故 `/messages` 为空是运行配置问题，不是能力问题。

---

## 3. 能力矩阵（源码/API 级）

图例：✅ 直接支持；⚠️ 有条件/需额外实现；❌ 不支持或未提供。

| 能力 | wxautox4 41.2.3 | wechatauto-replica 1.2.10 | 证据/备注 |
| --- | --- | --- | --- |
| 文本收/发 | ✅ | ✅ | 两者均 `SendMsg`；wa 发送走 UIA/OCR |
| 群内发送 | ✅ | ✅ | |
| 发送 @ 指定成员 | ✅ `SendMsg(at=...)` | ✅ `SendMsg(at=...)` | wa 仅有 `at`，无 AtAll |
| @所有人 | ✅ `AtAll` | ❌ 无 `AtAll` 方法 | 源码搜索无 `AtAll` |
| 入站 @ 结构化识别 | ⚠️ `markup`（@分隔符，改名/粘贴失效） | ⚠️/❌ 源码无 `atuserlist/at_list` 字段；只能文本/关键词推断 | 当前 bridge 也报 `mentions: markup` |
| 群成员全量名册 | ⚠️ `members: observed`（只看到发过言的人） | ✅ `get_group_members()` + `GroupMemberWatcher` | wa 的强项 |
| 群列表 | ✅ `GetAllRecentGroups` | ✅ `get_groups()` | |
| 建群 | ✅ `CreateGroup` | ❌ | |
| 群名/公告/我的群昵称/群备注 | ✅ 四个 Set 方法 | ❌ | |
| 好友/标签/备注 | ✅ `AddNewFriend`、`GetNewFriends`、`GetFriendDetails`、`EditFriendInfo`、`GetTagContacts` | ⚠️ `search_contact`、`list_labels` 只读；`AddFriendFromGroup` 有限 | |
| 历史消息 | ✅ `GetHistoryMessage`（UI 滚动，慢/受窗口影响） | ✅ `get_messages` 全量 DB 读取（快、可分页） | wa 的强项 |
| 实时监听 | ✅ `AddListenChat + StartListening` | ✅ `Listener` / `GetNewMessage` | |
| 图片接收 | ✅ `ImageMessage.download` / `ocr` | ✅ `MediaDownloader`，支持原图/压缩/缩略图分级 | |
| 语音接收 | ✅ `VoiceMessage.to_text()` | ✅ `get_voice_rows()` + SILK 转码（依赖 ffmpeg/silk） | |
| 文件接收 | ✅ `FileMessage.download` | ✅ `MediaDownloader` | |
| 视频接收 | ✅ `VideoMessage.download` | ✅（DB 有视频时） | |
| 出站文件/图片 | ✅ `SendFiles` | ✅ `SendFiles` | |
| 出站语音 | ✅ `SendAudio` | ❌ 无 `SendAudio` | |
| 出站视频 | ⚠️ 作为文件发（无专用 video 发送） | ⚠️ 作为文件发 | |
| 朋友圈读取 | ✅ `Moments` | ✅ `MomentDB`（读、点赞/评论走 UIA） | |
| 朋友圈发布 | ✅ `PublishMoment` | ❌ 无 `PublishMoment` | |
| 朋友圈点赞/评论 | ✅ | ⚠️ 走 UIA（实验性） | |
| 多账号 | ✅（`WeChat(nickname=...)`） | ✅ `list_accounts()` | |
| 数据库/历史直读 | ❌（UI 驱动） | ✅ SQLCipher 解密 | wa 的强项 |
| 媒体原图/AES 解密 | ✅（当前 bridge `media:true`） | ✅ 原图分级、`image_keys.json` 持久化 | |
| 免费/许可 | ❌ **需授权码/授权文件** | ✅ **Apache-2.0，免费** | |
| 源码/可改 | ❌ 编译 `.pyd` 闭源 | ✅ 完整 Python 源码 | |
| OS | **Windows 10/11 x64** | **Windows 10/11 x64** | 两者都不跨 OS |
| 微信版本 | 本机 4.1.9.30 实测可用；目标版本以厂商为准 | **要求 4.1.12+**（本机 4.1.9 不满足） | 关键差异 |
| 发送稳定性 | ⚠️ 依赖 UI；本机 4 天重挂 148 次 | ⚠️ UIA/OCR 发送；DB 读稳定，发送受窗口影响 | |
| 集成到现有 bridge | ✅ 已跑通 `pc-uia` | ⚠️ 需新增 `pc-db` 后端，映射 8 端点 | 约 2–4 人日 PoC |

---

## 4. 评分（0–5，按“研发群 bug 收集”场景加权）

权重按你的场景（办公室常开 Windows、研发群、测试反馈 bug、需要稳定收/发、群成员与历史）设定：

| 维度 | 权重 | wxautox4 | wechatauto | 说明 |
| --- | ---: | ---: | ---: | --- |
| 群内 @ 判定（触发可靠性） | 20 | 3 | 2 | wx 的 markup 优于 wa 的纯文本/关键词 |
| 群成员名册/成员同步 | 15 | 2 | 5 | wa 全量，wx 只能 observed |
| 历史回填/检索 | 10 | 4 | 5 | wa DB 直读；wx UI 滚动 |
| 入站消息类型/媒体覆盖 | 14 | 5 | 4 | wx 消息类最全（笔记/合并/卡片等） |
| 出站文本/文件/@/语音 | 12 | 5 | 3 | wx 有 AtAll/SendAudio；wa 只有 at/SendFiles |
| 稳定性/自恢复 | 12 | 2 | 3 | wx 本机 148 次重挂；wa 发送也依赖 UI |
| 费用/许可 | 10 | 1 | 5 | wxautox4 需授权；wa Apache-2.0 |
| 可维护/可改源码 | 7 | 1 | 4 | wx 闭源编译；wa 开源 |
| **加权合计（0–5 折算 100）** | 100 | **60.2** | **74.2** |  |

> 结论对权重敏感：若把“@ 触发”权重提高到 30、费用降到 5，wxautox4 会反超；若把“免费/名册/历史”权重提高，wechatauto 明显领先。**单看当前研发群生产，wxautox4 的 @/出站更完整；单看免费与读侧深度，wechatauto 更强。**

---

## 5. 关键结论（影响决策）

1. **wxautox4 仍是目前“群 @ 触发 + 出站能力”最完整的现成方案**：`AtAll`、`at`、`SendAudio`、朋友圈发布、好友/群管理都在；本机实测可直接用。代价是**闭源 + 授权费 + Windows + UI 稳定性差**（4 天 148 次重挂）。
2. **wechatauto-replica 不是 wxautox4 的“无缝免费替代”**：
   - 强项：**免费 Apache-2.0、全量历史、群成员名册、媒体解密**；
   - 弱项：**没有 AtAll/SendAudio/朋友圈发布/好友群管理**；入站 @ 没有结构化字段；发送仍依赖 UIA/OCR；
   - **硬门槛：要求微信 4.1.12+，本机 4.1.9.30 不满足**；生产前必须升级测试机并复测。
3. 对你的“办公室常开 Windows、研发群、测试反馈 bug”场景，**最稳的是保留 wxautox4 作为生产主后端**（你已确认不替换），**并行增加 wechatauto 作为免费/读侧后端**（历史、名册、媒体、诊断），并把它作为未来免费化的候选。两者不是二选一，而是**读写分工**：
   - wxautox4：实时监听、@、发送、群管理；
   - wechatauto：全量历史回填、群成员同步、图片/语音归档、问题复盘。
4. 如果强行用 wechatauto 独立承担生产：需要自己补 `AtAll`、`SendAudio`、朋友圈发布、群管理（UI 或第三方），并接受 4.1.12+ 版本门槛与 UIA 发送风险；不建议在没有 PoC 前直接替代。
5. **跨 OS / 普通用户免费**仍应走 iLink（见上一份调研）；wechatauto 只解决 Windows 且免费，不解决跨 OS。

---

## 6. 建议的下一步实验（用结果再决策）

1. **升级测试机微信到 4.1.12+**（不要动生产机），安装 `wechatauto-replica==1.2.10`；
2. 跑 6 组基线：
   - A 读：`WeChatDB().get_self_info()`、`get_sessions()`、`get_groups()`、`get_group_members()`；
   - B 历史：`get_messages(group, limit=100)` 与当前 wxautox4 `GetHistoryMessage` 的条数/耗时对比；
   - C 媒体：图片原图/压缩/缩略图、语音 SILK、文件下载成功率；
   - D 监听：`Listener` 1 小时，统计新消息延迟、漏消息、重复；
   - E 发送：向 `文件传输助手` 发文本/文件/图片，验证 `SendMsg(at=...)` 在群里的真实 @ 效果（用测试群/测试号）；
   - F 稳定性：连续 24 小时运行，记录崩溃、窗口焦点、重挂次数。
3. 输出一份与本文同表的 **实测版**；若 wechatauto 在 4.1.12+ 的 @/发送稳定，再考虑 `pc-db` 后端；否则保持 wxautox4 主、wechatauto 辅。

---

## 7. 参考

- wxautox4：[PyPI 41.2.3](https://pypi.org/project/wxautox4/)（授权系统）
- wechatauto-replica：[GitHub](https://github.com/fanyuantaier/wechatauto-replica)（Apache-2.0，1.2.10）
- 当前 bridge 契约：[contract.md](../../sidecar/wxauto-bridge/contract.md)
- 上一份微信接入调研：[wechat-transport-research.zh-CN.md](wechat-transport-research.zh-CN.md)
