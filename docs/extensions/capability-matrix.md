# Capability matrix: the four added sources against Feishu and GitHub

> Language: [English](capability-matrix.md) · [中文](capability-matrix.zh-CN.md)

Reference for what "aligned" means. Feishu and GitHub are the two sources the upstream superagent ships; the other four are
this bundle's additions. ✅ present · ➖ not applicable to the platform · ❌ impossible on the backend (stated, never faked).

| Capability | Feishu (official) | GitHub (official) | WeChat | WeCom | DingTalk | Yunxiao Projex |
| --- | --- | --- | --- | --- | --- | --- |
| Receive messages | ✅ poll history + events | ✅ poll notifications | ✅ sidecar poll | ✅ signed callback (plugin mounts `/wecom/<instance>`) | ✅ stream (needs a `connect` injected; no SDK shipped) | ✅ poll work items/comments |
| Assess / decide / execute / reply loop | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Structured `@` judgement | ✅ open_id | ➖ | ✅ `ats` (markup fallback, strength in facts) | ✅ `mentionsAgent` | ✅ `ats` staffId | ➖ |
| Direct messages | ✅ | ➖ | ✅ | ✅ | ✅ | ➖ |
| Outbound text | ✅ markdown | ✅ comment | ✅ + mention-back | ✅ plain 2048 | ✅ markdown 5000 | ✅ RICHTEXT/Markdown comment |
| Outbound files | ➖ (CLI) | ➖ | ✅ `sendFiles` | ❌ API text only | ➖ (webhook) | ✅ attachments |
| Idempotent send | ✅ keyed | ✅ marker | ✅ keyed | ❌ none (stated) | ❌ none (stated) | ✅ marker |
| Thread context for the assessment | ✅ thread/root/parent | ✅ PR/issue | ✅ thread/parent; `root`→`no_root` | ✅ thread; `root`/`parent`→`no_*` | ✅ thread; `root`/`parent`→`no_*` | ✅ item body + comments |
| Worker reads of the original | ✅ `feishu/<t>/…` | ✅ `github/<t>/…` | ✅ `weixin/<t>/…` | ✅ `wecom/<t>/message` | ✅ `dingtalk/<t>/message` | ✅ `projex/<t>/item`, `/comments` |
| Inbound images for the assessment | ✅ | ➖ | ✅ `[image:<id>]`, `/media` | ✅ `MediaId`, `/cgi-bin/media/get` | ➖ (text stream) | ✅ item/comment images archived |
| Panel search | ✅ message id | ✅ issue/PR number | ✅ native id | ✅ decimal `MsgId` | ✅ `msgId` | ✅ serial or page URL |
| Reply→parent mapping | ✅ | ✅ | ✅ (quote id) | ➖ no quote in callback | ➖ | ➖ |
| Display-name refresh | ✅ chat names | ✅ repo names | ✅ rooms/members | ✅ department users (`refreshLabels`) | ❌ needs contact permission API, not offered | ✅ status vocabulary |
| Member/roster sync into Policy | ✅ chat members | ✅ collaborators | ✅ group members | ❌ group members unreadable; user list only fills names | ❌ same | ✅ project members |
| Health entries | `feishu` + `history` | `github` | `weixin` | `wecom` | `dingtalk` | `projex` |
| History backfill | ✅ chat history | ✅ notifications | ✅ post re-attach catch-up (marked `historical`) | ❌ callback only | ❌ stream only | ✅ first-sight comments |
| Message deep link | ✅ AppLink | ✅ issue/PR URL | ❌ | ❌ | ❌ | ✅ item page |
| Multiple instances | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## WeChat's two profiles (personal / team) + optional non-default wxauto

The **WeChat** column above describes the WeChat source's general capability surface. What ships is **two profiles** (the `profile` field), default `personal`; `wxauto-bridge` (`pc-uia` / wxautox4) and `gate-guard` are **non-default, not bundled** optional external backends, shown only in the last column for reference (✅ present · ⚠️ conditional · ❌ absent / not applicable).

| Capability | `personal` (**default**) = `weixin-ilink-bridge` (ilink) | `team` = `weixin-db-bridge` (pc-db / wechatauto-replica) | (optional, not bundled) `wxauto-bridge` (pc-uia / wxautox4) |
| --- | --- | --- | --- |
| OS / cost | **any OS (no desktop WeChat)**; **free** (official iLink) | Windows only (WeChat **4.1.12+**); **free** (Apache-2.0) | Windows only; **needs a wxautox4 commercial licence** |
| Groups / DMs | ⚠️ **DMs only** (no groups, no roster, no `@`) | ✅ groups + DMs (DB-read group trigger) | ✅ groups + DMs |
| Inbound structured `@` | ❌ `none` | ❌ `none` (`ats` always empty; rely on Policy/keywords) | ⚠️ `markup` (client markup; forgeable) |
| Group roster | ⚠️ `observed` (peer only) | ✅ `full` (full roster) | ⚠️ `observed` (only those who spoke) |
| History backfill | ❌ realtime only | ✅ full DB history, pageable | ⚠️ UI scroll catch-up |
| Inbound images / media | ✅ CDN + AES decrypt | ✅ when `MediaDownloader` is available | ✅ build-dependent `download()` |
| Outbound send | ✅ text (echoes `context_token`), keyed idempotency | ✅ text / file / group-`@` (needs `--profile team`; via `wechatauto` UIA/OCR); read-only 501 by default | ✅ text/files/voice/`@` |
| Voice / Moments / friends / create-group | ➖ (DM assistant) | ❌ **none** (voice/Moments/friend/create-group not wired, not claimed) | ✅ build-dependent |
| Receive / trigger | long-poll `getUpdates` | DB-read trigger (Node polls `/messages`; `/listen` does not drive the UI) | listener callback (drives the desktop UI) |
| 4.1.12.55 | ✅ client-version independent | ✅ DB read all pass, production-ready; send needs full UIA | ⚠️ cold-start gate=0 attach fails; needs hot-activation + licence + retest |

**4.1.12.55 finding**: this build turns the WeChat 4.x Qt accessibility gate off by default (the `mmui` tree is not materialised on a cold start). `wechatauto` ships hot activation, so **`team` (replica)'s DB read passes fully on 4.1.12.55 and is production-ready**, and its `--profile team` send goes through UIA/OCR; `personal` (iLink) is client-version independent; `wxautox4` has no hot activation and fails to attach on a cold start, so it is not a release backend (see `docs/research/compat-4.1.12.55.md`). Startup, exclusion and version requirements are in `sidecar/README.md`.

## Platform limits, and why they are not bugs

- **No deep link** on WeChat, WeCom and DingTalk: none of the three exposes a per-message URL; the panel names the Source.
- **No history** on WeCom and DingTalk: both deliver by push (callback / stream) and offer no read-back endpoint, so no
  backfill and no `/thread` pages. WeChat reads history through its sidecar; Feishu through the history API; Projex through the
  work-item APIs.
- **DingTalk transport**: the WebSocket client is the `dingtalk-stream` SDK, which this bundle deliberately does not vendor.
  A deployment injects `connect()` (see `src/sources/dingtalk-watch.ts`); without it the kind is
  registered but nothing listens, and health says so. Everything downstream of the stream (Trigger, ThreadContext, worker
  read, reply, policy) is aligned.
- **WeCom / DingTalk member sync**: a self-built app cannot enumerate a chat's members; WeCom fills Policy *names* from a
  department it is allowed to read, and both refuse to pretend a visible-user list is a chat roster.
- **WeCom / DingTalk / WeChat images**: WeChat and WeCom deliver images with a media id the deployment can download; DingTalk
  stream events carry text, so no image is claimed.

## What this round added

1. `projex/<trigger-id>/item` and `/comments` worker reads (`src/sources/work/projex/read.ts`), with paging and the agent's own
   comment marked `bot`.
2. `dingtalk/<trigger-id>/message` worker read and a DingTalk ThreadContext (`thread` = the one message, `no_root`,
   `no_parent`) — `src/sources/chat/dingtalk/{read,kind}.ts`.
3. WeCom `refreshLabels` over the contact user list, plus a `departmentId` setting, so Policy rows show names.
4. A `dsh-superagent-dingtalk` skill, and the Projex skill now names its two resources.
5. Tests: `tests/projex-read.spec.ts`, `tests/dingtalk-read.spec.ts`, plus the existing WeCom/WeChat/Projex suites.
