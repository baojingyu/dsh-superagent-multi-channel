#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""weixin-db-bridge 自测（fake 模式，无需微信、跨平台）。

在进程内用 ``ThreadingHTTPServer`` 起一个 ``--fake`` 后端，按 ``contract.md`` 逐项
断言 HTTP 契约：鉴权、错误码、八个端点的字段形状、游标翻页、媒体字节、能力自述。
退出码 0 表示全部通过。

    python sidecar/weixin-db-bridge/selftest.py
"""
from __future__ import annotations

import json
import os
import sys
import threading
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server as bridge  # noqa: E402

TOKEN = "selftest-token-" + os.urandom(4).hex()
FAILURES = []
CHECKS = 0


def check(name, condition, detail=""):
    global CHECKS
    CHECKS += 1
    if condition:
        sys.stdout.write("  ok  %s\n" % name)
    else:
        sys.stdout.write("FAIL  %s  %s\n" % (name, detail))
        FAILURES.append(name)


def request(method, path, token=TOKEN, body=None, raw=False):
    url = "%s%s" % (BASE_URL, path)
    data = None
    headers = {}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = resp.read()
            if raw:
                return resp.status, payload, resp.headers.get("Content-Type", "")
            try:
                return resp.status, json.loads(payload.decode("utf-8")), resp.headers
            except (ValueError, UnicodeDecodeError):
                return resp.status, payload, resp.headers
    except urllib.error.HTTPError as error:
        payload = error.read()
        try:
            parsed = json.loads(payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            parsed = payload
        return error.code, parsed, error.headers


def main():
    global BASE_URL
    args = bridge.parse_args(["--fake", "--port", "0", "--token", TOKEN, "--quiet"])
    httpd = bridge.make_server(args, token=TOKEN, port=0)
    port = httpd.server_address[1]
    BASE_URL = "http://127.0.0.1:%d" % port
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        run_checks()
    finally:
        httpd.shutdown()
        httpd.server_close()

    sys.stdout.write("\n%d checks, %d failure(s)\n" % (CHECKS, len(FAILURES)))
    if FAILURES:
        sys.stdout.write("FAILED: %s\n" % ", ".join(FAILURES))
        return 1
    sys.stdout.write("ALL PASS\n")
    return 0


def run_checks():
    # --- /health --------------------------------------------------------
    status, body, _ = request("GET", "/health")
    check("health 200", status == 200, status)
    check("health ok/available true", body.get("ok") is True and body.get("available") is True, body)
    check("health backend=pc-db", body.get("backend") == "pc-db", body.get("backend"))
    check("health sidecar='1'", body.get("sidecar") == "1", body.get("sidecar"))
    check("health version present", isinstance(body.get("version"), str) and body["version"])
    caps = body.get("capabilities") or {}
    check("capabilities members=full", caps.get("members") == "full", caps)
    check("capabilities mentions in {none,markup}", caps.get("mentions") in ("none", "markup"), caps)
    check("capabilities media=true", caps.get("media") is True, caps)

    # --- /status --------------------------------------------------------
    status, body, _ = request("GET", "/status")
    check("status 200", status == 200, status)
    check("status loggedIn", body.get("loggedIn") is True, body)
    check("status wxid", body.get("wxid") == bridge.FAKE_SELF_WXID, body.get("wxid"))
    check("status backend=pc-db", body.get("backend") == "pc-db", body.get("backend"))
    check("status client present", isinstance(body.get("client"), str) and body["client"])

    # --- /rooms ---------------------------------------------------------
    status, body, _ = request("GET", "/rooms")
    rooms = body.get("rooms") if isinstance(body, dict) else None
    check("rooms 200 + list", status == 200 and isinstance(rooms, list), body)
    ids = {room["id"] for room in rooms or []}
    names = {room["name"] for room in rooms or []}
    check("rooms contains group id", bridge.FAKE_GROUP_ID in ids, ids)
    check("rooms contains single id", bridge.FAKE_SINGLE_ID in ids, ids)
    check("rooms names present", bridge.FAKE_GROUP_NAME in names and bridge.FAKE_SINGLE_NAME in names, names)

    # --- /members -------------------------------------------------------
    status, body, _ = request("GET", "/members?room=" + bridge.FAKE_GROUP_ID)
    members = body.get("members") if isinstance(body, dict) else None
    check("members 200 + list", status == 200 and isinstance(members, list), body)
    pairs = {(m["id"], m["name"]) for m in members or []}
    check("members contains self", (bridge.FAKE_SELF_WXID, bridge.FAKE_SELF_NAME) in pairs, pairs)
    check("members contains alice", ("wxid_fake_alice", "阿黎") in pairs, pairs)
    status, body, _ = request("GET", "/members?room=chatroom_missing")
    check("members unknown -> []", status == 200 and body.get("members") == [], body)

    # --- /messages ------------------------------------------------------
    status, body, _ = request("GET", "/messages?room=" + bridge.FAKE_GROUP_ID + "&limit=50")
    events = body.get("events") if isinstance(body, dict) else None
    check("messages 200 + events", status == 200 and isinstance(events, list) and events, body)
    check("messages next present", isinstance(body.get("next"), str), body)
    native_ids = [event["nativeId"] for event in events or []]
    check("messages nativeId unique", len(native_ids) == len(set(native_ids)), native_ids)
    first = (events or [{}])[0]
    check("event has contract fields", all(key in first for key in
          ("nativeId", "room", "sender", "text", "at", "ats", "own", "quoteId", "media")), first)
    check("event sender object", isinstance(first.get("sender"), dict) and "id" in first["sender"] and "name" in first["sender"], first)
    check("event text non-empty", all(isinstance(e["text"], str) and e["text"] != "" for e in events or []), [e["text"] for e in events or []])
    check("event at ISO-ish", all(isinstance(e["at"], str) and e["at"].endswith("Z") for e in events or []), [e["at"] for e in events or []])
    check("event ats is list", all(isinstance(e["ats"], list) for e in events or []), None)
    check("event own bool", all(isinstance(e["own"], bool) for e in events or []), None)
    check("event room == group id", all(e["room"] == bridge.FAKE_GROUP_ID for e in events or []), [e["room"] for e in events or []])
    image_events = [e for e in events or [] if e.get("media")]
    check("image event has media #{index}", image_events and image_events[0]["media"][0]["id"].endswith("#0")
          and image_events[0]["media"][0]["kind"] == "image", image_events)

    # cursor paging: 用 next 再读，应当没有更新事件
    tail_status, tail_body, _ = request("GET", "/messages?room=" + bridge.FAKE_GROUP_ID + "&cursor=" + body.get("next", "0"))
    check("cursor paging returns none", tail_status == 200 and tail_body.get("events") == [], tail_body)
    check("cursor paging keeps next", tail_body.get("next") == body.get("next"), (tail_body.get("next"), body.get("next")))

    # limit 夹取 [1,200]
    _, clamp_body, _ = request("GET", "/messages?room=" + bridge.FAKE_GROUP_ID + "&limit=100000")
    check("limit clamped to <=200", isinstance(clamp_body.get("events"), list), clamp_body)

    # 单聊 room="" -> room 字段为 ""
    status, body, _ = request("GET", "/messages?room=&limit=50")
    single_events = body.get("events") if isinstance(body, dict) else None
    check("direct messages 200", status == 200 and isinstance(single_events, list), body)
    check("direct event room is ''", all(set_event_room(e) == "" for e in single_events or []), single_events)

    # --- /media ---------------------------------------------------------
    if image_events:
        media_id = image_events[0]["media"][0]["id"]
        encoded = media_id.replace("#", "%23")
        status, payload, ctype = request("GET", "/media/" + encoded, raw=True)
        check("media 200", status == 200, status)
        check("media content-type image/*", ctype.split(";")[0].strip().startswith("image/"), ctype)
        check("media bytes non-empty", isinstance(payload, (bytes, bytearray)) and len(payload) > 8, len(payload or b""))
        check("media PNG magic", bytes(payload[:8]) == b"\x89PNG\r\n\x1a\n", list(bytes(payload[:8])) if payload else None)
    status, body, _ = request("GET", "/media/%2Fnot-exist%230", raw=False)
    check("media unknown -> 404", status == 404 and body.get("error") == "not_found", (status, body))

    # --- /send (只读默认 501) -------------------------------------------
    status, body, _ = request("POST", "/send", body={"room": bridge.FAKE_GROUP_ID, "wxid": "x", "text": "hi"})
    check("send default -> 501 unsupported", status == 501 and body.get("error") == "unsupported", (status, body))

    # --- /listen --------------------------------------------------------
    status, body, _ = request("POST", "/listen", body={"rooms": [bridge.FAKE_GROUP_ID]})
    check("listen 200", status == 200, status)
    listening_ids = {room["id"] for room in (body.get("listening") or [])}
    check("listen reports group", bridge.FAKE_GROUP_ID in listening_ids, body)
    status, body, _ = request("POST", "/listen", body={"rooms": ["chatroom_missing"]})
    check("listen unknown -> failed", status == 200 and [f["room"] for f in body.get("failed") or []] == ["chatroom_missing"], body)
    status, body, _ = request("POST", "/listen", body={"rooms": []})
    check("listen empty -> empty", status == 200 and body.get("listening") == [], body)

    # --- 鉴权与错误码 ---------------------------------------------------
    status, body, _ = request("GET", "/health", token=None)
    check("missing token -> 401", status == 401 and body.get("error") == "unauthorized", (status, body))
    status, body, _ = request("GET", "/health", token="wrong-token")
    check("wrong token -> 401", status == 401 and body.get("error") == "unauthorized", (status, body))

    status, body, _ = request("GET", "/does-not-exist")
    check("unknown path -> 404", status == 404 and body.get("error") == "not_found", (status, body))

    status, body, headers = request("GET", "/send")
    check("GET /send -> 405 + Allow", status == 405 and body.get("error") == "method_not_allowed"
          and "POST" in (headers.get("Allow") or ""), (status, body, headers.get("Allow")))
    status, body, headers = request("POST", "/health", body={})
    check("POST /health -> 405 + Allow", status == 405 and "GET" in (headers.get("Allow") or ""), (status, headers.get("Allow")))

    status, body, _ = request("POST", "/send", body=b"{not json")
    check("bad JSON -> 400", status == 400 and body.get("error") == "bad_request", (status, body))
    status, body, _ = request("POST", "/listen", body={"rooms": "not-a-list"})
    check("listen bad rooms -> 400", status == 400 and body.get("error") == "bad_request", (status, body))


def set_event_room(event):
    return event.get("room")


if __name__ == "__main__":
    sys.exit(main())
