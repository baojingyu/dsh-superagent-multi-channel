#!/usr/bin/env node
/**
 * weixin-ilink-bridge —— 把腾讯 iLink Bot（微信「龙虾」ClawBot）协议封装成
 * 现有 wxauto-bridge 冻结 HTTP 契约（sidecar/wxauto-bridge/contract.md §1）的 Node sidecar。
 *
 * 设计要点（与 contract.md 对齐）：
 *   - Node 18+，零第三方依赖（仅内置 http/crypto/fs + 全局 fetch）。
 *   - 扫码登录把凭证写文件；`run` 时后台长轮询 getUpdates，HTTP 只从内存缓冲读，规避 Node 侧 15s 超时。
 *   - 端点：GET /health /status /rooms /members /messages /media/<id>；POST /send /listen。
 *   - Bearer token 保护全部端点（timing-safe 比对），日志绝不打印 token 值。
 *   - iLink 仅提供单聊：事件 room 恒为 ""（契约 §3），群不伪造、/rooms 只列观测到的单聊对端。
 *   - 入站图片/文件走 CDN 下载 + AES-128-ECB 解密；语音/视频等不可解码类型按 501 处理。
 *
 * 协议客户端与 CDN/AES 实现 vendored 自 MIT 的 gtaifu/dsh-wechat-bridge（lib/ilink.mjs、
 * lib/ilink-media.mjs，Copyright (c) 2026 Xiang Fu，见同目录 LICENSE），本文件的 HTTP 桥接
 * 与归一化逻辑是本仓库自有实现。
 */

import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";

import {
  createIlinkClient,
  extractText,
  DEFAULT_BASE_URL,
  STALE_TOKEN_ERRCODE,
  LONG_POLL_TIMEOUT_MS,
} from "./lib/ilink.mjs";
import {
  downloadAndDecrypt,
  downloadPlain,
  getMimeFromFilename,
} from "./lib/ilink-media.mjs";

export const VERSION = "0.1.0";
export const SIDECAR = "1";
export const BACKEND = "ilink";
export const DEFAULT_PORT = 9300;
export const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_CHANNEL_VERSION = "2.4.6";
const DEFAULT_BOT_AGENT = "dsh-weixin-ilink-bridge";
const MAX_BODY_BYTES = 1024 * 1024;
const IDEMPOTENCY_TTL_MS = 600_000;
const IDEMPOTENCY_MAX = 256;
const MEDIA_CACHE_TTL_MS = 300_000;

const log = (...a) => process.stderr.write(`[ilink-bridge ${new Date().toISOString()}] ${a.join(" ")}\n`);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const safeIdFor = (userId) => `ilink_${sha1(userId).slice(0, 16)}`;
const localPart = (userId) => {
  const s = String(userId ?? "");
  const at = s.indexOf("@");
  return (at > 0 ? s.slice(0, at) : s) || s || "unknown";
};
const isoNow = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function sniffImageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii") === "GIF87a") return "image/gif";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return "image/jpeg";
}

const hasRef = (media) => Boolean(media?.encrypt_query_param || media?.full_url);

/** 媒体项渲染成事件 text 的占位（契约 §3.2：任何分支都不得产出空串）。 */
function placeholderFor(itemList = []) {
  const types = new Set((itemList ?? []).map((i) => i?.type));
  if (types.has(2)) return "[图片]";
  if (types.has(5)) return "[视频消息]";
  if (types.has(4)) return "[文件消息]";
  if (types.has(3)) return "[语音消息]";
  return "[消息]";
}

// ---------------------------------------------------------------------------
// 桥接核心（可被 selftest 直接 import，进程内起服务）
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.client       createIlinkClient(...) 实例
 * @param {object|null} opts.auth    {token, baseUrl, botId, userId, channelVersion,...}
 * @param {string} opts.token        HTTP Bearer token
 * @param {boolean} [opts.mediaEnabled=true]
 * @param {string} [opts.syncBufFile]
 * @param {number} [opts.pollIdleMs=300]
 */
export function createBridge(opts) {
  const client = opts.client;
  const auth = opts.auth ?? null;
  const bearer = String(opts.token ?? "");
  const mediaEnabled = opts.mediaEnabled !== false;
  const pollIdleMs = Number(opts.pollIdleMs ?? 300);
  const syncBufFile = opts.syncBufFile ?? null;
  const mediaCacheTtlMs = Number(opts.mediaCacheTtlMs ?? MEDIA_CACHE_TTL_MS);
  // 契约 §6：相邻两次发送间隔 ≥ 1 s（可配置，selftest 置 0 以免拖慢）
  const minSendGapMs = Number(opts.minSendGapMs ?? 1000);
  let lastSendAt = 0;

  const selfId = auth?.botId || auth?.userId || "";
  const botName = auth?.botName || selfId || "iLink Bot";

  const state = {
    available: Boolean(auth && auth.token),
    detail: auth && auth.token ? "" : "未登录：先运行 `node server.mjs login` 扫码",
    seq: 0,
    lastEventAt: "",
    buf: "",
    stopping: false,
    listening: new Set(),
  };

  /** rawUserId -> { rawId, safeId, name, lastAt } */
  const peers = new Map();
  /** safeId -> rawUserId */
  const peersBySafe = new Map();
  /** peerRawId -> context_token */
  const contextTokens = new Map();
  /** nativeId -> event (含原始 item_list，供引用/媒体解析) */
  const byNativeId = new Map();
  const events = [];
  /** mediaId "<nativeId>#<index>" -> { item, nativeId } */
  const mediaIndex = new Map();
  /** mediaId -> { bytes, mime, at } */
  const mediaCache = new Map();
  /** Idempotency-Key -> { msgId, at } */
  const idempotency = new Map();

  let chain = Promise.resolve();
  const withLock = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  function ensurePeer(userId, ctxToken) {
    const raw = String(userId ?? "");
    if (!raw) return null;
    if (ctxToken) contextTokens.set(raw, ctxToken);
    const safeId = safeIdFor(raw);
    let peer = peers.get(raw);
    if (!peer) {
      peer = { rawId: raw, safeId, name: localPart(raw), lastAt: "" };
      peers.set(raw, peer);
      peersBySafe.set(safeId, raw);
    }
    peer.lastAt = isoNow();
    return peer;
  }

  /** 解析 /messages、/members、/send、/listen 的 room 引用：""|safeId|rawUserId|显示名。 */
  function resolvePeer(ref) {
    const r = String(ref ?? "");
    if (!r) return null;
    const raw = peersBySafe.get(r);
    if (raw) return peers.get(raw);
    if (peers.has(r)) return peers.get(r);
    for (const p of peers.values()) {
      if (p.rawId === r || p.name === r) return p;
    }
    // 形如 userId 的引用：允许懒注册（新一轮对端尚无消息时也能配置）
    if (r.includes("@")) return ensurePeer(r);
    return null;
  }

  // -- 入站归一 -------------------------------------------------------------

  function ingest(msg) {
    if (!msg || typeof msg !== "object") return;
    const from = String(msg.from_user_id ?? "");
    const nativeId = String(msg.message_id ?? msg.seq ?? msg.client_id ?? msg.new_msg_id ?? `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`);
    if (byNativeId.has(nativeId)) return; // at-least-once：按 nativeId 去重

    const ctx = msg.context_token;
    const peer = ensurePeer(from, ctx);
    const itemList = Array.isArray(msg.item_list) ? msg.item_list : [];

    let text = "";
    try {
      text = extractText(msg);
    } catch {
      text = "";
    }
    if (!text) text = placeholderFor(itemList);

    const at = msg.create_time ? new Date(Number(msg.create_time) * 1000).toISOString().replace(/\.\d+Z$/, "Z") : isoNow();

    const media = [];
    itemList.forEach((item, index) => {
      const mediaRef = item?.image_item?.media || item?.file_item?.media || item?.voice_item?.media || item?.video_item?.media;
      if (!mediaRef || !hasRef(mediaRef)) return;
      const mediaId = `${nativeId}#${index}`;
      mediaIndex.set(mediaId, { item, nativeId });
      if (item.type === 2) media.push({ id: mediaId, kind: "image" });
    });

    const event = {
      seq: ++state.seq,
      nativeId,
      room: "", // 单聊（契约 §3）
      sender: { id: peer?.safeId ?? safeIdFor(from), name: peer?.name ?? localPart(from) },
      text,
      at,
      ats: [], // iLink 无法证明群 @：capabilities.mentions = "none"
      own: Boolean(selfId && from === selfId),
      quoteId: "",
      media,
      peerRawId: from,
      peerSafeId: peer?.safeId ?? safeIdFor(from),
    };

    byNativeId.set(nativeId, { event, itemList });
    events.push(event);
    state.lastEventAt = at;
    if (events.length > 5000) events.splice(0, events.length - 5000);
  }

  // -- 后台长轮询 -----------------------------------------------------------

  let pollAbort = null;

  async function saveSyncBuf(buf) {
    if (!syncBufFile) return;
    try {
      await mkdir(path.dirname(syncBufFile), { recursive: true });
      await writeFile(syncBufFile, String(buf ?? ""), "utf8");
    } catch (e) {
      log(`保存游标失败（忽略）：${e?.message ?? e}`);
    }
  }

  async function loadSyncBuf() {
    if (!syncBufFile) return "";
    try {
      return (await readFile(syncBufFile, "utf8")).trim();
    } catch {
      return "";
    }
  }

  async function pollLoop(signal) {
    let failures = 0;
    state.buf = await loadSyncBuf();
    while (!state.stopping && !signal.aborted) {
      let resp;
      try {
        resp = await client.getUpdates(state.buf, LONG_POLL_TIMEOUT_MS, signal);
      } catch (e) {
        if (signal.aborted || state.stopping) break;
        failures += 1;
        log(`getUpdates 网络错误 (${failures}/3)：${e?.message ?? e}`);
        await sleep(failures >= 3 ? 30_000 : 2_000);
        if (failures >= 3) failures = 0;
        continue;
      }

      const code = resp.errcode ?? resp.ret;
      if (code === STALE_TOKEN_ERRCODE) {
        state.available = false;
        state.detail = "iLink token 失效（-14），请重新运行 `node server.mjs login` 扫码续连";
        log("token 失效 (-14)，暂停 30s 后重试扫描");
        await sleep(30_000);
        continue;
      }
      if ((resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)) {
        failures += 1;
        log(`getUpdates 错误 ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${failures}/3)`);
        await sleep(failures >= 3 ? 30_000 : 2_000);
        if (failures >= 3) failures = 0;
        continue;
      }

      failures = 0;
      state.available = true;
      state.detail = "";
      if (resp.get_updates_buf && resp.get_updates_buf !== state.buf) {
        state.buf = resp.get_updates_buf;
        saveSyncBuf(state.buf);
      }
      const msgs = Array.isArray(resp.msgs) ? resp.msgs : [];
      for (const msg of msgs) {
        if (msg.message_type !== undefined && msg.message_type !== 1) continue; // 只处理用户消息
        try {
          ingest(msg);
        } catch (e) {
          log(`消息归一异常（忽略）：${e?.stack ?? e}`);
        }
      }
      if (msgs.length === 0) await sleep(pollIdleMs);
    }
  }

  // -- 媒体下载/解密 ---------------------------------------------------------

  async function loadMedia(id) {
    const cached = mediaCache.get(id);
    if (cached && Date.now() - cached.at < mediaCacheTtlMs) {
      return { status: 200, bytes: cached.bytes, mime: cached.mime };
    }
    const entry = mediaIndex.get(id);
    if (!entry) return { status: 404, detail: "媒体 id 不在当前可见窗口" };
    if (!mediaEnabled) return { status: 501, detail: "该构建未开启媒体下载能力" };

    const item = entry.item ?? {};
    try {
      if (item.type === 2) {
        const img = item.image_item ?? {};
        const m = img.media ?? {};
        if (!hasRef(m)) return { status: 404, detail: "图片无 CDN 引用" };
        const key = img.aeskey ? Buffer.from(String(img.aeskey), "hex").toString("base64") : m.aes_key;
        const buf = key
          ? await downloadAndDecrypt({ aesKeyBase64: key, fullUrl: m.full_url, encryptQueryParam: m.encrypt_query_param, log })
          : await downloadPlain({ fullUrl: m.full_url, encryptQueryParam: m.encrypt_query_param, log });
        if (!buf || buf.length === 0) return { status: 404, detail: "空载荷" };
        const mime = sniffImageMime(buf);
        mediaCache.set(id, { bytes: buf, mime, at: Date.now() });
        return { status: 200, bytes: buf, mime };
      }
      if (item.type === 4) {
        const f = item.file_item ?? {};
        const m = f.media ?? {};
        if (!hasRef(m) || !m.aes_key) return { status: 404, detail: "文件无 CDN 引用或缺少 aes_key" };
        const buf = await downloadAndDecrypt({ aesKeyBase64: m.aes_key, fullUrl: m.full_url, encryptQueryParam: m.encrypt_query_param, log });
        if (!buf || buf.length === 0) return { status: 404, detail: "空载荷" };
        const mime = getMimeFromFilename(f.file_name ?? "file.bin");
        mediaCache.set(id, { bytes: buf, mime, at: Date.now() });
        return { status: 200, bytes: buf, mime };
      }
      return { status: 501, detail: `媒体类型 ${item.type} 不支持解密下载` };
    } catch (e) {
      log(`媒体 ${id} 下载/解密失败：${e?.message ?? e}`);
      return { status: 404, detail: String(e?.message ?? e) };
    }
  }

  // -- /messages 分页 -------------------------------------------------------

  function filteredEvents(roomRef) {
    const r = String(roomRef ?? "");
    if (r === "") return events;
    const peer = resolvePeer(r);
    if (!peer) return [];
    return events.filter((e) => e.peerSafeId === peer.safeId);
  }

  function toWire(e) {
    return {
      nativeId: e.nativeId,
      room: e.room,
      sender: { id: e.sender.id, name: e.sender.name },
      text: e.text,
      at: e.at,
      ats: e.ats,
      own: e.own,
      quoteId: e.quoteId,
      media: e.media,
    };
  }

  function page(roomRef, limit, cursor) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const list = filteredEvents(roomRef);
    const head = String(state.seq);
    let cursorSeq = null;
    if (cursor !== undefined && cursor !== null && cursor !== "") {
      const n = Number(cursor);
      if (Number.isFinite(n) && n >= 0 && n <= state.seq) cursorSeq = n;
      // 否则游标失效 → 按无游标处理
    }
    let candidates;
    if (cursorSeq !== null) candidates = list.filter((e) => e.seq > cursorSeq);
    else candidates = list;
    const pageItems = candidates.slice(0, lim);
    let next;
    if (pageItems.length) next = String(pageItems[pageItems.length - 1].seq);
    else next = cursorSeq !== null ? String(cursorSeq) : String(state.seq);
    return { events: pageItems.map(toWire), next, head };
  }

  // -- HTTP ---------------------------------------------------------------

  function json(res, status, obj, extraHeaders = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      ...extraHeaders,
    });
    res.end(body);
  }
  const fail = (res, status, code, detail) => json(res, status, { error: code, ...(detail ? { detail } : {}) });
  function methodNotAllowed(res, allow) {
    json(res, 405, { error: "method_not_allowed" }, { Allow: allow });
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) return resolve({});
        try {
          const v = JSON.parse(raw);
          resolve(v && typeof v === "object" && !Array.isArray(v) ? v : null);
        } catch {
          resolve(undefined);
        }
      });
      req.on("error", reject);
    });
  }

  function unauthorized(res) {
    fail(res, 401, "unauthorized");
  }

  function checkAuth(req) {
    if (!bearer) return true;
    const header = String(req.headers["authorization"] ?? "");
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    return safeEqual(provided, bearer);
  }

  async function handleSend(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return fail(res, 400, "bad_request", "请求体过大或读取失败");
    }
    if (body === undefined) return fail(res, 400, "bad_request", "请求体不是合法 JSON");
    if (body === null) return fail(res, 400, "bad_request", "请求体必须是对象");

    if (body.file) return fail(res, 501, "unsupported", "本 PoC 的 /send 仅支持文本，出站文件未实现");
    const text = typeof body.text === "string" ? body.text : "";
    if (!text) return fail(res, 400, "bad_request", "缺少 text");
    const peer = resolvePeer(body.room);
    if (!peer) return fail(res, 409, "gone", "未知会话，无法确定接收方");
    const ctxToken = contextTokens.get(peer.rawId);
    if (!ctxToken) return fail(res, 409, "gone", "该会话暂无 context_token（需先收到对端一条消息）");

    const idemKey = req.headers["idempotency-key"];
    if (idemKey) {
      const hit = idempotency.get(String(idemKey));
      if (hit && Date.now() - hit.at < IDEMPOTENCY_TTL_MS) {
        return json(res, 200, { msgId: hit.msgId, deduped: true });
      }
    }

    // quoteId 尽力而为：解析到已观测消息时带上 ref_msg（iLink 出站引用字段）；解析不到按普通文本发，不伪造。
    const quoteId = typeof body.quoteId === "string" ? body.quoteId : "";
    const item = { type: 1, text_item: { text } };
    if (quoteId) {
      const orig = byNativeId.get(quoteId);
      const refItem = orig?.itemList?.[0];
      if (refItem) item.ref_msg = { title: orig.event?.sender?.name ?? "", message_item: refItem };
    }
    const itemList = [item];

    try {
      const sent = await withLock(async () => {
        // 契约 §6：进程内发送串行，相邻两次间隔 ≥ minSendGapMs（命中幂等缓存的重放不消耗间隔）
        const wait = lastSendAt + minSendGapMs - Date.now();
        if (wait > 0) await sleep(wait);
        try {
          return await client.sendMessageItems({ to: peer.rawId, itemList, contextToken: ctxToken });
        } finally {
          lastSendAt = Date.now();
        }
      });
      const msgId = sent?.clientId ?? "";
      if (idemKey) {
        if (idempotency.size >= IDEMPOTENCY_MAX) {
          const oldest = idempotency.keys().next().value;
          idempotency.delete(oldest);
        }
        idempotency.set(String(idemKey), { msgId, at: Date.now() });
      }
      return json(res, 200, { msgId, deduped: false });
    } catch (e) {
      log(`/send 失败 to=${peer.safeId} err=${e?.message ?? e}`);
      const ret = e?.ret;
      if (ret !== undefined && ret !== 0 && ret !== null) return fail(res, 409, "gone", `sendmessage ret=${ret}`);
      return fail(res, 502, "unavailable", String(e?.message ?? e));
    }
  }

  async function handleListen(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return fail(res, 400, "bad_request", "请求体过大或读取失败");
    }
    if (body === undefined) return fail(res, 400, "bad_request", "请求体不是合法 JSON");
    if (body === null) return fail(res, 400, "bad_request", "请求体必须是对象");
    if (!Array.isArray(body.rooms) || body.rooms.some((x) => typeof x !== "string")) {
      return fail(res, 400, "bad_request", "rooms 必须是字符串数组");
    }
    const failed = [];
    const target = new Set();
    const nameOf = new Map();
    for (const ref of body.rooms) {
      const peer = resolvePeer(ref);
      if (!peer) {
        failed.push({ room: ref, detail: "会话不存在或未被观测到" });
        continue;
      }
      target.add(peer.safeId);
      nameOf.set(peer.safeId, peer.name);
    }
    const added = [...target].filter((id) => !state.listening.has(id));
    const removed = [...state.listening].filter((id) => !target.has(id));
    state.listening = target;
    const listening = [...target].map((id) => ({ id, name: nameOf.get(id) ?? id }));
    return json(res, 200, { listening, added, removed, failed });
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
    const p = url.pathname;
    const method = req.method ?? "GET";

    if (!checkAuth(req)) return unauthorized(res);

    // ---- /health（进程存活即 200；可用性在体内）----
    if (p === "/health") {
      if (method !== "GET") return methodNotAllowed(res, "GET");
      const available = state.available;
      const caps = { mentions: "none", members: "observed", media: mediaEnabled };
      const detail = available ? undefined : (state.detail || "iLink 未就绪");
      return json(res, 200, {
        ok: available,
        available,
        version: VERSION,
        sidecar: SIDECAR,
        backend: BACKEND,
        uptimeSec: Math.round(process.uptime()),
        capabilities: caps,
        ...(detail ? { detail } : {}),
      });
    }

    // ---- /status ----
    if (p === "/status") {
      if (method !== "GET") return methodNotAllowed(res, "GET");
      const loggedIn = state.available && Boolean(auth && auth.token);
      const out = {
        loggedIn,
        wxid: selfId,
        name: botName,
        backend: BACKEND,
        client: "ilink",
        available: state.available,
      };
      if (state.lastEventAt) out.lastEventAt = state.lastEventAt;
      if (!state.available && state.detail) out.detail = state.detail;
      return json(res, 200, out);
    }

    // 以下为数据端点：后端不可用时 502（契约 §7）
    const dataPaths = new Set(["/rooms", "/members", "/messages", "/send", "/listen"]);
    const isMedia = p.startsWith("/media/");
    if ((dataPaths.has(p) || isMedia) && !state.available) {
      return fail(res, 502, "unavailable", state.detail || "iLink 未就绪");
    }

    if (p === "/rooms") {
      if (method !== "GET") return methodNotAllowed(res, "GET");
      const rooms = [...peers.values()]
        .map((peer) => ({ id: peer.safeId, name: peer.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      // 群：iLink 协议不提供群会话，这里只返回单聊；不伪造群。
      return json(res, 200, { rooms });
    }

    if (p === "/members") {
      if (method !== "GET") return methodNotAllowed(res, "GET");
      const ref = url.searchParams.get("room") ?? "";
      const peer = resolvePeer(ref);
      const members = peer ? [{ id: peer.safeId, name: peer.name }] : [];
      return json(res, 200, { members });
    }

    if (p === "/messages") {
      if (method !== "GET") return methodNotAllowed(res, "GET");
      const room = url.searchParams.get("room") ?? "";
      const limit = url.searchParams.get("limit") ?? "50";
      const cursor = url.searchParams.get("cursor") ?? "";
      return json(res, 200, page(room, limit, cursor));
    }

    if (p === "/send") {
      if (method !== "POST") return methodNotAllowed(res, "POST");
      return handleSend(req, res);
    }

    if (p === "/listen") {
      if (method !== "POST") return methodNotAllowed(res, "POST");
      return handleListen(req, res);
    }

    if (isMedia) {
      if (method !== "GET") return methodNotAllowed(res, "GET");
      let id;
      try {
        id = decodeURIComponent(p.slice("/media/".length));
      } catch {
        return fail(res, 400, "bad_request", "媒体 id 编码非法");
      }
      if (!id) return fail(res, 404, "not_found");
      const result = await withLock(() => loadMedia(id));
      if (result.status === 200) {
        res.writeHead(200, { "content-type": result.mime, "content-length": result.bytes.length });
        return res.end(result.bytes);
      }
      if (result.status === 501) return fail(res, 501, "unsupported", result.detail);
      return fail(res, 404, "not_found", result.detail);
    }

    return fail(res, 404, "not_found");
  }

  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((e) => {
      log(`请求处理异常：${e?.stack ?? e}`);
      try {
        fail(res, 500, "internal", String(e?.message ?? e));
      } catch {
        /* headers already sent */
      }
    });
  });

  return {
    server,
    state,
    peers,
    events,
    mediaIndex,
    async start({ port = 0, host = DEFAULT_HOST } = {}) {
      pollAbort = new AbortController();
      const p = pollLoop(pollAbort.signal).catch((e) => log(`轮询循环退出：${e?.message ?? e}`));
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return { port: server.address().port, host, pollTask: p };
    },
    async stop() {
      state.stopping = true;
      try {
        pollAbort?.abort();
      } catch {}
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// 扫码登录（CLI）
// ---------------------------------------------------------------------------

const mask = (s, n = 6) => (typeof s === "string" && s.length > 0 ? (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-n)}` : s) : "(空)");

function readLine(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (a) => {
    rl.close();
    resolve(a.trim());
  }));
}

async function loadAuthFile(file) {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    if (!raw.token) throw new Error("bad shape");
    return raw;
  } catch {
    return null;
  }
}

async function saveAuthFile(file, auth) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...auth, savedAt: Date.now() }, null, 2), "utf8");
}

async function doLogin(values, files) {
  const baseUrl = values.baseUrl || DEFAULT_BASE_URL;
  const channelVersion = values.channelVersion || DEFAULT_CHANNEL_VERSION;
  const botAgent = values.botAgent || DEFAULT_BOT_AGENT;
  const client = createIlinkClient({ baseUrl, channelVersion, botAgent, log: (m) => log(m) });

  console.log("正在向微信 iLink 申请登录二维码…");
  let qr = await client.getBotQrcode();
  if (!qr.qrcode) throw new Error("获取二维码失败：响应缺少 qrcode");
  console.log(`\n📱 请用手机微信打开以下二维码链接完成登录：\n${qr.qrcodeImgContent}\n`);

  const deadline = Date.now() + (values.qrTimeoutMs || 8 * 60 * 1000);
  let verifyCode;
  let refresh = 0;
  while (Date.now() < deadline) {
    let st;
    try {
      st = await client.pollQrcodeStatus(qr.qrcode, verifyCode);
    } catch {
      st = { status: "wait" };
    }
    switch (st.status) {
      case "wait":
        process.stdout.write(".");
        break;
      case "scaned":
        console.log("\n✅ 已扫码，请在手机上确认…");
        break;
      case "need_verifycode":
        verifyCode = await readLine("🔢 输入手机微信显示的数字配对码：");
        continue;
      case "verify_code_blocked":
        console.log("\n⛔ 配对码错误次数过多，刷新二维码…");
        verifyCode = undefined;
        if (++refresh > 3) throw new Error("配对码多次错误，请稍后重试");
        qr = await client.getBotQrcode();
        console.log(`📱 新二维码：\n${qr.qrcodeImgContent}\n`);
        break;
      case "expired":
        console.log("\n⏳ 二维码过期，刷新…");
        if (++refresh > 3) throw new Error("二维码多次过期，请重新运行 login");
        qr = await client.getBotQrcode();
        console.log(`📱 新二维码：\n${qr.qrcodeImgContent}\n`);
        break;
      case "scaned_but_redirect":
        if (st.redirectHost) {
          console.log(`\n🔀 服务器要求切换节点：${st.redirectHost}`);
          client.setBaseUrl(`https://${st.redirectHost}`);
        }
        break;
      case "binded_redirect":
        console.log("\n✅ 该微信已连接过本机（binded_redirect），沿用现有凭证。");
        return null;
      case "confirmed": {
        if (!st.botId) throw new Error("登录确认但服务器未返回 ilink_bot_id");
        console.log(`\n🎉 登录成功！botId=${st.botId} userId=${st.userId ? mask(st.userId) : "?"}`);
        return {
          token: st.botToken,
          baseUrl: st.baseUrl || baseUrl,
          botId: st.botId,
          userId: st.userId ?? null,
          channelVersion,
          loggedInAt: Date.now(),
        };
      }
      default:
        break;
    }
    await sleep(1000);
  }
  throw new Error("等待扫码超时");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `weixin-ilink-bridge —— 腾讯 iLink Bot ⇄ wxauto-bridge 契约的 Node sidecar

用法:
  node server.mjs login   [--auth-file PATH] [--base-url URL] [--channel-version 2.4.6] [--qr-timeout-ms N]
  node server.mjs run     --token-file PATH [--port 9300] [--host 127.0.0.1] [--auth-file PATH]
                          [--base-url URL] [--sync-buf-file PATH] [--no-media]
                          [--media-cache-ttl 300] [--min-send-gap-ms 1000] [--poll-idle-ms 300]
  node server.mjs status  [--auth-file PATH]
  node server.mjs help

环境变量:
  ILINK_BRIDGE_TOKEN         HTTP Bearer token（--token 优先）
  ILINK_BRIDGE_AUTH_FILE     凭证文件（默认 <本目录>/data/weixin-ilink-auth.json）
  ILINK_BRIDGE_SYNC_BUF      消息游标文件（默认 <本目录>/data/weixin-ilink-syncbuf.txt）

安全: 只监听回环地址；token 只从文件/环境读取，日志只打印 token=set，绝不输出其值。
`;

function parseArgs(argv) {
  const out = { command: "run", values: {} };
  const take = (name) => {
    const v = argv[++i];
    if (v === undefined) throw new Error(`缺少 ${name} 的值`);
    return v;
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (["login", "run", "status", "help"].includes(a) && out.command === "run" && out._seenCmd !== true) {
      out.command = a;
      out._seenCmd = true;
      continue;
    }
    switch (a) {
      case "-h":
      case "--help":
        out.command = "help";
        break;
      case "--port": out.values.port = Number(take(a)); break;
      case "--host": out.values.host = take(a); break;
      case "--token": out.values.token = take(a); break;
      case "--token-file": out.values.tokenFile = take(a); break;
      case "--auth-file": out.values.authFile = take(a); break;
      case "--base-url": out.values.baseUrl = take(a); break;
      case "--channel-version": out.values.channelVersion = take(a); break;
      case "--bot-agent": out.values.botAgent = take(a); break;
      case "--sync-buf-file": out.values.syncBufFile = take(a); break;
      case "--media-cache-ttl": out.values.mediaCacheTtl = Number(take(a)); break;
      case "--min-send-gap-ms": out.values.minSendGapMs = Number(take(a)); break;
      case "--poll-idle-ms": out.values.pollIdleMs = Number(take(a)); break;
      case "--qr-timeout-ms": out.values.qrTimeoutMs = Number(take(a)); break;
      case "--no-media": out.values.mediaEnabled = false; break;
      default:
        if (a.startsWith("-")) throw new Error(`未知参数: ${a}`);
    }
  }
  return out;
}

function defaultAuthFile(values) {
  return values.authFile || process.env.ILINK_BRIDGE_AUTH_FILE || path.join(__dirname, "data", "weixin-ilink-auth.json");
}

async function readToken(values) {
  if (values.token) return String(values.token);
  if (process.env.ILINK_BRIDGE_TOKEN) return String(process.env.ILINK_BRIDGE_TOKEN);
  if (values.tokenFile) {
    try {
      return (await readFile(values.tokenFile, "utf8")).trim();
    } catch (e) {
      throw new Error(`读取 token 文件失败：${values.tokenFile}: ${e?.message ?? e}`);
    }
  }
  return "";
}

async function main() {
  const { command, values } = parseArgs(process.argv.slice(2));
  if (command === "help") {
    console.log(HELP);
    return;
  }
  const authFile = defaultAuthFile(values);

  if (command === "login") {
    const auth = await doLogin(values, { authFile });
    if (auth) {
      await saveAuthFile(authFile, auth);
      console.log(`\n凭证已保存：${authFile}`);
      console.log("现在运行：node server.mjs run --token-file <TOKEN_FILE>  开始接收微信消息。");
    }
    return;
  }

  if (command === "status") {
    const auth = await loadAuthFile(authFile);
    if (!auth) {
      console.log("尚未登录。运行：node server.mjs login");
      return;
    }
    console.log(JSON.stringify({
      botId: auth.botId,
      baseUrl: auth.baseUrl,
      token: mask(auth.token, 8),
      loggedInAt: auth.loggedInAt ? new Date(auth.loggedInAt).toISOString() : null,
      authFile,
    }, null, 2));
    return;
  }

  // run
  const auth = await loadAuthFile(authFile);
  if (!auth) {
    console.error(`❌ 未找到凭证：${authFile}\n先运行：node server.mjs login`);
    process.exitCode = 1;
    return;
  }
  const token = await readToken(values);
  if (!token) {
    console.error("❌ 缺少 HTTP Bearer token：用 --token-file / --token / ILINK_BRIDGE_TOKEN 提供（建议放 0600 文件）");
    process.exitCode = 1;
    return;
  }

  const client = createIlinkClient({
    baseUrl: auth.baseUrl || values.baseUrl || DEFAULT_BASE_URL,
    token: auth.token,
    channelVersion: auth.channelVersion || values.channelVersion || DEFAULT_CHANNEL_VERSION,
    botAgent: values.botAgent || DEFAULT_BOT_AGENT,
    log: (m) => log(m),
  });

  const port = Number(values.port ?? DEFAULT_PORT);
  const host = values.host ?? DEFAULT_HOST;
  const bridge = createBridge({
    client,
    auth,
    token,
    mediaEnabled: values.mediaEnabled !== false,
    syncBufFile: values.syncBufFile || process.env.ILINK_BRIDGE_SYNC_BUF || path.join(path.dirname(authFile), "weixin-ilink-syncbuf.txt"),
    pollIdleMs: values.pollIdleMs ?? 300,
    mediaCacheTtlMs: values.mediaCacheTtl ?? MEDIA_CACHE_TTL_MS,
    minSendGapMs: values.minSendGapMs ?? 1000,
  });
  const { port: actual } = await bridge.start({ port, host });
  log(`iLink bridge 已启动 http://${host}:${actual} backend=${BACKEND} version=${VERSION} token=set media=${values.mediaEnabled !== false}`);
  log(`health: curl -H "Authorization: Bearer <TOKEN>" http://${host}:${actual}/health`);

  const shutdown = async () => {
    log("正在退出…");
    await bridge.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`错误：${e?.stack ?? e}`);
    process.exitCode = 1;
  });
}
