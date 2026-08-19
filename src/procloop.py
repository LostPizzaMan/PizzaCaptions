from __future__ import annotations

import json
import logging
import subprocess
import sys
from pathlib import Path

import winjob

logger = logging.getLogger("procloop")

BASE_DIR = Path(__file__).resolve().parent.parent

_EXE_NAME = "PizzaAudio.exe"
_EXE_CANDIDATES = [
    BASE_DIR / "bin" / _EXE_NAME,
    BASE_DIR / "native" / "procloop" / "target" / "release" / _EXE_NAME,
]

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

def _find_exe() -> "Path | None":
    for c in _EXE_CANDIDATES:
        if c.exists():
            return c
    return None

def available() -> bool:
    if sys.platform != "win32" or _find_exe() is None:
        return False
    try:
        return sys.getwindowsversion().build >= 19041
    except Exception:
        return False

def list_programs() -> list[dict]:
    exe = _find_exe()
    if exe is None:
        return []
    try:
        out = subprocess.run(
            [str(exe), "list"], capture_output=True, text=True, timeout=5,
            creationflags=_NO_WINDOW,
        )
        data = json.loads(out.stdout or "[]")
        seen, items = set(), []
        for it in data:
            name = str(it.get("name", "")).strip()
            pid = int(it.get("pid", 0))
            if not name or pid <= 0 or name.lower() in seen:
                continue
            seen.add(name.lower())
            items.append({"pid": pid, "name": name})
        return items
    except Exception as e:
        logger.warning("procloop list failed: %s", e)
        return []

def resolve_pid(name: str) -> "int | None":
    if not name:
        return None
    want = name.strip().lower()
    for it in list_programs():
        if it["name"].lower() == want:
            return it["pid"]
    return None

class ProcLoopSource:
    def __init__(self, pid: int):
        exe = _find_exe()
        if exe is None:
            raise RuntimeError("PizzaAudio.exe not found")
        self.proc = subprocess.Popen(
            [str(exe), str(pid)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=_NO_WINDOW,
        )
        winjob.assign(self.proc)

    def read(self, nframes: int, exception_on_overflow: bool = False) -> bytes:
        need = nframes * 2
        buf = bytearray()
        while len(buf) < need:
            chunk = self.proc.stdout.read(need - len(buf))
            if not chunk:
                raise EOFError("procloop ended (target program closed)")
            buf += chunk
        return bytes(buf)

    def stop_stream(self) -> None:
        pass

    def close(self) -> None:
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=2)
                except Exception:
                    self.proc.kill()
        except Exception:
            pass
