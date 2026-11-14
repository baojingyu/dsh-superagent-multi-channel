# 微信 sidecar 总览：三种后端，一份冻结契约

微信个人号没有官方开放的个人消息 API。本插件把「怎么拿到消息」放在一个**回环 HTTP sidecar** 后面，
Node 侧（`src/sources/chat/weixin/*`）只认 `wxauto-bridge/contract.md` 冻结的 8 个端点，**换后端 = 换一个实现这份契约的 sidecar + 改面板里的地址/启动器**，Node 业务层零改动。

本目录提供三种后端，覆盖三种取舍：**付费但要最全的 Windows 群能力**、**免费只读的 Windows 诊断/历史**、**免费跨 OS 但只做个人助手**。

---

## 1. 三后端对照

| 维度 | `wxauto-bridge`（`pc-uia` / wxautox4） | `weixin-db-bridge`（`pc-db` / wechatauto-replica） | `weixin-ilink-bridge`（`ilink` / 腾讯 iLink Bot） |
|---|---|---|---|
| 定位 | Windows 研发群主后端，能力最全 | Windows 免费只读补充：历史/名册/媒体/复盘 | 普通用户默认：个人助手 / 远程控制 |
| 操作系统 | Windows 10/11 x64（需已登录桌面微信） | Windows 10/11 x64（需已登录桌面微信） | 任意 OS（纯 Node，**不需要桌面微信**） |
| 费用/许可 | **需 wxautox4 商业授权**（部署方自负） | **免费**（wechatauto-replica，Apache-2.0） | **免费**（官方 iLink 通道） |
| 依赖 | wxautox4 + UIAutomation | wechatauto-replica（读 SQLCipher 本地库） | Node 18+，零第三方依赖（vendored MIT 客户端） |
| 默认端口 | `8787` | `8788` | `9300` |
| 启动器 | `sidecar/start-wxbridge.cmd` | `sidecar/start-weixin-db.cmd` | `sidecar/start-weixin-ilink.cmd` |
| 后端标识 | `backend:"pc-uia"` | `backend:"pc-db"` | `backend:"ilink"` |
| 收消息 | 监听回调（`AddListenChat + StartListening`） | 只读本地库（`get_messages`/`get_new_messages`） | 云端长轮询（`getUpdates`） |
| 群 / 私聊 | 群 + 私聊 | 群 + 私聊 | **仅单聊**（不提供群会话、群成员表、群 @） |
| 结构化 `@` | `mentions:"markup"`（读客户端 @ 标记，改名/粘贴可伪造） | `mentions:"none"`（`ats` 恒空，群消息靠 Policy/关键词准入） | `mentions:"none"`（`ats` 恒空） |
| 群成员名册 | `members:"observed"`（只有发过言的人） | `members:"full"`（全量名册，来自 `contact.db`） | `members:"observed"`（仅单聊对端） |
| 媒体（入站图片） | `media:true`（取决于构建 `download()`） | `media:true`（`MediaDownloader` 可用时），否则 `false`→`501` | `media:true`（CDN 下载 + AES-128-ECB 解密），否则 `false`→`501` |
| 出站发送 | ✅ 文本/引用/@回、文件、语音；keyed 幂等 | ⚠️ **默认只读 `501`**；显式 `--allow-send` 才经 UIA 发送 | ✅ 文本（必须回传 `context_token`），keyed 幂等 |
| 历史回填 | UI 滚动补读（重挂后最近 20 条） | ✅ 全量 DB 历史（可分页） | ❌ 仅实时（`getUpdates`） |
| 稳定性成本 | UI 被抢/客户端升级会中断，自愈重挂 | 读库稳定；发送依赖 UI；**要求微信 4.1.12+** | 官方通道但限流、token ~24h、10 条级额度 |
| 部署边界 | 同一微信号同一时刻只允许一个 UI 自动化客户端在操作 | 只读不碰界面；`--allow-send` 时才与其它 UI 工具互斥 | 无界面依赖，可与桌面后端并行（身份不同，不能对同一会话双发） |

> 能力自述（`GET /health.capabilities`）是每个后端对「自己能兑现哪些契约字段」的**诚实声明**，Node 侧据此决定群 `@` 是否可用。不要用「`ats` 是否为空」去猜。

---

## 2. 默认策略（怎么选）

| 场景 | 选择 | 理由 |
|---|---|---|
| 普通用户：个人微信助手、远程控制、跨 OS（mac/Linux/Windows 均可） | **`weixin-ilink-bridge`（默认）** | 免费、扫码即用、无需桌面微信；代价是仅单聊、有限流 |
| 办公室 Windows 常开机器：研发群的 `@` 触发、群发、文件回传 | **`wxauto-bridge`（`pc-uia`）** | 群/@/文件/语音最全，实时监听；代价是需 wxautox4 授权 + UI 稳定性 |
| Windows 免费补充：全量历史、群成员名册、图片/语音归档、问题复盘 | **`weixin-db-bridge`（`pc-db`，只读）** | Apache-2.0 免费、读库稳定、名册全量；默认只读，不抢窗口 |

- **iLink 默认给个人助手**：不接群、不承诺 @。需要群能力时切到 Windows 后端。
- **Windows 研发群用 wxauto**：群 @、出站文件、语音转写都齐，是当前生产主后端。
- **wechatauto 只做只读补充**：历史/名册/媒体归档；要它发送得显式 `--allow-send`，并接受与 wxauto 的 UI 互斥。
- **不把 wxautox4 的逆向/绕过包进发布**：本仓库只调用其公开 API；授权由部署方自行承担，不随仓库分发任何 wxautox4 文件，也不含任何规避其授权检查的代码（`poc/` 下的探测脚本只是一次性只读验证，不属于发布物）。

---

## 3. 启动（三种各一份）

三种后端都用**独立 Bearer token** 保护全部端点，token 只经命令行/环境变量/权限收紧的文件传入，**任何日志都不出现 token 值**。

### 3.1 wxauto-bridge（`pc-uia`，默认 8787）

```powershell
# 需已登录桌面微信 + 已装 wxautox4；token 放 owner-only 文件
sidecar\start-wxbridge.cmd          # 或按 sidecar/wxauto-bridge/README 手工起 server.py --port 8787
```
详见 `sidecar/wxauto-bridge/contract.md` 与 `EXTENSIONS.zh-CN.md` 第 4/5 节。

**微信 4.1.12.55+ 额外要求**：启动 wxauto-bridge 前先运行 `sidecar\gate-guard\start-gate-guard.cmd`（或 `python sidecar\gate-guard\gate_guard.py --interval 10`）保持 Qt accessibility gate 打开；否则 wxautox4 冷启动找不到 `mmui` 主窗口。gate-guard 只解决 UIA 树，不解决 wxautox4 授权。

### 3.2 weixin-db-bridge（`pc-db`，默认 8788，只读）

```powershell
$env:WXBRIDGE_TOKEN = "<long-random-token>"
# 只读读库最小依赖：cryptography / colorama / 可选 zstandard
python sidecar\weixin-db-bridge\server.py --port 8788
# 或无微信自测：
python sidecar\weixin-db-bridge\selftest.py
```

- 启动器：`sidecar\start-weixin-db.cmd`（读 `WXBRIDGE_TOKEN`/`WEIXIN_DB_TOKEN`，可用 `WECHATAUTO_VENV` 指定 venv、`WECHATAUTO_PATH` 指定源码目录）。
- 详见 `sidecar/weixin-db-bridge/README.md`。

### 3.3 weixin-ilink-bridge（`ilink`，默认 9300，跨 OS）

```powershell
# 1) 扫码登录，保存凭证（~24h 有效，errcode -14 时重扫）
node sidecar\weixin-ilink-bridge\server.mjs login --auth-file sidecar\weixin-ilink-bridge\data\weixin-ilink-auth.json
# 2) 准备独立 HTTP Bearer token 文件，3) 启动
node sidecar\weixin-ilink-bridge\server.mjs run --port 9300 --host 127.0.0.1 `
  --token-file secrets\ilinkbridge.token --auth-file sidecar\weixin-ilink-bridge\data\weixin-ilink-auth.json
# 或无真实微信自测：
node sidecar\weixin-ilink-bridge\selftest.mjs
```

- 启动器：`sidecar\start-weixin-ilink.cmd`。
- 详见 `sidecar/weixin-ilink-bridge/README.md`。

> 面板里每个后端就是「地址 + 启动器 + token 文件」三项：把 `baseUrl` 指向对应端口，`bridgeLauncher` 指向对应 `.cmd`，`/health` 会自报 `backend` 与 `capabilities`。

---

## 4. 互斥与共存（必须遵守）

1. **`pc-uia` 与 `pc-db` 共用同一台 Windows 桌面微信的 UI**：`wxauto-bridge` 全程驱动界面；`weixin-db-bridge` 只读读库不碰界面，但一旦加 `--allow-send` 就走 UIA/OCR 发送。**同一微信号同一时刻只允许一个 UI 自动化客户端操作界面**（wxautox4 / wxauto / wechatauto 的发送路径互斥），否则互相抢焦点、监听器失效。
2. **只读读库可以并行**：不加 `--allow-send` 的 `pc-db` 不改库、不切会话、不 `AddListenChat`，可与 `pc-uia` 并存做历史/名册补充；但**同一微信号同一时刻只允许一个实例持有登录态/解密密钥**（双开、风控红线）。
3. **`ilink` 与桌面后端互相独立**：iLink 不依赖桌面微信、无 UI，可与 `pc-uia`/`pc-db` 并行；但它绑定的是**你本人微信下的一个 Bot 身份**，与桌面客户端的会话不是同一条，不能对同一会话双发。

---

## 5. 版本矩阵与 4.1.12.55 结论

实测依据：`docs/research/compat-4.1.12.55.md`（微信 4.1.12.55 下只会话、只读，未发消息）。

| 微信客户端版本 | `wxauto-bridge`（wxautox4 41.2.3） | `weixin-db-bridge`（wechatauto-replica 1.2.10） | `weixin-ilink-bridge`（iLink） |
|---|---|---|---|
| 4.1.9.x（上一可用基线，如 4.1.9.30） | ✅ 可用（旧基线，`/rooms` 能返回群） | ❌ 低于 4.1.12 门槛，不可用 | ✅ 与客户端版本无关 |
| **4.1.12.55** | ❌ 冷启动（无障碍 gate=0）attach 失败：`未找到已登录的客户端主窗口`；仅当 gate 被热激活（gate=1）后才能 `GetMyInfo/IsOnline/GetSession`，而 **wxautox4 自己不做热激活** | ✅ **DB 只读五个 API 全通**（`get_self_info`/`get_sessions`/`get_groups`/`get_group_members`/`get_messages`），**推荐版本** | ✅ 与客户端版本无关 |
| 4.1.15.56（自动升级后） | ❌ 报「未找到已登录的客户端主窗口」，attach 失败 | ✅（若仍满足 4.1.12+） | ✅ 与客户端版本无关 |

**4.1.12.55 根因**：这一版把微信 4.x 的 Qt 无障碍 gate 默认关掉（gate=0），`mmui` 控件树冷启动不物化，只剩 Qt 外壳。`wechatauto-replica` 自带 `wechatauto.accessibility` 的「扫描 RVA + 热写 1 字节 + 校验 mmui 出现」逻辑，所以它的 DB 与 UIA 路线都能用；`wxautox4` 没有这套热激活，冷启动连「已登录主窗口」都找不到。

**4.1.12.55 是否可上生产（结论）**：

- **`weixin-db-bridge`（`pc-db`，DB 只读）→ 可上生产（推荐）**：不依赖 UIA 控件树、不依赖 wxautox4 授权；4.1.12.55 上密钥提取 20/20、五个只读 API 全通，只读不产生账号副作用。
- **`wxauto-bridge`（`pc-uia`/wxautox4）→ 有条件**：必须先补「gate 热激活守护 + 授权确认 + 重启后复测（能 attach、`/rooms` 非空、监听能收消息）」；在补齐并复测通过前**不要宣称 pc-uia 后端在 4.1.12.55 可用**。现网 bridge 若在升级前启动、持着旧 UIA 根句柄，会表现为「`/rooms` 空 + 大量自动重挂」——**不要贸然重启**，重启后新进程在 gate=0 下 attach 直接失败。
- **`weixin-ilink-bridge` → 不受客户端版本影响**：不依赖桌面微信，可随时启用。

**回滚点**：当前客户端安装 `C:\Program Files\Tencent\Weixin\4.1.12.55`；上一可用客户端 **4.1.9.30**；数据目录 `xwechat_files` 升级不删库，回退客户端后仍可读。最轻回滚 = 不动客户端、保持现网 bridge 运行、重启前先跑一次 gate 热激活；彻底回滚 = 卸载 4.1.12.55 重装 4.1.9.30 后复测 `/health`、`/rooms`、`/members`。详见 `docs/research/compat-4.1.12.55.md` §8。

> 补充：`wxautox4` 是商业库，授权由部署方自行承担；`poc/` 里为验证兼容性用过进程内放行模块，只改探测进程自身内存、退出即失效，现网 bridge 未被 patch/重启。发布物不含任何 wxautox4 文件或规避其授权检查的代码。
