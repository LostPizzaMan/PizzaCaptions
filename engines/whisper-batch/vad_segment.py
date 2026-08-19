import time
import numpy as np
import sherpa_onnx

class VadSegmenter:
    def __init__(self, vad_model_path, *, sample_rate=16000, threshold=0.5,
                 min_silence_s=0.7, min_speech_s=0.25, max_speech_s=20.0,
                 window=512, buffer_s=60.0, preroll_ms=500.0,
                 flush_peak=3 / 32768, flush_hold_s=0.2):
        self._vad_path = str(vad_model_path)
        self.sample_rate = sample_rate
        self.threshold = threshold
        self.min_silence_s = min_silence_s
        self.min_speech_s = min_speech_s
        self.max_speech_s = max_speech_s
        self.window = window
        self.buffer_s = buffer_s
        self.preroll = int(preroll_ms / 1000.0 * sample_rate)
        self.flush_peak = flush_peak
        self.flush_hold_s = flush_hold_s
        self._keep = self.preroll + int((max_speech_s + min_silence_s + 1.0) * sample_rate)
        self._empty = np.empty(0, dtype=np.float32)
        self._reset_vad()
        self._silence_since = None
        self._flushed = False

    def _build_vad(self):
        cfg = sherpa_onnx.VadModelConfig()
        cfg.silero_vad.model = self._vad_path
        cfg.silero_vad.threshold = self.threshold
        cfg.silero_vad.min_silence_duration = self.min_silence_s
        cfg.silero_vad.min_speech_duration = self.min_speech_s
        cfg.silero_vad.max_speech_duration = self.max_speech_s
        cfg.silero_vad.window_size = self.window
        cfg.sample_rate = self.sample_rate
        return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=self.buffer_s)

    def _reset_vad(self):
        self.vad = self._build_vad()
        self._buffer = self._empty
        self._hist = self._empty
        self._fed = 0
        self._prev_end = 0

    def _accept_block(self, block):
        for i in range(0, len(block), self.window):
            self.vad.accept_waveform(block[i:i + self.window])
        self._fed += len(block)
        self._hist = np.concatenate([self._hist, block])
        if len(self._hist) > self._keep:
            self._hist = self._hist[len(self._hist) - self._keep:]

    def _pop(self, out):
        while not self.vad.empty():
            start = self.vad.front.start
            samples = np.array(self.vad.front.samples)
            self.vad.pop()
            base = self._fed - len(self._hist)
            lo = max(base, start - self.preroll, self._prev_end)
            pre = self._hist[lo - base:start - base] if start > lo else self._empty
            out.append(np.concatenate([pre, samples]) if len(pre) else samples)
            self._prev_end = start + len(samples)

    def feed(self, pcm):
        out = []
        peak = float(np.max(np.abs(pcm))) if len(pcm) else 0.0
        now = time.monotonic()
        if peak < self.flush_peak:
            if not self._flushed:
                if self._silence_since is None:
                    self._silence_since = now
                elif now - self._silence_since >= self.flush_hold_s:
                    self.vad.flush()
                    self._pop(out)
                    self._reset_vad()
                    self._silence_since = None
                    self._flushed = True
        else:
            self._silence_since = None
            self._flushed = False

        self._buffer = np.concatenate([self._buffer, pcm])
        n = (len(self._buffer) // self.window) * self.window
        if n:
            self._accept_block(self._buffer[:n])
            self._buffer = self._buffer[n:]
        self._pop(out)
        return out

    def drain(self):
        out = []
        n = (len(self._buffer) // self.window) * self.window
        if n:
            self._accept_block(self._buffer[:n])
            self._buffer = self._buffer[n:]
        self.vad.flush()
        self._pop(out)
        return out
