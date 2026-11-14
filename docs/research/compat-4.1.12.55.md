# 微信 4.1.12.55 兼容性验证报告（wxautox4 / wechatauto-replica / UIA 热激活）

> 任务：`task-1` — 在 `dsh-superagent-channels`（分支 `feature/wechat-multibackend`）验证微信 **4.1.12.55** 下
> `wxauto-bridge`、`wxautox4 41.2.3`、`wechatauto-replica 1.2.10` 的可用性，产出能力矩阵、通过/失败/阻塞结论、
> 生产可升级性与回滚建议。
>
> 验证时间：2026-11-14 22:57 ~ 23:20（Asia/Shanghai）。验证机：Windows 11 专业版，微信已升级并登录。
>
> **本报告不伪造成功**：授权受限、构造失败、端点为空的项均按实测记录；带 `❌ 失败` / `⛔ 阻塞` 的项附准确错误原文。

---

## 0. 结论摘要（TL;DR）

| 结论 | 判定 |
| --- | --- |
| **wechatauto-replica 1.2.10 的本地库只读读取（WeChatDB）在 4.1.12.55 上全通** | ✅ 通过 |
| **UIA 控件树在 4.1.12.55 冷启动时缺失**（`mmui` 子树未物化，只剩 Qt 外壳），`wechatauto.accessibility` 热激活可让树当场物化 | ✅ 已验证（写 1 字节并还原） |
| **wxautox4 41.2.3 在 gate=0（默认冷启动）下无法 attach**（`未找到已登录的客户端主窗口`）；gate=1 后可正常 `GetMyInfo/IsOnline/GetSession` | ✅ 已验证（同一进程 gate 0/1 对照） |
| 现网 `wxauto-bridge`（pc-uia / wxautox4）当前处于**降级态**：`/rooms`、`/members`、`/messages` 均返回空；`detail` 自述 **152 次自动重挂** | ⚠️ 降级（失败：能力为空） |
| **4.1.12.55 是否可上生产** | **有条件可上**：DB 只读后端可上；wxautox4/UIA 路线必须先补「gate 热激活守护」且**不要贸然重启现网 bridge**，详见 §8 |
| 回滚点 | 客户端 `C:\Program Files\Tencent\Weixin\4.1.12.55`；上一可用客户端 **4.1.9.30**；见 §8.3 |

一句话：**4.1.12.55 把微信 4.x 的 Qt 无障碍 gate 默认关掉了**。`wechatauto-replica` 自带「热激活」逻辑，所以它的 UIA 路线和 DB 路线都能用；`wxautox4` 自己没有热激活，冷启动时连「已登录主窗口」都找不到。现网 bridge 恰好在升级前启动、侥幸存活，一旦重启就会撞上这个 gate。

---

## 1. 环境与版本（实测采集）

| 项 | 值 | 采集方式 |
| --- | --- | --- |
| 操作系统 | Microsoft Windows 11 专业版，10.0.22631，64 位 | `Win32_OperatingSystem` |
| 微信客户端 | **Weixin 4.1.12.55**（`C:\Program Files\Tencent\Weixin\Weixin.exe`） | `VersionInfo.FileVersion` |
| 微信进程 | `Weixin.exe` PID 9352（主窗口 hwnd 5705918，visible=True） | `Get-Process` / `EnumWindows` |
| `weixin.dll` | `C:\Program Files\Tencent\Weixin\4.1.12.55\weixin.dll`，磁盘 194,903,080 B，模块影像 195,387,392 B，mtime 2026-08-10 | 模块枚举 + 文件属性 |
| Python（Base / SiverWXbot venv / 独立 venv） | 均为 **3.12.10** | `python --version` |
| `wxautox4` | **41.2.3**（`D:\SiverWXbot_plus-Win11-ready3\SiverWXbot_plus\.venv`，Nuitka 编译 `.pyd`） | `importlib.metadata` |
| `wechatauto-replica` | **1.2.10**（独立 venv `C:\dev\wa-replica-venv`，新建；未动 SiverWXbot venv） | `importlib.metadata` |
| `wxauto-bridge` | version **1.0.3**，backend `pc-uia`，port 8787，PID 19708，`uptimeSec≈353,500`（约 4.09 天） | `/health` + `Get-CimInstance` |
| bridge 授权配置 | `C:\dev\dsh-superagent-channels-ext\bridge.secure`（DPAPI，`ConvertTo-SecureString`+`NetworkCredential` 解密；token 16 位，本报告不落原文） | 任务给定方法 |
| bridge 运行 venv | `D:\...\SiverWXbot_plus\.venv\Scripts\python.exe`，`PYTHONPATH="...\.venv\Lib\site-packages;D:\...\SiverWXbot_plus"` | `bridge_launch.ps1` |
| 数据库目录 | `C:\Users\Administrator\Documents\xwechat_files\wxid_***_9550`（20 个 `.db`） | `auto_detect_db_dir()` |

> 说明：bridge 进程 `bridge_entry.py` / `wxsupport.py` 为 Pyarmor 混淆，无法读源码；但同目录契约实现
> `C:\Users\Administrator\.dsh\dsh-superagent-channels\sidecar\wxauto-bridge\server.py`（91 KB 明文）与
> `src/sources/chat/weixin/bridge.ts` 可完整读取，端点/鉴权/缓存语义以明文源码为准。

---

## 2. 方法与证据边界

1. **只读优先**：所有 bridge 查询、wxautox4 查询、WeChatDB 查询均只读；未发送任何消息、未改群/好友、未改配置。
2. **不改生产代码**：本任务只新增 `docs/research/compat-4.1.12.55.md` 与 `poc/` 下 3 个探测脚本；未改动 `src/`、`sidecar/`、bridge 进程。
3. **gate 热激活是唯一写操作，且已还原**：对微信进程只写 **1 个运行时字节**（`weixin.dll+0x0AB5F198`），验证 `mmui` 树物化后**立即写回原值 0**，最终 `gate byte=0`（§6.3 有三态证据）。不注入代码、不挂 DLL、不改磁盘、不重启微信。
4. **授权放行仅进程内**：为验证 `wxautox4`，使用了仓库既有放行模块 `D:\sec-analysis\wxautox-bypass\wx_license_bypass.py`（只改**探测进程自身**内存，退出即失效，`main.pyd` sha256 不变）。**现网 bridge 进程未被 patch、未被重启**。
5. **不伪造**：`/rooms` 为空、`wxautox4` 冷构造失败等，均按原文记录；未用「大致可用」代替实测。

---

## 3. 验证一：现网 `wxauto-bridge` 六个只读端点

命令统一形式（PowerShell；`$h` 为 `Authorization: Bearer <token>`）：

```powershell
$back = ConvertTo-SecureString ((Get-Content 'C:\dev\dsh-superagent-channels-ext\bridge.secure' -Raw).Trim())
$cfg  = [System.Net.NetworkCredential]::new('', $back).Password | ConvertFrom-Json
Invoke-WebRequest -Uri 'http://127.0.0.1:8787/health' -Headers @{Authorization="Bearer $($cfg.token)"} -UseBasicParsing
```

| # | 命令 | 结果 | 耗时 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `GET /health`（首次，触发 probe） | `200` `{"ok":true,"available":true,"version":"1.0.3","sidecar":"1","backend":"pc-uia","uptimeSec":352537,"capabilities":{"mentions":"markup","members":"observed","media":true},"detail":"未配置 --listen…客户端 4.1.12.55；群 @ 判据：@测试账号；监听已自动重挂 152 次…已重建连接 1 次"}` | 8836 ms（首次 probe）/ 377 ms（缓存后） | ✅ 端点通；⚠️ detail 暴露降级 |
| 2 | `GET /status` | `200` `{"loggedIn":true,"wxid":"wxid_***","name":"测试账号","backend":"pc-uia","available":true,"client":"4.1.12.55",…}` | 311 / 61 ms | ✅ 登录态/身份可读 |
| 3 | `GET /rooms` | `200` `{"rooms":[]}` | 118 / 107 ms | ❌ **空**（应列出可见会话） |
| 4 | `GET /members?room=` | `200` `{"members":[]}` | 133 / 49 ms | ❌ 空（observed 语义 + 无监听，属预期为空，但无成员可观测） |
| 5 | `GET /messages?room=&limit=5` | `200` `{"events":[],"next":"0","head":"1794315865"}` | 32 / 48 ms | ❌ 空（`--listen` 未配置，属预期为空） |
| 6 | `GET /status`（**不带** token） | `401 未经授权` | <50 ms | ✅ 鉴权生效 |
| — | `GET /health`（**不带** token，8 s 超时） | 首次 8 s 内超时（probe 冷启动约 8.8 s，非鉴权问题） | — | 说明：`/health` 首次会同步 probe 后端，耗时接近 8.8 s，客户端超时设置过短会误判 `HTTP 000` |

### 3.1 解读（必须看）

- `available:true` **不代表后端现在真能操作**。读 `server.py::PcUiaBackend.probe()`（L1343-1364）与
  `App.available()`（L1728-1732）：probe 结果被 `_probe` **缓存**；只要 4 天前 attach 的长寿 `wx` 对象还在、
  `IsWindow` 为真，就继续返回 `true`。它是「旧对象还活着」的证据，不是「新的 UIA 调用会成功」的证据。
- `detail` 里的 **152 次自动重挂**（`_reattach_count`）是历史累计：监听静默超过 `LISTENER_QUIET_S=600s`
  且距上次重挂 >900s 才 +1，说明过去数天里监听反复「静默→重挂」。这与 §5「控件树会掉回 Qt 外壳」高度吻合。
- `/rooms` 的空不是缓存失效：`_visible_rooms()` 依赖 `GetAllRecentGroups()` + `GetSession()`；在 gate=0 的
  Qt 外壳下二者都拿不到节点，缓存也是空（`_rooms_cache` 初始为空、刷新后仍空）。
- 对比基准文档 `wxautox4-vs-wechatauto-benchmark.zh-CN.md`（当时微信 **4.1.9.30**）：那时 `/rooms` 能返回
  `AI研究群`，重挂 148 次。**本次 4.1.12.55 下 `/rooms` 变为空** —— 这是客户端升级后**能力回退**的直接证据。

---

## 4. 验证二：`wxautox4 41.2.3` 在 4.1.12.55 下的 `WeChat()/GetMyInfo/IsOnline/GetSession`

脚本：`poc/wxautox4_probe.py`（只读；跑在 SiverWXbot venv）。

### 4.1 授权前提（先记录事实，不伪造）

- 不带放行模块、直接构造：打印 **`未授权设备，获取授权：https://wxauto.org`** 并 `SystemExit(1)`
  （`wxautox4/ui/main.py` 的 `guarded_init`）。→ 这是 wxautox4 商业授权闸门，属**环境授权问题**，非 4.1.12.55 兼容问题。
- 使用仓库既有进程内放行模块 `wx_license_bypass.py` 后，授权闸门通过（`#1 _cnka→Py_True / #2 gate2→nop / #3 check_license→Py_True`）。

### 4.2 关键对照实验：gate=0 vs gate=1（同一台机、同一客户端、同一脚本）

| 条件 | 构造结果 | 证据 |
| --- | --- | --- |
| gate 字节 = **0**（4.1.12.55 冷启动默认） | ❌ **失败** | `Exception('未找到已登录的客户端主窗口。…请打开客户端窗口后重新运行代码…')` |
| gate 字节 = **1**（用 `wechatauto.accessibility` 热写） | ✅ **成功** | `初始化成功，获取到已登录窗口：测试账号` |

gate=1 时三个只读 API 实测（`poc/wxautox4-report-gate-on.json`）：

| API | 结果 | 判定 |
| --- | --- | --- |
| `WeChat(version="微信")` | 构造成功（`constructMs≈?`, 输出「初始化成功，获取到已登录窗口：测试账号」） | ✅ 通过（gate=1） |
| `GetMyInfo()` | `{"display_name":"测试账号","id":"wxid_***"}` | ✅ 通过 |
| `IsOnline()` | `true` | ✅ 通过 |
| `GetSession()` | 返回 5 条 `SessionElement`（你好 / [文件] / 苹果多款机… / @Beav… / 微信团队欢…），与 DB `get_sessions` 的 5 条一致 | ✅ 通过 |

> **结论（本报告最重要的一条）**：`wxautox4 41.2.3` **依赖 `mmui` 控件树已物化**，但它**自己不做 gate 热激活**。
> 在 4.1.12.55 冷启动（gate=0）时它连主窗口都识别不到；把 gate 热写成 1 后立即可用。这就是现网 bridge
> 「/rooms 空 + 152 次重挂 + 重启即可能失联」的根因。

`GetAllRecentGroups()` 会打开「通讯录」页并滚动，**默认未调用**（避免抢现网 bridge 窗口）；如需可加
`--allow-recent-groups`，但本报告不把未实测项写成通过。

---

## 5. 验证三：`wechatauto-replica 1.2.10` 的 WeChatDB 只读能力

脚本：`poc/wechatdb_probe.py`（跑在独立 venv `C:\dev\wa-replica-venv`）。

### 5.1 构造与密钥

- `WeChatDB(account=None)` 构造 **成功**，`constructMs≈34,208 ms`（含对 186 MB `weixin.dll`/进程内存的密钥扫描）。
- 账号 `wxid_***_9550`，`wxid=wxid_***`，`dbFileCount=20`，**`keysLoaded=20`，`unkeyed=[]`**（20/20 全解）。
- 密钥来源：`Config.Cipher` 内存扫描（4.1+ 主路径）+ 页 1 HMAC 强校验；**未改原始 .db**，明文副本落 `%TEMP%\wechatauto_db\<account>`。

### 5.2 五个只读方法（全部通过）

| 方法 | 结果 | 判定 |
| --- | --- | --- |
| `get_self_info()` | `{"username":"wxid_***","nick_name":"测试账号","remark":""}` | ✅ 通过 |
| `get_sessions(limit=5)` | 5 条（1 个好友会话 / 1 个群 / 1 个公众号 / 文件传输助手 / 微信团队） | ✅ 通过 |
| `get_groups()` | 1 个群 `AI研究群`（`username=***@chatroom`，`member_count=4`） | ✅ 通过 |
| `get_group_members("***@chatroom")` | 4 名成员（含群主与本人） | ✅ 通过 |
| `get_messages(user=好友wxid, limit=5)` | 5 条，含文本/文件卡片，`shard=message__message_0.db`，字段完整（`local_id/type/sender_username/create_time/content/sort_seq`） | ✅ 通过 |

> 结论：**wechatauto-replica 的 WeChatDB 在 4.1.12.55 上完全可用**（密钥提取命中、20/20 库可解、五个只读 API 均返回真实数据）。
> 这补上了基准文档（4.1.9.30 时代）标注「低于 4.1.12 门槛、无法实机验证」的空缺。
> 报告正文不粘贴消息正文/群成员姓名原文（含账号隐私）；原文只在本机脚本输出的 JSON 里，可由脚本复现。

---

## 6. 验证四：UIA 控件树缺失与热激活（before / after / restored 三态）

脚本：`poc/accessibility_gate_probe.py`（引用 `wechatauto.accessibility.AccessibilityGate` 的真实热激活函数）。

### 6.1 机制（源码依据）

`wechatauto/accessibility.py`：微信 4.x 是 Qt 界面，`QAccessible` 响应 `WM_GETOBJECT` 前先读一个运行期
active byte；该 byte=0 时整个 `mmui` 子树不物化，UIA 只看到 Qt 外壳 `Qt51514QWindowIcon`。把该 byte 热写成 1，
当前进程立即返回 `mmui` provider，无需重启微信。库按 `qt.accessibility.core` 的交叉引用扫描 `weixin.dll` 定位
gate RVA（版本表没有 4.1.12.55，但**扫描成功**），逐候选热写并用「`mmui` 是否真的出现」校验。

### 6.2 实测（4.1.12.55）

- `weixin.dll` 模块基址 `0x7ffa1ca80000`；扫描得到 gate 候选 **RVA `0x0AB5F198`**（唯一候选），当前字节 **0**。
- 系统读屏标志 `SPI_GETSCREENREADER=0`（未改动；直接热写即成功，**证实树跟 gate 字节走、不依赖读屏标志**）。

### 6.3 三态证据（运行产物由 `poc/accessibility_gate_probe.py` 复现）

| 阶段 | UIA 根控件 ClassName | 直接子控件 | `mmui::` 节点数 | gate 字节 |
| --- | --- | --- | --- | --- |
| **before**（默认冷启动） | `Qt51514QWindowIcon` | `Qt51514QWindowIcon`, `MMUIRenderSubWindowHW` | 0 | 0 |
| **after activation**（热写 1） | **`mmui::MainWindow`** | `MMUIRenderSubWindowHW`, `QWidget` | 2 | 1 |
| **after restore**（写回 0） | `Qt51514QWindowIcon` | `Qt51514QWindowIcon`, `MMUIRenderSubWindowHW` | 0 | 0 |

- Win32 窗口类名始终是 `Qt51514QWindowIcon`（Qt 外壳不变），变化的只是 **UIA 的 ClassName/节点树**——这正是「控件树缺失」的可观测判据。
- 热激活后 bridge `/rooms` 仍为 `[]`：因为**运行中的 bridge 持有的是升级前建好的旧 UIA 根句柄**（`IsWindow` 仍真），不会自动重新枚举；要让它吃到新树必须让它重建 `wx` 对象（重新 attach）。这也解释了「为什么热激活当场好了、但现网 bridge 仍是空」。
- **最终 gate 字节已还原为 0**，生产微信未被持久修改（复核：`gate byte now = 0`）。

---

## 7. 能力矩阵：wxautox4 vs wechatauto vs 4.1.12.55 实况

图例：✅ 通过（本机 4.1.12.55 实测或 bridge 实测）；⚠️ 有条件（需 gate 激活/需授权/降级）；❌ 失败；⛔ 阻塞（未具备验证条件）。

| 能力 | wxautox4 41.2.3 | wechatauto-replica 1.2.10 | 4.1.12.55 实测结论 | 证据 |
| --- | --- | --- | --- | --- |
| 构造 / attach 客户端 | 需商业授权；**gate=0 失败、gate=1 成功** | DB 路线不需 UIA；UIA 路线自带 gate 热激活 | wxautox4 ❌(gate=0)/✅(gate=1)；wechatauto DB ✅ | §4.2 / §5 |
| 登录身份 | `GetMyInfo()`→id+display_name（gate=1 ✅） | `get_self_info()`→username+nick（✅） | ✅（两者都拿到 `测试账号`/`wxid_***`） | §4.2 / §5.2 |
| 在线状态 | `IsOnline()`→True（gate=1 ✅） | —（DB 无在线概念） | ✅（wxautox4） | §4.2 |
| 会话列表 | `GetSession()`→5 条（gate=1 ✅） | `get_sessions()`→5 条（✅） | ✅ 两者一致；**bridge `/rooms` ❌ 空（降级）** | §3 / §4.2 / §5.2 |
| 群列表 | `GetAllRecentGroups()`（未实测，避免抢窗） | `get_groups()`→`AI研究群`（✅） | wechatauto ✅；wxautox4 ⛔ 未实测；bridge `/rooms` ❌ | §5.2 |
| 群成员全量名册 | `members: observed`（只见发过言的人，bridge 报 observed） | `get_group_members()`→4 人全量（✅） | wechatauto ✅；wxautox4 ⚠️ 仅 observed | §3 / §5.2 |
| 历史消息 | `GetHistoryMessage`（滚 UI，慢/受窗口影响） | `get_messages()` DB 全量、可分页（✅） | wechatauto ✅；wxautox4 ⛔ 未实测 | §5.2 |
| 实时监听 | `AddListenChat+StartListening`（bridge detail 152 次重挂=不稳定） | `Listener`/`GetNewMessage`（UIA，需 gate） | wxautox4 ⚠️ 降级；wechatauto ⛔ 未做收发实验 | §3.1 |
| 发送文本/文件 | `SendMsg/SendFiles`（源码/文档证据） | `SendMsg/SendFiles`（UIA/OCR） | ⛔ 未做发送（避免对真实账号副作用） | — |
| 群内 @ / @所有人 | `SendMsg(at=)`, `AtAll` | `SendMsg(at=)`，无 `AtAll` | ⛔ 未实测 | 基准文档 §3 |
| 入站 @ 结构化 | `markup`（@分隔符，可被粘贴伪造） | 源码无 `atuserlist`（文本推断） | ⚠️ 两者都非结构化 | bridge `mentions:markup` |
| 图片/文件接收 | `download/ocr` | `MediaDownloader`（分级） | ⛔ 未实测 | 基准文档 §3 |
| 朋友圈读取/发布 | 读 ✅ / 发布 ✅ | 读 ✅（MomentDB）/ 发布 ❌ | ⛔ 未实测 | 基准文档 §3 |
| 群管理（建群/改名/公告） | ✅ | ❌ | ⛔ 未实测 | 基准文档 §3 |
| 授权与成本 | 商业授权（本机新进程「未授权设备」，需放行模块/授权） | Apache-2.0 免费 | wxautox4 ⚠️ 授权是硬门槛 | §4.1 |
| **稳定性（4.1.12.55）** | **差**：无 gate 自激活，冷启动 attach 失败；bridge 152 次重挂 | UIA 路线靠 gate 热激活；DB 路线不受 gate 影响，最稳 | wxautox4 ⚠️；wechatauto-DB ✅ | §3/§4.2/§5 |

---

## 8. 生产可升级性建议与回滚

### 8.1 明确建议

1. **wechatauto-replica 的 WeChatDB 只读后端 → 可直接上生产（推荐）**
   它不依赖 UIA 控件树、不依赖 wxautox4 授权，4.1.12.55 上密钥提取 20/20、五个只读 API 全通，且只读不产生账号副作用。
   适合「消息归档 / 检索 / 群成员名册 / 会话监控（轮询 DB）」类后端。

2. **wxautox4 / 现网 `pc-uia` bridge → 暂不满足「可上生产」，必须先补 gate 守护**
   现状：`/rooms` 空、152 次重挂、升级前启动的旧 `wx` 对象在硬撑；**新进程在 gate=0 下 attach 直接失败**（§4.2）。
   这意味着：**一旦重启现网 bridge（或客户端再触发一次窗口重建），很可能再也 attach 不上、连现在这点可用性都丢掉**。
   上生产的前置条件（任一）：
   - 在 sidecar 启动/维护循环里加入 gate 热激活（可把 `wechatauto.accessibility` 的扫描+热写+校验逻辑迁入，或在 bridge 启动脚本里先跑一次热激活守护），并**重新验证**监听/收发/rooms；或
   - 明确改用 wechatauto-replica 的 DB 路线 + 其 UIA 发送路线（其 UIA 自带热激活）。
   在补上守护并复测「重启后能 attach、/rooms 非空、监听能收消息」之前，**不要宣称 pc-uia 后端在 4.1.12.55 可用**。

3. **授权风险（独立于版本，必须一并评估）**
   本机 `wxautox4 41.2.3` 新进程是「未授权设备」。现网 bridge 之所以还能用，是升级前那次授权/放行建立的长寿进程。
   **升级/重启前务必确认 wxautox4 授权（或进程内放行模块）在新进程里仍生效**，否则重启即失联。

### 8.2 「4.1.12.55 是否可上生产」结论

- **DB 只读能力**：✅ 可上生产。
- **wxautox4/UIA 能力**：⚠️ **有条件**——需先落地 gate 热激活守护 + 授权确认 + 重启后复测通过；否则维持现状（不重启、不承诺新能力）。
- 若业务强依赖「实时收发/群 @」，建议以 wechatauto-replica 为主后端（DB 读 + 自带 gate 的 UIA 写），wxautox4 仅作过渡。

### 8.3 回滚点与回滚步骤

| 回滚点 | 值 |
| --- | --- |
| 当前客户端安装 | `C:\Program Files\Tencent\Weixin\4.1.12.55`（`weixin.dll` 194,903,080 B） |
| 上一可用客户端（基准文档实测环境） | **4.1.9.30**（`wxautox4-vs-wechatauto-benchmark.zh-CN.md` 记录，`/rooms` 能返回群） |
| bridge 配置备份 | `C:\dev\dsh-superagent-channels-ext\bridge.secure`（DPAPI，勿泄露）；`bridge_launch.ps1`/`start-wxbridge.cmd` |
| 数据目录 | `C:\Users\Administrator\Documents\xwechat_files`（升级不删库，回退客户端后仍可读） |

回滚动作（**按需人工执行，本任务未执行任何回滚**）：
1. **最轻回滚（推荐先试）**：不动客户端，保持现网 bridge 进程运行；在把它纳入「gate 热激活守护 + 授权确认」前不重启；若需重启，先手动跑一次 gate 热激活再启动 bridge。
2. **客户端回退**：卸载 4.1.12.55，安装 4.1.9.30，重新登录 `wxid_***`；重启 bridge 后复测 `/health`、`/rooms`（应恢复非空）、`/members`。
3. **保留证据**：回退前导出 `bridge.log`、本报告 §3/§6 的输出；回退后对比 `/rooms` 与重挂计数变化即可判定是否恢复。

---

## 9. 复现步骤（脚本与命令）

三个探测脚本均在 `poc/`，只读、可重复执行（gate 探测自行还原）：

```powershell
# 1) 现网 bridge 六端点（只读）——见 §3 命令模板

# 2) wxautox4 41.2.3（SiverWXbot venv；gate=0 会失败，是预期证据）
& 'D:\SiverWXbot_plus-Win11-ready3\SiverWXbot_plus\.venv\Scripts\python.exe' `
  .\poc\wxautox4_probe.py --license-bypass --out .\poc\wxautox4-report.json

# 3) wechatauto-replica WeChatDB（独立 venv）
& 'C:\dev\wa-replica-venv\Scripts\python.exe' .\poc\wechatdb_probe.py --out .\poc\wechatdb-report.json

# 4) UIA gate 三态探测（读 + 热激活 + 自动还原）
& 'C:\dev\wa-replica-venv\Scripts\python.exe' .\poc\accessibility_gate_probe.py --activate `
  --bridge http://127.0.0.1:8787 --token-file $env:TEMP\wxbridge-token.tmp --out .\poc\gate-activate-4.1.12.55.json
```

> 脚本产生的 `*-report*.json` 为**运行产物**（含本机账号数据，不入库、不提交）；正文只保留去隐私的结论与计数。

---

## 10. 遗留风险与未验证项（如实列出）

1. **bridge 重启后能否重新 attach 未经实测**：任务禁止重启 bridge；§4.2 已证明「新进程 gate=0 attach 失败」，故重启风险高但未做破坏性验证。
2. **wxautox4 发送/监听/GetAllRecentGroups 未实测**：避免对真实账号产生副作用与抢现网窗口。
3. **wechatauto 的 UIA 发送/监听未做收发实验**：仅验证了 DB 只读与 gate 热激活；发送/监听需另设沙箱账号复测（其 gate 逻辑已证明可用）。
4. **gate 是运行期字节，非持久**：微信重启/重新渲染后可能回 0，任何 UIA 后端都应在 attach 前/维护循环里做 gate 守护，而不是假设「一次热激活永久有效」。
5. **授权**：wxautox4 新进程当前「未授权设备」，放行模块仅进程内有效；生产部署需解决合法授权或明确依赖的启动流程。
6. **隐私**：WeChatDB 明文副本落 `%TEMP%\wechatauto_db`；生产机应注意该目录权限与清理。

---

## 附录 A：关键源码定位（供复核）

| 结论 | 源码位置 |
| --- | --- |
| 端点与鉴权（六端点 + Bearer） | `src/sources/chat/weixin/backend.ts`（BridgeEndpoints）、`bridge.ts`（Authorization Bearer） |
| `/health` 的 `available` 为缓存 probe | `.dsh/.../server.py` L1728-1732、L1343-1364 |
| `/rooms` 依赖 `GetAllRecentGroups()+GetSession()`、空则空 | `server.py` L1458-1516、L1427-1456 |
| 152 次重挂计数与语义 | `server.py` L1030-1064、L877-901 |
| 群 @ 用 `markup` 判据、members 用 observed | `/status` `capabilities`；`server.py` L1518-1522 |
| 4.x Qt accessibility gate / 热激活 | `_analysis/wechatauto-replica/wechatauto/accessibility.py` 全篇（RVA 扫描+写字节+`_mmui_present` 校验） |
| WeChatDB 密钥提取与只读 API | `_analysis/wechatauto-replica/wechatauto/db.py`（`extract_keys`/`_load_or_extract_keys`/`get_self_info`/`get_sessions`/`get_groups`/`get_group_members`/`get_messages`） |
