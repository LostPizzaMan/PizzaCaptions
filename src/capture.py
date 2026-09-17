import asyncio
import json
import logging
import threading
import time
from dataclasses import dataclass

import numpy as np
import pyaudiowpatch as pyaudio
import websockets

import captions_overlay as _captions_overlay
import engine_install
import procloop as _procloop
import win_captions
from audio import _StreamResampler
from engine_base import CATALOG, ENGINES_DIR, EngineManager

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
CHUNK = 4096
GATE_HOLD_S = 0.4

_emit_ui = lambda msg, targets=None: None
_control_clients: set = set()
_get_stt_language = lambda: "en"
_get_engine_models = lambda: {}
_get_min_sound_level = lambda: 0.0
_get_overlay_owner = lambda: "them"

def configure(*, emit_ui, control_clients, get_stt_language, get_engine_models,
              get_min_sound_level, get_overlay_owner):
    global _emit_ui, _control_clients, _get_stt_language, _get_engine_models
    global _get_min_sound_level, _get_overlay_owner
    _emit_ui = emit_ui
    _control_clients = control_clients
    _get_stt_language = get_stt_language
    _get_engine_models = get_engine_models
    _get_min_sound_level = get_min_sound_level
    _get_overlay_owner = get_overlay_owner

def _tag_result(text: str, stream: str) -> str:
    try:
        obj = json.loads(text)
    except (ValueError, TypeError):
        return text
    if not isinstance(obj, dict):
        return text
    obj["stream"] = stream
    return json.dumps(obj)

def _model_for(engine_id: str) -> str:
    chosen = _get_engine_models().get(engine_id)
    if chosen:
        return chosen
    if engine_id == "whisper-batch":
        return "large-v3-turbo" if engine_install._has_nvidia_gpu() else "small"
    manifest = CATALOG.manifests.get(engine_id, {})
    return manifest.get("default_model", "default")

class EnginePool:
    def __init__(self):
        self._shared: dict[str, "EngineManager"] = {}
        self._shared_refs: dict[str, set[str]] = {}
        self._spawning: "EngineManager | None" = None

    def acquire(self, engine_id: str, language, model, *, make) -> "EngineManager":
        mgr = make()
        self._spawning = mgr
        mgr.ensure(engine_id, language, model)
        return mgr

    def release(self, mgr: "EngineManager") -> None:
        self._stop(mgr)

    def startup(self) -> "dict | None":
        m = self._spawning
        if m is None:
            return None
        return {"running": m.running(), "phase": m.startup_phase, "detail": m.startup_detail}

    def acquire_shared(self, engine_id: str, slot: str) -> "EngineManager | None":
        mgr = self._shared.get(engine_id)
        if mgr is None:
            return None
        self._shared_refs.setdefault(engine_id, set()).add(slot)
        return mgr

    def register_shared(self, engine_id: str, mgr: "EngineManager", slot: str) -> None:
        self._shared[engine_id] = mgr
        self._shared_refs.setdefault(engine_id, set()).add(slot)

    def release_shared(self, engine_id: str, slot: str) -> None:
        users = self._shared_refs.get(engine_id)
        if users is None:
            return
        users.discard(slot)
        if not users:
            self._shared_refs.pop(engine_id, None)
            mgr = self._shared.pop(engine_id, None)
            if mgr is not None:
                self._stop(mgr)

    def sharing_slots(self, mgr: "EngineManager") -> set[str]:
        for engine_id, m in list(self._shared.items()):
            if m is mgr:
                return set(self._shared_refs.get(engine_id, ()))
        return set()

    def stop_shared_all(self) -> None:
        for mgr in list(self._shared.values()):
            self._stop(mgr)
        self._shared.clear()
        self._shared_refs.clear()

    def stop_all(self) -> None:
        self.stop_shared_all()

    @staticmethod
    def _stop(mgr: "EngineManager") -> None:
        try:
            mgr.stop()
        except Exception:
            pass

_engine_pool = EnginePool()

_pa_lock = threading.Lock()

ENGINE_BUSY_CODE = 1013
ENGINE_BUSY_ATTEMPTS = 8

async def _open_engine_session(mgr: "EngineManager", stop_event: threading.Event,
                               language: str | None = None, slot: str | None = None):
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
    siblings = sorted(s for s in _engine_pool.sharing_slots(mgr)
                      if s != slot and _slot_is_live(s))
    if siblings:
        logger.warning("Engine %s is wedged but shared with slot(s) %s; refusing to restart "
                       "it (that would kill their session)", mgr.engine_id, ", ".join(siblings))
        _emit_ui({"type": "toast", "kind": "warn", "eyebrow": "Engine busy",
                  "msg": f"{mgr.engine_id} is not responding and the other transport is using "
                         "the same instance. Stop that transport, then start this one again."},
                 (_control_clients,))
        raise RuntimeError(f"engine busy: {mgr.engine_id} is shared with a running slot, "
                           "so it cannot be restarted from here")
    logger.warning("Engine still holding a session after %d attempts; restarting it",
                   ENGINE_BUSY_ATTEMPTS)
    new_port = await asyncio.to_thread(mgr.restart)
    if new_port is None:
        raise RuntimeError("engine busy: the previous session did not release in time")
    ws = await websockets.connect(_asr_url(new_port), max_size=None)
    await ws.recv()
    return ws

def _capture_worker(device_index: int, stop_event: threading.Event, mgr: "EngineManager",
                    stream_tag: str, language: str | None = None,
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

            engine_ws = await _open_engine_session(mgr, stop_event, language, stream_tag)

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
                    threshold = _get_min_sound_level() if is_mic else 0.0
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
                                  and stream_tag == _get_overlay_owner())
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

@dataclass
class Slot:
    mgr: "EngineManager"
    thread: threading.Thread
    stop: threading.Event
    shared_engine: "str | None" = None
    device: int = -1
    language: "str | None" = None
    program: "str | None" = None
    is_mic: bool = True

_slots: dict[str, Slot] = {}
_DEFAULT_ENGINE = "nano"
_SHARED_ENGINES = {"qwen3", "whisper-batch"}

_spawning_slots: dict[str, "tuple[str, str, str | None]"] = {}

def _slot_is_live(slot: str) -> bool:
    s = _slots.get(slot)
    if s is not None:
        return s.thread.is_alive()
    return slot in _spawning_slots

def spawning_specs() -> "list[tuple[str, str, str | None]]":
    return list(_spawning_slots.values())

def _cfg_is_mic(slot: str, cfg: dict) -> bool:
    v = cfg.get("is_mic")
    return (slot == "you") if v is None else bool(v)

def _slot_diff(slot: str, live: "Slot", cfg: dict) -> "list[str]":
    engine = cfg.get("engine") or _DEFAULT_ENGINE
    dev = cfg.get("device")
    req_dev = int(dev) if dev is not None else -1
    model = cfg.get("model") or _model_for(engine)
    is_mic = _cfg_is_mic(slot, cfg)
    pairs = (("engine", live.mgr.engine_id, engine),
             ("device", live.device, req_dev),
             ("program", live.program, cfg.get("program")),
             ("language", live.language, cfg.get("language")),
             ("model", live.mgr.model, model),
             ("is_mic", live.is_mic, is_mic))
    return [f"{name}: {have!r} -> {want!r}" for name, have, want in pairs if have != want]

def _slot_matches(slot: str, live: "Slot", cfg: dict) -> bool:
    return not _slot_diff(slot, live, cfg)

def _unify_shared_models(requested: dict) -> None:
    you, them = requested.get("you"), requested.get("them")
    if not you or not them:
        return
    eng = you.get("engine") or _DEFAULT_ENGINE
    if eng not in _SHARED_ENGINES or (them.get("engine") or _DEFAULT_ENGINE) != eng:
        return
    want = you.get("model") or _model_for(eng)
    have = them.get("model") or _model_for(eng)
    if have == want:
        return
    logger.info("slot them: model %r -> %r (one %s instance serves both slots; You decides)",
                have, want, eng)
    requested["them"] = dict(them, model=want)
    _emit_ui({"type": "toast", "kind": "warn", "eyebrow": "Shared model",
              "msg": f"Them uses You's {eng} model ({want}): one instance serves both slots."},
             (_control_clients,))

class SlotStartError(RuntimeError):
    def __init__(self, slot: str, cause: BaseException):
        super().__init__(str(cause))
        self.slot = slot
        self.running = sorted(_slots)

def set_slots(slots: dict) -> None:
    requested = {slot: cfg for slot, cfg in slots.items()
                 if cfg and (cfg.get("device") is not None or cfg.get("program"))}
    _unify_shared_models(requested)
    shared_users: "dict[str, list[str]]" = {}
    for s, live in _slots.items():
        if live.shared_engine is not None:
            shared_users.setdefault(live.shared_engine, []).append(s)
    for eng, users in shared_users.items():
        adding = any(s not in _slots and (c.get("engine") or _DEFAULT_ENGINE) == eng
                     for s, c in requested.items())
        if len(users) < 2 and not adding:
            continue
        stale = any(
            requested.get(s) is not None
            and ((requested[s].get("engine") or _DEFAULT_ENGINE) != eng
                 or _slots[s].mgr.model != (requested[s].get("model") or _model_for(eng)))
            for s in users)
        if stale:
            logger.info("slots %s: stop (shared %s changes engine/model; the one instance "
                        "cannot reload in place)", "+".join(sorted(users)), eng)
            for s in users:
                stop_slot(s)
    for slot in list(_slots):
        if slot not in requested:
            logger.info("slot %s: stop (no longer requested)", slot)
            stop_slot(slot)
    touched: list[str] = []
    slot = ""
    try:
        for slot, cfg in requested.items():
            live = _slots.get(slot)
            if live is not None:
                diff = _slot_diff(slot, live, cfg)
                if not diff:
                    logger.info("slot %s: keep (%s %s unchanged)", slot,
                                live.mgr.engine_id, live.mgr.model)
                    continue
                logger.info("slot %s: respawn (%s)", slot, ", ".join(diff))
            else:
                logger.info("slot %s: start (%s %s, language %r, device %r, program %r)", slot,
                            cfg.get("engine") or _DEFAULT_ENGINE, cfg.get("model") or "default",
                            cfg.get("language"), cfg.get("device"), cfg.get("program"))
            touched.append(slot)
            if live is not None:
                reconfigure_slot(slot, cfg)
            else:
                _start_slot(slot, cfg)
    except Exception as e:
        for s in touched:
            stop_slot(s)
        raise SlotStartError(slot, e) from e

def _start_slot(slot: str, cfg: dict) -> None:
    dev = cfg.get("device")
    program = cfg.get("program")
    if dev is None and not program:
        return
    engine = cfg.get("engine") or _DEFAULT_ENGINE
    lang = cfg.get("language")
    if not lang or lang == "auto":
        lang = _get_stt_language()
    model = cfg.get("model") or _model_for(engine)
    dev_idx = int(dev) if dev is not None else -1
    slot_lang = cfg.get("language")
    _spawning_slots[slot] = (engine, model, slot_lang)
    try:
        shared_engine = None
        if engine in _SHARED_ENGINES:
            mgr = _engine_pool.acquire_shared(engine, slot)
            if mgr is not None and mgr.model != model:
                logger.warning("slot %s: attached to the running %s instance on model %r, not "
                               "the requested %r (set_slots should have unified these)",
                               slot, engine, mgr.model, model)
            if mgr is None:
                mgr = EngineManager(ENGINES_DIR)
                mgr.refresh()
                if not mgr.available(engine):
                    raise RuntimeError(f"{engine} engine not installed")
                mgr.ensure(engine, lang, model)
                _engine_pool.register_shared(engine, mgr, slot)
            shared_engine = engine
        else:
            def _make() -> "EngineManager":
                m = EngineManager(ENGINES_DIR)
                m.refresh()
                if not m.available(engine):
                    raise RuntimeError(f"{engine} engine not installed")
                return m
            mgr = _engine_pool.acquire(engine, lang, model, make=_make)
        is_mic = _cfg_is_mic(slot, cfg)
        stop = threading.Event()
        t = threading.Thread(target=_capture_worker,
                             args=(dev_idx, stop, mgr, slot, slot_lang, is_mic, program), daemon=True)
        _slots[slot] = Slot(mgr, t, stop, shared_engine, dev_idx, slot_lang, program, is_mic)
        t.start()
    finally:
        _spawning_slots.pop(slot, None)

def reconfigure_slot(slot: str, cfg: dict) -> None:
    if slot not in _slots:
        return
    stop_slot(slot)
    _start_slot(slot, cfg)

def stop_slot(slot: str) -> None:
    s = _slots.pop(slot, None)
    if s is None:
        return
    s.stop.set()
    if s.thread.is_alive():
        s.thread.join(timeout=3)
    if s.shared_engine is not None:
        _engine_pool.release_shared(s.shared_engine, slot)
    else:
        _engine_pool.release(s.mgr)

def restart_slot(slot: str) -> None:
    s = _slots.get(slot)
    if s is None or (s.device < 0 and not s.program):
        return
    s.stop.set()
    if s.thread.is_alive():
        s.thread.join(timeout=3)
    s.stop = threading.Event()
    s.thread = threading.Thread(target=_capture_worker,
                                args=(s.device, s.stop, s.mgr, slot, s.language, s.is_mic, s.program), daemon=True)
    s.thread.start()

def stop_all_slots() -> None:
    for s in _slots.values():
        s.stop.set()
    for s in _slots.values():
        if s.thread.is_alive():
            s.thread.join(timeout=3)
    for s in _slots.values():
        if s.shared_engine is None:
            _engine_pool.release(s.mgr)
    _engine_pool.stop_shared_all()
    _slots.clear()
