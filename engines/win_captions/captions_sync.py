_EOS = "。．！？.!?"
_BOUNDARY = set(_EOS + "\n")

_NL_SENTENCE_BYTES = 40

def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return (0x3000 <= o <= 0x9FFF) or (0x3400 <= o <= 0x4DBF) or (0xF900 <= o <= 0xFAFF) or (0xFF00 <= o <= 0xFFEF)

def _replace_newlines(text: str) -> str:
    parts = text.split("\n")
    n = len(parts)
    out = []
    for i, seg in enumerate(parts):
        seg = seg.strip()
        if i == n - 1:
            out.append(seg)
            break
        if not seg:
            continue
        last = seg[-1]
        if last in _EOS:
            out.append(seg)
        elif len(seg.encode("utf-8")) >= _NL_SENTENCE_BYTES:
            out.append(seg + ("。" if _is_cjk(last) else ". "))
        else:
            out.append(seg if _is_cjk(last) else seg + " ")
    return "".join(out)

class CaptionSync:
    def __init__(self, emit, *, idle_commit=12, max_chars=140):
        self._emit = emit
        self._idle_commit = idle_commit
        self._max_chars = max_chars
        self.reset()

    def reset(self):
        self._line = 0
        self._base = 0
        self._last = ""
        self._idle = 0

    def _finalize(self, text, hard=True):
        self._emit(text, self._line, True, hard)
        self._line += 1
        self._last = ""
        self._idle = 0

    @staticmethod
    def _first_boundary(s):
        for i, ch in enumerate(s):
            if ch in _BOUNDARY:
                return i
        return -1

    def update(self, full_text):
        full = _replace_newlines((full_text or "").replace("\r", ""))
        if len(full) < self._base:
            self._base = 0
            self._last = ""
            self._idle = 0

        while True:
            rest = full[self._base:]
            bidx = self._first_boundary(rest)

            if bidx == -1:
                cur = rest.strip()
                if not cur:
                    return
                if cur != self._last:
                    self._emit(cur, self._line, False, False)
                    self._last = cur
                    self._idle = 0
                    if len(cur) >= self._max_chars:
                        self._finalize(cur)
                        self._base = len(full)
                    return
                self._idle += 1
                if self._idle >= self._idle_commit:
                    self._finalize(cur, hard=False)
                    self._base = len(full)
                return

            cur = rest[:bidx + 1].strip()
            adv = bidx + 1
            while adv < len(rest) and rest[adv] in " \n\t":
                adv += 1
            self._base += adv
            if cur:
                self._finalize(cur)
