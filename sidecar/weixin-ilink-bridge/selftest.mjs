#!/usr/bin/env node
/**
 * selftest.mjs —— mock iLink 服务端 + 进程内启动 bridge，验证 HTTP 契约。
 *
 * 覆盖：
 *   - 200：/health、/status、/rooms、/members、/messages（字段）、/send、/media、/listen
 *   - 401：缺 token / 错 token
 *   - 404：未知路径、未知媒体 id
 *   - 501：不支持的媒体类型（语音）
 *   - 消息字段：nativeId / room="" / sender / text / at(ISO) / ats / own / media
 *   - /send 必须回传 context_token；Idempotency-Key 去重
 *   - /messages 游标推进与空页
 *
 * 零依赖，Node 18+。运行：node selftest.mjs
 */

import http from "node:http";
import crypto from "node:crypto";
import { createBridge } from "./server.mjs";
import { createIlinkClient } from "./lib/ilink.mjs";

const HTTP_TOKEN = "test-http-token";
const BOT_ID = "mockbot@im.bot";
const USER_ID = "tester@im.wechat";
const CTX = "ctx-token-A";

// ---- 固定 AES-128-ECB 测试载荷（明文含 PNG 魔数，供图片 mime 嗅探） ----
const AESKEY_HEX = "00112233445566778899aabbccddeeff";
const AESKEY = Buffer.from(AESKEY_HEX, "hex");
const PLAINTEXT = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("mock-image-body", "utf8"),
]);
const CIPHER = (() => {
  const c = crypto.createCipheriv("aes-128-ecb", AESKEY, null);
  return Buffer.concat([c.update(PLAINTEXT), c.final()]);
})();
const AES_KEY_B64 = Buffer.from(AESKEY_HEX, "utf8").toString("base64"); // 官方编码：base64(utf8(hex))

let cdnPort = 0;
const mediaRef = () => ({
  encrypt_query_param: "mock-download-param",
  full_url: `http://127.0.0.1:${cdnPort}/mock/cdn/download`,
  aes_key: AES_KEY_B64,
  encrypt_type: 1,
});

// 在 mock 服务端口确定后再构建（mediaRef 需拿到真实 cdnPort）
let MESSAGES = [];
function buildMessages() {
  return [
    {
      message_id: 1001,
      from_user_id: USER_ID,
      to_user_id: BOT_ID,
      message_type: 1,
      context_token: CTX,
      item_list: [{ type: 1, text_item: { text: "你好，这是第一条消息" } }],
    },
    {
      message_id: 1002,
      from_user_id: USER_ID,
      to_user_id: BOT_ID,
      message_type: 1,
      context_token: CTX,
      item_list: [{ type: 2, image_item: { media: mediaRef(), mid_size: CIPHER.length } }],
    },
    {
      message_id: 1003,
      from_user_id: USER_ID,
      to_user_id: BOT_ID,
      message_type: 1,
      context_token: CTX,
      item_list: [{ type: 4, file_item: { media: mediaRef(), file_name: "report.txt", len: String(PLAINTEXT.length) } }],
    },
    {
      message_id: 1004,
      from_user_id: USER_ID,
      to_user_id: BOT_ID,
      message_type: 1,
      context_token: CTX,
      item_list: [{ type: 3, voice_item: { media: mediaRef() } }],
    },
  ];
}

// ---------------------------------------------------------------------------
// mock iLink 服务端
// ---------------------------------------------------------------------------

function startMock() {
  const captured = { sendmessage: [], getupdates: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;

    if (route === "POST /ilink/bot/getupdates") {
      captured.getupdates += 1;
      const first = captured.getupdates === 1;
      const body = JSON.stringify(
        first
          ? { ret: 0, msgs: MESSAGES, get_updates_buf: "buf-1", longpolling_timeout_ms: 35000 }
          : { ret: 0, msgs: [], get_updates_buf: "buf-1", longpolling_timeout_ms: 35000 },
      );
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(body);
    }

    if (route === "POST /ilink/bot/sendmessage") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const msg = parsed.msg ?? {};
        captured.sendmessage.push({
          to: msg.to_user_id,
          context_token: msg.context_token,
          client_id: msg.client_id,
          items: (msg.item_list ?? []).map((i) => ({ type: i.type, text: i.text_item?.text })),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ret: 0 }));
      });
      return;
    }

    if (route === "GET /mock/cdn/download") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(CIPHER.length),
      });
      return res.end(CIPHER);
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ret: -1, errmsg: "mock: unknown route" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      cdnPort = server.address().port;
      resolve({
        url: `http://127.0.0.1:${cdnPort}`,
        captured,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 断言/工具
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) {
    passed++;
    results.push(`  ✅ ${name}`);
  } else {
    failed++;
    results.push(`  ❌ ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(base, path, { method = "GET", token = HTTP_TOKEN, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("content-type") ?? "";
  let parsed;
  let buf;
  if (ct.includes("application/json")) {
    parsed = await res.json().catch(() => undefined);
  } else {
    buf = Buffer.from(await res.arrayBuffer());
  }
  return { status: res.status, headers: res.headers, json: parsed, buf, ct };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const mock = await startMock();
  MESSAGES = buildMessages();
  const auth = { token: "mock-bot-token", baseUrl: mock.url, botId: BOT_ID, userId: USER_ID, channelVersion: "2.4.6" };
  const client = createIlinkClient({ baseUrl: mock.url, token: auth.token, channelVersion: "2.4.6", botAgent: "selftest" });
  const bridge = createBridge({ client, auth, token: HTTP_TOKEN, mediaEnabled: true, pollIdleMs: 30, minSendGapMs: 0 });
  const { port } = await bridge.start({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${port}`;

  // 等待后台长轮询把 mock 消息灌入缓冲
  const deadline = Date.now() + 3000;
  while (bridge.events.length < MESSAGES.length && Date.now() < deadline) await sleep(20);

  try {
    // ---- 401 ----
    {
      const noTok = await fetch(`${base}/health`);
      ok("401 缺 token → status 401", noTok.status === 401, `got ${noTok.status}`);
      const body = await noTok.json().catch(() => ({}));
      ok("401 body.error=unauthorized", body.error === "unauthorized", JSON.stringify(body));
      const wrong = await call(base, "/health", { token: "wrong-token" });
      ok("401 错 token → status 401", wrong.status === 401, `got ${wrong.status}`);
    }

    // ---- /health ----
    {
      const r = await call(base, "/health");
      ok("200 GET /health", r.status === 200, `got ${r.status}`);
      const b = r.json ?? {};
      ok("health.backend=ilink", b.backend === "ilink", JSON.stringify(b.backend));
      ok("health.ok=true & available=true", b.ok === true && b.available === true);
      ok("health.version 是字符串", typeof b.version === "string" && b.version.length > 0);
      ok("health.sidecar='1'", b.sidecar === "1");
      const caps = b.capabilities ?? {};
      ok("capabilities.mentions=none", caps.mentions === "none", JSON.stringify(caps));
      ok("capabilities.members=observed", caps.members === "observed");
      ok("capabilities.media=true", caps.media === true);
    }

    // ---- /status ----
    {
      const r = await call(base, "/status");
      ok("200 GET /status", r.status === 200, `got ${r.status}`);
      const b = r.json ?? {};
      ok("status.loggedIn=true", b.loggedIn === true);
      ok("status.wxid=botId", b.wxid === BOT_ID, JSON.stringify(b.wxid));
      ok("status.backend=ilink", b.backend === "ilink");
      ok("status.client=ilink", b.client === "ilink");
      ok("status.name 非空", typeof b.name === "string" && b.name.length > 0);
    }

    // ---- /rooms ----
    let peerSafeId = "";
    {
      const r = await call(base, "/rooms");
      ok("200 GET /rooms", r.status === 200, `got ${r.status}`);
      const rooms = (r.json ?? {}).rooms ?? [];
      ok("rooms 含 1 个单聊对端", rooms.length === 1, JSON.stringify(rooms));
      peerSafeId = rooms[0]?.id ?? "";
      ok("rooms[0].id 形如 ilink_…", /^ilink_[0-9a-f]{16}$/.test(peerSafeId), peerSafeId);
      ok("rooms[0].name 非空", typeof rooms[0]?.name === "string" && rooms[0].name.length > 0);
    }

    // ---- /members ----
    {
      const r = await call(base, `/members?room=${encodeURIComponent(peerSafeId)}`);
      ok("200 GET /members", r.status === 200);
      const members = (r.json ?? {}).members ?? [];
      ok("members 观察到该对端", members.length === 1 && members[0].id === peerSafeId);
      const unknown = await call(base, "/members?room=nobody");
      ok("members 未知 room 返回空数组", (unknown.json ?? {}).members?.length === 0);
    }

    // ---- /messages 字段 ----
    {
      const r = await call(base, "/messages?room=&limit=50");
      ok("200 GET /messages", r.status === 200, `got ${r.status}`);
      const b = r.json ?? {};
      const evs = b.events ?? [];
      ok("messages 返回 4 条事件", evs.length === 4, `got ${evs.length}`);
      ok("messages.next 非空", typeof b.next === "string" && b.next.length > 0);
      ok("messages.head 非空", typeof b.head === "string" && b.head.length > 0);

      const e0 = evs[0] ?? {};
      ok("event.nativeId 正确", e0.nativeId === "1001", JSON.stringify(e0.nativeId));
      ok("event.room=''（单聊）", e0.room === "");
      ok("event.sender.id=ilink_…", /^ilink_[0-9a-f]{16}$/.test(e0.sender?.id ?? ""), JSON.stringify(e0.sender));
      ok("event.text 正确", e0.text === "你好，这是第一条消息", JSON.stringify(e0.text));
      ok("event.at 为 ISO8601 UTC（秒级 Z）", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(e0.at ?? ""), e0.at);
      ok("event.ats=[]", Array.isArray(e0.ats) && e0.ats.length === 0);
      ok("event.own=false", e0.own === false);
      ok("event.media=[]（纯文本）", Array.isArray(e0.media) && e0.media.length === 0);

      const e1 = evs[1] ?? {};
      ok("图片事件 text=[图片] 占位", e1.text === "[图片]", JSON.stringify(e1.text));
      ok("图片事件 media 含 1 条 image", Array.isArray(e1.media) && e1.media.length === 1 && e1.media[0].kind === "image" && e1.media[0].id === "1002#0", JSON.stringify(e1.media));

      const e2 = evs[2] ?? {};
      ok("文件事件 text=[文件消息]", e2.text === "[文件消息]", JSON.stringify(e2.text));
      const e3 = evs[3] ?? {};
      ok("语音事件 text=[语音消息]", e3.text === "[语音消息]", JSON.stringify(e3.text));
    }

    // ---- /messages 游标 ----
    {
      const first = await call(base, "/messages?room=&limit=50");
      const next = (first.json ?? {}).next;
      const again = await call(base, `/messages?room=&limit=50&cursor=${encodeURIComponent(next)}`);
      ok("cursor 推进后无新事件 → events=[]", (again.json ?? {}).events?.length === 0, JSON.stringify(again.json));
      ok("无新事件时 next 原样返回", (again.json ?? {}).next === next, `${again.json?.next} != ${next}`);
    }

    // ---- /send + context_token + 幂等 ----
    {
      const before = mock.captured.sendmessage.length;
      const r = await call(base, "/send", { method: "POST", body: { room: peerSafeId, text: "回复测试" } });
      ok("200 POST /send", r.status === 200, `got ${r.status} ${JSON.stringify(r.json)}`);
      ok("send.msgId 非空", typeof (r.json ?? {}).msgId === "string" && (r.json ?? {}).msgId.length > 0);
      ok("send.deduped=false", (r.json ?? {}).deduped === false);
      const sent = mock.captured.sendmessage[before];
      ok("sendmessage.to=对端 userId", sent?.to === USER_ID, JSON.stringify(sent?.to));
      ok("sendmessage 回传 context_token", sent?.context_token === CTX, JSON.stringify(sent?.context_token));
      ok("sendmessage item 为文本", sent?.items?.[0]?.type === 1 && sent.items[0].text === "回复测试");

      // 幂等重放
      const k = "idem-1";
      const a = await call(base, "/send", { method: "POST", headers: { "Idempotency-Key": k }, body: { room: peerSafeId, text: "幂等A" } });
      const b = await call(base, "/send", { method: "POST", headers: { "Idempotency-Key": k }, body: { room: peerSafeId, text: "幂等A" } });
      ok("幂等重放 deduped=true", (b.json ?? {}).deduped === true, JSON.stringify(b.json));
      ok("幂等重放同 msgId", (a.json ?? {}).msgId === (b.json ?? {}).msgId);

      // quoteId：解析到已观测消息时带上 ref_msg（mock 只校验请求仍成功、仍回传 context_token）
      const q = await call(base, "/send", { method: "POST", body: { room: peerSafeId, text: "引用回复", quoteId: "1001" } });
      ok("200 /send 带 quoteId", q.status === 200, `got ${q.status}`);
    }

    // ---- /media 200（图片） ----
    {
      const r = await call(base, "/media/1002%230");
      ok("200 GET /media 图片", r.status === 200, `got ${r.status}`);
      ok("media content-type image/*", (r.ct ?? "").startsWith("image/"), r.ct);
      ok("media 字节=解密后明文", Buffer.isBuffer(r.buf) && r.buf.equals(PLAINTEXT), `len=${r.buf?.length}`);
    }
    // ---- /media 200（文件） ----
    {
      const r = await call(base, "/media/1003%230");
      ok("200 GET /media 文件", r.status === 200, `got ${r.status}`);
      ok("file media 字节=解密后明文", Buffer.isBuffer(r.buf) && r.buf.equals(PLAINTEXT));
    }
    // ---- /media 501（语音不支持） ----
    {
      const r = await call(base, "/media/1004%230");
      ok("501 GET /media 语音(不支持)", r.status === 501, `got ${r.status}`);
      ok("501 body.error=unsupported", (r.json ?? {}).error === "unsupported", JSON.stringify(r.json));
    }
    // ---- /media 404（未知 id） ----
    {
      const r = await call(base, "/media/nope%230");
      ok("404 GET /media 未知 id", r.status === 404, `got ${r.status}`);
      ok("404 body.error=not_found", (r.json ?? {}).error === "not_found");
    }

    // ---- /listen ----
    {
      const r = await call(base, "/listen", { method: "POST", body: { rooms: [peerSafeId] } });
      ok("200 POST /listen", r.status === 200, `got ${r.status}`);
      const b = r.json ?? {};
      ok("listen.listening 含该对端", Array.isArray(b.listening) && b.listening.some((x) => x.id === peerSafeId));
      ok("listen.added 含该对端", Array.isArray(b.added) && b.added.includes(peerSafeId));
      const r2 = await call(base, "/listen", { method: "POST", body: { rooms: [] } });
      ok("listen 空集合 → removed 含该对端", Array.isArray((r2.json ?? {}).removed) && r2.json.removed.includes(peerSafeId));
    }

    // ---- 404 未知路径 / 405 方法 ----
    {
      const r = await call(base, "/nope");
      ok("404 未知路径", r.status === 404, `got ${r.status}`);
      ok("404 body.error=not_found", (r.json ?? {}).error === "not_found");
      const m = await call(base, "/health", { method: "POST" });
      ok("405 方法不符", m.status === 405, `got ${m.status}`);
      ok("405 带 Allow 头", (m.headers.get("allow") ?? "").includes("GET"), m.headers.get("allow") ?? "");
    }

    // ---- 400 请求体非法 ----
    {
      const bad = await fetch(`${base}/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" },
        body: "{not json",
      });
      ok("400 /send 非法 JSON", bad.status === 400, `got ${bad.status}`);
      ok("400 body.error=bad_request", (await bad.json().catch(() => ({}))).error === "bad_request");
      const notArray = await call(base, "/listen", { method: "POST", body: { rooms: "nope" } });
      ok("400 /listen rooms 非数组", notArray.status === 400, `got ${notArray.status}`);
      const noText = await call(base, "/send", { method: "POST", body: { room: peerSafeId } });
      ok("400 /send 缺 text", noText.status === 400, `got ${noText.status}`);
    }

    // ---- 409 会话不可接收（无 context_token / 未知 room） ----
    {
      const unknown = await call(base, "/send", { method: "POST", body: { room: "ilink_0000000000000000", text: "x" } });
      ok("409 /send 未知会话 → gone", unknown.status === 409 && (unknown.json ?? {}).error === "gone", `got ${unknown.status} ${JSON.stringify(unknown.json)}`);
      const noCtx = await call(base, "/send", { method: "POST", body: { room: "lazy@im.wechat", text: "x" } });
      ok("409 /send 无 context_token → gone", noCtx.status === 409 && (noCtx.json ?? {}).error === "gone", `got ${noCtx.status}`);
    }

    // ---- /messages 按 room 过滤 ----
    {
      const other = await call(base, "/messages?room=ilink_0000000000000000");
      ok("/messages 未知 room → events=[]", (other.json ?? {}).events?.length === 0, JSON.stringify(other.json));
      const bySafe = await call(base, `/messages?room=${encodeURIComponent(peerSafeId)}`);
      ok("/messages 按 safeId 过滤可见该对端事件", (bySafe.json ?? {}).events?.length === 4, `got ${bySafe.json?.events?.length}`);
    }

    // ---- /media 缓存命中（第二次仍 200） ----
    {
      const again = await call(base, "/media/1002%230");
      ok("media 二次请求命中缓存 → 200", again.status === 200 && Buffer.isBuffer(again.buf) && again.buf.equals(PLAINTEXT));
    }
  } finally {
    await bridge.stop();
    await mock.close();
  }

  // ---- 未登录后端：/health 200 但 available:false，数据端点 502 ----
  {
    const bare = createBridge({ client, auth: null, token: HTTP_TOKEN, mediaEnabled: true, pollIdleMs: 30, minSendGapMs: 0 });
    const started = await bare.start({ port: 0, host: "127.0.0.1" });
    const b2 = `http://127.0.0.1:${started.port}`;
    try {
      const h = await call(b2, "/health");
      ok("未登录 /health 仍 200", h.status === 200, `got ${h.status}`);
      ok("未登录 health.available=false", (h.json ?? {}).available === false);
      ok("未登录 health 带 detail", typeof (h.json ?? {}).detail === "string" && (h.json ?? {}).detail.length > 0);
      const s = await call(b2, "/status");
      ok("未登录 /status loggedIn=false", (s.json ?? {}).loggedIn === false);
      const rooms = await call(b2, "/rooms");
      ok("未登录 /rooms → 502 unavailable", rooms.status === 502 && (rooms.json ?? {}).error === "unavailable", `got ${rooms.status}`);
      const msg = await call(b2, "/messages?room=");
      ok("未登录 /messages → 502", msg.status === 502, `got ${msg.status}`);
    } finally {
      await bare.stop();
    }
  }

  console.log("\n=== weixin-ilink-bridge selftest ===");
  for (const line of results) console.log(line);
  console.log(`\n结果：${passed} 通过，${failed} 失败，共 ${passed + failed} 项`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("selftest 运行异常：", e?.stack ?? e);
  process.exitCode = 1;
});
