import argparse
import asyncio
import json
import logging
import os
import socket
import subprocess
import time
from pathlib import Path
from urllib import request as urllib_request

import uvicorn
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("nemotron-stream-engine")

SAMPLE_RATE = 16000

GGUF_NAME = "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf"

ENDPOINTING_MS = os.environ.get("NEMOTRON_ENDPOINTING_MS")

_models_dir: Path | None = None
_binary: Path | None = None
_gguf: Path | None = None
_language: str = "en"
_serve_port: int = 0
_serve_proc: "subprocess.Popen | None" = None
_session_lock = asyncio.Lock()

def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]

def _resolve_assets():
    global _binary, _gguf
    bin_dir = Path(__file__).parent / "bin"
    direct = bin_dir / "nemo-speech.exe"
    _binary = direct if direct.exists() else next(iter(bin_dir.rglob("nemo-speech.exe")), None)
    if _binary is None:
        raise FileNotFoundError(f"nemo-speech.exe not found under {bin_dir}")
    _gguf = _models_dir / GGUF_NAME
    if not _gguf.exists():
        raise FileNotFoundError(f"Nemotron GGUF weights not found at {_gguf}")

def _serve_ready() -> bool:
    try:
        with urllib_request.urlopen(f"http://127.0.0.1:{_serve_port}/ready", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False

def _start_serve():
    global _serve_proc, _serve_port
    _serve_port = _free_port()
    cmd = [str(_binary), "serve", "--asr-model", str(_gguf),
           "--host", "127.0.0.1", "--port", str(_serve_port),
           "--no-ui", "--device", "cpu",
           "--asr.endpointing.enable=true"]
    if ENDPOINTING_MS:
        cmd.append(f"--asr.endpointing.stop_history_eou_ms={ENDPOINTING_MS}")
    logger.info("Starting nemo-speech serve on 127.0.0.1:%d", _serve_port)
    _serve_proc = subprocess.Popen(cmd, cwd=str(_binary.parent))
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        if _serve_proc.poll() is not None:
            raise RuntimeError(f"nemo-speech serve exited with code {_serve_proc.returncode} during startup")
        if _serve_ready():
            logger.info("nemo-speech serve ready (lang=%s)", _language)
            return
        time.sleep(0.5)
    raise RuntimeError("nemo-speech serve did not become ready in time")

app = FastAPI()

@app.get("/health")
def health():
    ok = _serve_proc is not None and _serve_proc.poll() is None and _serve_ready()
    return {"status": "ok" if ok else "starting", "engine": "nemotron-stream"}

@app.websocket("/asr")
async def asr(ws: WebSocket):
    await ws.accept()
    if _session_lock.locked():
        await ws.close(code=1013, reason="engine busy: one session at a time")
        return
    async with _session_lock:
        url = f"ws://127.0.0.1:{_serve_port}/v1/realtime"
        try:
            upstream = await websockets.connect(url, max_size=None)
        except Exception as e:
            logger.error("Could not reach nemo-speech serve: %s", e)
            await ws.close(code=1011, reason="engine backend unavailable")
            return

        session = {"sample_rate": SAMPLE_RATE}
        if _language and _language != "auto":
            session["language"] = _language
        if ENDPOINTING_MS:
            try:
                session["endpointing_ms"] = float(ENDPOINTING_MS)
            except ValueError:
                pass
        await upstream.send(json.dumps({"type": "session.update", "session": session}))

        await ws.send_text(json.dumps({"type": "ready"}))
        logger.info("Session started")

        async def uplink():
            try:
                while True:
                    data = await ws.receive_bytes()
                    await upstream.send(data)
            except WebSocketDisconnect:
                try:
                    await upstream.send(json.dumps({"type": "input_audio_buffer.commit"}))
                except Exception:
                    pass

        async def downlink():
            line_no = 0
            partial = ""
            active = False

            def send(text, final):
                return ws.send_text(json.dumps(
                    {"lines": [{"text": text, "speaker": 0}], "line_count": line_no,
                     **({"final": True} if final else {})}))

            async for msg in upstream:
                if isinstance(msg, bytes):
                    continue
                try:
                    e = json.loads(msg)
                except ValueError:
                    continue
                t = e.get("type", "")
                if t.endswith("transcription.delta"):
                    if not active:
                        line_no += 1
                        active = True
                        partial = ""
                    partial += e.get("delta", "")
                    text = partial.strip()
                    if text:
                        await send(text, final=False)
                elif t.endswith("transcription.completed"):
                    if not active:
                        line_no += 1
                    text = (e.get("transcript") or partial).strip()
                    active = False
                    partial = ""
                    if text:
                        await send(text, final=True)
                elif t == "error":
                    logger.warning("serve error event: %s", str(e)[:200])

        up = asyncio.create_task(uplink())
        down = asyncio.create_task(downlink())
        try:
            done, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in pending:
                try:
                    await task
                except BaseException:
                    pass
            which = "shell" if up in done else "serve"
            for task in done:
                exc = task.exception()
                if exc and not isinstance(exc, (WebSocketDisconnect, websockets.ConnectionClosed)):
                    logger.error("Session error (%s side): %s", which, exc)
            logger.info("Session ended (%s closed the stream)", which)
        finally:
            try:
                await upstream.close()
            except Exception:
                pass
            try:
                await ws.close()
            except Exception:
                pass

def main():
    global _models_dir, _language
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--language", default="en")
    parser.add_argument("--model", default="default")
    parser.add_argument("--models-dir", required=True)
    args = parser.parse_args()

    _models_dir = Path(args.models_dir)
    _language = args.language
    _resolve_assets()
    _start_serve()
    logger.info("Listening on 127.0.0.1:%d", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")

if __name__ == "__main__":
    main()
