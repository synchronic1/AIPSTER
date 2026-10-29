"""Typed ctypes bindings for the Win32 APIs the tray uses.

Every function used across aipster_tray gets explicit argtypes/restype here.
Without them, ctypes defaults to 32-bit int handles, which truncates real
64-bit HWND/HANDLE values and breaks cross-process window lookup. Call
`kernel32()`, `user32()`, or `shell32()` for the configured libraries.
"""
import ctypes
from ctypes import wintypes

_KERNEL32 = None
_USER32 = None
_SHELL32 = None

WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
WNDPROC = ctypes.WINFUNCTYPE(wintypes.LPARAM, wintypes.HWND, ctypes.c_uint,
                             wintypes.WPARAM, wintypes.LPARAM)


class MSG(ctypes.Structure):
    _fields_ = [("hwnd", wintypes.HWND), ("message", ctypes.c_uint),
                ("wParam", wintypes.WPARAM), ("lParam", wintypes.LPARAM),
                ("time", wintypes.DWORD),
                ("pt_x", ctypes.c_long), ("pt_y", ctypes.c_long)]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def kernel32():
    global _KERNEL32
    if _KERNEL32 is None:
        kernel32 = ctypes.windll.kernel32
        kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
        kernel32.GetModuleHandleW.restype = wintypes.HMODULE
        kernel32.GetLastError.argtypes = []
        kernel32.GetLastError.restype = wintypes.DWORD
        kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                                     wintypes.LPVOID, wintypes.DWORD]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        _KERNEL32 = kernel32
    return _KERNEL32


def user32():
    global _USER32
    if _USER32 is None:
        user32 = ctypes.windll.user32
        user32.RegisterClassW.argtypes = [wintypes.LPVOID]
        user32.RegisterClassW.restype = wintypes.ATOM
        user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                           wintypes.DWORD, ctypes.c_int, ctypes.c_int,
                                           ctypes.c_int, ctypes.c_int, wintypes.HWND,
                                           wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
        user32.CreateWindowExW.restype = wintypes.HWND
        user32.DefWindowProcW.argtypes = [wintypes.HWND, ctypes.c_uint, wintypes.WPARAM,
                                          wintypes.LPARAM]
        user32.DefWindowProcW.restype = wintypes.LPARAM
        user32.DestroyWindow.argtypes = [wintypes.HWND]
        user32.DestroyWindow.restype = wintypes.BOOL
        user32.SetTimer.argtypes = [wintypes.HWND, ctypes.c_size_t, ctypes.c_uint,
                                    wintypes.LPVOID]
        user32.SetTimer.restype = ctypes.c_size_t
        user32.GetMessageW.argtypes = [wintypes.LPVOID, wintypes.HWND, ctypes.c_uint,
                                       ctypes.c_uint]
        user32.GetMessageW.restype = wintypes.BOOL
        user32.TranslateMessage.argtypes = [wintypes.LPVOID]
        user32.TranslateMessage.restype = wintypes.BOOL
        user32.DispatchMessageW.argtypes = [wintypes.LPVOID]
        user32.DispatchMessageW.restype = wintypes.LPARAM
        user32.PeekMessageW.argtypes = [wintypes.LPVOID, wintypes.HWND, ctypes.c_uint,
                                        ctypes.c_uint, ctypes.c_uint]
        user32.PeekMessageW.restype = wintypes.BOOL
        user32.PostQuitMessage.argtypes = [ctypes.c_int]
        user32.PostQuitMessage.restype = None
        user32.PostMessageW.argtypes = [wintypes.HWND, ctypes.c_uint, wintypes.WPARAM,
                                        wintypes.LPARAM]
        user32.PostMessageW.restype = wintypes.BOOL
        user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
        user32.EnumWindows.restype = wintypes.BOOL
        user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        user32.GetClassNameW.restype = ctypes.c_int
        user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        user32.GetWindowTextLengthW.restype = ctypes.c_int
        user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        user32.GetWindowTextW.restype = ctypes.c_int
        user32.SendMessageTimeoutW.argtypes = [wintypes.HWND, ctypes.c_uint, wintypes.WPARAM,
                                               wintypes.LPARAM, ctypes.c_uint, ctypes.c_uint,
                                               ctypes.POINTER(wintypes.LPARAM)]
        user32.SendMessageTimeoutW.restype = wintypes.LPARAM
        user32.RegisterWindowMessageW.argtypes = [wintypes.LPCWSTR]
        user32.RegisterWindowMessageW.restype = ctypes.c_uint
        user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
        user32.GetCursorPos.restype = wintypes.BOOL
        user32.CreatePopupMenu.argtypes = []
        user32.CreatePopupMenu.restype = wintypes.HMENU
        user32.AppendMenuW.argtypes = [wintypes.HMENU, ctypes.c_uint, ctypes.c_size_t,
                                       wintypes.LPCWSTR]
        user32.AppendMenuW.restype = wintypes.BOOL
        user32.TrackPopupMenu.argtypes = [wintypes.HMENU, ctypes.c_uint, ctypes.c_int,
                                          ctypes.c_int, ctypes.c_int, wintypes.HWND,
                                          wintypes.LPVOID]
        user32.TrackPopupMenu.restype = ctypes.c_int
        user32.DestroyMenu.argtypes = [wintypes.HMENU]
        user32.DestroyMenu.restype = wintypes.BOOL
        user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, ctypes.c_uint,
                                      ctypes.c_int, ctypes.c_int, ctypes.c_uint]
        user32.LoadImageW.restype = wintypes.HANDLE
        user32.DestroyIcon.argtypes = [wintypes.HICON]
        user32.DestroyIcon.restype = wintypes.BOOL
        user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        user32.SetForegroundWindow.restype = wintypes.BOOL
        _USER32 = user32
    return _USER32


def shell32():
    global _SHELL32
    if _SHELL32 is None:
        shell32 = ctypes.windll.shell32
        shell32.Shell_NotifyIconW.argtypes = [wintypes.DWORD, wintypes.LPVOID]
        shell32.Shell_NotifyIconW.restype = wintypes.BOOL
        shell32.ShellExecuteW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                          wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_int]
        shell32.ShellExecuteW.restype = wintypes.HINSTANCE
        _SHELL32 = shell32
    return _SHELL32
