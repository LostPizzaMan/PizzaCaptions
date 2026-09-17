import json
import logging
import time
import webbrowser
from urllib import request as urllib_request

from fastapi import APIRouter

logger = logging.getLogger(__name__)

_APP_VERSION = "0.0.0"

def configure(*, app_version):
    global _APP_VERSION
    _APP_VERSION = app_version

UPDATE_REPO = "LostPizzaMan/PizzaCaptions"
UPDATE_URL = f"https://github.com/{UPDATE_REPO}/releases/latest"
_UPDATE_TTL = 6 * 3600
_update_cache: dict = {"checked": 0.0, "result": None}

router = APIRouter()

def _parse_version(s: str) -> tuple | None:
    try:
        return tuple(int(p) for p in s.strip().lstrip("vV").split("."))
    except ValueError:
        return None

def _latest_release_via_redirect() -> tuple[str, str]:
    req = urllib_request.Request(UPDATE_URL, headers={"User-Agent": f"LiveTranscription/{_APP_VERSION}"})
    with urllib_request.urlopen(req, timeout=5) as r:
        final = r.url
    if "/releases/tag/" not in final:
        raise RuntimeError(f"unexpected releases URL: {final}")
    return final.rstrip("/").rsplit("/", 1)[-1], final

@router.get("/update/check")
def update_check(force: bool = False):
    now = time.time()
    if not force and _update_cache["result"] is not None and now - _update_cache["checked"] < _UPDATE_TTL:
        return _update_cache["result"]
    result = {"current": _APP_VERSION, "latest": None, "update_available": False, "url": UPDATE_URL}
    tag, url = "", ""
    try:
        req = urllib_request.Request(
            f"https://api.github.com/repos/{UPDATE_REPO}/releases/latest",
            headers={"User-Agent": f"LiveTranscription/{_APP_VERSION}",
                     "Accept": "application/vnd.github+json"},
        )
        with urllib_request.urlopen(req, timeout=5) as r:
            rel = json.loads(r.read())
        tag, url = rel.get("tag_name", ""), rel.get("html_url") or UPDATE_URL
    except Exception as e:
        logger.info("Update check via API failed: %s", e)
        try:
            tag, url = _latest_release_via_redirect()
        except Exception as e2:
            logger.info("Update check failed: %s", e2)
    latest, current = _parse_version(tag), _parse_version(_APP_VERSION)
    if latest and current:
        result["latest"] = tag.lstrip("vV")
        result["update_available"] = latest > current
        result["url"] = url or UPDATE_URL
    _update_cache.update(checked=now, result=result)
    return result

@router.post("/update/open")
async def update_open():
    url = (_update_cache.get("result") or {}).get("url") or UPDATE_URL
    webbrowser.open(url)
    return {"ok": True}
