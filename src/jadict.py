import asyncio
import json
import logging
import sqlite3
import threading

from fastapi import APIRouter, Body, HTTPException

import engine_install

logger = logging.getLogger(__name__)

_DB_PATH = engine_install.MODELS_DIR / "jadict" / "jadict.sqlite"

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
    "名詞": ("n", "pn", "adj-no", "num"), "代名詞": ("pn",), "動詞": ("v",),
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


_PRIORITY = {
    "いる": "居る", "入る": "はいる", "降る": "ふる",
    "彼": "かれ", "こと": "事", "本": "ほん",
}


def _priority_rank(entry: dict, pref: str) -> int:
    if pref and (pref in entry.get("kanji", []) or pref in entry.get("kana", [])):
        return 0
    return 1


def _lookup_surface(surface: str, targets: tuple) -> "dict | None":

    entries = _dict_lookup(surface)
    if not entries:
        return None
    pref = _PRIORITY.get(surface)
    if targets or pref:
        entries = sorted(entries, key=lambda e: (
            bool(targets) and not _entry_matches_pos(e, targets),
            _priority_rank(e, pref),
        ))
    readings, senses, common = [], [], False
    for e in entries:
        for k in e["kana"]:
            if k not in readings:
                readings.append(k)
        senses.extend(e["senses"])
        common = common or e.get("common", False)
    return {"headword": surface, "reading": readings[0] if readings else "",
            "readings": readings, "common": common, "senses": senses[:6]}


def _do_lookup(word: str, pos: str, base: str) -> dict:
    targets = _pos_targets(pos)
    out = {"word": word, "results": [], "matched": 0}
    if word:
        for end in range(len(word), 0, -1):
            res = _lookup_surface(word[:end], targets)
            if res:
                out = {"word": word[:end], "matched": end, "results": [res]}
                break
    if base:
        bres = _lookup_surface(base, targets)
        out["base"] = {"word": base, "results": [bres] if bres else []}
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
    if not word:
        raise HTTPException(status_code=400, detail="no word")
    if not _db_present():
        raise HTTPException(status_code=409, detail="Dictionary data not installed")
    _open()
    try:
        return await asyncio.to_thread(_do_lookup, word, pos, base)
    except Exception as e:
        logger.error("Lookup failed: %s", e)
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
