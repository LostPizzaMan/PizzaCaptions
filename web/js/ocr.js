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
