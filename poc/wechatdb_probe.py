# -*- coding: utf-8 -*-
"""wechatdb_probe.py — 用 wechatauto-replica 的 WeChatDB 只读验证微信 4.1.12.55 本地库。

这是 ``docs/research/compat-4.1.12.55.md`` 第 3 项的独立脚本，跑在**独立 venv**
``C:\\dev\\wa-replica-venv``（wechatauto-replica 1.2.10），不动 SiverWXbot 的 venv。

它只做**只读**：
  get_self_info       当前登录账号昵称/备注（contact.db）
  get_sessions        会话列表（session.db）
  get_groups          群列表 + 群成员（contact.db）
  get_group_members   单个群成员（chatroom_member/contact）
  get_messages        某会话最近消息（message_*.db）

WeChatDB 的密钥来自**运行中微信进程内存只读扫描**（Config.Cipher 主路径 + cfg 回退），
解密出的明文库写进 ``%TEMP%\\wechatauto_db\\<account>``，不改动原始 .db 文件。

若版本/依赖不允许（密钥提取锚点随版本漂移、页 1 HMAC 校验不过），脚本**如实记录报错**，
不伪造成功——这正是本任务第 3 项要求的「记录准确错误」。

用法（独立 venv）
    C:\\dev\\wa-replica-venv\\Scripts\\python.exe wechatdb_probe.py --out wechatdb-report.json
    ... --account wxid_xxx_9550 --limit 5      # 指定账号/条数
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback


def _jsonable(v, depth=0):
    if depth > 3:
        return "<max depth>"
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, tuple, set)):
        return [_jsonable(x, depth + 1) for x in list(v)[:30]]
    if isinstance(v, dict):
        return {str(k): _jsonable(x, depth + 1) for k, x in list(v.items())[:40]}
    try:
        return "<%s> %s" % (type(v).__name__, repr(v)[:160])
    except Exception:
        return "<%s>" % type(v).__name__


def build_report(args):
    report = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "python": sys.version.split()[0]}
    try:
        import wechatauto
        report["wechatauto"] = getattr(wechatauto, "__version__", None)
        from wechatauto.db import WeChatDB, auto_detect_db_dir
        report["dbDirDetected"] = auto_detect_db_dir()
    except BaseException as e:
        report["importError"] = repr(e)
        report["importTraceback"] = traceback.format_exc()
        return report

    t0 = time.time()
    try:
        db = WeChatDB(account=args.account or None)
        report["constructMs"] = int((time.time() - t0) * 1000)
        report["constructed"] = True
        report["account"] = db.account
        report["wxid"] = db.wxid
        report["dbDir"] = db.db_dir
        report["keysLoaded"] = getattr(db, "_keys", None) and len(db._keys) or 0
        report["dbFileCount"] = len(getattr(db, "_db_files", []) or [])
        report["unkeyed"] = list(getattr(db, "unkeyed", []) or [])
    except BaseException as e:
        report["constructMs"] = int((time.time() - t0) * 1000)
        report["constructed"] = False
        report["constructError"] = repr(e)
        report["constructTraceback"] = traceback.format_exc()
        return report

    def safe(name, fn):
        t = time.time()
        try:
            val = fn()
            return {"ok": True, "ms": int((time.time() - t) * 1000),
                    "count": len(val) if isinstance(val, (list, tuple)) else None,
                    "value": _jsonable(val)}
        except BaseException as e:
            return {"ok": False, "ms": int((time.time() - t) * 1000),
                    "error": repr(e), "traceback": traceback.format_exc()}

    report["get_self_info"] = safe("get_self_info", lambda: db.get_self_info())
    sessions = None
    try:
        sessions = db.get_sessions(limit=args.limit)
    except BaseException:
        sessions = None
    report["get_sessions"] = safe("get_sessions", lambda: db.get_sessions(limit=args.limit))

    groups = None
    try:
        groups = db.get_groups()
    except BaseException:
        groups = None
    report["get_groups"] = safe("get_groups", lambda: db.get_groups())

    # 选一个群做 get_group_members；选一个会话做 get_messages
    room_wxid = None
    if groups:
        room_wxid = (groups[0] or {}).get("username")
    if room_wxid:
        report["get_group_members"] = safe(
            "get_group_members(%s)" % room_wxid, lambda: db.get_group_members(room_wxid))
    else:
        report["get_group_members"] = {"skipped": True, "why": "no group was returned by get_groups()"}

    target_user = None
    if sessions:
        target_user = (sessions[0] or {}).get("username")
    if not target_user:
        target_user = db.wxid
    report["get_messages"] = safe(
        "get_messages(%s)" % target_user, lambda: db.get_messages(target_user, limit=args.limit))
    report["messagesTargetUser"] = target_user
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description="Read-only WeChatDB capability probe (wechatauto-replica).")
    ap.add_argument("--account", default="", help="account dir name under xwechat_files (default: auto pick)")
    ap.add_argument("--limit", type=int, default=5)
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv)
    out = os.path.abspath(args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "wechatdb-report.json"))
    try:
        report = build_report(args)
    except BaseException as e:
        report = {"error": repr(e), "traceback": traceback.format_exc()}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("[db] report written:", out)
    print(json.dumps({k: report.get(k) for k in
                      ("constructed", "account", "wxid", "keysLoaded", "dbFileCount", "constructError")},
                     ensure_ascii=False))
    for k in ("get_self_info", "get_sessions", "get_groups", "get_group_members", "get_messages"):
        v = report.get(k, {})
        brief = {kk: v.get(kk) for kk in ("ok", "count", "error", "skipped") if kk in v}
        print("[db] %-20s %s" % (k, json.dumps(brief, ensure_ascii=False)))
    return 0 if report.get("constructed") else 4


if __name__ == "__main__":
    raise SystemExit(main())
