import asyncio
import json
import logging
import threading
import time
from urllib import request as urllib_request

from fastapi import APIRouter, HTTPException, Request

from engine_base import ENGINES_DIR, EngineManager

logger = logging.getLogger(__name__)


class OcrManager(EngineManager):


    def recognize(self, image: bytes) -> list[dict]:

        with self.lock:
            port = self.port
        if port is None:
            raise RuntimeError("OCR engine not running")
        req = urllib_request.Request(
            f"http://127.0.0.1:{port}/ocr", data=image,
            headers={"Content-Type": "application/octet-stream"}, method="POST")
        with urllib_request.urlopen(req, timeout=120) as r:
            return json.loads(r.read()).get("lines", [])

    def capture(self) -> dict:

        with self.lock:
            port = self.port
        if port is None:
            raise RuntimeError("OCR engine not running")
        with urllib_request.urlopen(f"http://127.0.0.1:{port}/capture", timeout=30) as r:
            return json.loads(r.read())


_ocr_mgr = OcrManager(ENGINES_DIR)


def on_shutdown():
    _ocr_mgr.stop()


def on_engine_removed(engine_id):
    if engine_id == "ocr":
        _ocr_mgr.stop()


router = APIRouter()



def _ocr_manifest() -> dict | None:
    _ocr_mgr.refresh()
    return _ocr_mgr.manifests.get("ocr")


def _ocr_params(m: dict) -> tuple[str, str, str]:

    return m["id"], (m.get("languages") or ["multi"])[0], m.get("default_model", "medium")


@router.get("/ocr/status")
def ocr_status():
    m = _ocr_manifest()
    return {
        "installed": bool(m and m.get("_available")),
        "running": _ocr_mgr.running(),
        "engine": _ocr_mgr.engine_id if _ocr_mgr.running() else None,
        "model": _ocr_mgr.model,
        "phase": _ocr_mgr.startup_phase,
        "detail": _ocr_mgr.startup_detail,
    }


@router.post("/ocr/start")
def ocr_start():

    m = _ocr_manifest()
    if not (m and m.get("_available")):
        raise HTTPException(status_code=409, detail="OCR engine not installed")
    engine_id, lang, tier = _ocr_params(m)
    if _ocr_mgr.running() and _ocr_mgr.engine_id == engine_id:
        return {"ok": True, "running": True}

    def _go():
        try:
            _ocr_mgr.ensure(engine_id, lang, tier)
        except Exception as e:
            logger.error("OCR engine start failed: %s", e)

    threading.Thread(target=_go, daemon=True, name="ocr-start").start()
    return {"ok": True, "running": False}


@router.post("/ocr/stop")
def ocr_stop():
    _ocr_mgr.stop()
    return {"ok": True}


@router.get("/ocr/capture")
async def ocr_capture():

    m = _ocr_manifest()
    if not (m and m.get("_available")):
        raise HTTPException(status_code=409, detail="OCR engine not installed")
    engine_id, lang, tier = _ocr_params(m)
    try:
        await asyncio.to_thread(_ocr_mgr.ensure, engine_id, lang, tier)
    except Exception as e:
        logger.error("OCR engine start failed: %s", e)
        raise HTTPException(status_code=500, detail=f"engine start failed: {e}")
    try:
        return await asyncio.to_thread(_ocr_mgr.capture)
    except Exception as e:
        logger.error("OCR capture failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/ocr/recognize")
async def ocr_recognize(request: Request):

    m = _ocr_manifest()
    if not (m and m.get("_available")):
        raise HTTPException(status_code=409, detail="OCR engine not installed")
    image = await request.body()
    if not image:
        raise HTTPException(status_code=400, detail="no image")
    engine_id, lang, tier = _ocr_params(m)
    try:
        await asyncio.to_thread(_ocr_mgr.ensure, engine_id, lang, tier)
    except Exception as e:
        logger.error("OCR engine start failed: %s", e)
        raise HTTPException(status_code=500, detail=f"engine start failed: {e}")
    try:
        t0 = time.perf_counter()
        lines = await asyncio.to_thread(_ocr_mgr.recognize, image)
        ocr_ms = round((time.perf_counter() - t0) * 1000)
    except Exception as e:
        logger.error("OCR failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "lines": lines, "ocr_ms": ocr_ms}
