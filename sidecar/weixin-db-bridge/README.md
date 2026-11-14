# weixin-db-bridge —— 微信 4.x 本地数据库只读 sidecar（`pc-db` 后端）

这是 `wxauto-bridge` 的一个**只读、免注入、免 UIA** 后端实现。它不驱动微信界面、
不修改任何数据库、不启动会抢占窗口的监听器，只通过 `wechatauto-replica` 读取本机
微信 4.x 的 SQLCipher 本地库（`contact.db` / `session.db` / `message_N.db`）来回答
会话、成员、消息与图片查询。

> 契约以 `../wxauto-bridge/contract.md` 为准。本 sidecar 只实现其中的**只读子集**，
> 字段与错误码严格对齐；发送默认返回 `501`。

## 1. 定位与能力边界（诚实声明）

`GET /health.capabilities` 对本后端固定为：

| 字段 | 取值 | 说明 |
|---|---|---|
| `mentions` | `"none"` | DB 里拿不到可信的 `@` 结构化列表；`ats` 恒为 `[]`，不做「文本里猜 @昵称」。需要群消息时把群设为「全部消息」，靠 Policy/关键词准入。 |
| `members` | `"full"` | 群成员表来自 `contact.db` 的 `chat_room` / `chatroom_member`，是**全量名册**。 |
| `media` | `true` / `false` | `wechatauto.media.MediaDownloader` 可用时为 `true`，`GET /media/<id>` 才会尝试解密下载；否则 `false` 且 `/media` 返回 `501`。 |

端点行为：

| 端点 | `pc-db` 行为 |
|---|---|
| `GET /health` | 进程与 DB 可用性、版本、能力自述；DB 不可用时 `available:false` + `detail`，进程不崩。 |
| `GET /status` | 登录账号 `wxid` / 昵称 / `backend:"pc-db"` / `client`（客户端版本，如 `4.1.12.55`）。 |
| `GET /rooms` | 群 + 单聊会话候选全集（只读，不订阅）。群 id 归一为 `wxdb_g_<sha1>`；单聊用原 wxid（不合正则才归一为 `wxdb_u_<sha1>`）。 |
| `GET /members?room=` | 群成员全量；`room` 接受归一 id、群显示名、原始 `xxx@chatroom`；未知会话返回 `[]`。 |
| `GET /messages?room=&limit=&cursor=` | 读 `get_messages`（无游标→最近一页）/ `get_new_messages`（有游标→增量）。`next` 为不透明游标（DB `sort_seq`）。单聊 `room=""` 合并所有私聊为一条流。 |
| `GET /media/<id>` | `<nativeId>#<index>`，按 `MediaDownloader.download_image` 解密本机图片；取不到 `404`，整体无能力 `501`，**绝不返回 200+0 字节**。 |
| `POST /send` | **默认 `501 unsupported`（只读）**；显式 `--allow-send` 才经 `wechatauto.guia.quick_send` 走 UIA 发送。 |
| `POST /listen` | 只做「认不认得这些会话」的应答（`listening/added/removed/failed`）。**不 `AddListenChat`/`StartListening`**，绝不抢微信窗口。 |

### 与 `wxautox4`（L0 `pc-uia` 后端）互斥

- 本后端**完全不碰 UIAutomation / 窗口**，因此理论上可与其它工具共存；但 `--allow-send`
  会调用 `wechatauto.guia.quick_send`（UIA + OCR），此时与任何其它 UI 自动化客户端
  （`wxautox4`、`wxauto` 等）**同一微信号同一时刻只能有一个在操作界面**，否则互相抢焦点。
- **同一微信号同一时刻只允许一个实例持有登录态/读密钥**（双开、风控红线）。
- 只读读库（不加 `--allow-send`）不会修改微信数据，也不会触发界面操作。

## 2. 安装

`wechatauto-replica` 是本机读取微信 4.x 数据库的库，需要安装在**运行 sidecar 的那个
Python 解释器**里（不要装进其它项目的 venv）：

```powershell
# 方式 A：从 PyPI 安装
<Venv>\Scripts\python.exe -m pip install wechatauto-replica

# 方式 B：从本仓 _analysis 的源码目录（未发布时用 --wechatauto-path 指向它即可，无需安装）
#   本仓已有：..\..\_analysis\wechatauto-replica
```

最省事的做法是用一个专用 venv，例如本机已有的 `..\..\_analysis\wa-venv`：

```powershell
$py = "C:\...\default-workspace\_analysis\wa-venv\Scripts\python.exe"
& $py -m pip install "cryptography>=41" colorama zstandard          # 只读 DB 所需的最小依赖
# 需要发送/完整 UIA 时再装完整包：& $py -m pip install wechatauto-replica
```

> 只读读库只需 `cryptography`（SQLCipher 解密）、`colorama`（`wechatauto.logger` 依赖）
> 与可选 `zstandard`（长文本消息解压）。本 sidecar 会优先正常 `import wechatauto`，
> 若完整包因 UIA 依赖缺失而导入失败，会退化为**只加载 `wechatauto.db` / `wechatauto.media`
> 子模块**（绕开会拉起整条 UIA 栈的包 `__init__`），因此纯只读场景不需要装 UIA/OCR 全套。

## 3. 运行

token 只经命令行或环境变量传入，日志只打印 `token=set`，**任何输出都不含 token 值**。

```powershell
# 1) 设 token（0800 权限的私密文件读取也可，这里用环境变量最简单）
$env:WXBRIDGE_TOKEN = "<a-long-random-token>"

# 2) 启动（默认 127.0.0.1:8788；与 wxauto-bridge 的 8787 区分开）
python sidecar\weixin-db-bridge\server.py --port 8788

# 只读自测（无需微信）：确定性 fake 数据，跨平台
python sidecar\weixin-db-bridge\selftest.py
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--port` | 监听端口，默认 `8788`。 |
| `--host` | 默认 `127.0.0.1`；绑定非回环需显式 `--allow-remote`。 |
| `--token` | Bearer token；也可用 `WXBRIDGE_TOKEN` / `WEIXIN_DB_TOKEN`。 |
| `--fake` | 用确定性 fake 后端（不导入 wechatauto、不碰 Windows）。 |
| `--allow-send` | 允许 `POST /send` 经 `wechatauto.guia.quick_send` 发送（默认只读 501）。 |
| `--db-dir` | 微信数据根目录（默认自动探测 `xwechat_files`）。 |
| `--account` | 指定账号目录名（默认按最近活动 + 密钥校验选择）。 |
| `--wechatauto-path` | 未 `pip install` 时指向 `wechatauto-replica` 源码目录。 |
| `--media-cache-ttl` | 媒体字节缓存秒数，默认 300。 |

Windows 一键启动器：`sidecar\start-weixin-db.cmd`（读取 `WXBRIDGE_TOKEN`，可用
`WECHATAUTO_VENV` 指定 venv、`WECHATAUTO_PATH` 指定源码目录）。

## 4. 与 Node 侧对接

Node 侧客户端（`src/sources/chat/weixin/bridge.ts`）在所有面板里用同一套字段。本后端
只在 `rooms[].id` / `sender.id` 上做了**必要归一**：

- 群 `chatroomId`（含 `@`，过不了 Node 的 `^[A-Za-z0-9_-]+$`）→ `wxdb_g_<sha1[:16]>`；
  事件 `room` 与 `/rooms[].id` 用同一个归一 id，因此线程/策略能对上。
- 单聊事件按契约 `room: ""`，`threadRoot` 由 Node 取 `sender.id`；`/rooms` 仍会列出单聊
  候选（面板下拉需要），但私聊读取统一走 `room=""` 那条流。
- `at` 用消息 `create_time`（epoch 秒）转 ISO8601 UTC；无时间字段回落服务端时间。

## 5. 自测

`selftest.py` 用 `--fake` 在进程内起服务，断言 54 项 HTTP 契约（鉴权、错误码、八个端点、
游标翻页、媒体字节、能力自述）。运行：

```powershell
python sidecar\weixin-db-bridge\selftest.py
# 期望输出：... ALL PASS
```

真实微信只读验证（需微信登录 + 本机库可解密）：

```powershell
$env:WXBRIDGE_TOKEN="<token>"
python sidecar\weixin-db-bridge\server.py --port 8788 --wechatauto-path ..\_analysis\wechatauto-replica
# 另开终端用 curl 验证 /health /status /rooms /members /messages 均为只读
```

## 6. 安全

- 只绑定回环地址；Bearer token 用 `hmac.compare_digest` 比对，缺失与错误一律 `401`。
- token 不落日志、不进错误体；`--verbose` 的堆栈也不包含 token（token 只在请求头里）。
- 只读：不改库、不 `AddListenChat`、不切会话；`--allow-send` 是唯一会碰界面的开关。
