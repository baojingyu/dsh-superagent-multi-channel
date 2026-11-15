# 双 profile 交付 QA 报告（personal=iLink / team=replica）

> 目的：为「一个插件两个 profile」这次交付做质量门——验证
> ① `sidecar/weixin-db-bridge` 新增的 **team 全量模式**（`--profile team`：`/send` 支持 text/files/@、`/listen` 记录不抢 UI）
> ② `src/sources/chat/weixin/kind.ts` 的 **profile 配置**（`WeixinConfigSchema.profile` 默认 `personal`、默认 `baseUrl` 9300、字段/hint）
> 并按契约做全量回归，给出上线准入结论。
>
> 报告日期：2026-11-15。分支：`feature/wechat-multibackend`（本地需求分支，未 commit/push，Lead 统一提交）。
> 测试机：Windows；Node **v24.21.0**（DSH 内置 runtime，用 `process.execPath` 启动 sidecar）；Python **3.12.10**。
> **无微信客户端、无真实账号**——team 用 `--fake`、iLink 仍用 mock，跨平台可复现。
>
> 范围约束：本 QA 只改 `tests/**` 与本文档；未修改生产 `src` / `sidecar`（发现问题只报告）。

---

## 1. 范围与方法

| 对象 | 变更 | 本次验证点 |
| --- | --- | --- |
| `sidecar/weixin-db-bridge/server.py` | 新增 `--profile team` / `--team`：`allow_send` 自动开；`/send` 走 `wechatauto.Chat.SendMsg` / `SendFiles`，支持 `text` / `files`（绝对路径数组）/ `at`（昵称或 wxid/wxname），另兼容 Node 契约的 base64 `file`；`/listen` 只记录不 `AddListenChat`；默认（readonly）`/send` 仍 501 | team fake HTTP 契约 |
| `src/sources/chat/weixin/kind.ts` | `WeixinConfigSchema.profile: z.enum(['personal','team']).default('personal')`；`Fields` 新增 `profile` select；`baseUrl` 默认改 `http://127.0.0.1:9300`（personal=iLink）；hint 指向 personal→9300/start-weixin-ilink.cmd、team→8788/start-weixin-db.cmd | 默认/字段/hint 断言 |
| `package.json` | 发布 `files` 仅含两 sidecar + 两启动器 + sidecar/README；不再含 wxauto-bridge / gate-guard | 构建回归 |

测试分层：
1. **后端自带 selftest**（独立复跑取数字）：`python sidecar/weixin-db-bridge/selftest.py`（含新增 team 用例）。
2. **独立跨进程契约测试** `tests/weixin-bridge-contract.spec.ts`（本次扩展）：
   - 复用既有 pc-db(`--fake`) / ilink(mock) 两套；
   - **新增 team 套件**：`python server.py --fake --profile team --port <随机> --token <随机> --quiet` 起真实进程，原生 `fetch` 驱动；
   - **新增 config 套件**：直接对 `WeixinConfigSchema` / `weixinKind.fields` 断言。
3. **全仓回归**：`tsc --noEmit`、`vitest run --maxWorkers=2`、`tsdown`；`tests/docs.spec.ts` 必须绿。

---

## 2. 测试命令与结果（完整数字）

| # | 命令 | 结果 | 数字 / 关键输出 |
| --- | --- | --- | --- |
| 1 | `python sidecar/weixin-db-bridge/selftest.py` | ✅ PASS | **71 checks, 0 failure, ALL PASS**（原只读 54 + team 17） |
| 2 | `vitest run tests/weixin-bridge-contract.spec.ts --maxWorkers=1` | ✅ PASS | **23 passed**（pc-db 8 + ilink 7 + team 6 + config 2） |
| 3 | `vitest run tests/weixin-kind.spec.ts --maxWorkers=1` | ✅ PASS | **32 passed**（含 profile 字段/默认/非法值；baseUrl 默认 9300） |
| 4 | `vitest run tests/docs.spec.ts --maxWorkers=1` | ✅ PASS | **6 passed**（`weixin-bridge-contract.spec.ts` 已在 007 Tests 表中，无需新增行） |
| 5 | `tsc --noEmit` | ✅ PASS | exit 0，无诊断 |
| 6 | `vitest run --maxWorkers=2`（全量） | ✅ PASS | **Test Files 103 passed \| 5 skipped (108)；Tests 1647 passed \| 41 skipped (1688)**；73.80s |
| 7 | `tsdown` | ✅ PASS | exit 0；ESM **31 files, total 1.03 MB**（`lib/index.js` 480.50 kB / gzip 136.87 kB）；CJS `lib/client.js` 363.34 kB / gzip 87.98 kB |

对照上一轮（双后端，未含 team/config）：全量 vitest `1639 passed / 1680 tests`。
本轮 **+8 测试**（team 6 + config 2），文件数不变（扩展既有 spec，未新增文件），其余无回归。

---

## 3. 契约与配置覆盖矩阵

### 3.1 team 模式（`--fake --profile team`，tests/weixin-bridge-contract.spec.ts 新增 6 项）

| 断言点 | 结果 | 说明 |
| --- | --- | --- |
| `GET /health` 200 | ✅ | `ok/available=true`、`backend:"pc-db"`、`capabilities{members:"full",media:true,**send:true**}` |
| `GET /messages?room=<群>` | ✅ | 群消息作为触发源；逐条断言 §3 字段：`room=群id`、`sender{id,name}`、`text` 非空、`at` ISO-Z、`ats[]`、`own` bool、`media[]` |
| `POST /send {room,text}` | ✅ | 200 `{msgId,deduped:false}`，回显 `text` |
| `POST /send {room,text,at:['阿黎']}` | ✅ | 200，回显 `at:['阿黎']`（`at` 支持字符串或字符串数组） |
| `POST /send {room,text,files:[<绝对路径>]}` | ✅ | 200，回显 `files`；测试用真实临时文件绝对路径 |
| `POST /send {room,text,files:[…],at:[…]}` 组合 | ✅ | 200，`files`/`at` 同时回显 |
| `Idempotency-Key` 重放（body `idempotencyKey`） | ✅ | 第二次 `deduped:true` 且 `msgId` 相同 |
| `POST /listen {rooms:[群]}` | ✅ | 200 `{listening,added,removed,failed}`；`listening` 含该群；**只记录、不 AddListenChat/StartListening**（不抢 UI） |
| token 卫生 | ✅ | child stderr 不含 bearer token |

### 3.2 只读模式（默认，无 `--profile team`/`--allow-send`）

| 断言点 | 结果 | 说明 |
| --- | --- | --- |
| `POST /send` | ✅ | **501 `unsupported`**（既有 pc-db 只读套件断言；“只读后端不伪造发送成功”） |
| `capabilities.send` | ✅ | 只读为假（team 为真），`/health` 如实自述 |

### 3.3 profile 配置（tests/weixin-bridge-contract.spec.ts 新增 2 项）

| 断言点 | 结果 |
| --- | --- |
| `WeixinConfigSchema.parse({tokenFile,selfWxid}).profile` | ✅ `'personal'`（默认） |
| `WeixinConfigSchema.parse({…}).baseUrl` | ✅ `'http://127.0.0.1:9300'`（随默认 profile） |
| `parse({profile:'team'}).profile` | ✅ `'team'` |
| `safeParse({profile:'other'})` | ✅ `success=false` |
| `weixinKind.fields` 的 `profile` | ✅ 存在且 `type:'select'`，`options.value === ['personal','team']` |
| `profile` 字段 hint | ✅ 同时包含 `9300` 与 `8788` |

---

## 4. 风险与语义说明（诚实）

1. **profile 是“声明 + 推荐配置”，不是强约束**：`kind.ts` 的注释明确 profile 只记录档位并驱动 hint；真正的后端仍由 `baseUrl` 与 `bridgeLauncher` 决定（二者在冻结契约后可互换）。因此「profile=team 但 baseUrl 指向 iLink 端口」这类错配 **schema 不会拒绝**，属运维一致性问题——面板 hint 已提示“地址指向哪个后端，就由哪个后端服务”。
2. **team 发送会驱动真实微信 UI**：team 模式 `allow_send` 自动开，真实 `/send` 走 `wechatauto.Chat.SendMsg` / `SendFiles`（需完整 UIA 栈）。在真实机器上与 `wxautox4`/`wxauto` 等任何 UI 自动化客户端**同一微信号同一时刻只能有一个在操作界面**，否则抢焦点——与既有的 `pc-db --allow-send` 同一红线。
3. **team 收消息不抢 UI**：`/listen` 仅记录房间，触发靠 Node 侧 `/messages` 的 DB 轮询（`get_messages`/`get_new_messages`），不 `AddListenChat`/`StartListening`。
4. **team 运行前提**：Windows 桌面微信 **4.1.12+** 已登录、本进程可读其内存以取库密钥；`wechatauto-replica` 可导入，team 发送还需完整 UIA（非仅 db/media 子模块）。
5. **`files` 是 sidecar 本机绝对路径**：team 的 `files` 是运行 sidecar 那台机器上的绝对路径（不是 HTTP 上传字节）；同时兼容 Node 契约的 base64 `file`（写入私有临时文件后发送）。fake 只校验“字符串数组”，真实后端要求路径存在（缺失即 400）。
6. **iLink（personal）未变**：仅单聊、无群、`mentions:"none"`、≈24h 凭证、≈10 条/日限流（详见 `docs/research/wechat-backends-qa.md`），本报告未重复覆盖其真实链路。

---

## 5. 未覆盖项（诚实声明）

1. **真实机器上的 team 发送**：本机无微信客户端，team 仅以 `--fake` 验证 HTTP 形状与参数归一；真实 `Chat.SendMsg`/`SendFiles`、真实 `at` 显示名解析、真实 `files` 存在性校验未在真机验证。
2. **Windows UI 并发抢占**：仅静态分析 + 文档证据，未在同一已登录微信机器上做并发争用实测。
3. **4.1.12.55 真机版本矩阵**：见 task-1 报告 `docs/research/compat-4.1.12.55.md`，本报告不重复。
4. **iLink 真实链路**：扫码/续期/限流/真实 CDN 仍为 mock（沿袭上一轮结论）。
5. **profile 错配的运行期校验**：schema 不强制 profile 与 baseUrl 一致，未新增运行期一致性校验。
6. **媒体/大文件边界**：team 未新增语音/朋友圈/好友/建群（按实现声明不实现），故未覆盖这些能力。

---

## 6. 上线准入（Release Gate）

| 门禁项 | 结论 | 依据 |
| --- | --- | --- |
| team 契约（`/send` text/files/at、`/listen`、`/messages`、只读 501） | ✅ 通过 | selftest 71/71；contract spec team 6/6 |
| profile 配置（默认 personal、team、非法值、字段/hint、baseUrl 9300） | ✅ 通过 | contract config 2/2；weixin-kind.spec 32/32 |
| 类型检查 | ✅ 通过 | `tsc --noEmit` exit 0 |
| 全量回归 | ✅ 通过 | vitest 1647 passed / 0 failed（41 live-skip 属环境门控） |
| 文档一致性 | ✅ 通过 | `docs.spec.ts` 6/6（扩展既有 spec 文件，007 Tests 表无需新增行） |
| 构建 / 发布包 | ✅ 通过 | `tsdown` exit 0；`package.json files` 仅两 sidecar+两启动器+sidecar/README，不含 wxauto-bridge/gate-guard |
| 真实账号 team 发送烟测（Windows 4.1.12+） | ⚠️ 条件项 | 上线前必须在目标机真实微信上各跑一轮：text / 文件 / @，并确认不与其它 UI 自动化并发 |
| profile↔baseUrl 一致性 | ⚠️ 运维项 | 面板按 profile 选端口；部署检查时确认 baseUrl/launcher/profile 三者一致 |

**结论**：契约与回归门禁（PASS 项）全部通过，可合并；**「可上线」仍需**：目标机真实账号 team 发送烟测 + UI 独占确认 + profile/baseUrl/launcher 一致性核对。默认策略：`personal`（iLink，跨 OS 单聊个人助手，默认）；`team`（replica，Windows 4.1.12+，研发群 DB 触发，文本/文件/@）。

---

## 7. 通过 / 失败清单

**通过（PASS）**

- [x] team `--profile team --fake`：`/health` 200 且 `capabilities.send=true`
- [x] team `/messages` 群事件 §3 字段完整
- [x] team `/send`：`{room,text}` / `{room,text,at:[…]}` / `{room,text,files:[绝对路径]}` / 组合 → 200 `{msgId,deduped}`
- [x] team `Idempotency-Key` 重放去重（同 msgId，deduped=true）
- [x] team `/listen` 200 `{listening,added,removed,failed}`，只记录不抢 UI
- [x] 只读默认 `/send` 501 unsupported
- [x] `WeixinConfigSchema.profile` 默认 `personal`、接受 `team`、拒绝其它值；默认 `baseUrl=9300`
- [x] `weixinKind.fields` 的 `profile` 为 select，options `['personal','team']`，hint 含 9300/8788
- [x] `tsc --noEmit` exit 0；`tsdown` exit 0；全量 vitest 1647 passed / 0 failed；`docs.spec` 6/6

**失败 / 阻塞（FAIL / BLOCKED）**

- 无。全量套件 0 失败。

**未覆盖 / 条件项**：见第 5、6 节。

---

## 8. 复现命令

```powershell
# 1) 后端自测（含 team 用例，无需微信）
python sidecar/weixin-db-bridge/selftest.py                 # 71 checks, 0 failure, ALL PASS

# 2) 独立跨进程契约（team + config 已含）
node node_modules/vitest/vitest.mjs run tests/weixin-bridge-contract.spec.ts --maxWorkers=1   # 23 passed

# 3) 配置与文档
node node_modules/vitest/vitest.mjs run tests/weixin-kind.spec.ts tests/docs.spec.ts --maxWorkers=1

# 4) 质量门
node node_modules/typescript/bin/tsc --noEmit                        # exit 0
node node_modules/vitest/vitest.mjs run --maxWorkers=2               # 1647 passed / 41 skipped
node node_modules/tsdown/dist/run.mjs                                 # exit 0
```
