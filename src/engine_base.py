import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path
from urllib import request as urllib_request

import engine_install
import winjob

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
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
        self.recent_output: deque[str] = deque(maxlen=25)

    def refresh(self):
        manifests: dict[str, dict] = {}
        for base, source in ((self.engines_dir, "dev"), (engine_install.PACKS_DIR, "installed")):
            if not base.exists():
                continue
            for mf in sorted(base.glob("*/engine.json")):
                try:
                    m = json.loads(mf.read_text(encoding="utf-8"))
                    m.setdefault("kind", "asr")
                    m["_dir"] = mf.parent
                    m["_source"] = source
                    complete = bool(m.get("installed")) if source == "installed" else True
                    m["_available"] = complete and (mf.parent / m.get("python", "")).resolve().exists()
                    if m["id"] in manifests and not m["_available"]:
                        continue
                    if manifests.get(m["id"], {}).get("needs_vc_runtime"):
                        m.setdefault("needs_vc_runtime", True)
                    for field in ("name", "description", "languages"):
                        app_val = manifests.get(m["id"], {}).get(field)
                        if app_val:
                            m[field] = app_val
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

    def restart(self) -> int | None:
        with self.lock:
            if self.engine_id is None:
                return None
            engine_id, language, model = self.engine_id, self.language, self.model
            self._stop_locked()
            self._spawn_locked(engine_id, language, model)
            return self.port

    def _stop_locked(self):
        if self.proc is not None:
            if self.proc.poll() is None:
                logger.info("Stopping engine %s (pid %d)", self.engine_id, self.proc.pid)
                self._terminate_tree(self.proc)
            self.proc = None
        self.port = self.engine_id = self.language = self.model = None
        self.startup_phase = self.startup_detail = ""

    @staticmethod
    def _terminate_tree(proc):
        if sys.platform == "win32":
            try:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                               timeout=10)
            except Exception as e:
                logger.warning("taskkill failed for pid %d (%s); using kill()", proc.pid, e)
                proc.kill()
            try:
                proc.wait(timeout=5)
            except Exception:
                pass
        else:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    def _spawn_locked(self, engine_id: str, language: str, model: str):
        self.startup_phase, self.startup_detail = "loading", ""
        manifest = self.manifests.get(engine_id)
        if manifest is None:
            raise ValueError(f"Unknown engine: {engine_id}")
        edir: Path = manifest["_dir"]
        if manifest["_source"] == "installed":
            app_dir = self.engines_dir / engine_id
            for src in app_dir.glob("*.py"):
                dst = edir / src.name
                if not dst.exists() or src.stat().st_mtime > dst.stat().st_mtime:
                    shutil.copy2(src, dst)
                    logger.info("Updated %s pack code (%s) from app copy", engine_id, src.name)
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
        self.recent_output.clear()
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
                raise RuntimeError(self._startup_failure(engine_id, code))
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

    def _startup_failure(self, engine_id: str, code: int | None) -> str:
        tail = list(self.recent_output)
        blob, last = "\n".join(tail), (tail[-1] if tail else "")
        if "ModuleNotFoundError" in blob:
            return (f"Engine {engine_id} is missing its dependencies (incomplete install) - "
                    f"reinstall it from Settings. ({last})")
        if "DLL load failed" in blob:
            return (f"Engine {engine_id} could not load its native libraries. Install the "
                    f"Microsoft Visual C++ Redistributable (x64) and try again. ({last})")
        return f"Engine {engine_id} exited with code {code} during startup (see log)"

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
                        self.recent_output.append(line)
                else:
                    buf.append(ch)
        except Exception:
            pass
