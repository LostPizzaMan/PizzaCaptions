import asyncio
import ctypes
import json
import logging
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib import request as urllib_request

import numpy as np
import pyaudiowpatch as pyaudio
from fastapi import APIRouter, Body, HTTPException

import engine_install
from audio import _StreamResampler
from engine_base import EngineManager, ENGINES_DIR

logger = logging.getLogger(__name__)

TTS_SAMPLE_RATE = 24000

_model_for = lambda engine_id: "default"
_get_mic_name = lambda: ""
_persist = lambda: None
_safe_id = lambda value, kind="id": str(value or "")

def configure(*, model_for, get_mic_name, persist, safe_id):
    global _model_for, _get_mic_name, _persist, _safe_id
    _model_for = model_for
    _get_mic_name = get_mic_name
    _persist = persist
    _safe_id = safe_id

_tts_voice = ""
_tts_output_device = ""
_tts_monitor_device = ""
_passthru_enabled = False
_tts_terms_accepted: set[str] = set()

class TtsManager(EngineManager):
    def speak(self, text: str, voice: str, speed: float) -> tuple[bytes, int]:
        with self.lock:
            port = self.port
        if port is None:
            raise RuntimeError("TTS engine not running")
        body = json.dumps({"text": text, "voice": voice, "speed": speed}).encode("utf-8")
        req = urllib_request.Request(
            f"http://127.0.0.1:{port}/speak", data=body,
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib_request.urlopen(req, timeout=120) as r:
            rate = int(r.headers.get("X-Sample-Rate", TTS_SAMPLE_RATE))
            return r.read(), rate

_tts_mgr = TtsManager(ENGINES_DIR)

VC_REDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe"

def _vc_runtime_ok() -> bool:
    if sys.platform != "win32":
        return True
    try:
        for dll in ("msvcp140.dll", "msvcp140_1.dll"):
            ctypes.WinDLL(dll)
        return True
    except OSError:
        return False

def _tts_manifests() -> list[dict]:
    _tts_mgr.refresh()
    return [m for m in _tts_mgr.manifests.values() if m.get("kind") == "tts"]

def _voicevox_catalog() -> list[dict]:
    f = ENGINES_DIR / "voicevox" / "catalog.json"
    if not f.exists():
        return []
    try:
        return json.loads(f.read_text(encoding="utf-8")).get("characters", [])
    except Exception as e:
        logger.warning("Failed to read VOICEVOX catalog: %s", e)
        return []

def _voicevox_vvm_dir() -> Path:
    return engine_install.MODELS_DIR / "voicevox" / "voicevox_core" / "models" / "vvms"

def _voicevox_present_vvms() -> set[str]:
    vd = _voicevox_vvm_dir()
    return {p.name for p in vd.glob("*.vvm")} if vd.exists() else set()

def _voicevox_voices() -> list[dict]:
    present = _voicevox_present_vvms()
    out = []
    for c in _voicevox_catalog():
        for s in c.get("styles", []):
            if s.get("vvm") in present:
                out.append({"id": str(s["id"]), "label": f"{c['speaker']}（{s['name']}）",
                            "lang": "ja", "credit": c.get("credit", ""),
                            "terms_url": c.get("terms_url", ""), "speaker": c["speaker"],
                            "en": c.get("en", ""), "style": s["name"],
                            "style_en": s.get("en", "")})
    return out

_winvoices_cache: "list[dict] | None" = None

def _winvoices_voices() -> list[dict]:
    global _winvoices_cache
    m = _tts_mgr.manifests.get("winvoices")
    if not (m and m.get("_available")):
        return []
    if _winvoices_cache is not None:
        return _winvoices_cache
    pack = engine_install.PACKS_DIR / "winvoices"
    py, script = pack / "python" / "python.exe", pack / "engine_server.py"
    if not (py.exists() and script.exists()):
        return []
    try:
        proc = subprocess.run(
            [str(py), str(script), "--list-voices"],
            capture_output=True, text=True, encoding="utf-8", timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        raw = json.loads(proc.stdout).get("voices", [])
    except Exception as e:
        logger.warning("winvoices enumeration failed: %s", e)
        return []
    out = [{"id": v["id"], "label": f'{v["name"]} ({v.get("bcp47") or v.get("lang", "")})',
            "lang": v.get("lang", "en"), "credit": "", "terms_url": "", "speaker": ""}
           for v in raw if v.get("id")]
    _winvoices_cache = out
    return out

def _voice_entries(m: dict) -> list[dict]:
    if m.get("id") == "voicevox":
        cat = _voicevox_voices()
        if cat:
            return cat
    if m.get("id") == "winvoices" or m.get("dynamic_voices"):
        return _winvoices_voices()
    default_lang = (m.get("languages") or ["en"])[0]
    out = []
    for v in m.get("voices", []):
        if isinstance(v, str):
            out.append({"id": v, "label": v, "lang": default_lang,
                        "credit": "", "terms_url": "", "speaker": ""})
        elif isinstance(v, dict) and v.get("id") is not None:
            out.append({"id": str(v["id"]), "label": v.get("label") or str(v["id"]),
                        "lang": v.get("lang") or default_lang,
                        "credit": v.get("credit", ""), "terms_url": v.get("terms_url", ""),
                        "speaker": v.get("speaker", "")})
    return out

def _tts_engine_for_voice(voice: str):
    for m in _tts_manifests():
        for v in _voice_entries(m):
            if v["id"] == voice:
                return m, v
    return None, None

def _default_tts_voice() -> str:
    if _tts_voice:
        m, _v = _tts_engine_for_voice(_tts_voice)
        if m is not None and m.get("_available"):
            return _tts_voice
    for m in sorted(_tts_manifests(), key=lambda x: x["id"]):
        if not m.get("_available"):
            continue
        if m.get("default_voice"):
            return str(m["default_voice"])
        ents = _voice_entries(m)
        if ents:
            return ents[0]["id"]
    return ""

def _tts_agreement_ok(m: dict) -> bool:
    if not (m.get("license") or {}).get("agreement_required"):
        return True
    return m["id"] in _tts_terms_accepted

def _wasapi_host_index(p: "pyaudio.PyAudio") -> int | None:
    for i in range(p.get_host_api_count()):
        if "WASAPI" in p.get_host_api_info_by_index(i).get("name", ""):
            return p.get_host_api_info_by_index(i)["index"]
    return None

def _get_output_devices():
    p = pyaudio.PyAudio()
    devices, seen = [], set()
    try:
        wasapi_host = _wasapi_host_index(p)
        for i in range(p.get_device_count()):
            info = p.get_device_info_by_index(i)
            if wasapi_host is not None and info.get("hostApi") != wasapi_host:
                continue
            if info.get("isLoopbackDevice") or info.get("maxOutputChannels", 0) <= 0:
                continue
            name = info["name"]
            if name in seen:
                continue
            seen.add(name)
            devices.append({"index": i, "name": name,
                            "cable": "cable" in name.lower(),
                            "rate": int(info.get("defaultSampleRate", 48000))})
    finally:
        p.terminate()
    return devices

def _resolve_output_device(p: "pyaudio.PyAudio", name: str) -> tuple[int | None, int]:
    if name:
        wasapi_host = _wasapi_host_index(p)
        for i in range(p.get_device_count()):
            info = p.get_device_info_by_index(i)
            if wasapi_host is not None and info.get("hostApi") != wasapi_host:
                continue
            if info.get("isLoopbackDevice") or info.get("maxOutputChannels", 0) <= 0:
                continue
            if info["name"] == name:
                return i, int(info.get("defaultSampleRate", 48000))
    info = p.get_default_output_device_info()
    return int(info["index"]), int(info.get("defaultSampleRate", 48000))

def _cable_output_index(p: "pyaudio.PyAudio") -> "tuple[int, int] | None":
    wasapi_host = _wasapi_host_index(p)
    for i in range(p.get_device_count()):
        info = p.get_device_info_by_index(i)
        if wasapi_host is not None and info.get("hostApi") != wasapi_host:
            continue
        if info.get("isLoopbackDevice") or info.get("maxOutputChannels", 0) <= 0:
            continue
        if "cable" in info["name"].lower():
            return i, int(info.get("defaultSampleRate", 48000))
    return None

def _resample_pcm(samples: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst or len(samples) == 0:
        return samples
    n = int(round(len(samples) * dst / src))
    x_old = np.linspace(0.0, 1.0, num=len(samples), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
    return np.interp(x_new, x_old, samples).astype(np.float32)

_playback_q: "queue.Queue" = queue.Queue()
_playback_thread: threading.Thread | None = None
_playback_lock = threading.Lock()
_playback_abort = threading.Event()
_playback_active = threading.Event()

def _ensure_playback_thread():
    global _playback_thread
    with _playback_lock:
        if _playback_thread is None or not _playback_thread.is_alive():
            _playback_thread = threading.Thread(target=_playback_worker, daemon=True, name="tts-playback")
            _playback_thread.start()

def _play_clip(p: "pyaudio.PyAudio", pcm_bytes: bytes, src_rate: int, device_name: str):
    samples = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
    idx, dev_rate = _resolve_output_device(p, device_name)
    samples = _resample_pcm(samples, src_rate, dev_rate)
    audio = (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16)
    audio = np.concatenate([audio, np.zeros(int(dev_rate * 0.05), dtype=np.int16)])
    pos = {"i": 0}

    def _cb(in_data, frame_count, time_info, status):
        i = pos["i"]
        chunk = audio[i:i + frame_count]
        pos["i"] = i + len(chunk)
        if len(chunk) < frame_count:
            chunk = np.concatenate([chunk, np.zeros(frame_count - len(chunk), dtype=np.int16)])
            return (chunk.tobytes(), pyaudio.paComplete)
        return (chunk.tobytes(), pyaudio.paContinue)

    try:
        stream = p.open(format=pyaudio.paInt16, channels=1, rate=dev_rate, output=True,
                        output_device_index=idx, frames_per_buffer=2048, stream_callback=_cb)
    except Exception as e:
        logger.warning("TTS callback stream unavailable (%s); using blocking write", e)
        stream = p.open(format=pyaudio.paInt16, channels=1, rate=dev_rate, output=True,
                        output_device_index=idx, frames_per_buffer=16384)
        try:
            step = 16384
            for i in range(0, len(audio), step):
                if _playback_abort.is_set():
                    break
                stream.write(audio[i:i + step].tobytes())
        finally:
            stream.stop_stream()
            stream.close()
        return

    stream.start_stream()
    try:
        while stream.is_active():
            if _playback_abort.is_set():
                break
            time.sleep(0.03)
    finally:
        stream.stop_stream()
        stream.close()

def _play_clip_multi(p: "pyaudio.PyAudio", pcm_bytes: bytes, src_rate: int, device_names: list[str]):
    names = list(dict.fromkeys(device_names))
    if len(names) <= 1:
        _play_clip(p, pcm_bytes, src_rate, names[0] if names else "")
        return
    threads = [threading.Thread(target=_play_clip, args=(p, pcm_bytes, src_rate, n),
                                daemon=True) for n in names]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

def _playback_worker():
    p = pyaudio.PyAudio()
    try:
        while True:
            item = _playback_q.get()
            if item is None:
                break
            pcm_bytes, src_rate, device_names = item
            _playback_active.set()
            try:
                _play_clip_multi(p, pcm_bytes, src_rate, device_names)
            except Exception as e:
                logger.warning("TTS playback failed: %s", e)
            finally:
                _playback_active.clear()
                _playback_abort.clear()
    finally:
        p.terminate()

def _enqueue_playback(pcm_bytes: bytes, src_rate: int, device_names: list[str]):
    _ensure_playback_thread()
    _playback_q.put((pcm_bytes, src_rate, list(device_names)))

def _stop_playback():
    if _playback_thread is not None:
        _playback_q.put(None)

def _flush_playback():
    dropped = 0
    while True:
        try:
            item = _playback_q.get_nowait()
        except queue.Empty:
            break
        if item is None:
            _playback_q.put(None)
            break
        dropped += 1
    if _playback_active.is_set():
        _playback_abort.set()
    return dropped

_passthru_thread: threading.Thread | None = None
_passthru_stop = threading.Event()
_passthru_lock = threading.Lock()

PASSTHRU_FRAMES = 1024
PASSTHRU_CUSHION_S = 0.10
PASSTHRU_MAX_S = 0.30

class _PassthruBuffer:
    def __init__(self, cushion: int, maximum: int):
        self._lock = threading.Lock()
        self._buf = np.empty(0, dtype=np.int16)
        self._cushion = cushion
        self._max = maximum
        self.underruns = 0
        self.trims = 0

    def push(self, samples: np.ndarray):
        with self._lock:
            self._buf = np.concatenate([self._buf, samples])
            if len(self._buf) > self._max:
                self._buf = self._buf[len(self._buf) - self._cushion:]
                self.trims += 1

    def pop(self, n: int) -> np.ndarray:
        with self._lock:
            if len(self._buf) >= n:
                out, self._buf = self._buf[:n], self._buf[n:]
                return out
            out = np.zeros(n, dtype=np.int16)
            out[:len(self._buf)] = self._buf
            self._buf = np.empty(0, dtype=np.int16)
            self.underruns += 1
            return out

    def level(self) -> int:
        with self._lock:
            return len(self._buf)

def _resolve_input_device(p: "pyaudio.PyAudio", name: str) -> tuple[int, int, int]:
    if name:
        wasapi_host = _wasapi_host_index(p)
        for i in range(p.get_device_count()):
            info = p.get_device_info_by_index(i)
            if wasapi_host is not None and info.get("hostApi") != wasapi_host:
                continue
            if info.get("isLoopbackDevice") or info.get("maxInputChannels", 0) <= 0:
                continue
            if info["name"] == name:
                return (i, int(info.get("defaultSampleRate", 48000)),
                        int(info.get("maxInputChannels") or 1))
    info = p.get_default_input_device_info()
    return (int(info["index"]), int(info.get("defaultSampleRate", 48000)),
            int(info.get("maxInputChannels") or 1))

def _passthru_worker(stop_event: threading.Event):
    p = pyaudio.PyAudio()
    in_stream = out_stream = None
    buf = None
    mic_name = _get_mic_name()
    try:
        mic_idx, mic_rate, mic_ch = _resolve_input_device(p, mic_name)
        out_idx, out_rate = _resolve_output_device(p, _tts_output_device)
        try:
            cur = p.get_device_info_by_index(out_idx)
            if "cable" not in (cur.get("name", "").lower()):
                cab = _cable_output_index(p)
                if cab is not None:
                    out_idx, out_rate = cab
        except Exception:
            pass
        resampler = _StreamResampler(mic_rate, out_rate) if mic_rate != out_rate else None
        cushion = int(out_rate * PASSTHRU_CUSHION_S)
        buf = _PassthruBuffer(cushion, int(out_rate * PASSTHRU_MAX_S))

        def _in_cb(in_data, frame_count, time_info, status):
            audio = np.frombuffer(in_data, dtype=np.int16).astype(np.float32)
            if mic_ch > 1:
                audio = audio.reshape(-1, mic_ch).mean(axis=1)
            if resampler is not None:
                audio = resampler.process(audio)
            if len(audio):
                buf.push(np.clip(np.rint(audio), -32768, 32767).astype(np.int16))
            return (None, pyaudio.paContinue)

        def _out_cb(in_data, frame_count, time_info, status):
            return (buf.pop(frame_count).tobytes(), pyaudio.paContinue)

        in_stream = p.open(format=pyaudio.paInt16, channels=mic_ch, rate=mic_rate,
                           input=True, input_device_index=mic_idx,
                           frames_per_buffer=PASSTHRU_FRAMES, stream_callback=_in_cb)
        out_stream = p.open(format=pyaudio.paInt16, channels=1, rate=out_rate,
                            output=True, output_device_index=out_idx,
                            frames_per_buffer=PASSTHRU_FRAMES, stream_callback=_out_cb,
                            start=False)
        logger.info("Mic passthru: %s @%dHz ch=%d -> %s @%dHz",
                    mic_name or "default input", mic_rate, mic_ch,
                    _tts_output_device or "default output", out_rate)

        deadline = time.monotonic() + 2.0
        while buf.level() < cushion and time.monotonic() < deadline and not stop_event.is_set():
            time.sleep(0.005)
        out_stream.start_stream()

        while not stop_event.is_set() and in_stream.is_active() and out_stream.is_active():
            stop_event.wait(0.25)
    except Exception as e:
        logger.warning("Mic passthru stopped: %s", e)
    finally:
        if buf is not None and (buf.underruns or buf.trims):
            logger.info("Mic passthru: %d underruns, %d trims", buf.underruns, buf.trims)
        for s in (in_stream, out_stream):
            if s is not None:
                try:
                    s.stop_stream()
                    s.close()
                except Exception:
                    pass
        p.terminate()

def start_passthru():
    global _passthru_thread, _passthru_stop
    with _passthru_lock:
        if _passthru_thread is not None and _passthru_thread.is_alive():
            return
        _passthru_stop = threading.Event()
        _passthru_thread = threading.Thread(target=_passthru_worker, args=(_passthru_stop,),
                                            daemon=True, name="tts-passthru")
        _passthru_thread.start()

def stop_passthru():
    global _passthru_thread
    with _passthru_lock:
        _passthru_stop.set()
        t = _passthru_thread
        _passthru_thread = None
    if t is not None and t.is_alive():
        t.join(timeout=2)

def _passthru_active() -> bool:
    return _passthru_thread is not None and _passthru_thread.is_alive()

def _restart_passthru_if_running():
    if _passthru_enabled and _passthru_active():
        stop_passthru()
        start_passthru()

def load_config(cfg: dict):
    global _tts_voice, _tts_output_device, _tts_monitor_device, _passthru_enabled
    global _tts_terms_accepted
    if isinstance(cfg.get("tts_voice"), str):
        _tts_voice = cfg["tts_voice"]
    if isinstance(cfg.get("tts_output_device"), str):
        _tts_output_device = cfg["tts_output_device"]
    if isinstance(cfg.get("tts_monitor_device"), str):
        _tts_monitor_device = cfg["tts_monitor_device"]
    if isinstance(cfg.get("passthru_enabled"), bool):
        _passthru_enabled = cfg["passthru_enabled"]
    if isinstance(cfg.get("tts_terms_accepted"), list):
        _tts_terms_accepted = {str(x) for x in cfg["tts_terms_accepted"]}

def config_dict() -> dict:
    return {
        "tts_voice":          _tts_voice,
        "tts_output_device":  _tts_output_device,
        "tts_monitor_device": _tts_monitor_device,
        "passthru_enabled":   _passthru_enabled,
        "tts_terms_accepted": sorted(_tts_terms_accepted),
    }

def on_startup():
    if _passthru_enabled:
        start_passthru()

def on_shutdown():
    stop_passthru()
    _tts_mgr.stop()
    _stop_playback()

def on_mic_changed():
    _restart_passthru_if_running()

router = APIRouter()

@router.get("/tts/status")
def tts_status():
    packs = []
    for m in sorted(_tts_manifests(), key=lambda x: x["id"]):
        lic = m.get("license") or {}
        packs.append({
            "id": m["id"],
            "name": m.get("name", m["id"]),
            "languages": m.get("languages", []),
            "installed": bool(m.get("_available")),
            "source": m.get("_source"),
            "needs_vc_runtime": bool(m.get("needs_vc_runtime")),
            "default_voice": str(m["default_voice"]) if m.get("default_voice") is not None else None,
            "voices": _voice_entries(m),
            "agreement_required": bool(lic.get("agreement_required")),
            "terms_accepted": _tts_agreement_ok(m),
            "license": lic,
        })
    selected = _default_tts_voice()
    running_engine = _tts_mgr.engine_id if _tts_mgr.running() else None
    sel_m, _sel_v = _tts_engine_for_voice(selected)
    return {
        "installed": any(p["installed"] for p in packs),
        "running": bool(running_engine and sel_m and running_engine == sel_m["id"]),
        "running_engine": running_engine,
        "phase": _tts_mgr.startup_phase,
        "detail": _tts_mgr.startup_detail,
        "selected_voice": selected,
        "packs": packs,
        "vc_runtime": {"ok": _vc_runtime_ok(), "url": VC_REDIST_URL},
    }

@router.get("/tts/devices")
def tts_devices():
    return {"devices": _get_output_devices(), "selected": _tts_output_device,
            "monitor": _tts_monitor_device,
            "passthru": _passthru_enabled, "passthru_active": _passthru_active()}

@router.post("/tts/select")
def tts_select(payload: dict = Body(...)):
    global _tts_voice, _tts_output_device, _tts_monitor_device
    changed = False
    v = payload.get("voice")
    if isinstance(v, str) and v and _tts_engine_for_voice(v)[0] is not None:
        _tts_voice = v
        changed = True
    d = payload.get("device")
    if isinstance(d, str):
        _tts_output_device = d
        _restart_passthru_if_running()
        changed = True
    mon = payload.get("monitor")
    if isinstance(mon, str):
        _tts_monitor_device = mon
        changed = True
    if changed:
        _persist()
    return {"ok": True, "selected_voice": _default_tts_voice()}

@router.post("/tts/passthru")
def tts_passthru(payload: dict = Body(...)):
    global _passthru_enabled
    _passthru_enabled = bool(payload.get("enabled"))
    if _passthru_enabled:
        start_passthru()
    else:
        stop_passthru()
    _persist()
    return {"ok": True, "enabled": _passthru_enabled, "active": _passthru_active()}

@router.post("/tts/accept")
def tts_accept(payload: dict = Body(...)):
    engine_id = _safe_id(payload.get("engine"), "engine")
    _tts_mgr.refresh()
    m = _tts_mgr.manifests.get(engine_id)
    if not m or m.get("kind") != "tts":
        raise HTTPException(status_code=404, detail=f"Unknown TTS engine: {engine_id}")
    _tts_terms_accepted.add(engine_id)
    _persist()
    return {"ok": True, "accepted": sorted(_tts_terms_accepted)}

VOICEVOX_DOWNLOADER_URL = (
    "https://github.com/VOICEVOX/voicevox_core/releases/download/0.16.4/"
    "download-windows-x64.exe"
)
_vv_dl_lock = threading.Lock()
_vv_dl_job: dict = {"running": False, "speaker": "", "phase": "idle",
                    "detail": "", "error": None, "done": True}

def _set_vv_dl(**kw):
    with _vv_dl_lock:
        _vv_dl_job.update(**kw)

def _voicevox_download_exe() -> Path:
    exe = engine_install.MODELS_DIR / "voicevox" / "download-windows-x64.exe"
    if not exe.exists():
        exe.parent.mkdir(parents=True, exist_ok=True)
        urllib_request.urlretrieve(VOICEVOX_DOWNLOADER_URL, exe)
    return exe

def _voicevox_download_vvms(vvms: list[str]):
    target = engine_install.MODELS_DIR / "voicevox" / "voicevox_core"
    exe = _voicevox_download_exe()
    for vvm in vvms:
        _set_vv_dl(phase="downloading", detail=vvm)
        cmd = [str(exe), "--only", "models", "--models-pattern", vvm, "-o", str(target)]
        proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            proc.stdin.write("y\ny\ny\n"); proc.stdin.flush(); proc.stdin.close()
        except Exception:
            pass
        for line in proc.stdout:
            line = line.strip()
            if line:
                _set_vv_dl(phase="downloading", detail=f"{vvm}: {line[-80:]}")
        if proc.wait() != 0:
            raise RuntimeError(f"downloader exited {proc.returncode} for {vvm}")
    if _tts_mgr.running() and _tts_mgr.engine_id == "voicevox":
        _tts_mgr.stop()

@router.get("/tts/catalog")
def tts_catalog():
    present = _voicevox_present_vvms()
    m = _tts_mgr.manifests.get("voicevox", {})
    chars = []
    for c in _voicevox_catalog():
        vvms = sorted({s["vvm"] for s in c.get("styles", [])})
        have = sum(1 for s in c.get("styles", []) if s.get("vvm") in present)
        chars.append({
            "speaker": c["speaker"],
            "en": c.get("en", ""),
            "credit": c.get("credit", ""),
            "terms_url": c.get("terms_url", ""),
            "styles": [{"id": s["id"], "name": s["name"], "en": s.get("en", "")}
                       for s in c.get("styles", [])],
            "vvms": vvms,
            "downloaded": bool(vvms) and all(v in present for v in vvms),
            "styles_available": have,
        })
    return {"engine_installed": bool(m.get("_available")), "characters": chars,
            "download": dict(_vv_dl_job)}

@router.post("/tts/voices/download")
def tts_voices_download(payload: dict = Body(...)):
    m = _tts_mgr.manifests.get("voicevox")
    if not (m and m.get("_available")):
        raise HTTPException(status_code=409, detail="VOICEVOX not installed")
    if not _tts_agreement_ok(m):
        raise HTTPException(status_code=403, detail="license agreement required")
    speaker = (payload.get("speaker") or "").strip()
    entry = next((c for c in _voicevox_catalog() if c["speaker"] == speaker), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="unknown character")
    present = _voicevox_present_vvms()
    need = sorted({s["vvm"] for s in entry.get("styles", []) if s.get("vvm") not in present})
    if not need:
        return {"ok": True, "already": True}
    with _vv_dl_lock:
        if not _vv_dl_job["done"]:
            raise HTTPException(status_code=409, detail="a voice download is already running")
        _vv_dl_job.update(running=True, speaker=speaker, phase="starting",
                          detail="", error=None, done=False)

    def _go():
        try:
            _voicevox_download_vvms(need)
            _set_vv_dl(phase="done", detail="", done=True, running=False)
        except Exception as e:
            logger.exception("VOICEVOX voice download failed")
            _set_vv_dl(phase="error", error=str(e), done=True, running=False)

    threading.Thread(target=_go, daemon=True, name="vv-voice-dl").start()
    return {"ok": True, "downloading": need}

@router.get("/tts/voices/download/status")
def tts_voices_download_status():
    with _vv_dl_lock:
        return dict(_vv_dl_job)

@router.post("/tts/start")
def tts_start(payload: dict | None = Body(default=None)):
    voice = (payload or {}).get("voice") or _default_tts_voice()
    m, _v = _tts_engine_for_voice(voice)
    if not (m and m.get("_available")):
        raise HTTPException(status_code=409, detail="TTS engine not installed")
    if not _tts_agreement_ok(m):
        raise HTTPException(status_code=403, detail="license agreement required")
    engine_id = m["id"]
    lang = (m.get("languages") or ["en"])[0]
    if _tts_mgr.running() and _tts_mgr.engine_id == engine_id:
        return {"ok": True, "running": True}

    def _go():
        try:
            _tts_mgr.ensure(engine_id, lang, _model_for(engine_id))
        except Exception as e:
            logger.error("TTS engine start failed: %s", e)

    threading.Thread(target=_go, daemon=True, name="tts-start").start()
    return {"ok": True, "running": False}

@router.post("/tts/speak")
async def tts_speak(payload: dict = Body(...)):
    global _tts_voice, _tts_output_device, _tts_monitor_device
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="no text")
    voice = payload.get("voice") or _default_tts_voice()
    m, _v = _tts_engine_for_voice(voice)
    if not (m and m.get("_available")):
        raise HTTPException(status_code=409, detail="voice not available")
    if not _tts_agreement_ok(m):
        raise HTTPException(status_code=403, detail="license agreement required")
    try:
        speed = min(2.0, max(0.5, float(payload.get("speed", 1.0))))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="speed must be a number")

    changed = False
    if isinstance(payload.get("voice"), str) and payload["voice"]:
        _tts_voice = payload["voice"]; changed = True
    if isinstance(payload.get("device"), str):
        if payload["device"] != _tts_output_device:
            _tts_output_device = payload["device"]
            _restart_passthru_if_running()
        changed = True
    if isinstance(payload.get("monitor"), str):
        _tts_monitor_device = payload["monitor"]; changed = True
    if changed:
        _persist()

    engine_id = m["id"]
    lang = (m.get("languages") or ["en"])[0]
    try:
        await asyncio.to_thread(_tts_mgr.ensure, engine_id, lang, _model_for(engine_id))
    except Exception as e:
        logger.error("TTS engine start failed: %s", e)
        raise HTTPException(status_code=500, detail=f"engine start failed: {e}")
    try:
        t0 = time.perf_counter()
        pcm, rate = await asyncio.to_thread(_tts_mgr.speak, text, voice, speed)
        gen_ms = round((time.perf_counter() - t0) * 1000)
    except Exception as e:
        logger.error("TTS synthesis failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    targets = [_tts_output_device]
    if _tts_monitor_device:
        targets.append(_tts_monitor_device)
    _enqueue_playback(pcm, rate, targets)
    return {"ok": True, "sample_rate": rate, "bytes": len(pcm),
            "duration": len(pcm) / 2 / rate, "gen_ms": gen_ms}

@router.post("/tts/stop")
def tts_stop():
    dropped = _flush_playback()
    return {"ok": True, "dropped": dropped}
