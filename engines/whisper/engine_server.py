import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("whisper-engine")

_model_cache_dir: str | None = None


def _setup_models_dir(models_dir: str):

    global _model_cache_dir
    md = Path(models_dir)
    hf, pt = md / "hf", md / "pt"
    hf.mkdir(parents=True, exist_ok=True)
    pt.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HUB_CACHE"] = str(hf)
    _model_cache_dir = str(pt)


def _make_config(language: str, model: str):
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
        audio_processor = AudioProcessor(transcription_engine=_engine)
        results_generator = await audio_processor.create_tasks()

        async def send_results():
            async for response in results_generator:
                await ws.send_text(json.dumps(response.to_dict()))

        await ws.send_text(json.dumps({"type": "ready"}))
        sender = asyncio.create_task(send_results())
        logger.info("Session started")
        try:
            while True:
                data = await ws.receive_bytes()
                await audio_processor.process_audio(data)
        except WebSocketDisconnect:
            logger.info("Session closed by client")
        except Exception as e:
            logger.error("Session error: %s", e)
        finally:
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

    from whisperlivekit import TranscriptionEngine
    logger.info("Loading Whisper model=%s language=%s ...", args.model, args.language)
    _engine = TranscriptionEngine(config=_make_config(args.language, args.model))
    logger.info("Model loaded, listening on 127.0.0.1:%d", args.port)

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
