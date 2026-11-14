# -*- coding: utf-8 -*-
"""accessibility_gate_probe.py — 探测微信 4.x 的 Qt accessibility gate 是否物化 ``mmui`` 控件树。

这是 ``docs/research/compat-4.1.12.55.md`` 第 4 项（UIA 控件树缺失与热激活）的证据脚本。

背景
----
微信 4.x 用 Qt 画界面，``QAccessible`` 在响应 ``WM_GETOBJECT`` 前会先看一个运行时
active byte。冷启动、未启用读屏标志时该 byte 为 0，整棵 ``mmui`` 子树不会物化，UIA
只能看到 Qt 外壳（窗口类 ``Qt51514QWindowIcon``）——表现是按钮/会话/消息全部扫不到。
把该 byte 热写成 1 后**当前进程立刻**返回 ``mmui`` provider，无需重启微信。

本脚本：
  1. 定位本会话里可见的微信主窗口（Weixin.exe / 标题 微信/Weixin）；
  2. 记录**激活前**：Win32 窗口类名、UIA 根控件 ClassName、直接子控件类名、``mmui::`` 节点数；
  3. 只读扫描 ``weixin.dll`` 算出 gate RVA 候选，并**只读**读出候选地址当前字节；
  4. ``--activate`` 时调用 ``wechatauto.accessibility.AccessibilityGate`` 的热激活
     （与库内生产逻辑同一函数），校验 ``mmui`` 树是否真的物化，记录**激活后**状态；
  5. 立即把被改的字节**写回原值**，并记录**还原后**状态——生产微信的进程内存被
     恢复成探测前一致（除极短的激活窗口外不做持久修改）。

安全边界
--------
- 默认**只读**：不加 ``--activate`` 不会写任何进程内存。
- ``--activate`` 只改微信自己进程里 1 个运行时标志字节，不注入代码、不挂 DLL、不改磁盘。
- 写后必定回读原值并写回；打完即还原，报告里给出 before/after/restored 三段证据。
- 允许 ``--set-screen-reader-fallback``：直接热写不物化时，按库 ``wake()`` 语义临时
  设系统读屏标志再试，结束后恢复原标志（默认关闭，避免全系统副作用）。

用法
----
    python accessibility_gate_probe.py                     # 只读探测
    python accessibility_gate_probe.py --activate          # 热激活 + 还原
    python accessibility_gate_probe.py --activate --bridge http://127.0.0.1:8787 \
        --token-file C:\\path\\to\\token.txt                # 激活期间顺带记录 bridge /rooms
    python accessibility_gate_probe.py --out gate.json

退出码
------
0  报告写出（只读成功，或激活流程跑完）
2  没找到可见微信窗口
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import time
import traceback
from typing import Any, Dict, List, Optional


# --------------------------------------------------------------------------- 窗口定位
WECHAT_TITLES = ("微信", "Weixin", "WeChat")
QT_SHELL_CLASS = "Qt51514QWindowIcon"
MMUI_PREFIX = "mmui::"


def _enum_windows() -> List[dict]:
    """枚举本会话的微信主窗口：标题或类名匹配就算。"""
    import win32gui  # pywin32

    found: List[dict] = []

    def cb(hwnd, _extra):
        try:
            title = win32gui.GetWindowText(hwnd)
            cls = win32gui.GetClassName(hwnd)
        except Exception:
            return True
        if title in WECHAT_TITLES or cls == QT_SHELL_CLASS:
            found.append({
                "hwnd": int(hwnd),
                "class": cls,
                "title": title,
                "visible": bool(win32gui.IsWindowVisible(hwnd)),
            })
        return True

    win32gui.EnumWindows(cb, None)
    return found


def _pid_from_hwnd(hwnd: int) -> Optional[int]:
    try:
        import win32process
        return int(win32process.GetWindowThreadProcessId(hwnd)[1])
    except Exception:
        return None


# --------------------------------------------------------------------------- UIA 树快照
def _uia_snapshot(hwnd: int, max_children: int = 40) -> dict:
    """用 uiautomation 读出根控件类名、直接子控件类名、``mmui::`` 节点数。

    只看一到两层：足以判断「是 Qt 空壳还是 mmui 树已物化」，不深挖（深挖会慢且易卡）。
    """
    out: dict = {"ok": False}
    try:
        import uiautomation as auto
    except Exception as error:  # pragma: no cover
        out["error"] = "uiautomation import failed: %r" % (error,)
        return out
    try:
        root = auto.ControlFromHandle(hwnd)
    except Exception as error:
        out["error"] = "ControlFromHandle failed: %r" % (error,)
        return out
    if root is None:
        out["error"] = "ControlFromHandle returned None"
        return out
    try:
        root_class = root.ClassName or ""
    except Exception:
        root_class = ""
    children: List[str] = []
    mmui_direct = 0
    mmui_deep = 1 if root_class.startswith(MMUI_PREFIX) else 0
    try:
        kids = root.GetChildren() or []
    except Exception:
        kids = []
    for kid in kids[:max_children]:
        try:
            cls = kid.ClassName or ""
        except Exception:
            cls = ""
        children.append(cls)
        if cls.startswith(MMUI_PREFIX):
            mmui_direct += 1
            mmui_deep += 1
        # 再下钻一层，统计 mmui 后代（Qt 外壳常见结构：QWindow -> MMUI...）
        try:
            for g in (kid.GetChildren() or [])[:max_children]:
                try:
                    gcls = g.ClassName or ""
                except Exception:
                    gcls = ""
                if gcls.startswith(MMUI_PREFIX):
                    mmui_deep += 1
        except Exception:
            pass
    out.update({
        "ok": True,
        "rootClass": root_class,
        "controlType": getattr(getattr(root, "ControlTypeName", ""), "__str__", lambda: "")(),
        "children": children,
        "mmuiDirect": mmui_direct,
        "mmuiDeepTwoLevels": mmui_deep,
        "isQtShell": root_class == QT_SHELL_CLASS and mmui_deep == 0,
    })
    return out


# --------------------------------------------------------------------------- gate 字节
def _load_accessibility():
    """导入库的真实热激活模块；失败返回 (None, reason)。"""
    try:
        from wechatauto.accessibility import AccessibilityGate  # noqa: PLC0415
        return AccessibilityGate, ""
    except Exception as error:  # pragma: no cover
        return None, repr(error)


def _load_module():
    """整个 ``wechatauto.accessibility`` 模块：``_dll_identity`` / ``_gate_cache`` 是模块级函数，
    不是 ``AccessibilityGate`` 的类属性（1.2.10 的模块结构）。"""
    try:
        import wechatauto.accessibility as mod  # noqa: PLC0415
        return mod
    except Exception:  # pragma: no cover
        return None


def _gate_probe(hwnd: int, pid: int) -> dict:
    """只读：定位 weixin.dll、算 gate RVA 候选、读每个候选当前字节。"""
    AccessibilityGate, reason = _load_accessibility()
    if AccessibilityGate is None:
        return {"ok": False, "error": "cannot import wechatauto.accessibility: " + reason}
    mod = AccessibilityGate._weixin_dll_module(pid)
    if not mod:
        return {"ok": False, "error": "weixin.dll not found in pid %s modules" % pid}
    base, size, dll_path = mod
    cands = list(AccessibilityGate._qaccessible_candidate_rvas(dll_path))
    out: dict = {
        "ok": True,
        "dllPath": dll_path,
        "dllSize": size,
        "base": hex(int(base)),
        "candidateRvas": [hex(int(c)) for c in cands],
        "candidatesRead": [],
    }
    if not cands:
        return out
    # 用库自己的 OpenProcess + ReadProcessMemory 读候选当前字节
    access = 0x0400 | 0x0010  # QUERY_INFORMATION | VM_READ
    k32 = ctypes.windll.kernel32
    k32.OpenProcess.restype = ctypes.c_void_p
    handle = k32.OpenProcess(access, False, pid)
    if not handle:
        out["error"] = "OpenProcess(read) failed err=%s" % ctypes.get_last_error()
        return out
    try:
        for rva in cands[:8]:
            addr = int(base) + int(rva)
            val = AccessibilityGate._read_process_byte(handle, addr)
            out["candidatesRead"].append({"rva": hex(int(rva)), "currentByte": val})
    finally:
        k32.CloseHandle(ctypes.c_void_p(handle))
    return out


def _find_verified_rva(hwnd: int, pid: int) -> Optional[int]:
    """热激活成功后库会把生效 RVA 记进缓存；据此定位要还原的地址。"""
    AccessibilityGate, _ = _load_accessibility()
    mod = _load_module()
    if AccessibilityGate is None or mod is None:
        return None
    dll = AccessibilityGate._weixin_dll_module(pid)
    if not dll:
        return None
    base, _size, dll_path = dll
    identity = mod._dll_identity(dll_path)
    rva = mod._VERIFIED_GATE_RVA.get(identity)
    if rva is None:
        disk = mod._gate_cache().get(identity, {}).get("verified")
        if isinstance(disk, int):
            rva = disk
    return int(rva) if rva is not None else None


def _write_byte(pid: int, rva: int, base: int, value: int) -> Optional[int]:
    """直接写/还原某 RVA 的字节，返回写入前的旧值（失败 None）。"""
    AccessibilityGate, _ = _load_accessibility()
    if AccessibilityGate is None:
        return None
    k32 = ctypes.windll.kernel32
    k32.OpenProcess.restype = ctypes.c_void_p
    handle = k32.OpenProcess(0x0400 | 0x0010 | 0x0020 | 0x0008, False, pid)
    if not handle:
        return None
    try:
        addr = int(base) + int(rva)
        old = AccessibilityGate._read_process_byte(handle, addr)
        AccessibilityGate._write_process_byte(handle, addr, value)
        return old
    finally:
        k32.CloseHandle(ctypes.c_void_p(handle))


def _spi_get_screen_reader() -> Optional[int]:
    try:
        v = ctypes.c_int(0)
        ok = ctypes.windll.user32.SystemParametersInfoW(0x1046, 0, ctypes.byref(v), 0)
        return int(v.value) if ok else None
    except Exception:
        return None


def _spi_set_screen_reader(enable: bool) -> None:
    try:
        ctypes.windll.user32.SystemParametersInfoW(0x1047, 0, ctypes.c_void_p(1 if enable else 0), 0x02)
    except Exception:
        pass


# --------------------------------------------------------------------------- bridge 交叉验证
def _bridge_get(base_url: str, path: str, token: str, timeout: float = 40.0) -> dict:
    """最小 HTTP GET（带 Bearer），返回 {status, body, error, ms}。"""
    import urllib.request
    import urllib.error
    t0 = time.time()
    req = urllib.request.Request(base_url.rstrip("/") + path, headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            return {"status": resp.status, "body": body, "ms": int((time.time() - t0) * 1000)}
    except Exception as error:
        return {"error": repr(error), "ms": int((time.time() - t0) * 1000)}


# --------------------------------------------------------------------------- 主流程
def build_report(args) -> dict:
    report: dict = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "python": sys.version.split()[0],
        "activate": bool(args.activate),
        "screenReaderFlagBefore": _spi_get_screen_reader(),
        "windows": [],
    }
    windows = _enum_windows()
    report["windowCount"] = len(windows)
    if not windows:
        report["conclusion"] = "no WeChat window found in this session"
        return report

    # 优先可见窗口
    windows.sort(key=lambda w: (not w["visible"], w["hwnd"]))
    for win in windows:
        hwnd = win["hwnd"]
        pid = _pid_from_hwnd(hwnd)
        entry: dict = dict(win)
        entry["pid"] = pid
        entry["before"] = _uia_snapshot(hwnd)
        if pid:
            entry["gate"] = _gate_probe(hwnd, pid)
        if args.activate and pid:
            entry["activation"] = _activate_one(hwnd, pid, args, report)
        report["windows"].append(entry)
        if args.activate:
            break  # 只对第一个目标窗口做激活，避免多点写

    # 结论
    first = report["windows"][0]
    before = first.get("before", {})
    act = first.get("activation", {})
    if act.get("ok"):
        after = act.get("afterActivation", {})
        if after.get("mmuiDeepTwoLevels", 0) > before.get("mmuiDeepTwoLevels", 0):
            report["conclusion"] = (
                "hot activation materialized mmui tree: root %s -> %s" % (
                    before.get("rootClass"), after.get("rootClass")))
        else:
            report["conclusion"] = "activation ran but mmui tree did not appear (see errors)"
    else:
        report["conclusion"] = (
            "read-only: rootClass=%s, mmui=%s (Qt shell=%s)" % (
                before.get("rootClass"), before.get("mmuiDeepTwoLevels"), before.get("isQtShell")))
    return report


def _activate_one(hwnd: int, pid: int, args, report: dict) -> dict:
    """热激活 + 校验 + 还原；返回全过程证据。"""
    AccessibilityGate, reason = _load_accessibility()
    out: dict = {"ok": False}
    if AccessibilityGate is None:
        out["error"] = "cannot import AccessibilityGate: " + reason
        return out

    # 记录原 gate 字节（用于还原）
    mod = AccessibilityGate._weixin_dll_module(pid)
    if not mod:
        out["error"] = "weixin.dll not found"
        return out
    base, _size, dll_path = mod
    cands = list(AccessibilityGate._qaccessible_candidate_rvas(dll_path))
    original_bytes: Dict[str, int] = {}
    k32 = ctypes.windll.kernel32
    k32.OpenProcess.restype = ctypes.c_void_p
    h = k32.OpenProcess(0x0400 | 0x0010, False, pid)
    if h:
        try:
            for rva in cands[:4]:
                v = AccessibilityGate._read_process_byte(h, int(base) + int(rva))
                if v is not None:
                    original_bytes[hex(int(rva))] = v
        finally:
            k32.CloseHandle(ctypes.c_void_p(h))
    out["originalBytes"] = original_bytes

    # bridge 交叉验证（激活前）
    token = _read_token(args)
    bridge_before = None
    if args.bridge and token:
        bridge_before = _bridge_get(args.bridge, "/rooms", token)
        out["bridgeRoomsBefore"] = _summ(bridge_before)

    # 真正调用库的热激活（生产同一函数）
    try:
        ok = AccessibilityGate._hot_activate_accessibility(hwnd, verify=True, max_candidates=4)
    except Exception as error:
        out["error"] = "hot activate raised: %r" % (error,)
        out["traceback"] = traceback.format_exc()
        ok = False
    out["hotActivateReturned"] = bool(ok)

    # 直接热写未物化 → 可选：按 wake() 语义临时设读屏标志重试
    if not ok and args.set_screen_reader_fallback:
        before_flag = _spi_get_screen_reader()
        _spi_set_screen_reader(True)
        try:
            ok = AccessibilityGate._hot_activate_accessibility(hwnd, verify=True, max_candidates=4)
        except Exception as error:
            out["fallbackError"] = repr(error)
        out["fallbackUsedScreenReaderFlag"] = True
        out["screenReaderFlagDuring"] = _spi_get_screen_reader()
        _spi_set_screen_reader(bool(before_flag))
        out["screenReaderFlagRestored"] = _spi_get_screen_reader()

    out["ok"] = bool(ok)
    out["afterActivation"] = _uia_snapshot(hwnd)

    # bridge 交叉验证（激活后、还原前）
    if args.bridge and token:
        bridge_after = _bridge_get(args.bridge, "/rooms", token)
        out["bridgeRoomsDuringActivation"] = _summ(bridge_after)

    # 还原：把改过的字节写回原值（若库成功则 verified RVA 被写 1；其它候选可能被临时改动后已还原）
    restored = {}
    verified = _find_verified_rva(hwnd, pid)
    if verified is not None:
        old = _write_byte(pid, verified, base, 0)
        restored[hex(verified)] = {"restoredTo": 0, "wasBefore": old}
    else:
        # 没有 verified（未成功）：按 originalBytes 全部写回
        for rva_hex, val in original_bytes.items():
            _write_byte(pid, int(rva_hex, 16), base, val)
            restored[rva_hex] = {"restoredTo": val}
    out["restored"] = restored
    out["afterRestore"] = _uia_snapshot(hwnd)
    return out


def _summ(resp: Optional[dict]) -> Any:
    if resp is None:
        return None
    body = resp.get("body")
    if isinstance(body, str) and len(body) > 300:
        body = body[:300] + "..."
    return {"status": resp.get("status"), "error": resp.get("error"), "ms": resp.get("ms"), "body": body}


def _read_token(args) -> Optional[str]:
    if args.token:
        return args.token
    if args.token_file and os.path.exists(args.token_file):
        return open(args.token_file, "r", encoding="utf-8").read().strip()
    env = os.environ.get("WXBRIDGE_TOKEN")
    return env or None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Probe the WeChat 4.x Qt accessibility gate and mmui tree.")
    parser.add_argument("--activate", action="store_true", help="hot-write the gate byte, verify mmui, then restore")
    parser.add_argument("--set-screen-reader-fallback", action="store_true",
                        help="if direct write does not materialize, temporarily set the screen-reader flag and retry")
    parser.add_argument("--bridge", default="", help="bridge base URL for cross-checking /rooms, e.g. http://127.0.0.1:8787")
    parser.add_argument("--token", default="", help="bridge bearer token")
    parser.add_argument("--token-file", default="", help="file holding the bridge bearer token")
    parser.add_argument("--out", default="", help="write the JSON report here (default: ./accessibility-gate-report.json)")
    args = parser.parse_args(argv)

    out = os.path.abspath(args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                   "accessibility-gate-report.json"))
    try:
        report = build_report(args)
    except BaseException as error:
        report = {"error": repr(error), "traceback": traceback.format_exc(),
                  "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("[gate] report written: %s" % out)
    print(json.dumps({k: report.get(k) for k in ("conclusion", "windowCount")}, ensure_ascii=False))
    for w in report.get("windows", []):
        b = w.get("before", {})
        print("[gate] hwnd=%s pid=%s class=%s visible=%s rootClass=%s mmui=%s" % (
            w.get("hwnd"), w.get("pid"), w.get("class"), w.get("visible"),
            b.get("rootClass"), b.get("mmuiDeepTwoLevels")))
    return 0 if report.get("windowCount") else 2


if __name__ == "__main__":
    raise SystemExit(main())
