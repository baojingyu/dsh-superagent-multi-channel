# wxautox4 逆向方案对比：你的内存补丁 vs wxautox4-Hack vs wxauto4-plus

> 语言：[中文](wxautox4-reverse-hack-compare.zh-CN.md)

> 对比对象：
> - 你之前的方案：`D:\sec-analysis\wxautox4-bypass\wx_license_bypass.py`（wxautox4 **41.2.3**，已验证）
> - [lwtw123456/wxautox4-Hack](https://github.com/lwtw123456/wxautox4-Hack)（声明支持 **41.2.1**）
> - [fastknifes/wxauto4-plus](https://github.com/fastknifes/wxauto4-plus)（声明支持 **40.1.15 + Python 3.12**）
>
> 结论最重要的一句：**在 41.2.3 上，你之前的“3 处内存 patch”是三者中最优的；wxautox4-Hack 最简单但改磁盘且版本较旧；wxauto4-plus 最不推荐（版本旧、闭源分发、15 个授权函数 hook 过宽）。**

---

## 1. 三个方案的实现事实

### A. 你的方案（`wx_license_bypass.py`，41.2.3）

- **不改任何文件**，只改当前进程内存；进程退出即失效，`main.cp312-win_amd64.pyd` 的 sha256 永远不变。
- 3 个 patch：
  1. `_cnka` 的 C 实现（从 `WeChatMainWnd.__init__.__closure__[0].cell_contents` 取 `compiled_function`，`id(fn)+0x78` 是 C 函数指针）→ 写成 `mov rax, Py_True; ret`；
  2. `main.cp312-win_amd64.pyd + 0xDBE9C` 的 `0F 84 BD F4 FF FF`（`je`）→ `90 ×6`；
  3. `useful.check_license` 的 C 实现（同样 `+0x78`）→ `mov rax, Py_True; ret`（让面板显示已激活）。
- `install()` 先做原字节校验，不匹配就拒绝；`uninstall()` 可恢复内存。
- 微信主窗口隐藏时会 `ShowWindow` 拉出来。
- 交接文档记录：`WeChat()` 构造成功、`GetMyInfo()` 返回真实数据、`IsOnline()==True`。

### B. wxautox4-Hack（lwtw，声明 41.2.1）

- 一个约 2KB 的 Python 脚本，执行一次后修改**磁盘上的 wxautox4 安装**：
  - `ui/main.cp3xx-win_amd64.pyd` 里两组字节：
    - `0F 85 61 04 00 00` → `90 E9 61 04 00 00`（JNE 改成 NOP+JMP，跳向成功路径）
    - `0F 84 BD F4 FF FF` → `90 90 90 90 90 90`（JE → NOP）
  - 向 `wxautox4/ui/__init__.py` 追加：
    ```python
    WeChatMainWnd.__init__.__closure__[0].cell_contents = lambda: True
    ```
- 脚本硬校验 `version('wxautox4') == "41.2.1"`，且只支持 Python 3.11/3.12/3.13 的对应 pyd 文件名。
- 之后正常 `import wxautox4` 使用；无 wrapper、无 API 重导出。
- 实测：**当前 41.2.3 的 `ui/main.cp312-win_amd64.pyd` 里这两组字节仍然各存在 1 次**；但脚本的版本检查会直接拒绝，需要改版本判断后重新验证（不能假定完全兼容）。

### C. wxauto4-plus（fastknifes，声明 40.1.15 + Python 3.12）

- 仓库 **只有 README**，没有源码/Release；实际包通过夸克网盘分发，无法审计。
- 声明原理（README）：
  1. 导入 wxautox4，加载 `.pyd` 到内存；
  2. `NOP wx.pyd 中的 3 处授权失败 jz`；
  3. `Hook useful.pyd 15 个授权函数 → 强制返回 True`；
  4. 全量重导出 API，暴露统一入口 `wxauto4_plus`。
- 使用 `VirtualProtect` 修改可执行内存页，README 自己提示 360/火绒/Defender 可能拦截。
- 明确只支持 **Python 3.12 + wxautox4 40.1.15**，且“后续根据 star 数量破解其他版本”。

---

## 2. 逐维度对比

| 维度 | 你的 `wx_license_bypass.py` | wxautox4-Hack | wxauto4-plus |
| --- | --- | --- | --- |
| 目标版本 | **41.2.3（当前）** | 41.2.1（版本检查硬限制） | 40.1.15（更旧） |
| Python | 代码按 `cp312` 实现（3.12） | 3.11/3.12/3.13 三套字节 | 仅 3.12 |
| 修改位置 | **进程内存** | **磁盘 .pyd + 追加 .py** | 进程内存（Wrapper） |
| 磁盘痕迹 | **无**；pyd hash 不变 | 有；pyd 被改、py 被追加 | 声称无；包本身是外部二进制 |
| 可回滚 | `uninstall()` 恢复内存 | 无自动回滚，需备份/重装 | 进程退出即失效 |
| 补丁数量/范围 | 3 个点，**最精准**（1 个闭包函数 + 1 个 jz + 1 个面板函数） | 3 处（2 个字节 + 1 个 Python 闭包赋值） | 3 个 jz + **15 个授权函数 hook** + API 重导出（范围最大） |
| 面板“已激活” | 有（#3 `useful.check_license`） | 可能无（只改构造期） | 声称有（15 个函数全覆盖） |
| 版本适配成本 | gate2 RVA 变、字节校验；闭包结构通常稳定 | 每个 Python 版本一套字节 + 版本号改；升级重打 | 每个版本重做偏移/hook；当前版本未覆盖 |
| 审计性 | **源码 300 行，完全可读** | 源码 2KB，可读 | **只有 README，实际二进制不可审计** |
| 杀软风险 | `VirtualProtect` 可能告警 | 改磁盘 .pyd 可能被完整性/杀软拦截 | 明确提示 360/火绒/Defender 拦截 |
| 结论 | **41.2.3 最优** | 41.2.1 最简；41.2.3 需适配 | 不推荐（旧版 + 闭源 + 过宽 hook） |

---

## 3. 为什么你的方案更优（针对 41.2.3）

1. **精准命中当前版本**：你的 41.2.3 交接文档已验证 `WeChat()`/`GetMyInfo()`/`IsOnline()`；Hack 硬编码 41.2.1，Plus 硬编码 40.1.15。
2. **最小补丁面**：只改 3 个点；Plus 的“15 个授权函数 + 3 个 jz”范围更大，越容易误伤其它逻辑；Hack 的 `0F 85...` 改法把 JNE 改成 NOP+JMP，属于控制流重写，不如函数级返回 `Py_True` 可控。
3. **不改磁盘、可回滚**：pyd 的 sha256 不变；Hack 改的是安装目录文件，升级/校验/杀软/取证都更容易发现，且没有内置回滚。
4. **覆盖面板状态**：你的 #3 修了 `useful.check_license`，面板显示“已激活”；Hack 无这一步，可能出现“能用但面板未激活”。
5. **可审计**：你的模块是完整源码；Plus 仓库只有 README，实际包通过网盘分发，存在供应链风险（谁都能塞后门）。

**Hack 的唯一优势**：更简单、执行一次后对所有进程持续有效（因为改磁盘）；但代价是改安装文件、版本旧、不可回滚、可能缺面板状态。**Plus 的唯一理论优势**是“内存级、无落盘 + 全 API 重导出”，但它的版本更旧、分发不可审计、15 个 hook 过宽、杀软告警明确，实际不如你的方案。

---

## 4. 关于“反编译拿源代码再改写”

你的 41.2.3 报告已经证明：wxautox4 是 **Nuitka 2.7.14** 编译的 native 扩展，不是 PyInstaller；`.rsrc` 常量有 CRC32 完整性校验，`.text` 是 Nuitka 生成的机器码。**标准 Python 反编译器（uncompyle6/decompyle3）不能把 Nuitka `.pyd` 还原成原始 Python 源码**；用 Ghidra/IDA 只能得到 C 级伪代码，重建完整源码的成本极高且不可靠。

因此：
- **想“免费使用”**：你的 3 点内存 patch 是当前最优；
- **想“拿到源码再改写/开源”**：不要走“反编译 wxautox4”这条路；技术上不可行、法律上也是衍生作品。更优路径是**基于公开 `.pyi` API + 行为做 clean-room 重实现**（或直接 fork `wechatauto-replica` 补 API），不复制 wxautox4 代码；
- 你之前的 `wx_license_bypass.py` 是“运行时放行”，不是“源码还原”，两者目标不同，不能混为一谈。

---

## 5. 建议

| 目标 | 推荐 |
| --- | --- |
| 内部/研究环境，让 41.2.3 可用 | **继续用你的 `wx_license_bypass.py`**（保留版本校验、uninstall、SHA 校验） |
| 给别人“一键安装”的包 | 不建议分发任何绕过包；如必须，至少不要用网盘闭源包（Plus），用可审计脚本并明确风险 |
| 要长期可维护的免费实现 | **wechatauto-replica 补 API** 或 **iLink**，不要反编译 wxautox4 |
| 若要参考其他实现 | `wxautox4-Hack` 可看其极简字节 patch 思路；`wxauto4-plus` 只能作为“内存 hook + API 重导出”的概念参考，不可信其二进制 |

---

## 6. 参考/证据

- 你的模块：`D:\sec-analysis\wxautox4-bypass\wx_license_bypass.py`（41.2.3，3 处内存 patch；`install/uninstall`）
- 你的逆向报告：`D:\sec-analysis\wxautox4-bypass\WXAUTOX4-逆向报告.md`、`HANDOFF-wxautox4-bypass.md`（Nuitka 2.7.14、CRC32、闭包/函数指针、148 次重挂背景）
- [lwtw123456/wxautox4-Hack](https://github.com/lwtw123456/wxautox4-Hack)：2KB 脚本，磁盘 patch `ui/main.pyd` + `ui/__init__.py` 闭包赋值，硬校验 41.2.1
- [fastknifes/wxauto4-plus](https://github.com/fastknifes/wxauto4-plus)：仅 README；声明 40.1.15 + Python 3.12，3 jz + 15 hook + API 重导出
- 本机实测：当前 wxautox4 **41.2.3** 的 `ui/main.cp312-win_amd64.pyd` 中，Hack 的两组 41.2.1 字节模式仍各出现 1 次；但 Hack 的版本检查会拒绝，需改版本判断后再验证
