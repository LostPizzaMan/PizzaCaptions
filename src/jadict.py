import asyncio
import gzip
import json
import logging
import os
import sqlite3
import threading
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

import engine_install

logger = logging.getLogger(__name__)

_DB_PATH = engine_install.MODELS_DIR / "jadict" / "jadict.sqlite"

_DATA_DIR = Path(__file__).resolve().parent / "data"
_meta: "dict | None" = None
_priority: "dict | None" = None
_uk: "set | None" = None
_rare: "set | None" = None
_data_lock = threading.Lock()

def _load_jmdict_meta() -> None:
    global _meta, _priority, _uk, _rare
    with _data_lock:
        if _meta is not None:
            return
        try:
            _meta = json.loads(gzip.decompress((_DATA_DIR / "jmdict_meta.json.gz").read_bytes()))
        except Exception as e:
            logger.warning("JMdict metadata unavailable (%s)", e)
            _meta = {}
        _priority = _meta.get("priority", {})
        _uk = set(_meta.get("uk", []))
        _rare = set(_meta.get("rare", []))

def _rare_set() -> set:
    if _rare is None:
        _load_jmdict_meta()
    return _rare

def _priority_data() -> "tuple[dict, set]":
    if _priority is None:
        _load_jmdict_meta()
    return _priority, _uk

def _is_rare_kanji(kanji: str, reading: str) -> bool:
    return f"{kanji}\t{reading}" in _rare_set()

_NO_PRIORITY = 9

def _form_priority(entry: dict, surface: str) -> int:
    kana = entry.get("kana", [])
    reading = kana[0] if kana else ""
    pkanji = (entry.get("kanji") or [""])[0]
    return _priority_data()[0].get(f"{surface}\t{reading}\t{pkanji}", _NO_PRIORITY)

def _is_kana(s: str) -> bool:
    return bool(s) and all("぀" <= c <= "ヿ" for c in s)

def _kata2hira(s: str) -> str:
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in (s or ""))

def _reading_miss(entry: dict, reading_h: str) -> int:
    if not reading_h:
        return 1
    return 0 if reading_h in {_kata2hira(k) for k in entry.get("kana", [])} else 1

def _kana_primary(entry: dict) -> bool:
    kana = entry.get("kana", [])
    reading = kana[0] if kana else ""
    pkanji = (entry.get("kanji") or [""])[0]
    if f"{reading}\t{pkanji}" in _priority_data()[1]:
        return True
    return not [k for k in entry.get("kanji", []) if not _is_rare_kanji(k, reading)]

_dict: "sqlite3.Connection | None" = None
_dict_lock = threading.Lock()

def _db_present() -> bool:
    return _DB_PATH.exists()

def _open() -> bool:
    global _dict
    with _dict_lock:
        if _dict is not None:
            return True
        if not _DB_PATH.exists():
            return False
        _dict = sqlite3.connect(f"file:{_DB_PATH}?mode=ro", uri=True, check_same_thread=False)
        n = _dict.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        logger.info("JMdict loaded: %d entries (%s)", n, _DB_PATH)
        return True

def _close() -> None:
    global _dict
    with _dict_lock:
        if _dict is not None:
            try:
                _dict.close()
            except Exception:
                pass
            _dict = None

def _dict_lookup(surface: str) -> list[dict]:
    with _dict_lock:
        if _dict is None:
            return []
        rows = _dict.execute(
            "SELECT e.payload FROM keys k JOIN entries e ON e.eid = k.eid WHERE k.surface = ?",
            (surface,)).fetchall()
    return [json.loads(r[0]) for r in rows]

_POS_MAP = {
    "名詞": ("n", "pn", "adj-no", "num", "adj-na"), "代名詞": ("pn",), "動詞": ("v",),
    "形容詞": ("adj-i",), "形状詞": ("adj-na",), "形容動詞": ("adj-na",),
    "副詞": ("adv",), "助詞": ("prt",), "接続詞": ("conj",), "感動詞": ("int",),
    "連体詞": ("adj-pn",), "助動詞": ("aux", "cop"),
}

def _pos_targets(pos: str) -> tuple:
    return _POS_MAP.get((pos or "").strip(), ())

def _entry_matches_pos(entry: dict, targets: tuple) -> bool:
    for sense in entry.get("senses", []):
        for p in sense.get("pos", []):
            if any(p == t or p.startswith(t) for t in targets):
                return True
    return False

_MAX_CARDS = 6

def _clean_kanji(form: str) -> bool:
    return (any("一" <= c <= "鿿" for c in form)
            and not any("！" <= c <= "～" or c in "〃々仝〇○" for c in form))

def _entry_headword(entry: dict, surface: str) -> str:
    kanji = entry.get("kanji", [])
    if surface in kanji:
        return surface
    kana = entry.get("kana", [])
    reading = kana[0] if kana else ""
    pkanji = kanji[0] if kanji else ""
    if f"{reading}\t{pkanji}" in _priority_data()[1]:
        return surface
    for k in kanji:
        if not _is_rare_kanji(k, reading) and _clean_kanji(k):
            return k
    return surface

def _entry_card(entry: dict, surface: str) -> dict:
    kana = entry.get("kana", [])
    return {"headword": _entry_headword(entry, surface), "reading": kana[0] if kana else "",
            "readings": kana, "common": entry.get("common", False),
            "senses": entry["senses"][:5]}

def _entry_relevant(entry: dict, surface: str) -> bool:
    kana = entry.get("kana", [])
    return surface in entry.get("kanji", []) or (bool(kana) and surface == kana[0])

_POTENTIAL_EROW = {"え": "う", "け": "く", "げ": "ぐ", "せ": "す", "て": "つ",
                   "ね": "ぬ", "べ": "ぶ", "め": "む", "れ": "る"}

def _depotential_candidates(word: str) -> list:
    cands = []
    if len(word) > 3 and word.endswith("られる"):
        cands.append(word[:-3] + "る")
    if len(word) >= 2 and word.endswith("る") and word[-2] in _POTENTIAL_EROW:
        cands.append(word[:-2] + _POTENTIAL_EROW[word[-2]])
    return cands

def _potential_lookup(word: str, pos: str, targets: tuple, reading: str = "") -> list:
    if not (pos or "").startswith("動詞"):
        return []
    for cand in _depotential_candidates(word):
        cards = _lookup_cards(cand, targets, reading)
        if cards:
            return cards
    return []

def _lookup_cards(surface: str, targets: tuple, reading: str = "") -> list:
    entries = _dict_lookup(surface)
    if not entries:
        return []
    kana_click = _is_kana(surface)
    reading_h = _kata2hira(reading)
    entries = sorted(entries, key=lambda e: (
        bool(targets) and not _entry_matches_pos(e, targets),
        0 if (kana_click and surface in e.get("kana", []) and e.get("common", False)
              and _kana_primary(e)) else 1,
        _form_priority(e, surface),
        not e.get("common", False),
        _reading_miss(e, reading_h),
    ))
    kept = [e for e in entries if _entry_relevant(e, surface)] or entries[:1]
    return [_entry_card(e, surface) for e in kept[:_MAX_CARDS]]

def _do_lookup(word: str, pos: str, base: str, reading: str = "") -> dict:
    targets = _pos_targets(pos)
    out = {"word": word, "results": [], "matched": 0}
    if word:
        cards = _lookup_cards(word, targets, reading) or _potential_lookup(word, pos, targets, reading)
        if cards:
            out = {"word": word, "matched": len(word), "results": cards}
        else:
            for end in range(len(word) - 1, 0, -1):
                cards = _lookup_cards(word[:end], targets)
                if cards:
                    out = {"word": word[:end], "matched": end, "results": cards}
                    break
    if base:
        bcards = _lookup_cards(base, targets, reading) or _potential_lookup(base, pos, targets, reading)
        out["base"] = {"word": base, "results": bcards}
    return out

router = APIRouter()

@router.get("/lang/status")
def lang_status():
    return {"installed": _db_present(), "running": _dict is not None, "phase": "", "detail": ""}

@router.post("/lang/start")
def lang_start():
    _open()
    return {"ok": True, "running": _dict is not None}

@router.post("/lang/stop")
def lang_stop():
    _close()
    return {"ok": True}

@router.post("/lang/lookup")
async def lang_lookup(payload: dict = Body(...)):
    word = (payload.get("word") or "").strip()
    pos = payload.get("pos") or ""
    base = payload.get("base") or ""
    reading = payload.get("reading") or ""
    if not word:
        raise HTTPException(status_code=400, detail="no word")
    if not _db_present():
        raise HTTPException(status_code=409, detail="Dictionary data not installed")
    _open()
    try:
        return await asyncio.to_thread(_do_lookup, word, pos, base, reading)
    except Exception as e:
        logger.error("Lookup failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

_SUDACHI_DIR = engine_install.MODELS_DIR / "sudachi"
_SUDACHI_DIC = _SUDACHI_DIR / "system.dic"
_SUDACHI_FLAG = _SUDACHI_DIR / "enabled"
_SUDACHI_URL = ("https://files.pythonhosted.org/packages/46/fe/"
                "68a146fced55319af40d25a4fe19b94c3a988406ce4674a8b2f0237fbc9f/"
                "sudachidict_core-20260723-py3-none-any.whl")
_SUDACHI_SHA256 = "b3869ce6b12b4bfa09575dc19030703bb669ab41bac12a74cafcbb28c6be2498"
_sudachi = None
_sudachi_lock = threading.Lock()
_sudachi_dl_lock = threading.Lock()
_sudachi_dl = {"downloading": False, "progress": 0.0, "error": ""}

def _sudachi_available() -> bool:
    if not _SUDACHI_DIC.exists():
        return False
    try:
        import sudachipy
        return True
    except ImportError:
        return False

def _sudachi_enabled() -> bool:
    return _SUDACHI_FLAG.exists()

def _sudachi_tokenizer():
    global _sudachi
    if _sudachi is None:
        with _sudachi_lock:
            if _sudachi is None:
                from sudachipy import Dictionary, Config
                _sudachi = Dictionary(config=Config(system=str(_SUDACHI_DIC))).create()
    return _sudachi

def warm_sudachi() -> None:
    if _sudachi_available():
        threading.Thread(target=_sudachi_tokenizer, daemon=True).start()

def _download_sudachi_dict() -> None:
    import urllib.request
    import zipfile
    import shutil
    import hashlib
    tmp_whl = _SUDACHI_DIR / "_dl.part"
    try:
        _SUDACHI_DIR.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        with urllib.request.urlopen(_SUDACHI_URL, timeout=60) as r:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            with open(tmp_whl, "wb") as f:
                while True:
                    chunk = r.read(262144)
                    if not chunk:
                        break
                    f.write(chunk)
                    digest.update(chunk)
                    done += len(chunk)
                    if total:
                        with _sudachi_dl_lock:
                            _sudachi_dl["progress"] = round(done / total, 3)
        if digest.hexdigest() != _SUDACHI_SHA256:
            raise ValueError("dictionary checksum mismatch")
        with zipfile.ZipFile(tmp_whl) as z:
            name = next(n for n in z.namelist() if n.endswith("resources/system.dic"))
            part = _SUDACHI_DIR / "system.dic.part"
            with z.open(name) as src, open(part, "wb") as out:
                shutil.copyfileobj(src, out, 1048576)
            os.replace(part, _SUDACHI_DIC)
            for lic in (n for n in z.namelist() if n.endswith("LICENSE-2.0.txt")):
                with z.open(lic) as src, open(_SUDACHI_DIR / "LICENSE-2.0.txt", "wb") as out:
                    shutil.copyfileobj(src, out)
        with _sudachi_dl_lock:
            _sudachi_dl.update(downloading=False, progress=1.0, error="")
    except Exception as e:
        logger.error("Sudachi dict download failed: %s", e)
        with _sudachi_dl_lock:
            _sudachi_dl.update(downloading=False, error=str(e))
    finally:
        tmp_whl.unlink(missing_ok=True)

def _do_tokenize(text: str) -> dict:
    from sudachipy import SplitMode
    tok = _sudachi_tokenizer()
    toks = []
    with _sudachi_lock:
        for m in tok.tokenize(text, SplitMode.C):
            p = m.part_of_speech()
            toks.append({
                "surface": m.surface(),
                "start": m.begin(),
                "base": m.dictionary_form(),
                "reading": _kata2hira(m.reading_form()),
                "pos": p[0],
                "detail": p[1],
                "ctype": p[4],
                "cform": p[5],
                "unk": m.is_oov(),
            })
    return {"tokens": toks}

@router.get("/lang/tokenizer")
def lang_tokenizer_status():
    with _sudachi_dl_lock:
        dl = dict(_sudachi_dl)
    return {"available": _sudachi_available(), "enabled": _sudachi_enabled(), **dl}

@router.post("/lang/tokenizer/enable")
def lang_tokenizer_enable(payload: dict = Body(...)):
    on = bool((payload or {}).get("on"))
    _SUDACHI_DIR.mkdir(parents=True, exist_ok=True)
    if on:
        _SUDACHI_FLAG.touch()
        warm_sudachi()
    else:
        _SUDACHI_FLAG.unlink(missing_ok=True)
    return {"ok": True, "enabled": on}

@router.post("/lang/tokenizer/download")
def lang_tokenizer_download():
    if _sudachi_available():
        return {"ok": True, "available": True}
    with _sudachi_dl_lock:
        if _sudachi_dl["downloading"]:
            raise HTTPException(status_code=409, detail="Already downloading")
        _sudachi_dl.update(downloading=True, progress=0.0, error="")
    threading.Thread(target=_download_sudachi_dict, daemon=True).start()
    return {"ok": True}

@router.post("/lang/tokenizer/remove")
def lang_tokenizer_remove():
    global _sudachi
    with _sudachi_lock:
        _sudachi = None
    import gc
    gc.collect()
    try:
        _SUDACHI_DIC.unlink(missing_ok=True)
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))
    _SUDACHI_FLAG.unlink(missing_ok=True)
    return {"ok": True}

@router.post("/lang/tokenize")
async def lang_tokenize(payload: dict = Body(...)):
    text = payload.get("text") or ""
    if not _sudachi_available():
        raise HTTPException(status_code=409, detail="High-accuracy tokenizer not installed")
    if not text:
        return {"tokens": []}
    try:
        return await asyncio.to_thread(_do_tokenize, text)
    except Exception as e:
        logger.error("Tokenize failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/lang/download")
def lang_download():
    if not engine_install.start_jadict_download():
        raise HTTPException(status_code=409, detail="Another install/download is already running")
    return {"ok": True}

@router.post("/lang/remove")
def lang_remove():
    _close()
    engine_install.remove_jadict_data()
    return {"ok": True}

def on_shutdown():
    _close()
