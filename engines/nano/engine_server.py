import argparse
import asyncio
import json
import logging
import os
import queue
import subprocess
import tempfile
import threading
import time
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx
from vad_segment import VadSegmenter
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("nano-engine")

SAMPLE_RATE = 16000

VAD_THRESHOLD = float(os.environ.get("VAD_THRESHOLD", "0.5"))
VAD_MIN_SILENCE_S = float(os.environ.get("VAD_MIN_SILENCE_S", "0.7"))
VAD_MIN_SPEECH_S = float(os.environ.get("VAD_MIN_SPEECH_S", "0.25"))
VAD_MAX_SPEECH_S = float(os.environ.get("VAD_MAX_SPEECH_S", "20.0"))
VAD_BUFFER_S = 60.0
VAD_PREROLL_MS = float(os.environ.get("VAD_PREROLL_MS", "500"))
VAD_WINDOW = 512

FLUSH_PEAK = 3 / 32768
FLUSH_HOLD = 0.2

NANO_THREADS = os.environ.get("NANO_THREADS") or str(max(1, (os.cpu_count() or 4) // 2))

_models_dir: Path | None = None
_binary: Path | None = None
_enc_gguf: Path | None = None
_llm_gguf: Path | None = None
_session_lock = asyncio.Lock()

def _resolve_assets():
    global _binary, _enc_gguf, _llm_gguf
    pack = Path(__file__).parent
    cand = [pack / "bin" / "llama-funasr-cli.exe", pack / "bin" / "llama-funasr-cli"]
    _binary = next((c for c in cand if c.exists()), None)
    if _binary is None:
        raise FileNotFoundError(f"llama-funasr-cli not found in {pack/'bin'}")
    md = _models_dir
    _enc_gguf = md / "funasr-encoder-f16.gguf"
    _llm_gguf = next((md / n for n in ("qwen3-0.6b-q8_0.gguf", "qwen3-0.6b-q5km.gguf")
                      if (md / n).exists()), None)
    if not _enc_gguf.exists() or _llm_gguf is None:
        raise FileNotFoundError(f"Fun-ASR-Nano GGUF weights not found in {md}")
    logger.info("Fun-ASR-Nano ready: %s + %s (%s threads)",
                _binary.name, _llm_gguf.name, NANO_THREADS)

def _write_wav(path: str, samples_f32: np.ndarray):
    pcm = np.clip(samples_f32, -1.0, 1.0)
    pcm = (pcm * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())

def _transcribe(samples_f32: np.ndarray) -> str:
    if len(samples_f32) < SAMPLE_RATE * 0.05:
        return ""
    fd, wav = tempfile.mkstemp(suffix=".wav", prefix="nano_")
    os.close(fd)
    try:
        _write_wav(wav, samples_f32)
        env = dict(os.environ)
        env.setdefault("GGML_NTHREADS", NANO_THREADS)
        proc = subprocess.run(
            [str(_binary), "--enc", str(_enc_gguf), "-m", str(_llm_gguf), "-a", wav],
            capture_output=True, text=True, encoding="utf-8", errors="ignore",
            timeout=120, env=env,
        )
        text = " ".join(l.strip() for l in proc.stdout.splitlines() if l.strip())
        return " ".join(t for t in text.split() if t != "/sil").strip()
    except subprocess.TimeoutExpired:
        logger.warning("Nano transcribe timed out")
        return ""
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok", "engine": "nano"}

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
                text = _transcribe(samples)
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
            await asyncio.to_thread(inference_thread.join, 30)
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
    _resolve_assets()
    logger.info("Listening on 127.0.0.1:%d", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")

if __name__ == "__main__":
    main()
