# wxautox4 Reverse Engineering Comparison: Your In-Memory Patch vs wxautox4-Hack vs wxauto4-plus

> Language: [English](wxautox4-reverse-hack-compare.en-US.md) · [中文](wxautox4-reverse-hack-compare.zh-CN.md)

> Compared objects:
> - Your previous approach: `D:\sec-analysis\wxautox4-bypass\wx_license_bypass.py` (wxautox4 **41.2.3**, verified)
> - [lwtw123456/wxautox4-Hack](https://github.com/lwtw123456/wxautox4-Hack) (declares support for **41.2.1**)
> - [fastknifes/wxauto4-plus](https://github.com/fastknifes/wxauto4-plus) (declares support for **40.1.15 + Python 3.12**)
>
> The single most important conclusion: **On 41.2.3, your previous "3-point in-memory patch" is the best of the three; wxautox4-Hack is the simplest but modifies disk and targets an older version; wxauto4-plus is the least recommended (older version, closed-source distribution, 15 license-function hooks that are too broad).**

---

## 1. Implementation Facts of the Three Approaches

### A. Your approach (`wx_license_bypass.py`, 41.2.3)

- **Modifies no files**, only the memory of the current process; it becomes void once the process exits, and the sha256 of `main.cp312-win_amd64.pyd` never changes.
- 3 patches:
  1. The C implementation of `_cnka` (obtain the `compiled_function` from `WeChatMainWnd.__init__.__closure__[0].cell_contents`; `id(fn)+0x78` is the C function pointer) → rewritten to `mov rax, Py_True; ret`;
  2. `main.cp312-win_amd64.pyd + 0xDBE9C`'s `0F 84 BD F4 FF FF` (`je`) → `90 ×6`;
  3. The C implementation of `useful.check_license` (likewise `+0x78`) → `mov rax, Py_True; ret` (so the panel shows activated).
- `install()` first verifies the original bytes and refuses if they do not match; `uninstall()` restores the memory.
- The WeChat main window is pulled out via `ShowWindow` when hidden.
- The handoff document records: `WeChat()` constructs successfully, `GetMyInfo()` returns real data, `IsOnline()==True`.

### B. wxautox4-Hack (lwtw, declares 41.2.1)

- A Python script of about 2KB that, after one run, modifies the **on-disk wxautox4 installation**:
  - In `ui/main.cp3xx-win_amd64.pyd`, two byte groups:
    - `0F 85 61 04 00 00` → `90 E9 61 04 00 00` (JNE changed to NOP+JMP, jumping to the success path)
    - `0F 84 BD F4 FF FF` → `90 90 90 90 90 90` (JE → NOP)
  - Appends to `wxautox4/ui/__init__.py`:
    ```python
    WeChatMainWnd.__init__.__closure__[0].cell_contents = lambda: True
    ```
- The script strictly checks `version('wxautox4') == "41.2.1"`, and only supports the corresponding pyd filenames for Python 3.11/3.12/3.13.
- Afterwards, `import wxautox4` is used normally; no wrapper, no API re-export.
- Measured: **In the current 41.2.3's `ui/main.cp312-win_amd64.pyd`, both of these two byte groups still each appear once**; however, the script's version check will directly reject it, requiring a modified version check and re-verification (one cannot assume full compatibility).

### C. wxauto4-plus (fastknifes, declares 40.1.15 + Python 3.12)

- The repository has **only a README**, no source code/Release; the actual package is distributed via Quark netdisk and cannot be audited.
- Declared principles (README):
  1. Import wxautox4 and load the `.pyd` into memory;
  2. `NOP` the 3 license-failure `jz` in `wx.pyd`;
  3. `Hook` the 15 license functions in `useful.pyd` → force return `True`;
  4. Fully re-export the API, exposing a unified entry `wxauto4_plus`.
- Uses `VirtualProtect` to modify executable memory pages; the README itself warns that 360/Huorong/Defender may intercept.
- Explicitly only supports **Python 3.12 + wxautox4 40.1.15**, and "will crack other versions later based on star count".

---

## 2. Dimension-by-Dimension Comparison

| Dimension | Your `wx_license_bypass.py` | wxautox4-Hack | wxauto4-plus |
| --- | --- | --- | --- |
| Target version | **41.2.3 (current)** | 41.2.1 (hard-limited by version check) | 40.1.15 (older) |
| Python | Code implemented for `cp312` (3.12) | Three byte sets for 3.11/3.12/3.13 | 3.12 only |
| Modification location | **Process memory** | **On-disk .pyd + appended .py** | Process memory (Wrapper) |
| Disk footprint | **None**; pyd hash unchanged | Yes; pyd modified, py appended | Claimed none; the package itself is an external binary |
| Rollbackable | `uninstall()` restores memory | No automatic rollback, requires backup/reinstall | Becomes void once the process exits |
| Patch count/scope | 3 points, **most precise** (1 closure function + 1 jz + 1 panel function) | 3 places (2 bytes + 1 Python closure assignment) | 3 jz + **15 license-function hooks** + API re-export (largest scope) |
| Panel "activated" | Yes (#3 `useful.check_license`) | Possibly no (only modifies construction phase) | Claimed yes (all 15 functions covered) |
| Version adaptation cost | gate2 RVA changes, byte verification; closure structure usually stable | One byte set per Python version + version-number change; re-patch on upgrade | Redo offsets/hooks per version; current version not covered |
| Auditability | **300 lines of source, fully readable** | 2KB of source, readable | **Only README, actual binary not auditable** |
| Antivirus risk | `VirtualProtect` may trigger alerts | Modifying on-disk .pyd may be blocked by integrity/antivirus | Explicitly warns of 360/Huorong/Defender interception |
| Conclusion | **Best on 41.2.3** | Simplest on 41.2.1; needs adaptation for 41.2.3 | Not recommended (old version + closed source + overly broad hooks) |

---

## 3. Why Your Approach Is Superior (for 41.2.3)

1. **Precisely hits the current version**: Your 41.2.3 handoff document has verified `WeChat()`/`GetMyInfo()`/`IsOnline()`; Hack hard-codes 41.2.1, Plus hard-codes 40.1.15.
2. **Minimal patch surface**: Only 3 points are changed; Plus's "15 license functions + 3 jz" has a larger scope and more easily damages other logic; Hack's `0F 85...` modification turns JNE into NOP+JMP, which is a control-flow rewrite and less controllable than a function-level return of `Py_True`.
3. **No disk modification, rollbackable**: The pyd's sha256 is unchanged; what Hack modifies is files in the installation directory, which are more easily discovered by upgrades/verification/antivirus/forensics, and it has no built-in rollback.
4. **Covers panel state**: Your #3 fixes `useful.check_license`, so the panel shows "activated"; Hack lacks this step and may exhibit "works but panel not activated".
5. **Auditable**: Your module is complete source code; the Plus repository has only a README, and the actual package is distributed via netdisk, posing a supply-chain risk (anyone can insert a backdoor).

**Hack's only advantage**: Simpler, and once executed it remains continuously effective for all processes (because it modifies disk); but the cost is modifying installation files, an older version, no rollback, and possibly missing panel state. **Plus's only theoretical advantage** is "memory-level, no disk write + full API re-export", but its version is older, its distribution is not auditable, its 15 hooks are overly broad, and its antivirus alerts are explicit — in practice it is inferior to your approach.

---

## 4. On "Decompiling to Get the Source Code and Then Rewriting"

Your 41.2.3 report has already proven: wxautox4 is a native extension compiled with **Nuitka 2.7.14**, not PyInstaller; the `.rsrc` constants have CRC32 integrity checks, and `.text` is machine code generated by Nuitka. **Standard Python decompilers (uncompyle6/decompyle3) cannot restore a Nuitka `.pyd` to the original Python source**; with Ghidra/IDA one can only obtain C-level pseudocode, and rebuilding the complete source is extremely costly and unreliable.

Therefore:
- **To "use it for free"**: Your 3-point in-memory patch is currently the best option;
- **To "get the source code and then rewrite/open-source it"**: Do not take the route of "decompiling wxautox4"; it is technically infeasible and legally a derivative work. The better path is a **clean-room reimplementation based on the public `.pyi` API + behavior** (or directly forking `wechatauto-replica` to add APIs), without copying wxautox4 code;
- Your previous `wx_license_bypass.py` is "runtime authorization bypass", not "source code restoration"; the two have different goals and cannot be conflated.

---

## 5. Recommendations

| Goal | Recommendation |
| --- | --- |
| Internal/research environment, make 41.2.3 usable | **Keep using your `wx_license_bypass.py`** (retain version check, uninstall, SHA verification) |
| A "one-click install" package for others | Do not distribute any bypass package; if it is a must, at least do not use a closed-source netdisk package (Plus), use an auditable script and clearly state the risks |
| A long-term maintainable free implementation | **Add APIs to wechatauto-replica** or **iLink**, do not decompile wxautox4 |
| If you want to reference other implementations | `wxautox4-Hack` can be consulted for its minimalist byte-patch idea; `wxauto4-plus` can only serve as a conceptual reference for "in-memory hook + API re-export", and its binary cannot be trusted |

---

## 6. References/Evidence

- Your module: `D:\sec-analysis\wxautox4-bypass\wx_license_bypass.py` (41.2.3, 3 in-memory patches; `install/uninstall`)
- Your reverse-engineering report: `D:\sec-analysis\wxautox4-bypass\WXAUTOX4-逆向报告.md`, `HANDOFF-wxautox4-bypass.md` (Nuitka 2.7.14, CRC32, closure/function pointer, background of 148 instances of re-hooking)
- [lwtw123456/wxautox4-Hack](https://github.com/lwtw123456/wxautox4-Hack): 2KB script, on-disk patch of `ui/main.pyd` + `ui/__init__.py` closure assignment, hard-checks 41.2.1
- [fastknifes/wxauto4-plus](https://github.com/fastknifes/wxauto4-plus): only README; declares 40.1.15 + Python 3.12, 3 jz + 15 hooks + API re-export
- Local test: In the current wxautox4 **41.2.3**'s `ui/main.cp312-win_amd64.pyd`, Hack's two groups of 41.2.1 byte patterns still each appear once; however, Hack's version check will reject it, requiring a modified version check followed by re-verification
