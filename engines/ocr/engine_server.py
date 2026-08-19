import argparse
import asyncio
import base64
import logging
import os
import tempfile
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request, Response

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("ocr-engine")

OCR_THREADS = int(os.environ.get("OCR_THREADS") or max(1, (os.cpu_count() or 4) // 2))

TIERS = {
    "tiny":   ("PP-OCRv6_tiny_det",   "PP-OCRv6_tiny_rec"),
    "small":  ("PP-OCRv6_small_det",  "PP-OCRv6_small_rec"),
    "medium": ("PP-OCRv6_medium_det", "PP-OCRv6_medium_rec"),
}

_ocr = None
_predict_lock = threading.Lock()

def _providers() -> list[str]:
    try:
        import onnxruntime as ort
        avail = set(ort.get_available_providers())
    except Exception:
        avail = set()
    order = ["DmlExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"]
    picked = [p for p in order if p in avail] or ["CPUExecutionProvider"]
    logger.info("ONNX providers available=%s -> using %s", sorted(avail), picked)
    return picked

def _load(models_dir: Path, tier: str):
    global _ocr
    if tier not in TIERS:
        raise ValueError(f"Unknown OCR tier {tier!r}; expected one of {list(TIERS)}")
    det_name, rec_name = TIERS[tier]
    det_dir = models_dir / f"{det_name}_onnx"
    rec_dir = models_dir / f"{rec_name}_onnx"
    for d in (det_dir, rec_dir):
        if not d.exists():
            raise FileNotFoundError(f"PP-OCRv6 ONNX model dir not found: {d}")

    from paddleocr import PaddleOCR
    _ocr = PaddleOCR(
        device="cpu",
        engine="onnxruntime",
        engine_config={"providers": _providers(), "intra_op_num_threads": OCR_THREADS},
        text_detection_model_name=det_name,
        text_detection_model_dir=str(det_dir),
        text_recognition_model_name=rec_name,
        text_recognition_model_dir=str(rec_dir),
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )
    logger.info("PP-OCRv6 %s ready (%d ONNX threads)", tier, OCR_THREADS)

def _xywh(boxes, polys, i) -> list[float] | None:
    if boxes is not None and i < len(boxes):
        x0, y0, x1, y1 = (float(v) for v in boxes[i])
        return [x0, y0, x1 - x0, y1 - y0]
    if polys is not None and i < len(polys):
        xs = [float(pt[0]) for pt in polys[i]]
        ys = [float(pt[1]) for pt in polys[i]]
        return [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]
    return None

def _recognize(img_path: str) -> list[dict]:
    lines: list[dict] = []
    with _predict_lock:
        results = _ocr.predict(img_path)
    for res in results:
        payload = getattr(res, "json", None)
        payload = payload.get("res", payload) if isinstance(payload, dict) else res
        texts = payload.get("rec_texts", []) or []
        scores = payload.get("rec_scores", []) or []
        boxes = payload.get("rec_boxes", None)
        polys = payload.get("rec_polys", None)
        for i, text in enumerate(texts):
            lines.append({
                "text": text,
                "score": float(scores[i]) if i < len(scores) else None,
                "box": _xywh(boxes, polys, i),
            })
    return lines

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok" if _ocr is not None else "loading", "engine": "ocr"}

@app.get("/capture")
def capture():
    import mss
    import mss.tools
    with mss.MSS() as sct:
        mon = sct.monitors[0]
        shot = sct.grab(mon)
        png = mss.tools.to_png(shot.rgb, shot.size)
    return {
        "png": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
        "width": shot.width,
        "height": shot.height,
        "left": mon["left"],
        "top": mon["top"],
    }

@app.post("/ocr")
async def ocr(request: Request):
    if _ocr is None:
        return Response(status_code=503, content="engine still loading")
    data = await request.body()
    if not data:
        return {"lines": []}
    fd, path = tempfile.mkstemp(suffix=".png", prefix="ocr_")
    os.close(fd)
    try:
        Path(path).write_bytes(data)
        t0 = time.perf_counter()
        lines = await asyncio.to_thread(_recognize, path)
        elapsed = time.perf_counter() - t0
        logger.info("OCR: %d lines in %.2fs (%d bytes)", len(lines), elapsed, len(data))
        return {"lines": lines, "ocr_ms": round(elapsed * 1000)}
    except Exception as e:
        logger.exception("OCR failed")
        return Response(status_code=500, content=f"ocr error: {e}")
    finally:
        try:
            os.remove(path)
        except OSError:
            pass

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--language", default="multi")
    parser.add_argument("--model", default="medium")
    parser.add_argument("--models-dir", required=True)
    args = parser.parse_args()

    _load(Path(args.models_dir), args.model)
    logger.info("Listening on 127.0.0.1:%d", args.port)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")

if __name__ == "__main__":
    main()
