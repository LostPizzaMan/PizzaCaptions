import asyncio
import json
import logging
import os
import sys

import websockets
from fastapi import APIRouter, Body, HTTPException

import translate as _translate_module
from engine_base import ENGINES_DIR, EngineManager

logger = logging.getLogger(__name__)

def _live_captions_exe() -> "str | None":
    if sys.platform != "win32":
        return None
    windir = os.environ.get("SystemRoot") or os.environ.get("windir") or r"C:\Windows"
    for sub in ("System32", "Sysnative"):
        p = os.path.join(windir, sub, "LiveCaptions.exe")
        if os.path.exists(p):
            return p
    return None

def _os_supports_live_captions() -> bool:
    return _live_captions_exe() is not None

_mgr = EngineManager(ENGINES_DIR)
_reader: "asyncio.Task | None" = None
_source = "current"
_start_lock = asyncio.Lock()

_MAX_INFLIGHT = 4
_RETRY_MAX_DELAY = 15.0
_inflight: list = []
_seq = 0
_shown: dict = {}
_last_queued = ""

_broadcast = None
_captions_clients: "set | None" = None
_control_clients: "set | None" = None
_target_language = lambda: "en-US"
_backend = lambda: None
_to_transcript = lambda: False
_on_source_change = lambda: None

def configure(*, broadcast, captions_clients, target_language, backend=None,
              control_clients=None, to_transcript=None, on_source_change=None):
    global _broadcast, _captions_clients, _target_language, _backend, _control_clients, _to_transcript
    global _on_source_change
    _broadcast = broadcast
    _captions_clients = captions_clients
    _target_language = target_language
    if backend is not None:
        _backend = backend
    if control_clients is not None:
        _control_clients = control_clients
    if to_transcript is not None:
        _to_transcript = to_transcript
    if on_source_change is not None:
        _on_source_change = on_source_change

async def _push_notice(msg: str) -> None:
    if _control_clients is None:
        return
    try:
        await _broadcast(json.dumps({"type": "toast", "kind": "warn", "msg": msg}), (_control_clients,))
    except Exception as e:
        logger.debug("win_captions notice failed: %s", e)

def _targets() -> tuple:
    if _to_transcript() and _control_clients is not None:
        return (_captions_clients, _control_clients)
    return (_captions_clients,)

def caption_source() -> str:
    return _source

async def _translate_and_push(text: str, line: int, seq: int):
    global _shown
    try:
        result = await _translate_module.translate_async(text, None, _target_language(), _backend())
        translated = ((result.get("translated") if isinstance(result, dict) else "") or "").strip()
        if seq > _shown.get(line, -1):
            _shown[line] = seq
            if translated and _captions_clients:
                await _broadcast(
                    json.dumps({"type": "translation", "source": text, "text": translated, "line": line}),
                    _targets())
            for s, ln, t in _inflight:
                if ln == line and s < seq and not t.done():
                    t.cancel()
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.warning("win_captions translate failed: %s", e)
    finally:
        _inflight[:] = [(s, ln, t) for (s, ln, t) in _inflight if s != seq]

def _queue_translation(text: str, line: int):
    global _seq, _last_queued
    if text == _last_queued:
        return
    _last_queued = text
    while len(_inflight) >= _MAX_INFLIGHT:
        _s, _ln, _t = _inflight.pop(0)
        _t.cancel()
    if len(_shown) > 100:
        for k in [k for k in _shown if k < line - 50]:
            del _shown[k]
    _seq += 1
    task = asyncio.create_task(_translate_and_push(text, line, _seq))
    _inflight.append((_seq, line, task))

async def _read_loop(port: int):
    url = f"ws://127.0.0.1:{port}/captions"
    delay = 1.0
    fails = 0
    warned = False
    try:
        while True:
            try:
                async with websockets.connect(url, max_size=None) as ws:
                    delay, fails, warned = 1.0, 0, False
                    async for message in ws:
                        if isinstance(message, bytes):
                            continue
                        try:
                            obj = json.loads(message)
                        except (ValueError, TypeError):
                            continue
                        if not isinstance(obj, dict) or obj.get("type"):
                            continue
                        obj["stream"] = "win_captions"
                        await _broadcast(json.dumps(obj), _targets())
                        lines = obj.get("lines") or []
                        text = ((lines[-1].get("text") if lines else "") or "").strip()
                        if not text:
                            continue
                        _queue_translation(text, obj.get("line_count", 0))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                fails += 1
                if not _mgr.running():
                    try:
                        await asyncio.to_thread(_mgr.ensure, "win_captions", "multi", "default")
                        url = f"ws://127.0.0.1:{_mgr.port}/captions"
                        logger.info("win_captions pack died; respawned on port %s", _mgr.port)
                        delay = 1.0
                    except Exception as e2:
                        logger.warning("win_captions pack respawn failed: %s", e2)
                        if not warned:
                            warned = True
                            await _push_notice("Windows 11 Live Captions stopped and could not be "
                                               "restarted. Check Live Captions is running, or pick "
                                               "the caption source again.")
                (logger.warning if fails <= 3 else logger.debug)(
                    "win_captions reader disconnected: %s", e)
                await asyncio.sleep(delay)
                delay = min(delay * 2, _RETRY_MAX_DELAY)
    except asyncio.CancelledError:
        pass

async def _stop():
    global _reader, _inflight, _seq, _shown, _last_queued
    for _s, _ln, _t in _inflight:
        _t.cancel()
    _inflight.clear()
    _seq = 0
    _shown = {}
    _last_queued = ""
    if _reader is not None:
        _reader.cancel()
        try:
            await _reader
        except asyncio.CancelledError:
            pass
        _reader = None
    await asyncio.to_thread(_mgr.stop)

async def on_shutdown():
    global _source
    await _stop()
    _source = "current"

async def on_engine_removed(engine_id: str):
    global _source
    if engine_id == "win_captions":
        await _stop()
        _source = "current"

router = APIRouter()

@router.post("/captions/overlay/source")
async def set_source(payload: dict = Body(...)):
    async with _start_lock:
        return await _set_source(payload)

async def _set_source(payload: dict):
    global _source, _reader
    source = (payload.get("source") or "current").strip()
    if source not in ("current", "win_captions"):
        raise HTTPException(status_code=400, detail=f"Unknown caption source: {source}")
    if source == _source and (source != "win_captions" or _reader is not None):
        return {"ok": True, "source": _source}
    await _stop()
    if source == "win_captions":
        if not _os_supports_live_captions():
            raise HTTPException(status_code=409,
                                detail="Windows 11 Live Captions is not available on this PC (needs Windows 11 22H2 or newer)")
        _mgr.refresh()
        if not _mgr.available("win_captions"):
            raise HTTPException(status_code=409,
                                detail="Windows 11 Live Captions pack is not installed")
        try:
            await asyncio.to_thread(_mgr.ensure, "win_captions", "multi", "default")
        except Exception as e:
            logger.error("win_captions source start failed: %s", e)
            raise HTTPException(status_code=500,
                                detail=f"Live Captions source failed to start: {e}")
        _reader = asyncio.create_task(_read_loop(_mgr.port))
    _source = source
    try:
        _on_source_change()
    except Exception as e:
        logger.warning("win_captions source-change hook failed: %s", e)
    return {"ok": True, "source": _source}

@router.get("/captions/source/status")
def status():
    _mgr.refresh()
    m = _mgr.manifests.get("win_captions")
    return {
        "source": _source,
        "win_captions_present": (ENGINES_DIR / "win_captions" / "engine.json").is_file(),
        "win_captions_supported": _os_supports_live_captions(),
        "win_captions_installed": bool(m and m.get("_available")),
        "win_captions_running": _mgr.running(),
    }
