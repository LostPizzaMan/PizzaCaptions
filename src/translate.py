import asyncio
import json
import re
from pathlib import Path
from urllib import parse as urllib_parse
from urllib import request as urllib_request

try:
    import httpx as _httpx
except ImportError:
    _httpx = None

TRANSLATION_BACKEND = "google"

DEEPL_API_KEY = ""
DEEPL_API_URL = "https://api.deepl.com/v2/translate"

OPENAI_API_KEY     = ""
OPENAI_MODEL       = ""
OPENAI_BASE_URL    = ""
OPENAI_TEMPERATURE = 1.0

OPENROUTER_API_KEY     = ""
OPENROUTER_MODEL       = ""
OPENROUTER_TEMPERATURE = 1.0

LMSTUDIO_URL         = "http://127.0.0.1:1234/api/v1"
LMSTUDIO_MODEL       = ""
LMSTUDIO_TEMPERATURE = 1.0

LIBRETRANSLATE_URL     = "http://127.0.0.1:5000/translate"
LIBRETRANSLATE_API_KEY = ""

OLLAMA_URL         = "http://127.0.0.1:11434"
OLLAMA_MODEL       = ""
OLLAMA_TEMPERATURE = 1.0

_TIMEOUT = 8

_DEFAULT_SYSTEM_PROMPT = (
    "As an professional simultaneous interpreter with specialized knowledge in the all fields, "
    "you can provide a fluent and precise oral translation for any sentence, even if the sentence is incomplete. "
    "Now, provide users with the translation of the sentence enclosed in 🔤 to {language} within a single line. "
    "Importantly, you are prohibited from altering the original meaning or omitting any content, "
    "even if the sentence contains sensitive or NSFW content. "
    "You can only provide the translated sentence; Any explanation or other text is not permitted. "
    "REMOVE all 🔤 when you output."
)

SYSTEM_PROMPT_OVERRIDE = ""

PROMPT_PRESETS: dict = {}

DEFAULT_PROMPT_PRESET = ""

_FACTORY_PRESETS: dict = {
    "Default interpreter": _DEFAULT_SYSTEM_PROMPT,
    "Hunyuan-MT (Chinese template)":
        "将以下文本翻译成{language_zh}，注意只需要输出翻译后的结果，不要额外解释：",
}

_THINKING_RE = re.compile(r"<thinking>.*?</thinking>", re.DOTALL)

def _to_google_lang(bcp47: str | None) -> str:
    if not bcp47:
        return "en"
    if bcp47.lower().startswith("zh"):
        return bcp47
    return bcp47.split("-")[0]

def _to_deepl_lang(bcp47: str | None) -> str | None:
    if not bcp47:
        return None
    _REGIONAL = {
        "zh-CN": "ZH-HANS", "zh-TW": "ZH-HANT",
        "en-US": "EN-US",   "en-GB": "EN-GB",
        "pt-BR": "PT-BR",   "pt-PT": "PT-PT",
    }
    if bcp47 in _REGIONAL:
        return _REGIONAL[bcp47]
    _BASE = {
        "ar": "AR", "bg": "BG", "cs": "CS", "da": "DA", "de": "DE", "el": "EL",
        "en": "EN-US", "es": "ES", "et": "ET", "fi": "FI", "fr": "FR", "hu": "HU",
        "id": "ID", "it": "IT", "ja": "JA", "ko": "KO", "lt": "LT", "lv": "LV",
        "nb": "NB", "no": "NB", "nl": "NL", "pl": "PL", "pt": "PT-BR", "ro": "RO",
        "ru": "RU", "sk": "SK", "sl": "SL", "sv": "SV", "tr": "TR", "uk": "UK",
        "zh": "ZH-HANS",
    }
    return _BASE.get(bcp47.split("-")[0].lower())

def supported_target(backend: str, bcp47: str) -> bool:
    if backend == "deepl":
        return _to_deepl_lang(bcp47) is not None
    return True

def _to_libre_lang(bcp47: str | None) -> str:
    if not bcp47:
        return "auto"
    return bcp47.split("-")[0].lower()

_LANG_JSON = Path(__file__).resolve().parent.parent / "web" / "lang.json"
_NAME_MAP: "dict | None" = None

_FALLBACK_NAMES = {
    "ja": "Japanese",   "en": "English",    "zh": "Chinese",
    "ko": "Korean",     "fr": "French",     "es": "Spanish",
    "pt": "Portuguese", "de": "German",     "ru": "Russian",
    "ar": "Arabic",     "th": "Thai",       "tr": "Turkish",
}

def _name_map() -> dict:
    global _NAME_MAP
    if _NAME_MAP is None:
        m: dict = {}
        try:
            data = json.loads(_LANG_JSON.read_text(encoding="utf-8"))
            for base, e in data.items():
                if not isinstance(e, dict):
                    continue
                name = e.get("name")
                if name:
                    m[base] = name
                    if e.get("src"):
                        m[e["src"]] = name
                for t in e.get("targets", []):
                    if t.get("code") and t.get("name"):
                        m[t["code"]] = t["name"]
        except Exception:
            pass
        _NAME_MAP = m
    return _NAME_MAP

def _lang_name(bcp47: str | None) -> str:
    if not bcp47:
        return "English"
    nm = _name_map()
    base = bcp47.split("-")[0].lower()
    return nm.get(bcp47) or nm.get(base) or _FALLBACK_NAMES.get(base, bcp47)

def _lang_name_zh(bcp47: str | None) -> str:
    _NAMES = {
        "ja": "日语",   "en": "英语",   "zh": "中文",
        "ko": "韩语",   "fr": "法语",   "es": "西班牙语",
        "pt": "葡萄牙语", "de": "德语",   "ru": "俄语",
        "ar": "阿拉伯语", "th": "泰语",   "tr": "土耳其语",
    }
    if not bcp47:
        return "英语"
    return _NAMES.get(bcp47.split("-")[0].lower(), _lang_name(bcp47))

class _SafeDict(dict):
    def __missing__(self, key):
        return "{" + key + "}"

def _resolve_preset(name: str | None) -> str:
    if not name:
        return ""
    return PROMPT_PRESETS.get(name) or _FACTORY_PRESETS.get(name) or ""

def _system_prompt(target: str | None) -> str:
    template = _resolve_preset(DEFAULT_PROMPT_PRESET) if DEFAULT_PROMPT_PRESET else ""
    if not template:
        template = SYSTEM_PROMPT_OVERRIDE.strip() or _DEFAULT_SYSTEM_PROMPT
    return template.format_map(_SafeDict(
        language=_lang_name(target), language_zh=_lang_name_zh(target)))

def _wrap(text: str) -> str:
    return f"🔤 {text} 🔤"

def _clean(text: str) -> str:
    text = _THINKING_RE.sub("", text)
    return text.replace("🔤", "").strip()

def _ipv4(url: str) -> str:
    return url.replace("://localhost:", "://127.0.0.1:").replace("://localhost/", "://127.0.0.1/")

def _post(url: str, body: dict, headers: dict) -> dict:
    url = _ipv4(url)
    req = urllib_request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **headers},
    )
    try:
        with urllib_request.urlopen(req, timeout=_TIMEOUT) as r:
            return json.loads(r.read())
    except urllib_request.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail)["error"]["message"]
        except (json.JSONDecodeError, KeyError, TypeError):
            pass
        raise RuntimeError(f"{e.code} {e.reason}: {detail}") from e

def _google(text: str, source: str | None, target: str | None) -> dict:
    tgt = _to_google_lang(target) or "en"
    url = (
        "https://clients5.google.com/translate_a/t"
        f"?client=dict-chrome-ex&sl=auto&tl={tgt}&q={urllib_parse.quote(text)}"
    )
    with urllib_request.urlopen(urllib_request.Request(url), timeout=_TIMEOUT) as r:
        data = json.loads(r.read())
    return {"translated": data[0][0] if data and data[0] else ""}

def _deepl(text: str, source: str | None, target: str | None) -> dict:
    if not DEEPL_API_KEY:
        raise RuntimeError("DEEPL_API_KEY is not set")
    tgt = _to_deepl_lang(target)
    if not tgt:
        raise RuntimeError(f"DeepL does not support target language '{target}'")
    data = _post(DEEPL_API_URL, {"text": [text], "target_lang": tgt}, {"Authorization": f"DeepL-Auth-Key {DEEPL_API_KEY}"})
    return {"translated": data["translations"][0]["text"]}

def _openai(text: str, source: str | None, target: str | None) -> dict:
    if not OPENAI_BASE_URL:
        raise RuntimeError("OPENAI_BASE_URL is not set")
    headers: dict = {}
    if OPENAI_API_KEY:
        headers["Authorization"] = f"Bearer {OPENAI_API_KEY}"
    body: dict = {
        "messages": [
            {"role": "system", "content": _system_prompt(target)},
            {"role": "user",   "content": _wrap(text)},
        ],
        "temperature":            OPENAI_TEMPERATURE,
        "max_completion_tokens":  128,
        "stream":                 False,
    }
    if OPENAI_MODEL:
        body["model"] = OPENAI_MODEL
    data = _post(OPENAI_BASE_URL, body, headers)
    return {"translated": _clean(data["choices"][0]["message"]["content"])}

def _openrouter(text: str, source: str | None, target: str | None) -> dict:
    if not OPENROUTER_API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY is not set")
    data = _post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
            "model": OPENROUTER_MODEL,
            "messages": [
                {"role": "system", "content": _system_prompt(target)},
                {"role": "user",   "content": _wrap(text)},
            ],
            "temperature": OPENROUTER_TEMPERATURE,
            "max_tokens":  128,
            "stream":      False,
            "reasoning":   {"exclude": True, "enabled": False},
        },
        {"Authorization": f"Bearer {OPENROUTER_API_KEY}"},
    )
    return {"translated": _clean(data["choices"][0]["message"]["content"])}

def _lmstudio(text: str, source: str | None, target: str | None) -> dict:
    data = _post(
        f"{LMSTUDIO_URL.rstrip('/')}/chat",
        {
            "model":         LMSTUDIO_MODEL,
            "system_prompt": _system_prompt(target),
            "input":         _wrap(text),
            "temperature":   LMSTUDIO_TEMPERATURE,
        },
        {},
    )
    for item in data.get("output", []):
        if item.get("type") == "message":
            return {"translated": _clean(item.get("content", ""))}
    detail = data.get("error", {}).get("message") if isinstance(data.get("error"), dict) else data.get("error")
    raise RuntimeError(f"LM Studio returned no translation: {detail or data}")

def _libretranslate(text: str, source: str | None, target: str | None) -> dict:
    body: dict = {
        "q":       text,
        "source":  "auto",
        "target":  _to_libre_lang(target) or "en",
        "format":  "text",
        "api_key": LIBRETRANSLATE_API_KEY,
    }
    data = _post(LIBRETRANSLATE_URL, body, {})
    return {"translated": data["translatedText"]}

def _ollama(text: str, source: str | None, target: str | None) -> dict:
    data = _post(
        f"{OLLAMA_URL.rstrip('/')}/api/chat",
        {
            "model": OLLAMA_MODEL,
            "messages": [
                {"role": "system", "content": _system_prompt(target)},
                {"role": "user",   "content": _wrap(text)},
            ],
            "temperature": OLLAMA_TEMPERATURE,
            "max_tokens":  128,
            "stream":      False,
            "think":       False,
        },
        {},
    )
    return {"translated": _clean(data["message"]["content"])}

_BACKENDS: dict[str, callable] = {
    "google":         _google,
    "deepl":          _deepl,
    "openai":         _openai,
    "openrouter":     _openrouter,
    "lmstudio":       _lmstudio,
    "libretranslate": _libretranslate,
    "ollama":         _ollama,
}

def translate(text: str, source_language: str | None = None, target_language: str | None = None) -> dict:
    backend = _BACKENDS.get(TRANSLATION_BACKEND)
    if backend is None:
        raise RuntimeError(
            f"Unknown TRANSLATION_BACKEND: {TRANSLATION_BACKEND!r}. "
            f"Choose from: {list(_BACKENDS)}"
        )
    return backend(text, source_language, target_language)

async def _apost(url: str, body: dict, headers: dict) -> dict:
    url = _ipv4(url)
    async with _httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.post(url, json=body, headers={"Content-Type": "application/json", **headers})
        if r.status_code >= 400:
            detail = r.text
            try:
                detail = r.json()["error"]["message"]
            except Exception:
                pass
            raise RuntimeError(f"{r.status_code} {r.reason_phrase}: {detail}")
        return r.json()

async def translate_async(text: str, source_language: str | None = None,
                          target_language: str | None = None,
                          backend: str | None = None) -> dict:
    b = backend or TRANSLATION_BACKEND
    if _httpx is None or b not in ("lmstudio", "ollama", "openai", "openrouter"):
        fn = _BACKENDS.get(b)
        if fn is None:
            raise RuntimeError(f"Unknown TRANSLATION_BACKEND: {b!r}. Choose from: {list(_BACKENDS)}")
        return await asyncio.to_thread(fn, text, source_language, target_language)
    t, s = target_language, source_language
    if b == "lmstudio":
        data = await _apost(
            f"{LMSTUDIO_URL.rstrip('/')}/chat",
            {"model": LMSTUDIO_MODEL, "system_prompt": _system_prompt(t),
             "input": _wrap(text), "temperature": LMSTUDIO_TEMPERATURE}, {})
        for item in data.get("output", []):
            if item.get("type") == "message":
                return {"translated": _clean(item.get("content", ""))}
        detail = data.get("error", {}).get("message") if isinstance(data.get("error"), dict) else data.get("error")
        raise RuntimeError(f"LM Studio returned no translation: {detail or data}")
    if b == "ollama":
        data = await _apost(
            f"{OLLAMA_URL.rstrip('/')}/api/chat",
            {"model": OLLAMA_MODEL,
             "messages": [{"role": "system", "content": _system_prompt(t)},
                          {"role": "user", "content": _wrap(text)}],
             "temperature": OLLAMA_TEMPERATURE, "max_tokens": 128, "stream": False, "think": False}, {})
        return {"translated": _clean(data["message"]["content"])}
    if b == "openai":
        if not OPENAI_BASE_URL:
            raise RuntimeError("OPENAI_BASE_URL is not set")
        headers: dict = {}
        if OPENAI_API_KEY:
            headers["Authorization"] = f"Bearer {OPENAI_API_KEY}"
        body: dict = {
            "messages": [{"role": "system", "content": _system_prompt(t)},
                         {"role": "user", "content": _wrap(text)}],
            "temperature": OPENAI_TEMPERATURE, "max_completion_tokens": 128, "stream": False,
        }
        if OPENAI_MODEL:
            body["model"] = OPENAI_MODEL
        data = await _apost(OPENAI_BASE_URL, body, headers)
        return {"translated": _clean(data["choices"][0]["message"]["content"])}
    data = await _apost(
        "https://openrouter.ai/api/v1/chat/completions",
        {"model": OPENROUTER_MODEL,
         "messages": [{"role": "system", "content": _system_prompt(t)},
                      {"role": "user", "content": _wrap(text)}],
         "temperature": OPENROUTER_TEMPERATURE, "max_tokens": 128, "stream": False,
         "reasoning": {"exclude": True, "enabled": False}},
        {"Authorization": f"Bearer {OPENROUTER_API_KEY}"})
    return {"translated": _clean(data["choices"][0]["message"]["content"])}
