import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import threading
import time
import zipfile
from pathlib import Path
from urllib import request as urllib_request

import winjob

logger = logging.getLogger(__name__)

LOCAL_DATA_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "LiveTranscription"
PACKS_DIR = LOCAL_DATA_DIR / "engines"
MODELS_DIR = LOCAL_DATA_DIR / "models"
CACHE_DIR = LOCAL_DATA_DIR / "cache"

_TAR_SAFE = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}

PYTHON_STANDALONE_URL = (
    "https://github.com/astral-sh/python-build-standalone/releases/download/"
    "20250115/cpython-3.12.8+20250115-x86_64-pc-windows-msvc-install_only.tar.gz"
)

_SHERPA = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
_BUNDLED_SILERO_VAD = Path(__file__).resolve().parent / "data" / "silero_vad.onnx"
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

FUNASR_LLAMACPP_URL = (
    "https://github.com/modelscope/FunASR/releases/download/v1.3.29/"
    "funasr-llamacpp-windows-x64-avx2.zip"
)
_NANO_GGUF = "https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-GGUF/resolve/main"
NANO_MODEL_FILES = {
    "funasr-encoder-f16.gguf": f"{_NANO_GGUF}/funasr-encoder-f16.gguf",
    "qwen3-0.6b-q8_0.gguf": f"{_NANO_GGUF}/qwen3-0.6b-q8_0.gguf",
}

_LLAMACPP_REL = "https://github.com/ggml-org/llama.cpp/releases/download/b10149"
QWEN3_RUNTIME_URLS = (
    f"{_LLAMACPP_REL}/llama-b10149-bin-win-cuda-12.4-x64.zip",
    f"{_LLAMACPP_REL}/cudart-llama-bin-win-cuda-12.4-x64.zip",
)
_QWEN3_GGUF = "https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/main"
QWEN3_MODEL_FILES = {
    "Qwen3-ASR-1.7B-Q8_0.gguf": f"{_QWEN3_GGUF}/Qwen3-ASR-1.7B-Q8_0.gguf",
    "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf": f"{_QWEN3_GGUF}/mmproj-Qwen3-ASR-1.7B-Q8_0.gguf",
}

_PPOCR_HF = "https://huggingface.co/PaddlePaddle"
_PPOCR_FILES = ("inference.onnx", "inference.json", "inference.yml")
OCR_MODEL_REPOS = {
    "tiny":   ("PP-OCRv6_tiny_det_onnx",   "PP-OCRv6_tiny_rec_onnx"),
    "small":  ("PP-OCRv6_small_det_onnx",  "PP-OCRv6_small_rec_onnx"),
    "medium": ("PP-OCRv6_medium_det_onnx", "PP-OCRv6_medium_rec_onnx"),
}

JADICT_DICT_URL = (
    "https://github.com/LostPizzaMan/PizzaCaptions-Assets/releases/download/"
    "dictionary/jadict.sqlite"
)

_job_lock = threading.Lock()
_job: dict = {"engine": None, "phase": "idle", "detail": "", "error": None, "done": True}

def get_job() -> dict:
    with _job_lock:
        return dict(_job)

def _set_job(**kw):
    with _job_lock:
        _job.update(kw)

_cancel_ev = threading.Event()
_cur_proc: "subprocess.Popen | None" = None

class _Cancelled(Exception):
    pass

def cancel_job():
    _cancel_ev.set()
    p = _cur_proc
    if p is not None and p.poll() is None:
        try:
            p.terminate()
        except Exception:
            pass

def _fake_download() -> bool:
    return os.environ.get("LT_FAKE_DOWNLOAD", "") not in ("", "0", "false", "False")

def _simulate_download(phase: str = "downloading-models", seconds: float = 6.0):
    steps = 40
    logger.info("LT_FAKE_DOWNLOAD: simulating a %.0fs download (%s)", seconds, phase)
    for i in range(steps + 1):
        if _cancel_ev.is_set():
            raise _Cancelled()
        _set_job(phase=phase, detail=f"{i * 100 // steps}%")
        time.sleep(seconds / steps)

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

_DL_TIMEOUT = 60

def _download(url: str, dest: Path, phase: str):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        return
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with urllib_request.urlopen(url, timeout=_DL_TIMEOUT) as r:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            with open(tmp, "wb") as f:
                while True:
                    if _cancel_ev.is_set():
                        raise _Cancelled()
                    chunk = r.read(262144)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    _set_job(phase=phase, detail=(f"{done / 1e6:.0f} / {total / 1e6:.0f} MB"
                                                  if total else f"{done / 1e6:.0f} MB"))
        if total and done < total:
            raise RuntimeError(f"download truncated: {done} of {total} bytes")
        tmp.rename(dest)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise

def _install_silero_vad(dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(_BUNDLED_SILERO_VAD, dest)

_SILERO_V5_MIN_BYTES = 1_500_000

def migrate_silero_vad() -> None:
    if not MODELS_DIR.exists() or not _BUNDLED_SILERO_VAD.exists():
        return
    for d in MODELS_DIR.iterdir():
        vad = d / "silero_vad.onnx"
        try:
            if not vad.exists() or vad.stat().st_size >= _SILERO_V5_MIN_BYTES:
                continue
            shutil.copy2(_BUNDLED_SILERO_VAD, vad)
            logger.info("Upgraded silero VAD to v5 in %s", d.name)
        except Exception as e:
            logger.warning("silero v5 migration skipped for %s: %s", d.name, e)

def _extract_or_purge(archive: Path, extract):
    try:
        extract()
    except Exception:
        archive.unlink(missing_ok=True)
        raise

def _run_uv(uv: str, python: Path, args: list[str], phase: str, cwd: Path | None = None):
    cmd = [uv, "pip", "install", "--python", str(python)] + args
    logger.info("engine-install: %s", " ".join(cmd))
    env = dict(os.environ)
    env["UV_CACHE_DIR"] = str(CACHE_DIR / "uv")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", env=env,
                            cwd=str(cwd) if cwd else None,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    winjob.assign(proc)
    global _cur_proc
    _cur_proc = proc
    output_lines = []
    try:
        for line in proc.stdout:
            if _cancel_ev.is_set():
                proc.terminate()
                break
            line = line.strip()
            if line:
                output_lines.append(line)
                _set_job(phase=phase, detail=line[-120:])
        code = proc.wait()
    finally:
        _cur_proc = None
    if _cancel_ev.is_set():
        raise _Cancelled()
    if code != 0:
        full_output = "\n".join(output_lines)
        logger.error("uv pip install failed (exit %d), full output:\n%s", code, full_output)
        tail = " | ".join(output_lines[-15:]) or "(no output captured)"
        raise RuntimeError(f"dependency install failed (uv exit {code}): {tail}")

def _install_python(dest: Path):
    archive = CACHE_DIR / PYTHON_STANDALONE_URL.rsplit("/", 1)[-1]
    _download(PYTHON_STANDALONE_URL, archive, "downloading-python")
    _set_job(phase="extracting-python", detail="")
    def _x():
        with tarfile.open(archive) as tf:
            tf.extractall(dest, **_TAR_SAFE)
    _extract_or_purge(archive, _x)
    if not (dest / "python" / "python.exe").exists():
        raise RuntimeError("python-build-standalone layout unexpected")

def download_parakeet_model(model_id: str):
    if _fake_download():
        _simulate_download(); return
    spec = PARAKEET_MODEL_ARCHIVES.get(model_id)
    if spec is None:
        raise ValueError(f"Unknown parakeet model: {model_id}")
    target = MODELS_DIR / "parakeet"
    target.mkdir(parents=True, exist_ok=True)

    vad = target / "silero_vad.onnx"
    if not vad.exists():
        _install_silero_vad(vad)

    model_dir = target / model_id
    if not model_dir.exists():
        archive = CACHE_DIR / f"{model_id}.tar.bz2"
        _download(spec["url"], archive, "downloading-models")
        _set_job(phase="extracting-models", detail="")
        def _x():
            with tarfile.open(archive) as tf:
                tf.extractall(target, **_TAR_SAFE)
        _extract_or_purge(archive, _x)
        (target / spec["extracted"]).rename(model_dir)
        archive.unlink(missing_ok=True)

def start_model_download(model_id: str) -> bool:
    with _job_lock:
        if not _job["done"]:
            return False
        _cancel_ev.clear()
        _job.update(engine="parakeet", phase="starting", detail="", error=None, done=False)

    def run():
        try:
            download_parakeet_model(model_id)
            _set_job(phase="done", detail="", done=True)
        except _Cancelled:
            _set_job(phase="cancelled", detail="", error=None, done=True)
        except Exception as e:
            logger.exception("Model download failed")
            _set_job(phase="error", error=str(e), done=True)

    threading.Thread(target=run, daemon=True).start()
    return True

_DL_PCT_RE = re.compile(r"(\d{1,3})%")

def _whisper_dl_detail(line: str) -> str | None:
    low = line.lower()
    if not ("%|" in line or "b/s" in low or "download" in low
            or "fetching" in low or "reconstructing" in low):
        return None
    m = _DL_PCT_RE.search(line)
    return f"{m.group(1)}%" if m else "downloading..."

_WHISPER_DL_RUNNER = Path(__file__).resolve().parent / "whisper_dl_runner.py"

def whisper_model_dir(model: str) -> Path:
    return MODELS_DIR / "whisper" / model

def download_whisper_model(engine_python: Path, model: str):
    global _cur_proc
    if _fake_download():
        _simulate_download(); return
    dest = whisper_model_dir(model)
    dest.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen([str(engine_python), str(_WHISPER_DL_RUNNER), model, str(dest)],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace",
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    winjob.assign(proc)
    _cur_proc = proc
    buf: list[str] = []
    tail: list[str] = []
    try:
        while True:
            ch = proc.stdout.read(1)
            if not ch:
                break
            if ch in ("\r", "\n"):
                line = "".join(buf).strip(); buf.clear()
                if not line:
                    continue
                tail.append(line)
                del tail[:-15]
                detail = _whisper_dl_detail(line)
                if detail:
                    _set_job(phase="downloading-models", detail=detail)
            else:
                buf.append(ch)
        code = proc.wait()
    finally:
        _cur_proc = None
    if _cancel_ev.is_set():
        raise _Cancelled()
    if code != 0:
        raise RuntimeError("whisper model download failed: " + (" | ".join(tail[-5:]) or "no output"))

def start_whisper_model_download(engine_python: Path, model: str) -> bool:
    with _job_lock:
        if not _job["done"]:
            return False
        _cancel_ev.clear()
        _job.update(engine="whisper", phase="starting", detail="", error=None, done=False)

    def run():
        try:
            download_whisper_model(engine_python, model)
            _set_job(phase="done", detail="", done=True)
        except _Cancelled:
            _set_job(phase="cancelled", detail="", error=None, done=True)
        except Exception as e:
            logger.exception("Whisper model download failed")
            _set_job(phase="error", error=str(e), done=True)

    threading.Thread(target=run, daemon=True).start()
    return True

def start_jadict_download() -> bool:
    with _job_lock:
        if not _job["done"]:
            return False
        _cancel_ev.clear()
        _job.update(engine="jadict", phase="starting", detail="", error=None, done=False)

    def run():
        try:
            download_jadict_dict()
            _set_job(phase="done", detail="", done=True)
        except _Cancelled:
            _set_job(phase="cancelled", detail="", error=None, done=True)
        except Exception as e:
            logger.exception("Dictionary download failed")
            _set_job(phase="error", error=str(e), done=True)

    threading.Thread(target=run, daemon=True).start()
    return True

def remove_jadict_data():
    target = MODELS_DIR / "jadict"
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)

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

def download_nano_models():
    target = MODELS_DIR / "nano"
    target.mkdir(parents=True, exist_ok=True)

    vad = target / "silero_vad.onnx"
    if not vad.exists():
        _install_silero_vad(vad)
    for name, url in NANO_MODEL_FILES.items():
        dst = target / name
        if not dst.exists():
            _download(url, dst, "downloading-models")

def _install_nano_binary(dest: Path):
    bin_dir = dest / "bin"
    if (bin_dir / "llama-funasr-cli.exe").exists():
        return
    bin_dir.mkdir(parents=True, exist_ok=True)
    archive = CACHE_DIR / FUNASR_LLAMACPP_URL.rsplit("/", 1)[-1]
    _download(FUNASR_LLAMACPP_URL, archive, "downloading-runtime")
    _set_job(phase="extracting-runtime", detail="")
    def _x():
        with zipfile.ZipFile(archive) as zf:
            for member in zf.namelist():
                if member.endswith("/"):
                    continue
                data = zf.read(member)
                (bin_dir / Path(member).name).write_bytes(data)
    _extract_or_purge(archive, _x)
    if not (bin_dir / "llama-funasr-cli.exe").exists():
        raise RuntimeError("llama-funasr-cli.exe missing from FunASR runtime archive")

def download_ocr_models(tier: str = "medium"):
    repos = OCR_MODEL_REPOS.get(tier)
    if repos is None:
        raise ValueError(f"Unknown OCR tier: {tier}")
    target = MODELS_DIR / "ocr"
    for repo in repos:
        for fname in _PPOCR_FILES:
            dst = target / repo / fname
            if not dst.exists():
                _download(f"{_PPOCR_HF}/{repo}/resolve/main/{fname}", dst, "downloading-models")

def _valid_jadict(path: Path) -> bool:
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            return con.execute("SELECT COUNT(*) FROM entries").fetchone()[0] > 0
        finally:
            con.close()
    except Exception:
        return False

def download_jadict_dict():
    if _fake_download():
        _simulate_download(); return
    target = MODELS_DIR / "jadict"
    target.mkdir(parents=True, exist_ok=True)
    dst = target / "jadict.sqlite"

    if dst.exists() and _valid_jadict(dst):
        return
    if dst.exists():
        dst.unlink()

    _download(JADICT_DICT_URL, dst, "downloading-models")
    if not _valid_jadict(dst):
        dst.unlink(missing_ok=True)
        raise RuntimeError(
            "downloaded jadict.sqlite is not a valid dictionary (corrupt or "
            "truncated download); check the release asset.")

def download_qwen3_models():
    target = MODELS_DIR / "qwen3"
    target.mkdir(parents=True, exist_ok=True)
    vad = target / "silero_vad.onnx"
    if not vad.exists():
        _install_silero_vad(vad)
    for name, url in QWEN3_MODEL_FILES.items():
        dst = target / name
        if not dst.exists():
            _download(url, dst, "downloading-models")

def _install_qwen3_runtime():
    bin_dir = MODELS_DIR / "qwen3" / "bin"
    if (bin_dir / "llama-server.exe").exists():
        return
    bin_dir.mkdir(parents=True, exist_ok=True)
    for url in QWEN3_RUNTIME_URLS:
        archive = CACHE_DIR / url.rsplit("/", 1)[-1]
        _download(url, archive, "downloading-runtime")
        _set_job(phase="extracting-runtime", detail="")
        def _x(archive=archive):
            with zipfile.ZipFile(archive) as zf:
                for member in zf.namelist():
                    if member.endswith("/"):
                        continue
                    (bin_dir / Path(member).name).write_bytes(zf.read(member))
        _extract_or_purge(archive, _x)
    if not (bin_dir / "llama-server.exe").exists():
        raise RuntimeError("llama-server.exe missing from the llama.cpp CUDA archive")

def install(engine_id: str, source_dir: Path, repo_dir: Path):
    _set_job(engine=engine_id, phase="starting", detail="", error=None, done=False)
    dest = PACKS_DIR / engine_id
    partial = False
    try:
        if _fake_download():
            _simulate_download(phase="installing-deps")
            _set_job(phase="done", detail="", done=True)
            return
        uv = _find_uv()

        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True)
        partial = True

        shutil.copytree(source_dir, dest, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("python", "__pycache__"))

        _install_python(dest)
        python = dest / "python" / "python.exe"

        manifest = json.loads((dest / "engine.json").read_text(encoding="utf-8"))
        if manifest.get("torch_cuda_index") and _has_nvidia_gpu():
            idx = manifest["torch_cuda_index"]
            _run_uv(uv, python,
                    ["torch==2.11.0", "torchaudio==2.11.0",
                     "--index-url", f"https://download.pytorch.org/whl/{idx}"],
                    "installing-torch")
        _run_uv(uv, python, ["-r", "requirements.txt"], "installing-deps", cwd=dest)

        if engine_id == "parakeet":
            _install_parakeet_models(repo_dir / "stt-parakeet" / "models")
            manifest["models_dir"] = "../../models/parakeet"
        elif engine_id == "parakeet-stream":
            _install_parakeet_models(repo_dir / "stt-parakeet" / "models")
        elif engine_id == "qwen3":
            if not _has_nvidia_gpu():
                raise RuntimeError(
                    "Qwen3-ASR requires an NVIDIA GPU (no nvidia-smi found). "
                    "On CPU it runs at about 2x realtime, too slow for live captions.")
            _install_qwen3_runtime()
            download_qwen3_models()
            manifest["models_dir"] = "../../models/qwen3"
        elif engine_id == "nano":
            _install_nano_binary(dest)
            download_nano_models()
            manifest["models_dir"] = "../../models/nano"
        elif engine_id == "ocr":
            download_ocr_models(manifest.get("default_model", "medium"))
            manifest["models_dir"] = "../../models/ocr"
        elif engine_id == "whisper-batch":
            if _has_nvidia_gpu():
                _run_uv(uv, python, ["nvidia-cublas-cu12", "nvidia-cudnn-cu12>=9,<10"],
                        "installing-cuda")
            wdir = MODELS_DIR / "whisper"
            wdir.mkdir(parents=True, exist_ok=True)
            vad = wdir / "silero_vad.onnx"
            if not vad.exists():
                _install_silero_vad(vad)

        manifest["python"] = "python/python.exe"
        manifest["installed"] = True
        (dest / "engine.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        partial = False
        _set_job(phase="done", detail="", done=True)
        logger.info("Engine %s installed to %s", engine_id, dest)
    except _Cancelled:
        if partial:
            shutil.rmtree(dest, ignore_errors=True)
        _set_job(phase="cancelled", detail="", error=None, done=True)
    except Exception as e:
        logger.exception("Engine install failed")
        if partial:
            shutil.rmtree(dest, ignore_errors=True)
        _set_job(phase="error", error=str(e), done=True)

def start_install(engine_id: str, source_dir: Path, repo_dir: Path) -> bool:
    with _job_lock:
        if not _job["done"]:
            return False
        _cancel_ev.clear()
        _job.update(engine=engine_id, phase="starting", detail="", error=None, done=False)
    threading.Thread(target=install, args=(engine_id, source_dir, repo_dir), daemon=True).start()
    return True

def remove(engine_id: str):
    dest = PACKS_DIR / engine_id
    if dest.exists():
        shutil.rmtree(dest)
