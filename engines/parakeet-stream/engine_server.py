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
logger = logging.getLogger("parakeet-stream-engine")

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
VAD_MIN_SILENCE_S = float(os.environ.get("VAD_MIN_SILENCE_S", "0.5"))
VAD_MIN_SPEECH_S = float(os.environ.get("VAD_MIN_SPEECH_S", "0.25"))
VAD_MAX_SPEECH_S = float(os.environ.get("VAD_MAX_SPEECH_S", "20.0"))
VAD_BUFFER_S = 60.0
VAD_WINDOW = 512

PREVIEW_STEP_S = float(os.environ.get("PARAKEET_STREAM_STEP_S", "0.30"))
POLL_S = 0.05

DECODING_METHOD = os.environ.get("PARAKEET_DECODING", "greedy_search")
NUM_THREADS = int(os.environ.get("PARAKEET_STREAM_THREADS", "1"))
DEBUG_TIMING = bool(os.environ.get("PARAKEET_STREAM_DEBUG"))
STABLE_PREVIEW = os.environ.get("PARAKEET_STREAM_RAW") is None

FLUSH_PEAK = 3 / 32768
FLUSH_HOLD = 0.2

_models_dir: Path | None = None
_recognizer: sherpa_onnx.OfflineRecognizer | None = None
_session_lock = asyncio.Lock()

_SENTINEL = object()


def _load_recognizer(lang: str):
    global _recognizer
    model_name = LANG_TO_MODEL.get(lang)
    if model_name is None:
        raise ValueError(f"No model configured for language: {lang}")
    cfg = MODELS[model_name]
    model_dir = _models_dir / model_name
    threads = NUM_THREADS

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
    logger.info("Parakeet streaming model loaded (lang=%s)", lang)


def _transcribe(samples_f32: np.ndarray) -> str:
    if len(samples_f32) < SAMPLE_RATE * 0.05:
        return ""
    stream = _recognizer.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples_f32)
    _recognizer.decode_stream(stream)
    return stream.result.text.strip()


def _common_prefix(a: str, b: str) -> str:
    n, m = 0, min(len(a), len(b))
    while n < m and a[n] == b[n]:
        n += 1
    return a[:n]


class StablePrefix:


    def __init__(self):
        self.prev = ""
        self.shown = ""

    def update(self, cur: str) -> str:
        agreed = _common_prefix(self.prev, cur)
        self.prev = cur
        if " " in agreed:
            agreed = agreed[:agreed.rfind(" ")]
        if len(agreed) > len(self.shown):
            self.shown = agreed
        return self.shown


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
    return {"status": "ok", "engine": "parakeet-stream"}


@app.websocket("/asr")
async def asr(ws: WebSocket):
    await ws.accept()
    if _session_lock.locked():
        await ws.close(code=1013, reason="engine busy: one session at a time")
        return
    async with _session_lock:
        loop = asyncio.get_running_loop()
        result_queue: asyncio.Queue = asyncio.Queue()
        audio_queue: queue.Queue = queue.Queue()

        def emit(line_no: int, text: str):
            msg = {"lines": [{"text": text, "speaker": 0}], "line_count": line_no}
            loop.call_soon_threadsafe(result_queue.put_nowait, msg)

        def stream_worker():
            vad = _build_vad()
            vad_rem = np.empty(0, dtype=np.float32)
            live = np.empty(0, dtype=np.float32)
            line_no = 0
            new_line = True
            last_text = ""
            last_preview = 0.0
            silent_run = 0.0
            stable = StablePrefix()
            stopping = False

            def reset_utterance():
                nonlocal vad, vad_rem, live, new_line, last_text, silent_run, stable
                vad = _build_vad()
                vad_rem = np.empty(0, dtype=np.float32)
                live = np.empty(0, dtype=np.float32)
                new_line = True
                last_text = ""
                silent_run = 0.0
                stable = StablePrefix()

            while True:
                chunks = []
                try:
                    first = audio_queue.get(timeout=POLL_S)
                    if first is _SENTINEL:
                        stopping = True
                    else:
                        chunks.append(first)
                except queue.Empty:
                    pass
                while True:
                    try:
                        b = audio_queue.get_nowait()
                    except queue.Empty:
                        break
                    if b is _SENTINEL:
                        stopping = True
                    else:
                        chunks.append(b)

                endpoint = False
                if chunks:
                    new_audio = np.concatenate(chunks)
                    dur = len(new_audio) / SAMPLE_RATE
                    peak = float(np.max(np.abs(new_audio))) if len(new_audio) else 0.0

                    if peak >= FLUSH_PEAK:
                        live = np.concatenate([live, new_audio]) if len(live) else new_audio
                        silent_run = 0.0
                    elif len(live):
                        silent_run += dur

                    vad_rem = np.concatenate([vad_rem, new_audio])
                    while len(vad_rem) >= VAD_WINDOW:
                        vad.accept_waveform(vad_rem[:VAD_WINDOW])
                        vad_rem = vad_rem[VAD_WINDOW:]

                    if not vad.empty():
                        while not vad.empty():
                            vad.pop()
                        endpoint = True
                    elif len(live) and silent_run >= FLUSH_HOLD:
                        endpoint = True

                now = time.monotonic()
                if endpoint and len(live):
                    text = _transcribe(live)
                    if text:
                        if new_line:
                            line_no += 1
                        emit(line_no, text)
                    reset_utterance()
                elif len(live) and (now - last_preview) >= PREVIEW_STEP_S:
                    t0 = time.perf_counter()
                    hyp = _transcribe(live)
                    text = stable.update(hyp) if STABLE_PREVIEW else hyp
                    last_preview = now
                    if DEBUG_TIMING:
                        logger.info("preview %.0f ms  buf=%.1fs  shown=%dch",
                                    (time.perf_counter() - t0) * 1000,
                                    len(live) / SAMPLE_RATE, len(text))
                    if text and text != last_text:
                        if new_line:
                            line_no += 1
                            new_line = False
                        emit(line_no, text)
                        last_text = text

                if stopping and audio_queue.empty():
                    if len(live):
                        text = _transcribe(live)
                        if text:
                            if new_line:
                                line_no += 1
                            emit(line_no, text)
                    break

        worker = threading.Thread(target=stream_worker, daemon=True)
        worker.start()

        async def send_results():
            while True:
                msg = await result_queue.get()
                if msg is None:
                    break
                await ws.send_text(json.dumps(msg))

        sender = asyncio.create_task(send_results())

        await ws.send_text(json.dumps({"type": "ready"}))
        logger.info("Session started")
        try:
            while True:
                data = await ws.receive_bytes()
                pcm = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
                audio_queue.put(pcm)
        except WebSocketDisconnect:
            logger.info("Session closed by client")
        except Exception as e:
            logger.error("Session error: %s", e)
        finally:
            audio_queue.put(_SENTINEL)
            await asyncio.to_thread(worker.join, 10)
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
