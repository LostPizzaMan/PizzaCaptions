import argparse
import asyncio
import ctypes
import json
import logging
import os
import subprocess
import threading
import time

import comtypes
import uiautomation as auto
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from captions_sync import CaptionSync

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("win_captions-engine")

_user32 = ctypes.windll.user32
SW_MINIMIZE, SW_RESTORE = 6, 9
GWL_EXSTYLE, WS_EX_TOOLWINDOW = -20, 0x80
LC_CLASS = "LiveCaptionsDesktopWindow"
CAPTION_AID = "CaptionsTextBlock"
POLL_S = 0.15

def _lc_exe() -> str:
    windir = os.environ.get("SystemRoot") or os.environ.get("windir") or r"C:\Windows"
    for sub in ("System32", "Sysnative"):
        p = os.path.join(windir, sub, "LiveCaptions.exe")
        if os.path.exists(p):
            return p
    return os.path.join(windir, "System32", "LiveCaptions.exe")

app = FastAPI()
_reader_lock = threading.Lock()

@app.get("/health")
def health():
    return {"status": "ok", "engine": "win_captions"}

_user32.FindWindowW.restype = ctypes.c_void_p
_user32.FindWindowW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]

def _find_window(stop: threading.Event, timeout: float):
    end = time.time() + timeout
    while time.time() < end and not stop.is_set():
        hwnd = _user32.FindWindowW(LC_CLASS, None)
        if hwnd:
            try:
                ctrl = auto.ControlFromHandle(hwnd)
            except Exception:
                ctrl = None
            if ctrl is not None:
                return ctrl
        stop.wait(0.25)
    return None

def _find_by_aid(ctrl, aid, depth=0, maxdepth=14):
    if depth > maxdepth:
        return None
    try:
        kids = ctrl.GetChildren()
    except Exception:
        return None
    for ch in kids:
        try:
            if ch.AutomationId == aid:
                return ch
        except Exception:
            pass
        r = _find_by_aid(ch, aid, depth + 1, maxdepth)
        if r:
            return r
    return None

def _hide_bar(hwnd: int) -> int:
    ex = _user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    _user32.ShowWindow(hwnd, SW_MINIMIZE)
    _user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW)
    return ex

def _restore_bar(hwnd: int, ex: int):
    try:
        _user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex)
        _user32.ShowWindow(hwnd, SW_RESTORE)
    except Exception:
        pass

def _kill_live_captions():
    try:
        subprocess.run(["taskkill", "/IM", "LiveCaptions.exe", "/F"],
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                       capture_output=True)
    except Exception:
        pass

def _read_loop(on_frame, stop: threading.Event):
    comtypes.CoInitializeEx(comtypes.COINIT_MULTITHREADED)
    sync = CaptionSync(on_frame)
    launched = False
    try:
        while not stop.is_set():
            win = _find_window(stop, 1.0)
            if win is None:
                if not launched:
                    subprocess.Popen([_lc_exe()])
                    launched = True
                win = _find_window(stop, 15.0)
            if win is None:
                logger.warning("Live Captions window not ready; retrying (is it turned on? Win+Ctrl+L)")
                stop.wait(1.0)
                continue
            hwnd = win.NativeWindowHandle
            ex_orig = _hide_bar(hwnd)
            logger.info("reading Live Captions (hwnd=%s)", hwnd)
            try:
                while not stop.is_set():
                    if not _user32.IsWindow(hwnd):
                        logger.warning("Live Captions window gone; re-acquiring")
                        break
                    tb = _find_by_aid(win, CAPTION_AID)
                    if tb is not None:
                        try:
                            name = tb.Name
                        except Exception:
                            name = None
                        if name:
                            sync.update(name)
                    stop.wait(POLL_S)
            finally:
                _restore_bar(hwnd, ex_orig)
    except Exception:
        logger.exception("win_captions read loop error")
    finally:
        if launched:
            _kill_live_captions()
        comtypes.CoUninitialize()

@app.websocket("/captions")
async def captions_ws(ws: WebSocket):
    if not _reader_lock.acquire(blocking=False):
        await ws.accept()
        await ws.close(code=1013)
        return
    await ws.accept()
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()
    stop = threading.Event()

    def on_frame(text, line, final, hard=False):
        frame = {"lines": [{"text": text, "speaker": 0}], "line_count": line, "final": final, "hard": hard}
        loop.call_soon_threadsafe(q.put_nowait, frame)

    reader = threading.Thread(target=_read_loop, args=(on_frame, stop), daemon=True)
    reader.start()
    try:
        await ws.send_text(json.dumps({"type": "ready"}))

        async def pump():
            while True:
                await ws.send_text(json.dumps(await q.get()))

        recv = asyncio.create_task(ws.receive_text())
        send = asyncio.create_task(pump())
        await asyncio.wait({recv, send}, return_when=asyncio.FIRST_COMPLETED)
        for t in (recv, send):
            if not t.done():
                t.cancel()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("win_captions ws error")
    finally:
        stop.set()
        await asyncio.to_thread(reader.join, 3)
        _reader_lock.release()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--language", default="")
    parser.add_argument("--model", default="default")
    parser.add_argument("--models-dir", default="")
    args = parser.parse_args()
    logger.info("win_captions Live Captions source on 127.0.0.1:%d", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")

if __name__ == "__main__":
    main()
