import argparse
import asyncio
import logging
import os
import re
import threading
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

import numpy as np
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("supertonic-engine")

SAMPLE_RATE = 44100
DEFAULT_VOICE = "F1"
MODEL = "supertonic-3"

THREADS = max(1, int(os.environ.get("SUPERTONIC_THREADS", "4")))

REPOS = ("Supertone/supertonic-3", "supertone-oss-archive/supertonic-3")
FILES = (
    "onnx/tts.json",
    "onnx/unicode_indexer.json",
    "onnx/duration_predictor.onnx",
    "onnx/text_encoder.onnx",
    "onnx/vector_estimator.onnx",
    "onnx/vocoder.onnx",
    "voice_styles/F1.json",
    "voice_styles/F2.json",
    "voice_styles/F3.json",
    "voice_styles/F4.json",
    "voice_styles/F5.json",
    "voice_styles/M1.json",
    "voice_styles/M2.json",
    "voice_styles/M3.json",
    "voice_styles/M4.json",
    "voice_styles/M5.json",
)

_tts = None
_styles: dict = {}
_langs: frozenset = frozenset()
_fallback_lang = "en"
_synth_lock = threading.Lock()
_models_dir: Path | None = None

def _download(rel: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    last_err = None
    for repo in REPOS:
        url = f"https://huggingface.co/{repo}/resolve/main/{rel}"
        try:
            with urlopen(url) as r:
                total = int(r.headers.get("Content-Length", 0))
                got = 0
                chunk = 1 << 20
                loud = total >= (4 << 20)
                with open(tmp, "wb") as f:
                    while True:
                        buf = r.read(chunk)
                        if not buf:
                            break
                        f.write(buf)
                        got += len(buf)
                        if loud:
                            print(f"\rDownloading {dest.name}: {got >> 20}MiB/{total >> 20}MiB "
                                  f"({100 * got // max(total, 1)}%)", end="", flush=True)
            if loud:
                print(flush=True)
            tmp.replace(dest)
            return
        except (URLError, OSError) as e:
            last_err = e
            logger.warning("%s failed from %s: %s", rel, repo, e)
    tmp.unlink(missing_ok=True)
    raise RuntimeError(f"could not download {rel}: {last_err}")

def _ensure_model() -> Path:
    assert _models_dir is not None
    root = _models_dir / MODEL
    missing = [rel for rel in FILES
               if not (root / rel).exists() or (root / rel).stat().st_size == 0]
    if missing:
        print(f"Downloading Supertonic model ({len(missing)} files, ~390 MB) ...", flush=True)
    for rel in missing:
        _download(rel, root / rel)
    return root

def _load() -> None:
    global _tts, _styles, _langs
    import supertonic

    root = _ensure_model()
    logger.info("Loading Supertonic model (%d ONNX threads) ...", THREADS)
    _tts = supertonic.TTS(model=MODEL, model_dir=str(root), auto_download=False,
                          intra_op_num_threads=THREADS)
    for p in sorted((root / "voice_styles").glob("*.json")):
        try:
            _styles[p.stem] = _tts.get_voice_style(p.stem)
        except Exception as e:
            logger.warning("voice style %s failed to load: %s", p.stem, e)
    _langs = frozenset(getattr(supertonic, "AVAILABLE_LANGUAGES", ("en",)))
    logger.info("Supertonic ready: %d voices, %d languages.", len(_styles), len(_langs))

_HANGUL = re.compile("[\uac00-\ud7af\u1100-\u11ff]")
_KANA = re.compile("[\u3040-\u30ff]")
_HAN = re.compile("[\u4e00-\u9fff\u3400-\u4dbf]")

def _script_lang(text: str) -> "str | None":
    if _HANGUL.search(text):
        return "ko"
    if _KANA.search(text) or _HAN.search(text):
        return "ja"
    return None

def _resolve_lang(want: str, text: str) -> str:
    want = (want or "").strip().lower()
    script = _script_lang(text)
    if script and script in _langs and script != want:
        if want:
            logger.info("caller said %r but the text is %s; synthesizing as %s",
                        want, script, script)
        return script
    for cand in (want, _fallback_lang):
        cand = (cand or "").strip().lower()
        if cand and cand in _langs:
            return cand
    if want:
        logger.info("language %r not supported; using language-agnostic mode", want)
    return "na" if "na" in _langs else "en"

def _synth(text: str, voice: str, speed: float, lang: str) -> bytes:
    style = _styles.get(voice) or _styles.get(DEFAULT_VOICE)
    if style is None:
        raise RuntimeError("no voice styles loaded")
    with _synth_lock:
        audio, _ = _tts.synthesize(text, style, speed=speed, lang=lang)
    samples = np.asarray(audio, dtype=np.float32).squeeze()
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok", "engine": "supertonic"}

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
    lang = _resolve_lang(str(body.get("lang") or ""), text)

    try:
        pcm = await asyncio.to_thread(_synth, text, voice, speed, lang)
    except Exception as e:
        logger.error("Synthesis failed: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)

    return Response(content=pcm, media_type="application/octet-stream",
                    headers={"X-Sample-Rate": str(SAMPLE_RATE)})

def main():
    global _models_dir, _fallback_lang
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--language", default="en")
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--models-dir", required=True)
    args = parser.parse_args()

    _models_dir = Path(args.models_dir)
    _fallback_lang = args.language or "en"
    _load()
    logger.info("Listening on 127.0.0.1:%d", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")

if __name__ == "__main__":
    main()
