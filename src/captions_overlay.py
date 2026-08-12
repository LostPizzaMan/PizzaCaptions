import ctypes
import logging
import threading

import hotkey as _hotkey

logger = logging.getLogger(__name__)

UI_PORT = 3011
CAPTIONS_URL = f"http://127.0.0.1:{UI_PORT}/captions.html"
_HOTKEY_MODS = _hotkey.MOD_ALT
_HOTKEY_VK = _hotkey.VK_C

_app_handle = None
_win = None
_shown = False
_interactive = False
_hover_enabled = True
_blur_translation = False
_origin = (0, 0)
_hk = None
_poll_thread = None
_poll_stop = threading.Event()
_lock = threading.Lock()


class _POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def _cursor_pos():
    p = _POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


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
    existing = Manager.get_webview_window(_app_handle, "captions")
    if existing is not None:
        _win = existing
        return _win
    _win = WebviewWindowBuilder.build(
        _app_handle, "captions", WebviewUrl.External(CAPTIONS_URL),
        transparent=True, decorations=False, always_on_top=True,
        skip_taskbar=True, shadow=False, resizable=False,
        maximizable=False, minimizable=False, closable=False,
        focused=False, visible=False, title="captions",
    )
    logger.info("captions window built")
    return _win


def _do_show() -> None:

    global _shown, _interactive, _origin
    try:
        from pytauri import Position, Size
        win = _build_or_get_window()
        mon = _app_handle.primary_monitor()
        if mon is not None:
            size = mon.size() if callable(mon.size) else mon.size
            pos = mon.position() if callable(mon.position) else mon.position
            w, h = size
            x, y = pos
            _origin = (int(x), int(y))
            win.set_position(Position.Physical((int(x), int(y))))
            win.set_size(Size.Physical((int(w), int(h))))
        win.set_always_on_top(True)
        win.set_ignore_cursor_events(True)
        win.show()
        _shown = True
        _interactive = False
        try:
            win.eval(
                "window.__captionsReset && window.__captionsReset();"
                "window.__captionsInteract && window.__captionsInteract(false);"
                "window.__captionsHoverDefine && window.__captionsHoverDefine(%s);"
                "window.__captionsBlur && window.__captionsBlur(%s)"
                % (("true" if _hover_enabled else "false"),
                   ("true" if _blur_translation else "false")))
        except Exception:
            pass
    except Exception as e:
        logger.error("captions show failed: %s", e)


def _do_hide() -> None:
    global _shown, _interactive
    try:
        if _win is not None:
            _win.hide()
    except Exception as e:
        logger.error("captions hide failed: %s", e)
    _shown = False
    _interactive = False


def _do_set_interactive(on: bool) -> None:

    global _interactive
    if not _shown or _win is None:
        return
    try:
        _interactive = bool(on)
        _win.set_ignore_cursor_events(not _interactive)
        if _interactive:
            _win.set_focus()
            _win.eval("window.jadict && window.jadict.hoverAt(-1,-1)")
        _win.eval("window.__captionsInteract && window.__captionsInteract(%s)"
                  % ("true" if _interactive else "false"))
    except Exception as e:
        logger.error("captions interact toggle failed: %s", e)


def _do_hover(rx: int, ry: int) -> None:

    try:
        if _win is not None:
            _win.eval("window.__captionsHover && window.__captionsHover(%d,%d)" % (rx, ry))
    except Exception:
        pass


def _poll_loop() -> None:

    last = None
    while not _poll_stop.is_set():
        try:
            if (_shown and not _interactive and (_hover_enabled or _blur_translation)
                    and _win is not None and _app_handle is not None):
                x, y = _cursor_pos()
                if (x, y) != last:
                    last = (x, y)
                    rx, ry = x - _origin[0], y - _origin[1]
                    _app_handle.run_on_main_thread(lambda rx=rx, ry=ry: _do_hover(rx, ry))
            else:
                last = None
        except Exception:
            pass
        _poll_stop.wait(0.04)


def show() -> None:
    if _app_handle is None:
        logger.info("captions overlay unavailable (no app handle; browser dev?)")
        return
    _app_handle.run_on_main_thread(_do_show)


def hide() -> None:
    if _app_handle is None:
        return
    _app_handle.run_on_main_thread(_do_hide)


def set_interactive(on: bool) -> None:
    if _app_handle is None or not _shown:
        return
    _app_handle.run_on_main_thread(lambda: _do_set_interactive(on))


def toggle_interactive() -> None:
    set_interactive(not _interactive)


def _eval_js(js: str) -> None:
    if _app_handle is None:
        return
    def run():
        try:
            if _win is not None:
                _win.eval(js)
        except Exception:
            pass
    _app_handle.run_on_main_thread(run)


def set_hover(on: bool) -> None:
    global _hover_enabled
    _hover_enabled = bool(on)
    _eval_js("window.__captionsHoverDefine && window.__captionsHoverDefine(%s)"
             % ("true" if _hover_enabled else "false"))
    if not _hover_enabled:
        _eval_js("window.jadict && window.jadict.hoverAt(-1,-1)")


def set_blur(on: bool) -> None:
    global _blur_translation
    _blur_translation = bool(on)
    _eval_js("window.__captionsBlur && window.__captionsBlur(%s)"
             % ("true" if _blur_translation else "false"))


def _on_hotkey() -> None:
    toggle_interactive()


def start() -> None:

    global _hk, _poll_thread
    with _lock:
        if _app_handle is None:
            return
        if _hk is None:
            hk = _hotkey.GlobalHotkey(_HOTKEY_MODS, _HOTKEY_VK, _on_hotkey)
            if hk.start():
                _hk = hk
                logger.info("captions interact hotkey Alt+C registered")
            else:
                logger.warning("captions interact hotkey Alt+C not registered (already in use)")
        if _poll_thread is None:
            _poll_stop.clear()
            _poll_thread = threading.Thread(target=_poll_loop, daemon=True, name="captions-hover")
            _poll_thread.start()


def stop() -> None:
    global _hk, _poll_thread
    _poll_stop.set()
    if _poll_thread is not None:
        _poll_thread.join(timeout=1)
        _poll_thread = None
    if _hk is not None:
        _hk.stop()
        _hk = None
    _app_handle and hide()
