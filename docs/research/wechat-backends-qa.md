# 微信多后端 QA 报告（weixin-db-bridge / weixin-ilink-bridge）

> 目的：为「微信多后端」特性做质量门——验证 `sidecar/weixin-db-bridge`（后端 `pc-db`）与
> `sidecar/weixin-ilink-bridge`（后端 `ilink`）是否严格实现 `sidecar/wxauto-bridge/contract.md` 的冻结契约，
> 并对现有 `src` 做全量回归，给出上线准入结论。
>
> 报告日期：2026-11-14。分支：`feature/wechat-multibackend`（本地需求分支，未 commit/push，由 Lead 统一提交）。
> 测试机：Windows；Node **v24.21.0**（DSH 内置 runtime，测试用 `process.execPath` 启动 sidecar）；
> Python **3.12.10**。**无微信客户端、无真实账号**——全部用 fake/mock 数据，跨平台可复现。
>
> 范围约束：本 QA 只写 `tests/**` 与本文档；未修改任何生产 `src` / `sidecar` 代码（发现问题只报告）。

---

## 1. 范围与方法

被测对象：

| 后端 | 目录 | 语言/运行时 | 默认端口 | 契约实现 |
| --- | --- | --- | --- | --- |
| `pc-db` | `sidecar/weixin-db-bridge` | Python 3.10+ 纯标准库 | 8788 | 只读子集：健康/状态/会话/成员/消息/媒体；`/send` 默认 501 |
| `ilink` | `sidecar/weixin-ilink-bridge` | Node 18+ 零依赖 | 9300 | 全端点：单聊会话/消息/发送（context_token）/媒体 AES 解密 |

测试分三层，全部无真实微信：

1. **后端自带 selftest**（视为被审计对象的一部分，独立复跑取数字）：
   - `sidecar/weixin-db-bridge/selftest.py`：进程内 `--fake` 后端 + `ThreadingHTTPServer`，逐项断言 HTTP 契约。
   - `sidecar/weixin-ilink-bridge/selftest.mjs`：内置 mock iLink 服务端 + 进程内 bridge。
2. **新增独立跨进程契约测试** `tests/weixin-bridge-contract.spec.ts`（本次交付）：不依赖后端自测代码，用**真实子进程 + 原生 `fetch`** 从外部驱动：
   - `pc-db`：`python server.py --fake --port <随机> --token <随机> --quiet` 起真实 HTTP 进程；
   - `ilink`：进程内起一个 mock iLink 服务端（getUpdates / sendmessage / notify / CDN 下载），写临时 auth 文件，再 `node server.mjs run --base-url <mock>` 起真实 HTTP 进程。
   - 两个后端目录缺失或解释器不可用时**自动 skip**，默认套件在纯 TS 环境也不会红。
3. **全仓回归**：`tsc --noEmit`、`vitest run --maxWorkers=2`、`tsdown`。

---

## 2. 测试命令与结果（完整数字）

| # | 命令 | 结果 | 数字 / 关键输出 |
| --- | --- | --- | --- |
| 1 | `python sidecar/weixin-db-bridge/selftest.py` | ✅ PASS | `54 checks, 0 failure(s)` / `ALL PASS` |
| 2 | `node sidecar/weixin-ilink-bridge/selftest.mjs` | ✅ PASS | `83 通过，0 失败，共 83 项` |
| 3 | `vitest run tests/weixin-bridge-contract.spec.ts --maxWorkers=1` | ✅ PASS | `15 passed`（pc-db 8 + ilink 7），约 2.6s |
| 4 | `tsc --noEmit` | ✅ PASS | exit 0，无任何诊断 |
| 5 | `vitest run --maxWorkers=2`（全量） | ✅ PASS | **Test Files 103 passed \| 5 skipped (108)；Tests 1639 passed \| 41 skipped (1680)**；127.73s |
| 6 | `tsdown` | ✅ PASS | exit 0；ESM **31 files, total 1.02 MB**（`lib/index.js` 479.24 kB / gzip 136.77 kB）；CJS `lib/client.js` 362.59 kB / gzip 87.92 kB |

对照基线（新增 spec 之前）：全量 vitest = `102 passed \| 5 skipped (107 files)`、`1624 passed \| 41 skipped (1665 tests)`。
本次新增 **+1 文件 / +15 测试**，其余无回归。

> 说明：新增 `tests/weixin-bridge-contract.spec.ts` 后，仓库既有的一致性测试 `tests/docs.spec.ts`
> （“lists every test in the test table of 007 Architecture”）要求 `docs/007-architecture.md` 的 `## Tests` 表
> 列出每个 `tests/**/*.spec.ts`。经 Lead 授权，已在 `## Tests` 表**追加一行**（仅此一行），`docs.spec.ts` 6/6 通过。

复现所需解释器路径（本机）：Node `…\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe`；
Python `…\dependencies\python\python.exe`（或系统 `python`）。

---

## 3. 契约覆盖矩阵（tests/weixin-bridge-contract.spec.ts）

| 端点 / 语义 | `pc-db`（--fake） | `ilink`（mock iLink） |
| --- | --- | --- |
| `GET /health` 200 | ok/available=true、`backend:pc-db`、`sidecar:"1"`、`capabilities{members:"full",mentions∈{none,markup},media:true}` | ok/available=true、`backend:ilink`、`capabilities{mentions:"none",members:"observed",media:true}` |
| `GET /status` 200 | `loggedIn:true`、`wxid`、`backend:pc-db`、`client` | `loggedIn:true`、`wxid=botId`、`backend:ilink`、`client:"ilink"` |
| `GET /rooms` 200 | 群 + 单聊候选（含 group id/name） | 单聊对端 `ilink_<hex16>` |
| `GET /members` 200 | 群全量名册（self + alice）；未知 room → `[]` | 观察到的对端；未知 room → `[]` |
| `GET /messages` 200 | §3 全字段 + 游标分页 | §3 全字段 + 游标分页 |
| `GET /media/<id>` | 200 `image/png` + PNG 魔数；未知 → 404 | 200 图片/文件（AES-128-ECB 解密=明文）；语音 → 501；未知 → 404 |
| `POST /send` | 501 `unsupported`（只读默认） | 200 `{msgId,deduped}`；**回传 context_token**；`Idempotency-Key` 去重同 msgId |
| `POST /listen` | 200 `listening/added/removed/failed`；未知进 failed；空集合清空 | 200 `listening/added/removed/failed`；空集合 `removed` 含对端 |
| `401` | 缺 token / 错 token → `unauthorized` | 缺 / 错 token → 401 |
| `404` | 未知路径 / 未知媒体 id → `not_found` | 未知路径 / 未知媒体 id → `not_found` |
| `405` | `GET /send` → `Allow: POST`；`POST /health` → `Allow: GET` | `POST /health` → `Allow: GET` |
| `400` | 非法 JSON、`rooms` 非字符串数组 → `bad_request` | `rooms` 非字符串数组 → `bad_request` |
| token 卫生 | child stderr 不含 token，仅 `token=set` | child stderr 不含 HTTP bearer token |

### 3.1 事件字段（contract §3）

两个后端都对 `GET /messages` 的每条事件断言：
`nativeId`（唯一，去重键）、`room`（组群为群 id；**单聊恒 `""`**）、`sender{id,name}`、`text`（**永远非空**）、
`at`（`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$` ISO8601 UTC 秒级）、`ats`（数组；两后端均无群 @ 能力，恒 `[]`）、
`own`（bool）、`quoteId`（string）、`media`（数组）。图片事件 `media[0]` 形如 `{id:"<nativeId>#0", kind:"image"}`。

### 3.2 分页与媒体（contract §4 / §5）

- **游标**：用上一页 `next` 再读 → `events: []` 且 `next` 原样返回（两后端均验证）。
- **媒体**：`pc-db` 返回 `image/png` 且前 8 字节为 PNG 魔数；`ilink` 图片/文件解密后字节与 mock 明文逐字节相等。
- **零字节规则**：未知媒体 id 一律 `404`（绝不出现 `200 + 0 字节`）；`ilink` 语音 → `501 unsupported`。

---

## 4. 风险与互斥分析（task-4 第 3 点）

### 4.1 两个新后端是否修改现有 `src` 行为

- `weixin-db-bridge` / `weixin-ilink-bridge` 都是**独立 sidecar 进程**，Node 侧（`src/sources/chat/weixin/*`）不 import 它们，仍只通过 `bridge.ts` 的冻结 HTTP 契约通信——**新增后端不改变任何 `src` 运行逻辑**。
- 工作区当前唯一 `src` 变更是 `src/sources/chat/weixin/kind.ts` 的**提示文案/注释**（把 “wxauto-bridge” 扩为三后端说明），属产品化集成（task-5 scope），**非功能性**；`tsc` 与全量 vitest（含 `weixin-kind.spec.ts`）均通过。
- 证据：`git diff src` 仅上述文案 diff；`weixin-bridge-contract.spec.ts` 15/15、全量 1639/1639 通过。

### 4.2 是否与 `wxauto-bridge` 同时运行造成 UI 抢占

| 组合 | 结论 | 说明 |
| --- | --- | --- |
| `pc-db`（只读，默认） | **无窗口争用** | 只读 SQLCipher 本地库，不驱动 UIA、不 `AddListenChat`/`StartListening`、不切会话；`/listen` 仅做「认不认得」应答 |
| `pc-db --allow-send` | **有 UI 抢占风险** | 发送走 `wechatauto.guia.quick_send`（UIA + OCR）；与 `wxautox4`/`wxauto` 等任何 UI 自动化客户端**同一微信号同一时刻只能有一个操作界面**，否则抢焦点 |
| `ilink` | **无窗口争用** | 走腾讯 iLink Bot 官方协议（HTTP 长轮询 + CDN），完全不碰本机微信客户端界面 |
| 登录态互斥 | **红线** | 同一微信号同一时刻只允许一个实例持有登录态（双开/双发/风控）；`pc-db` 与 `wxauto-bridge` 指向同一账号时不得同时以发送态运行 |
| 端口 | **默认不冲突** | wxauto-bridge=8787、weixin-db-bridge=8788、weixin-ilink-bridge=9300 |

建议：生产环境每个 Source 只指向一个后端的 launcher 与 `baseUrl`；`pc-db` 默认只读部署；确需发送时确认该账号无其它 UI 自动化在跑，或改用 `ilink`（不占界面）。

---

## 5. 未覆盖项（诚实声明）

1. **真实微信 / 真实账号端到端**：本机无微信客户端，全部 fake/mock。真实收发、真实 UI 行为未在本次覆盖。
2. **真实 wechatauto-replica 读库**：需安装 + 微信 4.1.12+ 且库可解密。真实 DB 读通由 task-1（`docs/research/compat-4.1.12.55.md`）在 4.1.12.55 上验证，非本报告的 fake 路径；测试不依赖真实微信/真实 DB。
3. **iLink 真实链路**：真实扫码登录、24h 凭证过期（-14）、每会话约 10 条/日限流、真实 CDN 解密——本报告仅用 mock 服务端验证协议层与 HTTP 契约，未打真实腾讯服务。
4. **群 `@`**：`pc-db` 与 `ilink` 的 `capabilities.mentions` 均为 `"none"`（不适用），未做群 @ 判定测试；依赖群 @ 的工单不应接到这两个实例上。
5. **媒体边界**：大文件、超时、`--media-cache-ttl`（默认 300s）失效边界未穷举；仅验证 1×1 PNG 与一个小文本文件的解密/下载。
6. **Windows UI 并发抢占**：仅按实现与文档做**静态分析**，未在同一台已登录微信机器上做并发争用实测。
7. **发送串行/节流**：`pc-db --allow-send` 与 `ilink` 的≥1s 间隔、抖动、进程内串行仅在 fake/mock 语义层间接验证，未做高频真实发送压测。

---

## 6. 上线准入（Release Gate）

| 门禁项 | 结论 | 依据 |
| --- | --- | --- |
| 契约一致性（200/400/401/404/405/501、事件字段、分页、媒体、token 卫生） | ✅ 通过 | `tests/weixin-bridge-contract.spec.ts` 15/15 |
| 后端自带自测 | ✅ 通过 | db 54/54；ilink 83/83 |
| 类型检查 | ✅ 通过 | `tsc --noEmit` exit 0 |
| 全量单元/集成回归 | ✅ 通过 | vitest 1639 passed / 0 failed（41 live-skip 属环境门控） |
| 构建 | ✅ 通过 | `tsdown` exit 0 |
| 真实账号 E2E（收发/媒体/登录态） | ⚠️ 条件项 | 上线前必须在目标机用真实账号各跑一轮烟测；`ilink` 需验证扫码续期与限流 |
| 版本矩阵（微信 4.1.12.55） | ⚠️ 参考 task-1 | 见 `docs/research/compat-4.1.12.55.md` |
| 发布内容合规 | ✅ 通过 | 未把 wxautox4 逆向/绕过/授权规避包进发布；`pc-db` 如实以 `available:false`+`detail` 报不可用，不伪造 |

**结论**：契约与回归门禁（PASS 项）全部通过，可合并；**「可上线」仍需**：目标机真实账号烟测 + `ilink` 续期/限流演练 + task-1 版本矩阵结论。默认策略建议——`ilink` 作跨 OS 个人助手；Windows 研发群用 `wxauto`；`wechatauto`（`pc-db`）做免费只读补充。

---

## 7. 通过 / 失败清单

**通过（PASS）**

- [x] `pc-db` `/health` `/status` `/rooms` `/members` `/messages` `/media` `/listen` 200 契约字段
- [x] `pc-db` `/send` 默认 501（只读，不伪造发送成功）
- [x] `ilink` `/health` `/status` `/rooms` `/members` `/messages` `/media` `/send` `/listen` 200 契约字段
- [x] `ilink` `/send` 回传 `context_token` + `Idempotency-Key` 去重
- [x] 401（缺/错 token）、404（未知路径/媒体）、405（含 `Allow`）、400（非法 body）两后端均符合
- [x] 事件 §3 字段（text 非空、at ISO-Z、ats、own、quoteId、media）两后端均符合
- [x] 游标分页（next 前进 / 空页 next 原样）两后端均符合
- [x] 媒体字节（PNG 魔数 / AES 解密=明文）+ 零字节规则（未知→404；ilink 语音→501）
- [x] token 不落 sidecar 日志（仅 `token=set` / 不含 HTTP token）
- [x] `tsc --noEmit` exit 0；`tsdown` exit 0；全量 vitest 1639 passed / 0 failed
- [x] 新增 spec 已登记到 `docs/007-architecture.md` `## Tests` 表（`docs.spec.ts` 6/6）

**失败 / 阻塞（FAIL / BLOCKED）**

- 无。全量套件 0 失败。

**未覆盖 / 条件项**：见第 5、6 节（真实微信 E2E、真实 DB、iLink 真实链路、群 @、媒体边界、Windows 并发实测）。

---

## 8. 复现命令

```powershell
# 1) 后端自带自测（无需微信）
python  sidecar/weixin-db-bridge/selftest.py            # 54 checks, 0 failure, ALL PASS
node    sidecar/weixin-ilink-bridge/selftest.mjs        # 83 通过, 0 失败

# 2) 独立跨进程契约测试
node node_modules/vitest/vitest.mjs run tests/weixin-bridge-contract.spec.ts --maxWorkers=1   # 15 passed

# 3) 质量门
node node_modules/typescript/bin/tsc --noEmit                        # exit 0
node node_modules/vitest/vitest.mjs run --maxWorkers=2               # 1639 passed / 41 skipped
node node_modules/tsdown/dist/run.mjs                                 # exit 0
```
