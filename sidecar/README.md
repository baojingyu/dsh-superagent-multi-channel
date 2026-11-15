# 微信 sidecar 总览：两个发布 profile，一份冻结契约

微信个人号没有官方开放的个人消息 API。本插件把「怎么拿到消息」放在一个**回环 HTTP sidecar** 后面，
Node 侧（`src/sources/chat/weixin/*`）只认 `wxauto-bridge/contract.md` 冻结的 8 个端点，**换 profile = 换一个实现这份契约的 sidecar + 改面板里的「桥地址 / 桥启动器 / token 文件」**，Node 业务层零改动。

一个微信 Source 有 `profile` 字段，只有两个发布 profile，**默认 `personal`**：

- **`personal`（默认）= `weixin-ilink-bridge`**：腾讯 iLink Bot，免费、跨 OS、扫码即用，只做**个人助手单聊**。
- **`team` = `weixin-db-bridge`**：wechatauto-replica，免费、Windows、微信 **4.1.12+**，面向**研发群**：DB 读库触发群消息、全量历史/名册、文本/文件/群 @ 发送。

本发布只随包 `weixin-ilink-bridge`、`weixin-db-bridge` 两个 sidecar 与 `start-weixin-ilink.cmd`、`start-weixin-db.cmd` 两个启动器。

> **`wxauto-bridge`（wxautox4）与 `gate-guard` 是非默认、不随包发布的可选外部组件**；下文只在「非默认后端」一节提一句，部署方如需自行安装与授权。

---

## 1. 两 profile 对照（仅发布 ilink + replica）

| 维度 | `personal`（默认）= `weixin-ilink-bridge`（`ilink` / 腾讯 iLink Bot） | `team` = `weixin-db-bridge`（`pc-db` / wechatauto-replica） |
|---|---|---|
| 默认端口 / 启动器 | `9300` / `sidecar\start-weixin-ilink.cmd` | `8788` / `sidecar\start-weixin-db.cmd` |
| 后端标识 | `backend:"ilink"` | `backend:"pc-db"` |
| OS / 费用 | **任意 OS（无需桌面微信）**；**免费**（官方 iLink 通道） | 仅 Windows（需登录桌面微信，**4.1.12+**）；**免费**（Apache-2.0） |
| 依赖 | Node 18+，零第三方依赖（vendored MIT 客户端） | `wechatauto-replica`（DB 读；发送需完整 UIA 包） |
| 收消息 | 云端长轮询 `getUpdates` | 只读本地库 `get_messages`/`get_new_messages`（**DB 触发**，Node 轮询 `/messages`） |
| 群 / 私聊 | **仅单聊**（不提供群会话、群成员表、群 @） | ✅ 群 + 私聊 |
| 入站结构化 `@` | ❌ `mentions:"none"`（`ats` 恒空） | ❌ `mentions:"none"`（DB 无入站 @ 列表，`ats` 恒空） |
| 群成员名册 | ⚠️ `members:"observed"`（仅单聊对端） | ✅ `members:"full"`（全量名册，来自 `contact.db`） |
| 历史回填 | ❌ 仅实时 | ✅ 全量 DB 历史、可分页 |
| 入站媒体（图片） | ✅ CDN 下载 + AES-128-ECB 解密，否则 `501` | ✅ `MediaDownloader` 可用时，否则 `501` |
| 出站发送 | ✅ 文本（必须回传 `context_token`），keyed 幂等 | ✅ 文本 / 文件 / 群 @（需 `--profile team`；走 `wechatauto.Chat.SendMsg`/`SendFiles`，UIA/OCR）；默认只读 `501` |
| 限制 | 限流、token ~24h、10 条级额度；群功能不保证 | 发送要占桌面界面；**无语音 / 朋友圈 / 好友 / 建群**（见 §2） |

能力自述（`GET /health.capabilities`）是每个后端对「自己能兑现哪些契约字段」的**诚实声明**，Node 侧据此决定群 `@` 是否可用，不要用「`ats` 是否为空」去猜。

---

## 2. 各自的边界（诚实声明，不是 bug）

**`personal`（iLink）**：单聊为主，不接群、无群成员表、无入站 `@`；连续消息有额度限制、token 约 24h（`errcode -14` 需重扫）。

**`team`（replica）**：

- **无语音转写、无朋友圈、无好友/建群**（`wechatauto` 这些接口本仓库未接入，也不声称）。
- **入站无结构化 @**（`mentions:"none"`）：群消息靠「全部消息 + Policy/关键词」准入，不按 @ 判定。
- **群成员是全量名册**（`members:"full"`），可直接同步进 Policy。
- **发送**：`readonly`（默认）只读，`/send` 恒 `501`；`--profile team` 才开文本/文件/群 @ 发送（`wechatauto.Chat`，UIA+OCR，要求完整 `wechatauto-replica`、Windows 4.1.12+、桌面可见未锁屏）。
- **触发**：`team` 用 **DB 读库触发**——Node 轮询 `/messages`，`/listen` 只记录房间、**不 `AddListenChat`/`StartListening`**，读库不抢 UI；只有 `/send` 在发送时占用界面。

---

## 3. 默认策略（怎么选）

| profile / 场景 | 选择 | 理由 |
|---|---|---|
| **`personal`（默认）**：个人微信助手、远程控制、跨 OS（mac/Linux/Windows 均可）、扫码自派任务 | **`weixin-ilink-bridge`（9300）** | 免费、扫码即用、无需桌面微信；代价是仅单聊、有限流 |
| **`team`**：办公室 Windows 常开机器、研发群：群消息触发、历史/名册、需要真发文本/文件/群 @ | **`weixin-db-bridge`（8788，`--profile team`）** | 免费（Apache-2.0）、全量历史/名册、可在 PC 微信上真发；要求 Windows + 微信 4.1.12+，发送占界面 |

- **`personal` 是默认 profile**。
- **`team` 默认只读**；要在 PC 微信上真发，用 `--profile team`（或 `WXBRIDGE_PROFILE=team`）启动 `weixin-db-bridge`。
- **发布只带 iLink + replica 两个后端、两个启动器**。

---

## 4. 启动（两个 profile 各一份）

两个后端都用**独立 Bearer token** 保护全部端点，token 只经命令行/环境变量/权限收紧的文件传入，**任何日志都不出现 token 值**。

### 4.1 personal：weixin-ilink-bridge（`ilink`，默认 9300，跨 OS）

```powershell
# 1) 扫码登录，保存凭证（~24h 有效，errcode -14 时重扫）
node sidecar\weixin-ilink-bridge\server.mjs login --auth-file sidecar\weixin-ilink-bridge\data\weixin-ilink-auth.json
# 2) 准备独立 HTTP Bearer token 文件，3) 启动
node sidecar\weixin-ilink-bridge\server.mjs run --port 9300 --host 127.0.0.1 `
  --token-file secrets\ilinkbridge.token --auth-file sidecar\weixin-ilink-bridge\data\weixin-ilink-auth.json
# 或无真实微信自测：
node sidecar\weixin-ilink-bridge\selftest.mjs
```

- 启动器：`sidecar\start-weixin-ilink.cmd`。详见 `sidecar/weixin-ilink-bridge/README.md`。

### 4.2 team：weixin-db-bridge（`pc-db`，默认 8788；只读或 team 全量）

```powershell
$env:WXBRIDGE_TOKEN = "<long-random-token>"

# 只读档位（默认；不碰界面、/send 501）：
python sidecar\weixin-db-bridge\server.py --port 8788

# team 全量档位（DB 触发 + 文本/文件/群 @ 发送；发送时占界面）：
python sidecar\weixin-db-bridge\server.py --port 8788 --profile team

# 无微信自测：
python sidecar\weixin-db-bridge\selftest.py
```

- 启动器：`sidecar\start-weixin-db.cmd`（读 `WXBRIDGE_TOKEN`/`WEIXIN_DB_TOKEN`，可用 `WECHATAUTO_VENV` 指定 venv、`WECHATAUTO_PATH` 指定源码目录；追加 `--profile team` 或 `set WXBRIDGE_PROFILE=team` 切全量）。**要求微信 4.1.12+**，发送需完整 `wechatauto-replica`。
- 详见 `sidecar/weixin-db-bridge/README.md`。

> 面板里每个 profile 就是「profile + 地址 + 启动器 + token 文件」四项：`profile` 选 personal/team，`baseUrl` 指向对应端口（personal=9300、team=8788），`bridgeLauncher` 指向对应 `.cmd`，`/health` 自报 `backend` 与 `capabilities`。

---

## 4.1 与官方飞书来源对齐的消息语义

微信轮询循环按飞书来源处理，不额外制造即时消息：

- **首次读取一个会话**：先把当前 `head` 作为游标基线，历史消息不当作新请求；
- **不发送**“收到，正在处理”、关键词自动回复、处理中提醒；
- 一条消息的去向由 Policy/Engine 决定；被拒绝的“已寻址”消息仍按 `acceptsNotice` 发送一次说明，与飞书一致；
- 私聊按一条 `room=""` 流读取；team 只接群时把 `directMessages` 关掉，避免把历史私聊和服务账号消息当作触发。

## 5. 互斥与共存（必须遵守）

1. **`personal`（iLink）无界面依赖**：不驱动桌面微信，可与桌面后端并行；但它是**你本人微信下的一个 Bot 身份**，不能与桌面客户端对同一会话双发。
2. **`team` 默认只读不碰界面**；一旦 `--profile team` 走 UIA/OCR 发送，就**占用桌面界面**——同一微信号同一时刻只允许一个 UI 自动化客户端操作界面，否则互相抢焦点。
3. **同一微信号同一时刻只允许一个实例持有登录态/解密密钥**（双开、风控红线）。

---

## 6. 版本要求与 4.1.12.55 结论

- **`personal`（iLink）**：与微信客户端版本无关，只取决于 iLink 网关与账号绑定。
- **`team`（replica）**：要求微信 **4.1.12+**；DB 只读不依赖 UIA 控件树，发送依赖 `wechatauto` 的 UIA/OCR。实测依据 `docs/research/compat-4.1.12.55.md`。

**4.1.12.55 根因**：这一版把微信 4.x 的 Qt 无障碍 gate 默认关掉（gate=0），`mmui` 控件树冷启动不物化。`wechatauto-replica` 自带「扫描 RVA + 热写 1 字节 + 校验 mmui 出现」的热激活逻辑，所以它的 **DB 只读与 UIA 发送都能用**——4.1.12.55 上 `team` 的 DB 只读五个 API 全通、可上生产；`wxautox4`（非默认后端）没有热激活，冷启动 attach 失败，故不作为发布后端。

**回滚点**：当前客户端 `4.1.12.55`，上一可用 `4.1.9.30`；数据目录 `xwechat_files` 回退后仍可读。详见 `docs/research/compat-4.1.12.55.md` §8。

---

## 7. 非默认、不随包发布的后端：`wxauto-bridge` / `gate-guard`

`wxauto-bridge`（`pc-uia` / wxautox4）与 `gate-guard` **不在本发布物内**：本仓库不随包分发任何 wxautox4 文件，也不含规避其授权检查的代码。若你自行部署了 wxauto-bridge，可按其自身 README 手工启动（`server.py --port 8787`），必要时自行维护 `gate-guard` 的 Qt accessibility gate；授权与兼容性由你自负。发布包只包含 `weixin-ilink-bridge`、`weixin-db-bridge` 两个 sidecar 与 `start-weixin-ilink.cmd`、`start-weixin-db.cmd` 两个启动器。
