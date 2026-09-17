import logging
import shutil
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

import engine_install

logger = logging.getLogger(__name__)

_catalog = None
_model_for = lambda engine_id: "default"
_get_stt_language = lambda: "en"
_slots: dict = {}
_get_spawning = lambda: []

def configure(*, catalog, model_for, get_stt_language, slots, get_spawning):
    global _catalog, _model_for, _get_stt_language, _slots, _get_spawning
    _catalog = catalog
    _model_for = model_for
    _get_stt_language = get_stt_language
    _slots = slots
    _get_spawning = get_spawning

_WHISPER_DL_EST = {
    "tiny": "75 MB", "base": "145 MB", "small": "500 MB",
    "medium": "1.5 GB", "large-v3-turbo": "1.6 GB", "large-v3": "3 GB",
}
_PARAKEET_STORAGE = {
    "parakeet-tdt-0.6b-v3-int8": {"label": "European languages (25)", "est": "650 MB"},
    "parakeet-ja": {"label": "Japanese", "est": "620 MB"},
}

router = APIRouter()

def _path_size(p: Path) -> int:
    if p.is_file():
        return p.stat().st_size
    if p.is_dir():
        return sum(f.stat().st_size for f in p.rglob("*")
                   if f.is_file() and not f.is_symlink())
    return 0

def _whisper_artifacts(model: str) -> list[Path]:
    root = engine_install.MODELS_DIR / "whisper"
    artifacts = []
    flat = root / model
    if flat.is_dir():
        artifacts.append(flat)
    pt = root / "pt" / f"{model}.pt"
    if pt.exists():
        artifacts.append(pt)
    hf = root / "hf"
    if hf.exists():
        for d in hf.glob("models--*"):
            name = d.name.lower()
            if "distil" in name and "distil" not in model:
                continue
            if name.endswith(f"-{model}"):
                artifacts.append(d)
    return artifacts

def _whisper_decoder_present(model: str) -> bool:
    root = engine_install.MODELS_DIR / "whisper"
    return (root / model / f"{model}.pt").exists() or (root / "pt" / f"{model}.pt").exists()

def _whisper_installed(model: str, engine: str = "whisper-batch") -> bool:
    if engine == "whisper" and not _whisper_decoder_present(model):
        return False
    root = engine_install.MODELS_DIR / "whisper"
    if (root / model / "model.bin").exists():
        return True
    hf = root / "hf"
    if hf.is_dir():
        for d in hf.glob("models--*"):
            name = d.name.lower()
            if "distil" in name and "distil" not in model:
                continue
            if name.endswith(f"-{model}"):
                if any(d.rglob("*.incomplete")):
                    continue
                if any((s / "model.bin").exists() for s in (d / "snapshots").glob("*")):
                    return True
    return False

def _parakeet_active_model() -> str:
    return "parakeet-ja" if _get_stt_language() == "ja" else "parakeet-tdt-0.6b-v3-int8"

def _engine_holds_model(engine: str, model: str, rid: str, rmodel: str, rlang) -> bool:
    if engine in ("whisper", "whisper-batch") and rid in ("whisper", "whisper-batch"):
        return rmodel == model
    if engine == "parakeet" and rid in ("parakeet", "parakeet-stream"):
        lang = rlang if (rlang and rlang != "auto") else _get_stt_language()
        slot_model = "parakeet-ja" if lang == "ja" else "parakeet-tdt-0.6b-v3-int8"
        return slot_model == model
    return False

def _model_held_by_slot(engine: str, model: str) -> bool:
    for s in _slots.values():
        if not s.thread.is_alive() and not s.mgr.running():
            continue
        if _engine_holds_model(engine, model, s.mgr.engine_id, s.mgr.model, s.language):
            return True
    for rid, rmodel, rlang in _get_spawning():
        if _engine_holds_model(engine, model, rid, rmodel, rlang):
            return True
    return False

@router.get("/models")
def list_models(engine: str):
    items = []
    if engine == "parakeet-stream":
        engine = "parakeet"
    if engine in ("whisper", "whisper-batch"):
        manifest = _catalog.manifests.get(engine, {})
        active = _model_for(engine)
        for m in manifest.get("models", []):
            size = sum(_path_size(a) for a in _whisper_artifacts(m))
            items.append({
                "id": m, "label": m, "installed": _whisper_installed(m, engine),
                "size_bytes": size,
                "est_download": _WHISPER_DL_EST.get(m, "?"),
                "can_download": True,
                "active": m == active,
            })
    elif engine == "parakeet":
        root = engine_install.MODELS_DIR / "parakeet"
        active = _parakeet_active_model()
        for mid, spec in _PARAKEET_STORAGE.items():
            size = _path_size(root / mid)
            items.append({
                "id": mid, "label": spec["label"], "installed": size > 0,
                "size_bytes": size, "est_download": spec["est"],
                "can_download": True, "active": mid == active,
            })
    elif engine == "nano":
        root = engine_install.MODELS_DIR / "nano"
        size = sum(_path_size(root / n) for n in
                   ("funasr-encoder-f16.gguf", "qwen3-0.6b-q8_0.gguf"))
        items.append({
            "id": "default", "label": "Fun-ASR-Nano (Q8)", "installed": size > 0,
            "size_bytes": size, "est_download": "1.3 GB",
            "can_download": False, "active": True,
        })
    elif engine == "nemotron-stream":
        root = engine_install.MODELS_DIR / "nemotron"
        size = _path_size(root / "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf")
        items.append({
            "id": "default", "label": "Nemotron 3.5 ASR Streaming (Q8)", "installed": size > 0,
            "size_bytes": size, "est_download": "742 MB",
            "can_download": False, "active": True,
        })
    else:
        raise HTTPException(status_code=404, detail=f"Unknown engine: {engine}")
    total = sum(i["size_bytes"] for i in items)
    engine_install.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(engine_install.MODELS_DIR).free
    return {"engine": engine, "models": items, "total_bytes": total, "disk_free_bytes": free}

@router.post("/models/download")
async def model_download(payload: dict = Body(...)):
    engine, model = payload.get("engine"), payload.get("model")
    if engine == "parakeet-stream":
        engine = "parakeet"
    if engine in ("whisper", "whisper-batch"):
        py = manifest = None
        for eid in (engine, "whisper-batch" if engine == "whisper" else "whisper"):
            m = _catalog.manifests.get(eid)
            if m and m.get("_available"):
                manifest, py = m, (m["_dir"] / m["python"]).resolve()
                break
        if manifest is None:
            raise HTTPException(status_code=409, detail="Install a Whisper engine first")
        if model not in manifest.get("models", []):
            raise HTTPException(status_code=404, detail=f"Unknown model: {model}")
        want_decoder = (engine == "whisper" and manifest["id"] == "whisper")
        if not engine_install.start_whisper_model_download(py, model, want_decoder):
            raise HTTPException(status_code=409, detail="Another download/install is already running")
        return {"ok": True}
    if engine != "parakeet" or model not in engine_install.PARAKEET_MODEL_ARCHIVES:
        raise HTTPException(status_code=400, detail="Unknown engine/model for download")
    if not engine_install.start_model_download(model):
        raise HTTPException(status_code=409, detail="Another download/install is already running")
    return {"ok": True}

@router.post("/models/download/cancel")
async def model_download_cancel():
    engine_install.cancel_job()
    return {"ok": True}

@router.post("/models/delete")
async def model_delete(payload: dict = Body(...)):
    engine, model = payload.get("engine"), payload.get("model")
    if engine == "parakeet-stream":
        engine = "parakeet"
    if _model_held_by_slot(engine, str(model)):
        raise HTTPException(status_code=409, detail="Model is in use. Stop capture first, then delete it.")
    if engine in ("whisper", "whisper-batch"):
        manifest = _catalog.manifests.get(engine, {})
        if model not in manifest.get("models", []):
            raise HTTPException(status_code=404, detail=f"Unknown model: {model}")
        targets = _whisper_artifacts(str(model))
    elif engine == "parakeet":
        if model not in _PARAKEET_STORAGE:
            raise HTTPException(status_code=404, detail=f"Unknown model: {model}")
        d = engine_install.MODELS_DIR / "parakeet" / str(model)
        targets = [d] if d.exists() else []
    else:
        raise HTTPException(status_code=404, detail=f"Unknown engine: {engine}")
    freed = 0
    for t in targets:
        freed += _path_size(t)
        if t.is_dir():
            shutil.rmtree(t)
        else:
            t.unlink()
    logger.info("Deleted model %s/%s (freed %.0f MB)", engine, model, freed / 1e6)
    return {"ok": True, "freed_bytes": freed}
