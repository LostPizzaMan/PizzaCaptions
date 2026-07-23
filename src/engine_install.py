import json
import logging
import os
import shutil
import subprocess
import sys
import tarfile
import threading
from pathlib import Path
from urllib import request as urllib_request

import winjob

logger = logging.getLogger(__name__)

LOCAL_DATA_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "LiveTranscription"
PACKS_DIR = LOCAL_DATA_DIR / "engines"
MODELS_DIR = LOCAL_DATA_DIR / "models"
CACHE_DIR = LOCAL_DATA_DIR / "cache"

PYTHON_STANDALONE_URL = (
    "https://github.com/astral-sh/python-build-standalone/releases/download/"
    "20250115/cpython-3.12.8+20250115-x86_64-pc-windows-msvc-install_only.tar.gz"
)

_SHERPA = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
SILERO_VAD_URL = f"{_SHERPA}/silero_vad.onnx"
PARAKEET_MODEL_ARCHIVES = {
    "parakeet-tdt-0.6b-v3-int8": {
        "url": f"{_SHERPA}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
        "extracted": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    },
    "parakeet-ja": {
        "url": f"{_SHERPA}/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8.tar.bz2",
        "extracted": "sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8",
    },
}

_job_lock = threading.Lock()
_job: dict = {"engine": None, "phase": "idle", "detail": "", "error": None, "done": True}


def get_job() -> dict:
    with _job_lock:
        return dict(_job)


def _set_job(**kw):
    with _job_lock:
        _job.update(kw)


def _find_uv() -> str:
    candidates = [
        Path(sys.executable).parent / "uv.exe",
        Path(sys.executable).parent.parent / "uv.exe",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    found = shutil.which("uv")
    if found:
        return found
    raise RuntimeError("uv.exe not found, cannot install engine dependencies")


def _has_nvidia_gpu() -> bool:
    return shutil.which("nvidia-smi") is not None


def _download(url: str, dest: Path, phase: str):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        return
    tmp = dest.with_suffix(dest.suffix + ".part")

    def hook(blocks, block_size, total):
        if total > 0:
            done_mb = blocks * block_size / 1e6
            _set_job(phase=phase, detail=f"{done_mb:.0f} / {total / 1e6:.0f} MB")

    try:
        urllib_request.urlretrieve(url, tmp, reporthook=hook)
        tmp.rename(dest)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def _run_uv(uv: str, python: Path, args: list[str], phase: str):
    cmd = [uv, "pip", "install", "--python", str(python)] + args
    logger.info("engine-install: %s", " ".join(cmd))
    env = dict(os.environ)
    env["UV_CACHE_DIR"] = str(CACHE_DIR / "uv")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", env=env,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    winjob.assign(proc)
    output_lines = []
    for line in proc.stdout:
        line = line.strip()
        if line:
            output_lines.append(line)
            _set_job(phase=phase, detail=line[-120:])
    if proc.wait() != 0:
        full_output = "\n".join(output_lines)
        logger.error("uv pip install failed (exit %d), full output:\n%s", proc.returncode, full_output)
        tail = " | ".join(output_lines[-15:]) or "(no output captured)"
        raise RuntimeError(f"dependency install failed (uv exit {proc.returncode}): {tail}")


def _install_python(dest: Path):
    archive = CACHE_DIR / PYTHON_STANDALONE_URL.rsplit("/", 1)[-1]
    _download(PYTHON_STANDALONE_URL, archive, "downloading-python")
    _set_job(phase="extracting-python", detail="")
    with tarfile.open(archive) as tf:
        tf.extractall(dest)
    if not (dest / "python" / "python.exe").exists():
        raise RuntimeError("python-build-standalone layout unexpected")


def download_parakeet_model(model_id: str):

    spec = PARAKEET_MODEL_ARCHIVES.get(model_id)
    if spec is None:
        raise ValueError(f"Unknown parakeet model: {model_id}")
    target = MODELS_DIR / "parakeet"
    target.mkdir(parents=True, exist_ok=True)

    vad = target / "silero_vad.onnx"
    if not vad.exists():
        _download(SILERO_VAD_URL, vad, "downloading-models")

    model_dir = target / model_id
    if not model_dir.exists():
        archive = CACHE_DIR / f"{model_id}.tar.bz2"
        _download(spec["url"], archive, "downloading-models")
        _set_job(phase="extracting-models", detail="")
        with tarfile.open(archive) as tf:
            tf.extractall(target)
        (target / spec["extracted"]).rename(model_dir)
        archive.unlink(missing_ok=True)


def start_model_download(model_id: str) -> bool:
    with _job_lock:
        if not _job["done"]:
            return False
        _job.update(engine="parakeet", phase="starting", detail="", error=None, done=False)

    def run():
        try:
            download_parakeet_model(model_id)
            _set_job(phase="done", detail="", done=True)
        except Exception as e:
            logger.exception("Model download failed")
            _set_job(phase="error", error=str(e), done=True)

    threading.Thread(target=run, daemon=True).start()
    return True


def _install_parakeet_models(dev_models: Path | None):
    target = MODELS_DIR / "parakeet"
    target.mkdir(parents=True, exist_ok=True)

    if dev_models and dev_models.exists():
        _set_job(phase="copying-models", detail=str(dev_models))
        for item in dev_models.iterdir():
            dst = target / item.name
            if dst.exists():
                continue
            if item.is_dir():
                shutil.copytree(item, dst)
            else:
                shutil.copy2(item, dst)
        return

    download_parakeet_model("parakeet-tdt-0.6b-v3-int8")


def install(engine_id: str, source_dir: Path, repo_dir: Path):
    _set_job(engine=engine_id, phase="starting", detail="", error=None, done=False)
    dest = PACKS_DIR / engine_id
    try:
        uv = _find_uv()

        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True)

        for name in ("engine.json", "engine_server.py", "requirements.txt"):
            src = source_dir / name
            if src.exists():
                shutil.copy2(src, dest / name)

        _install_python(dest)
        python = dest / "python" / "python.exe"

        manifest = json.loads((dest / "engine.json").read_text(encoding="utf-8"))
        if manifest.get("torch_cuda_index") and _has_nvidia_gpu():
            idx = manifest["torch_cuda_index"]
            _run_uv(uv, python,
                    ["torch==2.11.0", "torchaudio==2.11.0",
                     "--index-url", f"https://download.pytorch.org/whl/{idx}"],
                    "installing-torch")
        _run_uv(uv, python, ["-r", str(dest / "requirements.txt")], "installing-deps")

        if engine_id == "parakeet":
            _install_parakeet_models(repo_dir / "stt-parakeet" / "models")
            manifest["models_dir"] = "../../models/parakeet"

        manifest["python"] = "python/python.exe"
        manifest["installed"] = True
        (dest / "engine.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        _set_job(phase="done", detail="", done=True)
        logger.info("Engine %s installed to %s", engine_id, dest)
    except Exception as e:
        logger.exception("Engine install failed")
        _set_job(phase="error", error=str(e), done=True)


def start_install(engine_id: str, source_dir: Path, repo_dir: Path) -> bool:
    with _job_lock:
        if not _job["done"]:
            return False
        _job.update(engine=engine_id, phase="starting", detail="", error=None, done=False)
    threading.Thread(target=install, args=(engine_id, source_dir, repo_dir), daemon=True).start()
    return True


def remove(engine_id: str):
    dest = PACKS_DIR / engine_id
    if dest.exists():
        shutil.rmtree(dest)
