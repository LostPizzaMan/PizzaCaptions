import shutil
import sys
from pathlib import Path

import huggingface_hub
from faster_whisper.utils import _MODELS
from tqdm.auto import tqdm as _T

class _Bar(_T):
    def __init__(self, *a, **k):
        k["disable"] = False
        super().__init__(*a, **k)

def _decoder(model: str, dest: str) -> None:
    from whisperlivekit.whisper import _MODELS as _PT_URLS, _download
    url = _PT_URLS.get(model)
    if not url:
        sys.exit("no streaming decoder published for: " + model)
    tmp = Path(dest) / ".dl"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        _download(url, str(tmp), False)
        (tmp / f"{model}.pt").replace(Path(dest) / f"{model}.pt")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

def main() -> None:
    model, dest = sys.argv[1], sys.argv[2]
    with_decoder = "--with-decoder" in sys.argv[3:]
    repo = model if "/" in model else _MODELS.get(model)
    if not repo:
        sys.exit("unknown whisper model: " + model)
    huggingface_hub.snapshot_download(
        repo,
        local_dir=dest,
        allow_patterns=[
            "config.json",
            "preprocessor_config.json",
            "model.bin",
            "tokenizer.json",
            "vocabulary.*",
        ],
        tqdm_class=_Bar,
    )
    if with_decoder:
        _decoder(model, dest)

if __name__ == "__main__":
    main()
