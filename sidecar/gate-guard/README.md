# gate-guard：微信 4.1.12.55+ 的 UIA gate 守护

`wxauto-bridge`（`pc-uia` / wxautox4）依赖微信的 `mmui` UIA 控件树。微信 **4.1.12.55** 冷启动时
Qt accessibility gate 默认为 `0`，控件树不物化，表现为「未找到已登录的主窗口」或 `/rooms` 为空。
`wechatauto-replica` 的 `accessibility.wake()` 可把 gate 热写成 `1`，本目录的守护进程按间隔重复调用，
保证微信重启/窗口重建后 UIA 仍可用。

## 使用

```powershell
# 1) 安装依赖（已装 wechatauto-replica 的 venv 也可）
pip install wechatauto-replica

# 2) 只激活一次
python sidecar\gate-guard\gate_guard.py --once

# 3) 常驻（推荐与 wxauto-bridge 同机运行）
python sidecar\gate-guard\gate_guard.py --interval 10
```

或 `sidecar\gate-guard\start-gate-guard.cmd`（可用 `WECHATAUTO_VENV` 指向 venv）。

## 验证

```powershell
python sidecar\gate-guard\gate_guard.py --status
# 期望：uiaRoot='mmui::MainWindow' mmui=True
```

没有 `wechatauto` 时返回明确错误；只支持 Windows 桌面会话。gate 是运行时字节，不改磁盘、不注入 DLL。
它只解决 UIA 树物化，**不解决 wxautox4 的商业授权**。
