"""eNSP GUI bridge - elevated sidecar used by the dsh-ensp plugin.

Why this exists
---------------
eNSP runs elevated (compat flags ``~WIN7RTM RUNASADMIN``).  A normal integrity
process cannot drive it: ``PostMessage``/``SetWindowPos`` fail with
ERROR_ACCESS_DENIED under UIPI.  This helper is started with the "runas" verb so
it lives at the same integrity level as eNSP.

Two run modes
-------------
``--job FILE``    one-shot batch (default).  One process start carries a whole
                  list of steps, which is what makes bulk GUI work fast:
                  ~0.3 s launch, then 1-70 ms per step.
``--port/--token`` resident server for callers that keep a process alive.

Protocol: newline-delimited JSON, one request per line.
``{"id": 7, "op": "postclick", "hwnd": 1234, "x": 10, "y": 20}``

Hard-won rules baked in here
----------------------------
* Screenshots use BitBlt from the window DC: works while the window is covered,
  needs no focus and no elevation (~15 ms).
* Clicks go through ``PostMessage`` whenever possible: no cursor movement, no
  focus steal, works in the background.  Real ``SendInput`` clicks are the
  fallback and always restore the previous cursor position.
* Re-resolve every window handle by title/class on each call.  eNSP spawns a
  fresh process (and fresh HWNDs) per topology, so cached handles go stale.
* Never send custom WM_USER messages to eNSP controls.  The skinned status bar
  crashes the whole client when asked for SB_GETPARTS.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import socket
import subprocess
import threading
import time
import traceback

import win32api
import win32clipboard
import win32con
import win32gui
import win32process
import win32ui

try:
    from PIL import Image
except Exception:  # pragma: no cover - Pillow is optional
    Image = None

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
shell32 = ctypes.windll.shell32

CREATE_NO_WINDOW = 0x08000000
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800

VK = {
    "enter": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B, "space": 0x20,
    "backspace": 0x08, "del": 0x2E, "delete": 0x2E, "insert": 0x2D,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "ctrl": 0x11, "shift": 0x10, "alt": 0x12, "win": 0x5B,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
    "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD),
                ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wt.DWORD), ("wParamL", wt.WORD), ("wParamH", wt.WORD)]


class _INPUTunion(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("union", _INPUTunion)]


class STARTUPINFO(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("lpReserved", wt.LPWSTR), ("lpDesktop", wt.LPWSTR),
                ("lpTitle", wt.LPWSTR), ("dwX", wt.DWORD), ("dwY", wt.DWORD),
                ("dwXSize", wt.DWORD), ("dwYSize", wt.DWORD),
                ("dwXCountChars", wt.DWORD), ("dwYCountChars", wt.DWORD),
                ("dwFillAttribute", wt.DWORD), ("dwFlags", wt.DWORD),
                ("wShowWindow", wt.WORD), ("cbReserved2", wt.WORD),
                ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
                ("hStdInput", wt.HANDLE), ("hStdOutput", wt.HANDLE), ("hStdError", wt.HANDLE)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wt.HANDLE), ("hThread", wt.HANDLE),
                ("dwProcessId", wt.DWORD), ("dwThreadId", wt.DWORD)]


DPI_MODE = None
LOG_LOCK = threading.Lock()
LOG_PATH = None


def log(line):
    if not LOG_PATH:
        return
    with LOG_LOCK:
        try:
            with open(LOG_PATH, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:
            pass


# ------------------------------------------------------------------ utilities

def set_dpi_aware():
    """Per-monitor v2 so reported rectangles match physical pixels."""
    for attempt in (-4, -3, -2):
        try:
            if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(attempt)):
                return attempt
        except Exception:
            pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return "shcore:2"
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
        return 1
    except Exception:
        return 0


def is_elevated():
    adv = ctypes.windll.advapi32
    adv.OpenProcessToken.argtypes = [wt.HANDLE, wt.DWORD, ctypes.POINTER(wt.HANDLE)]
    adv.OpenProcessToken.restype = wt.BOOL
    handle = wt.HANDLE()
    if not adv.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(handle)):
        return None

    class TOKEN_ELEVATION(ctypes.Structure):
        _fields_ = [("TokenIsElevated", wt.DWORD)]

    te = TOKEN_ELEVATION()
    size = wt.DWORD()
    adv.GetTokenInformation(handle, 20, ctypes.byref(te), ctypes.sizeof(te),
                            ctypes.byref(size))
    kernel32.CloseHandle(handle)
    return bool(te.TokenIsElevated)


def _send_inputs(inputs):
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    return user32.SendInput(n, ctypes.byref(arr), ctypes.sizeof(INPUT))


def _mouse_input(flags, dx=0, dy=0, data=0):
    item = INPUT()
    item.type = INPUT_MOUSE
    item.union.mi = MOUSEINPUT(dx, dy, data, flags, 0, 0)
    return item


def _key_input(vk=0, scan=0, flags=0):
    item = INPUT()
    item.type = INPUT_KEYBOARD
    item.union.ki = KEYBDINPUT(vk, scan, flags, 0, 0)
    return item


# ------------------------------------------------------------------ discovery

def window_info(hwnd):
    try:
        pid = win32process.GetWindowThreadProcessId(hwnd)[1]
    except Exception:
        pid = 0
    rect = win32gui.GetWindowRect(hwnd)
    return {
        "hwnd": int(hwnd),
        "title": win32gui.GetWindowText(hwnd),
        "cls": win32gui.GetClassName(hwnd),
        "pid": int(pid),
        "rect": list(rect),
        "client_origin": list(win32gui.ClientToScreen(hwnd, (0, 0))),
        "client_size": list(win32gui.GetClientRect(hwnd)[2:]),
        "visible": bool(win32gui.IsWindowVisible(hwnd)),
        "minimized": bool(win32gui.IsIconic(hwnd)),
    }


def enum_windows(filter_text=None, visible_only=True):
    rows = []
    needle = (filter_text or "").lower()

    def cb(hwnd, _):
        if visible_only and not win32gui.IsWindowVisible(hwnd):
            return True
        title = win32gui.GetWindowText(hwnd)
        if needle:
            if needle not in title.lower():
                return True
        elif not title:
            return True
        rows.append(window_info(hwnd))
        return True

    win32gui.EnumWindows(cb, None)
    return rows


def find_window(title=None, hwnd=None, cls=None, include_hidden=True):
    if hwnd:
        if win32gui.IsWindow(int(hwnd)):
            return int(hwnd)
        raise LookupError("no such hwnd %s (eNSP re-creates windows; re-discover)" % hwnd)
    needle = (title or "").lower()
    want_cls = (cls or "").lower()
    matches = []

    def cb(h, _):
        if not include_hidden and not win32gui.IsWindowVisible(h):
            return True
        t = win32gui.GetWindowText(h)
        c = win32gui.GetClassName(h)
        if want_cls and c.lower() != want_cls:
            return True
        if needle and needle not in t.lower():
            return True
        if not needle and not want_cls:
            return True
        matches.append((h, t, c))
        return True

    win32gui.EnumWindows(cb, None)
    if not matches:
        raise LookupError("no window matched title=%r cls=%r" % (title, cls))
    matches.sort(key=lambda m: len(m[1]))
    return int(matches[0][0])


def _level_of(hwnd, root):
    level = 0
    cur = win32gui.GetParent(hwnd)
    while cur and cur != root and level < 12:
        level += 1
        cur = win32gui.GetParent(cur)
    return level + 1


def children(hwnd, depth=2):
    """All descendants of ``hwnd`` once each, tagged with nesting level."""
    out = []

    def cb(ch, _):
        try:
            level = _level_of(ch, hwnd)
            if level > depth:
                return True
            rect = win32gui.GetWindowRect(ch)
            crect = win32gui.GetClientRect(ch)
            out.append({
                "hwnd": int(ch),
                "cls": win32gui.GetClassName(ch),
                "txt": win32gui.GetWindowText(ch),
                "rect": list(rect),
                "local": [rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]],
                "size": [crect[2], crect[3]],
                "visible": bool(win32gui.IsWindowVisible(ch)),
                "level": level,
            })
        except Exception:
            pass
        return True

    win32gui.EnumChildWindows(hwnd, cb, None)
    return out


def texts(hwnd, depth=2, only=None):
    """Readable text of a window and its descendants (WM_GETTEXT only: safe)."""
    out = []
    for item in children(hwnd, depth):
        if only and item["cls"] != only:
            continue
        if item["txt"]:
            out.append({"hwnd": item["hwnd"], "cls": item["cls"], "txt": item["txt"],
                        "local": item["local"]})
    return out


def wnd_at(x, y):
    hwnd = user32.WindowFromPoint(wt.POINT(int(x), int(y)))
    if not hwnd:
        return None
    chain = []
    cur = hwnd
    while cur:
        chain.append({"hwnd": int(cur), "cls": win32gui.GetClassName(cur),
                      "txt": win32gui.GetWindowText(cur),
                      "rect": list(win32gui.GetWindowRect(cur))})
        parent = win32gui.GetParent(cur)
        if not parent:
            break
        cur = parent
    client = win32gui.ScreenToClient(hwnd, (int(x), int(y)))
    return {"hwnd": int(hwnd), "cls": chain[0]["cls"], "txt": chain[0]["txt"],
            "client": list(client), "chain": chain}


# ------------------------------------------------------------------ capture

def capture(hwnd, out_path, crop=None, mode="blit"):
    """Grab a window's pixels.

    ``mode="blit"`` (default) copies from the window DC: fast, occlusion proof,
    no elevation needed.  ``mode="print"`` asks the window to paint itself.
    """
    rect = win32gui.GetWindowRect(hwnd)
    width, height = rect[2] - rect[0], rect[3] - rect[1]
    if width <= 0 or height <= 0:
        raise RuntimeError("window has no area: %r" % (rect,))
    hdc = win32gui.GetWindowDC(hwnd)
    src = None
    mem = None
    bmp = None
    try:
        src = win32ui.CreateDCFromHandle(hdc)
        mem = src.CreateCompatibleDC()
        bmp = win32ui.CreateBitmap()
        bmp.CreateCompatibleBitmap(src, width, height)
        mem.SelectObject(bmp)
        if mode == "print":
            user32.PrintWindow(hwnd, mem.GetSafeHdc(), 2)
        else:
            mem.BitBlt((0, 0), (width, height), src, (0, 0), win32con.SRCCOPY)
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        bmp.SaveBitmapFile(mem, out_path)
    finally:
        try:
            if bmp:
                win32gui.DeleteObject(bmp.GetHandle())
            if mem:
                mem.DeleteDC()
            if src:
                src.DeleteDC()
        finally:
            win32gui.ReleaseDC(hwnd, hdc)

    result = {"out": out_path, "width": width, "height": height, "mode": mode}
    if out_path.lower().endswith((".png", ".jpg", ".jpeg")):
        if Image is None:
            raise RuntimeError("Pillow missing: cannot write %s" % out_path)
        with Image.open(out_path) as img:
            img = img.convert("RGB")
            if crop:
                x, y, w, h = (int(v) for v in crop)
                img = img.crop((x, y, x + w, y + h))
                result["cropped"] = [x, y, w, h]
            img.save(out_path)
            result["width"], result["height"] = img.size
    return result


def window_exists(hwnd):
    return bool(hwnd) and bool(win32gui.IsWindow(int(hwnd)))


def wait_window(title=None, cls=None, timeout=15.0, poll=0.2):
    deadline = time.time() + float(timeout)
    last = None
    while time.time() < deadline:
        try:
            return window_info(find_window(title, None, cls))
        except LookupError as exc:
            last = exc
        time.sleep(poll)
    raise LookupError("window did not appear within %ss (title=%r cls=%r): %s"
                      % (timeout, title, cls, last))


# ------------------------------------------------------------------ input

def _abs(dx, dy):
    vx = user32.GetSystemMetrics(76)
    vy = user32.GetSystemMetrics(77)
    vw = user32.GetSystemMetrics(78)
    vh = user32.GetSystemMetrics(79)
    return (int(round((dx - vx) * 65535.0 / max(vw - 1, 1))),
            int(round((dy - vy) * 65535.0 / max(vh - 1, 1))))


def cursor_pos():
    return list(win32api.GetCursorPos())


def move_to(x, y, steps=1, delay=0.0):
    start = win32api.GetCursorPos()
    for i in range(1, steps + 1):
        px = int(round(start[0] + (x - start[0]) * i / steps))
        py = int(round(start[1] + (y - start[1]) * i / steps))
        ax, ay = _abs(px, py)
        _send_inputs([_mouse_input(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, ax, ay)])
        if delay:
            time.sleep(delay)
    return cursor_pos()


def click_at(x, y, button="left", nomove=False, hold=0.0, double=False, clics=1,
             restore=False):
    start = cursor_pos()
    if not nomove:
        move_to(x, y)
        time.sleep(0.03)
    down = {"left": MOUSEEVENTF_LEFTDOWN, "right": MOUSEEVENTF_RIGHTDOWN,
            "middle": MOUSEEVENTF_MIDDLEDOWN}[button]
    up = {"left": MOUSEEVENTF_LEFTUP, "right": MOUSEEVENTF_RIGHTUP,
          "middle": MOUSEEVENTF_MIDDLEUP}[button]
    for _ in range(clics):
        _send_inputs([_mouse_input(down)])
        if hold:
            time.sleep(hold)
        _send_inputs([_mouse_input(up)])
        if double:
            time.sleep(0.05)
            _send_inputs([_mouse_input(down)])
            time.sleep(0.02)
            _send_inputs([_mouse_input(up)])
        time.sleep(0.05)
    if restore:
        move_to(start[0], start[1])
    return {"cursor": cursor_pos(), "restored_to": start if restore else None}


def drag(x1, y1, x2, y2, steps=12, hold=0.15, button="left", restore=False):
    start = cursor_pos()
    move_to(x1, y1)
    time.sleep(0.05)
    down = MOUSEEVENTF_LEFTDOWN if button == "left" else MOUSEEVENTF_RIGHTDOWN
    up = MOUSEEVENTF_LEFTUP if button == "left" else MOUSEEVENTF_RIGHTUP
    _send_inputs([_mouse_input(down)])
    time.sleep(hold)
    move_to(x2, y2, steps=steps, delay=0.01)
    time.sleep(hold)
    _send_inputs([_mouse_input(up)])
    if restore:
        move_to(start[0], start[1])
    return {"cursor": cursor_pos()}


def wheel(delta, x=None, y=None):
    if x is not None and y is not None:
        move_to(x, y)
        time.sleep(0.05)
    _send_inputs([_mouse_input(MOUSEEVENTF_WHEEL, 0, 0, int(delta))])
    return {"delta": delta}


def post_click(hwnd, x, y, button="left", double=False, client=True):
    """Click through the target's message queue: no cursor, no focus needed."""
    if not client:
        x, y = win32gui.ScreenToClient(hwnd, (int(x), int(y)))
    down = win32con.WM_LBUTTONDOWN if button == "left" else win32con.WM_RBUTTONDOWN
    up = win32con.WM_LBUTTONUP if button == "left" else win32con.WM_RBUTTONUP
    mk = win32con.MK_LBUTTON if button == "left" else win32con.MK_RBUTTON
    lp = (int(y) << 16) | (int(x) & 0xFFFF)
    win32gui.PostMessage(hwnd, win32con.WM_MOUSEMOVE, 0, lp)
    time.sleep(0.01)
    win32gui.PostMessage(hwnd, down, mk, lp)
    time.sleep(0.03)
    win32gui.PostMessage(hwnd, up, 0, lp)
    if double:
        time.sleep(0.04)
        win32gui.PostMessage(hwnd, win32con.WM_LBUTTONDBLCLK, mk, lp)
        time.sleep(0.02)
        win32gui.PostMessage(hwnd, up, 0, lp)
    return {"hwnd": int(hwnd), "x": int(x), "y": int(y), "double": bool(double)}


def type_text(text, per_char=0.0):
    for ch in text:
        if ch == "\n":
            _send_inputs([_key_input(0x0D), _key_input(0x0D, 0, KEYEVENTF_KEYUP)])
        elif ch == "\r":
            continue
        elif ch == "\t":
            _send_inputs([_key_input(0x09), _key_input(0x09, 0, KEYEVENTF_KEYUP)])
        else:
            code = ord(ch)
            _send_inputs([_key_input(0, code, KEYEVENTF_UNICODE),
                          _key_input(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)])
        if per_char:
            time.sleep(per_char)
    return len(text)


def post_text(hwnd, text, per_char=0.0):
    """Deliver characters as WM_CHAR straight to a control (console windows)."""
    for ch in text:
        code = 0x0D if ch == "\n" else ord(ch)
        win32gui.PostMessage(hwnd, win32con.WM_CHAR, code, 1)
        if per_char:
            time.sleep(per_char)
    return len(text)


def press_key(name, mods=None):
    mods = mods or []
    keys = []
    for m in mods:
        vk = VK.get(m.lower())
        if vk is None:
            raise ValueError("unknown modifier %r" % m)
        keys.append(vk)
    vk = VK.get(name.lower())
    if vk is None:
        if len(name) == 1:
            vk = ord(name.upper())
        else:
            raise ValueError("unknown key %r" % name)
    seq = [_key_input(k) for k in keys] + [_key_input(vk)]
    seq += [_key_input(vk, 0, KEYEVENTF_KEYUP)]
    seq += [_key_input(k, 0, KEYEVENTF_KEYUP) for k in reversed(keys)]
    _send_inputs(seq)
    return {"key": name, "mods": mods}


def set_clipboard(text):
    for _ in range(8):
        try:
            win32clipboard.OpenClipboard()
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
            win32clipboard.CloseClipboard()
            return True
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("clipboard busy after retries")


def paste_text(text):
    set_clipboard(text)
    time.sleep(0.08)
    press_key("v", ["ctrl"])
    return {"pasted": len(text)}


# ------------------------------------------------------------------ window ops

def focus(hwnd, restore=True):
    if restore and win32gui.IsIconic(hwnd):
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        time.sleep(0.35)
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        fg = win32gui.GetForegroundWindow()
        tid_fg = win32process.GetWindowThreadProcessId(fg)[0]
        tid_self = kernel32.GetCurrentThreadId()
        user32.AttachThreadInput(tid_self, tid_fg, True)
        try:
            win32gui.BringWindowToTop(hwnd)
            win32gui.SetForegroundWindow(hwnd)
        finally:
            user32.AttachThreadInput(tid_self, tid_fg, False)
    time.sleep(0.2)
    return window_info(hwnd)


def _is_foreground(hwnd):
    return _root_of(int(user32.GetForegroundWindow() or 0)) == _root_of(hwnd)


def raise_window(hwnd, settle=0.2):
    """Lift a window to the top of the Z-order without activating it.

    HWND_TOPMOST followed by HWND_NOTOPMOST keeps the window above every other
    normal window, which is the only way to un-cover eNSP when another app is
    maximised in front of it.
    """
    hwnd = int(hwnd)
    flags = win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | win32con.SWP_NOACTIVATE
    win32gui.SetWindowPos(hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0, flags)
    time.sleep(0.06)
    win32gui.SetWindowPos(hwnd, win32con.HWND_NOTOPMOST, 0, 0, 0, 0, flags)
    time.sleep(settle)
    return {"raised": True, "hwnd": hwnd}


def window_at(x, y):
    """Top-level window that would receive a click at screen point (x, y)."""
    hwnd = int(win32gui.WindowFromPoint((int(x), int(y))) or 0)
    return _root_of(hwnd)


def activate(hwnd, method="auto", settle=0.2):
    """Bring ``hwnd`` to the foreground, falling back to raising + a real click.

    Windows only lets the foreground process steal focus, and an elevated
    sidecar usually is not it, so SetForegroundWindow alone is unreliable.
    """
    hwnd = int(hwnd)
    if win32gui.IsIconic(hwnd):
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        time.sleep(0.3)
    tried = []
    if method in ("auto", "switch"):
        try:
            user32.SwitchToThisWindow(hwnd, True)
        except Exception as exc:
            tried.append("switch:%s" % exc)
        time.sleep(settle)
        if _is_foreground(hwnd):
            return {"activated": True, "method": "switch", "tried": tried}
        tried.append("switch:no")
    if method in ("auto", "setfg"):
        try:
            focus(hwnd, False)
        except Exception as exc:
            tried.append("setfg:%s" % exc)
        time.sleep(settle)
        if _is_foreground(hwnd):
            return {"activated": True, "method": "setforeground", "tried": tried}
        tried.append("setfg:no")
    if method in ("auto", "raise"):
        raise_window(hwnd)
        if _is_foreground(hwnd):
            return {"activated": True, "method": "raise", "tried": tried}
        tried.append("raise:no")
    if method in ("auto", "click"):
        rect = win32gui.GetWindowRect(hwnd)
        point = [(rect[0] + rect[2]) // 2, rect[1] + 10]
        click_at(point[0], point[1], restore=True)
        time.sleep(settle)
        if _is_foreground(hwnd):
            return {"activated": True, "method": "titlebar-click", "point": point, "tried": tried}
        tried.append("click:no")
    return {"activated": False, "tried": tried}


def guard_foreground(expect, settle=0.2):
    """Make ``expect`` the foreground window or refuse to keep going."""
    target = _root_of(int(expect))
    info = activate(target, "auto", settle)
    if not info.get("activated"):
        raise RuntimeError(
            "refusing to send keystrokes: %r is not the foreground window (tried %s)"
            % (win32gui.GetWindowText(target), ", ".join(info.get("tried", []))))
    return info


def click_guarded(x, y, expect=None, raise_first=True, **kwargs):
    """Click only when the point really belongs to the expected window.

    A blind SendInput click on a covered eNSP would land in whatever app the
    user has in front, so the target is verified (and optionally raised first).
    """
    x, y = int(x), int(y)
    info = {"point": [x, y]}
    if expect is not None:
        target = _root_of(int(expect))
        info["expect"] = target
        hit = window_at(x, y)
        if hit != target and raise_first:
            raise_window(target)
            hit = window_at(x, y)
            info["raised"] = True
        if hit != target:
            raise RuntimeError(
                "refusing to click %s: that point belongs to %r (hwnd %s), not the expected window %s "
                "(bring eNSP to the front, or pass raise=false to override)"
                % ([x, y], win32gui.GetWindowText(hit), hit, target))
        info["covered"] = False
    info.update(click_at(x, y, **kwargs))
    return info


def resize(hwnd, x, y, width, height):
    win32gui.SetWindowPos(hwnd, win32con.HWND_TOP, int(x), int(y), int(width), int(height),
                          win32con.SWP_SHOWWINDOW)
    time.sleep(0.2)
    return window_info(hwnd)


def close_window(hwnd):
    win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    return {"closed": int(hwnd)}


def send_text(hwnd, text):
    win32gui.SendMessage(hwnd, win32con.WM_SETTEXT, 0, text)
    return {"hwnd": int(hwnd), "text": text}


def click_button(hwnd):
    win32gui.SendMessage(hwnd, win32con.BM_CLICK, 0, 0)
    return {"clicked": int(hwnd)}


def _root_of(hwnd):
    if not hwnd:
        return 0
    return int(win32gui.GetAncestor(int(hwnd), win32con.GA_ROOT) or hwnd)


def foreground():
    hwnd = user32.GetForegroundWindow()
    return {"hwnd": int(hwnd or 0), "title": win32gui.GetWindowText(hwnd) if hwnd else "",
            "cls": win32gui.GetClassName(hwnd) if hwnd else ""}


def safe_type(hwnd, text, per_char=0.02, settle=0.15, method="auto"):
    """Type into ``hwnd`` only after proving it owns the keyboard.

    SendInput goes to the foreground window, so a failed activation would leak
    keystrokes into whatever the user is actually looking at.  This refuses
    instead of typing blind.
    """
    hwnd = int(hwnd)
    info = activate(hwnd, method, settle)
    fg = int(user32.GetForegroundWindow() or 0)
    if not info.get("activated"):
        raise RuntimeError(
            "refusing to type: could not activate hwnd %s (foreground is %r); tried %s"
            % (hwnd, win32gui.GetWindowText(fg), ", ".join(info.get("tried", []))))
    typed = type_text(text, per_char)
    return {"typed": typed, "foreground": fg, "activation": info["method"]}


# --------------------------------------------------------------- process ops

def shell_open(path, wait=0.0):
    """ShellExecute 'open' inherits our elevation for executables."""
    rc = shell32.ShellExecuteW(None, "open", path, None,
                             os.path.dirname(os.path.abspath(path)), 1)
    if rc <= 32:
        raise RuntimeError("ShellExecuteW rc=%s for %s" % (rc, path))
    if wait:
        time.sleep(float(wait))
    return {"rc": rc}


def explorer_open(path, wait=0.0):
    """Hand the document to Explorer so the new process outlives this job."""
    rc = shell32.ShellExecuteW(None, "open", "explorer.exe", '"%s"' % path, None, 1)
    if rc <= 32:
        raise RuntimeError("explorer ShellExecute rc=%s" % rc)
    if wait:
        time.sleep(float(wait))
    return {"rc": rc}


def spawn_detached(exe, cmdline=None, workdir=None, breakaway=True):
    si = STARTUPINFO()
    si.cb = ctypes.sizeof(STARTUPINFO)
    si.dwFlags = 0x00000001
    si.wShowWindow = 1
    pi = PROCESS_INFORMATION()
    flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    if breakaway:
        flags |= CREATE_BREAKAWAY_FROM_JOB
    kernel32.CreateProcessW.argtypes = [wt.LPCWSTR, wt.LPWSTR, wt.LPVOID, wt.LPVOID,
                                        wt.BOOL, wt.DWORD, wt.LPVOID, wt.LPCWSTR,
                                        ctypes.POINTER(STARTUPINFO),
                                        ctypes.POINTER(PROCESS_INFORMATION)]
    ok = kernel32.CreateProcessW(exe, ctypes.c_wchar_p(cmdline or exe), None, None, False,
                                 flags, None, workdir, ctypes.byref(si), ctypes.byref(pi))
    if not ok:
        raise OSError("CreateProcess failed: %s" % ctypes.WinError())
    return {"pid": int(pi.dwProcessId), "breakaway": breakaway}


def kill_images(names, wait=0.0):
    killed = []
    for name in names:
        proc = subprocess.run(["taskkill", "/f", "/im", name], capture_output=True, text=True,
                              creationflags=CREATE_NO_WINDOW)
        killed.append({"image": name, "rc": proc.returncode,
                       "out": ((proc.stdout or proc.stderr) or "").strip()[:200]})
    if wait:
        time.sleep(float(wait))
    return killed


# --------------------------------------------------------------- eNSP helpers

def ensp_windows():
    """Visible eNSP client windows."""
    return [w for w in enum_windows(None, True) if w["cls"].lower().startswith("afx:")]


def ensp_main():
    """The first visible eNSP client window, or a clear error."""
    wins = ensp_windows()
    if not wins:
        raise LookupError("no eNSP window is open")
    return wins[0]


def resolve_target(args):
    """Window selector used by every window op: hwnd / title / cls, or ensp=true."""
    if args.get("ensp"):
        return ensp_main()["hwnd"]
    return find_window(args.get("title"), args.get("hwnd"), args.get("cls"))


def device_windows():
    """eNSP device windows: consoles and property dialogs (#32770, titled by device)."""
    rows = []
    for w in enum_windows(None, True):
        if w["cls"] == "#32770" and w["title"]:
            rows.append(w)
    return rows


def canvas_anchors(main_hwnd):
    """Label anchors on the canvas.

    eNSP parks one invisible 30x22 ``Edit`` control on every device label.  The
    names are painted, not stored, so a caller pairs these rectangles with the
    .topo file's ``edit_left``/``edit_top`` to learn the canvas -> screen offset.
    """
    rows = []
    for item in children(main_hwnd, 2):
        width = item["rect"][2] - item["rect"][0]
        height = item["rect"][3] - item["rect"][1]
        if item["cls"] == "Edit" and abs(width - 30) <= 6 and abs(height - 22) <= 6:
            rows.append({"hwnd": item["hwnd"], "rect": item["rect"]})
    return rows


def exe_version(path):
    """File/product version of an executable, for telling eNSP builds apart."""
    info = win32api.GetFileVersionInfo(path, "\\")
    ms, ls = info["FileVersionMS"], info["FileVersionLS"]
    return "%d.%d.%d.%d" % (ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF)


def exeinfo(path):
    out = {"path": path, "exists": os.path.exists(path)}
    if out["exists"]:
        try:
            out["version"] = exe_version(path)
        except Exception as exc:
            out["version_error"] = str(exc)
        try:
            out["modified"] = time.strftime("%Y-%m-%d %H:%M:%S",
                                            time.localtime(os.path.getmtime(path)))
        except Exception:
            pass
    return out


# ------------------------------------------------------------------ dispatch

def dispatch(op, args):
    if op == "ping":
        return {"pong": True, "pid": os.getpid(), "elevated": is_elevated(),
                "dpi_aware": DPI_MODE, "cursor": cursor_pos(),
                "screen": [user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)]}
    if op == "windows":
        return {"windows": enum_windows(args.get("filter"), args.get("visible_only", True))}
    if op == "ensp":
        wins = ensp_windows()
        return {"windows": wins, "devices": device_windows(),
                "anchors": [{"main": w["hwnd"], "items": canvas_anchors(w["hwnd"])}
                            for w in wins]}
    if op == "pidwindows":
        rows = []
        want = int(args["pid"])
        def cb(h, _):
            _t, pid = win32process.GetWindowThreadProcessId(h)
            if pid != want:
                return True
            rows.append(window_info(h))
            return True
        win32gui.EnumWindows(cb, None)
        return {"windows": rows}
    if op == "screen":
        out = args["out"]
        width = user32.GetSystemMetrics(0)
        height = user32.GetSystemMetrics(1)
        hdesktop = user32.GetDesktopWindow()
        hdc = user32.GetWindowDC(hdesktop)
        src = win32ui.CreateDCFromHandle(hdc)
        mem = src.CreateCompatibleDC()
        bmp = win32ui.CreateBitmap()
        bmp.CreateCompatibleBitmap(src, width, height)
        mem.SelectObject(bmp)
        mem.BitBlt((0, 0), (width, height), src, (0, 0), win32con.SRCCOPY)
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        bmp.SaveBitmapFile(mem, out)
        win32gui.DeleteObject(bmp.GetHandle())
        mem.DeleteDC()
        src.DeleteDC()
        user32.ReleaseDC(hdesktop, hdc)
        if out.lower().endswith(".png") and Image is not None:
            with Image.open(out) as img:
                img = img.convert("RGB")
                if args.get("crop"):
                    x, y, w, h = (int(v) for v in args["crop"])
                    img = img.crop((x, y, x + w, y + h))
                img.save(out)
        return {"out": out, "width": width, "height": height}
    if op == "children":
        hwnd = resolve_target(args)
        return {"children": children(hwnd, args.get("depth", 2))}
    if op == "texts":
        hwnd = resolve_target(args)
        return {"texts": texts(hwnd, args.get("depth", 2), args.get("only"))}
    if op == "find":
        hwnd = find_window(args.get("title"), args.get("hwnd"), args.get("cls"),
                           args.get("include_hidden", True))
        return {"window": window_info(hwnd)}
    if op == "info":
        hwnd = resolve_target(args)
        return {"window": window_info(hwnd)}
    if op == "wait":
        return {"window": wait_window(args.get("title"), args.get("cls"),
                                      args.get("timeout", 15))}
    if op == "exists":
        return {"exists": window_exists(args.get("hwnd"))}
    if op == "shot":
        hwnd = resolve_target(args)
        return capture(hwnd, args["out"], args.get("crop"), args.get("mode", "blit"))
    if op == "show":
        hwnd = find_window(args.get("title"), args.get("hwnd"), args.get("cls"),
                           include_hidden=True)
        win32gui.ShowWindow(hwnd, win32con.SW_SHOWNORMAL if args.get("normal", True)
                            else win32con.SW_SHOW)
        if args.get("front", True):
            focus(hwnd, False)
        time.sleep(args.get("settle", 0.4))
        return {"window": window_info(hwnd)}
    if op == "focus":
        hwnd = resolve_target(args)
        return {"window": focus(hwnd, args.get("restore", True))}
    if op == "resize":
        hwnd = resolve_target(args)
        return {"window": resize(hwnd, args["x"], args["y"], args["w"], args["h"])}
    if op == "close":
        hwnd = resolve_target(args)
        return close_window(hwnd)
    if op == "cursor":
        return {"cursor": cursor_pos()}
    if op == "move":
        return {"cursor": move_to(args["x"], args["y"], args.get("steps", 1),
                                  args.get("delay", 0.0))}
    if op == "click":
        expect = None
        if args.get("expect"):
            expect = ensp_main()["hwnd"] if args["expect"] == "ensp" else (
                int(args["expect"]) if isinstance(args["expect"], int) else resolve_target({"title": args["expect"]}))
        elif args.get("ensp_rel"):
            expect = ensp_main()["hwnd"]
        if args.get("ensp_rel"):
            main = ensp_main()
            x = main["rect"][0] + int(args["ensp_rel"][0])
            y = main["rect"][1] + int(args["ensp_rel"][1])
        else:
            x, y = args["x"], args["y"]
        if expect:
            return click_guarded(x, y, expect, args.get("raise_first", True),
                                 button=args.get("button", "left"),
                                 nomove=args.get("nomove", False), hold=args.get("hold", 0.0),
                                 double=args.get("double", False), clics=args.get("clics", 1),
                                 restore=args.get("restore", False))
        return click_at(x, y, args.get("button", "left"),
                        args.get("nomove", False), args.get("hold", 0.0),
                        args.get("double", False), args.get("clics", 1),
                        args.get("restore", False))
    if op == "ncclick":
        hwnd = resolve_target(args)
        lp = (int(args["y"]) << 16) | (int(args["x"]) & 0xFFFF)
        win32gui.PostMessage(hwnd, win32con.WM_NCLBUTTONDOWN, win32con.HTCLIENT, lp)
        time.sleep(0.05)
        win32gui.PostMessage(hwnd, win32con.WM_NCLBUTTONUP, 0, lp)
        return {"nc": [args["x"], args["y"]]}
    if op == "postclick":
        hwnd = resolve_target(args)
        return post_click(hwnd, args["x"], args["y"], args.get("button", "left"),
                          args.get("double", False), args.get("client", True))
    if op == "drag":
        return drag(args["x1"], args["y1"], args["x2"], args["y2"],
                    args.get("steps", 12), args.get("hold", 0.15),
                    args.get("button", "left"), args.get("restore", False))
    if op == "wheel":
        return wheel(args.get("delta", -120), args.get("x"), args.get("y"))
    if op == "type":
        guard = guard_foreground(ensp_main()["hwnd"]) if args.get("ensp") else None
        if args.get("expect"):
            guard = guard_foreground(resolve_target({"title": args["expect"]}) if isinstance(args["expect"], str)
                                     else args["expect"])
        out = {"typed": type_text(args["text"], args.get("per_char", 0.0))}
        if guard:
            out["activation"] = guard["method"]
        return out
    if op == "safetype":
        return safe_type(resolve_target(args), args["text"],
                         args.get("per_char", 0.02), args.get("settle", 0.15),
                         args.get("method", "auto"))
    if op == "activate":
        return activate(resolve_target(args), args.get("method", "auto"),
                        args.get("settle", 0.2))
    if op == "raise":
        return raise_window(resolve_target(args), args.get("settle", 0.2))
    if op == "fg":
        return foreground()
    if op == "posttext":
        hwnd = resolve_target(args)
        return {"posted": post_text(hwnd, args["text"], args.get("per_char", 0.0))}
    if op == "key":
        if args.get("expect") or args.get("ensp"):
            target = ensp_main()["hwnd"] if args.get("ensp") else (
                resolve_target({"title": args["expect"]}) if isinstance(args["expect"], str) else args["expect"])
            guard_foreground(target)
        return press_key(args["key"], args.get("mods"))
    if op == "paste":
        if args.get("expect") or args.get("ensp"):
            target = ensp_main()["hwnd"] if args.get("ensp") else (
                resolve_target({"title": args["expect"]}) if isinstance(args["expect"], str) else args["expect"])
            guard_foreground(target)
        if args.get("hwnd"):
            focus(find_window(None, args["hwnd"]), True)
        return paste_text(args["text"])
    if op == "settext":
        hwnd = resolve_target(args)
        return send_text(hwnd, args["text"])
    if op == "bmclick":
        hwnd = resolve_target(args)
        return click_button(hwnd)
    if op == "wndat":
        return {"at": wnd_at(args["x"], args["y"])}
    if op == "exeinfo":
        return {"exe": exeinfo(args["path"])}
    if op == "open":
        return shell_open(args["path"], args.get("wait", 0.0))
    if op == "explore":
        return explorer_open(args["path"], args.get("wait", 0.0))
    if op == "spawn":
        return {"spawned": spawn_detached(args["exe"], args.get("cmdline"),
                                          args.get("workdir"), args.get("breakaway", True))}
    if op == "kill":
        return {"killed": kill_images(args["names"], args.get("wait", 0.0))}
    if op == "sleep":
        time.sleep(float(args.get("t", 0.5)))
        return {"slept": args.get("t", 0.5)}
    if op == "exit":
        return {"bye": True}
    raise ValueError("unknown op %r" % op)


# ------------------------------------------------------------------ run modes

def run_job(job_path):
    """One-shot batch.  One launch carries every step: the fast path."""
    with open(job_path, "r", encoding="utf-8") as fh:
        job = json.load(fh)
    results = []
    started = time.time()
    for index, step in enumerate(job.get("steps", [])):
        if not isinstance(step, dict) or "op" not in step:
            results.append({"index": index, "ok": False, "op": None,
                            "error": "step must be an object with op"})
            continue
        op = step["op"]
        args = {k: v for k, v in step.items() if k != "op"}
        t0 = time.time()
        try:
            payload = dispatch(op, args) or {}
            payload["ok"] = True
        except Exception as exc:
            payload = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc),
                       "trace": traceback.format_exc()[-1200:]}
        payload["index"] = index
        payload["op"] = op
        payload["ms"] = int((time.time() - t0) * 1000)
        results.append(payload)
        if job.get("stop_on_error") and not payload["ok"]:
            break
    out = {"ok": True, "elevated": is_elevated(), "dpi_aware": DPI_MODE,
           "pid": os.getpid(), "steps": results, "ms": int((time.time() - started) * 1000)}
    with open(job["result"], "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)


def serve(port, token):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(8)
    log("listening %d" % port)
    while True:
        conn, _addr = server.accept()
        threading.Thread(target=_serve_conn, args=(conn, token), daemon=True).start()


def _serve_conn(conn, token):
    buf = b""
    try:
        conn.settimeout(900)
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    req = json.loads(line.decode("utf-8"))
                except Exception as exc:
                    conn.sendall((json.dumps({"ok": False, "error": "bad json: %s" % exc})
                                  + "\n").encode())
                    continue
                if token and req.get("token") != token:
                    conn.sendall((json.dumps({"id": req.get("id"), "ok": False,
                                              "error": "bad token"}) + "\n").encode())
                    continue
                op = req.get("op")
                t0 = time.time()
                try:
                    payload = dispatch(op, {k: v for k, v in req.items() if k != "op"}) or {}
                    payload["ok"] = True
                except Exception as exc:
                    payload = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc),
                               "trace": traceback.format_exc()[-1200:]}
                payload["id"] = req.get("id")
                payload["ms"] = int((time.time() - t0) * 1000)
                conn.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode())
                if op == "exit":
                    os._exit(0)
    except Exception:
        log("conn error: " + traceback.format_exc()[-500:])
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main(argv=None):
    global DPI_MODE, LOG_PATH
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", default="")
    parser.add_argument("--log", default="")
    parser.add_argument("--job", default="")
    args = parser.parse_args(argv)
    LOG_PATH = args.log or None
    DPI_MODE = set_dpi_aware()
    log("start pid=%s elevated=%s dpi=%s mode=%s" % (os.getpid(), is_elevated(), DPI_MODE,
                                                     "job" if args.job else "serve"))
    if args.job:
        run_job(args.job)
        return
    serve(args.port, args.token)


if __name__ == "__main__":
    main()
