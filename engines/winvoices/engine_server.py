import argparse
import asyncio
import io
import json
import logging
import sys
import wave

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("winvoices-engine")

app = FastAPI()

def _short_lang(bcp47: str) -> str:
    return (bcp47 or "en").split("-")[0].lower()

def _all_voices():
    from winsdk.windows.media.speechsynthesis import SpeechSynthesizer
    try:
        return list(SpeechSynthesizer.all_voices)
    except Exception:
        return list(SpeechSynthesizer.get_all_voices())

def _list_voices() -> list[dict]:
    out = []
    for v in _all_voices():
        out.append({"id": v.id, "name": v.display_name,
                    "lang": _short_lang(v.language), "bcp47": v.language,
                    "gender": "female" if int(v.gender) == 1 else "male"})
    return out

async def _synth(text: str, voice_id: str, speed: float) -> tuple[bytes, int]:
    from winsdk.windows.media.speechsynthesis import SpeechSynthesizer
    from winsdk.windows.storage.streams import DataReader

    synth = SpeechSynthesizer()
    if voice_id:
        match = next((v for v in _all_voices() if v.id == voice_id), None)
        if match is not None:
            synth.voice = match
    try:
        synth.options.speaking_rate = max(0.5, min(6.0, float(speed)))
    except Exception:
        pass

    stream = await synth.synthesize_text_to_stream_async(text)
    size = int(stream.size)
    reader = DataReader(stream.get_input_stream_at(0))
    await reader.load_async(size)
    buf = bytearray(size)
    reader.read_bytes(buf)

    with wave.open(io.BytesIO(bytes(buf)), "rb") as w:
        rate = w.getframerate()
        channels = w.getnchannels()
        pcm = w.readframes(w.getnframes())
    if channels == 2:
        import audioop
        pcm = audioop.tomono(pcm, 2, 0.5, 0.5)
    return pcm, rate

@app.get("/health")
def health():
    return {"status": "ok", "engine": "winvoices"}

@app.get("/voices")
def voices():
    return {"voices": _list_voices()}

@app.post("/speak")
async def speak(req: Request):
    try:
        body = await req.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "no text"}, status_code=400)
    voice = body.get("voice") or ""
    try:
        speed = float(body.get("speed", 1.0))
    except (TypeError, ValueError):
        return JSONResponse({"error": "speed must be a number"}, status_code=400)
    try:
        pcm, rate = await _synth(text, voice, speed)
    except Exception as e:
        logger.error("Synthesis failed: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)
    return Response(content=pcm, media_type="application/octet-stream",
                    headers={"X-Sample-Rate": str(rate)})

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int)
    parser.add_argument("--language", default="en")
    parser.add_argument("--model", default="default")
    parser.add_argument("--models-dir", default=None)
    parser.add_argument("--list-voices", action="store_true",
                        help="print the OS voices as JSON and exit (the shell "
                             "uses this to populate the picker without serving)")
    args = parser.parse_args()

    if args.list_voices:
        print(json.dumps({"voices": _list_voices()}, ensure_ascii=True))
        return
    if args.port is None:
        parser.error("--port is required to serve")

    try:
        n = len(_list_voices())
    except Exception as e:
        logger.error("winsdk voice enumeration failed: %s", e)
        raise SystemExit(1)
    logger.info("Windows Voices ready (%d voices), listening on 127.0.0.1:%d", n, args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")

if __name__ == "__main__":
    main()
