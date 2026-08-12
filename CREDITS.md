# Credits & Licenses

Pizza Captions is built on the following open-source projects and models.

## Speech recognition

- **[WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit)** - Apache-2.0
  Streaming transcription engine wrapping SimulStreaming / faster-whisper.

- **[OpenAI Whisper](https://github.com/openai/whisper) models** - MIT

- **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** - MIT
  The backend WhisperLiveKit is run with here, built on
  [CTranslate2](https://github.com/OpenNMT/CTranslate2) (MIT).

- **[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)** - Apache-2.0
  ONNX Runtime-based streaming speech recognition.

- **[NVIDIA Parakeet](https://huggingface.co/nvidia) models** - CC-BY-4.0
  © NVIDIA Corporation. Used under the Creative Commons Attribution 4.0
  International License (https://creativecommons.org/licenses/by/4.0/).

- **[Fun-ASR-Nano](https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-GGUF)** models - Apache-2.0
  © FunAudioLLM. Run with the prebuilt CLI from the
  [FunASR](https://github.com/modelscope/FunASR) release (toolkit: MIT).

- **[Qwen3-ASR](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)** models - Apache-2.0
  © Qwen, in the [GGUF conversion](https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF)
  published by ggml-org.

- **[llama.cpp](https://github.com/ggml-org/llama.cpp)** - MIT
  © 2023-2026 The ggml authors. The GGUF inference runtime behind the two engines
  above.

- **[Silero VAD](https://github.com/snakers4/silero-vad)** - MIT
  Voice activity detection.

Model weights and engine binaries are downloaded when you install an engine and
are **not redistributed** with this app.

## Text to speech

- **[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)** - Apache-2.0
  Neural TTS voices (English and Japanese), run via
  [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) (MIT). The Japanese
  voice adds [pyopenjtalk](https://github.com/r9y9/pyopenjtalk) (MIT) and
  [misaki](https://github.com/hexgrad/misaki) for correct kanji readings.

- **[VOICEVOX](https://voicevox.hiroshiba.jp/)** - Powered by VOICEVOX.
  Japanese neural TTS via [voicevox_core](https://github.com/VOICEVOX/voicevox_core)
  (MIT), with voicevox_onnxruntime and the Open JTalk dictionary. These, and the
  voice models, are downloaded from the official source at runtime and are **not
  redistributed** with this app. Each character voice has its own terms: audio you
  publish must credit the character as `VOICEVOX:キャラクター名`
  (e.g. `VOICEVOX:ずんだもん`). The app shows and copies the exact credit for the
  voice in use.

- **[Open JTalk](http://open-jtalk.sourceforge.net/)** - Modified BSD.
  Japanese pronunciation dictionary, used by the VOICEVOX and Kokoro Japanese voices.

- **Windows voices** - the operating system's built-in speech voices, accessed via
  [winsdk](https://pypi.org/project/winsdk/) (MIT). Nothing is bundled.

## Japanese dictionary

The optional Japanese click-to-define feature segments text with kuromoji (in the
UI) and looks words up in JMdict.

- **[JMdict](https://www.edrdg.org/jmdict/j_jmdict.html)** - CC BY-SA 4.0
  © [EDRDG](https://www.edrdg.org/), used under the
  [EDRDG Licence](https://www.edrdg.org/edrdg/licence.html), via the
  [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) release
  (conversion: MIT). The dictionary is downloaded on install and **not
  redistributed** with this app.

- **[kuromoji.js](https://github.com/takuyaa/kuromoji.js)** - Apache-2.0
  © Takuya Asano / Atilika Inc. Japanese word segmentation, bundled in
  `web/vendor/kuromoji/`, with the **mecab-ipadic** dictionary (© Nara Institute
  of Science and Technology; ICOT Free Software terms). Full texts in
  `web/vendor/kuromoji/LICENSE-2.0.txt` and `NOTICE.md`.

## Screen OCR

The optional Screen OCR engine (snip and read on-screen text) downloads its model
weights on install; they are **not redistributed** with this app.

- **[PP-OCRv6](https://huggingface.co/PaddlePaddle)** models via
  **[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)** / PaddlePaddle - Apache-2.0
  © PaddlePaddle Authors. Text detection and recognition, run through ONNX Runtime.

- **[ONNX Runtime](https://github.com/microsoft/onnxruntime)** - MIT
  © Microsoft. Inference runtime (DirectML on a GPU, CPU otherwise).

- **[mss](https://github.com/BoboTiG/python-mss)** - MIT
  Virtual-desktop screen capture for the snip.

## Application

- **[FastAPI](https://fastapi.tiangolo.com/)** - MIT
- **[uvicorn](https://www.uvicorn.org/)** - BSD-3-Clause
- **[NumPy](https://numpy.org/)** - BSD-3-Clause
- **[PyAudioWPatch](https://github.com/s0d3s/PyAudioWPatch)** - Apache-2.0 (WASAPI loopback capture)
- **[python-osc](https://github.com/attwad/python-osc)** - Unlicense (VRChat OSC output)
- **[websockets](https://github.com/python-websockets/websockets)** - BSD-3-Clause
- **[PyTauri](https://github.com/pytauri/pytauri) / [Tauri](https://tauri.app/)** - Apache-2.0 / MIT (desktop shell)
- **[uv](https://github.com/astral-sh/uv)** - MIT / Apache-2.0 (engine dependency installer)
- **[CPython](https://www.python.org/)** - PSF License, bundled via
  [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
