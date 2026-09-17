import asyncio
import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import time
import logging
import webbrowser
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request

import pyaudiowpatch as pyaudio
import uvicorn
from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_server import ThreadingOSCUDPServer
from pythonosc.udp_client import SimpleUDPClient

import capture
import engine_install
import jadict
import models
import ocr
import procloop as _procloop
import translate as _translate_module
import tts
import updates
import win_captions
from engine_base import CATALOG, ENGINES_DIR, UI_PORT
from hallucinations import DEFAULT_BLOCKED_PHRASES

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

APP_VERSION = "0.6.0"

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

def _emit_ui(msg, targets=None) -> None:
    loop = _main_loop
    if loop is None:
        return
    text = msg if isinstance(msg, str) else json.dumps(msg)
    try:
        asyncio.run_coroutine_threadsafe(_broadcast_text(text, targets), loop)
    except RuntimeError:
        pass

_CONFIG_FILE = APP_DATA_DIR / "config.json"

_blocked_phrases: list[str] = []

_discard_other_alphabets = False

_active_engine = "whisper"
_engine_models: dict[str, str] = {}

_mic_device_name = ""
_loopback_device_name = ""

_min_sound_level = 0.0

_stt_max_phrase_s = 20.0

_wizard_done = False

_ui_state: dict = {}

_suppress_osc_when_muted = True

OSC_CHATBOX_MODES = ("original_first", "translation_first", "original_only", "translation_only")
_osc_chatbox = "original_first"

_program_capture_enabled = False

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
    global _mic_device_name, _loopback_device_name
    global _min_sound_level, _wizard_done, _suppress_osc_when_muted, _program_capture_enabled
    global _stt_max_phrase_s, _ui_state, _osc_chatbox
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
        for _k in ("captions_blur", "captions_pos_color", "captions_reading",
                   "captions_show", "captions_max_lines", "captions_text_scale"):
            if _k in cfg:
                _pending_caption_prefs[_k.replace("captions_", "")] = cfg[_k]
        raw = cfg.get("blocked_phrases", [])
        if isinstance(raw, list):
            _blocked_phrases = [str(p).strip() for p in raw if str(p).strip()]
        if isinstance(cfg.get("discard_other_alphabets"), bool):
            _discard_other_alphabets = cfg["discard_other_alphabets"]
        if cfg.get("active_engine") in CATALOG.manifests:
            _active_engine = cfg["active_engine"]
        if isinstance(cfg.get("engine_models"), dict):
            _engine_models = {k: str(v) for k, v in cfg["engine_models"].items()}
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
        if isinstance(cfg.get("ui_state"), dict):
            _ui_state = cfg["ui_state"]
        if isinstance(cfg.get("suppress_osc_when_muted"), bool):
            _suppress_osc_when_muted = cfg["suppress_osc_when_muted"]
        if cfg.get("osc_chatbox") in OSC_CHATBOX_MODES:
            _osc_chatbox = cfg["osc_chatbox"]
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
    capture.stop_all_slots()
    ocr.on_shutdown()
    jadict.on_shutdown()
    await win_captions.on_shutdown()
    capture._engine_pool.stop_all()
    tts.on_shutdown()

app = FastAPI(lifespan=lifespan)
app.include_router(ocr.router)
app.include_router(jadict.router)
app.include_router(tts.router)
app.include_router(updates.router)
app.include_router(models.router)
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
    with capture._pa_lock:
        return _enumerate_devices()

def _enumerate_devices():
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
    return capture._engine_pool.startup() or {"running": False, "phase": "", "detail": ""}

@app.post("/open-external")
def open_external(payload: dict = Body(...)):
    url = (payload.get("url") or "").strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(status_code=400, detail="only http(s) URLs allowed")
    webbrowser.open(url)
    return {"ok": True}

@app.get("/engines")
def engines():
    CATALOG.refresh()
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
            for m in sorted((mm for mm in CATALOG.manifests.values()
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

capture.configure(
    emit_ui=_emit_ui,
    control_clients=_control_clients,
    get_stt_language=lambda: _stt_language,
    get_engine_models=lambda: _engine_models,
    get_min_sound_level=lambda: _min_sound_level,
    get_overlay_owner=lambda: _overlay_owner,
)

tts.configure(
    model_for=capture._model_for,
    get_mic_name=lambda: _mic_device_name,
    persist=_persist_config,
    safe_id=_safe_id,
)

updates.configure(app_version=APP_VERSION)
models.configure(
    catalog=CATALOG,
    model_for=capture._model_for,
    get_stt_language=lambda: _stt_language,
    slots=capture._slots,
    get_spawning=capture.spawning_specs,
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

@app.post("/engines/remove")
async def engines_remove(payload: dict = Body(...)):
    engine_id = _safe_id(payload.get("engine"), "engine")
    for slot, s in list(capture._slots.items()):
        if s.mgr.engine_id == engine_id:
            await asyncio.to_thread(capture.stop_slot, slot)
            _emit_ui({"type": "capture_ended", "stream": slot})
    ocr.on_engine_removed(engine_id)
    tts.on_engine_removed(engine_id)
    await win_captions.on_engine_removed(engine_id)
    engine_install.remove(engine_id)
    CATALOG.refresh()
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
        "captions_show":          _captions_overlay.get_prefs()["show"],
        "captions_max_lines":     _captions_overlay.get_prefs()["max_lines"],
        "captions_text_scale":    _captions_overlay.get_prefs()["text_scale"],
        "mic_device_name":        _mic_device_name,
        "loopback_device_name":   _loopback_device_name,
        "min_sound_level":        _min_sound_level,
        "stt_max_phrase_s":       _stt_max_phrase_s,
        "wizard_done":            _wizard_done,
        "ui_state":               _ui_state,
        "suppress_osc_when_muted": _suppress_osc_when_muted,
        "osc_chatbox":            _osc_chatbox,
        "program_capture_enabled": _program_capture_enabled,
        "program_capture_supported": _procloop.available(),
        **tts.config_dict(),
    }

@app.post("/config")
async def set_config(payload: dict = Body(...)):
    global _blocked_phrases, _discard_other_alphabets, _target_language
    global _win_captions_target, _win_captions_backend, _win_captions_to_transcript
    global _mic_device_name, _loopback_device_name
    global _min_sound_level, _wizard_done, _suppress_osc_when_muted, _stt_max_phrase_s
    global _program_capture_enabled, _ui_state, _osc_chatbox
    m = _translate_module
    supported_backends = set(m._BACKENDS)
    backend = payload.get("translation_backend")
    if backend and backend not in supported_backends:
        raise HTTPException(status_code=400, detail=f"Unknown backend: {backend}")
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
    if isinstance(payload.get("ui_state"), dict):
        _ui_state = payload["ui_state"]
    if isinstance(payload.get("suppress_osc_when_muted"), bool):
        _suppress_osc_when_muted = payload["suppress_osc_when_muted"]
    if "osc_chatbox" in payload:
        v = payload["osc_chatbox"]
        if v not in OSC_CHATBOX_MODES:
            raise HTTPException(status_code=400,
                                detail=f"osc_chatbox must be one of: {', '.join(OSC_CHATBOX_MODES)}")
        _osc_chatbox = v
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
    except TimeoutError:
        backend = _translate_module.TRANSLATION_BACKEND
        raise HTTPException(
            status_code=503,
            detail=f"Translation timed out: {backend} did not answer in time")
    except urllib_error.URLError as e:
        if isinstance(e.reason, TimeoutError):
            backend = _translate_module.TRANSLATION_BACKEND
            raise HTTPException(
                status_code=503,
                detail=f"Translation timed out: {backend} did not answer in time")
        raise HTTPException(status_code=503, detail=f"Translation failed: {e.reason}")

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
    try:
        while True:
            msg = await ws.receive_text()
            data = json.loads(msg)
            action = data.get("action")

            if action == "set_slots":
                fallback = data.get("engine") or capture._DEFAULT_ENGINE
                slots = {
                    "you": {"device": data.get("you_device"),
                            "engine": data.get("you_engine") or fallback,
                            "language": data.get("you_lang"),
                            "model": data.get("you_model"),
                            "program": data.get("you_program"),
                            "is_mic": data.get("you_is_mic")},
                    "them": {"device": data.get("them_device"),
                             "engine": data.get("them_engine") or fallback,
                             "language": data.get("them_lang"),
                             "model": data.get("them_model"),
                             "program": data.get("them_program"),
                             "is_mic": data.get("them_is_mic")},
                }
                try:
                    await asyncio.to_thread(capture.set_slots, slots)
                    live = [s for s, c in slots.items()
                            if c["device"] is not None or c["program"]]
                    if len(live) == 1:
                        c = slots[live[0]]
                        _active_engine = c["engine"]
                        _engine_models[c["engine"]] = c["model"] or capture._model_for(c["engine"])
                        if c["language"] and c["language"] != "auto":
                            _stt_language = c["language"]
                        _persist_config()
                    await ws.send_text(json.dumps({"status": "slots_set"}))
                except capture.SlotStartError as e:
                    logger.error("Capture start failed (%s slot): %s", e.slot, e)
                    await ws.send_text(json.dumps({"error": f"Capture start failed: {e}",
                                                   "slot": e.slot, "running": e.running}))
                except Exception as e:
                    logger.error("Capture start failed: %s", e)
                    await asyncio.to_thread(capture.stop_all_slots)
                    await ws.send_text(json.dumps({"error": f"Capture start failed: {e}", "running": []}))

            elif action == "stop_all_slots":
                await asyncio.to_thread(capture.stop_all_slots)
                await ws.send_text(json.dumps({"status": "all_slots_stopped"}))

            elif action == "stop_slot":
                slot = data.get("slot")
                if slot in ("you", "them"):
                    await asyncio.to_thread(capture.stop_slot, slot)
                await ws.send_text(json.dumps({"status": "slot_stopped", "slot": slot}))

            elif action == "restart_slot":
                slot = data.get("slot")
                if slot in ("you", "them"):
                    await asyncio.to_thread(capture.restart_slot, slot)

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

    except WebSocketDisconnect:
        await asyncio.to_thread(capture.stop_all_slots)
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

@app.post("/captions/overlay/content")
def captions_overlay_content(payload: dict = Body(...)):
    _captions_overlay.set_show(str(payload.get("mode") or "both"))
    _persist_config()
    return {"ok": True}

@app.post("/captions/overlay/maxlines")
def captions_overlay_maxlines(payload: dict = Body(...)):
    _captions_overlay.set_max_lines(payload.get("lines"))
    _persist_config()
    return {"ok": True}

@app.post("/captions/overlay/textscale")
def captions_overlay_textscale(payload: dict = Body(...)):
    _captions_overlay.set_text_scale(payload.get("scale"))
    _persist_config()
    return {"ok": True}

@app.get("/captions/overlay/state")
def captions_overlay_state():
    return _captions_overlay.get_prefs()

mimetypes.add_type("text/javascript", ".js")

app.mount("/", StaticFiles(directory=str(WEB_DIR)), name="static")

if __name__ == "__main__":
    print(f"Web UI: http://localhost:{UI_PORT}")
    print("Open this in your browser (Chrome/Edge recommended)")
    uvicorn.run(app, host="localhost", port=UI_PORT, log_level="info")
