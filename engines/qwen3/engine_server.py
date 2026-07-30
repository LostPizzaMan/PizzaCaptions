import argparse
import asyncio
import base64
import io
import json
import logging
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path
from urllib import request as urllib_request

import numpy as np
import sherpa_onnx
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("qwen3-engine")

SAMPLE_RATE = 16000

VAD_THRESHOLD = float(os.environ.get("VAD_THRESHOLD", "0.5"))
VAD_MIN_SILENCE_S = float(os.environ.get("VAD_MIN_SILENCE_S", "0.5"))
VAD_MIN_SPEECH_S = float(os.environ.get("VAD_MIN_SPEECH_S", "0.25"))
VAD_MAX_SPEECH_S = float(os.environ.get("VAD_MAX_SPEECH_S", "20.0"))
VAD_BUFFER_S = 60.0
VAD_WINDOW = 512

FLUSH_PEAK = 1e-4
FLUSH_HOLD = 0.35

CONTEXT_TOKENS = int(os.environ.get("QWEN3_CONTEXT", "4096"))

ASR_MARKER = "<asr_text>"

_session_lock = asyncio.Lock()
_server_proc: subprocess.Popen | None = None
_server_port: int = 0
_models_dir: Path


def _has_nvidia_gpu() -> bool:
    return shutil.which("nvidia-smi") is not None


def _free_port() -> int:
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _start_llama_server(models_dir: Path) -> tuple[subprocess.Popen, int]:
    exe = models_dir / "bin" / "llama-server.exe"
    model = models_dir / "Qwen3-ASR-1.7B-Q8_0.gguf"
    mmproj = models_dir / "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf"
    for p in (exe, model, mmproj):
        if not p.exists():
            raise FileNotFoundError(f"Qwen3 runtime file missing: {p}")

    port = _free_port()
    cmd = [str(exe), "-m", str(model), "--mmproj", str(mmproj),
           "-ngl", "99", "--mmproj-offload",
           "-c", str(CONTEXT_TOKENS), "-np", "1",
           "--host", "127.0.0.1", "--port", str(port),
           "-t", str(max(1, (os.cpu_count() or 4) // 2))]
    logger.info("Starting llama-server on 127.0.0.1:%d", port)
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"llama-server exited with code {proc.returncode} during startup")
        try:
            with urllib_request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                if r.status == 200 and b'"ok"' in r.read():
                    logger.info("llama-server ready")
                    return proc, port
        except Exception:
            pass
        time.sleep(0.5)
    proc.kill()
    raise RuntimeError("llama-server did not become healthy in 180s")


def _wav_bytes(samples_f32: np.ndarray) -> bytes:
    pcm = np.clip(samples_f32, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _transcribe(samples_f32: np.ndarray) -> str:
    if len(samples_f32) < SAMPLE_RATE * 0.05:
        return ""
    body = {
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "Transcribe the audio."},
            {"type": "input_audio", "input_audio": {
                "data": base64.b64encode(_wav_bytes(samples_f32)).decode(),
                "format": "wav"}}]}],
        "temperature": 0,
        "max_tokens": 512,
    }
    req = urllib_request.Request(
        f"http://127.0.0.1:{_server_port}/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib_request.urlopen(req, timeout=300) as r:
        out = json.loads(r.read())
    text = out["choices"][0]["message"]["content"]
    if ASR_MARKER in text:
        text = text.split(ASR_MARKER, 1)[1]
    return text.replace("</asr_text>", " ").strip()


def _build_vad() -> sherpa_onnx.VoiceActivityDetector:
    vad_path = _models_dir / "silero_vad.onnx"
    if not vad_path.exists():
        raise FileNotFoundError(f"Silero VAD model not found at {vad_path}")
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = str(vad_path)
    cfg.silero_vad.threshold = VAD_THRESHOLD
    cfg.silero_vad.min_silence_duration = VAD_MIN_SILENCE_S
    cfg.silero_vad.min_speech_duration = VAD_MIN_SPEECH_S
    cfg.silero_vad.window_size = VAD_WINDOW
    cfg.silero_vad.max_speech_duration = VAD_MAX_SPEECH_S
    cfg.sample_rate = SAMPLE_RATE
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=VAD_BUFFER_S)


app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok", "engine": "qwen3"}


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
                try:
                    text = _transcribe(samples)
                except Exception as e:
                    logger.error("Transcription failed: %s", e)
                    text = ""
                elapsed = time.perf_counter() - t0
                emit({"type": "state", "state": "listening"})
                if not text:
                    continue
                logger.info("Inference: %.2fs for %.2fs audio: %s", elapsed, duration, text)
                line_count += 1
                emit({"lines": [{"text": text, "speaker": 0}],
                      "line_count": line_count, "final": True,
                      "decode_ms": round(elapsed * 1000)})

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
            await asyncio.to_thread(inference_thread.join, 30)
            result_queue.put_nowait(None)
            try:
                await sender
            except Exception:
                pass


def main():
    global _models_dir, _server_proc, _server_port
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--language", default="en")
    parser.add_argument("--model", default="default")
    parser.add_argument("--models-dir", required=True)
    args = parser.parse_args()

    _models_dir = Path(args.models_dir)

    if not _has_nvidia_gpu():
        logger.error("Qwen3-ASR requires an NVIDIA GPU. On CPU this model runs at "
                     "~2x realtime, too slow for live captions, so it will not start.")
        raise SystemExit(2)

    _server_proc, _server_port = _start_llama_server(_models_dir)

    logger.info("Qwen3-ASR ready, listening on 127.0.0.1:%d", args.port)
    try:
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
    finally:
        if _server_proc and _server_proc.poll() is None:
            logger.info("Stopping llama-server")
            _server_proc.terminate()
            try:
                _server_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                _server_proc.kill()


if __name__ == "__main__":
    main()
