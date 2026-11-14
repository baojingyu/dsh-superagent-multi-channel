# -*- coding: utf-8 -*-
"""gate_guard.py — 保持微信 4.x 的 Qt accessibility gate 打开。

背景（见 docs/research/compat-4.1.12.55.md）：
微信 4.x 冷启动时 Qt 的 QAccessible gate 默认为 0，`mmui` 控件树不会物化，
wxautox4 / UIA 自动化只能看到 Qt 外壳，表现为“未找到已登录的主窗口”或 /rooms 为空。
wechatauto-replica 的 `accessibility.wake()` 能把 gate 热写成 1；本进程按固定间隔
重新扫描微信窗口并调用同一热激活函数，保证微信重启/窗口重建后仍能恢复。

安全边界：
- 只写微信进程内 1 个运行时标志字节（gate），不注入 DLL、不改磁盘、不改聊天数据。
- 需要已登录的桌面微信；Windows only。
- 只作为 wxauto-bridge（pc-uia / wxautox4）在微信 4.1.12.55+ 的伴随进程；
  不解决 wxautox4 授权问题（授权由部署方按商业条款处理）。

依赖：
    pip install wechatauto-replica
（或用 WECHATAUTO_VENV 指向已装 wechatauto 的 venv）

用法：
    python gate_guard.py --once
    python gate_guard.py --interval 10
    python gate_guard.py --status
"""
from __future__ import annotations

import argparse
import sys
import time

WECHAT_TITLES = ("微信", "Weixin", "WeChat")
QT_SHELL_CLASS = "Qt51514QWindowIcon"


def _windows():
    try:
        import win32gui
    except Exception as error:
        raise RuntimeError("pywin32 is required: %r" % (error,))
    found = []

    def callback(hwnd, _):
        try:
            title = win32gui.GetWindowText(hwnd)
            cls = win32gui.GetClassName(hwnd)
        except Exception:
            return True
        if title in WECHAT_TITLES or cls == QT_SHELL_CLASS:
            found.append((int(hwnd), title, cls, bool(win32gui.IsWindowVisible(hwnd))))
        return True

    win32gui.EnumWindows(callback, None)
    return found


def _activate_once(verbose=False):
    try:
        from wechatauto.accessibility import wake
    except Exception as error:
        raise RuntimeError(
            "wechatauto.accessibility is unavailable; install wechatauto-replica "
            "into this interpreter or set WECHATAUTO_VENV: %r" % (error,)
        )
    windows = _windows()
    if not windows:
        if verbose:
            print("[gate-guard] no WeChat window found")
        return False
    ok = False
    for hwnd, title, cls, visible in windows:
        if not visible:
            continue
        try:
            result = wake([hwnd], set_flag=False, verify=True)
        except Exception as error:
            if verbose:
                print("[gate-guard] wake(%s) failed: %r" % (hwnd, error))
            continue
        if verbose:
            print("[gate-guard] wake hwnd=%s title=%r class=%r -> %s" % (hwnd, title, cls, result))
        ok = ok or bool(result)
    return ok


def _status():
    try:
        import uiautomation as auto
    except Exception as error:
        print("uiautomation unavailable: %r" % (error,))
        return 2
    windows = _windows()
    if not windows:
        print("no WeChat window found")
        return 2
    for hwnd, title, cls, visible in windows:
        if not visible:
            continue
        try:
            root = auto.ControlFromHandle(hwnd)
            root_class = root.ClassName or "" if root else ""
        except Exception:
            root_class = ""
        print("hwnd=%s title=%r win32Class=%r uiaRoot=%r mmui=%s" % (
            hwnd, title, cls, root_class, root_class.startswith("mmui::")))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Keep the WeChat 4.x QAccessible gate open for wxautox4/UIA.")
    parser.add_argument("--once", action="store_true", help="activate once then exit")
    parser.add_argument("--status", action="store_true", help="print current UIA root class and exit")
    parser.add_argument("--interval", type=float, default=10.0, help="seconds between attempts (default 10)")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    if args.status:
        return _status()

    if args.once:
        ok = _activate_once(verbose=args.verbose)
        print("[gate-guard] activated" if ok else "[gate-guard] not activated")
        return 0 if ok else 1

    print("[gate-guard] running; interval=%ss (Ctrl+C to stop)" % args.interval)
    try:
        while True:
            try:
                _activate_once(verbose=args.verbose)
            except Exception as error:
                print("[gate-guard] %r" % (error,))
            time.sleep(max(1.0, args.interval))
    except KeyboardInterrupt:
        print("\n[gate-guard] stopped")
        return 0


if __name__ == "__main__":
    sys.exit(main())
