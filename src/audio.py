import numpy as np

class _StreamResampler:
    _NUMTAPS = 63

    def __init__(self, in_rate: int, out_rate: int):
        cutoff = min(0.45 * out_rate / in_rate, 0.45)
        n = np.arange(self._NUMTAPS) - (self._NUMTAPS - 1) / 2
        taps = 2 * cutoff * np.sinc(2 * cutoff * n) * np.hamming(self._NUMTAPS)
        self._taps = (taps / taps.sum()).astype(np.float32)
        self._hist = np.zeros(self._NUMTAPS - 1, dtype=np.float32)
        self._buf = np.empty(0, dtype=np.float32)
        self._pos = 0.0
        self._step = in_rate / out_rate

    def process(self, pcm: np.ndarray) -> np.ndarray:
        x = np.concatenate([self._hist, pcm.astype(np.float32)])
        self._hist = x[-(self._NUMTAPS - 1):]
        self._buf = np.concatenate([self._buf, np.convolve(x, self._taps, mode="valid")])
        limit = len(self._buf) - 1
        if limit < 1:
            return np.empty(0, dtype=np.float32)
        positions = np.arange(self._pos, limit, self._step)
        idx = positions.astype(np.int64)
        frac = (positions - idx).astype(np.float32)
        out = self._buf[idx] * (1.0 - frac) + self._buf[idx + 1] * frac
        next_pos = self._pos + len(positions) * self._step
        keep_from = int(next_pos)
        self._buf = self._buf[keep_from:]
        self._pos = next_pos - keep_from
        return out
