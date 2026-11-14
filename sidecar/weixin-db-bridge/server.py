#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""weixin-db-bridge —— 微信 4.x 本地数据库只读 sidecar（契约见 ../wxauto-bridge/contract.md）。

后端名固定为 ``pc-db``：不注入进程、不驱动 UIAutomation，只读取微信 4.x 的
SQLCipher 本地库（contact.db / session.db / message_N.db）来回答会话、成员、
消息与图片。发送默认走只读语义（``POST /send`` 返回 501），除非显式
``--allow-send``。监听是拉取式的：``/messages`` 由 Node 轮询直接读库，``/listen``
只做「认不认得这些会话」的应答，绝不 ``AddListenChat``/``StartListening``，
因此不会抢占微信窗口。

设计要点（与 contract.md 严格对齐）：
  * 纯标准库 ``ThreadingHTTPServer`` 提供 HTTP/1.1 + JSON；``wechatauto`` 惰性导入。
  * 每个请求都校验 ``Authorization: Bearer <token>``，用 ``hmac.compare_digest`` 比对。
  * 错误码：400 bad_request / 401 unauthorized / 404 not_found / 405 method_not_allowed /
    409 gone / 500 internal / 501 unsupported / 502 unavailable。
  * ``--fake`` 模式提供确定性数据，不导入 ``wechatauto``、不碰 Windows，供 selftest 使用。
  * token 只经 CLI/环境变量传入，日志只打印 ``token=set``，任何输出都不含 token 值。
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import struct
import sys
import threading
import time
import traceback
import zlib
from collections import OrderedDict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

VERSION = "0.1.0"
SIDECAR = "1"
BACKEND_NAME = "pc-db"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8788
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
MAX_BODY_BYTES = 1 << 20
DEFAULT_MEDIA_TTL_S = 300.0
MEDIA_CACHE_MAX = 64
ROOM_INDEX_TTL_S = 30.0
INIT_RETRY_S = 30.0
ISO_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
WXID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
_SAFE_ID = re.compile(r"[^A-Za-z0-9_-]+")
_CLIENT_VERSION_DIR = re.compile(r"^\d+\.\d+\.\d+\.\d+$")


# --------------------------------------------------------------------------- 异常 → 状态码


class BadRequest(Exception):
    """请求体不是合法 JSON / 不是对象，或参数不合法 → 400。"""


class Unauthorized(Exception):
    """鉴权失败 → 401。"""


class NotFound(Exception):
    """路径或媒体 id 不存在 → 404。"""


class Unsupported(Exception):
    """该后端不具备此能力（只读 send / 无下载能力）→ 501。"""


class Unavailable(Exception):
    """后端暂时不可用 → 502（Node 侧视为可重试）。"""


# --------------------------------------------------------------------------- 通用工具


def iso_now() -> str:
    return time.strftime(ISO_FORMAT, time.gmtime())


def iso_from_epoch(value) -> str:
    """create_time（epoch 秒）→ ISO8601 UTC；无法解析回落服务端时间。"""
    try:
        if isinstance(value, str) and value.strip().isdigit():
            value = int(value)
        if isinstance(value, (int, float)) and value > 0:
            return time.strftime(ISO_FORMAT, time.gmtime(float(value)))
    except (ValueError, OSError, OverflowError):
        pass
    return iso_now()


def field(obj, name):
    return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)


def short_error(error: BaseException, limit: int = 300) -> str:
    text = "%s: %s" % (type(error).__name__, error)
    return text[:limit]


def client_version() -> str:
    """已安装微信客户端版本号（读安装目录里以版本号命名的子目录，无需 UIA/提权）。"""
    roots = []
    for variable in ("ProgramFiles", "ProgramFiles(x86)"):
        base = os.environ.get(variable)
        if base:
            roots.append(os.path.join(base, "Tencent", "Weixin"))
    for root in roots:
        try:
            versions = [name for name in os.listdir(root) if _CLIENT_VERSION_DIR.match(name)]
        except OSError:
            continue
        if versions:
            versions.sort(key=lambda n: tuple(int(p) for p in n.split(".")))
            return versions[-1]
    return ""


def mime_of(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


def make_png(width: int = 1, height: int = 1) -> bytes:
    """在代码里生成 1×1 RGB PNG（fake 后端用，不随包携带二进制）。"""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + b"\x1e\x6b\xd6" * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def room_id_for(username: str, kind: str) -> str:
    """会话 username → 契约允许的稳定 id（``^[A-Za-z0-9_-]+$``）。

    群 chatroomId 形如 ``xxx@chatroom``，含 ``@``，过不了 Node 侧 ``rooms[].id`` 的
    正则；单聊 wxid 通常本身就合规。因此群一律归一为 ``wxdb_g_<sha1[:16]>``，
    单聊合规就原样保留、不合规再归一为 ``wxdb_u_<sha1[:16]>``。归一留在 sidecar，
    后端差异不外溢（与 contract.md §7.1 同一原则）。
    """
    if kind == "group" or username.endswith("@chatroom"):
        return "wxdb_g_" + hashlib.sha1(username.encode("utf-8")).hexdigest()[:16]
    if WXID_PATTERN.match(username or ""):
        return username
    return "wxdb_u_" + hashlib.sha1(username.encode("utf-8")).hexdigest()[:16]


_IMAGE_TYPES = {"图片", "image"}
_TYPE_PLACEHOLDER = {
    "语音": "[语音消息]", "视频": "[视频消息]", "文件/链接/卡片": "[文件消息]",
    "动画表情": "[表情消息]", "位置": "[位置消息]", "音视频通话": "[消息]",
    "系统消息": "[系统消息]", "红包": "[红包]",
}


def render_text(content, type_name) -> str:
    """契约 §3.2：text 永不为空串。有可读 content 就透传，否则按类型给占位。"""
    if isinstance(content, bytes):
        try:
            content = content.decode("utf-8").strip()
        except UnicodeDecodeError:
            content = ""
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(type_name, str) and type_name:
        return _TYPE_PLACEHOLDER.get(type_name, "[%s]" % type_name)
    return "[消息]"


def native_id_for(username: str, shard: str, local_id) -> str:
    """一条消息的稳定 nativeId：聊天 md5 前缀 + 分片名 + local_id。

    local_id 只在分片内唯一，同一分片里不同会话的 Msg_ 表也各自从 1 计数，所以
    必须把「聊天」与「分片」都编进去，否则会撞号、把不同消息当同一条去重。
    """
    chat = hashlib.md5((username or "").encode("utf-8", "replace")).hexdigest()[:6]
    sh = _SAFE_ID.sub("_", re.sub(r"\.db$", "", shard or "")) or "s"
    return "%s_%s_%s" % (chat, sh, local_id)


# --------------------------------------------------------------------------- 后端基类


class BackendBase:
    """契约面（health/status/rooms/members/messages/media/send/listen）的公共骨架。"""

    name = BACKEND_NAME

    def probe(self) -> "tuple[bool, str]":
        return True, ""

    def capabilities(self) -> dict:
        return {"mentions": "none", "members": "full", "media": False}

    def status(self) -> dict:
        raise Unavailable("not implemented")

    def rooms(self) -> list:
        raise Unavailable("not implemented")

    def members(self, room: str) -> list:
        raise Unavailable("not implemented")

    def messages(self, room: str, cursor: str, limit: int) -> dict:
        raise Unavailable("not implemented")

    def media(self, media_id: str) -> "tuple[bytes, str]":
        raise Unsupported("this backend has no media download capability")

    def send(self, payload: dict) -> dict:
        raise Unsupported("read-only backend: sending is not supported")

    def listen(self, rooms: list, options: "dict | None") -> dict:
        raise Unsupported("listen is not supported on this backend")

    def close(self) -> None:
        pass


# --------------------------------------------------------------------------- fake 后端


FAKE_SELF_WXID = "wxid_fake_self"
FAKE_SELF_NAME = "智能助手"
FAKE_GROUP_ID = "chatroom_fake_dev"
FAKE_GROUP_NAME = "研发-交付群"
FAKE_SINGLE_ID = "wxid_fake_alice"
FAKE_SINGLE_NAME = "阿黎"
FAKE_MEMBERS = [
    (FAKE_SELF_WXID, FAKE_SELF_NAME),
    ("wxid_fake_alice", "阿黎"),
    ("wxid_fake_bob", "王博"),
]
_FAKE_BASE_SEQ = 1762400000


def _fake_row(local_id, sender, type_name, content, seq, shard="message__message_0.db", username="", room=""):
    return {
        "username": username, "room": room, "local_id": local_id,
        "sender_username": sender, "type": type_name, "content": content,
        "sort_seq": seq, "create_time": seq, "shard": shard,
    }


class FakeBackend(BackendBase):
    """确定性 fake：不导入 wechatauto、不碰 Windows，供 selftest 验证 HTTP 契约。"""

    name = BACKEND_NAME

    def __init__(self, allow_send: bool = False) -> None:
        self.allow_send = allow_send
        self._png = make_png()
        self._send_cache: "OrderedDict[str, str]" = OrderedDict()
        self._media_ids = set()
        # 群消息
        self._group_rows = [
            _fake_row("1", FAKE_SELF_WXID, "文本", "大家好，我是机器人。", _FAKE_BASE_SEQ + 1,
                      username=FAKE_GROUP_ID, room=FAKE_GROUP_ID),
            _fake_row("2", "wxid_fake_alice", "文本", "把 timeout 改成 3s", _FAKE_BASE_SEQ + 2,
                      username=FAKE_GROUP_ID, room=FAKE_GROUP_ID),
            _fake_row("3", FAKE_SELF_WXID, "文本", "好的，3s 已改。", _FAKE_BASE_SEQ + 3,
                      username=FAKE_GROUP_ID, room=FAKE_GROUP_ID),
            _fake_row("4", "wxid_fake_alice", "图片", "", _FAKE_BASE_SEQ + 4,
                      username=FAKE_GROUP_ID, room=FAKE_GROUP_ID),
        ]
        # 单聊消息（room 为空串）
        self._single_rows = [
            _fake_row("1", "wxid_fake_alice", "文本", "私聊看一下这个报表", _FAKE_BASE_SEQ + 10,
                      shard="message__message_1.db", username=FAKE_SINGLE_ID, room=""),
        ]
        self._nicks = {wxid: name for wxid, name in FAKE_MEMBERS}

    def capabilities(self):
        return {"mentions": "none", "members": "full", "media": True}

    def status(self):
        return {
            "loggedIn": True, "wxid": FAKE_SELF_WXID, "name": FAKE_SELF_NAME,
            "backend": self.name, "available": True, "client": "4.1.12.55",
        }

    def rooms(self):
        return [
            {"id": FAKE_GROUP_ID, "name": FAKE_GROUP_NAME},
            {"id": FAKE_SINGLE_ID, "name": FAKE_SINGLE_NAME},
        ]

    def members(self, room):
        if room in (FAKE_GROUP_ID, FAKE_GROUP_NAME):
            return [{"id": w, "name": n} for w, n in FAKE_MEMBERS]
        if room in (FAKE_SINGLE_ID, FAKE_SINGLE_NAME):
            return [{"id": FAKE_SINGLE_ID, "name": FAKE_SINGLE_NAME}]
        return []

    def _page(self, rows, cursor, limit):
        try:
            since = int(cursor) if cursor else 0
        except (TypeError, ValueError):
            since = 0
        if since > 0:
            chosen = [r for r in rows if r["sort_seq"] > since]
        else:
            chosen = list(rows)
        chosen.sort(key=lambda r: r["sort_seq"])
        page = chosen[:limit]
        next_cursor = str(page[-1]["sort_seq"]) if page else (cursor or "0")
        head = str(max((r["sort_seq"] for r in rows), default=0))
        return page, next_cursor, head

    def messages(self, room, cursor, limit):
        if room in ("", FAKE_SINGLE_ID, FAKE_SINGLE_NAME):
            rows = self._single_rows
        elif room in (FAKE_GROUP_ID, FAKE_GROUP_NAME):
            rows = self._group_rows
        else:
            return {"events": [], "next": cursor or "0", "head": "0"}
        page, next_cursor, head = self._page(rows, cursor, limit)
        items = [(row.get("username", ""), row, row.get("room", "")) for row in page]

        def sink(media_id, _ctx):
            self._media_ids.add(media_id)

        events = _rows_to_events(items, FAKE_SELF_WXID, self._nicks, True, sink)
        return {"events": events, "next": next_cursor, "head": head}

    def media(self, media_id):
        if media_id in self._media_ids:
            return self._png, "image/png"
        raise NotFound(media_id)

    def send(self, payload):
        if not self.allow_send:
            raise Unsupported("read-only backend: sending is not supported (start with --allow-send to enable)")
        key = payload.get("idempotencyKey") or ""
        if key and key in self._send_cache:
            return {"msgId": self._send_cache[key], "deduped": True}
        msg_id = "fake_" + os.urandom(5).hex()
        if key:
            self._send_cache[key] = msg_id
            while len(self._send_cache) > 256:
                self._send_cache.popitem(last=False)
        return {"msgId": msg_id, "deduped": False}

    def listen(self, rooms, options):
        known = {FAKE_GROUP_ID: FAKE_GROUP_NAME, FAKE_GROUP_NAME: FAKE_GROUP_NAME,
                 FAKE_SINGLE_ID: FAKE_SINGLE_NAME, FAKE_SINGLE_NAME: FAKE_SINGLE_NAME}
        listening, added, failed, seen = [], [], [], set()
        prev = getattr(self, "_listening_ids", set())
        now_ids = set()
        for room in rooms:
            if room in known:
                rid = FAKE_GROUP_ID if room in (FAKE_GROUP_ID, FAKE_GROUP_NAME) else FAKE_SINGLE_ID
                if rid in seen:
                    continue
                seen.add(rid)
                now_ids.add(rid)
                listening.append({"id": rid, "name": known[room]})
                if rid not in prev:
                    added.append(known[room])
            else:
                failed.append({"room": room, "detail": "会话不存在"})
        removed = [r for r in prev if r not in now_ids]
        self._listening_ids = now_ids
        return {"listening": listening, "added": added, "removed": removed, "failed": failed}


# --------------------------------------------------------------------------- row → event


def _is_image(type_name) -> bool:
    return isinstance(type_name, str) and type_name in _IMAGE_TYPES


def _rows_to_events(items, self_wxid, nicks, media_available, media_sink):
    """把 (username, row, room_for_event) 列表转成契约事件。

    media_sink(media_id, (username, local_id, shard)) 把「哪条消息的图」登记进
    media 缓存，``GET /media/<id>`` 据此回读并解密。
    """
    events = []
    for username, row, room in items:
        local_id = row.get("local_id")
        seq = row.get("sort_seq")
        shard = row.get("shard", "")
        native = native_id_for(username, shard, local_id)
        type_name = row.get("type")
        text = render_text(row.get("content"), type_name)
        sender_id = row.get("sender_username") or ""
        sender_name = nicks.get(sender_id, sender_id) if sender_id else ""
        media = []
        if media_available and _is_image(type_name):
            media_id = native + "#0"
            media = [{"id": media_id, "kind": "image"}]
            if media_sink is not None:
                media_sink(media_id, (username, local_id, shard))
        events.append({
            "nativeId": native,
            "room": room,
            "sender": {"id": sender_id, "name": sender_name},
            "text": text,
            "at": iso_from_epoch(row.get("create_time", seq)),
            "ats": [],
            "own": bool(self_wxid) and sender_id == self_wxid,
            "quoteId": "",
            "media": media,
        })
    return events


# --------------------------------------------------------------------------- pc-db 后端


def _load_wechatauto(wechatauto_path: str):
    """惰性导入 wechatauto 的 WeChatDB / MediaDownloader。

    优先正常导入（``pip install wechatauto-replica`` 后可用）。若完整包因 UIA 相关
    依赖（uiautomation/winsdk/pyautogui…）缺失而无法导入，则退化为**只加载
    db/media 子模块**——用一个占位 ``wechatauto`` 包对象塞进 ``sys.modules``，
    绕开会拉起整个 UIA 栈的 ``__init__``。只读 DB 后端只需要 DB/媒体，
    不需要 GUI 栈。
    """
    if wechatauto_path:
        path = os.path.abspath(wechatauto_path)
        if os.path.isdir(path) and path not in sys.path:
            sys.path.insert(0, path)
    try:
        from wechatauto import WeChatDB, MediaDownloader  # noqa: PLC0415
        return WeChatDB, MediaDownloader
    except Exception as first_error:  # noqa: BLE001
        import importlib
        import importlib.util
        import types

        spec = importlib.util.find_spec("wechatauto")
        if spec is None or not spec.submodule_search_locations:
            raise first_error
        pkg_dir = list(spec.submodule_search_locations)[0]
        existing = sys.modules.get("wechatauto")
        if existing is None or not hasattr(existing, "__path__"):
            stub = types.ModuleType("wechatauto")
            stub.__path__ = [pkg_dir]
            stub.__package__ = "wechatauto"
            sys.modules["wechatauto"] = stub
        try:
            db_mod = importlib.import_module("wechatauto.db")
            media_mod = importlib.import_module("wechatauto.media")
        except Exception:
            raise first_error
        module = sys.modules["wechatauto"]
        module.WeChatDB = db_mod.WeChatDB
        module.MediaDownloader = media_mod.MediaDownloader
        return db_mod.WeChatDB, media_mod.MediaDownloader


class WeixinDbBackend(BackendBase):
    """``pc-db``：读微信 4.x 本地 SQLCipher 库，只读。"""

    name = BACKEND_NAME

    def __init__(self, db_dir=None, account=None, allow_send=False,
                 media_ttl=DEFAULT_MEDIA_TTL_S, wechatauto_path="", verbose=False):
        self._db_dir = db_dir
        self._account = account
        self.allow_send = allow_send
        self._media_ttl = max(0.0, float(media_ttl))
        self._wechatauto_path = wechatauto_path or os.environ.get("WECHATAUTO_PATH", "")
        self.verbose = verbose
        self._db = None
        self._media = None
        self._self_wxid = ""
        self._init_error = ""
        self._init_error_at = 0.0
        self._lock = threading.RLock()
        self._index = None
        self._index_at = 0.0
        self._media_ctx: "OrderedDict[str, tuple]" = OrderedDict()
        self._media_bytes: "OrderedDict[str, tuple]" = OrderedDict()

    # -- 初始化 -----------------------------------------------------------
    def _ensure(self):
        with self._lock:
            if self._db is not None:
                return self._db
            now = time.monotonic()
            if self._init_error and (now - self._init_error_at) < INIT_RETRY_S:
                raise Unavailable(self._init_error)
            try:
                WeChatDB, MediaDownloader = _load_wechatauto(self._wechatauto_path)
                db = WeChatDB(db_dir=self._db_dir or None, account=self._account or None)
                info = db.get_self_info() or {}
                self._self_wxid = str(field(info, "username") or getattr(db, "wxid", "") or "")
                try:
                    self._media = MediaDownloader(db)
                except Exception:  # noqa: BLE001 —— 媒体探测失败不该拖垮只读读取
                    self._media = None
                self._db = db
                self._init_error = ""
                return db
            except Unavailable:
                raise
            except Exception as error:  # noqa: BLE001
                self._init_error = "微信数据库不可用：%s（确认微信已登录，且运行 sidecar 的进程权限不低于微信）" % short_error(error)
                self._init_error_at = now
                raise Unavailable(self._init_error)

    def probe(self):
        try:
            self._ensure()
            return True, ""
        except Unavailable as error:
            return False, str(error)

    def capabilities(self):
        media = False
        try:
            self._ensure()
            media = self._media is not None
        except Unavailable:
            media = False
        return {"mentions": "none", "members": "full", "media": media}

    # -- 身份与会话索引 ---------------------------------------------------
    @property
    def self_wxid(self):
        self._ensure()
        return self._self_wxid

    def _nicks(self):
        db = self._ensure()
        try:
            return dict(db.nickname_map())
        except Exception:  # noqa: BLE001
            return {}

    def _room_index(self, force=False):
        db = self._ensure()
        now = time.monotonic()
        if not force and self._index is not None and (now - self._index_at) < ROOM_INDEX_TTL_S:
            return self._index
        by_id, by_name, groups, singles = {}, {}, [], []
        try:
            for group in db.get_groups() or []:
                username = str(field(group, "username") or "")
                if not username:
                    continue
                name = str(field(group, "name") or username)
                rid = room_id_for(username, "group")
                by_id[rid] = (username, name, "group")
                by_name.setdefault(name, (username, "group"))
                by_name.setdefault(username, (username, "group"))
                groups.append((username, name, rid))
        except Exception:  # noqa: BLE001
            pass
        group_names = {g[0] for g in groups}
        try:
            for session in db.get_sessions(limit=500) or []:
                username = str(field(session, "username") or "")
                if not username or username in group_names or username.endswith("@chatroom"):
                    continue
                try:
                    name = db.get_nickname(username) or username
                except Exception:  # noqa: BLE001
                    name = username
                rid = room_id_for(username, "single")
                by_id[rid] = (username, name, "single")
                by_name.setdefault(name, (username, "single"))
                by_name.setdefault(username, (username, "single"))
                singles.append((username, name, rid))
        except Exception:  # noqa: BLE001
            pass
        self._index = {"by_id": by_id, "by_name": by_name, "groups": groups, "singles": singles}
        self._index_at = now
        return self._index

    def _resolve_room(self, room):
        """room（空串 / 归一 id / 显示名 / 原始 username）→ (username, kind)。"""
        if room == "":
            return "", "direct"
        index = self._room_index()
        if room in index["by_id"]:
            username, _name, kind = index["by_id"][room]
            return username, kind
        if room in index["by_name"]:
            username, kind = index["by_name"][room]
            return username, kind
        # 原始 chatroom id / wxid 直接传进来
        if room.endswith("@chatroom"):
            return room, "group"
        if WXID_PATTERN.match(room):
            return room, "single"
        return None, ""

    # -- 契约端点 ---------------------------------------------------------
    def status(self):
        try:
            db = self._ensure()
        except Unavailable as error:
            return {
                "loggedIn": False, "wxid": "", "name": "",
                "backend": self.name, "available": False,
                "client": client_version(), "detail": str(error),
            }
        try:
            info = db.get_self_info() or {}
            wxid = str(field(info, "username") or self._self_wxid or "")
            name = str(field(info, "remark") or field(info, "nick_name") or wxid)
        except Exception as error:  # noqa: BLE001
            return {
                "loggedIn": bool(self._self_wxid), "wxid": self._self_wxid, "name": self._self_wxid,
                "backend": self.name, "available": True, "client": client_version(),
                "detail": "读取自身信息失败：%s" % short_error(error),
            }
        return {
            "loggedIn": bool(wxid), "wxid": wxid, "name": name,
            "backend": self.name, "available": True, "client": client_version(),
        }

    def rooms(self):
        index = self._room_index()
        out = []
        for _username, name, rid in index["groups"]:
            out.append({"id": rid, "name": name})
        for _username, name, rid in index["singles"]:
            out.append({"id": rid, "name": name})
        out.sort(key=lambda item: (item["name"] or ""))
        return out[:500]

    def members(self, room):
        username, kind = self._resolve_room(room)
        if not username:
            return []
        db = self._ensure()
        if kind == "single":
            try:
                name = db.get_nickname(username) or username
            except Exception:  # noqa: BLE001
                name = username
            return [{"id": username, "name": name}]
        try:
            rows = db.get_group_members(username) or []
        except Exception:  # noqa: BLE001
            return []
        out = []
        for row in rows:
            wxid = str(field(row, "username") or "")
            if not wxid:
                continue
            name = str(field(row, "remark") or field(row, "nick_name") or wxid)
            out.append({"id": wxid, "name": name})
        return out

    def _collect(self, usernames, cursor, limit):
        """从若干会话收集一页，返回 ([(username,row)], next, head)。"""
        db = self._ensure()
        try:
            since = int(cursor) if cursor else 0
        except (TypeError, ValueError):
            since = 0
        items = []
        max_seq = 0
        for username in usernames:
            try:
                if since > 0:
                    rows = db.get_new_messages(username, since_seq=since, limit=limit) or []
                else:
                    rows = db.get_messages(username, limit=limit) or []
                    rows = list(reversed(rows))
            except Exception:  # noqa: BLE001
                continue
            for row in rows:
                seq = int(field(row, "sort_seq") or 0)
                max_seq = max(max_seq, seq)
                items.append((username, row))
        items.sort(key=lambda pair: int(field(pair[1], "sort_seq") or 0))
        if since > 0:
            # 增量：从游标之后最旧的开始，取一页
            page = items[:limit]
        else:
            # 无游标：返回「最近 limit 条」这一页，多会话合并时要保留最新的一截
            page = items[-limit:] if len(items) > limit else items
        if since > 0:
            next_cursor = str(max((int(field(r, "sort_seq") or 0) for _u, r in page), default=since))
        else:
            next_cursor = str(max((int(field(r, "sort_seq") or 0) for _u, r in page), default=0))
        head = str(max_seq if max_seq else (since or 0))
        return page, next_cursor, head

    def messages(self, room, cursor, limit):
        username, kind = self._resolve_room(room)
        if username is None:
            return {"events": [], "next": cursor or "0", "head": "0"}
        if kind == "direct":
            index = self._room_index()
            usernames = [username for username, _name, _rid in index["singles"]]
            event_room = ""
        elif kind == "single":
            usernames = [username]
            event_room = ""
        else:
            usernames = [username]
            event_room = room_id_for(username, "group")
        page, next_cursor, head = self._collect(usernames, cursor, limit)
        items = [(u, row, event_room) for u, row in page]
        nicks = self._nicks()
        media_available = self.capabilities().get("media", False)
        events = _rows_to_events(items, self._self_wxid, nicks, media_available, self._remember_media)
        return {"events": events, "next": next_cursor, "head": head}

    # -- 媒体 -------------------------------------------------------------
    def _remember_media(self, media_id, ctx):
        self._media_ctx[media_id] = (ctx, time.monotonic())
        while len(self._media_ctx) > MEDIA_CACHE_MAX:
            self._media_ctx.popitem(last=False)

    def media(self, media_id):
        if self._media is None:
            # 明确区分「整体无能力」与「这条取不到」
            self._ensure()
            if self._media is None:
                raise Unsupported("this backend has no media download capability")
        hit = self._media_bytes.get(media_id)
        if hit is not None and hit[0] >= time.monotonic():
            return hit[1], hit[2]
        ctx_hit = self._media_ctx.get(media_id)
        if ctx_hit is None or (time.monotonic() - ctx_hit[1]) > self._media_ttl:
            raise NotFound(media_id)
        (username, local_id, shard), _ts = ctx_hit
        try:
            path = self._media.download_image(username, local_id, shard=shard or None)
        except Exception as error:  # noqa: BLE001
            raise Unavailable("下载图片失败：%s" % short_error(error))
        if not path or not os.path.exists(path):
            raise NotFound(media_id)
        try:
            with open(path, "rb") as handle:
                data = handle.read()
        except OSError as error:
            raise Unavailable("读取图片失败：%s" % short_error(error))
        if not data:
            raise NotFound(media_id)
        mime = mime_of(data)
        self._media_bytes[media_id] = (time.monotonic() + self._media_ttl, data, mime)
        while len(self._media_bytes) > MEDIA_CACHE_MAX:
            self._media_bytes.popitem(last=False)
        return data, mime

    # -- 发送 / 监听 ------------------------------------------------------
    def send(self, payload):
        if not self.allow_send:
            raise Unsupported("read-only backend: sending is not supported (start with --allow-send to enable)")
        room = str(payload.get("room") or "")
        wxid = str(payload.get("wxid") or "")
        text = str(payload.get("text") or "")
        if not text:
            raise BadRequest("text is empty")
        try:
            from wechatauto.guia import quick_send  # noqa: PLC0415
        except Exception as error:  # noqa: BLE001
            raise Unavailable("发送能力不可用（wechatauto.guia 未安装/导入失败）：%s" % short_error(error))
        username, _kind = self._resolve_room(room)
        if room and username is None:
            raise NotFound(room)
        target = wxid or username or room
        try:
            quick_send(text, target)
        except Exception as error:  # noqa: BLE001
            raise Unavailable("发送失败：%s" % short_error(error))
        return {"msgId": "pc-db_" + os.urandom(5).hex(), "deduped": False}

    def listen(self, rooms, options):
        index = self._room_index()
        listening, added, failed, seen = [], [], [], set()
        prev = getattr(self, "_listening_ids", set())
        now_ids = set()
        for room in rooms:
            username, kind = self._resolve_room(room)
            if username is None:
                failed.append({"room": room, "detail": "会话不存在"})
                continue
            rid = room_id_for(username, "group" if kind == "group" else "single")
            if rid in seen:
                continue
            seen.add(rid)
            now_ids.add(rid)
            name = index["by_id"].get(rid, (username, username, kind))[1]
            listening.append({"id": rid, "name": name})
            if rid not in prev:
                added.append(name)
        removed = [rid for rid in prev if rid not in now_ids]
        self._listening_ids = now_ids
        # 只读后端是拉取式：这里不 AddListenChat / 不 StartListening，绝不抢微信窗口。
        return {"listening": listening, "added": added, "removed": removed, "failed": failed}

    def close(self):
        pass


# --------------------------------------------------------------------------- HTTP 层


class BridgeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, backend, token):
        super().__init__(address, handler)
        self.backend = backend
        self.token = token
        self.started_at = time.monotonic()


GET_ROUTES = {"/health", "/status", "/rooms", "/members", "/messages"}
POST_ROUTES = {"/send", "/listen"}


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "weixin-db-bridge/" + VERSION
    protocol_version = "HTTP/1.1"

    # 不把 token 或请求内容写进日志
    def log_message(self, fmt, *args):  # noqa: N802
        if getattr(self.server, "quiet", False):
            return
        sys.stderr.write("[weixin-db-bridge] %s - %s\n" % (self.address_string(), fmt % args))

    # -- 响应 -------------------------------------------------------------
    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status, code, detail=None, allow=None):
        # 错误响应不再复用连接：请求体可能尚未读完，keep-alive 下会串到下一个请求。
        self.close_connection = True
        payload = {"error": code}
        if detail:
            payload["detail"] = detail
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if allow:
            self.send_header("Allow", allow)
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, status, data, mime):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # -- 鉴权与解析 -------------------------------------------------------
    def _authorized(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        supplied = header[len("Bearer "):].strip()
        return hmac.compare_digest(supplied.encode("utf-8"), self.server.token.encode("utf-8"))

    def _read_json(self):
        length = self.headers.get("Content-Length")
        if length is None:
            raise BadRequest("missing Content-Length")
        try:
            size = int(length)
        except ValueError:
            raise BadRequest("invalid Content-Length")
        if size < 0 or size > MAX_BODY_BYTES:
            raise BadRequest("request body too large")
        raw = self.rfile.read(size) if size else b""
        if not raw:
            raise BadRequest("empty body")
        try:
            value = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise BadRequest("body is not valid JSON")
        if not isinstance(value, dict):
            raise BadRequest("body must be a JSON object")
        return value

    # -- 分发 -------------------------------------------------------------
    def do_GET(self):  # noqa: N802
        if not self._guard():
            return
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)
        if path in POST_ROUTES:
            self._send_error(405, "method_not_allowed", allow="POST")
            return
        try:
            if path == "/health":
                self._handle_health()
            elif path == "/status":
                self._send_json(200, self.server.backend.status())
            elif path == "/rooms":
                self._send_json(200, {"rooms": self.server.backend.rooms()})
            elif path == "/members":
                room = (query.get("room", [""])[0])
                self._send_json(200, {"members": self.server.backend.members(room)})
            elif path == "/messages":
                self._handle_messages(query)
            elif path.startswith("/media/"):
                self._handle_media(unquote(parsed.path[len("/media/"):]))
            else:
                self._send_error(404, "not_found", "unknown path: %s" % path)
        except Exception as error:  # noqa: BLE001
            self._map_exception(error)

    def do_POST(self):  # noqa: N802
        if not self._guard():
            return
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        if path in GET_ROUTES or path.startswith("/media/"):
            self._send_error(405, "method_not_allowed", allow="GET")
            return
        try:
            if path == "/send":
                body = self._read_json()
                result = self.server.backend.send(body)
                self._send_json(200, result)
            elif path == "/listen":
                body = self._read_json()
                rooms = body.get("rooms")
                if not isinstance(rooms, list) or not all(isinstance(item, str) for item in rooms):
                    raise BadRequest("rooms must be a string array")
                options = body.get("options")
                if options is not None and not isinstance(options, dict):
                    raise BadRequest("options must be an object")
                self._send_json(200, self.server.backend.listen(rooms, options))
            else:
                self._send_error(404, "not_found", "unknown path: %s" % path)
        except Exception as error:  # noqa: BLE001
            self._map_exception(error)

    # -- 具体处理 ---------------------------------------------------------
    def _handle_health(self):
        backend = self.server.backend
        available, detail = backend.probe()
        payload = {
            "ok": available,
            "available": available,
            "version": VERSION,
            "sidecar": SIDECAR,
            "backend": backend.name,
            "uptimeSec": int(time.monotonic() - self.server.started_at),
            "capabilities": backend.capabilities(),
        }
        if not available and detail:
            payload["detail"] = detail
        self._send_json(200, payload)

    def _handle_messages(self, query):
        room = query.get("room", [""])[0]
        limit_raw = query.get("limit", [str(DEFAULT_LIMIT)])[0]
        cursor = query.get("cursor", [""])[0]
        try:
            limit = int(limit_raw)
        except (TypeError, ValueError):
            raise BadRequest("limit must be an integer")
        if limit < 1:
            limit = 1
        if limit > MAX_LIMIT:
            limit = MAX_LIMIT
        page = self.server.backend.messages(room, cursor, limit)
        self._send_json(200, page)

    def _handle_media(self, media_id):
        data, mime = self.server.backend.media(media_id)
        self._send_bytes(200, data, mime)

    # -- 错误映射 ---------------------------------------------------------
    def _guard(self):
        if self._authorized():
            return True
        # 不区分「没带」与「带错」
        self._send_error(401, "unauthorized")
        return False

    def _map_exception(self, error):
        if isinstance(error, BadRequest):
            self._send_error(400, "bad_request", str(error))
        elif isinstance(error, Unauthorized):
            self._send_error(401, "unauthorized")
        elif isinstance(error, NotFound):
            self._send_error(404, "not_found", str(error))
        elif isinstance(error, Unsupported):
            self._send_error(501, "unsupported", str(error))
        elif isinstance(error, Unavailable):
            self._send_error(502, "unavailable", str(error))
        else:
            if getattr(self.server, "verbose", False):
                traceback.print_exc()
            self._send_error(500, "internal", short_error(error))


# --------------------------------------------------------------------------- 入口


def build_backend(args) -> BackendBase:
    if args.fake:
        return FakeBackend(allow_send=args.allow_send)
    return WeixinDbBackend(
        db_dir=args.db_dir, account=args.account, allow_send=args.allow_send,
        media_ttl=args.media_cache_ttl, wechatauto_path=args.wechatauto_path,
        verbose=args.verbose,
    )


def resolve_token(args) -> str:
    token = args.token or os.environ.get("WXBRIDGE_TOKEN") or os.environ.get("WEIXIN_DB_TOKEN")
    if not token:
        raise SystemExit("缺少 token：用 --token 或环境变量 WXBRIDGE_TOKEN / WEIXIN_DB_TOKEN 提供")
    return token


def make_server(args, backend=None, token=None, host=None, port=None) -> BridgeHTTPServer:
    backend = backend or build_backend(args)
    token = token if token is not None else resolve_token(args)
    host = host or args.host
    port = args.port if port is None else port
    if host not in ("127.0.0.1", "::1", "localhost") and not args.allow_remote:
        raise SystemExit("拒绝绑定非回环地址 %s：如确需请显式 --allow-remote" % host)
    server = BridgeHTTPServer((host, port), BridgeHandler, backend, token)
    server.quiet = args.quiet
    server.verbose = args.verbose
    return server


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="weixin-db-bridge",
        description="微信 4.x 本地数据库只读 sidecar（pc-db 后端，契约见 contract.md）",
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口（默认 %d）" % DEFAULT_PORT)
    parser.add_argument("--token", default="", help="Bearer token（也可用 WXBRIDGE_TOKEN / WEIXIN_DB_TOKEN）")
    parser.add_argument("--fake", action="store_true", help="使用确定性 fake 后端（无需微信，供自测）")
    parser.add_argument("--allow-send", action="store_true", help="允许通过 wechatauto.guia 发送（默认只读 501）")
    parser.add_argument("--allow-remote", action="store_true", help="允许绑定非回环地址")
    parser.add_argument("--db-dir", default=None, help="微信数据根目录（默认自动探测）")
    parser.add_argument("--account", default=None, help="指定账号目录名（默认按最近活动/密钥校验选择）")
    parser.add_argument("--wechatauto-path", default="", help="wechatauto-replica 源码目录（未 pip 安装时指向它）")
    parser.add_argument("--media-cache-ttl", type=float, default=DEFAULT_MEDIA_TTL_S, help="媒体缓存秒数（默认 300）")
    parser.add_argument("--verbose", action="store_true", help="打印异常堆栈到 stderr")
    parser.add_argument("--quiet", action="store_true", help="不打印每个请求的访问日志")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    token = resolve_token(args)
    server = make_server(args, token=token)
    # token 值绝不打印：只说「已设置」。
    sys.stderr.write("[weixin-db-bridge] backend=%s fake=%s token=set listening on http://%s:%d\n"
                     % (server.backend.name, args.fake, args.host, args.port))
    if not args.fake:
        available, detail = server.backend.probe()
        if available:
            sys.stderr.write("[weixin-db-bridge] 微信数据库已就绪\n")
        else:
            sys.stderr.write("[weixin-db-bridge] 微信数据库暂不可用：%s\n" % detail)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\n[weixin-db-bridge] 收到中断，退出\n")
    finally:
        server.backend.close()
        server.server_close()


if __name__ == "__main__":
    main()
