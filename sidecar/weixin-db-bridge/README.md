# weixin-db-bridge —— 微信 4.x 本地数据库 sidecar（`pc-db` 后端）

这是 `wxauto-bridge` 的一个**免注入**后端实现。它不注入微信进程、不启动会抢占窗口的
监听器，通过 `wechatauto-replica` 读取本机微信 4.x 的 SQLCipher 本地库
（`contact.db` / `session.db` / `message_N.db`）来回答会话、成员、消息与图片。

支持两个运行档位（`--profile`）：

- **`readonly`（默认）**：纯只读。`POST /send` 恒 `501`，`POST /listen` 只「认不认得
  这些会话」。完全不碰微信界面。
- **`team`（`--profile team` / `--team`）**：DB 触发的**全量模式**。`allow_send` 自动
  打开，`POST /send` 经 `wechatauto.Chat.SendMsg` / `SendFiles` 发送 **文本 / 文件 /
  群 @**；`POST /listen` 只记录房间供 Node 轮询 `/messages`（群触发靠读库），仍
  **不 `AddListenChat` / `StartListening`**、不抢 UI。

> 契约以 `../wxauto-bridge/contract.md` 为准。本 sidecar 实现其中的只读子集，并在
> `team` 档位补齐发送（文本/文件/@）。字段与错误码严格对齐。

## 1. 定位与能力边界（诚实声明）

`GET /health.capabilities` 对本后端为：

| 字段 | 取值 | 说明 |
|---|---|---|
| `mentions` | `"none"` | DB 里拿不到可信的入站 `@` 结构化列表；`ats` 恒为 `[]`。出站的群 `@`（`team` 档位）是另一回事，见下。 |
| `members` | `"full"` | 群成员表来自 `contact.db` 的 `chat_room` / `chatroom_member`，是**全量名册**。 |
| `media` | `true` / `false` | `wechatauto.media.MediaDownloader` 可用时为 `true`，`GET /media/<id>` 才会尝试解密下载；否则 `false` 且 `/media` 返回 `501`。 |
| `send` | `true` / `false` | `readonly` 档位为 `false`（`/send` 恒 `501`）；`team` 档位或显式 `--allow-send` 为 `true`。 |

端点行为：

| 端点 | `pc-db` 行为 |
|---|---|
| `GET /health` | 进程与 DB 可用性、版本、能力自述；DB 不可用时 `available:false` + `detail`，进程不崩。 |
| `GET /status` | 登录账号 `wxid` / 昵称 / `backend:"pc-db"` / `client`（客户端版本，如 `4.1.12.55`）。 |
| `GET /rooms` | 群 + 单聊会话候选全集（只读，不订阅）。群 id 归一为 `wxdb_g_<sha1>`；单聊用原 wxid（不合正则才归一为 `wxdb_u_<sha1>`）。 |
| `GET /members?room=` | 群成员全量；`room` 接受归一 id、群显示名、原始 `xxx@chatroom`；未知会话返回 `[]`。 |
| `GET /messages?room=&limit=&cursor=` | 读 `get_messages`（无游标→最近一页）/ `get_new_messages`（有游标→增量）。`next` 为不透明游标（DB `sort_seq`）。单聊 `room=""` 合并所有私聊为一条流。**两个档位一致**，群消息即触发源。 |
| `GET /media/<id>` | `<nativeId>#<index>`，按 `MediaDownloader.download_image` 解密本机图片；取不到 `404`，整体无能力 `501`，**绝不返回 200+0 字节**。 |
| `POST /send` | `readonly`：`501 unsupported`。`team`：支持 `text`、`files`（文件**绝对路径**列表，另兼容契约的 base64 `file`）、`at`（群成员昵称/ID，不要求 AtAll）；走 `wechatauto.Chat.SendMsg` / `SendFiles`。 |
| `POST /listen` | 只做「认不认得这些会话」的应答并记录（`listening/added/removed/failed`）。**两个档位都不 `AddListenChat`/`StartListening`**，绝不抢微信窗口。 |

### `team` 档位 /send 细节

- 请求体：`{"room","wxid","text","quoteId","at","files","file","idempotencyKey"}`。
  - `room`：归一 id / 群名 / 原始 `xxx@chatroom` / wxid，均会被解析回原始 username 再发。
  - `text`：正文；空串时必须有 `files`/`file`，否则 `400`。
  - `files`：**文件绝对路径列表**（sidecar 原生）；任一不存在 → `400`。
  - `file`：`{"name","data": base64}` 单文件（对齐 Node 契约）；写到私有临时目录、发完即删。
  - `at`：成员昵称/ID 字符串或数组，仅群聊生效；解析成群成员显示名后真 `@`。
    多成员时**第一个为真实 `@`**，其余以 `@名字` 文本形式附在正文后（`guia.at_member`
    单次只 `@` 一人）。
- 错误码：`400`（参数/文件/base64 非法）、`401`、`404`（`room` 不存在）、
  `501`（readonly）、`502`（`wechatauto`/GUI 不可用、发送失败）。

### 与 `wxautox4`（L0 `pc-uia` 后端）互斥

- 只读档位**完全不碰 UIAutomation / 窗口**，可与其它工具共存；`team` 档位的发送路径
  （`wechatauto.Chat.SendMsg/SendFiles` → `WeChatGUI`）是 UIA + OCR，此时与任何其它 UI
  自动化客户端**同一微信号同一时刻只能有一个在操作界面**，否则互相抢焦点。
- **同一微信号同一时刻只允许一个实例持有登录态/读密钥**（双开、风控红线）。

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
>
> **`team` 档位的发送**走 `wechatauto.Chat`（UIA + OCR），必须装**完整** `wechatauto-replica`
> （含 `uiautomation` / `winsdk` / `pyautogui` / `opencv-python` 等），且需要 Windows 4.1.12+
> 客户端、已登录、桌面可见未锁屏。纯只读子模块退化模式**不能**发送。

## 3. 运行

token 只经命令行或环境变量传入，日志只打印 `token=set`，**任何输出都不含 token 值**。

```powershell
# 1) 设 token（0800 权限的私密文件读取也可，这里用环境变量最简单）
$env:WXBRIDGE_TOKEN = "<a-long-random-token>"

# 2) 只读档位（默认；127.0.0.1:8788，与 wxauto-bridge 的 8787 区分开）
python sidecar\weixin-db-bridge\server.py --port 8788

# 3) team 全量档位（DB 触发 + 文本/文件/@ 发送）
python sidecar\weixin-db-bridge\server.py --port 8788 --profile team
#   或等价：python sidecar\weixin-db-bridge\server.py --port 8788 --team

# 自测（无需微信）：确定性 fake 数据，跨平台
python sidecar\weixin-db-bridge\selftest.py
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--port` | 监听端口，默认 `8788`。 |
| `--host` | 默认 `127.0.0.1`；绑定非回环需显式 `--allow-remote`。 |
| `--token` | Bearer token；也可用 `WXBRIDGE_TOKEN` / `WEIXIN_DB_TOKEN`。 |
| `--fake` | 用确定性 fake 后端（不导入 wechatauto、不碰 Windows）。 |
| `--profile` | `readonly`（默认，只读）/ `team`（DB 触发 + 文本/文件/@ 发送）。 |
| `--team` | `--profile team` 的别名。 |
| `--allow-send` | 允许发送（`team` 档位已隐含；`readonly` 下如单独加则等价打开发送）。 |
| `--db-dir` | 微信数据根目录（默认自动探测 `xwechat_files`）。 |
| `--account` | 指定账号目录名（默认按最近活动 + 密钥校验选择）。 |
| `--wechatauto-path` | 未 `pip install` 时指向 `wechatauto-replica` 源码目录。 |
| `--media-cache-ttl` | 媒体字节缓存秒数，默认 300。 |
| `WXBRIDGE_PORT`（环境变量） | 期望端口；空=默认 `8788`，`0`=让操作系统分配空闲端口。优先于 `--port` 的默认值（启动脚本会把它透传为 `--port`）。 |
| `WXBRIDGE_PORT_FILE`（环境变量） | 若设置（绝对路径），server 绑定成功后把**实际监听端口**的十进制文本写入该文件（每次启动覆盖）；父目录不存在会自动创建。`--port 0` 时用它拿到真实端口。 |

Windows 一键启动器：`sidecar\start-weixin-db.cmd`（读取 `WXBRIDGE_TOKEN`，可用
`WECHATAUTO_VENV` 指定 venv、`WECHATAUTO_PATH` 指定源码目录）。切 team 档位有两种方式：
命令行追加 `--profile team`（`%*` 原样透传），或设 `set WXBRIDGE_PROFILE=team`。

端口冲突时可让桥用随机空闲端口启动并回显真实地址：

```bat
set WXBRIDGE_PORT=0
set WXBRIDGE_PORT_FILE=%TEMP%\dsh-weixin\bridge-team.port
start-weixin-db.cmd
rem 桥绑定后 bridge-team.port 里就是实际端口，例如 5 位十进制文本
```

`WXBRIDGE_PORT` 非空时启动脚本用 `--port %WXBRIDGE_PORT%`，否则默认 `8788`；
`WXBRIDGE_PORT_FILE` 由子进程从环境继承，脚本无需重设。

## 4. 与 Node 侧对接

Node 侧客户端（`src/sources/chat/weixin/bridge.ts`）在所有面板里用同一套字段。本后端
只在 `rooms[].id` / `sender.id` 上做了**必要归一**：

- 群 `chatroomId`（含 `@`，过不了 Node 的 `^[A-Za-z0-9_-]+$`）→ `wxdb_g_<sha1[:16]>`；
  事件 `room` 与 `/rooms[].id` 用同一个归一 id，因此线程/策略能对上。
- 单聊事件按契约 `room: ""`，`threadRoot` 由 Node 取 `sender.id`；`/rooms` 仍会列出单聊
  候选（面板下拉需要），但私聊读取统一走 `room=""` 那条流。
- `at` 用消息 `create_time`（epoch 秒）转 ISO8601 UTC；无时间字段回落服务端时间。
- 群触发（`team` 档位）：Node 侧轮询 `GET /messages?room=<群归一 id>&cursor=<next>`，读库
  得到新消息作为触发源；sidecar 的 `/listen` 只把房间记进应答，**不订阅、不抢 UI**。

### 4.1 `team`（`pc-db`）与 `iLink`（`weixin-ilink-bridge`）分工

两者是**不同 profile、互补的两条路**，同一微信号不要同时用会抢界面的路径：

| 维度 | `pc-db` + `team`（本 sidecar） | `iLink`（`weixin-ilink-bridge`） |
|---|---|---|
| 收发通道 | 本地库读 + `wechatauto.Chat`（UIA/OCR）发送 | iLink 协议直连 |
| 抢 UI | 发送时占用界面（UIA + OCR） | 不占用本地界面 |
| 前提 | Windows 4.1.12+ 客户端在线、桌面可见 | iLink 网关可达、账号已绑定 |
| 适用 | 需要在 PC 客户端上真发、且能接受占界面 | 无 PC 客户端 / 不愿占界面 |
| 档位 | 只读用 `--profile readonly`（不占 UI），真发用 `--profile team` | — |

选型：**只想读不占界面** → `readonly`；**必须在 PC 微信上真发文本/文件/@** → `team`；
**完全不想占界面 / 无 PC 客户端** → 走 iLink。

## 5. 自测

`selftest.py` 用 `--fake` 在进程内起服务，断言 **71 项** HTTP 契约：第一段 54 项覆盖只读
档位（鉴权、错误码、八个端点、游标翻页、媒体字节、能力自述、只读 `/send` 501）；第二段
17 项覆盖 `--profile team`（`/send` 的 text/files/at/组合/幂等/校验错误 400·404，
`/listen` 200 记录房间，能力自述 `send:true`）。运行：

```powershell
python sidecar\weixin-db-bridge\selftest.py
# 期望输出：71 checks, 0 failure(s) / ALL PASS
```

真实微信验证：

```powershell
$env:WXBRIDGE_TOKEN="<token>"
# 只读：/health /status /rooms /members /messages 均只读
python sidecar\weixin-db-bridge\server.py --port 8788 --wechatauto-path ..\_analysis\wechatauto-replica
# team 真发（需完整 UIA 装好、微信在线、桌面可见）：
python sidecar\weixin-db-bridge\server.py --port 8788 --profile team --wechatauto-path ..\_analysis\wechatauto-replica
# curl POST /send {"room":"<群id>","text":"hi","at":["某成员"]} 观察界面发送与落库
```

## 6. 安全

- 只绑定回环地址；Bearer token 用 `hmac.compare_digest` 比对，缺失与错误一律 `401`。
- token 不落日志、不进错误体；`--verbose` 的堆栈也不包含 token（token 只在请求头里）。
- 只读档位：不改库、不 `AddListenChat`、不切会话。`team` 档位唯一会碰界面的是 `/send`
  （`wechatauto.Chat.SendMsg/SendFiles`）；`/listen` 始终只记录，不订阅。
- `files` 走绝对路径且必须存在；base64 `file` 的落盘文件名经 basename + 字符白名单净化，
  写入私有临时目录、发送后立即删除，避免目录穿越与残留。
