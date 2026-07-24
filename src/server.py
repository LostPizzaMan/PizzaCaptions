import asyncio
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import logging
import webbrowser
from contextlib import asynccontextmanager
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
import translate as _translate_module
import winjob
from hallucinations import DEFAULT_BLOCKED_PHRASES

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

APP_VERSION = "0.2.1"

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

_file_handler = RotatingFileHandler(LOG_DIR / "server.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
_file_handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
logging.getLogger().addHandler(_file_handler)



_stt_language = "ja"
_target_language = "en-US"



ENGINES_DIR = BASE_DIR / "engines"
ENGINE_STARTUP_TIMEOUT = 1800


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


_DL_SIZE_RE = re.compile(r"(\d+(?:\.\d+)?\s*[KMGT]i?B?\s*/\s*\d+(?:\.\d+)?\s*[KMGT]i?B?)", re.I)
_DL_PCT_RE = re.compile(r"(\d{1,3})\s*%")


def _download_detail(line: str) -> str | None:

    low = line.lower()
    if not ("%|" in line or "b/s" in low or "download" in low or "fetching" in low):
        return None
    pct = _DL_PCT_RE.search(line)
    size = _DL_SIZE_RE.search(line)
    if pct and size:
        return f"{pct.group(1)}% ({size.group(1).replace(' ', '')})"
    if pct:
        return f"{pct.group(1)}%"
    if size:
        return size.group(1).replace(" ", "")
    return "starting download..."


class EngineManager:

    def __init__(self, engines_dir: Path):
        self.engines_dir = engines_dir
        self.manifests: dict[str, dict] = {}
        self.refresh()
        self.proc: subprocess.Popen | None = None
        self.port: int | None = None
        self.engine_id: str | None = None
        self.language: str | None = None
        self.model: str | None = None
        self.lock = threading.Lock()
        self.startup_phase: str = ""
        self.startup_detail: str = ""

    def refresh(self):

        manifests: dict[str, dict] = {}
        for base, source in ((self.engines_dir, "dev"), (engine_install.PACKS_DIR, "installed")):
            if not base.exists():
                continue
            for mf in sorted(base.glob("*/engine.json")):
                try:
                    m = json.loads(mf.read_text(encoding="utf-8"))
                    m["_dir"] = mf.parent
                    m["_source"] = source
                    m["_available"] = (mf.parent / m.get("python", "")).resolve().exists()
                    if m["id"] in manifests and not m["_available"]:
                        continue
                    manifests[m["id"]] = m
                except Exception as e:
                    logger.warning("Skipping bad engine manifest %s: %s", mf, e)
        self.manifests = manifests

    def available(self, engine_id: str) -> bool:
        m = self.manifests.get(engine_id)
        return bool(m and m["_available"])

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def ensure(self, engine_id: str, language: str, model: str):
        with self.lock:
            if self.running() and (self.engine_id, self.language, self.model) == (engine_id, language, model):
                return
            self._stop_locked()
            self._spawn_locked(engine_id, language, model)

    def stop(self):
        with self.lock:
            self._stop_locked()

    def _stop_locked(self):
        if self.proc is not None:
            if self.proc.poll() is None:
                logger.info("Stopping engine %s (pid %d)", self.engine_id, self.proc.pid)
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
            self.proc = None
        self.port = self.engine_id = self.language = self.model = None
        self.startup_phase = self.startup_detail = ""

    def _spawn_locked(self, engine_id: str, language: str, model: str):
        self.startup_phase, self.startup_detail = "loading", ""
        manifest = self.manifests.get(engine_id)
        if manifest is None:
            raise ValueError(f"Unknown engine: {engine_id}")
        edir: Path = manifest["_dir"]
        if manifest["_source"] == "installed":
            src = self.engines_dir / engine_id / "engine_server.py"
            dst = edir / "engine_server.py"
            if src.exists() and (not dst.exists() or src.stat().st_mtime > dst.stat().st_mtime):
                shutil.copy2(src, dst)
                logger.info("Updated %s pack code from app copy", engine_id)
        python = (edir / manifest["python"]).resolve()
        if not python.exists():
            raise RuntimeError(f"Engine {engine_id}: interpreter not found at {python}")
        port = _free_port()
        if manifest.get("models_dir"):
            models_dir = (edir / manifest["models_dir"]).resolve()
        elif manifest.get("models_engine"):
            models_dir = engine_install.MODELS_DIR / manifest["models_engine"]
        else:
            models_dir = engine_install.MODELS_DIR / engine_id
        cmd = [str(python), str(edir / manifest["entry"]),
               "--port", str(port), "--language", language, "--model", model,
               "--models-dir", str(models_dir)]
        logger.info("Spawning engine %s (language=%s, model=%s, port=%d)", engine_id, language, model, port)
        self.proc = subprocess.Popen(
            cmd, cwd=str(edir),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        winjob.assign(self.proc)
        threading.Thread(target=self._pump_output, args=(self.proc, engine_id), daemon=True).start()

        deadline = time.monotonic() + ENGINE_STARTUP_TIMEOUT
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                code = self.proc.returncode
                self.proc = None
                raise RuntimeError(f"Engine {engine_id} exited with code {code} during startup (see log)")
            try:
                with urllib_request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                    if r.status == 200:
                        break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            self._stop_locked()
            raise RuntimeError(f"Engine {engine_id} did not become healthy in {ENGINE_STARTUP_TIMEOUT}s")

        self.port, self.engine_id, self.language, self.model = port, engine_id, language, model
        self.startup_phase, self.startup_detail = "ready", ""
        logger.info("Engine %s ready on port %d", engine_id, port)

    def _pump_output(self, proc: subprocess.Popen, engine_id: str):
        try:
            buf: list[str] = []
            while True:
                ch = proc.stdout.read(1)
                if not ch:
                    break
                if ch in ("\r", "\n"):
                    line = "".join(buf).strip()
                    buf.clear()
                    if not line:
                        continue
                    detail = _download_detail(line)
                    if detail:
                        self.startup_phase, self.startup_detail = "downloading", detail
                    if ch == "\n":
                        logger.info("[%s] %s", engine_id, line)
                else:
                    buf.append(ch)
        except Exception:
            pass


_engine_mgr = EngineManager(ENGINES_DIR)



_CONFIG_FILE = APP_DATA_DIR / "config.json"

_blocked_phrases: list[str] = []

_active_engine = "whisper"
_engine_models: dict[str, str] = {}

_source_mode = "mic"
_mic_device_name = ""
_loopback_device_name = ""

_min_sound_level = 0.0

_wizard_done = False

_suppress_osc_when_muted = True


def _model_for(engine_id: str) -> str:
    manifest = _engine_mgr.manifests.get(engine_id, {})
    return _engine_models.get(engine_id) or manifest.get("default_model", "default")

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
    global _blocked_phrases, _active_engine, _engine_models
    global _stt_language, _target_language
    global _source_mode, _mic_device_name, _loopback_device_name
    global _min_sound_level, _wizard_done, _suppress_osc_when_muted
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
        raw = cfg.get("blocked_phrases", [])
        if isinstance(raw, list):
            _blocked_phrases = [str(p).strip() for p in raw if str(p).strip()]
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
        if isinstance(cfg.get("wizard_done"), bool):
            _wizard_done = cfg["wizard_done"]
        if isinstance(cfg.get("suppress_osc_when_muted"), bool):
            _suppress_osc_when_muted = cfg["suppress_osc_when_muted"]
    except Exception as e:
        logger.warning("Failed to load config.json: %s", e)


def _persist_config():
    saved = {k: v for k, v in get_config().items()
             if k not in ("default_system_prompt", "default_blocked_phrases")}
    _CONFIG_FILE.write_text(json.dumps(saved, indent=2, ensure_ascii=False), encoding="utf-8")


_load_config()



@asynccontextmanager
async def lifespan(app: FastAPI):
    start_osc_receiver()
    yield
    stop_osc_receiver()
    stop_capture()
    _engine_mgr.stop()


app = FastAPI(lifespan=lifespan)


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



class _StreamResampler:


    _NUMTAPS = 63

    def __init__(self, in_rate: int, out_rate: int):
        cutoff = min(0.45 * out_rate / in_rate, 0.45)
        n = np.arange(self._NUMTAPS) - (self._NUMTAPS - 1) / 2
        taps = 2 * cutoff * np.sinc(2 * cutoff * n) * np.hamming(self._NUMTAPS)
        self._taps = (taps / taps.sum()).astype(np.float32)
        self._hist = np.zeros(self._NUMTAPS - 1, dtype=np.float32)
        self._buf = np.empty(0, dtype=np.float32)
        self._pos = 0.0
        self._step = in_rate / out_rate

    def process(self, pcm: np.ndarray) -> np.ndarray:
        x = np.concatenate([self._hist, pcm.astype(np.float32)])
        self._hist = x[-(self._NUMTAPS - 1):]
        self._buf = np.concatenate([self._buf, np.convolve(x, self._taps, mode="valid")])
        limit = len(self._buf) - 1
        if limit < 1:
            return np.empty(0, dtype=np.float32)
        positions = np.arange(self._pos, limit, self._step)
        idx = positions.astype(np.int64)
        frac = (positions - idx).astype(np.float32)
        out = self._buf[idx] * (1.0 - frac) + self._buf[idx + 1] * frac
        next_pos = self._pos + len(positions) * self._step
        keep_from = int(next_pos)
        self._buf = self._buf[keep_from:]
        self._pos = next_pos - keep_from
        return out


_capture_thread: threading.Thread | None = None
_capture_stop = threading.Event()
_last_device_index: int | None = None


def _capture_worker(device_index: int, stop_event: threading.Event, browser_ws: WebSocket, engine_port: int):

    async def run():
        p = pyaudio.PyAudio()
        stream = None
        engine_ws = None
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

            engine_ws = await websockets.connect(f"ws://127.0.0.1:{engine_port}/asr", max_size=None)
            await engine_ws.recv()

            await browser_ws.send_text(json.dumps({"type": "config", "useAudioWorklet": True}))

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
                    threshold = _min_sound_level
                    now = time.monotonic()
                    if threshold <= 0 or level >= threshold:
                        last_loud = now
                    gated = threshold > 0 and (now - last_loud) >= GATE_HOLD_S
                    if gated:
                        audio = np.zeros_like(audio)
                    try:
                        await browser_ws.send_text(json.dumps(
                            {"type": "audio_level", "level": round(level, 3), "gated": gated}))
                    except Exception:
                        pass

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
                    try:
                        await browser_ws.send_text(message)
                    except Exception as e:
                        logger.error("Forward error: %s", e)
                        break

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
            logger.error("Capture error: %s", e)
        finally:
            if engine_ws is not None:
                try:
                    await engine_ws.close()
                except Exception:
                    pass
            if stream:
                stream.stop_stream()
                stream.close()
            p.terminate()
            logger.info("Capture stopped")

    asyncio.run(run())


def start_capture(device_index: int, browser_ws: WebSocket, engine_port: int):
    global _capture_thread, _capture_stop, _last_device_index
    stop_capture()
    _last_device_index = device_index
    _capture_stop = threading.Event()
    _capture_thread = threading.Thread(
        target=_capture_worker,
        args=(device_index, _capture_stop, browser_ws, engine_port),
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



@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/devices")
def devices():
    mic, loopback = _get_devices()
    return {"mic": mic, "loopback": loopback}


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


@app.get("/update/check")
def update_check(force: bool = False):
    now = time.time()
    if not force and _update_cache["result"] is not None and now - _update_cache["checked"] < _UPDATE_TTL:
        return _update_cache["result"]
    result = {"current": APP_VERSION, "latest": None, "update_available": False, "url": UPDATE_URL}
    try:
        req = urllib_request.Request(
            f"https://api.github.com/repos/{UPDATE_REPO}/releases/latest",
            headers={"User-Agent": f"LiveTranscription/{APP_VERSION}",
                     "Accept": "application/vnd.github+json"},
        )
        with urllib_request.urlopen(req, timeout=5) as r:
            rel = json.loads(r.read())
        latest = _parse_version(rel.get("tag_name", ""))
        current = _parse_version(APP_VERSION)
        if latest and current:
            result["latest"] = rel["tag_name"].lstrip("vV")
            result["update_available"] = latest > current
            result["url"] = rel.get("html_url") or UPDATE_URL
    except Exception as e:
        logger.info("Update check failed: %s", e)
    _update_cache.update(checked=now, result=result)
    return result


@app.post("/update/open")
async def update_open():
    url = (_update_cache.get("result") or {}).get("url") or UPDATE_URL
    webbrowser.open(url)
    return {"ok": True}


@app.get("/engines")
def engines():
    _engine_mgr.refresh()
    return {
        "engines": [
            {
                "id": m["id"],
                "name": m.get("name", m["id"]),
                "languages": m.get("languages", []),
                "models": m.get("models", []),
                "default_model": m.get("default_model"),
                "installed": m["_available"],
                "source": m["_source"],
                "experimental": bool(m.get("experimental")),
            }
            for m in sorted(_engine_mgr.manifests.values(), key=lambda m: bool(m.get("experimental")))
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
        return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
    return 0


def _whisper_artifacts(model: str) -> list[Path]:

    root = engine_install.MODELS_DIR / "whisper"
    artifacts = []
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


def _parakeet_active_model() -> str:
    return "parakeet-ja" if _stt_language == "ja" else "parakeet-tdt-0.6b-v3-int8"


@app.get("/models")
def list_models(engine: str):
    items = []
    if engine == "parakeet-stream":
        engine = "parakeet"
    if engine == "whisper":
        manifest = _engine_mgr.manifests.get("whisper", {})
        active = _model_for("whisper")
        for m in manifest.get("models", []):
            size = sum(_path_size(a) for a in _whisper_artifacts(m))
            items.append({
                "id": m, "label": m, "installed": size > 0, "size_bytes": size,
                "est_download": _WHISPER_DL_EST.get(m, "?"),
                "can_download": False,
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
    if engine != "parakeet" or model not in engine_install.PARAKEET_MODEL_ARCHIVES:
        raise HTTPException(status_code=400, detail="Only parakeet models are downloaded here; whisper models download on first use")
    if not engine_install.start_model_download(model):
        raise HTTPException(status_code=409, detail="Another download/install is already running")
    return {"ok": True}


@app.post("/models/delete")
async def model_delete(payload: dict = Body(...)):
    engine, model = payload.get("engine"), payload.get("model")
    if engine == "parakeet-stream":
        engine = "parakeet"
    if _engine_mgr.running():
        running = _engine_mgr.engine_id
        in_use = (engine == "whisper" and running == "whisper" and _engine_mgr.model == model) or \
                 (engine == "parakeet" and running in ("parakeet", "parakeet-stream")
                  and _parakeet_active_model() == model)
        if in_use:
            raise HTTPException(status_code=409, detail="Model is in use. Stop capture or switch model/language first")
    if engine == "whisper":
        manifest = _engine_mgr.manifests.get("whisper", {})
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
    engine_install.remove(engine_id)
    _engine_mgr.refresh()
    return {"ok": True}


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
        "blocked_phrases":         _blocked_phrases,
        "default_blocked_phrases": DEFAULT_BLOCKED_PHRASES,
        "active_engine":           _active_engine,
        "engine_models":           _engine_models,
        "stt_language":            _stt_language,
        "target_language":         _target_language,
        "source_mode":            _source_mode,
        "mic_device_name":        _mic_device_name,
        "loopback_device_name":   _loopback_device_name,
        "min_sound_level":        _min_sound_level,
        "wizard_done":            _wizard_done,
        "suppress_osc_when_muted": _suppress_osc_when_muted,
    }


@app.post("/config")
async def set_config(payload: dict = Body(...)):
    global _blocked_phrases, _target_language
    global _source_mode, _mic_device_name, _loopback_device_name
    global _min_sound_level, _wizard_done, _suppress_osc_when_muted
    m = _translate_module
    supported_backends = set(m._BACKENDS)
    backend = payload.get("translation_backend")
    if backend and backend not in supported_backends:
        raise HTTPException(status_code=400, detail=f"Unknown backend: {backend}")
    if "source_mode" in payload:
        if payload["source_mode"] not in ("mic", "loopback"):
            raise HTTPException(status_code=400, detail="source_mode must be 'mic' or 'loopback'")
        _source_mode = payload["source_mode"]
    if isinstance(payload.get("mic_device_name"), str):
        _mic_device_name = payload["mic_device_name"]
    if isinstance(payload.get("loopback_device_name"), str):
        _loopback_device_name = payload["loopback_device_name"]
    if "min_sound_level" in payload:
        v = payload["min_sound_level"]
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not (0 <= v <= 1):
            raise HTTPException(status_code=400, detail="min_sound_level must be a number between 0 and 1")
        _min_sound_level = float(v)
    if isinstance(payload.get("wizard_done"), bool):
        _wizard_done = payload["wizard_done"]
    if isinstance(payload.get("suppress_osc_when_muted"), bool):
        _suppress_osc_when_muted = payload["suppress_osc_when_muted"]
    if "blocked_phrases" in payload:
        raw = payload["blocked_phrases"]
        if not isinstance(raw, list):
            raise HTTPException(status_code=400, detail="blocked_phrases must be a list")
        _blocked_phrases = [str(p).strip() for p in raw if str(p).strip()]
    for key, attr in _CONFIG_FIELDS.items():
        if key in payload:
            setattr(m, attr, payload[key])
    if isinstance(payload.get("target_language"), str) and payload["target_language"].strip():
        _target_language = payload["target_language"].strip()
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
        return await asyncio.to_thread(_translate_module.translate, text, source_language, target_language)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except urllib_error.URLError as e:
        raise HTTPException(status_code=503, detail=f"Translation failed: {e.reason}")



async def _resume_capture(ws: WebSocket) -> bool:
    if _last_device_index is None:
        return False
    await asyncio.to_thread(_engine_mgr.ensure, _active_engine, _stt_language, _model_for(_active_engine))
    start_capture(_last_device_index, ws, _engine_mgr.port)
    await ws.send_text(json.dumps({"status": "capture_started"}))
    return True


@app.websocket("/control")
async def control_ws(ws: WebSocket):
    global _stt_language, _active_engine
    origin = ws.headers.get("origin")
    if not _origin_allowed(origin):
        logger.warning("Rejected /control connection from origin %s", origin)
        await ws.close(code=1008)
        return
    await ws.accept()
    await ws.send_text(json.dumps({"status": "language_set", "language": _stt_language}))
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
                _engine_mgr.refresh()
                if not _engine_mgr.available(_active_engine):
                    await ws.send_text(json.dumps({"error":
                        "No transcription engine installed. Open Settings (⚙) and click Install"}))
                    continue
                try:
                    await asyncio.to_thread(
                        _engine_mgr.ensure, _active_engine, _stt_language, _model_for(_active_engine)
                    )
                except Exception as e:
                    logger.error("Engine start failed: %s", e)
                    await ws.send_text(json.dumps({"error": f"Engine failed to start: {e}"}))
                    continue
                start_capture(int(device_index), ws, _engine_mgr.port)
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
                manifest = _engine_mgr.manifests.get(_active_engine, {})
                if lang not in manifest.get("languages", []):
                    await ws.send_text(json.dumps({"error": f"Unsupported language: {lang}"}))
                    continue
                await ws.send_text(json.dumps({"status": "language_loading", "language": lang}))
                was_capturing = _capture_active()
                stop_capture()
                _stt_language = lang
                _persist_config()
                try:
                    if was_capturing:
                        await _resume_capture(ws)
                    else:
                        _engine_mgr.stop()
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
                await ws.send_text(json.dumps({"status": "engine_loading", "engine": engine_id}))
                was_capturing = _capture_active()
                stop_capture()
                _active_engine = engine_id
                _engine_models[engine_id] = model
                languages = manifest.get("languages", [])
                if _stt_language not in languages and languages:
                    _stt_language = "en" if "en" in languages else languages[0]
                _persist_config()
                try:
                    if was_capturing:
                        await _resume_capture(ws)
                    else:
                        _engine_mgr.stop()
                except Exception as e:
                    logger.error("Engine switch failed: %s", e)
                    await ws.send_text(json.dumps({"error": f"Engine failed to start: {e}"}))
                await ws.send_text(json.dumps({
                    "status": "engine_set", "engine": engine_id, "model": model,
                    "languages": languages, "language": _stt_language,
                }))

    except WebSocketDisconnect:
        stop_capture()



app.mount("/", StaticFiles(directory=str(WEB_DIR)), name="static")



if __name__ == "__main__":
    print(f"Web UI: http://localhost:{UI_PORT}")
    print("Open this in your browser (Chrome/Edge recommended)")
    uvicorn.run(app, host="localhost", port=UI_PORT, log_level="info")
