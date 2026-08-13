(function () {
  
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

  const AUXILIARY_VERBS = new Set([
    'みる', 'おく', 'くれる', 'あげる', 'もらう', 'いく', '行く', 'くる', '来る',
    'くださる', 'ある', '有る', '始める', '始まる',
  ]);
  const BREAK_PARTICLES = new Set(['し', 'けど', 'けれど', 'が', 'のに', 'ので', 'から', 'と', 'ながら']);

  function getRelatedTokens(tokens, idx) {
    const el = tokens[idx];
    const related = [el];
    const basePos = el.dataset.pos;
    if (basePos !== '動詞' && basePos !== '形容詞' && basePos !== '形容動詞') return related;
    for (let i = idx + 1; i < tokens.length; i++) {
      const s = tokens[i];
      const pos = s.dataset.pos;
      const detail = s.dataset.posDetail || '';
      if ((s.dataset.word === 'です' && s.dataset.conjugatedForm !== '連用形') || s.dataset.word === 'だ') break;
      if (pos === '助詞' && detail === '接続助詞' && BREAK_PARTICLES.has(s.dataset.word)) break;
      if (pos === '助動詞') { related.push(s); continue; }
      if (pos === '動詞' && detail === '接尾') { related.push(s); continue; }
      if (pos === '動詞' && detail === '非自立' && !AUXILIARY_VERBS.has(s.dataset.word)) { related.push(s); continue; }
      if (pos === '助詞' && detail === '接続助詞') { related.push(s); continue; }
      if (pos === '助詞' && detail === '並立助詞' && (s.dataset.word === 'たり' || s.dataset.word === 'だり')) { related.push(s); continue; }
      break;
    }
    return related;
  }

  function getConjugationLabel(related) {
    const baseConjForm = related[0].dataset.conjugatedForm || '';
    if (related.length <= 1) {
      if (baseConjForm.startsWith('命令')) return 'imperative';
      if (baseConjForm === '連用形') return 'continuative';
      if (baseConjForm === '体言接続特殊') return 'negative';
      return '';
    }
    const suffixes = related.slice(1).map((s) => ({ word: s.dataset.word, surface: s.dataset.surface || s.textContent }));
    const words = new Set(suffixes.map((s) => s.word));
    const surfaces = new Set(suffixes.map((s) => s.surface));
    const baseConjType = related[0].dataset.conjugatedType || '';
    const isGodan = baseConjType.startsWith('五段') || baseConjType === 'サ変・スル' || baseConjType === 'カ変・クル';
    const hasTeForm = surfaces.has('て') || surfaces.has('で');
    const hasTa = (surfaces.has('た') || surfaces.has('だ')) && !surfaces.has('たら') && !surfaces.has('だら');
    const hasPolite = words.has('ます');
    const hasShimau = words.has('てしまう') || words.has('しまう');
    const hasChimau = words.has('ちまう') || words.has('じまう');
    const hasChau = words.has('ちゃう') || words.has('じゃう') || surfaces.has('じゃ');
    const hasTari = words.has('たり') || words.has('だり');
    const hasProgressiveAux = words.has('いる') || words.has('おる') || words.has('てる');
    const hasTeContraction = hasTeForm && hasTa && !hasShimau && !hasChimau && !hasChau;
    const hasTePolite = hasTeForm && hasPolite;
    const hasProgressive = hasProgressiveAux || hasTeContraction || hasTePolite;
    const tags = [];
    if (words.has('せる') || words.has('させる')) tags.push('causative');
    if (words.has('られる')) tags.push('potential or passive');
    else if (words.has('れる')) tags.push(isGodan ? 'passive' : 'potential');
    if (hasProgressive) tags.push('progressive');
    if (hasShimau) tags.push('〜しまう');
    if (hasChimau) tags.push('〜ちまう');
    if (hasChau) tags.push('〜ちゃう');
    if (words.has('すぎる')) tags.push('excessive');
    if (words.has('たい')) tags.push('〜たい');
    if (hasPolite) tags.push('polite');
    if (words.has('ない') || words.has('ぬ') || words.has('ん')) tags.push('negative');
    if (hasTa && (!hasTeForm || hasShimau || hasChimau || hasChau || hasProgressive)) tags.push('past');
    if (words.has('う') || words.has('よう')) tags.push('volitional');
    if (words.has('なさる')) tags.push('imperative');
    if (hasTari) tags.push('〜たり');
    if (hasTeForm && tags.length === 0) tags.push('te-form');
    if (surfaces.has('たら') || surfaces.has('だら') || words.has('ば')
        || suffixes.some((s) => s.word === 'ない' && (s.surface === 'なきゃ' || s.surface === 'なけれ'))) tags.push('conditional');
    return tags.join(' · ');
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

  function renderKuro(el, raw) {
    const tokens = wrapTokens(raw);
    el.textContent = '';
    el.dataset.jaline = '1';   
    
    const bounds = new Set([0]);
    let acc = 0;
    for (const t of raw) { acc += t.surface_form.length; bounds.add(acc); }
    el._jaBounds = bounds;
    let i = 0, off = 0;
    while (i < tokens.length) {
      const related = getRelatedTokens(tokens, i);
      const surface = related.map((t) => t.textContent).join('');
      if (!hasJa(surface)) {
        el.appendChild(document.createTextNode(surface));
      } else {
        const span = document.createElement('span');
        span.className = 'jarun';
        span.dataset.seg = '1';
        span.dataset.base = tokens[i].dataset.word;
        span.dataset.pos = tokens[i].dataset.pos;       
        span.dataset.grammar = getConjugationLabel(related);
        span.dataset.off = String(off);                 
        if (tokens[i].dataset.wt === 'UNKNOWN') span.dataset.unk = '1';
        span.textContent = surface;
        span.addEventListener('click', onKuroClick);
        el.appendChild(span);
      }
      off += surface.length;
      i += related.length;
    }
  }

  function onKuroClick(e) {
    e.stopPropagation();
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
      const r = await fetch('/lang/lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: text.slice(start, start + WINDOW), base: span.dataset.base, pos: span.dataset.pos }),
      });
      if (!r.ok) throw new Error(r.status);
      j = await r.json();
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
      const r = await fetch('/lang/lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: text.slice(start, start + WINDOW), base, pos }),
      });
      if (!r.ok) throw new Error(r.status);
      j = await r.json();
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
      const r = await fetch('/lang/lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: base, pos: pos || '' }),
      });
      if (!r.ok) throw new Error((await r.text()) || r.status);
      j = await r.json();
    } catch {
      if (my === reqId) { p.innerHTML = '<div class="jadict-empty">Lookup failed</div>'; place(anchor); }
      return;
    }
    if (my !== reqId) return;
    showResults(j, grammar, anchor);
  }

  async function renderJaText(el, text) {
    if (!enabled || !hasJa(text)) { el.textContent = text; return; }
    el.textContent = text;
    const token = String(++jaToken);
    el.dataset.jaTok = token;
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
    const related = getRelatedTokens(wrapTokens(raw), 0);
    const kCover = related.map((t) => t.textContent).join('').length;
    const kBase = (raw[0].basic_form && raw[0].basic_form !== '*') ? raw[0].basic_form : raw[0].surface_form;
    const kPos = raw[0].pos;
    const grammar = getConjugationLabel(related);

    const my = ++reqId;
    const p = ensurePop();
    p.hidden = false;
    p.innerHTML = '<div class="jadict-loading">Looking up…</div>';
    clearHighlight();
    setScanHighlight(rangeFor(line, start, start + kCover));   
    place(rangeFor(line, start, start + kCover) || line);

    let j;
    try {
      const r = await fetch('/lang/lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: text.slice(start, start + WINDOW), base: kBase, pos: kPos }),
      });
      if (!r.ok) throw new Error(r.status);
      j = await r.json();
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
    if (!enabled || !e.shiftKey) return;
    
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
      const r = await fetch('/lang/lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: win }),
      });
      if (!r.ok) throw new Error((await r.text()) || r.status);
      j = await r.json();
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

  window.jadict = { renderJaText, refresh: init, hoverAt, get enabled() { return enabled; } };

  const LANGS = [
    ['en-US', 'English'], ['ja-JP', 'Japanese'], ['zh-CN', 'Chinese (Simplified)'],
    ['zh-TW', 'Chinese (Traditional)'], ['ko-KR', 'Korean'], ['fr-FR', 'French'],
    ['es-ES', 'Spanish'], ['pt-BR', 'Portuguese'], ['ar-SA', 'Arabic'],
    ['th-TH', 'Thai'], ['tr-TR', 'Turkish'], ['lv-LV', 'Latvian'], ['nl-NL', 'Dutch'],
  ];

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; }
    catch {
      const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    }
  }

  let tpop = null, tpopKey = 0, tSrcEl = null, tOutEl = null, tText = null, tAnchor = null;
  let target = (() => { try { return localStorage.getItem('ocrTransTarget'); } catch { return null; } })() || 'en-US';

  function ensureTpop() {
    if (tpop) return tpop;
    tpop = document.createElement('div');
    tpop.className = 'ocr-tpop';
    tpop.hidden = true;
    const head = document.createElement('div'); head.className = 'ocr-tpop-head';
    const lbl = document.createElement('span'); lbl.textContent = 'To';
    const sel = document.createElement('select'); sel.className = 'ocr-tpop-lang';
    LANGS.forEach(([bcp, name]) => {
      const o = document.createElement('option'); o.value = bcp; o.textContent = name; sel.appendChild(o);
    });
    sel.value = target;
    if (!sel.value) { sel.value = 'en-US'; target = 'en-US'; }
    sel.addEventListener('change', () => {
      target = sel.value;
      try { localStorage.setItem('ocrTransTarget', target); } catch {  }
      if (tText != null) doTranslate();
    });
    head.append(lbl, sel);
    tSrcEl = document.createElement('div'); tSrcEl.className = 'ocr-tpop-src';
    tOutEl = document.createElement('div'); tOutEl.className = 'ocr-tpop-out';
    tpop.append(head, tSrcEl, tOutEl);
    document.body.appendChild(tpop);
    document.addEventListener('mousedown', (e) => {
      if (tpop.hidden) return;
      if (e.target.closest('.ocr-tpop') || e.target.closest('.ocr-menu')) return;
      hideTrans();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTrans(); });
    return tpop;
  }

  function hideTrans() { if (tpop) { tpop.hidden = true; tText = null; } }

  function placeT(anchor) {
    const r = anchor.getBoundingClientRect();
    const pr = tpop.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8));
    let top = r.bottom + 6;
    if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
    tpop.style.left = left + 'px';
    tpop.style.top = top + 'px';
  }

  function translate(text, anchor) {
    ensureTpop();
    tText = text; tAnchor = anchor;
    tpop.hidden = false;
    tSrcEl.textContent = text;
    doTranslate();
  }

  async function doTranslate() {
    const text = tText, anchor = tAnchor;
    if (text == null) return;
    const my = ++tpopKey;
    tOutEl.className = 'ocr-tpop-out';
    tOutEl.textContent = 'Translating…';
    placeT(anchor);
    let j, ok;
    try {
      const res = await fetch('/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sourceLanguage: '', targetLanguage: target }),
      });
      ok = res.ok;
      j = await res.json().catch(() => ({}));
    } catch (e) {
      if (my === tpopKey) { tOutEl.className = 'ocr-tpop-out err'; tOutEl.textContent = e.message; placeT(anchor); }
      return;
    }
    if (my !== tpopKey) return;
    tOutEl.className = 'ocr-tpop-out' + (ok ? '' : ' err');
    tOutEl.textContent = ok ? (j.translated || '(no translation)') : (j.detail || 'Translation failed');
    placeT(anchor);
  }

  let menu = null, menuFor = null;

  function ensureMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    menu.className = 'ocr-menu';
    menu.hidden = true;
    const item = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ocr-menu-item'; b.textContent = label;
      b.addEventListener('click', () => { const f = menuFor; hideMenu(); if (f) fn(f); });
      return b;
    };
    menu.append(
      item('Copy', (f) => copyText(f.text)),
      item('Translate', (f) => translate(f.text, f.anchor)),
    );
    document.body.appendChild(menu);
    document.addEventListener('mousedown', (e) => {
      if (!menu.hidden && !e.target.closest('.ocr-menu')) hideMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
    window.addEventListener('scroll', hideMenu, true);
    return menu;
  }

  function hideMenu() { if (menu) menu.hidden = true; }

  function lineMenu(x, y, text, anchor) {
    const m = ensureMenu();
    menuFor = { text, anchor };
    m.hidden = false;
    const mr = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(x, window.innerWidth - mr.width - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, window.innerHeight - mr.height - 8)) + 'px';
  }

  window.ocrKit = { copyText, translate, lineMenu };
})();
