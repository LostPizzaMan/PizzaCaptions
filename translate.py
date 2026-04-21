# Portions of this file are derived from LiveCaptions-Translator
# Copyright 2024 SakiRinn and other contributors
# Licensed under the Apache License, Version 2.0
# https://github.com/SakiRinn/LiveCaptions-Translator

import json
import re
from urllib import parse as urllib_parse
from urllib import request as urllib_request

# Config

TRANSLATION_BACKEND = "google"

# DeepL
DEEPL_API_KEY = ""
DEEPL_API_URL = "https://api.deepl.com/v2/translate"

# OpenAI-compatible
OPENAI_API_KEY     = ""
OPENAI_MODEL       = ""
OPENAI_BASE_URL    = ""   # e.g. https://api.openai.com/v1/chat/completions
OPENAI_TEMPERATURE = 1.0

# OpenRouter
OPENROUTER_API_KEY     = ""
OPENROUTER_MODEL       = ""
OPENROUTER_TEMPERATURE = 1.0

# LM Studio (local)
LMSTUDIO_URL         = "http://localhost:1234/api/v1"
LMSTUDIO_MODEL       = ""
LMSTUDIO_TEMPERATURE = 1.0

# LibreTranslate (self-hosted)
LIBRETRANSLATE_URL     = "http://localhost:5000/translate"
LIBRETRANSLATE_API_KEY = ""

# Ollama (local)
OLLAMA_URL         = "http://localhost:11434"
OLLAMA_MODEL       = ""
OLLAMA_TEMPERATURE = 1.0

# Shared constants

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

# Override: leave blank to use the default prompt above.
# Use {language} as a placeholder for the target language name.
SYSTEM_PROMPT_OVERRIDE = ""

_THINKING_RE = re.compile(r"<thinking>.*?</thinking>", re.DOTALL)

# Language code helpers

def _to_google_lang(bcp47: str | None) -> str:
    if not bcp47:
        return "en"
    if bcp47.lower().startswith("zh"):
        return bcp47   # keep zh-CN / zh-TW as-is for Google
    return bcp47.split("-")[0]


def _to_deepl_lang(bcp47: str | None) -> str | None:
    if not bcp47:
        return None
    _MAP = {
        "zh-CN": "ZH-HANS", "zh-TW": "ZH-HANT",
        "en-US": "EN-US",   "en-GB": "EN-GB",
        "ja-JP": "JA",      "ko-KR": "KO",
        "fr-FR": "FR",      "ru-RU": "RU",
        "es-ES": "ES",      "pt-BR": "PT-BR",
        "ar-SA": "AR",      "de-DE": "DE",
        "th-TH": "TH",      "tr-TR": "TR",
    }
    return _MAP.get(bcp47, bcp47.upper())


def _to_libre_lang(bcp47: str | None) -> str:
    """LibreTranslate uses plain language codes (no region)."""
    if not bcp47:
        return "auto"
    return bcp47.split("-")[0].lower()


def _lang_name(bcp47: str | None) -> str:
    _NAMES = {
        "ja": "Japanese",   "en": "English",    "zh": "Chinese",
        "ko": "Korean",     "fr": "French",     "es": "Spanish",
        "pt": "Portuguese", "de": "German",     "ru": "Russian",
        "ar": "Arabic",     "th": "Thai",       "tr": "Turkish",
    }
    if not bcp47:
        return "English"
    return _NAMES.get(bcp47.split("-")[0].lower(), bcp47)

# Shared helpers

def _system_prompt(target: str | None) -> str:
    template = SYSTEM_PROMPT_OVERRIDE.strip() or _DEFAULT_SYSTEM_PROMPT
    return template.format(language=_lang_name(target))


def _wrap(text: str) -> str:
    return f"🔤 {text} 🔤"


def _clean(text: str) -> str:
    """Strip <thinking> blocks and 🔤 markers from LLM output."""
    text = _THINKING_RE.sub("", text)
    return text.replace("🔤", "").strip()


def _post(url: str, body: dict, headers: dict) -> dict:
    req = urllib_request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **headers},
    )
    with urllib_request.urlopen(req, timeout=_TIMEOUT) as r:
        return json.loads(r.read())


# Backends

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
    tgt = _to_deepl_lang(target) or "EN-US"
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
        "temperature":      OPENAI_TEMPERATURE,
        "max_tokens":       128,
        "stream":           False,
        # Disable thinking/reasoning
        "think":            False,
        "enable_thinking":  False,
        "reasoning_effort": "low",
        "reasoning":        {"exclude": True, "enabled": False, "effort": "low"},
        "thinking":         {"type": "disabled"},
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
    return {"translated": ""}


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


# Public API

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
    """Translate text and return {"translated": "..."}."""
    backend = _BACKENDS.get(TRANSLATION_BACKEND)
    if backend is None:
        raise RuntimeError(
            f"Unknown TRANSLATION_BACKEND: {TRANSLATION_BACKEND!r}. "
            f"Choose from: {list(_BACKENDS)}"
        )
    return backend(text, source_language, target_language)
