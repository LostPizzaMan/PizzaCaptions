import argparse
import asyncio
import logging
import sys
import threading
from pathlib import Path
from urllib.request import urlopen

import numpy as np
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("kokoro-ja-engine")

SAMPLE_RATE = 24000
DEFAULT_VOICE = "jf_alpha"

ASSETS = {
    "kokoro-v1.0.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    "voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
}

_kokoro = None
_ja_g2p = None
_synth_lock = threading.Lock()
_models_dir: Path | None = None

def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urlopen(url) as r:
        total = int(r.headers.get("Content-Length", 0))
        got = 0
        chunk = 1 << 20
        with open(tmp, "wb") as f:
            while True:
                buf = r.read(chunk)
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

def _ensure_model() -> tuple[Path, Path]:
    assert _models_dir is not None
    paths = {}
    for name, url in ASSETS.items():
        p = _models_dir / name
        if not p.exists():
            logger.info("Fetching %s ...", name)
            _download(url, p)
        paths[name] = p
    return paths["kokoro-v1.0.onnx"], paths["voices-v1.0.bin"]

def _load_kokoro() -> None:
    global _kokoro
    from kokoro_onnx import Kokoro
    model_path, voices_path = _ensure_model()
    logger.info("Loading Kokoro model ...")
    _kokoro = Kokoro(str(model_path), str(voices_path))
    logger.info("Kokoro (JA) model ready.")

def _japanese_phonemes(text: str) -> str | None:
    global _ja_g2p
    try:
        import jaconv
        import pyopenjtalk
        from misaki import ja
    except ImportError:
        return None
    if _ja_g2p is None:
        _ja_g2p = ja.JAG2P()
    hira = jaconv.kata2hira(pyopenjtalk.g2p(text, kana=True))
    phonemes, _ = _ja_g2p(hira)
    return phonemes.replace(" ː", "ː")

def _synth(text: str, voice: str, speed: float) -> bytes:
    with _synth_lock:
        phonemes = _japanese_phonemes(text)
        if phonemes:
            samples, sr = _kokoro.create(phonemes, voice=voice, speed=speed, is_phonemes=True)
        else:
            logger.warning("Japanese G2P deps missing; falling back to espeak (readings will be wrong).")
            samples, sr = _kokoro.create(text, voice=voice, speed=speed, lang="ja")
    if sr != SAMPLE_RATE:
        logger.warning("Unexpected sample rate %d from Kokoro", sr)
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok", "engine": "kokoro-ja"}

@app.post("/speak")
async def speak(req: Request):
    try:
        body = await req.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "no text"}, status_code=400)
    voice = body.get("voice") or DEFAULT_VOICE
    try:
        speed = float(body.get("speed", 1.0))
    except (TypeError, ValueError):
        return JSONResponse({"error": "speed must be a number"}, status_code=400)

    try:
        pcm = await asyncio.to_thread(_synth, text, voice, speed)
    except Exception as e:
        logger.error("Synthesis failed: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)

    return Response(content=pcm, media_type="application/octet-stream",
                    headers={"X-Sample-Rate": str(SAMPLE_RATE)})

def main():
    global _models_dir
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--language", default="ja")
    parser.add_argument("--model", default="default")
    parser.add_argument("--models-dir", required=True)
    args = parser.parse_args()

    _models_dir = Path(args.models_dir)
    _load_kokoro()
    logger.info("Listening on 127.0.0.1:%d", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")

if __name__ == "__main__":
    main()
