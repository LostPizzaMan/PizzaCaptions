import asyncio
import json
import os
import threading
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request

import numpy as np
import pyaudiowpatch as pyaudio
import uvicorn
from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pythonosc.udp_client import SimpleUDPClient

from whisperlivekit import AudioProcessor, TranscriptionEngine, parse_args
import translate as _translate_module

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
CHUNK = 4096
UI_PORT = 3000
ASR_PORT = 8000
VRC_OSC_IP = "127.0.0.1"
VRC_OSC_PORT = 9000
BASE_DIR = Path(__file__).parent
WEB_DIR = BASE_DIR / "web"

# WhisperLiveKit config

_LANG_STATE_FILE = BASE_DIR / ".language"
_wlk_language = _LANG_STATE_FILE.read_text().strip() if _LANG_STATE_FILE.exists() else "ja"


def _make_config(language: str):
    old_argv = sys.argv
    sys.argv = [
        "wlk",
        "--model", "large-v3-turbo",
        "--language", language,
        "--backend", "faster-whisper",
        "--pcm-input",
    ]
    try:
        return parse_args()
    finally:
        sys.argv = old_argv


_config = _make_config(_wlk_language)
_transcription_engine: TranscriptionEngine | None = None
_engine_lock = threading.Lock()


def _init_engine(language: str):
    global _transcription_engine, _config, _wlk_language
    if _transcription_engine is not None:
        try:
            _transcription_engine.stop()
        except Exception:
            pass
        _transcription_engine = None
    _wlk_language = language
    _config = _make_config(language)
    _transcription_engine = TranscriptionEngine(config=_config)
    logger.info("TranscriptionEngine initialized (language=%s)", language)


def _ensure_engine(language: str | None = None):
    target_language = language or _wlk_language
    with _engine_lock:
        if _transcription_engine is not None and _wlk_language == target_language:
            return
        _init_engine(target_language)


# Translation config

_CONFIG_FILE = BASE_DIR / "config.json"

_CONFIG_FIELDS = {
    "system_prompt_override":  "SYSTEM_PROMPT_OVERRIDE",
    "translation_backend":     "TRANSLATION_BACKEND",
    "deepl_api_url":           "DEEPL_API_URL",
    "deepl_api_key":           "DEEPL_API_KEY",
    "openai_base_url":         "OPENAI_BASE_URL",
    "openai_api_key":          "OPENAI_API_KEY",
    "openai_model":            "OPENAI_MODEL",
    "openai_temperature":      "OPENAI_TEMPERATURE",
    "openrouter_api_key":      "OPENROUTER_API_KEY",
    "openrouter_model":        "OPENROUTER_MODEL",
    "openrouter_temperature":  "OPENROUTER_TEMPERATURE",
    "lmstudio_url":            "LMSTUDIO_URL",
    "lmstudio_model":          "LMSTUDIO_MODEL",
    "lmstudio_temperature":    "LMSTUDIO_TEMPERATURE",
    "libretranslate_url":      "LIBRETRANSLATE_URL",
    "libretranslate_api_key":  "LIBRETRANSLATE_API_KEY",
    "ollama_url":              "OLLAMA_URL",
    "ollama_model":            "OLLAMA_MODEL",
    "ollama_temperature":      "OLLAMA_TEMPERATURE",
}


def _load_config():
    """Apply persisted config.json settings to the translate module."""
    if not _CONFIG_FILE.exists():
        return
    try:
        cfg = json.loads(_CONFIG_FILE.read_text())
        m = _translate_module
        for key, attr in _CONFIG_FIELDS.items():
            if key in cfg:
                setattr(m, attr, cfg[key])
    except Exception as e:
        logger.warning("Failed to load config.json: %s", e)


_load_config()


# FastAPI app

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# OSC

_osc_client = SimpleUDPClient(VRC_OSC_IP, VRC_OSC_PORT)


def send_osc(text: str):
    try:
        _osc_client.send_message("/chatbox/input", [text, True, False])
    except Exception as e:
        logger.warning("OSC send error: %s", e)


def send_osc_typing(flag: bool):
    try:
        _osc_client.send_message("/chatbox/typing", flag)
    except Exception as e:
        logger.warning("OSC typing error: %s", e)


# Device listing

def _get_devices():
    p = pyaudio.PyAudio()
    mic_devices, loopback_devices = [], []
    seen_names = set()
    try:
        wasapi_host = None
        for i in range(p.get_host_api_count()):
            api = p.get_host_api_info_by_index(i)
            if "WASAPI" in api.get("name", ""):
                wasapi_host = api["index"]
                break
        for i in range(p.get_device_count()):
            info = p.get_device_info_by_index(i)
            if wasapi_host is not None and info.get("hostApi") != wasapi_host:
                continue
            name = info["name"]
            if info.get("isLoopbackDevice"):
                loopback_devices.append({"index": i, "name": name})
            elif info.get("maxInputChannels", 0) > 0 and name not in seen_names:
                seen_names.add(name)
                mic_devices.append({"index": i, "name": name})
    finally:
        p.terminate()
    return mic_devices, loopback_devices


# Audio capture -> in-process ASR

_capture_thread: threading.Thread | None = None
_capture_stop = threading.Event()


def _capture_worker(device_index: int, stop_event: threading.Event, browser_ws: WebSocket, engine: "TranscriptionEngine"):
    """Capture audio, feed directly to AudioProcessor, forward results to browser."""

    async def run():
        p = pyaudio.PyAudio()
        stream = None
        try:
            device_info = p.get_device_info_by_index(device_index)
            sample_rate = int(device_info["defaultSampleRate"])
            num_channels = device_info["maxInputChannels"] or 1

            stream = p.open(
                format=pyaudio.paInt16,
                channels=num_channels,
                rate=sample_rate,
                input=True,
                input_device_index=device_index,
                frames_per_buffer=CHUNK,
            )
            logger.info("Capture: %s @ %dHz ch=%d", device_info["name"], sample_rate, num_channels)

            audio_processor = AudioProcessor(transcription_engine=engine)
            results_generator = await audio_processor.create_tasks()

            # Only mark the session live after the transcription tasks are ready.
            await browser_ws.send_text(json.dumps({"type": "config", "useAudioWorklet": True}))

            async def send_audio():
                while not stop_event.is_set():
                    data = await asyncio.get_event_loop().run_in_executor(
                        None, lambda: stream.read(CHUNK, exception_on_overflow=False)
                    )
                    audio = np.frombuffer(data, dtype=np.int16).astype(np.float32)
                    if num_channels > 1:
                        audio = audio.reshape(-1, num_channels).mean(axis=1)
                    if sample_rate != SAMPLE_RATE:
                        new_len = int(len(audio) * SAMPLE_RATE / sample_rate)
                        audio = np.interp(
                            np.linspace(0, len(audio) - 1, new_len),
                            np.arange(len(audio)), audio
                        )
                    await audio_processor.process_audio(audio.astype(np.int16).tobytes())
                await audio_processor.cleanup()

            async def send_results():
                async for response in results_generator:
                    if stop_event.is_set():
                        break
                    try:
                        await browser_ws.send_text(json.dumps(response.to_dict()))
                    except Exception as e:
                        logger.error("Forward error: %s", e)
                        break

            await asyncio.gather(send_audio(), send_results())

        except Exception as e:
            logger.error("Capture error: %s", e)
        finally:
            if stream:
                stream.stop_stream()
                stream.close()
            p.terminate()
            logger.info("Capture stopped")

    asyncio.run(run())


def start_capture(device_index: int, browser_ws: WebSocket):
    global _capture_thread, _capture_stop
    stop_capture()
    _capture_stop = threading.Event()
    with _engine_lock:
        engine = _transcription_engine
    _capture_thread = threading.Thread(
        target=_capture_worker,
        args=(device_index, _capture_stop, browser_ws, engine),
        daemon=True,
    )
    _capture_thread.start()


def stop_capture():
    global _capture_thread
    _capture_stop.set()
    if _capture_thread and _capture_thread.is_alive():
        _capture_thread.join(timeout=3)
    _capture_thread = None


# HTTP routes

@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/devices")
def devices():
    mic, loopback = _get_devices()
    return {"mic": mic, "loopback": loopback}


@app.get("/config")
def get_config():
    m = _translate_module
    return {
        "default_system_prompt":   m._DEFAULT_SYSTEM_PROMPT,
        "system_prompt_override":  m.SYSTEM_PROMPT_OVERRIDE,
        "translation_backend":     m.TRANSLATION_BACKEND,
        "deepl_api_url":           m.DEEPL_API_URL,
        "deepl_api_key":           m.DEEPL_API_KEY,
        "openai_base_url":         m.OPENAI_BASE_URL,
        "openai_api_key":          m.OPENAI_API_KEY,
        "openai_model":            m.OPENAI_MODEL,
        "openai_temperature":      m.OPENAI_TEMPERATURE,
        "openrouter_api_key":      m.OPENROUTER_API_KEY,
        "openrouter_model":        m.OPENROUTER_MODEL,
        "openrouter_temperature":  m.OPENROUTER_TEMPERATURE,
        "lmstudio_url":            m.LMSTUDIO_URL,
        "lmstudio_model":          m.LMSTUDIO_MODEL,
        "lmstudio_temperature":    m.LMSTUDIO_TEMPERATURE,
        "libretranslate_url":      m.LIBRETRANSLATE_URL,
        "libretranslate_api_key":  m.LIBRETRANSLATE_API_KEY,
        "ollama_url":              m.OLLAMA_URL,
        "ollama_model":            m.OLLAMA_MODEL,
        "ollama_temperature":      m.OLLAMA_TEMPERATURE,
    }


@app.post("/config")
async def set_config(payload: dict = Body(...)):
    m = _translate_module
    supported_backends = set(m._BACKENDS)
    backend = payload.get("translation_backend")
    if backend and backend not in supported_backends:
        raise HTTPException(status_code=400, detail=f"Unknown backend: {backend}")
    for key, attr in _CONFIG_FIELDS.items():
        if key in payload:
            setattr(m, attr, payload[key])
    saved = {k: v for k, v in get_config().items() if k != "default_system_prompt"}
    _CONFIG_FILE.write_text(json.dumps(saved, indent=2))
    return {"ok": True}


@app.post("/translate")
async def translate(payload: dict = Body(...)):
    text = (payload.get("text") or "").strip()
    source_language = (payload.get("sourceLanguage") or "").strip() or None
    target_language = (payload.get("targetLanguage") or "").strip() or None
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")
    try:
        return await asyncio.to_thread(_translate_module.translate, text, source_language, target_language)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except urllib_error.URLError as e:
        raise HTTPException(status_code=503, detail=f"Translation failed: {e.reason}")


# Control WebSocket

@app.websocket("/control")
async def control_ws(ws: WebSocket):
    await ws.accept()
    await ws.send_text(json.dumps({"status": "language_set", "language": _wlk_language}))
    try:
        while True:
            msg = await ws.receive_text()
            data = json.loads(msg)
            action = data.get("action")

            if action == "start_capture":
                device_index = data.get("device_index")
                if device_index is None:
                    await ws.send_text(json.dumps({"error": "No device index provided"}))
                    continue
                await asyncio.to_thread(_ensure_engine, _wlk_language)
                start_capture(int(device_index), ws)
                await ws.send_text(json.dumps({"status": "capture_started"}))

            elif action == "stop_capture":
                stop_capture()
                await ws.send_text(json.dumps({"status": "capture_stopped"}))

            elif action == "send_osc":
                text = data.get("text", "")
                if text:
                    send_osc(text)

            elif action == "osc_typing":
                send_osc_typing(data.get("flag", False))

            elif action == "set_language":
                lang = data.get("language", "ja")
                supported = {"ja", "en", "zh", "ko", "fr", "es", "pt", "de", "ru", "ar", "ms", "auto"}
                if lang not in supported:
                    await ws.send_text(json.dumps({"error": f"Unsupported language: {lang}"}))
                    continue
                await ws.send_text(json.dumps({"status": "language_loading", "language": lang}))
                stop_capture()
                _LANG_STATE_FILE.write_text(lang)
                logger.info("Restarting process for language change to: %s", lang)
                os.execv(sys.executable, [sys.executable] + sys.argv)

    except WebSocketDisconnect:
        stop_capture()


# Static files

app.mount("/", StaticFiles(directory=str(WEB_DIR)), name="static")


# Entry point

if __name__ == "__main__":
    print(f"Web UI: http://localhost:{UI_PORT}")
    print("Open this in your browser (Chrome/Edge recommended)")
    uvicorn.run(app, host="localhost", port=UI_PORT, log_level="info")
