import os
import sys
import threading
import time
from pathlib import Path
from urllib import request as urllib_request

if sys.stdout is None or sys.stderr is None:
    _log_dir = Path(os.environ.get("APPDATA", ".")) / "LiveTranscription" / "logs"
    _log_dir.mkdir(parents=True, exist_ok=True)
    _stream = open(_log_dir / "desktop.log", "a", buffering=1, encoding="utf-8")
    sys.stdout = sys.stderr = _stream

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR / "src"))

UI_PORT = 3011


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
    server = sys.modules.get("server")
    if server is None:
        return
    try:
        server.stop_capture()
    except Exception:
        pass
    try:
        server._engine_mgr.stop()
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
                None, "Live Transcription is already running.", "Live Transcription", 0x40)
        return

    start_backend_async()

    from pytauri import Manager
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
        exit_code = app.run_return()
    finally:
        shutdown()
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
