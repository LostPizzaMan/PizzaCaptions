import argparse
import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("whisper-engine")

_UTF8_RUN_LIMIT = 20
_UTF8_RUN_GAP = 1.0

class _RecoveryWatcher(logging.Handler):
    target = None

    def __init__(self):
        super().__init__()
        self._utf8_count = 0
        self._utf8_last = 0.0
        self._reason = None

    def arm(self, loop, event):
        _RecoveryWatcher.target = {"loop": loop, "event": event}
        self._utf8_count = 0
        self._reason = None

    def disarm(self):
        _RecoveryWatcher.target = None
        self._utf8_count = 0
        self._reason = None

    def pop_reason(self):
        r = self._reason or "decoder stall"
        self._reason = None
        return r

    def _fire(self, reason):
        self._reason = reason
        t = _RecoveryWatcher.target
        if not t:
            return
        try:
            t["loop"].call_soon_threadsafe(t["event"].set)
        except Exception:
            pass

    def emit(self, record):
        if not _RecoveryWatcher.target:
            return
        try:
            msg = record.getMessage()
        except Exception:
            return

        if "SimulStreaming processing error" in msg:
            self._utf8_count = 0
            self._fire("SimulStreaming state corruption")
            return

        if msg.startswith("Output:"):
            out = msg[len("Output:"):]
            if out.strip("� \t\r\n"):
                self._utf8_count = 0
            return

        if "[UTF-8 Filter] Skipping" in msg:
            now = time.monotonic()
            if now - self._utf8_last > _UTF8_RUN_GAP:
                self._utf8_count = 0
            self._utf8_last = now
            self._utf8_count += 1
            if self._utf8_count >= _UTF8_RUN_LIMIT:
                self._utf8_count = 0
                self._fire("UTF-8 replacement-char loop (%d skips)" % _UTF8_RUN_LIMIT)

_recovery_watcher = _RecoveryWatcher()
logging.getLogger().addHandler(_recovery_watcher)

_model_cache_dir: str | None = None
_whisper_dir: "Path | None" = None

def _setup_models_dir(models_dir: str):
    global _model_cache_dir, _whisper_dir
    md = Path(models_dir)
    _whisper_dir = md
    hf, pt = md / "hf", md / "pt"
    hf.mkdir(parents=True, exist_ok=True)
    pt.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HUB_CACHE"] = str(hf)
    _model_cache_dir = str(pt)

def _make_config(language: str, model: str, model_dir: str | None = None):
    import torch
    if not torch.cuda.is_available():
        os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
    from whisperlivekit import parse_args
    old_argv = sys.argv
    sys.argv = [
        "wlk",
        "--model", model,
        "--language", language,
        "--backend", "faster-whisper",
        "--pcm-input",
    ]
    if model_dir:
        sys.argv += ["--model_dir", model_dir]
    if _model_cache_dir:
        sys.argv += ["--model_cache_dir", _model_cache_dir]
    try:
        return parse_args()
    finally:
        sys.argv = old_argv

_engine = None
_session_lock = asyncio.Lock()

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok", "engine": "whisper"}

@app.websocket("/asr")
async def asr(ws: WebSocket):
    await ws.accept()
    if _session_lock.locked():
        await ws.close(code=1013, reason="engine busy: one session at a time")
        return
    async with _session_lock:
        from whisperlivekit import AudioProcessor
        loop = asyncio.get_running_loop()
        fatal = asyncio.Event()
        _recovery_watcher.arm(loop, fatal)

        audio_processor = AudioProcessor(transcription_engine=_engine)
        results_generator = await audio_processor.create_tasks()

        async def send_results(gen):
            async for response in gen:
                await ws.send_text(json.dumps(response.to_dict()))

        await ws.send_text(json.dumps({"type": "ready"}))
        sender = asyncio.create_task(send_results(results_generator))
        logger.info("Session started")

        async def _rebuild():
            nonlocal audio_processor, results_generator, sender
            sender.cancel()
            try:
                await sender
            except (asyncio.CancelledError, Exception):
                pass
            try:
                await audio_processor.cleanup()
            except Exception as e:
                logger.warning("Recovery cleanup error: %s", e)
            fatal.clear()
            _recovery_watcher.arm(loop, fatal)
            audio_processor = AudioProcessor(transcription_engine=_engine)
            results_generator = await audio_processor.create_tasks()
            sender = asyncio.create_task(send_results(results_generator))

        recoveries = 0
        try:
            while True:
                recv = asyncio.create_task(ws.receive_bytes())
                fwait = asyncio.create_task(fatal.wait())
                await asyncio.wait({recv, fwait}, return_when=asyncio.FIRST_COMPLETED)

                if fatal.is_set():
                    recv.cancel()
                    try:
                        await recv
                    except (asyncio.CancelledError, Exception):
                        pass
                    recoveries += 1
                    logger.warning(
                        "Self-recovery #%d: %s; rebuilding AudioProcessor",
                        recoveries, _recovery_watcher.pop_reason())
                    await _rebuild()
                    logger.info("Self-recovery #%d: AudioProcessor rebuilt; resuming", recoveries)
                    continue

                fwait.cancel()
                try:
                    await fwait
                except (asyncio.CancelledError, Exception):
                    pass
                data = recv.result()
                await audio_processor.process_audio(data)
        except WebSocketDisconnect:
            logger.info("Session closed by client")
        except Exception as e:
            logger.error("Session error: %s", e)
        finally:
            _recovery_watcher.disarm()
            try:
                await audio_processor.cleanup()
            except Exception as e:
                logger.warning("Cleanup error: %s", e)
            sender.cancel()
            try:
                await sender
            except (asyncio.CancelledError, Exception):
                pass
            logger.info("Session ended")

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
    hf = (_whisper_dir / "hf") if _whisper_dir else None
    if not hf or not hf.is_dir():
        return False
    for d in hf.glob("models--*"):
        name = d.name.lower()
        if "distil" in name and "distil" not in model:
            continue
        if name.endswith("-" + model) and any((s / "model.bin").exists() for s in (d / "snapshots").glob("*")):
            return True
    return False

def _resolve_model_dir(model: str) -> str | None:
    if _whisper_dir is None:
        return None
    flat = _whisper_dir / model
    if (flat / "model.bin").exists():
        return str(flat)
    if _legacy_hf_present(model):
        return None
    _predownload(model, flat)
    return str(flat) if (flat / "model.bin").exists() else None

def main():
    global _engine
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--language", default="ja")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--models-dir", default=None)
    args = parser.parse_args()

    if args.models_dir:
        _setup_models_dir(args.models_dir)

    model_dir = _resolve_model_dir(args.model)
    from whisperlivekit import TranscriptionEngine
    logger.info("Loading Whisper model=%s language=%s dir=%s ...", args.model, args.language, model_dir or "(hf cache)")
    _engine = TranscriptionEngine(config=_make_config(args.language, args.model, model_dir))
    logger.info("Model loaded, listening on 127.0.0.1:%d", args.port)

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")

if __name__ == "__main__":
    main()
