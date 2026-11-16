# weixin-ilink-bridge —— 腾讯 iLink Bot 后端 sidecar（PoC）

把腾讯 **iLink Bot**（微信「龙虾」ClawBot，协议参考官方 `@tencent-weixin/openclaw-weixin@2.4.6`）
封装成现有 `wxauto-bridge` 的**冻结 HTTP 契约**（见 [../wxauto-bridge/contract.md](../wxauto-bridge/contract.md)），
供 `src/sources/chat/weixin/bridge.ts` 直接当作一个后端使用。

- **Node 18+，零第三方依赖**：只用内置 `http/crypto/fs` + 全局 `fetch`。
- 协议客户端与 CDN/AES 实现 **vendored** 自 MIT 的 [gtaifu/dsh-wechat-bridge](https://github.com/gtaifu/dsh-wechat-bridge)
  （`lib/ilink.mjs`、`lib/ilink-media.mjs`，Copyright (c) 2026 Xiang Fu，见 [LICENSE](./LICENSE)）；
  本目录的 HTTP 桥接与归一化是本仓库自有实现。
- 只监听回环地址；Bearer token 保护全部端点；日志不打印任何 token 值。

---

## 1. 端点（对齐 contract.md §1）

| # | 方法 | 路径 | 说明 |
|---|---|---|---|
| 1 | GET | `/health` | `{ok,available,version,sidecar:"1",backend:"ilink",uptimeSec,capabilities:{mentions:"none",members:"observed",media},detail?}` |
| 2 | GET | `/status` | `{loggedIn,wxid,name,backend:"ilink",client:"ilink",available,lastEventAt?,detail?}` |
| 3 | GET | `/rooms` | `{rooms:[{id,name}]}`：**仅单聊对端**（iLink 不提供群会话，不伪造；群列表恒空） |
| 4 | GET | `/members?room=<id>` | `{members:[{id,name}]}`：`members:"observed"`，单聊即该对端；未知 room 返回 `[]` |
| 5 | GET | `/messages?room=&limit=&cursor=` | `{events,next,head}`，事件字段见 §3；后台长轮询 `getUpdates` + 游标 |
| 6 | POST | `/send` | `{room,text,quoteId?}` → `sendmessage`，**必须回传该会话的 `context_token`**；返回 `{msgId,deduped}` |
| 7 | GET | `/media/<id>` | 图片/文件 CDN 下载 + AES-128-ECB 解密；不支持的类型/构建 → `501` |
| 8 | POST | `/listen` | `{rooms:[...],options?}` 记录监听集合（iLink 无服务端订阅，仅本地记录） |

- 鉴权：每个请求带 `Authorization: Bearer <token>`，缺失/不符 → `401 {"error":"unauthorized"}`。
- 错误体统一 `{"error":"<code>", "detail?": "..."}`；未知路径 `404 not_found`，方法不符 `405 method_not_allowed`（带 `Allow`）。
- 后端不可用（未登录 / token 失效 -14）时：`/health`、`/status` 仍 `200` 并在体内 `available:false`+`detail`；
  数据端点返回 `502 unavailable`。

### 事件字段（contract.md §3）

```json
{
  "nativeId": "1001",
  "room": "",
  "sender": { "id": "ilink_3da351bad1d722cb", "name": "tester" },
  "text": "你好",
  "at": "2026-11-14T04:01:02Z",
  "ats": [],
  "own": false,
  "quoteId": "",
  "media": [{ "id": "1002#0", "kind": "image" }]
}
```

- **单聊 `room` 恒为 `""`**（契约要求）；Node 侧 `threadRoot = room || senderId`，按发送人分线程。
- `sender.id` 用 `ilink_<sha1(userId)[:16]>` 归一（满足 Node 侧 `^[A-Za-z0-9_-]+$`；`/rooms`、`/members`、`/send`、`/listen` 同用此 id）。

---

## 2. 快速开始

### 2.1 扫码登录（保存凭证）

```bash
cd sidecar/weixin-ilink-bridge
node server.mjs login --auth-file ./data/weixin-ilink-auth.json
```

终端会打印 **二维码链接**（`qrcode_img_content`，用手机微信打开）。扫码后在手机确认；若提示配对码，按终端提示输入手机显示的数字。
成功后凭证写入 `data/weixin-ilink-auth.json`（含 `token`、`baseUrl`、`botId`、`userId`、`loggedInAt`）。
**该文件等同账号凭证，请限制权限，勿提交仓库。**

> 无需 `qrcode-terminal` 等额外依赖：直接把打印出的链接在手机微信里打开即可。

### 2.2 准备 HTTP Bearer token

sidecar 的 HTTP 端点用独立 Bearer token 保护（与 iLink 凭证无关）。写一个随机串到文件，并收紧权限：

```powershell
New-Item -ItemType Directory -Force ..\..\secrets | Out-Null
# 生成随机 token（示例）
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" > ..\..\secrets\ilinkbridge.token
icacls ..\..\secrets\ilinkbridge.token /inheritance:r /grant:r "$($env:USERNAME):R"
```

### 2.3 启动

```bash
node server.mjs run --port 9300 --host 127.0.0.1 \
  --token-file ../../secrets/ilinkbridge.token \
  --auth-file ./data/weixin-ilink-auth.json
```

或直接双击/调用仓库根 `sidecar/start-weixin-ilink.cmd`（见文件内注释）。

自检（不碰真实微信，mock 服务端）：

```bash
node selftest.mjs
```

---

## 3. 参数与环境变量

| 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--port` | `WXBRIDGE_PORT` | `9300` | HTTP 端口；`WXBRIDGE_PORT` 优先（`0`=让 OS 分配空闲端口）。 |
| — | `WXBRIDGE_PORT_FILE` | — | 若设置（绝对路径），绑定成功后把**实际监听端口**写入该文件（每次启动覆盖，父目录自动创建）。 |
| `--host` | — | `127.0.0.1` | 绑定地址（**勿改成 0.0.0.0**） |
| `--token` / `--token-file` | `ILINK_BRIDGE_TOKEN` | — | HTTP Bearer token（**必填**，建议用文件） |
| `--auth-file` | `ILINK_BRIDGE_AUTH_FILE` | `./data/weixin-ilink-auth.json` | 扫码凭证文件 |
| `--base-url` | — | `https://ilinkai.weixin.qq.com` | iLink 端点（可指向 mock/测试） |
| `--channel-version` | — | `2.4.6` | `base_info.channel_version` |
| `--sync-buf-file` | `ILINK_BRIDGE_SYNC_BUF` | `./data/weixin-ilink-syncbuf.txt` | `getUpdates` 游标持久化 |
| `--no-media` | — | 关闭 | 关闭媒体下载能力（`/media` → `501`，`capabilities.media=false`） |
| `--poll-idle-ms` | — | `300` | 长轮询空转间隔（避免 mock/异常空响应忙等） |
| `--media-cache-ttl` | — | `300` | `/media` 解密字节缓存秒数 |
| `--min-send-gap-ms` | — | `1000` | 相邻两次 `/send` 最小间隔（契约 §6） |

端口冲突时可随机端口启动并回显实际地址：

```bat
set WXBRIDGE_PORT=0
set WXBRIDGE_PORT_FILE=%TEMP%\dsh-weixin\bridge-personal.port
start-weixin-ilink.cmd
rem 绑定后实际端口写入 bridge-personal.port（十进制文本）
```

端口优先级：`WXBRIDGE_PORT` 环境变量（`"0"` 合法）> `--port` > 默认 `9300`。
`WXBRIDGE_PORT_FILE` 由子进程继承，脚本无需重设。

---

## 4. 媒体（入站图片/文件解密）

iLink 消息的图片/文件走微信 CDN：`item.<kind>_item.media.{encrypt_query_param, full_url, aes_key}`。
本 sidecar 在 `/media/<id>` 上用 AES-128-ECB（PKCS7）解密后返回原始字节：

- 图片：`Content-Type` 按魔数嗅探（png/jpeg/gif/webp/bmp），`media[]` 只列图片（契约要求 `kind:"image"`）。
- 文件：按文件名推断 MIME（`report.txt` → `text/plain`），同样支持解密下载。
- 语音/视频：本 PoC 不做转码/解密 → `501 unsupported`。
- 空载荷 → `404`（**零字节规则**，绝不返回 `200` + 0 字节）。媒体字节进程内缓存 300s（`--media-cache-ttl`）。

> **Node 侧消费范围**：`bridge.ts` 的 `media()` 只接受 `image/*` 的 `Content-Type`（契约 §5 只定义图片）。
> 文件类 `/media` 响应在本 sidecar 上可用（curl 可直接取到解密后的原始字节），但当前 Node 客户端会拒绝非图片类型——
> 这是契约层的既有边界，不是本 sidecar 的缺陷。

> `/send` 本 PoC 仅支持**文本**（含 `context_token` 回传与 `Idempotency-Key` 去重）；出站文件暂返回 `501`。

---

## 5. iLink 已知限制（务必阅读）

1. **凭证约 24 小时有效**：iLink Bot 登录态由腾讯服务端决定（社区实测约 24h）。失效时 `getUpdates` 返回
   `errcode/ret = -14`，sidecar 将 `available:false` 并提示重新扫码。`/status` 不提供剩余时间权威值——以服务端为准。
2. **发送条数/频率受限**：iLink Bot 免费额度有限（社区反馈量级约 **每会话/每日 10 条级别**，具体以腾讯官方为准）。
   超限会被限流/拒发，`sendmessage` 可能返回非 0 `ret`，本 sidecar 会映射为 `409 gone`/`502 unavailable`。
3. **仅单聊，无群**：iLink Bot 协议不提供群会话、群成员表与群 `@`。因此：
   - `/rooms` 只列观测到的单聊对端，群列表恒空（**不伪造群**）；
   - `capabilities.mentions = "none"`（`ats` 恒 `[]`）、`members = "observed"`；
   - 依赖群 `@` 的工单不要接在该实例上。

---

## 6. 自检覆盖（selftest.mjs）

mock iLink 服务端 + 进程内起 bridge，覆盖 **200 / 401 / 404 / 501** 与消息字段：

- `200`：`/health` `/status` `/rooms` `/members` `/messages` `/send` `/media`（图片+文件）`/listen`
- `400`：`/send` 非法 JSON / 缺 `text`；`/listen` `rooms` 非数组
- `401`：缺 token / 错 token；`404`：未知路径 / 未知媒体 id；`405`：方法不符（带 `Allow`）
- `409`：未知会话 / 无 `context_token`；`501`：语音媒体不支持；`502`：未登录后端的数据端点
- 消息字段：`nativeId`、`room=""`、`sender.id`、`text`、`at`（ISO8601 UTC 秒级 `Z`）、`ats`、`own`、`media`
- `/send` **回传 `context_token`** + `Idempotency-Key` 去重；`/messages` 游标推进与空页；`/media` 缓存命中

运行：`node selftest.mjs`（预期 `83 通过，0 失败`）。
