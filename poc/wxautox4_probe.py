# -*- coding: utf-8 -*-
"""wxautox4_probe.py — 用商业库 wxautox4 41.2.3 在微信 4.1.12.55 上做**只读**能力探测。

这是 ``docs/research/compat-4.1.12.55.md`` 第 2 项的独立测试脚本，跑在
``D:\\SiverWXbot_plus-Win11-ready3\\SiverWXbot_plus\\.venv``（装的是 wxautox4 41.2.3）。

授权前提（重要）
----------------
wxautox4 41.2.3 是商业闭源库，构造 ``WeChat()`` 会先过授权闸门（``guarded_init`` 里的
``_cnka``）。本机新进程直接构造会打印「未授权设备，获取授权」并 ``SystemExit(1)``。
仓库既有的进程内放行模块 ``D:\\sec-analysis\\wxautox-bypass\\wx_license_bypass.py``
（只改**本进程内存**、退出即失效、不落盘）可用于验证：

    --license-bypass            # 自动找默认路径并 install()
    --license-bypass PATH       # 指定放行模块

不加 ``--license-bypass`` 时脚本会**如实记录**授权失败（这正是「不伪造成功」的写法）。

只读边界
--------
- 只调用 ``WeChat()`` 构造、``GetMyInfo()``、``IsOnline()``、``GetSession()``；
- **不** ``ChatWith`` / ``AddListenChat`` / ``SendMsg``（不切会话、不置前、不发送）；
- ``GetAllRecentGroups()`` 会打开「通讯录」页（有抢窗口风险），默认不调用；
- 探测前后记录可见窗口类名与 ``weixin.dll+0xab5f198`` 字节；若探测过程改变了 gate
  字节（个别构建会顺手热写），脚本结束前**写回探测前的值**，不遗留对生产微信的修改。

退出码
------
0  报告写出（构造成功，或如实记录授权失败）
3  WeChat() 构造失败
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import importlib
import json
import os
import sys
import time
import traceback

GATE_RVA_4_1_12_55 = 0x0AB5F198
QT_SHELL_CLASS = "Qt51514QWindowIcon"
WECHAT_TITLES = ("微信", "Weixin", "WeChat")
DEFAULT_BYPASS = r"D:\sec-analysis\wxautox-bypass\wx_license_bypass.py"


def _jsonable(v, depth=0):
    if depth > 3:
        return "<max depth>"
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, tuple, set)):
        return [_jsonable(x, depth + 1) for x in list(v)[:50]]
    if isinstance(v, dict):
        return {str(k): _jsonable(x, depth + 1) for k, x in list(v.items())[:50]}
    try:
        return "<%s> %s" % (type(v).__name__, repr(v)[:160])
    except Exception:
        return "<%s>" % type(v).__name__


def _find_main_window():
    import win32gui
    import win32process
    best = None
    def cb(hwnd, _):
        nonlocal best
        try:
            title = win32gui.GetWindowText(hwnd)
            cls = win32gui.GetClassName(hwnd)
            vis = bool(win32gui.IsWindowVisible(hwnd))
        except Exception:
            return True
        if title in WECHAT_TITLES or cls in (QT_SHELL_CLASS, "mmui::MainWindow"):
            pid = int(win32process.GetWindowThreadProcessId(hwnd)[1])
            row = {"hwnd": int(hwnd), "pid": pid, "class": cls, "title": title, "visible": vis}
            if vis and (best is None or best.get("visible") is not True):
                best = row
            elif best is None:
                best = row
        return True
    win32gui.EnumWindows(cb, None)
    return best


class _MODULEENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD), ("th32ModuleID", wt.DWORD), ("th32ProcessID", wt.DWORD),
        ("GlblcntUsage", wt.DWORD), ("ProccntUsage", wt.DWORD),
        ("modBaseAddr", ctypes.c_void_p), ("modBaseSize", wt.DWORD), ("hModule", wt.HMODULE),
        ("szModule", wt.WCHAR * 256), ("szExePath", wt.WCHAR * 260),
    ]


def _module_base(pid: int, name: str):
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    snap = k32.CreateToolhelp32Snapshot(0x00000008 | 0x00000010, pid)
    if not snap or snap == ctypes.c_void_p(-1).value:
        return None
    try:
        e = _MODULEENTRY32W(); e.dwSize = ctypes.sizeof(e)
        ok = k32.Module32FirstW(snap, ctypes.byref(e))
        while ok:
            if e.szModule.lower() == name.lower():
                return ctypes.cast(e.modBaseAddr, ctypes.c_void_p).value
            ok = k32.Module32NextW(snap, ctypes.byref(e))
    finally:
        k32.CloseHandle(snap)
    return None


def _open(pid: int, write: bool):
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wt.HANDLE
    access = 0x0400 | 0x0010 | (0x0020 | 0x0008 if write else 0)
    return k32.OpenProcess(access, False, pid)


def _read_byte(pid: int, address: int):
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    h = _open(pid, write=False)
    if not h:
        return None
    try:
        buf = (ctypes.c_ubyte * 1)()
        read = ctypes.c_size_t(0)
        ok = k32.ReadProcessMemory(h, ctypes.c_void_p(address), buf, 1, ctypes.byref(read))
        return int(buf[0]) if ok and read.value == 1 else None
    finally:
        k32.CloseHandle(h)


def _write_byte(pid: int, address: int, value: int) -> bool:
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    h = _open(pid, write=True)
    if not h:
        return False
    try:
        buf = (ctypes.c_ubyte * 1)(value & 0xFF)
        written = ctypes.c_size_t(0)
        ok = k32.WriteProcessMemory(h, ctypes.c_void_p(address), buf, 1, ctypes.byref(written))
        return bool(ok and written.value == 1)
    finally:
        k32.CloseHandle(h)


def _gate_byte(pid: int):
    base = _module_base(pid, "weixin.dll")
    if base is None:
        return {"base": None, "byte": None}
    return {"base": hex(int(base)), "rva": hex(GATE_RVA_4_1_12_55),
            "byte": _read_byte(pid, int(base) + GATE_RVA_4_1_12_55)}


def _apply_bypass(path):
    folder = os.path.dirname(path)
    if folder and folder not in sys.path:
        sys.path.insert(0, folder)
    mod = importlib.import_module(os.path.splitext(os.path.basename(path))[0])
    mod.install(verbose=True)
    return mod


def build_report(args):
    report = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "python": sys.version.split()[0], "wxautox4": None,
              "licenseBypass": bool(args.license_bypass),
              "allowRecentGroups": bool(args.allow_recent_groups)}
    try:
        import wxautox4
        report["wxautox4"] = _pkg_version("wxautox4") or getattr(wxautox4, "__version__", None)
    except Exception as e:
        report["wxautox4ImportError"] = repr(e)

    win = _find_main_window()
    report["windowBefore"] = win
    before_gate = _gate_byte(win["pid"]) if win else None
    report["gateByteBefore"] = before_gate

    bypass_mod = None
    if args.license_bypass:
        try:
            bypass_mod = _apply_bypass(args.license_bypass)
            report["bypassInstalled"] = True
        except BaseException as e:
            report["bypassInstalled"] = False
            report["bypassError"] = repr(e)
            report["bypassTraceback"] = traceback.format_exc()

    try:
        from wxautox4.wx import WeChat
        try:
            t0 = time.time()
            wx = WeChat(version="微信")
            report["constructMs"] = int((time.time() - t0) * 1000)
            report["constructed"] = True
        except BaseException as e:
            report["constructed"] = False
            report["constructError"] = repr(e)
            report["constructTraceback"] = traceback.format_exc()
            wx = None

        if wx is not None:
            def safe(fn):
                t0 = time.time()
                try:
                    return {"ok": True, "value": _jsonable(fn()), "ms": int((time.time() - t0) * 1000)}
                except BaseException as e:
                    return {"ok": False, "error": repr(e), "ms": int((time.time() - t0) * 1000)}
            report["GetMyInfo"] = safe(lambda: wx.GetMyInfo())
            report["IsOnline"] = safe(lambda: wx.IsOnline())
            report["GetSession"] = safe(lambda: wx.GetSession())
            if args.allow_recent_groups:
                report["GetAllRecentGroups"] = safe(lambda: wx.GetAllRecentGroups())
            else:
                report["GetAllRecentGroups"] = {"skipped": True,
                    "why": "opens the Contacts page and may steal the window from the running bridge; pass --allow-recent-groups to try"}
            try:
                del wx
            except Exception:
                pass
    finally:
        if bypass_mod is not None:
            try:
                bypass_mod.uninstall(verbose=True)
                report["bypassUninstalled"] = True
            except BaseException as e:
                report["bypassUninstallError"] = repr(e)

    after_win = _find_main_window()
    report["windowAfter"] = after_win
    after_gate = _gate_byte(after_win["pid"]) if after_win else None
    report["gateByteAfter"] = after_gate

    # 如果探测期间 gate 字节被改变，写回探测前的值，不遗留对生产微信的修改
    if before_gate and after_gate and before_gate.get("byte") is not None and \
            after_gate.get("byte") != before_gate.get("byte"):
        base = int(after_gate["base"], 16)
        ok = _write_byte(after_win["pid"], base + GATE_RVA_4_1_12_55, before_gate["byte"])
        report["gateRestored"] = {"to": before_gate["byte"], "ok": ok,
                                  "verified": _read_byte(after_win["pid"], base + GATE_RVA_4_1_12_55)}
    return report


def _pkg_version(name):
    try:
        import importlib.metadata as m
        return m.version(name)
    except Exception:
        return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Read-only wxautox4 capability probe against the running WeChat 4.1.12.55.")
    ap.add_argument("--allow-recent-groups", action="store_true")
    ap.add_argument("--license-bypass", nargs="?", const=DEFAULT_BYPASS, default="",
                    help="path to wx_license_bypass.py (default: %s)" % DEFAULT_BYPASS)
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv)
    out = os.path.abspath(args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "wxautox4-report.json"))
    try:
        report = build_report(args)
    except BaseException as e:
        report = {"error": repr(e), "traceback": traceback.format_exc()}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2); f.write("\n")
    print("[wxautox4] report written:", out)
    print(json.dumps({k: report.get(k) for k in ("constructed", "constructError", "wxautox4", "licenseBypass", "bypassInstalled")}, ensure_ascii=False))
    for k in ("GetMyInfo", "IsOnline", "GetSession", "GetAllRecentGroups"):
        v = report.get(k, {})
        print("[wxautox4] %-18s %s" % (k, json.dumps(v, ensure_ascii=False)[:300]))
    return 0 if report.get("constructed") else 3


if __name__ == "__main__":
    raise SystemExit(main())
