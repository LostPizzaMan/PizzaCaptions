import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import logging
import webbrowser
from contextlib import asynccontextmanager
from dataclasses import dataclass
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request

import numpy as np
import pyaudiowpatch as pyaudio
import uvicorn
import websockets
from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_server import ThreadingOSCUDPServer
from pythonosc.udp_client import SimpleUDPClient

import engine_install
import jadict
import ocr
import procloop as _procloop
import translate as _translate_module
import tts
import win_captions
from audio import _StreamResampler
from engine_base import EngineManager, ENGINES_DIR
from hallucinations import DEFAULT_BLOCKED_PHRASES

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

APP_VERSION = "0.5.0"

SAMPLE_RATE = 16000
CHUNK = 4096
GATE_HOLD_S = 0.4
UI_PORT = 3011
VRC_OSC_IP = "127.0.0.1"
VRC_OSC_PORT = 9000
VRC_OSC_LISTEN_PORT = 9001
BASE_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = BASE_DIR / "web"

APP_DATA_DIR = Path(os.environ.get("APPDATA") or str(BASE_DIR)) / "LiveTranscription"
LOG_DIR = APP_DATA_DIR / "logs"
APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)

class _SafeRotatingFileHandler(RotatingFileHandler):
    def doRollover(self):
        try:
            super().doRollover()
        except (PermissionError, OSError):
            if not self.delay and self.stream is None:
                self.stream = self._open()

_file_handler = _SafeRotatingFileHandler(LOG_DIR / "server.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
_file_handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
logging.getLogger().addHandler(_file_handler)

_stt_language = "en"
_target_language = "en-US"
_win_captions_target = "en-US"
_win_captions_backend = ""
_win_captions_to_transcript = False
_overlay_owner = "them"
_pending_caption_prefs: dict = {}

_engine_mgr = EngineManager(ENGINES_DIR)

_control_clients: set[WebSocket] = set()
_captions_clients: set[WebSocket] = set()

_main_loop: asyncio.AbstractEventLoop | None = None
_ui_send_lock: asyncio.Lock | None = None

async def _broadcast_text(text: str, targets=None):
    if targets is None:
        targets = (_control_clients, _captions_clients)
    async with _ui_send_lock:
        for clients in targets:
            for ws in list(clients):
                try:
                    await ws.send_text(text)
                except Exception:
                    clients.discard(ws)

async def _broadcast_control(msg: dict):
    await _broadcast_text(json.dumps(msg))

def _emit_ui(msg, targets=None) -> None:
    loop = _main_loop
    if loop is None:
        return
    text = msg if isinstance(msg, str) else json.dumps(msg)
    try:
        asyncio.run_coroutine_threadsafe(_broadcast_text(text, targets), loop)
    except RuntimeError:
        pass

def _tag_result(text: str, stream: str = "listener") -> str:
    try:
        obj = json.loads(text)
    except (ValueError, TypeError):
        return text
    if not isinstance(obj, dict):
        return text
    obj["stream"] = stream
    return json.dumps(obj)

_CONFIG_FILE = APP_DATA_DIR / "config.json"

_blocked_phrases: list[str] = []

_discard_other_alphabets = False

_active_engine = "whisper"
_engine_models: dict[str, str] = {}

_source_mode = "mic"
_mic_device_name = ""
_loopback_device_name = ""

_min_sound_level = 0.0

_stt_max_phrase_s = 20.0
_stt_engine_max_phrase = None

_wizard_done = False

_suppress_osc_when_muted = True

_program_capture_enabled = False

def _model_for(engine_id: str) -> str:
    chosen = _engine_models.get(engine_id)
    if chosen:
        return chosen
    if engine_id == "whisper-batch":
        return "large-v3-turbo" if engine_install._has_nvidia_gpu() else "small"
    manifest = _engine_mgr.manifests.get(engine_id, {})
    return manifest.get("default_model", "default")

def _ensure_stt_engine():
    global _stt_engine_max_phrase
    if (_engine_mgr.running() and _active_engine != "whisper"
            and _stt_engine_max_phrase != _stt_max_phrase_s):
        _engine_mgr.stop()
    _engine_mgr.ensure(_active_engine, _stt_language, _model_for(_active_engine))
    _stt_engine_max_phrase = _stt_max_phrase_s

_CONFIG_FIELDS = {
    "system_prompt_override":  "SYSTEM_PROMPT_OVERRIDE",
    "prompt_presets":          "PROMPT_PRESETS",
    "default_prompt_preset":   "DEFAULT_PROMPT_PRESET",
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
    global _blocked_phrases, _discard_other_alphabets, _active_engine, _engine_models
    global _stt_language, _target_language, _win_captions_target, _win_captions_backend
    global _win_captions_to_transcript
    global _source_mode, _mic_device_name, _loopback_device_name
    global _min_sound_level, _wizard_done, _suppress_osc_when_muted, _program_capture_enabled
    global _stt_max_phrase_s
    if not _CONFIG_FILE.exists():
        return
    try:
        cfg = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        m = _translate_module
        for key, attr in _CONFIG_FIELDS.items():
            if key in cfg:
                setattr(m, attr, cfg[key])
        if isinstance(cfg.get("stt_language"), str) and cfg["stt_language"]:
            _stt_language = cfg["stt_language"]
        if isinstance(cfg.get("target_language"), str) and cfg["target_language"]:
            _target_language = cfg["target_language"]
        if isinstance(cfg.get("win_captions_target"), str):
            _win_captions_target = cfg["win_captions_target"]
        if isinstance(cfg.get("win_captions_backend"), str):
            _win_captions_backend = cfg["win_captions_backend"]
        if isinstance(cfg.get("win_captions_to_transcript"), bool):
            _win_captions_to_transcript = cfg["win_captions_to_transcript"]
        for _k in ("captions_blur", "captions_pos_color", "captions_reading"):
            if _k in cfg:
                _pending_caption_prefs[_k.replace("captions_", "")] = cfg[_k]
        raw = cfg.get("blocked_phrases", [])
        if isinstance(raw, list):
            _blocked_phrases = [str(p).strip() for p in raw if str(p).strip()]
        if isinstance(cfg.get("discard_other_alphabets"), bool):
            _discard_other_alphabets = cfg["discard_other_alphabets"]
        if cfg.get("active_engine") in _engine_mgr.manifests:
            _active_engine = cfg["active_engine"]
        if isinstance(cfg.get("engine_models"), dict):
            _engine_models = {k: str(v) for k, v in cfg["engine_models"].items()}
        if cfg.get("source_mode") in ("mic", "loopback"):
            _source_mode = cfg["source_mode"]
        if isinstance(cfg.get("mic_device_name"), str):
            _mic_device_name = cfg["mic_device_name"]
        if isinstance(cfg.get("loopback_device_name"), str):
            _loopback_device_name = cfg["loopback_device_name"]
        if isinstance(cfg.get("min_sound_level"), (int, float)):
            _min_sound_level = min(1.0, max(0.0, float(cfg["min_sound_level"])))
        v = cfg.get("stt_max_phrase_s")
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            _stt_max_phrase_s = max(4.0, min(20.0, float(v)))
            os.environ["VAD_MAX_SPEECH_S"] = str(_stt_max_phrase_s)
        if isinstance(cfg.get("wizard_done"), bool):
            _wizard_done = cfg["wizard_done"]
        if isinstance(cfg.get("suppress_osc_when_muted"), bool):
            _suppress_osc_when_muted = cfg["suppress_osc_when_muted"]
        if isinstance(cfg.get("program_capture_enabled"), bool):
            _program_capture_enabled = cfg["program_capture_enabled"]
        tts.load_config(cfg)
    except Exception as e:
        logger.warning("Failed to load config.json: %s", e)

def _persist_config():
    saved = {k: v for k, v in get_config().items()
             if k not in ("default_system_prompt", "default_blocked_phrases",
                          "factory_prompt_presets",
                          "translate_supported_targets", "program_capture_supported")}
    _CONFIG_FILE.write_text(json.dumps(saved, indent=2, ensure_ascii=False), encoding="utf-8")

_load_config()

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _main_loop, _ui_send_lock
    _main_loop = asyncio.get_running_loop()
    _ui_send_lock = asyncio.Lock()
    start_osc_receiver()
    tts.on_startup()
    threading.Thread(target=engine_install.migrate_silero_vad, daemon=True,
                     name="silero-v5-migrate").start()
    yield
    _main_loop = None
    stop_osc_receiver()
    stop_capture()
    stop_dual()
    ocr.on_shutdown()
    jadict.on_shutdown()
    await win_captions.on_shutdown()
    _engine_mgr.stop()
    tts.on_shutdown()

app = FastAPI(lifespan=lifespan)
app.include_router(ocr.router)
app.include_router(jadict.router)
app.include_router(tts.router)
app.include_router(win_captions.router)
win_captions.configure(
    broadcast=_broadcast_text,
    captions_clients=_captions_clients,
    target_language=lambda: _win_captions_target or _target_language,
    backend=lambda: _win_captions_backend or None,
    control_clients=_control_clients,
    to_transcript=lambda: _win_captions_to_transcript,
    on_source_change=lambda: _captions_overlay.clear(),
)

_ALLOWED_ORIGINS = frozenset({
    f"http://localhost:{UI_PORT}",
    f"http://127.0.0.1:{UI_PORT}",
})
_UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

def _origin_allowed(origin: str | None) -> bool:
    return origin is None or origin in _ALLOWED_ORIGINS

@app.middleware("http")
async def csrf_guard(request, call_next):
    if request.method in _UNSAFE_METHODS and not _origin_allowed(request.headers.get("origin")):
        logger.warning("Rejected cross-origin %s %s from origin %r",
                       request.method, request.url.path, request.headers.get("origin"))
        return JSONResponse({"detail": "Cross-origin request rejected"}, status_code=403)
    return await call_next(request)

@app.middleware("http")
async def no_cache(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response

_osc_client = SimpleUDPClient(VRC_OSC_IP, VRC_OSC_PORT)

_vrc_muted = False
_osc_server: ThreadingOSCUDPServer | None = None

def _on_mute_self(_address, *args):
    global _vrc_muted
    if args:
        _vrc_muted = bool(args[0])

def _muted_and_suppressed() -> bool:
    return _suppress_osc_when_muted and _vrc_muted

def start_osc_receiver():
    global _osc_server
    if _osc_server is not None:
        return
    disp = Dispatcher()
    disp.map("/avatar/parameters/MuteSelf", _on_mute_self)
    try:
        _osc_server = ThreadingOSCUDPServer((VRC_OSC_IP, VRC_OSC_LISTEN_PORT), disp)
    except OSError as e:
        logger.warning("OSC receiver unavailable on %s:%d (%s); mute-aware OSC disabled",
                       VRC_OSC_IP, VRC_OSC_LISTEN_PORT, e)
        return
    threading.Thread(target=_osc_server.serve_forever, name="osc-receiver", daemon=True).start()

def stop_osc_receiver():
    global _osc_server
    if _osc_server is not None:
        _osc_server.shutdown()
        _osc_server.server_close()
        _osc_server = None

def send_osc(text: str):
    if _muted_and_suppressed():
        return
    try:
        _osc_client.send_message("/chatbox/input", [text, True, False])
    except Exception as e:
        logger.warning("OSC send error: %s", e)

def send_osc_typing(flag: bool):
    if flag and _muted_and_suppressed():
        return
    try:
        _osc_client.send_message("/chatbox/typing", flag)
    except Exception as e:
        logger.warning("OSC typing error: %s", e)

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

_capture_thread: threading.Thread | None = None
_capture_stop = threading.Event()
_last_device_index: int | None = None
_last_program: "str | None" = None

_pa_lock = threading.Lock()

ENGINE_BUSY_CODE = 1013
ENGINE_BUSY_ATTEMPTS = 8

async def _open_engine_session(mgr: "EngineManager", stop_event: threading.Event, language: str | None = None):
    delay = 0.3

    def _asr_url(port: int) -> str:
        u = f"ws://127.0.0.1:{port}/asr"
        return f"{u}?language={language}" if language else u

    url = _asr_url(mgr.port)
    for attempt in range(1, ENGINE_BUSY_ATTEMPTS + 1):
        ws = await websockets.connect(url, max_size=None)
        try:
            await ws.recv()
            return ws
        except websockets.ConnectionClosed as e:
            await ws.close()
            busy = e.rcvd is not None and e.rcvd.code == ENGINE_BUSY_CODE
            if not busy or stop_event.is_set():
                raise
            logger.info("Engine still finishing the previous session, retrying (%d/%d)",
                        attempt, ENGINE_BUSY_ATTEMPTS)
            await asyncio.sleep(delay)
            delay = min(delay * 1.5, 2.0)

    if stop_event.is_set():
        raise RuntimeError("engine busy: the previous session did not release in time")
    logger.warning("Engine still holding a session after %d attempts; restarting it",
                   ENGINE_BUSY_ATTEMPTS)
    new_port = await asyncio.to_thread(mgr.restart)
    if new_port is None:
        raise RuntimeError("engine busy: the previous session did not release in time")
    ws = await websockets.connect(_asr_url(new_port), max_size=None)
    await ws.recv()
    return ws

def _capture_worker(device_index: int, stop_event: threading.Event, mgr: "EngineManager",
                    stream_tag: str = "listener", language: str | None = None,
                    is_mic: bool = True, program: "str | None" = None):
    async def run():
        p = None
        stream = None
        engine_ws = None
        try:
            if program:
                pid = _procloop.resolve_pid(program)
                if pid is None:
                    raise RuntimeError(f"Program not running: {program}")
                stream = _procloop.ProcLoopSource(pid)
                sample_rate = SAMPLE_RATE
                num_channels = 1
                logger.info("Capture: program %s (pid %d) via procloop", program, pid)
            else:
                with _pa_lock:
                    p = pyaudio.PyAudio()
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

            engine_ws = await _open_engine_session(mgr, stop_event, language)

            _emit_ui({"type": "config", "useAudioWorklet": True, "stream": stream_tag})

            resampler = _StreamResampler(sample_rate, SAMPLE_RATE) if sample_rate != SAMPLE_RATE else None

            async def send_audio():
                last_loud = time.monotonic()
                while not stop_event.is_set():
                    data = await asyncio.get_event_loop().run_in_executor(
                        None, lambda: stream.read(CHUNK, exception_on_overflow=False)
                    )
                    audio = np.frombuffer(data, dtype=np.int16).astype(np.float32)
                    if num_channels > 1:
                        audio = audio.reshape(-1, num_channels).mean(axis=1)

                    rms = float(np.sqrt(np.mean((audio / 32768.0) ** 2))) if len(audio) else 0.0
                    level = max(0.0, min(1.0, 1.0 + 20.0 * float(np.log10(rms + 1e-9)) / 60.0))
                    threshold = _min_sound_level if is_mic else 0.0
                    now = time.monotonic()
                    if threshold <= 0 or level >= threshold:
                        last_loud = now
                    gated = threshold > 0 and (now - last_loud) >= GATE_HOLD_S
                    if gated:
                        audio = np.zeros_like(audio)
                    _emit_ui({"type": "audio_level", "level": round(level, 3), "gated": gated, "stream": stream_tag})

                    if resampler is not None:
                        audio = resampler.process(audio)
                        if not len(audio):
                            continue
                    await engine_ws.send(np.clip(np.rint(audio), -32768, 32767).astype(np.int16).tobytes())

            async def recv_results():
                async for message in engine_ws:
                    if stop_event.is_set():
                        break
                    if isinstance(message, bytes):
                        continue
                    overlay_ok = (_captions_overlay.is_shown()
                                  and win_captions.caption_source() == "current"
                                  and stream_tag in ("listener", _overlay_owner))
                    _emit_ui(_tag_result(message, stream_tag),
                             None if overlay_ok else (_control_clients,))

            recv_task = asyncio.create_task(recv_results())
            try:
                await send_audio()
            finally:
                await engine_ws.close()
                try:
                    await recv_task
                except Exception:
                    pass

        except Exception as e:
            msg = str(e)
            if (stop_event.is_set()
                    or "cannot schedule new futures after shutdown" in msg
                    or "Event loop is closed" in msg):
                logger.info("Capture worker ending (%s)", msg or "stopped")
            else:
                if program and msg.startswith("Program not running"):
                    logger.info("Capture: %s", msg)
                else:
                    logger.error("Capture error: %s", e)
                _emit_ui({"type": "capture_ended", "stream": stream_tag})
        finally:
            if engine_ws is not None:
                try:
                    await engine_ws.close()
                except Exception:
                    pass
            if program:
                if stream:
                    try:
                        stream.stop_stream()
                        stream.close()
                    except Exception:
                        pass
            else:
                with _pa_lock:
                    if stream:
                        try:
                            stream.stop_stream()
                            stream.close()
                        except Exception:
                            pass
                    if p is not None:
                        try:
                            p.terminate()
                        except Exception:
                            pass
            logger.info("Capture stopped")

    asyncio.run(run())

def start_capture(device_index: int, mgr: "EngineManager", program: "str | None" = None):
    global _capture_thread, _capture_stop, _last_device_index, _last_program
    stop_capture()
    _last_device_index = device_index
    _last_program = program
    _capture_stop = threading.Event()
    is_mic = _source_mode == "mic" and not program
    _capture_thread = threading.Thread(
        target=_capture_worker,
        args=(device_index, _capture_stop, mgr, "listener", None, is_mic, program),
        daemon=True,
    )
    _capture_thread.start()

def stop_capture():
    global _capture_thread
    _capture_stop.set()
    if _capture_thread and _capture_thread.is_alive():
        _capture_thread.join(timeout=3)
    _capture_thread = None

def _capture_active() -> bool:
    return _capture_thread is not None and _capture_thread.is_alive()

@dataclass
class _DualSlot:
    mgr: "EngineManager"
    thread: threading.Thread
    stop: threading.Event
    shared_engine: "str | None" = None
    device: int = -1
    language: "str | None" = None
    program: "str | None" = None

_dual_slots: dict[str, _DualSlot] = {}
_dual_shared: dict[str, "EngineManager"] = {}
_dual_shared_refs: dict[str, set[str]] = {}
_DUAL_ENGINE = "nano"
_DUAL_SHARED_ENGINES = {"qwen3", "whisper-batch"}

def start_dual(slots: dict) -> None:
    stop_dual()
    claimed_single = False
    try:
        for slot, cfg in slots.items():
            if not cfg:
                continue
            claimed_single = _start_dual_slot(slot, cfg, allow_claim_single=not claimed_single) or claimed_single
    except Exception:
        stop_dual()
        raise

def _start_dual_slot(slot: str, cfg: dict, allow_claim_single: bool) -> bool:
    dev = cfg.get("device")
    program = cfg.get("program")
    if dev is None and not program:
        return False
    engine = cfg.get("engine") or _DUAL_ENGINE
    lang = cfg.get("language")
    if not lang or lang == "auto":
        lang = _stt_language
    model = cfg.get("model") or _model_for(engine)
    shared_engine = None
    claimed = False
    if (allow_claim_single and _engine_mgr.running()
            and (_engine_mgr.engine_id, _engine_mgr.language, _engine_mgr.model)
                == (engine, lang, model)):
        mgr = _engine_mgr
        claimed = True
    elif engine in _DUAL_SHARED_ENGINES:
        mgr = _dual_shared.get(engine)
        if mgr is None:
            mgr = EngineManager(ENGINES_DIR)
            mgr.refresh()
            if not mgr.available(engine):
                raise RuntimeError(f"{engine} engine not installed")
            mgr.ensure(engine, lang, model)
            _dual_shared[engine] = mgr
        _dual_shared_refs.setdefault(engine, set()).add(slot)
        shared_engine = engine
    else:
        mgr = EngineManager(ENGINES_DIR)
        mgr.refresh()
        if not mgr.available(engine):
            raise RuntimeError(f"{engine} engine not installed")
        mgr.ensure(engine, lang, model)
    slot_lang = cfg.get("language")
    dev_idx = int(dev) if dev is not None else -1
    stop = threading.Event()
    t = threading.Thread(target=_capture_worker,
                         args=(dev_idx, stop, mgr, slot, slot_lang, slot == "you", program), daemon=True)
    _dual_slots[slot] = _DualSlot(mgr, t, stop, shared_engine, dev_idx, slot_lang, program)
    t.start()
    return claimed

def reconfigure_dual_slot(slot: str, cfg: dict) -> None:
    if slot not in _dual_slots:
        return
    stop_dual_slot(slot)
    _start_dual_slot(slot, cfg, allow_claim_single=False)

def _release_shared(slot: str, engine: str) -> None:
    users = _dual_shared_refs.get(engine)
    if users is None:
        return
    users.discard(slot)
    if not users:
        _dual_shared_refs.pop(engine, None)
        mgr = _dual_shared.pop(engine, None)
        if mgr is not None:
            try:
                mgr.stop()
            except Exception:
                pass

def stop_dual_slot(slot: str) -> None:
    s = _dual_slots.pop(slot, None)
    if s is None:
        return
    s.stop.set()
    if s.thread.is_alive():
        s.thread.join(timeout=3)
    if s.shared_engine is not None:
        _release_shared(slot, s.shared_engine)
    elif s.mgr is not _engine_mgr:
        try:
            s.mgr.stop()
        except Exception:
            pass

def restart_dual_slot(slot: str) -> None:
    s = _dual_slots.get(slot)
    if s is None or (s.device < 0 and not s.program):
        return
    s.stop.set()
    if s.thread.is_alive():
        s.thread.join(timeout=3)
    s.stop = threading.Event()
    s.thread = threading.Thread(target=_capture_worker,
                                args=(s.device, s.stop, s.mgr, slot, s.language, slot == "you", s.program), daemon=True)
    s.thread.start()

def stop_dual() -> None:
    for s in _dual_slots.values():
        s.stop.set()
    for s in _dual_slots.values():
        if s.thread.is_alive():
            s.thread.join(timeout=3)
    for s in _dual_slots.values():
        if s.shared_engine is None and s.mgr is not _engine_mgr:
            try:
                s.mgr.stop()
            except Exception:
                pass
    for mgr in _dual_shared.values():
        try:
            mgr.stop()
        except Exception:
            pass
    _dual_slots.clear()
    _dual_shared.clear()
    _dual_shared_refs.clear()

def _dual_active() -> bool:
    return any(s.thread.is_alive() for s in _dual_slots.values())

@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")

@app.get("/devices")
def devices():
    mic, loopback = _get_devices()
    return {"mic": mic, "loopback": loopback}

@app.get("/audio/programs")
def audio_programs():
    if not _program_capture_enabled or not _procloop.available():
        return {"available": False, "programs": []}
    return {"available": True, "programs": _procloop.list_programs()}

@app.post("/shortcut/create")
def create_shortcut():
    if sys.platform != "win32":
        raise HTTPException(status_code=400, detail="Shortcuts are Windows-only")
    target = BASE_DIR / "Start Pizza Captions.bat"
    icon = BASE_DIR / "desktop" / "src-tauri" / "icons" / "icon.ico"
    if not target.exists():
        raise HTTPException(status_code=400, detail="Start Pizza Captions.bat not found (running in dev mode?)")

    def q(p):
        return "'" + str(p).replace("'", "''") + "'"

    ps = (
        "$ws = New-Object -ComObject WScript.Shell; "
        "$d = [Environment]::GetFolderPath('Desktop'); "
        "$lnk = $ws.CreateShortcut((Join-Path $d 'Pizza Captions.lnk')); "
        f"$lnk.TargetPath = {q(target)}; $lnk.WorkingDirectory = {q(BASE_DIR)}; "
        f"$lnk.IconLocation = {q(icon)}; $lnk.Description = 'Pizza Captions'; $lnk.Save()"
    )
    try:
        subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                       check=True, capture_output=True, text=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"Could not create shortcut: {e.stderr or e}")
    return {"ok": True}

@app.get("/version")
def version():
    return {"version": APP_VERSION}

@app.get("/engine/startup")
def engine_startup():
    return {
        "running": _engine_mgr.running(),
        "phase": _engine_mgr.startup_phase,
        "detail": _engine_mgr.startup_detail,
    }

UPDATE_REPO = "LostPizzaMan/PizzaCaptions"
UPDATE_URL = f"https://github.com/{UPDATE_REPO}/releases/latest"
_UPDATE_TTL = 6 * 3600
_update_cache: dict = {"checked": 0.0, "result": None}

def _parse_version(s: str) -> tuple | None:
    try:
        return tuple(int(p) for p in s.strip().lstrip("vV").split("."))
    except ValueError:
        return None

def _latest_release_via_redirect() -> tuple[str, str]:
    req = urllib_request.Request(UPDATE_URL, headers={"User-Agent": f"LiveTranscription/{APP_VERSION}"})
    with urllib_request.urlopen(req, timeout=5) as r:
        final = r.url
    if "/releases/tag/" not in final:
        raise RuntimeError(f"unexpected releases URL: {final}")
    return final.rstrip("/").rsplit("/", 1)[-1], final

@app.get("/update/check")
def update_check(force: bool = False):
    now = time.time()
    if not force and _update_cache["result"] is not None and now - _update_cache["checked"] < _UPDATE_TTL:
        return _update_cache["result"]
    result = {"current": APP_VERSION, "latest": None, "update_available": False, "url": UPDATE_URL}
    tag, url = "", ""
    try:
        req = urllib_request.Request(
            f"https://api.github.com/repos/{UPDATE_REPO}/releases/latest",
            headers={"User-Agent": f"LiveTranscription/{APP_VERSION}",
                     "Accept": "application/vnd.github+json"},
        )
        with urllib_request.urlopen(req, timeout=5) as r:
            rel = json.loads(r.read())
        tag, url = rel.get("tag_name", ""), rel.get("html_url") or UPDATE_URL
    except Exception as e:
        logger.info("Update check via API failed: %s", e)
        try:
            tag, url = _latest_release_via_redirect()
        except Exception as e2:
            logger.info("Update check failed: %s", e2)
    latest, current = _parse_version(tag), _parse_version(APP_VERSION)
    if latest and current:
        result["latest"] = tag.lstrip("vV")
        result["update_available"] = latest > current
        result["url"] = url or UPDATE_URL
    _update_cache.update(checked=now, result=result)
    return result

@app.post("/update/open")
async def update_open():
    url = (_update_cache.get("result") or {}).get("url") or UPDATE_URL
    webbrowser.open(url)
    return {"ok": True}

@app.post("/open-external")
def open_external(payload: dict = Body(...)):
    url = (payload.get("url") or "").strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(status_code=400, detail="only http(s) URLs allowed")
    webbrowser.open(url)
    return {"ok": True}

@app.get("/engines")
def engines():
    _engine_mgr.refresh()
    return {
        "engines": [
            {
                "id": m["id"],
                "kind": m.get("kind", "asr"),
                "name": m.get("name", m["id"]),
                "description": m.get("description", ""),
                "languages": m.get("languages", []),
                "models": m.get("models", []),
                "default_model": m.get("default_model"),
                "installed": m["_available"],
                "source": m["_source"],
                "experimental": bool(m.get("experimental")),
            }
            for m in sorted((mm for mm in _engine_mgr.manifests.values()
                             if mm.get("kind", "asr") == "asr"),
                            key=lambda m: bool(m.get("experimental")))
        ],
        "active_engine": _active_engine,
        "engine_models": _engine_models,
        "language": _stt_language,
        "install_job": engine_install.get_job(),
        "has_nvidia_gpu": engine_install._has_nvidia_gpu(),
        "wizard_done": _wizard_done,
    }

_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")

def _safe_id(value, kind: str = "id") -> str:
    s = str(value or "")
    if s in (".", "..") or not _SAFE_ID_RE.match(s):
        raise HTTPException(status_code=400, detail=f"Invalid {kind}: {value!r}")
    return s

tts.configure(
    model_for=_model_for,
    get_mic_name=lambda: _mic_device_name,
    persist=_persist_config,
    safe_id=_safe_id,
)

@app.post("/engines/install")
async def engines_install(payload: dict = Body(...)):
    engine_id = _safe_id(payload.get("engine"), "engine")
    source_dir = ENGINES_DIR / engine_id
    if not (source_dir / "engine.json").exists():
        raise HTTPException(status_code=404, detail=f"Unknown engine: {engine_id}")
    if not engine_install.start_install(engine_id, source_dir, BASE_DIR):
        raise HTTPException(status_code=409, detail="Another engine install is already running")
    return {"ok": True}

@app.get("/engines/install/status")
def engines_install_status():
    return engine_install.get_job()

_WHISPER_DL_EST = {
    "tiny": "75 MB", "base": "145 MB", "small": "500 MB",
    "medium": "1.5 GB", "large-v3-turbo": "1.6 GB", "large-v3": "3 GB",
}
_PARAKEET_STORAGE = {
    "parakeet-tdt-0.6b-v3-int8": {"label": "European languages (25)", "est": "650 MB"},
    "parakeet-ja": {"label": "Japanese", "est": "620 MB"},
}

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

def _whisper_installed(model: str) -> bool:
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
    return "parakeet-ja" if _stt_language == "ja" else "parakeet-tdt-0.6b-v3-int8"

def _model_held_by_dual(engine: str, model: str) -> bool:
    for s in _dual_slots.values():
        if not s.thread.is_alive():
            continue
        rid = s.mgr.engine_id
        if engine in ("whisper", "whisper-batch") and rid in ("whisper", "whisper-batch"):
            if s.mgr.model == model:
                return True
        elif engine == "parakeet" and rid in ("parakeet", "parakeet-stream"):
            lang = s.language if (s.language and s.language != "auto") else _stt_language
            slot_model = "parakeet-ja" if lang == "ja" else "parakeet-tdt-0.6b-v3-int8"
            if slot_model == model:
                return True
    return False

@app.get("/models")
def list_models(engine: str):
    items = []
    if engine == "parakeet-stream":
        engine = "parakeet"
    if engine in ("whisper", "whisper-batch"):
        manifest = _engine_mgr.manifests.get(engine, {})
        active = _model_for(engine)
        for m in manifest.get("models", []):
            size = sum(_path_size(a) for a in _whisper_artifacts(m))
            items.append({
                "id": m, "label": m, "installed": _whisper_installed(m), "size_bytes": size,
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
    else:
        raise HTTPException(status_code=404, detail=f"Unknown engine: {engine}")
    total = sum(i["size_bytes"] for i in items)
    engine_install.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(engine_install.MODELS_DIR).free
    return {"engine": engine, "models": items, "total_bytes": total, "disk_free_bytes": free}

@app.post("/models/download")
async def model_download(payload: dict = Body(...)):
    engine, model = payload.get("engine"), payload.get("model")
    if engine == "parakeet-stream":
        engine = "parakeet"
    if engine in ("whisper", "whisper-batch"):
        py = manifest = None
        for eid in (engine, "whisper-batch" if engine == "whisper" else "whisper"):
            m = _engine_mgr.manifests.get(eid)
            if m and m.get("_available"):
                manifest, py = m, (m["_dir"] / m["python"]).resolve()
                break
        if manifest is None:
            raise HTTPException(status_code=409, detail="Install a Whisper engine first")
        if model not in manifest.get("models", []):
            raise HTTPException(status_code=404, detail=f"Unknown model: {model}")
        if not engine_install.start_whisper_model_download(py, model):
            raise HTTPException(status_code=409, detail="Another download/install is already running")
        return {"ok": True}
    if engine != "parakeet" or model not in engine_install.PARAKEET_MODEL_ARCHIVES:
        raise HTTPException(status_code=400, detail="Unknown engine/model for download")
    if not engine_install.start_model_download(model):
        raise HTTPException(status_code=409, detail="Another download/install is already running")
    return {"ok": True}

@app.post("/models/download/cancel")
async def model_download_cancel():
    engine_install.cancel_job()
    return {"ok": True}

@app.post("/models/delete")
async def model_delete(payload: dict = Body(...)):
    engine, model = payload.get("engine"), payload.get("model")
    if engine == "parakeet-stream":
        engine = "parakeet"
    if _model_held_by_dual(engine, str(model)):
        raise HTTPException(status_code=409, detail="Model is in use. Stop capture first, then delete it.")
    if _engine_mgr.running():
        running = _engine_mgr.engine_id
        holds = (engine in ("whisper", "whisper-batch")
                 and running in ("whisper", "whisper-batch") and _engine_mgr.model == model) or \
                (engine == "parakeet" and running in ("parakeet", "parakeet-stream")
                 and _parakeet_active_model() == model)
        if holds:
            if _capture_active() or _dual_active():
                raise HTTPException(status_code=409, detail="Model is in use. Stop capture first, then delete it.")
            _engine_mgr.stop()
    if engine in ("whisper", "whisper-batch"):
        manifest = _engine_mgr.manifests.get(engine, {})
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

@app.post("/engines/remove")
async def engines_remove(payload: dict = Body(...)):
    engine_id = _safe_id(payload.get("engine"), "engine")
    if _engine_mgr.running() and _engine_mgr.engine_id == engine_id:
        stop_capture()
        _engine_mgr.stop()
    ocr.on_engine_removed(engine_id)
    await win_captions.on_engine_removed(engine_id)
    engine_install.remove(engine_id)
    _engine_mgr.refresh()
    return {"ok": True}

@app.get("/translate/lmstudio/models")
def lmstudio_models(url: str = ""):
    base = (url or _translate_module.LMSTUDIO_URL or "").strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=400, detail="LM Studio URL is not set")
    try:
        req = urllib_request.Request(f"{base}/models", headers={"Accept": "application/json"})
        with urllib_request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=502,
                            detail=f"Could not reach LM Studio: {getattr(e, 'reason', None) or e}")

    models = []
    for m in data.get("models", []):
        if m.get("type") == "embedding":
            continue
        key = m.get("key")
        if not key:
            continue
        models.append({
            "id": key,
            "label": m.get("display_name") or key,
            "params": m.get("params_string") or "",
            "quant": (m.get("quantization") or {}).get("name", ""),
        })
    models.sort(key=lambda m: m["label"].lower())
    return {"models": models}

_LANG_TARGET_CODES: "list | None" = None

def _all_target_codes() -> list:
    global _LANG_TARGET_CODES
    if _LANG_TARGET_CODES is None:
        codes: list = []
        try:
            data = json.loads((WEB_DIR / "lang.json").read_text(encoding="utf-8"))
            for code, e in data.items():
                if code == "auto" or not isinstance(e, dict):
                    continue
                if e.get("targets"):
                    codes += [t["code"] for t in e["targets"] if t.get("code")]
                else:
                    codes.append(e.get("src") or code)
        except Exception:
            pass
        _LANG_TARGET_CODES = codes
    return _LANG_TARGET_CODES

def _translate_supported_targets() -> dict:
    codes = _all_target_codes()
    return {"deepl": [c for c in codes if _translate_module.supported_target("deepl", c)]}

@app.get("/config")
def get_config():
    m = _translate_module
    return {
        "default_system_prompt":   m._DEFAULT_SYSTEM_PROMPT,
        "system_prompt_override":  m.SYSTEM_PROMPT_OVERRIDE,
        "prompt_presets":          m.PROMPT_PRESETS,
        "default_prompt_preset":   m.DEFAULT_PROMPT_PRESET,
        "factory_prompt_presets":  m._FACTORY_PRESETS,
        "translation_backend":     m.TRANSLATION_BACKEND,
        "translate_supported_targets": _translate_supported_targets(),
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
        "blocked_phrases":         _blocked_phrases,
        "default_blocked_phrases": DEFAULT_BLOCKED_PHRASES,
        "discard_other_alphabets": _discard_other_alphabets,
        "active_engine":           _active_engine,
        "engine_models":           _engine_models,
        "stt_language":            _stt_language,
        "target_language":         _target_language,
        "win_captions_target":     _win_captions_target,
        "win_captions_backend":    _win_captions_backend,
        "win_captions_to_transcript": _win_captions_to_transcript,
        "captions_blur":          _captions_overlay.get_prefs()["blur"],
        "captions_pos_color":     _captions_overlay.get_prefs()["pos_color"],
        "captions_reading":       _captions_overlay.get_prefs()["reading"],
        "source_mode":            _source_mode,
        "mic_device_name":        _mic_device_name,
        "loopback_device_name":   _loopback_device_name,
        "min_sound_level":        _min_sound_level,
        "stt_max_phrase_s":       _stt_max_phrase_s,
        "wizard_done":            _wizard_done,
        "suppress_osc_when_muted": _suppress_osc_when_muted,
        "program_capture_enabled": _program_capture_enabled,
        "program_capture_supported": _procloop.available(),
        **tts.config_dict(),
    }

@app.post("/config")
async def set_config(payload: dict = Body(...)):
    global _blocked_phrases, _discard_other_alphabets, _target_language
    global _win_captions_target, _win_captions_backend, _win_captions_to_transcript
    global _source_mode, _mic_device_name, _loopback_device_name
    global _min_sound_level, _wizard_done, _suppress_osc_when_muted, _stt_max_phrase_s
    global _program_capture_enabled
    m = _translate_module
    supported_backends = set(m._BACKENDS)
    backend = payload.get("translation_backend")
    if backend and backend not in supported_backends:
        raise HTTPException(status_code=400, detail=f"Unknown backend: {backend}")
    if "source_mode" in payload:
        if payload["source_mode"] not in ("mic", "loopback", "program"):
            raise HTTPException(status_code=400, detail="source_mode must be 'mic', 'loopback' or 'program'")
        _source_mode = payload["source_mode"]
    if isinstance(payload.get("mic_device_name"), str):
        _mic_device_name = payload["mic_device_name"]
        tts.on_mic_changed()
    if isinstance(payload.get("loopback_device_name"), str):
        _loopback_device_name = payload["loopback_device_name"]
    if "min_sound_level" in payload:
        v = payload["min_sound_level"]
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not (0 <= v <= 1):
            raise HTTPException(status_code=400, detail="min_sound_level must be a number between 0 and 1")
        _min_sound_level = float(v)
    if "stt_max_phrase_s" in payload:
        v = payload["stt_max_phrase_s"]
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not (4 <= v <= 20):
            raise HTTPException(status_code=400, detail="stt_max_phrase_s must be a number between 4 and 20")
        _stt_max_phrase_s = float(v)
        os.environ["VAD_MAX_SPEECH_S"] = str(_stt_max_phrase_s)
    if isinstance(payload.get("wizard_done"), bool):
        _wizard_done = payload["wizard_done"]
    if isinstance(payload.get("suppress_osc_when_muted"), bool):
        _suppress_osc_when_muted = payload["suppress_osc_when_muted"]
    if isinstance(payload.get("program_capture_enabled"), bool):
        _program_capture_enabled = payload["program_capture_enabled"]
    if "blocked_phrases" in payload:
        raw = payload["blocked_phrases"]
        if not isinstance(raw, list):
            raise HTTPException(status_code=400, detail="blocked_phrases must be a list")
        _blocked_phrases = [str(p).strip() for p in raw if str(p).strip()]
    if isinstance(payload.get("discard_other_alphabets"), bool):
        _discard_other_alphabets = payload["discard_other_alphabets"]
    if "prompt_presets" in payload:
        v = payload["prompt_presets"]
        if not isinstance(v, dict) or not all(
                isinstance(k, str) and isinstance(val, str) for k, val in v.items()):
            raise HTTPException(status_code=400, detail="prompt_presets must be an object of string->string")
    if "default_prompt_preset" in payload and not isinstance(payload["default_prompt_preset"], str):
        raise HTTPException(status_code=400, detail="default_prompt_preset must be a string")
    for key, attr in _CONFIG_FIELDS.items():
        if key in payload:
            setattr(m, attr, payload[key])
    if isinstance(payload.get("target_language"), str) and payload["target_language"].strip():
        _target_language = payload["target_language"].strip()
    if isinstance(payload.get("win_captions_target"), str):
        _win_captions_target = payload["win_captions_target"].strip()
    if isinstance(payload.get("win_captions_backend"), str):
        wb = payload["win_captions_backend"].strip()
        if wb and wb not in supported_backends:
            raise HTTPException(status_code=400, detail=f"Unknown backend: {wb}")
        _win_captions_backend = wb
    if isinstance(payload.get("win_captions_to_transcript"), bool):
        _win_captions_to_transcript = payload["win_captions_to_transcript"]
    _persist_config()
    return {"ok": True}

@app.post("/translate")
async def translate(payload: dict = Body(...)):
    text = (payload.get("text") or "").strip()
    source_language = (payload.get("sourceLanguage") or "").strip() or None
    target_language = (payload.get("targetLanguage") or "").strip() or _target_language
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")
    try:
        t0 = time.perf_counter()
        result = await asyncio.to_thread(_translate_module.translate, text, source_language, target_language)
        if isinstance(result, dict):
            result.setdefault("translate_ms", round((time.perf_counter() - t0) * 1000))
            translated = (result.get("translated") or "").strip()
            if translated and _captions_clients:
                await _broadcast_text(
                    json.dumps({"type": "translation", "source": text, "text": translated}),
                    (_captions_clients,))
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except urllib_error.URLError as e:
        raise HTTPException(status_code=503, detail=f"Translation failed: {e.reason}")

async def _resume_capture(ws: WebSocket) -> bool:
    if _last_device_index is None and not _last_program:
        return False
    await asyncio.to_thread(_ensure_stt_engine)
    await asyncio.to_thread(start_capture, _last_device_index if _last_device_index is not None else -1,
                            _engine_mgr, program=_last_program)
    await ws.send_text(json.dumps({"status": "capture_started"}))
    return True

@app.websocket("/control")
async def control_ws(ws: WebSocket):
    global _stt_language, _active_engine, _overlay_owner
    origin = ws.headers.get("origin")
    if not _origin_allowed(origin):
        logger.warning("Rejected /control connection from origin %s", origin)
        await ws.close(code=1008)
        return
    await ws.accept()
    _control_clients.add(ws)
    await ws.send_text(json.dumps({"status": "language_set", "language": _stt_language}))
    try:
        while True:
            msg = await ws.receive_text()
            data = json.loads(msg)
            action = data.get("action")

            if action == "start_capture":
                device_index = data.get("device_index")
                program = data.get("program")
                if device_index is None and not program:
                    await ws.send_text(json.dumps({"error": "No device index provided"}))
                    continue
                _engine_mgr.refresh()
                if not _engine_mgr.available(_active_engine):
                    await ws.send_text(json.dumps({"error":
                        "No transcription engine installed. Open Settings (⚙) and click Install"}))
                    continue
                try:
                    await asyncio.to_thread(_ensure_stt_engine)
                except Exception as e:
                    logger.error("Engine start failed: %s", e)
                    await ws.send_text(json.dumps({"error": f"Engine failed to start: {e}"}))
                    continue
                await asyncio.to_thread(start_capture,
                                        int(device_index) if device_index is not None else -1,
                                        _engine_mgr, program=program)
                await ws.send_text(json.dumps({"status": "capture_started"}))

            elif action == "stop_capture":
                await asyncio.to_thread(stop_capture)
                if _engine_mgr.running() and _engine_mgr.engine_id != "whisper" and not _dual_active():
                    await asyncio.to_thread(_engine_mgr.stop)
                await ws.send_text(json.dumps({"status": "capture_stopped"}))

            elif action == "start_dual":
                fallback = data.get("engine") or _DUAL_ENGINE
                slots = {
                    "you": {"device": data.get("you_device"),
                            "engine": data.get("you_engine") or fallback,
                            "language": data.get("you_lang"),
                            "model": data.get("you_model"),
                            "program": data.get("you_program")},
                    "them": {"device": data.get("them_device"),
                             "engine": data.get("them_engine") or fallback,
                             "language": data.get("them_lang"),
                             "model": data.get("them_model"),
                             "program": data.get("them_program")},
                }
                try:
                    await asyncio.to_thread(start_dual, slots)
                    await ws.send_text(json.dumps({"status": "dual_started"}))
                except Exception as e:
                    logger.error("Dual start failed: %s", e)
                    stop_dual()
                    await ws.send_text(json.dumps({"error": f"Dual start failed: {e}"}))

            elif action == "stop_dual":
                stop_dual()
                await ws.send_text(json.dumps({"status": "dual_stopped"}))

            elif action == "stop_dual_slot":
                slot = data.get("slot")
                if slot in ("you", "them"):
                    await asyncio.to_thread(stop_dual_slot, slot)
                await ws.send_text(json.dumps({"status": "dual_slot_stopped", "slot": slot}))

            elif action == "restart_dual_slot":
                slot = data.get("slot")
                if slot in ("you", "them"):
                    await asyncio.to_thread(restart_dual_slot, slot)

            elif action == "reconfigure_dual_slot":
                slot = data.get("slot")
                if slot in ("you", "them"):
                    cfg = {"device": data.get("device"), "engine": data.get("engine"),
                           "language": data.get("language"), "model": data.get("model"),
                           "program": data.get("program")}
                    try:
                        await asyncio.to_thread(reconfigure_dual_slot, slot, cfg)
                        await ws.send_text(json.dumps({"status": "dual_slot_reconfigured", "slot": slot}))
                    except Exception as e:
                        logger.error("Dual slot reconfigure failed: %s", e)
                        await ws.send_text(json.dumps({"error": f"Reconfigure failed: {e}"}))

            elif action == "set_overlay_owner":
                slot = data.get("slot")
                if slot in ("you", "them") and slot != _overlay_owner:
                    _overlay_owner = slot
                    _captions_overlay.clear()
                await ws.send_text(json.dumps({"status": "overlay_owner_set", "slot": _overlay_owner}))

            elif action == "send_osc":
                text = data.get("text", "")
                if text:
                    send_osc(text)

            elif action == "osc_typing":
                send_osc_typing(data.get("flag", False))

            elif action == "set_language":
                lang = data.get("language", "ja")
                manifest = _engine_mgr.manifests.get(_active_engine, {})
                if lang not in manifest.get("languages", []):
                    await ws.send_text(json.dumps({"error": f"Unsupported language: {lang}"}))
                    continue
                if lang == _stt_language:
                    await ws.send_text(json.dumps({"status": "language_set", "language": lang}))
                    continue
                await ws.send_text(json.dumps({"status": "language_loading", "language": lang}))
                was_capturing = _capture_active()
                await asyncio.to_thread(stop_capture)
                _stt_language = lang
                _persist_config()
                try:
                    if was_capturing:
                        await _resume_capture(ws)
                    elif not _dual_active():
                        await asyncio.to_thread(_engine_mgr.stop)
                except Exception as e:
                    logger.error("Language switch failed: %s", e)
                    await ws.send_text(json.dumps({"error": f"Engine failed to start: {e}"}))
                await ws.send_text(json.dumps({"status": "language_set", "language": lang}))

            elif action == "set_engine":
                engine_id = data.get("engine")
                _engine_mgr.refresh()
                manifest = _engine_mgr.manifests.get(engine_id)
                if manifest is None:
                    await ws.send_text(json.dumps({"error": f"Unknown engine: {engine_id}"}))
                    continue
                if not manifest["_available"]:
                    await ws.send_text(json.dumps(
                        {"error": f"Engine not installed: {engine_id}. Install it in Settings"}))
                    continue
                model = data.get("model") or _model_for(engine_id)
                if model not in manifest.get("models", [model]):
                    await ws.send_text(json.dumps({"error": f"Unknown model for {engine_id}: {model}"}))
                    continue
                languages = manifest.get("languages", [])
                if (engine_id == _active_engine and model == _model_for(engine_id)
                        and (not languages or _stt_language in languages)):
                    await ws.send_text(json.dumps({
                        "status": "engine_set", "engine": engine_id, "model": model,
                        "languages": languages, "language": _stt_language,
                    }))
                    continue
                await ws.send_text(json.dumps({"status": "engine_loading", "engine": engine_id}))
                was_capturing = _capture_active()
                await asyncio.to_thread(stop_capture)
                _active_engine = engine_id
                _engine_models[engine_id] = model
                if _stt_language not in languages and languages:
                    _stt_language = "en" if "en" in languages else languages[0]
                _persist_config()
                try:
                    if was_capturing:
                        await _resume_capture(ws)
                    elif not _dual_active():
                        await asyncio.to_thread(_engine_mgr.stop)
                except Exception as e:
                    logger.error("Engine switch failed: %s", e)
                    await ws.send_text(json.dumps({"error": f"Engine failed to start: {e}"}))
                await ws.send_text(json.dumps({
                    "status": "engine_set", "engine": engine_id, "model": model,
                    "languages": languages, "language": _stt_language,
                }))

    except WebSocketDisconnect:
        stop_capture()
        stop_dual()
    finally:
        _control_clients.discard(ws)

@app.websocket("/captions")
async def captions_ws(ws: WebSocket):
    origin = ws.headers.get("origin")
    if not _origin_allowed(origin):
        logger.warning("Rejected /captions connection from origin %s", origin)
        await ws.close(code=1008)
        return
    await ws.accept()
    _captions_clients.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _captions_clients.discard(ws)

import overlay as _overlay

_overlay.set_state_callback(
    lambda shown: _emit_ui({"type": "ocr_overlay", "shown": shown}, (_control_clients,)))
_overlay.set_guard(ocr.is_installed)
_overlay.set_blocked_callback(lambda: _emit_ui(
    {"type": "toast", "kind": "warn", "eyebrow": "Not installed",
     "msg": "Screen OCR isn't installed yet.", "action": "ocr_settings"},
    (_control_clients,)))

@app.post("/overlay/show")
def overlay_show():
    _overlay.show()
    return {"ok": True, "available": _overlay.available()}

@app.post("/overlay/hide")
def overlay_hide():
    _overlay.hide()
    return {"ok": True}

import captions_overlay as _captions_overlay
_captions_overlay.load_prefs(**_pending_caption_prefs)

@app.post("/captions/overlay/show")
def captions_overlay_show():
    _captions_overlay.show()
    return {"ok": True, "available": _captions_overlay.available()}

@app.post("/captions/overlay/hide")
def captions_overlay_hide():
    _captions_overlay.hide()
    return {"ok": True}

@app.post("/captions/overlay/interact")
def captions_overlay_interact(payload: dict = Body(...)):
    _captions_overlay.set_interactive(bool(payload.get("on")))
    return {"ok": True}

@app.post("/captions/overlay/hover")
def captions_overlay_hover(payload: dict = Body(...)):
    _captions_overlay.set_hover(bool(payload.get("on")))
    return {"ok": True}

@app.post("/captions/overlay/blur")
def captions_overlay_blur(payload: dict = Body(...)):
    _captions_overlay.set_blur(bool(payload.get("on")))
    _persist_config()
    return {"ok": True}

@app.post("/captions/overlay/poscolor")
def captions_overlay_poscolor(payload: dict = Body(...)):
    _captions_overlay.set_pos_color(bool(payload.get("on")))
    _persist_config()
    return {"ok": True}

@app.post("/captions/overlay/reading")
def captions_overlay_reading(payload: dict = Body(...)):
    _captions_overlay.set_reading(str(payload.get("mode") or "off"))
    _persist_config()
    return {"ok": True}

@app.get("/captions/overlay/state")
def captions_overlay_state():
    return _captions_overlay.get_prefs()

app.mount("/", StaticFiles(directory=str(WEB_DIR)), name="static")

if __name__ == "__main__":
    print(f"Web UI: http://localhost:{UI_PORT}")
    print("Open this in your browser (Chrome/Edge recommended)")
    uvicorn.run(app, host="localhost", port=UI_PORT, log_level="info")
