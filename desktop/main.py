import asyncio
import os
import sys
import threading

from pathlib import Path
from urllib import request as urllib_request

if sys.stdout is None or sys.stderr is None:
    _log_dir = Path(os.environ.get("APPDATA", ".")) / "LiveTranscription" / "logs"
    _log_dir.mkdir(parents=True, exist_ok=True)
    _stream = open(_log_dir / "desktop.log", "a", buffering=1, encoding="utf-8")
    sys.stdout = sys.stderr = _stream

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR / "src"))

from engine_base import UI_PORT

def start_backend_async():
    def run():
        try:
            import uvicorn
            import server
            config = uvicorn.Config(server.app, host="127.0.0.1", port=UI_PORT, log_level="info")
            uvicorn.Server(config).run()
        except Exception:
            import traceback
            traceback.print_exc()

    threading.Thread(target=run, daemon=True, name="backend").start()

def shutdown():
    import sys
    if sys.modules.get("server") is None:
        return
    for mod, fn in (("capture", "stop_all_slots"), ("tts", "on_shutdown"),
                    ("ocr", "on_shutdown"), ("jadict", "on_shutdown"),
                    ("win_captions", "stop_pack")):
        m = sys.modules.get(mod)
        try:
            if m is not None:
                getattr(m, fn)()
        except Exception:
            pass
    ov = sys.modules.get("overlay")
    if ov is not None:
        try:
            ov.stop()
        except Exception:
            pass
    cap = sys.modules.get("captions_overlay")
    if cap is not None:
        try:
            cap.stop()
        except Exception:
            pass

def _already_running() -> bool:
    try:
        with urllib_request.urlopen(f"http://127.0.0.1:{UI_PORT}/engines", timeout=1) as r:
            return r.status == 200
    except Exception:
        return False

def main():
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("LiveTranscription.App")

    if _already_running():
        if sys.platform == "win32":
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                None, "Pizza Captions is already running.", "Pizza Captions", 0x40)
        return

    start_backend_async()

    from pytauri import Manager, RunEvent, WindowEvent
    from pytauri.image import Image
    from pytauri_wheel.lib import builder_factory, context_factory

    src_tauri = Path(__file__).resolve().parent / "src-tauri"
    context = context_factory(src_tauri)
    app = builder_factory().build(context=context, invoke_handler=None)

    try:
        window = Manager.get_webview_window(app.handle(), "main")
        if window is not None:
            window.set_icon(Image.from_path(src_tauri / "icons" / "icon.png"))
    except Exception:
        pass

    try:
        import overlay
        overlay.set_app_handle(app.handle())
        overlay.start()
    except Exception:
        import traceback
        traceback.print_exc()

    try:
        import captions_overlay
        captions_overlay.set_app_handle(app.handle())
        captions_overlay.start()
    except Exception:
        import traceback
        traceback.print_exc()

    def on_run_event(handle, event):
        try:
            if (isinstance(event, RunEvent.WindowEvent) and event.label == "main"
                    and isinstance(event.event, WindowEvent.CloseRequested)):
                handle.exit(0)
        except Exception:
            pass

    try:
        exit_code = app.run_return(on_run_event)
    finally:
        shutdown()
    sys.exit(exit_code)

if __name__ == "__main__":
    main()
