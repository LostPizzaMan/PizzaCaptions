import ctypes
import logging
import threading
from ctypes import wintypes

logger = logging.getLogger(__name__)

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_NOREPEAT = 0x4000
WM_HOTKEY = 0x0312
WM_QUIT = 0x0012
VK_A = 0x41
VK_C = 0x43
VK_S = 0x53
VK_Z = 0x5A

_user32 = ctypes.windll.user32
_kernel32 = ctypes.windll.kernel32

class GlobalHotkey:
    def __init__(self, modifiers: int, vk: int, callback):
        self._mod = modifiers
        self._vk = vk
        self._cb = callback
        self._thread: threading.Thread | None = None
        self._tid: int | None = None
        self._ready = threading.Event()
        self._ok = False

    def start(self) -> bool:
        self._thread = threading.Thread(target=self._run, daemon=True, name="global-hotkey")
        self._thread.start()
        self._ready.wait(timeout=5)
        return self._ok

    def _run(self):
        self._tid = _kernel32.GetCurrentThreadId()
        self._ok = bool(_user32.RegisterHotKey(None, 1, self._mod | MOD_NOREPEAT, self._vk))
        self._ready.set()
        if not self._ok:
            logger.warning("RegisterHotKey failed (mod=%#x vk=%#x); likely already in use",
                           self._mod, self._vk)
            return
        msg = wintypes.MSG()
        while True:
            r = _user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if r == 0 or r == -1:
                break
            if msg.message == WM_HOTKEY:
                try:
                    self._cb()
                except Exception:
                    logger.exception("hotkey callback error")
        _user32.UnregisterHotKey(None, 1)

    def stop(self):
        if self._tid is not None:
            _user32.PostThreadMessageW(self._tid, WM_QUIT, 0, 0)
        if self._thread is not None:
            self._thread.join(timeout=2)
        self._tid = None
