import argparse
import asyncio
import json
import logging
import os
import queue
import sys
import threading
import time
from pathlib import Path

import numpy as np
import sherpa_onnx
from vad_segment import VadSegmenter
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("whisper-batch-engine")

SAMPLE_RATE = 16000

VAD_THRESHOLD = float(os.environ.get("VAD_THRESHOLD", "0.5"))
VAD_MIN_SILENCE_S = float(os.environ.get("VAD_MIN_SILENCE_S", "0.7"))
VAD_MIN_SPEECH_S = float(os.environ.get("VAD_MIN_SPEECH_S", "0.25"))
VAD_MAX_SPEECH_S = float(os.environ.get("VAD_MAX_SPEECH_S", "20.0"))
VAD_BUFFER_S = 60.0
VAD_PREROLL_MS = float(os.environ.get("VAD_PREROLL_MS", "500"))
VAD_WINDOW = 512

BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "")

FLUSH_PEAK = 3 / 32768
FLUSH_HOLD = 0.2

_MAX_SESSIONS = 2
_NUM_WORKERS = int(os.environ.get("WHISPER_NUM_WORKERS", "2"))

_models_dir: Path | None = None
_model = None
_default_language: str | None = None
_session_sem = asyncio.Semaphore(_MAX_SESSIONS)

def _norm_lang(lang):
    return None if lang in (None, "", "auto") else lang

def _setup_models_dir(models_dir: str):
    global _models_dir
    _models_dir = Path(models_dir).parent / "whisper"
    (_models_dir / "hf").mkdir(parents=True, exist_ok=True)
    os.environ["HF_HUB_CACHE"] = str(_models_dir / "hf")
    logger.info("Using shared whisper model dir: %s", _models_dir)

def _ensure_cuda_libs():
    if sys.platform != "win32":
        return
    import importlib.util
    import glob
    dirs = []
    spec = importlib.util.find_spec("torch")
    if spec and spec.submodule_search_locations:
        dirs.append(os.path.join(list(spec.submodule_search_locations)[0], "lib"))
    for probe in ("nvidia.cublas", "nvidia.cudnn"):
        try:
            s = importlib.util.find_spec(probe)
        except (ImportError, ValueError):
            s = None
        if s and s.submodule_search_locations:
            base = os.path.dirname(list(s.submodule_search_locations)[0])
            dirs.extend(glob.glob(os.path.join(base, "*", "bin")))
            break
    seen = set()
    for d in dirs:
        if d in seen or not os.path.isdir(d):
            continue
        seen.add(d)
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
        try:
            os.add_dll_directory(d)
        except OSError:
            pass

def _predownload(model: str, dest: Path):
    try:
        import huggingface_hub
        from faster_whisper.utils import _MODELS
        from tqdm.auto import tqdm as _tq
        repo = model if "/" in model else _MODELS.get(model)
        if not repo:
            return

        class _Bar(_tq):
            def __init__(self, *a, **k):
                k["disable"] = False
                super().__init__(*a, **k)

        huggingface_hub.snapshot_download(
            repo, local_dir=str(dest),
            allow_patterns=["config.json", "preprocessor_config.json", "model.bin",
                            "tokenizer.json", "vocabulary.*"],
            tqdm_class=_Bar)
    except Exception as e:
        logger.warning("model pre-download skipped (%s); loading directly", e)

def _legacy_hf_present(model: str) -> bool:
    hf = _models_dir / "hf"
    if not hf.is_dir():
        return False
    for d in hf.glob("models--*"):
        name = d.name.lower()
        if "distil" in name and "distil" not in model:
            continue
        if name.endswith("-" + model) and any((s / "model.bin").exists() for s in (d / "snapshots").glob("*")):
            return True
    return False

def _resolve_model(model: str) -> str:
    flat = _models_dir / model
    if (flat / "model.bin").exists():
        return str(flat)
    if _legacy_hf_present(model):
        return model
    _predownload(model, flat)
    return str(flat) if (flat / "model.bin").exists() else model

def _load_model(language: str, model: str):
    global _model, _default_language
    _default_language = _norm_lang(language)
    _ensure_cuda_libs()
    import ctranslate2
    from faster_whisper import WhisperModel

    target = _resolve_model(model)

    def _make(device, compute):
        logger.info("Loading faster-whisper model=%s from=%s device=%s compute=%s workers=%d ...",
                    model, target, device, compute, _NUM_WORKERS)
        return WhisperModel(target, device=device, compute_type=compute, num_workers=_NUM_WORKERS)

    if ctranslate2.get_cuda_device_count() > 0:
        try:
            m = _make("cuda", COMPUTE_TYPE or "float16")
            list(m.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), beam_size=1)[0])
            _model = m
            logger.info("Model loaded on GPU (default language=%s)", _default_language or "auto-detect")
            return
        except Exception as e:
            logger.warning("GPU unavailable (%s); falling back to CPU", e)
    _model = _make("cpu", COMPUTE_TYPE or "int8")
    logger.info("Model loaded on CPU (default language=%s)", _default_language or "auto-detect")

def _transcribe(samples_f32: np.ndarray, language: str | None) -> str:
    if len(samples_f32) < SAMPLE_RATE * 0.05:
        return ""
    segments, _info = _model.transcribe(
        samples_f32,
        language=language,
        beam_size=BEAM_SIZE,
        vad_filter=False,
        condition_on_previous_text=False,
    )
    return "".join(seg.text for seg in segments).strip()

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok", "engine": "whisper-batch"}

@app.websocket("/asr")
async def asr(ws: WebSocket):
    await ws.accept()
    if _session_sem.locked():
        await ws.close(code=1013, reason="engine busy: max sessions in use")
        return
    q = ws.query_params.get("language")
    session_language = _norm_lang(q) if q is not None else _default_language
    logger.info("Session language: %s", session_language or "auto-detect")
    async with _session_sem:
        loop = asyncio.get_running_loop()
        result_queue: asyncio.Queue = asyncio.Queue()
        segment_queue: queue.Queue = queue.Queue()

        def emit(msg):
            loop.call_soon_threadsafe(result_queue.put_nowait, msg)

        def inference_worker():
            line_count = 0
            while True:
                samples = segment_queue.get()
                if samples is None:
                    break
                emit({"type": "state", "state": "processing"})
                duration = len(samples) / SAMPLE_RATE
                t0 = time.perf_counter()
                text = _transcribe(samples, session_language)
                elapsed = time.perf_counter() - t0
                emit({"type": "state", "state": "listening"})
                if not text:
                    continue
                logger.info("Inference: %.2fs for %.2fs audio: %s", elapsed, duration, text)
                line_count += 1
                msg = {"lines": [{"text": text, "speaker": 0}],
                       "line_count": line_count, "final": True,
                       "decode_ms": round(elapsed * 1000)}
                loop.call_soon_threadsafe(result_queue.put_nowait, msg)

        inference_thread = threading.Thread(target=inference_worker, daemon=True)
        inference_thread.start()

        async def send_results():
            while True:
                msg = await result_queue.get()
                if msg is None:
                    break
                await ws.send_text(json.dumps(msg))

        sender = asyncio.create_task(send_results())

        seg = VadSegmenter(
            _models_dir / "silero_vad.onnx",
            sample_rate=SAMPLE_RATE, threshold=VAD_THRESHOLD,
            min_silence_s=VAD_MIN_SILENCE_S, min_speech_s=VAD_MIN_SPEECH_S,
            max_speech_s=VAD_MAX_SPEECH_S, window=VAD_WINDOW, buffer_s=VAD_BUFFER_S,
            preroll_ms=VAD_PREROLL_MS, flush_peak=FLUSH_PEAK, flush_hold_s=FLUSH_HOLD)

        await ws.send_text(json.dumps({"type": "ready"}))
        logger.info("Session started")
        try:
            while True:
                data = await ws.receive_bytes()
                pcm = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
                for utt in seg.feed(pcm):
                    segment_queue.put(utt)
        except WebSocketDisconnect:
            logger.info("Session closed by client")
        except Exception as e:
            logger.error("Session error: %s", e)
        finally:
            try:
                for utt in seg.drain():
                    segment_queue.put(utt)
            except Exception as e:
                logger.warning("VAD drain error: %s", e)
            segment_queue.put(None)
            await asyncio.to_thread(inference_thread.join, 10)
            result_queue.put_nowait(None)
            try:
                await sender
            except Exception:
                pass
            logger.info("Session ended")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--language", default="ja")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--models-dir", required=True)
    args = parser.parse_args()

    _setup_models_dir(args.models_dir)
    _load_model(args.language, args.model)
    logger.info("Listening on 127.0.0.1:%d", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")

if __name__ == "__main__":
    main()
