# WCF / WeChatFerry Node 家族调研（补充）

> 对象：`wcferry-node`、`node-wcferry`、`wechatferry`，以及官方文档 `https://wcferry.netlify.app/guide.html`。
> 结论：**技术能力强，但与当前微信 4.x 不兼容，且官方免责声明明确限制二次开发与分发；不作为本产品路线。**

---

## 1. 三个项目到底是什么

| 名称 | 实际仓库 | 角色 | 语言/星数 | 现状 |
| --- | --- | --- | --- | --- |
| **wechatferry**（Node 生态） | [wechatferry/wechatferry](https://github.com/wechatferry/wechatferry) | 基于 WeChatFerry 的 **Node 高层 SDK**：`@wechatferry/core`（SDK/RPC）+ `agent` + `puppet`（Wechaty）+ `nuxt` + `plugins` | TypeScript / **2114★**，MIT，npm `wechatferry@0.0.26` | 活跃（2026-11-13） |
| **node-wcferry** | [stkevintan/node-wcferry](https://github.com/stkevintan/node-wcferry) | **WCF 的原生 RPC 客户端**：`@wcferry/core` + `@wcferry/ws`（小 WebSocket 服务） | TypeScript / **31★**，无 license 字段 | 低维护（2026-10） |
| **wcferry-node** | 多个同名/近似仓库：`forget-pro/wcferry-node`（0★）、`passby6someone/wcferry-node-http`（0★）等；npm 上 **不存在 `wcferry-node` 包**（404） | 早期/个人 Node 封装或 HTTP 壳 | TypeScript / 0★ | 不建议使用；名称歧义大 |

官方文档明确：WechatFerry 是 @lich0821 的 **Windows 微信机器人底层框架**；`wechatferry` 是 **Node 生态第三方客户端**，不是腾讯官方。

---

## 2. 架构原理

```
Node 应用
  └─ @wechatferry/agent（高层：事件/发送/群管理）
       └─ @wechatferry/core（SDK 封装）
            └─ sdk.dll（C++ Hook，注入微信进程）
                 └─ 微信 3.9.12.17（必须）
```

- `@wechatferry/core` 依赖 `koffi`（FFI）、`@rustup/nng`（NNG/socket）、`google-protobuf`；不是纯 JS。
- 官方核心是 **DLL 注入 + RPC**（WeChatFerry C++ 的 `sdk.dll`），不是 UI 自动化，也不是 DB 解密。
- Windows x64 only；需要先安装并登录 **微信 3.9.12.17**（官方 guide 指定；核心 v39.5.2 适配 3.9.12.51）。
- 支持 Python / HTTP / NodeJS / Java / C# / Rust / Go 客户端；Node 只是其中一种壳。

---

## 3. 能力（官方 features + README）

- **事件**：消息、加群、退群、邀请入群、改群名、新好友、朋友圈事件（仅文字，图片需解密）。
- **联系人**：全部联系人、单个联系人、备注、头像。
- **消息**：文本/图片/文件/卡片 URL/小程序/地理位置；下载图片/文件；获取语音；转发消息。
- **发送**：文字（**可 @**）、图片、文件、卡片 URL、XML、GIF、拍一拍。
- **群聊**：群列表、群成员列表、群头像、群昵称、群公告、建群/邀请/踢人、添加群成员。
- **好友**：通过好友申请、添加群成员、删除/邀请群成员。
- **朋友圈**：获取朋友圈消息（文字；图片需解密），未见“发布朋友圈”能力。
- **历史**：agent 提供历史聊天记录查询。

> 单看能力，WCF 是“Hook 路线”里最全的：**群成员全量、@ 发送、群管理、媒体、卡片**，比 `wechatauto-replica` 的出站能力更强。但它的前提是 **微信 3.9.x**。

---

## 4. 致命约束（为什么不能作为本产品路线）

1. **微信版本不兼容**：官方 guide 要求 **微信 3.9.12.17**；核心 v39.5.2 适配 3.9.12.51。当前生产机微信 **4.1.9.30**；`WeChatFerry` 没有 4.x 支持（版本号 `w.x.y.z` 的 `w=39` 即 3.9）。要用它必须单独准备一台 **3.9.12.17 的 Windows 机器/回退客户端**，不能与现有 4.x 客户端共存。
2. **免责声明限制分发与二次开发**：官方 README 明确要求“下载/编译后 24 小时内删除”、“严禁二次开发”、“仅允许授权下数据库备份与查看”。这与我们要**开源、打包、长期分发**的产品形态直接冲突；只能作为**隔离环境的技术研究**，不能并入仓库或安装包。
3. **Hook 风险最高**：DLL 注入微信进程，版本一升级就失效；封号/稳定性风险高于 UI 自动化；Windows x64 only，不解决跨 OS。
4. **Node 封装维护度低**：`wechatferry/wechatferry` 活跃但本质依赖 3.9；`node-wcferry` 31★、无 license、低维护；`wcferry-node` npm 无此包、同名仓库 0★，不可信。
5. **不解决“普通人免费 + 跨 OS”**：它只是 Windows + 3.9 客户端的 Hook；普通用户不会为它降级微信；也不能在 macOS/Linux 上运行。

---

## 5. 与当前方案对比（仅能力维度）

| 维度 | wxautox4（当前） | wechatauto-replica | WCF Node（wechatferry） | iLink |
| --- | --- | --- | --- | --- |
| 微信 4.x | ✅（本机 4.1.9.30） | ✅ 4.1.12+ | ❌ **仅 3.9.12.17/3.9.12.51** | ✅ 云端 |
| Windows 依赖 | 是 | 是 | 是（且需特定旧版） | **否** |
| 群成员全量 | ⚠️ observed | ✅ | ✅ | ❌ |
| 发送 @ | ✅ | ✅（无 AtAll） | ✅（可 @） | ⚠️ 有限 |
| 群管理 | ✅（建群/群名/公告） | ❌ | ✅（建群/邀请/踢人/群公告） | ❌ |
| 媒体 | ✅ | ✅ | ✅（图片/文件/语音/视频/卡片） | ✅ |
| 朋友圈 | ✅（含发布） | 读/赞/评（发布无） | 读（文字；图片需解密） | ❌ |
| 费用/许可 | 需授权 | Apache-2.0 | MIT 代码，但**免责声明限制二次开发/分发** | 免费官方 |
| 源码/可改 | 闭源 | 开源 | 开源（但声明禁止二次开发） | 官方 SDK |
| 结论 | 当前生产可用 | 免费读侧补充 | **仅隔离研究/旧版专用** | 普通用户跨 OS |

---

## 6. 建议

- **不要**把 `wechatferry` / `node-wcferry` / `wcferry-node` 纳入主线或安装包；
- 如果要做 Hook 路线研究，**单独一台 Windows + 微信 3.9.12.17 隔离环境**，只用于技术验证，不连接生产账号；
- 你现有 **4.x** 的生产场景继续用 `wxautox4`（已运行），免费补充用 `wechatauto-replica`，跨 OS/普通用户用 `iLink`；
- 若未来微信 4.x 的 Hook 方案出现（例如新版 WCF），再按“版本支持 + 许可证 + 分发许可”三条重新评估。

---

## 7. 参考

- 官方文档：[wcferry.netlify.app/guide.html](https://wcferry.netlify.app/guide.html)（要求微信 3.9.12.17）
- 功能清单：[wcferry.netlify.app/features.html](https://wcferry.netlify.app/features.html)
- Node 集成：[wcferry.netlify.app/integrations/node.html](https://wcferry.netlify.app/integrations/node.html)
- [wechatferry/wechatferry](https://github.com/wechatferry/wechatferry)（2114★，MIT）
- [stkevintan/node-wcferry](https://github.com/stkevintan/node-wcferry)（31★）
- [lich0821/WeChatFerry](https://github.com/lich0821/WeChatFerry)（6806★，C++ 核心；README 版本 39.5.2）
