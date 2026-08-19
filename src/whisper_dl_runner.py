import sys

import huggingface_hub
from faster_whisper.utils import _MODELS
from tqdm.auto import tqdm as _T

class _Bar(_T):
    def __init__(self, *a, **k):
        k["disable"] = False
        super().__init__(*a, **k)

def main() -> None:
    model, dest = sys.argv[1], sys.argv[2]
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

if __name__ == "__main__":
    main()
