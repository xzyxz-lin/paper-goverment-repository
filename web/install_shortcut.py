#!/usr/bin/env python3
"""创建 Windows 桌面快捷方式（纯 ctypes 调 IShellLink COM，零第三方依赖）。"""
import ctypes
from ctypes import wintypes
from uuid import UUID

CLSID_ShellLink = UUID("{00021401-0000-0000-C000-000000000046}")
IID_IShellLinkW = UUID("{000214F9-0000-0000-C000-000000000046}")
IID_IPersistFile = UUID("{0000010B-0000-0000-C000-000000000046}")

HRESULT = ctypes.c_long
LPCWSTR = ctypes.c_wchar_p
GUID16 = ctypes.c_ubyte * 16


def _guid_bytes(u: UUID) -> GUID16:
    return GUID16(*u.bytes_le)


def create_shortcut(lnk_path, target, working_dir="", description="", show_cmd=7):
    """创建 .lnk 快捷方式。show_cmd=7 表示最小化启动。"""
    ole32 = ctypes.oledll.ole32
    ole32.CoInitialize(None)

    psl = ctypes.c_void_p()
    hr = ole32.CoCreateInstance(
        _guid_bytes(CLSID_ShellLink), None, 1,
        _guid_bytes(IID_IShellLinkW), ctypes.byref(psl),
    )
    if hr != 0:
        raise RuntimeError(f"CoCreateInstance failed hr={hr:#x}")

    vptr = ctypes.cast(psl, ctypes.POINTER(ctypes.c_void_p)).contents
    vtbl = ctypes.cast(vptr, ctypes.POINTER(ctypes.c_void_p))

    def _method(index, ret, *argtypes):
        return ctypes.WINFUNCTYPE(ret, ctypes.c_void_p, *argtypes)(vtbl[index])

    # IShellLinkW 方法（vtable 索引）
    _method(20, HRESULT, LPCWSTR)(psl, target)                 # SetPath
    if working_dir:
        _method(9, HRESULT, LPCWSTR)(psl, working_dir)         # SetWorkingDirectory
    if description:
        _method(7, HRESULT, LPCWSTR)(psl, description)         # SetDescription
    _method(15, HRESULT, ctypes.c_int)(psl, show_cmd)          # SetShowCmd

    # QueryInterface -> IPersistFile
    ppf = ctypes.c_void_p()
    hr = _method(0, HRESULT, ctypes.POINTER(GUID16), ctypes.POINTER(ctypes.c_void_p))(
        psl, _guid_bytes(IID_IPersistFile), ctypes.byref(ppf)
    )
    if hr != 0:
        raise RuntimeError(f"QueryInterface failed hr={hr:#x}")

    pf_vptr = ctypes.cast(ppf, ctypes.POINTER(ctypes.c_void_p)).contents
    pf_vtbl = ctypes.cast(pf_vptr, ctypes.POINTER(ctypes.c_void_p))
    Save = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, LPCWSTR, ctypes.c_int)(pf_vtbl[6])
    hr = Save(ppf, lnk_path, 1)
    if hr != 0:
        raise RuntimeError(f"IPersistFile::Save failed hr={hr:#x}")

    # 释放
    _method(2, ctypes.c_ulong)(psl)
    ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(pf_vtbl[2])(ppf)
    return lnk_path


if __name__ == "__main__":
    import os
    desktop = os.path.join(os.environ["USERPROFILE"], "Desktop")
    lnk = create_shortcut(
        lnk_path=os.path.join(desktop, "私人文献库.lnk"),
        target=r"A:\workbuddy项目\私人文献库\web\start_web.cmd",
        working_dir=r"A:\workbuddy项目\私人文献库\web",
        description="私人文献库 - 本地 Web 管理 (http://127.0.0.1:8040)",
        show_cmd=7,
    )
    print(f"已创建快捷方式: {lnk}")
