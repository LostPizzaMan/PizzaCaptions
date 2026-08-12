import logging
import threading

import hotkey as _hotkey

logger = logging.getLogger(__name__)

UI_PORT = 3011
OVERLAY_URL = f"http://127.0.0.1:{UI_PORT}/overlay.html"
_HOTKEY_MODS = _hotkey.MOD_ALT
_HOTKEY_VK = _hotkey.VK_S

_app_handle = None
_win = None
_hk = None
_lock = threading.Lock()


def set_app_handle(handle) -> None:
    global _app_handle
    _app_handle = handle


def available() -> bool:
    return _app_handle is not None


def _build_or_get_window():
    global _win
    if _win is not None:
        return _win
    from pytauri import Manager, WebviewUrl
    from pytauri.webview import WebviewWindowBuilder
    existing = Manager.get_webview_window(_app_handle, "overlay")
    if existing is not None:
        _win = existing
        return _win
    _win = WebviewWindowBuilder.build(
        _app_handle, "overlay", WebviewUrl.External(OVERLAY_URL),
        transparent=True, decorations=False, always_on_top=True,
        skip_taskbar=True, shadow=False, resizable=False,
        maximizable=False, minimizable=False, closable=False,
        focused=False, visible=False, title="overlay",
    )
    logger.info("overlay window built")
    return _win


def _do_show() -> None:
    try:
        from pytauri import Position, Size
        win = _build_or_get_window()
        mon = _app_handle.primary_monitor()
        if mon is not None:
            size = mon.size() if callable(mon.size) else mon.size
            pos = mon.position() if callable(mon.position) else mon.position
            w, h = size
            x, y = pos
            win.set_position(Position.Physical((int(x), int(y))))
            win.set_size(Size.Physical((int(w), int(h))))
        win.set_always_on_top(True)
        win.set_ignore_cursor_events(False)
        win.show()
        win.set_focus()
        try:
            win.eval("window.__overlayReset && window.__overlayReset()")
        except Exception:
            pass
    except Exception as e:
        logger.error("overlay show failed: %s", e)


def _do_hide() -> None:
    try:
        if _win is not None:
            _win.hide()
    except Exception as e:
        logger.error("overlay hide failed: %s", e)


def show() -> None:
    if _app_handle is None:
        logger.info("overlay unavailable (no app handle; browser dev?)")
        return
    _app_handle.run_on_main_thread(_do_show)


def hide() -> None:
    if _app_handle is None:
        return
    _app_handle.run_on_main_thread(_do_hide)


def _on_hotkey() -> None:
    show()


def start() -> None:

    global _hk
    with _lock:
        if _hk is not None or _app_handle is None:
            return
        hk = _hotkey.GlobalHotkey(_HOTKEY_MODS, _HOTKEY_VK, _on_hotkey)
        if hk.start():
            _hk = hk
            logger.info("OCR overlay hotkey Alt+S registered")
        else:
            logger.warning("OCR overlay hotkey Alt+S not registered (already in use)")


def stop() -> None:
    global _hk
    if _hk is not None:
        _hk.stop()
        _hk = None
    _app_handle and hide()
