import * as sudachi from './conjugation/sudachi.js';
import * as kuromoji from './conjugation/kuromoji.js';

async function lookupWord(body) {
  const r = await fetch('/lang/lookup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.text()) || r.status);
  return r.json();
}

  const CJK = /[぀-ヿ々ㇰ-ㇿ㐀-鿿豈-﫿ｦ-ﾟ]/;
  const hasJa = (s) => CJK.test(s);
  const WINDOW = 16;

  let enabled = false, pop = null, activeRun = null, reqId = 0, lastHover = null, jaToken = 0;

  const isKanji = (c) => /[㐀-鿿々〆ヶ]/.test(c);
  const kata2hira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

  function splitKanjiKana(s) {
    const runs = [];
    let i = 0;
    while (i < s.length) {
      const k = isKanji(s[i]);
      let j = i + 1;
      while (j < s.length && isKanji(s[j]) === k) j++;
      runs.push({ type: k ? 'kanji' : 'kana', text: s.slice(i, j) });
      i = j;
    }
    return runs;
  }

  function alignReading(word, reading) {
    if (!reading) return null;
    const runs = splitKanjiKana(word);
    const rh = kata2hira(reading);
    const out = [];
    let ri = 0;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (run.type === 'kana') {
        const kh = kata2hira(run.text);
        if (!rh.startsWith(kh, ri)) return null;
        ri += kh.length;
        out.push({ text: run.text });
      } else {
        const next = runs[i + 1];
        let end;
        if (next) {
          end = rh.indexOf(kata2hira(next.text), ri);
          if (end < 0) return null;
        } else {
          end = rh.length;
        }
        if (end <= ri) return null;
        out.push({ text: run.text, ruby: reading.slice(ri, end) });
        ri = end;
      }
    }
    if (ri !== rh.length) return null;
    return out;
  }

  function furiganaHtml(word, reading) {
    const pieces = alignReading(word, reading);
    if (!pieces || !pieces.some((p) => p.ruby)) return null;
    return pieces.map((p) => (p.ruby
      ? '<ruby>' + esc(p.text) + '<rt>' + esc(p.ruby) + '</rt></ruby>'
      : esc(p.text))).join('');
  }

  let readingMode = 'off';
  const hasKanji = (s) => Array.from(s || '').some(isKanji);
  const ROMA = {
    あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
    か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko', が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
    さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
    た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to', だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
    な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
    は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho', ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
    ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
    ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo', や: 'ya', ゆ: 'yu', よ: 'yo',
    ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', ゐ: 'wi', ゑ: 'we', を: 'wo', ん: 'n',
    ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゔ: 'vu', ー: '',
  };
  const YOUON = { き: 'ky', ぎ: 'gy', し: 'sh', じ: 'j', ち: 'ch', ぢ: 'j', に: 'ny', ひ: 'hy', び: 'by', ぴ: 'py', み: 'my', り: 'ry' };
  function romaSyllable(s, i) {
    const c = s[i], n = s[i + 1];
    if (YOUON[c] && (n === 'ゃ' || n === 'ゅ' || n === 'ょ')) {
      return { r: YOUON[c] + (n === 'ゃ' ? 'a' : n === 'ゅ' ? 'u' : 'o'), len: 2 };
    }
    if (ROMA[c] !== undefined) return { r: ROMA[c], len: 1 };
    return null;
  }

  function kanaToRomaji(kana) {
    const s = kata2hira(kana || '');
    let out = '', i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === 'っ') {
        const nx = romaSyllable(s, i + 1);
        if (nx && /^[a-z]/.test(nx.r) && !/^[aeiou]/.test(nx.r)) out += (nx.r[0] === 'c' ? 't' : nx.r[0]);
        i++; continue;
      }
      if (c === 'ー') { const m = out.match(/[aeiou]$/); if (m) out += m[0]; i++; continue; }
      const syl = romaSyllable(s, i);
      if (syl) { out += syl.r; i += syl.len; } else { out += c; i++; }
    }
    return out;
  }

  function applyReadingSpan(span) {
    const surface = span.dataset.surface || span.textContent;
    const reading = span.dataset.fullReading || '';
    const hasK = span.dataset.hasKanji === '1';
    if (readingMode === 'furigana') {
      const html = (hasK && reading) ? furiganaHtml(surface, reading) : null;
      if (html) span.innerHTML = html; else span.textContent = surface;
    } else if (readingMode === 'hiragana') {
      span.textContent = (hasK && reading) ? kata2hira(reading) : surface;
    } else if (readingMode === 'romaji') {
      span.textContent = kanaToRomaji(reading || surface);
    } else {
      span.textContent = surface;
    }
  }

  function stampReading(span, surface, reads, surfaces) {
    let gr = '', ok = true;
    for (let k = 0; k < surfaces.length; k++) {
      const rd = reads[k];
      if (rd && rd !== '*') gr += rd;
      else if (!hasKanji(surfaces[k])) gr += surfaces[k];
      else { ok = false; break; }
    }
    span.dataset.surface = surface;
    span.dataset.hasKanji = hasKanji(surface) ? '1' : '0';
    if (ok && gr) span.dataset.fullReading = gr;
    applyReadingSpan(span);
  }

  let kuro = null, kuroBuilding = null;
  function ensureKuro() {
    if (kuro) return Promise.resolve(kuro);
    if (kuroBuilding) return kuroBuilding;
    kuroBuilding = new Promise((resolve) => {
      if (!window.kuromoji) { resolve(null); return; }
      window.kuromoji.builder({ dicPath: '/vendor/kuromoji/dict' }).build((err, tk) => {
        if (err) { console.error('kuromoji build failed', err); resolve(null); return; }
        kuro = tk;
        resolve(tk);
      });
    });
    return kuroBuilding;
  }

  let _tokState = null, _tokAt = 0;
  async function useHiAccuracy() {
    const now = Date.now();
    if (!_tokState || now - _tokAt > 2000) {
      try { _tokState = await (await fetch('/lang/tokenizer')).json(); }
      catch (e) { _tokState = { available: false, enabled: false }; }
      _tokAt = now;
    }
    return !!_tokState.available && !!_tokState.enabled;
  }

  async function fetchTokens(text) {
    try {
      const r = await fetch('/lang/tokenize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) return null;
      return (await r.json()).tokens || [];
    } catch (e) { return null; }
  }

  function wrapTokens(raw) {
    return raw.map((t, i) => ({
      textContent: t.surface_form,
      dataset: {
        index: String(i), pos: t.pos || '', posDetail: t.pos_detail_1 || '',
        word: (t.basic_form && t.basic_form !== '*') ? t.basic_form : t.surface_form,
        reading: t.reading || '', surface: t.surface_form, wt: t.word_type || '',
        conjugatedForm: t.conjugated_form || '', conjugatedType: t.conjugated_type || '',
      },
    }));
  }

  function mergeCopulaNeg(raw) {
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i], n = raw[i + 1];
      if (n && (t.surface_form === 'じゃ' || t.surface_form === 'では') && n.basic_form === 'ない') {
        let surface = t.surface_form + n.surface_form, j = i + 1;
        const p = raw[j + 1];
        if (p && (p.surface_form === 'た' || p.surface_form === 'だ')) { surface += p.surface_form; j++; }
        out.push({
          surface_form: surface, basic_form: (t.surface_form === 'では') ? 'ではない' : 'じゃない',
          reading: '', pos: '', pos_detail_1: '', conjugated_form: '', conjugated_type: '', word_type: 'KNOWN',
        });
        i = j;
        continue;
      }
      out.push(t);
    }
    return out;
  }

  function renderKuro(el, raw) {
    raw = mergeCopulaNeg(raw);
    const tokens = wrapTokens(raw);
    el.textContent = '';
    el.dataset.jaline = '1';

    const bounds = new Set([0]);
    let acc = 0;
    for (const t of raw) { acc += t.surface_form.length; bounds.add(acc); }
    el._jaBounds = bounds;
    let i = 0, off = 0;
    while (i < tokens.length) {
      const related = kuromoji.getRelatedTokens(tokens, i);
      const surface = related.map((t) => t.textContent).join('');
      if (!hasJa(surface)) {
        el.appendChild(document.createTextNode(surface));
      } else {
        const span = document.createElement('span');
        span.className = 'jarun';
        span.dataset.seg = '1';
        span.dataset.base = tokens[i].dataset.word;
        span.dataset.pos = tokens[i].dataset.pos;
        span.dataset.reading = tokens[i].dataset.reading;
        span.dataset.grammar = kuromoji.getConjugationLabel(related);
        span.dataset.off = String(off);
        if (tokens[i].dataset.wt === 'UNKNOWN') span.dataset.unk = '1';
        span.textContent = surface;
        stampReading(span, surface, related.map((t) => t.dataset.reading), related.map((t) => t.textContent));
        span.addEventListener('click', onKuroClick);
        el.appendChild(span);
      }
      off += surface.length;
      i += related.length;
    }
  }

  function renderSudachi(el, toks) {
    toks = sudachi.mergeCopulaNeg(toks);
    el.textContent = '';
    el.dataset.jaline = '1';
    const bounds = new Set([0]);
    let acc = 0;
    for (const t of toks) { acc += t.surface.length; bounds.add(acc); }
    el._jaBounds = bounds;
    let i = 0, off = 0;
    while (i < toks.length) {
      const related = sudachi.getRelatedTokens(toks, i);
      const surface = related.map((t) => t.surface).join('');
      if (!hasJa(surface)) {
        el.appendChild(document.createTextNode(surface));
      } else {
        const span = document.createElement('span');
        span.className = 'jarun';
        span.dataset.seg = '1';
        span.dataset.base = sudachi.normBase(toks[i]);
        span.dataset.pos = toks[i].pos || '';
        span.dataset.reading = toks[i].reading || '';
        span.dataset.grammar = sudachi.getConjugationLabel(related);
        span.dataset.off = String(off);
        if (toks[i].unk) span.dataset.unk = '1';
        span.textContent = surface;
        stampReading(span, surface, related.map((t) => t.reading), related.map((t) => t.surface));
        span.addEventListener('click', onKuroClick);
        el.appendChild(span);
      }
      off += surface.length;
      i += related.length;
    }
  }

  function onKuroClick(e) {
    e.stopPropagation();
    if (!enabled) return;
    const span = e.currentTarget;
    clearHighlight();
    if (span.dataset.unk) { resolveUnknownClick(span); return; }
    resolveKnownClick(span);
  }

  async function resolveUnknownClick(span) {
    const line = span.closest && span.closest('[data-jaline]');
    if (!line || !kuro) {
      span.classList.add('jaword-active'); activeRun = span;
      defineWord(span.dataset.base, span.dataset.grammar, span.dataset.pos, span);
      return;
    }
    const start = +span.dataset.off || 0;
    const text = line.textContent;
    const tokenLen = span.textContent.length;
    const my = ++reqId;
    const p = ensurePop();
    p.hidden = false;
    p.innerHTML = '<div class="jadict-loading">Looking up…</div>';
    span.classList.add('jaword-active');
    activeRun = span;
    place(span);
    let j;
    try {
      j = await lookupWord({ word: text.slice(start, start + WINDOW), base: span.dataset.base, pos: span.dataset.pos, reading: span.dataset.reading });
    } catch {
      if (my === reqId) p.innerHTML = '<div class="jadict-empty">Lookup failed</div>';
      return;
    }
    if (my !== reqId) return;

    const Lj = j.matched || 0;
    const alignedEnd = !!line._jaBounds && line._jaBounds.has(start + Lj);
    let crossesParticle = false;
    if (Lj > tokenLen) {
      let acc = 0;
      for (const t of kuro.tokenize(text.slice(start))) {
        if (acc >= Lj) break;
        if (acc > 0 && t.pos === '助詞') { crossesParticle = true; break; }
        acc += t.surface_form.length;
      }
    }
    if (Lj > tokenLen && alignedEnd && !crossesParticle && (j.results || []).length) {
      clearHighlight();
      const range = rangeFor(line, start, start + Lj);
      setScanHighlight(range);
      showResults({ word: j.word, results: j.results }, '', range || span);
    } else {
      showResults({ word: span.dataset.base, results: (j.base && j.base.results) || [] }, span.dataset.grammar, span);
    }
  }

  async function resolveKnownClick(span) {
    const base = span.dataset.base, grammar = span.dataset.grammar, pos = span.dataset.pos;
    const line = span.closest && span.closest('[data-jaline]');
    span.classList.add('jaword-active');
    activeRun = span;
    if (!line || !kuro) { defineWord(base, grammar, pos, span); return; }
    const start = +span.dataset.off || 0;
    const text = line.textContent;
    const kCover = span.textContent.length;
    const my = ++reqId;
    const p = ensurePop();
    p.hidden = false;
    p.innerHTML = '<div class="jadict-loading">Looking up…</div>';
    place(span);
    let j;
    try {
      j = await lookupWord({ word: text.slice(start, start + WINDOW), base, pos, reading: span.dataset.reading });
    } catch {
      if (my === reqId) p.innerHTML = '<div class="jadict-empty">Lookup failed</div>';
      return;
    }
    if (my !== reqId) return;

    const Lj = j.matched || 0;
    const bounds = line._jaBounds;
    const aligned = !!bounds && bounds.has(start) && bounds.has(start + Lj);
    const longer = (j.results || [])[0];
    if (Lj > kCover && aligned && pos !== '助詞' && longer) {
      clearHighlight();
      const range = rangeFor(line, start, start + Lj);
      setScanHighlight(range);
      showResults({ word: j.word, results: j.results }, '', range || span);
    } else {
      showResults({ word: base, results: (j.base && j.base.results) || [] }, grammar, span);
    }
  }

  function showResults(j, grammar, anchor) {
    const p = ensurePop();
    p.innerHTML = renderResults(j, grammar);
    place(anchor);
  }

  async function defineWord(base, grammar, pos, anchor) {
    const p = ensurePop();
    const my = ++reqId;
    p.hidden = false;
    p.innerHTML = '<div class="jadict-loading">Looking up…</div>';
    place(anchor);
    let j;
    try {
      j = await lookupWord({ word: base, pos: pos || '' });
    } catch {
      if (my === reqId) { p.innerHTML = '<div class="jadict-empty">Lookup failed</div>'; place(anchor); }
      return;
    }
    if (my !== reqId) return;
    showResults(j, grammar, anchor);
  }

  async function renderJaText(el, text) {
    if ((!enabled && readingMode === 'off') || !hasJa(text)) { el.textContent = text; return; }
    el.textContent = text;
    const token = String(++jaToken);
    el.dataset.jaTok = token;

    if (await useHiAccuracy()) {
      const raw = await fetchTokens(text);
      if (el.dataset.jaTok !== token) return;
      if (raw) { ensureKuro(); renderSudachi(el, raw); return; }
    }
    const tk = await ensureKuro();
    if (el.dataset.jaTok !== token) return;
    if (!tk) { renderRuns(el, text); return; }
    renderKuro(el, tk.tokenize(text));
  }

  function renderRuns(el, text) {
    el.textContent = '';
    let i = 0;
    while (i < text.length) {
      const ja = CJK.test(text[i]);
      let j = i + 1;
      while (j < text.length && CJK.test(text[j]) === ja) j++;
      const chunk = text.slice(i, j);
      if (ja) {
        const run = document.createElement('span');
        run.className = 'jarun';
        run.textContent = chunk;
        run.dataset.text = chunk;
        run.addEventListener('click', onRunClick);
        el.appendChild(run);
      } else {
        el.appendChild(document.createTextNode(chunk));
      }
      i = j;
    }
  }

  function offsetAt(e, run) {
    try {
      const cr = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
      if (!cr || !run.contains(cr.startContainer)) return null;
      let total = 0;
      const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (n === cr.startContainer) { total += cr.startOffset; break; }
        total += n.textContent.length;
      }
      return Math.max(0, Math.min(total, run.dataset.text.length - 1));
    } catch { return null; }
  }

  function onRunClick(e) {
    e.stopPropagation();
    const run = e.currentTarget;
    clearHighlight();
    const offset = offsetAt(e, run) ?? 0;
    const win = run.dataset.text.slice(offset, offset + WINDOW);
    if (win) define(win, run, offset);
  }

  let scanOn = false;

  function caretGlobalOffset(line, node, off) {
    if (node === line) {
      let acc = 0;
      for (let k = 0; k < off && k < line.childNodes.length; k++) acc += line.childNodes[k].textContent.length;
      return acc;
    }
    let acc = 0, n;
    const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    while ((n = w.nextNode())) {
      if (n === node) return acc + off;
      acc += n.textContent.length;
    }
    return 0;
  }

  function nodeAtOffset(line, target) {
    let acc = 0, n, last = null;
    const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    while ((n = w.nextNode())) {
      last = n;
      const len = n.textContent.length;
      if (acc + len >= target) return [n, target - acc];
      acc += len;
    }
    return last ? [last, last.textContent.length] : [line, 0];
  }

  function rangeFor(line, start, end) {
    try {
      const [sn, so] = nodeAtOffset(line, start);
      const [en, eo] = nodeAtOffset(line, end);
      const r = document.createRange();
      r.setStart(sn, so); r.setEnd(en, eo);
      return r;
    } catch { return null; }
  }

  function setScanHighlight(range) {
    try {
      if (range && window.CSS && CSS.highlights && window.Highlight) {
        CSS.highlights.set('jascan', new Highlight(range));
        scanOn = true;
      }
    } catch {  }
  }

  function clearScanHighlight() {
    if (scanOn) { try { CSS.highlights.delete('jascan'); } catch {  } scanOn = false; }
  }

  async function scanFromCaret(e, line) {
    let cr;
    try { cr = document.caretRangeFromPoint(e.clientX, e.clientY); } catch { return; }
    if (!cr || !line.contains(cr.startContainer)) return;
    const text = line.textContent;
    const start = caretGlobalOffset(line, cr.startContainer, cr.startOffset);
    if (start >= text.length || !CJK.test(text[start])) return;
    if (lastHover && lastHover.line === line && lastHover.start === start) return;
    lastHover = { line, start };

    const raw = kuro.tokenize(text.slice(start));
    if (!raw.length) return;
    const wt = raw[0].word_type;
    const related = kuromoji.getRelatedTokens(wrapTokens(raw), 0);
    const kCover = related.map((t) => t.textContent).join('').length;
    const kBase = (raw[0].basic_form && raw[0].basic_form !== '*') ? raw[0].basic_form : raw[0].surface_form;
    const kPos = raw[0].pos;
    const grammar = kuromoji.getConjugationLabel(related);

    const my = ++reqId;
    const p = ensurePop();
    p.hidden = false;
    p.innerHTML = '<div class="jadict-loading">Looking up…</div>';
    clearHighlight();
    setScanHighlight(rangeFor(line, start, start + kCover));
    place(rangeFor(line, start, start + kCover) || line);

    let j;
    try {
      j = await lookupWord({ word: text.slice(start, start + WINDOW), base: kBase, pos: kPos, reading: raw[0].reading });
    } catch {
      if (my === reqId) p.innerHTML = '<div class="jadict-empty">Lookup failed</div>';
      return;
    }
    if (my !== reqId) return;

    const Lj = j.matched || 0;
    const bounds = line._jaBounds;
    const aligned = !!bounds && bounds.has(start) && bounds.has(start + Lj);
    const alignedEnd = !!bounds && bounds.has(start + Lj);

    let crossesParticle = false;
    if (Lj > kCover) {
      let acc = 0;
      for (const t of kuro.tokenize(text.slice(start))) {
        if (acc >= Lj) break;
        if (acc > 0 && t.pos === '助詞') { crossesParticle = true; break; }
        acc += t.surface_form.length;
      }
    }

    const useJmdict = Lj > kCover && (j.results || []).length
      && ((wt !== 'UNKNOWN' && aligned && kPos !== '助詞')
          || (wt === 'UNKNOWN' && alignedEnd && !crossesParticle));

    if (useJmdict) {
      setScanHighlight(rangeFor(line, start, start + Lj));
      showResults({ word: j.word, results: j.results }, '', rangeFor(line, start, start + Lj) || line);
    } else {
      showResults({ word: kBase, results: (j.base && j.base.results) || [] }, grammar,
                  rangeFor(line, start, start + kCover) || line);
    }
  }

  function onScanMove(e) {
    if (!enabled || !e.shiftKey || readingMode !== 'off') return;

    const line = e.target.closest && e.target.closest('[data-jaline]');
    if (line && kuro) { scanFromCaret(e, line); return; }

    const run = e.target.closest && e.target.closest('.jarun');
    if (!run || !run.dataset.text) return;
    const offset = offsetAt(e, run);
    if (offset == null) return;
    if (lastHover && lastHover.run === run && offset >= lastHover.start && offset < lastHover.end) return;
    const win = run.dataset.text.slice(offset, offset + WINDOW);
    if (win) {
      clearHighlight();
      lastHover = { run, start: offset, end: offset + 1 };
      define(win, run, offset);
    }
  }
  document.addEventListener('mousemove', onScanMove);

  function clearHighlight() {
    clearScanHighlight();
    if (!activeRun) return;
    if (activeRun.dataset.seg) activeRun.classList.remove('jaword-active');
    else activeRun.textContent = activeRun.dataset.text;
    activeRun = null;
  }

  function highlight(run, start, len) {
    const t = run.dataset.text;
    const end = Math.min(start + len, t.length);
    run.textContent = '';
    if (start > 0) run.appendChild(document.createTextNode(t.slice(0, start)));
    const hl = document.createElement('span');
    hl.className = 'jaword-active';
    hl.textContent = t.slice(start, end);
    run.appendChild(hl);
    if (end < t.length) run.appendChild(document.createTextNode(t.slice(end)));
    return hl;
  }

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'jadict-pop';
    pop.hidden = true;
    document.body.appendChild(pop);
    document.addEventListener('mousedown', (e) => {
      if (pop.hidden) return;
      if (e.target.closest('.jadict-pop') || e.target.closest('.jarun')) return;
      hidePop();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePop(); });
    return pop;
  }

  function hidePop() {
    if (pop) pop.hidden = true;
    clearHighlight();
    lastHover = null;
  }

  function place(anchor) {
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = Math.min(r.left, window.innerWidth - pr.width - 8);
    left = Math.max(8, left);
    let top = r.bottom + 6;
    if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }

  async function define(win, run, offset) {
    const p = ensurePop();
    const my = ++reqId;
    p.hidden = false;
    p.innerHTML = '<div class="jadict-loading">Looking up…</div>';
    place(run);
    let j;
    try {
      j = await lookupWord({ word: win });
    } catch {
      if (my === reqId) { p.innerHTML = '<div class="jadict-empty">Lookup failed</div>'; place(run); }
      return;
    }
    if (my !== reqId) return;
    let anchor = run;
    if (j.matched > 0) { activeRun = run; anchor = highlight(run, offset, j.matched); }

    lastHover = { run, start: offset, end: offset + Math.max(1, j.matched || 0) };
    p.innerHTML = renderResults(j);
    place(anchor);
  }

  function renderEntry(res, idx, grammar) {
    const furi = res.reading ? furiganaHtml(res.headword, res.reading) : null;
    const head = '<span class="jadict-word">' + (furi || esc(res.headword)) + '</span>';
    const reading = (!furi && res.reading && res.reading !== res.headword)
      ? '<span class="jadict-reading">' + esc(res.reading) + '</span>' : '';
    const common = res.common ? '<span class="jadict-common">common</span>' : '';

    const reasons = (idx === 0 && grammar)
      ? '<div class="jadict-reasons">' + esc(grammar) + '</div>' : '';
    const senses = (res.senses || []).slice(0, 5).map((sn) => {
      const pos = (sn.pos && sn.pos.length) ? '<span class="jadict-pos">' + esc(sn.pos.join(', ')) + '</span> ' : '';
      return '<li>' + pos + esc((sn.glosses || []).join('; ')) + '</li>';
    }).join('');
    return '<div class="jadict-entry"><div class="jadict-head">' + head + reading + common + '</div>'
      + reasons + '<ol class="jadict-senses">' + senses + '</ol></div>';
  }

  function renderResults(j, grammar) {
    const word = j.word || '';
    const results = j.results || [];
    if (!results.length) {
      return '<div class="jadict-head">' + esc(word) + '</div><div class="jadict-empty">No dictionary match</div>';
    }
    return renderEntry(results[0], 0, grammar);
  }

  async function init() {
    try {
      const s = await fetch('/lang/status').then((r) => r.json());
      enabled = !!s.installed;
      if (enabled) fetch('/lang/start', { method: 'POST' }).catch(() => {});
    } catch { enabled = false; }
    return enabled;
  }
  init();

  let hoverSpan = null;
  function hoverAt(cssX, cssY) {
    const el = document.elementFromPoint(cssX, cssY);
    const span = el && el.closest ? el.closest('.jarun') : null;
    if (!span) {
      if (hoverSpan) { hoverSpan = null; clearHighlight(); if (pop) pop.hidden = true; }
      return;
    }
    if (span === hoverSpan) return;
    hoverSpan = span;
    onKuroClick({ currentTarget: span, stopPropagation() {} });
  }

  window.jadict = {
    renderJaText, refresh: init, hoverAt, get enabled() { return enabled; },
    get readingMode() { return readingMode; },
    setReadingMode(m) { readingMode = (['furigana', 'hiragana', 'romaji'].indexOf(m) >= 0) ? m : 'off'; },
    tokenizerChanged() { _tokState = null; },
  };
