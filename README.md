> [!WARNING]
> **Work in progress.** Expect rough edges, missing features, and breaking changes.

# Pizza Captions

![screenshot](screenshot.png)

Real-time speech transcription and translation running entirely on your machine. Captures audio from a microphone or system loopback (speaker output), transcribes with your choice of STT engine ([WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit) or [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) with NVIDIA Parakeet), and optionally translates and forwards to VRChat via OSC.

## Features

- **Live transcription** - low-latency, streamed word by word
- **Swappable engines** - Whisper for accuracy, Parakeet for speed on any PC
- **Mic or loopback** - capture your voice or anything playing through your speakers
- **Translation** - multiple backends with in-app configuration
- **VRChat OSC** - send transcription/translation directly to the chatbox
- **Portable** - no Python install needed; everything runs from the extracted folder

## Requirements

- Windows 10/11 (WASAPI loopback capture is Windows-only)
- NVIDIA GPU optional, recommended for the Whisper engine; Parakeet runs well on CPU

## Getting started

1. Download the portable zip and extract the **whole folder** (don't run from inside the zip).
2. Double-click **`Start LiveTranscription.bat`**. A console window stays open showing what the app is doing.
3. First run: open Settings (**⚙**) and install a transcription engine:

| Engine | Best for | Download |
|---|---|---|
| **Parakeet** (sherpa-onnx) | Fast on any PC, no GPU needed. English, Japanese + 24 European languages | ~200 MB + models |
| **Whisper** (WhisperLiveKit) | Best accuracy, wants an NVIDIA GPU. ~All languages | ~2.5 GB + models |

4. Optional: pick a translation backend in Settings and enable **Translate**.

Engines and models install under `%LOCALAPPDATA%\LiveTranscription` (manage them in Settings → Engine); config and logs live in `%APPDATA%\LiveTranscription`. Updating the app = replace the extracted folder. Your settings, engines, and models survive.

## VRChat

Enable the **VRChat OSC** checkbox to send captions to your chatbox. OSC must be enabled in VRChat's action menu (Options → OSC → Enabled).

## Translation Backends

| Backend | Key required | Notes |
|---|---|---|
| Google | No | Free, default |
| DeepL | Yes | High quality |
| OpenAI-compatible | Optional | Works with any OpenAI-format endpoint |
| OpenRouter | Yes | Routes to many models |
| LM Studio | No | Local, native API |
| LibreTranslate | No | Self-hosted |
| Ollama | No | Local |

## Configuration

Click **⚙** in the app to configure engines, models, translation backends, and blocked phrases. Settings are saved to `%APPDATA%\LiveTranscription\config.json` and persist across updates.

## Troubleshooting

The console window shows what the app is doing; logs are also written to `%APPDATA%\LiveTranscription\logs`. To reclaim disk space, uninstall engines/models in Settings or delete `%LOCALAPPDATA%\LiveTranscription`.

## Credits

Built on WhisperLiveKit, OpenAI Whisper models, sherpa-onnx, NVIDIA Parakeet models (CC-BY-4.0, © NVIDIA Corporation), Silero VAD, and more. See [CREDITS.md](CREDITS.md) for the full list with licenses.

## License

Proprietary - all rights reserved. See [LICENSE](LICENSE). Third-party components remain under their own licenses (see [CREDITS.md](CREDITS.md)).
