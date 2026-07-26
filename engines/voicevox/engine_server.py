import argparse
import asyncio
import io
import logging
import os
import subprocess
import sys
import threading
import wave
from pathlib import Path
from urllib.request import urlopen

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("voicevox-engine")

SAMPLE_RATE = 24000
DEFAULT_STYLE_ID = 3

VVOX_VERSION = "0.16.4"
DOWNLOADER_URL = (
    f"https://github.com/VOICEVOX/voicevox_core/releases/download/{VVOX_VERSION}/"
    "download-windows-x64.exe"
)
MODELS = ["0.vvm", "15.vvm"]

_synth = None
_synth_lock = threading.Lock()
_models_dir: Path | None = None


def _download_file(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urlopen(url) as r:
        total = int(r.headers.get("Content-Length", 0))
        got = 0
        with open(tmp, "wb") as f:
            while True:
                buf = r.read(1 << 20)
                if not buf:
                    break
                f.write(buf)
                got += len(buf)
                if total:
                    print(f"\rDownloading {dest.name}: {got >> 20}/{total >> 20} MiB "
                          f"({100 * got / total:4.1f}%)", end="", flush=True)
                else:
                    print(f"\rDownloading {dest.name}: {got >> 20} MiB", end="", flush=True)
    print(flush=True)
    tmp.replace(dest)


def _asset_paths(base: Path):

    from voicevox_core.blocking import Onnxruntime
    ort_dll = base / "onnxruntime" / "lib" / Onnxruntime.LIB_VERSIONED_FILENAME
    dict_dirs = sorted((base / "dict").glob("open_jtalk_dic*"))
    vvm_files = sorted((base / "models" / "vvms").glob("*.vvm"))
    return ort_dll, (dict_dirs[0] if dict_dirs else None), vvm_files


def _assets_present(base: Path) -> bool:
    ort_dll, dict_dir, vvm_files = _asset_paths(base)
    if not (ort_dll.exists() and dict_dir is not None):
        return False
    have = {p.name for p in vvm_files}
    return all(m in have for m in MODELS)


def _run_downloader(exe: Path, target: Path, pattern: str, only_models: bool = False) -> None:

    scope = ["--only", "models"] if only_models else ["--exclude", "c-api"]
    cmd = [str(exe), *scope, "--models-pattern", pattern, "-o", str(target)]
    logger.info("Fetching VOICEVOX %s (%s) ...", pattern,
                "model" if only_models else "runtime + dictionary + model")
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        proc.stdin.write("y\ny\ny\n")
        proc.stdin.flush()
        proc.stdin.close()
    except Exception:
        pass
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            print(line, flush=True)
    if proc.wait() != 0:
        raise RuntimeError(f"VOICEVOX downloader exited with code {proc.returncode}")


def _ensure_assets() -> Path:
    assert _models_dir is not None
    base = _models_dir / "voicevox_core"
    if _assets_present(base):
        return base
    exe = _models_dir / "download-windows-x64.exe"
    if not exe.exists():
        _download_file(DOWNLOADER_URL, exe)
    for i, model in enumerate(MODELS):
        _run_downloader(exe, base, model, only_models=(i > 0))
    if not _assets_present(base):
        raise RuntimeError("VOICEVOX assets missing after download (see log)")
    return base


def _load() -> None:

    global _synth
    from voicevox_core.blocking import Onnxruntime, OpenJtalk, Synthesizer, VoiceModelFile
    base = _ensure_assets()
    ort_dll, dict_dir, vvm_files = _asset_paths(base)
    logger.info("Loading VOICEVOX ONNX Runtime ...")
    onnxruntime = Onnxruntime.load_once(filename=str(ort_dll))
    synth = Synthesizer(
        onnxruntime, OpenJtalk(str(dict_dir)),
        acceleration_mode="CPU", cpu_num_threads=max(os.cpu_count() or 2, 2),
    )
    for vvm in vvm_files:
        with VoiceModelFile.open(str(vvm)) as model:
            synth.load_voice_model(model)
    _synth = synth
    logger.info("VOICEVOX ready (%d voice model file(s) loaded).", len(vvm_files))


def _do_synth(text: str, style_id: int, speed: float) -> tuple[bytes, int]:
    with _synth_lock:
        aq = _synth.create_audio_query(text, style_id)
        try:
            if speed and abs(speed - 1.0) > 1e-3:
                aq.speed_scale = speed
        except Exception:
            logger.warning("Could not apply speed=%s to VOICEVOX query", speed)
        wav = _synth.synthesis(aq, style_id)
    with wave.open(io.BytesIO(wav), "rb") as w:
        return w.readframes(w.getnframes()), w.getframerate()


app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok", "engine": "voicevox"}


@app.post("/speak")
async def speak(req: Request):
    try:
        body = await req.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "no text"}, status_code=400)
    try:
        style_id = int(body.get("voice") or DEFAULT_STYLE_ID)
    except (TypeError, ValueError):
        style_id = DEFAULT_STYLE_ID
    try:
        speed = float(body.get("speed", 1.0))
    except (TypeError, ValueError):
        return JSONResponse({"error": "speed must be a number"}, status_code=400)

    try:
        pcm, rate = await asyncio.to_thread(_do_synth, text, style_id, speed)
    except Exception as e:
        logger.error("Synthesis failed: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)

    return Response(content=pcm, media_type="application/octet-stream",
                    headers={"X-Sample-Rate": str(rate)})


def main():
    global _models_dir
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--language", default="ja")
    parser.add_argument("--model", default="voicevox")
    parser.add_argument("--models-dir", required=True)
    args = parser.parse_args()

    _models_dir = Path(args.models_dir)
    _load()
    logger.info("Listening on 127.0.0.1:%d", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
