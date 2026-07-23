import argparse
import asyncio
import json
import logging
import os
import queue
import threading
import time
from pathlib import Path

import numpy as np
import sherpa_onnx
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("parakeet-engine")

SAMPLE_RATE = 16000

_TDT = "parakeet-tdt-0.6b-v3-int8"
LANG_TO_MODEL = {lang: _TDT for lang in [
    "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu",
    "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
]}
LANG_TO_MODEL["ja"] = "parakeet-ja"

MODELS = {
    _TDT: {
        "type":    "transducer",
        "encoder": "encoder.int8.onnx",
        "decoder": "decoder.int8.onnx",
        "joiner":  "joiner.int8.onnx",
        "tokens":  "tokens.txt",
    },
    "parakeet-ja": {
        "type":   "ctc",
        "model":  "model.int8.onnx",
        "tokens": "tokens.txt",
    },
}

VAD_THRESHOLD = float(os.environ.get("VAD_THRESHOLD", "0.5"))
VAD_MIN_SILENCE_S = float(os.environ.get("VAD_MIN_SILENCE_S", "0.7"))
VAD_MIN_SPEECH_S = float(os.environ.get("VAD_MIN_SPEECH_S", "0.25"))
VAD_MAX_SPEECH_S = float(os.environ.get("VAD_MAX_SPEECH_S", "20.0"))
VAD_BUFFER_S = 60.0
VAD_WINDOW = 512

DECODING_METHOD = os.environ.get("PARAKEET_DECODING", "modified_beam_search")

FLUSH_PEAK = 3 / 32768
FLUSH_HOLD = 0.2

_models_dir: Path | None = None
_recognizer: sherpa_onnx.OfflineRecognizer | None = None
_session_lock = asyncio.Lock()


def _load_recognizer(lang: str):
    global _recognizer
    model_name = LANG_TO_MODEL.get(lang)
    if model_name is None:
        raise ValueError(f"No model configured for language: {lang}")
    cfg = MODELS[model_name]
    model_dir = _models_dir / model_name
    threads = max(1, (os.cpu_count() or 2) // 2)

    if cfg["type"] == "transducer":
        encoder = model_dir / cfg["encoder"]
        if not encoder.exists():
            raise FileNotFoundError(f"Model not found at {model_dir}")
        logger.info("Loading parakeet transducer (%s, %s) from %s", lang, DECODING_METHOD, model_dir)
        _recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(encoder),
            decoder=str(model_dir / cfg["decoder"]),
            joiner=str(model_dir / cfg["joiner"]),
            tokens=str(model_dir / cfg["tokens"]),
            num_threads=threads,
            decoding_method=DECODING_METHOD,
            model_type="nemo_transducer",
        )
    else:
        model = model_dir / cfg["model"]
        if not model.exists():
            raise FileNotFoundError(f"Model not found at {model_dir}")
        logger.info("Loading parakeet CTC (%s) from %s", lang, model_dir)
        _recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
            model=str(model),
            tokens=str(model_dir / cfg["tokens"]),
            num_threads=threads,
        )
    logger.info("Parakeet model loaded (lang=%s)", lang)


def _transcribe(samples_f32: np.ndarray) -> str:
    if len(samples_f32) < SAMPLE_RATE * 0.05:
        return ""
    stream = _recognizer.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples_f32)
    _recognizer.decode_stream(stream)
    return stream.result.text.strip()


def _build_vad() -> sherpa_onnx.VoiceActivityDetector:
    vad_path = _models_dir / "silero_vad.onnx"
    if not vad_path.exists():
        raise FileNotFoundError(f"Silero VAD model not found at {vad_path}")
    vad_config = sherpa_onnx.VadModelConfig()
    vad_config.silero_vad.model = str(vad_path)
    vad_config.silero_vad.threshold = VAD_THRESHOLD
    vad_config.silero_vad.min_silence_duration = VAD_MIN_SILENCE_S
    vad_config.silero_vad.min_speech_duration = VAD_MIN_SPEECH_S
    vad_config.silero_vad.window_size = VAD_WINDOW
    vad_config.silero_vad.max_speech_duration = VAD_MAX_SPEECH_S
    vad_config.sample_rate = SAMPLE_RATE
    return sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=VAD_BUFFER_S)


app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok", "engine": "parakeet"}


@app.websocket("/asr")
async def asr(ws: WebSocket):
    await ws.accept()
    if _session_lock.locked():
        await ws.close(code=1013, reason="engine busy: one session at a time")
        return
    async with _session_lock:
        loop = asyncio.get_running_loop()
        result_queue: asyncio.Queue = asyncio.Queue()
        segment_queue: queue.Queue = queue.Queue()

        def inference_worker():
            line_count = 0
            while True:
                samples = segment_queue.get()
                if samples is None:
                    break
                duration = len(samples) / SAMPLE_RATE
                t0 = time.perf_counter()
                text = _transcribe(samples)
                elapsed = time.perf_counter() - t0
                if not text:
                    continue
                logger.info("Inference: %.2fs for %.2fs audio: %s", elapsed, duration, text)
                line_count += 1
                msg = {"lines": [{"text": text, "speaker": 0}], "line_count": line_count}
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

        vad = _build_vad()
        vad_buffer = np.empty(0, dtype=np.float32)
        silence_since = None
        flushed = False

        def pop_segments():
            while not vad.empty():
                samples = np.array(vad.front.samples)
                vad.pop()
                segment_queue.put(samples)

        await ws.send_text(json.dumps({"type": "ready"}))
        logger.info("Session started")
        try:
            while True:
                data = await ws.receive_bytes()
                pcm = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0

                peak = float(np.max(np.abs(pcm))) if len(pcm) else 0.0
                now = time.monotonic()
                if peak < FLUSH_PEAK:
                    if not flushed:
                        if silence_since is None:
                            silence_since = now
                        elif now - silence_since >= FLUSH_HOLD:
                            vad.flush()
                            pop_segments()
                            vad = _build_vad()
                            vad_buffer = np.empty(0, dtype=np.float32)
                            silence_since = None
                            flushed = True
                else:
                    silence_since = None
                    flushed = False

                vad_buffer = np.concatenate([vad_buffer, pcm])
                while len(vad_buffer) >= VAD_WINDOW:
                    vad.accept_waveform(vad_buffer[:VAD_WINDOW])
                    vad_buffer = vad_buffer[VAD_WINDOW:]
                pop_segments()
        except WebSocketDisconnect:
            logger.info("Session closed by client")
        except Exception as e:
            logger.error("Session error: %s", e)
        finally:
            try:
                while len(vad_buffer) >= VAD_WINDOW:
                    vad.accept_waveform(vad_buffer[:VAD_WINDOW])
                    vad_buffer = vad_buffer[VAD_WINDOW:]
                vad.flush()
                pop_segments()
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
    global _models_dir
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--language", default="en")
    parser.add_argument("--model", default="default")
    parser.add_argument("--models-dir", required=True)
    args = parser.parse_args()

    _models_dir = Path(args.models_dir)
    _load_recognizer(args.language)
    logger.info("Listening on 127.0.0.1:%d", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
