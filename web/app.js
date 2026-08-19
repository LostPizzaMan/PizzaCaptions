(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };

  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var LANGUAGE_NAMES = {};
  var TRANS_SRC = {};
  var LANG_DATA = {};
  function applyLangData(data) {
    LANG_DATA = data || {};
    Object.keys(LANG_DATA).forEach(function (code) {
      var e = LANG_DATA[code] || {};
      if (e.name) LANGUAGE_NAMES[code] = e.name;
      TRANS_SRC[code] = e.src || '';
    });
  }

  function shortSrc(code) { return code === 'auto' ? 'AUTO' : (code || '').toUpperCase(); }

  function shortTgt(code) { return (code || '').split('-')[0].toUpperCase(); }

  var TR = {
    you:   { source: 'mic',      engine: '', model: '', src: '', tgt: 'ja-JP', device: '', program: '', translate: true,
             dest: { tts: false } },
    them: { source: 'loopback', engine: '', model: '', src: '', tgt: 'en-US', device: '', program: '', translate: true,
             dest: { tts: false } }
  };
  var running = { you: false, them: false };
  var active = null;
  var filter = 'all';
  var oscOwner = 'you';

  var overlaySource = 'off';

  var engineInfo = null;
  var allDevices = { mic: [], loopback: [] };
  var allPrograms = [];
  var programsAvailable = false;
  function isProgram(r) { return TR[r].source === 'program' && !!TR[r].program; }

  function loadPrograms() {
    return fetch('/audio/programs').then(function (r) { return r.json(); }).then(function (d) {
      programsAvailable = !!(d && d.available);
      allPrograms = (d && d.programs) || [];
      renderDrawer('them');
    }).catch(function () {});
  }
  var translateBackend = 'google';
  var TR_SUPPORTED = {};

  var ws = null, userClosing = false, capturing = false, dualMode = false;

  var pendingStart = false;

  var startGen = 0;
  var activeText = '', liveKind = null, activeLineTime = null;
  var shownChars = 0, latestLineLength = 0, lineCount = 0, lastCommittedText = '', engineSignalsFinal = false;
  var silenceTimer = null, lastLineUpdateAt = 0;
  var blockedPhrases = [], discardOtherAlphabets = false;
  var latency = { stt: null, translate: null, tts: null };

  var app = $('#app'), feed = $('#feed'), pop = $('#pop');
  var strip = $('.strip'), drawer = $('#drawer');
  var live = $('#cur-line'), liveWho = $('.who', live), liveO = $('.cap-o', live);
  var curBox = $('#current');
  var EMPTY = '<div class="empty">No captions yet. Start a transport to begin.</div>';

  function engineStreamsPartials(id) { return !DUAL_ENGINES[id]; }

  function showLiveLine(on) { if (curBox) curBox.style.display = on ? '' : 'none'; }
  showLiveLine(false);

  function label(r) { return r === 'you' ? 'You' : (r === 'win' ? 'Windows' : 'Them'); }

  function hasJa(s) { return /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/.test(s || ''); }

  function jaClickable(kind) { return !!(window.jadict && window.jadict.enabled); }

  function readingOn() { return !!(window.jadict && window.jadict.readingMode && window.jadict.readingMode !== 'off'); }

  function jaShow(kind, text) { return hasJa(text) && !!window.jadict && (jaClickable(kind) || readingOn()); }

  function renderOriginal(el) {
    var o = el.querySelector('.o'); if (!o) return;
    var text = el.dataset.oRaw != null ? el.dataset.oRaw : o.textContent;
    if (jaShow(el.dataset.kind, text)) window.jadict.renderJaText(o, text);
    else o.textContent = text;
  }

  function refreshReading() {
    $$('.ln', feed).forEach(function (el) {
      renderOriginal(el);
      if (el.dataset.trText) setTranslation(el, el.dataset.trText);
    });
  }

  function save() {
    try {
      localStorage.setItem('v2Transports', JSON.stringify({ TR: TR, oscOwner: oscOwner, overlaySource: overlaySource }));
    } catch (e) {}
  }

  function loadStored() {
    try {
      var s = JSON.parse(localStorage.getItem('v2Transports') || 'null');
      if (!s) return;

      if (s.TR && s.TR.guest && !s.TR.them) { s.TR.them = s.TR.guest; }
      if (s.oscOwner === 'guest') { s.oscOwner = 'them'; }
      ['you', 'them'].forEach(function (r) {
        if (s.TR && s.TR[r]) {
          var c = s.TR[r];
          ['engine', 'model', 'src', 'tgt', 'device', 'program', 'source', 'translate'].forEach(function (k) {
            if (c[k] !== undefined) TR[r][k] = c[k];
          });
          if (c.dest) TR[r].dest = c.dest;
        }
      });
      if (s.oscOwner !== undefined) oscOwner = s.oscOwner;
      if (s.overlaySource !== undefined) overlaySource = s.overlaySource;
    } catch (e) {}
  }

  function engById(id) { return engineInfo && engineInfo.engines.filter(function (e) { return e.id === id; })[0]; }

  var ENGINE_ORDER = ['whisper-batch', 'parakeet', 'nano', 'qwen3', 'whisper', 'parakeet-stream'];

  function engRank(id) { var i = ENGINE_ORDER.indexOf(id); return i < 0 ? ENGINE_ORDER.length : i; }

  function installedEngines() {
    if (!engineInfo) return [];
    return engineInfo.engines.filter(function (e) { return e.installed; })
      .sort(function (a, b) { return engRank(a.id) - engRank(b.id) || a.name.localeCompare(b.name); });
  }

  function seedDefaults(cfg) {
    var engs = installedEngines();
    var fallbackEngine = (engineInfo && engById(engineInfo.active_engine) && engById(engineInfo.active_engine).installed)
      ? engineInfo.active_engine : (engs[0] ? engs[0].id : '');
    ['you', 'them'].forEach(function (r) {
      var c = TR[r];

      if (!c.engine || !engById(c.engine) || !engById(c.engine).installed) c.engine = fallbackEngine;
      var e = engById(c.engine);
      if (e) {
        if (!c.model || e.models.indexOf(c.model) < 0) {
          var cfgModel = engineInfo.engine_models && engineInfo.engine_models[e.id];

          var hwDefault = (e.id === 'whisper-batch' && !engineInfo.has_nvidia_gpu) ? 'small' : e.default_model;
          c.model = cfgModel || hwDefault || e.models[0] || '';
        }
        if (!c.src || e.languages.indexOf(c.src) < 0) {
          c.src = (e.languages.indexOf(engineInfo.language) >= 0 ? engineInfo.language : (e.languages[0] || 'auto'));
        }
      }
      if (!c.tgt && cfg && cfg.target_language) c.tgt = cfg.target_language;
      if (!c.device && cfg) c.device = r === 'you' ? (cfg.mic_device_name || '') : (cfg.loopback_device_name || '');
    });
  }

  async function loadBackend() {
    var eng, dev, cfg;
    try {
      var results = await Promise.all([
        fetch('/engines').then(function (r) { return r.json(); }),
        fetch('/devices').then(function (r) { return r.json(); }),
        fetch('/config').then(function (r) { return r.json(); })
      ]);
      eng = results[0]; dev = results[1]; cfg = results[2];
    } catch (e) { renderAll(); return; }
    engineInfo = eng;
    allDevices = { mic: (dev && dev.mic) || [], loopback: (dev && dev.loopback) || [] };
    loadPrograms();

    blockedPhrases = ((cfg.default_blocked_phrases || []).concat(cfg.blocked_phrases || []))
      .map(normalizeForBlocklist).filter(Boolean);
    discardOtherAlphabets = cfg.discard_other_alphabets === true;
    translateBackend = cfg.translation_backend || 'google';
    TR_SUPPORTED = cfg.translate_supported_targets || {};
    seedDefaults(cfg);
    renderAll();

    if (engineInfo.engines.length && engineInfo.engines.every(function (e) { return !e.installed; })) {
      if (engineInfo.wizard_done) foot('No engine installed. Open Settings > Engines to install one.');
      else openWizard();
    }
  }

  function fillOpts(sel, opts, value) {
    if (!sel) return;
    sel.innerHTML = '';
    opts.forEach(function (o) {
      var el = document.createElement('option');
      el.value = o.v; el.textContent = o.n;
      if (o.disabled) el.disabled = true;
      if (o.v === value) el.selected = true;
      sel.appendChild(el);
    });
  }

  var PINNED_LANGS = ['auto'];

  function langOpts(codes, pin, valueOf) {
    var has = {};
    codes.forEach(function (c) { has[c] = true; });
    var top = pin.filter(function (c) { return has[c]; });
    var rest = codes.filter(function (c) { return pin.indexOf(c) < 0; });
    rest.sort(function (a, b) {
      return (LANGUAGE_NAMES[a] || a).localeCompare(LANGUAGE_NAMES[b] || b);
    });
    function opt(c) { return { v: valueOf(c), n: LANGUAGE_NAMES[c] || c }; }
    return top.map(opt).concat(rest.map(opt));
  }

  function srcLangOpts(langs) {
    return langOpts(langs, PINNED_LANGS, function (c) { return c; });
  }

  function buildTargetOpts() {
    var out = [];
    Object.keys(LANG_DATA).forEach(function (code) {
      if (code === 'auto') return;
      var e = LANG_DATA[code] || {};
      if (e.targets && e.targets.length) {
        e.targets.forEach(function (t) { out.push({ v: t.code, n: t.name }); });
      } else {
        out.push({ v: e.src || code, n: e.name || code });
      }
    });
    out.sort(function (a, b) { return a.n.localeCompare(b.n); });
    return out;
  }

  function targetLangOpts(backend) {
    var bk = backend === undefined ? translateBackend : backend;
    var out = buildTargetOpts();
    var allow = TR_SUPPORTED[bk];
    if (allow && allow.length) {
      var set = {}; allow.forEach(function (c) { set[c] = 1; });
      out = out.filter(function (o) { return set[o.v]; });
    }
    return out;
  }

  function tgtName(code) {
    var hit = buildTargetOpts().filter(function (o) { return o.v === code; })[0];
    return hit ? hit.n : code;
  }

  function matchDeviceValue(list, name) {
    var m = list.filter(function (d) { return d.name === name; })[0];
    return m ? String(m.index) : (list[0] ? String(list[0].index) : '');
  }

  function engName(id) { var e = engById(id); return e ? e.name : (id || '-'); }

  function engShort(id) { return engName(id).replace(/\s*\([^)]*\)\s*$/, '').trim(); }

  function renderStrip(r) {
    var c = TR[r];
    $('#' + r + '-eng').innerHTML = c.engine
      ? escHtml(engShort(c.engine)) + (c.model ? ' <span class="m">' + escHtml(c.model) + '</span>' : '')
      : 'No engine';
    var flow = c.translate
      ? (escHtml(shortSrc(c.src)) + ' <span class="a">&rarr;</span> ' + escHtml(shortTgt(c.tgt)))
      : escHtml(shortSrc(c.src));
    $('#' + r + '-flow').innerHTML = flow;
    $('#f' + r).textContent = c.engine ? (engShort(c.engine) + (c.model ? '·' + c.model : '')) : '-';
  }

  function renderDrawer(r) {
    var dc = $('#dc-' + r), c = TR[r];

    var engs = installedEngines();
    fillOpts($('[data-cfg="engine"]', dc), engs.length
      ? engs.map(function (e) { return { v: e.id, n: e.name }; })
      : [{ v: '', n: 'No engine installed' }], c.engine);

    var e = engById(c.engine);

    var lockModel = (r === 'them' && sharedModelDual() && e && e.models.length > 1);
    if (lockModel) c.model = TR.you.model;
    var mSel = $('[data-cfg="model"]', dc);
    fillOpts(mSel, (e ? e.models : []).map(function (m) { return { v: m, n: m }; }), c.model);
    if (mSel) mSel.disabled = lockModel;

    var mVal = $('.mdl-val', dc);
    if (mVal) { if (lockModel) mVal.title = 'In dual, both slots share one model.'; else mVal.removeAttribute('title'); }
    fillOpts($('[data-cfg="src"]', dc), srcLangOpts(e ? e.languages : []), c.src);
    var topts = targetLangOpts();

    if (c.tgt && !topts.some(function (o) { return o.v === c.tgt; })) {
      topts = [{ v: c.tgt, n: tgtName(c.tgt) + ' (not supported)' }].concat(topts);
    }
    fillOpts($('[data-cfg="tgt"]', dc), topts, c.tgt);

    $('.mdl-fg', dc).style.display = (e && e.models.length > 1) ? '' : 'none';

    var list = r === 'you' ? allDevices.mic : allDevices.loopback;
    if (!c.device && !isProgram(r) && list[0]) c.device = list[0].name;
    var opts = list.length
      ? list.map(function (d) { return { v: String(d.index), n: d.name }; })
      : [{ v: '', n: 'No ' + (r === 'you' ? 'microphone' : 'desktop') + ' devices' }];
    var selVal = matchDeviceValue(list, c.device);
    if (r === 'them' && programsAvailable) {
      opts = opts.concat(allPrograms.map(function (p) { return { v: 'prog:' + p.name, n: '▶ ' + p.name }; }));
      if (isProgram(r)) {
        selVal = 'prog:' + c.program;

        if (!allPrograms.some(function (p) { return p.name === c.program; })) {
          opts.push({ v: selVal, n: '▶ ' + c.program + ' (not running)' });
        }
      }
    }
    fillOpts($('[data-cfg="device"]', dc), opts, selVal);

    var xt = $('[data-cfg="translate"]', dc);
    xt.setAttribute('aria-pressed', c.translate); xt.textContent = c.translate ? 'On' : 'Off';
    $('.xlate', dc).classList.toggle('off', !c.translate);
    $$('.dst[data-d]', dc).forEach(function (b) {
      var d = b.dataset.d;

      b.setAttribute('aria-pressed',
        d === 'osc' ? (oscOwner === r) : !!c.dest[d]);
    });
  }

  function renderAll() {
    ['you', 'them'].forEach(function (r) { renderStrip(r); renderDrawer(r); });
    refreshStatus();
  }

  function refreshStatus() {
    var n = (running.you ? 1 : 0) + (running.them ? 1 : 0);
    $('#srcs').textContent = n === 0 ? 'idle' : n + ' source' + (n > 1 ? 's' : '');
    var live = $('#live');
    live.classList.toggle('off', n === 0);
    live.textContent = n === 0 ? 'Idle' : 'Listening';
    $('#fstate').textContent = n === 0 ? 'Idle' : 'Listening';
    ['you', 'them'].forEach(function (r) { $('#tr-' + r).classList.toggle('on', running[r]); });
  }

  function foot(text) { $('#fstate').textContent = text; }

  function toast(kind, eyebrow, msg, action) {
    var wrap = $('#toasts'); if (!wrap) { foot(msg); return; }
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.innerHTML = '<div class="stripe"></div><div class="tbody">'
      + (eyebrow ? '<div class="tk"></div>' : '')
      + '<div class="tmsg"></div>'
      + (action ? '<div class="tact"><button class="go"></button><button class="mute" data-close>Dismiss</button></div>' : '')
      + '</div><button class="tx" data-close aria-label="Close">×</button>'
      + (action ? '' : '<div class="tlife"></div>');
    if (eyebrow) $('.tk', t).textContent = eyebrow;
    $('.tmsg', t).textContent = msg;
    if (action) $('.tact .go', t).textContent = action.label;
    wrap.appendChild(t);
    var kill = function () {
      if (!t.parentNode) return;
      t.classList.add('out'); setTimeout(function () { if (t.parentNode) t.remove(); }, 220);
    };
    $$('[data-close]', t).forEach(function (b) { b.addEventListener('click', kill); });
    if (action) $('.tact .go', t).addEventListener('click', function () { kill(); if (action.onClick) action.onClick(); });
    else setTimeout(kill, 4400);
    return t;
  }

  function dialog(opts) {
    return new Promise(function (resolve) {
      var bd = $('#dlg-backdrop'), card = $('#dlg');
      if (!bd || !card) { resolve(window.confirm((opts.h || '') + (opts.p ? '\n\n' + opts.p.replace(/<[^>]+>/g, '') : ''))); return; }
      card.innerHTML = '<div class="dk"></div><h2></h2><p></p>'
        + '<div class="dacts"><button class="sbtn" data-x></button><button class="sbtn primary" data-ok></button></div>';
      $('.dk', card).textContent = opts.k || 'Confirm';
      $('h2', card).textContent = opts.h || '';
      $('p', card).innerHTML = opts.p || '';
      $('[data-x]', card).textContent = opts.cancel || 'Cancel';
      var okb = $('[data-ok]', card);
      okb.textContent = opts.ok || 'OK';
      if (opts.danger) okb.classList.add('danger');
      var onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
      var done = function (v) { bd.removeAttribute('data-open'); document.removeEventListener('keydown', onKey, true); resolve(v); };
      $('[data-x]', card).onclick = function () { done(false); };
      okb.onclick = function () { done(true); };
      bd.onclick = function (e) { if (e.target === bd) done(false); };
      document.addEventListener('keydown', onKey, true);
      bd.setAttribute('data-open', '');
      setTimeout(function () { okb.focus(); }, 0);
    });
  }

  function openExternal(url) {
    if (url) fetch('/open-external', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url }) }).catch(function () {});
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[target="_blank"]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) { e.preventDefault(); openExternal(href); }
  }, true);

  var _dlpCancelled = false;
  function dlpUpdate(st) {
    var d = (st && st.detail) || '';

    var mSize = d.match(/([\d.]+)\s*\/\s*([\d.]+)\s*(MB|GB)/i);
    var fill = $('#dlp-fill');
    if (mSize) {
      var pct = Math.min(100, Math.round(+mSize[1] / +mSize[2] * 100));
      fill.classList.remove('indet'); fill.style.width = pct + '%';
      $('#dlp-pct').textContent = pct + '%'; $('#dlp-size').textContent = mSize[0];
    } else {
      fill.classList.add('indet'); $('#dlp-pct').textContent = 'Downloading…'; $('#dlp-size').textContent = '';
    }
  }
  var dlpCancelBtn = $('#dlp-cancel');
  if (dlpCancelBtn) dlpCancelBtn.addEventListener('click', function () {
    _dlpCancelled = true; dlpCancelBtn.disabled = true; dlpCancelBtn.textContent = 'Cancelling…';
    fetch('/models/download/cancel', { method: 'POST' }).catch(function () {});
  });

  async function runModelDownload(engine, md) {
    var bd = $('#dlp-backdrop');
    _dlpCancelled = false;
    if (dlpCancelBtn) { dlpCancelBtn.disabled = false; dlpCancelBtn.textContent = 'Cancel'; }
    $('#dlp-title').textContent = engName(engine);
    $('#dlp-sub').textContent = (md.label || md.id) + (md.est_download ? ' · ' + md.est_download : '');
    if (bd) bd.classList.remove('done');
    dlpUpdate({});
    if (bd) bd.setAttribute('data-open', '');
    foot('Downloading ' + engName(engine) + ' model…');

    function dlpFail(kind, msg) {
      if (bd) bd.removeAttribute('data-open');
      toast(kind, '', msg);
      refreshStatus();
      return false;
    }
    try {
      var resp = await fetch('/models/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: engine, model: md.id }) });
      if (!resp.ok) {
        var detail = ''; try { detail = (await resp.json()).detail; } catch (e2) {}
        return dlpFail('warn', detail || 'Could not start the model download.');
      }
    } catch (e) { return dlpFail('bad', 'Could not start the download.'); }
    var s = await pollInstall(function (st) { dlpUpdate(st); });
    if (_dlpCancelled || s.phase === 'cancelled') return dlpFail('info', 'Download cancelled.');
    if (s.error) return dlpFail('warn', 'Model download failed. Try again from Settings > Engines.');
    if (bd) { bd.classList.add('done'); $('#dlp-fill').classList.remove('indet'); $('#dlp-fill').style.width = '100%'; $('#dlp-pct').textContent = '100%'; }
    await new Promise(function (r) { setTimeout(r, 500); });
    if (bd) bd.removeAttribute('data-open');
    return true;
  }

  function renderLatency() {
    var parts = [];
    if (latency.stt != null) parts.push('STT ' + latency.stt + 'ms');
    if (latency.translate != null) parts.push('TL ' + latency.translate + 'ms');
    if (latency.tts != null) parts.push('TTS ' + latency.tts + 'ms');
    $('#flat').textContent = parts.length ? parts.join(' + ') : '-';
  }

  var ALNUM = /[\p{L}\p{N}]/u;

  function normalizeForBlocklist(t) { return (t || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase(); }

  function normalizeWithMap(chars) {
    var norm = '', map = [];
    chars.forEach(function (ch, i) {
      if (!ALNUM.test(ch)) return;
      var low = ch.toLowerCase(); norm += low;
      for (var k = 0; k < low.length; k++) map.push(i);
    });
    return { norm: norm, map: map };
  }
  var UNSPACED = /[぀-ヿ㐀-䶿一-鿿豈-﫿฀-๿\u{20000}-\u{2fa1f}]/u;

  function isWordy(ch) { return ALNUM.test(ch) && !UNSPACED.test(ch); }

  function boundaryOk(chars, start, end) {
    if (start > 0 && isWordy(chars[start - 1]) && isWordy(chars[start])) return false;
    if (end + 1 < chars.length && isWordy(chars[end + 1]) && isWordy(chars[end])) return false;
    return true;
  }

  function widenCuts(chars, drop) {
    var n = chars.length, i = 0;
    while (i < n) {
      if (!drop[i]) { i++; continue; }
      var end = i; while (end < n && drop[end]) end++;
      var after = end; while (after < n && !ALNUM.test(chars[after])) after++;
      for (var x = end; x < after; x++) drop[x] = true;
      for (var y = i - 1; y >= 0 && !ALNUM.test(chars[y]) && !/\s/.test(chars[y]); y--) drop[y] = true;
      if (after >= n) { for (var z = i - 1; z >= 0 && !ALNUM.test(chars[z]); z--) drop[z] = true; }
      i = after + 1;
    }
  }

  function tidyAfterStrip(text) {
    var out = [];
    for (var ci = 0; ci < text.length; ci++) {
      var ch = text[ci];
      if (/\s/.test(ch)) { if (out.length && out[out.length - 1] !== ' ') out.push(' '); continue; }
      if (!ALNUM.test(ch)) {
        var j = out.length - 1; while (j >= 0 && out[j] === ' ') j--;
        if (j >= 0 && !ALNUM.test(out[j])) continue;
        while (out.length && out[out.length - 1] === ' ') out.pop();
      }
      out.push(ch);
    }
    var chars = out; while (chars.length && !ALNUM.test(chars[0])) chars = chars.slice(1);
    return chars.join('').trim();
  }

  function stripBlockedPhrases(text) {
    var chars = Array.from(text || '');
    var nm = normalizeWithMap(chars), norm = nm.norm, map = nm.map;
    if (!norm) return { text: text || '', removed: false };
    var drop = new Array(chars.length).fill(false), removed = false;
    blockedPhrases.forEach(function (p) {
      if (!p) return;
      var i = norm.indexOf(p);
      while (i !== -1) {
        var from = map[i], to = map[i + p.length - 1];
        if (!boundaryOk(chars, from, to)) { i = norm.indexOf(p, i + 1); continue; }
        for (var c = from; c <= to; c++) drop[c] = true;
        removed = true; i = norm.indexOf(p, i + p.length);
      }
    });
    if (!removed) return { text: text, removed: false };
    widenCuts(chars, drop);
    return { text: tidyAfterStrip(chars.filter(function (_, i) { return !drop[i]; }).join('')), removed: true };
  }
  var OTHER_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
  var WORTH_SHOWING = /[\p{Script=Latin}\p{Nd}]/u;

  function englishModeSelected() { return !!active && TR[active].src === 'en'; }

  function stripOtherAlphabets(text) {
    var original = text || '', chars = Array.from(original);
    var drop = chars.map(function (ch) { return OTHER_SCRIPT.test(ch); });
    var kept = original;
    if (drop.some(Boolean)) { widenCuts(chars, drop); kept = tidyAfterStrip(chars.filter(function (_, i) { return !drop[i]; }).join('')); }
    if (!WORTH_SHOWING.test(kept)) kept = '';
    return { text: kept, removed: kept !== original };
  }

  function stripCommittedOverlap(text, prev) {
    var committed = (prev !== undefined ? prev : lastCommittedText);
    if (!text || !committed) return text;
    committed = committed.trim();
    var maxOverlap = Math.min(committed.length, text.length, 8);
    for (var size = maxOverlap; size >= 4; size--) {
      var suffix = committed.slice(-size);
      if (text.indexOf(suffix) === 0) return text.slice(size).replace(/^\s+/, '');
    }
    return text;
  }

  function hasRepetition(text) {
    if (!text || text.length < 3) return false;
    var normalized = text.replace(/\s+/g, '').replace(/[。、.,!?！？]/g, '');

    return /(.{2,20})\1{2,}/.test(normalized);
  }
  var SENTENCE_ENDERS = /[。．！？!?]/;
  var SOFT_LENGTH_LIMIT = 30;

  function endsWithSentenceEnder(text) {
    if (SENTENCE_ENDERS.test(text.slice(-2))) return true;
    return text.slice(-1) === '.' && !/\d\.$/.test(text);
  }

  var SILENCE_COMMIT_MS = 1250, SILENCE_FORCE_MARKED_MS = 8000;

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    lastLineUpdateAt = Date.now();
    silenceTimer = setTimeout(onSilence, SILENCE_COMMIT_MS);
  }

  function onSilence() {
    if (engineSignalsFinal && activeText && Date.now() - lastLineUpdateAt < SILENCE_FORCE_MARKED_MS) {
      silenceTimer = setTimeout(onSilence, SILENCE_COMMIT_MS); return;
    }
    commitActiveLine(); silenceTimer = null;
  }

  var startupPoll = null;
  function stopStartupPoll() { if (startupPoll) { clearTimeout(startupPoll); startupPoll = null; } }
  function startStartupPoll() {
    stopStartupPoll();
    var tick = function () {
      startupPoll = null;
      fetch('/engine/startup').then(function (r) { return r.json(); }).then(function (s) {
        if (capturing || !active || dualMode) return;
        var txt = s.phase === 'ready' ? '' : 'Loading model…';
        if (txt) { foot(txt); setPreparing(txt); }
        if (s.phase !== 'ready') startupPoll = setTimeout(tick, 500);
      }).catch(function () { if (!capturing && active && !dualMode) startupPoll = setTimeout(tick, 900); });
    };
    tick();
  }

  function setPreparing(text) {
    live.className = 'current idle'; liveWho.textContent = '';
    liveO.textContent = text; liveO.classList.remove('capcursor'); liveKind = null;
  }

  function setIdle() {
    stopStartupPoll();
    live.className = 'current idle'; liveWho.textContent = 'Idle';
    liveO.textContent = 'Waiting for audio'; liveO.classList.remove('capcursor'); liveKind = null; activeText = '';
    showLiveLine(false);
  }

  function setListening(kind) {
    stopStartupPoll();
    liveKind = kind; live.className = 'current ' + (kind === 'you' ? 'you' : 'them');
    liveWho.textContent = label(kind); liveO.textContent = activeText || ''; liveO.classList.add('capcursor');
    showLiveLine(engineStreamsPartials(TR[kind] && TR[kind].engine));
  }

  function ensureActiveLine() {
    var fresh = !activeLineTime;
    if (liveKind !== active || live.classList.contains('idle')) setListening(active);
    if (fresh) {
      activeLineTime = new Date();
      if (active && oscOwner === active) send({ action: 'osc_typing', flag: true });
    }
  }

  function updateActiveLine(text) {
    ensureActiveLine();
    activeText = text; liveO.textContent = text; liveO.classList.add('capcursor');
    if (!engineSignalsFinal && text.length >= SOFT_LENGTH_LIMIT && endsWithSentenceEnder(text)) {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      commitActiveLine();
    } else {
      resetSilenceTimer();
    }
  }

  function timeStr(d) { return (d || new Date()).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

  function addFeedLine(kind, text, when) {
    var el = document.createElement('div');
    el.className = 'ln ' + (kind === 'you' ? 'you' : kind === 'win' ? 'win' : 'them') + ' anim';
    el.dataset.kind = kind;
    el.innerHTML =
      '<div class="top"><span class="who">' + label(kind) + '</span><span class="o"></span>' +
      '<span class="time">' + timeStr(when) + '</span></div>' +
      '<div class="x" style="display:none"></div>';

    el.dataset.oRaw = text;
    renderOriginal(el);
    applyFilter(el);
    var em = feed.querySelector('.empty'); if (em) em.remove();
    feed.insertBefore(el, feed.firstChild); feed.scrollTop = 0;
    bindWords(el);
    return el;
  }

  function setTranslation(el, text, pending) {
    var x = el.querySelector('.x');
    if (!text) { x.style.display = 'none'; x.textContent = ''; return; }
    if (!pending) el.dataset.trText = text;
    x.innerHTML = '';

    if (!pending && jaShow(el.dataset.kind, text)) {
      var span = document.createElement('span'); window.jadict.renderJaText(span, text); x.appendChild(span);
    } else {
      x.appendChild(document.createTextNode(text));
    }
    x.style.display = '';
    x.classList.toggle('pending', !!pending);
  }

  async function requestTranslation(text, el, r, doOsc) {
    var c = TR[r];
    setTranslation(el, 'Translating…', true);
    try {
      var body = { text: text, sourceLanguage: TRANS_SRC[c.src] || '', targetLanguage: c.tgt || '' };
      var res = await fetch('/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      var payload = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        var d = (typeof payload.detail === 'string') ? payload.detail
              : (payload.detail ? JSON.stringify(payload.detail) : 'HTTP ' + res.status);
        setTranslation(el, '[Translation unavailable] ' + d);

        if (doOsc) sendOsc(text).then(stopOscTyping);
        return;
      }
      if (typeof payload.translate_ms === 'number') { latency.translate = payload.translate_ms; renderLatency(); }
      var translated = payload.translated || '';
      setTranslation(el, translated);

      if (translated && autoSpeakOn(r) && ttsReads === 'translation') ttsSpeak(translated);
      if (doOsc) sendOsc(text, translated).then(stopOscTyping);
    } catch (err) {
      setTranslation(el, '[Translation unavailable] ' + err.message);
      if (doOsc) sendOsc(text).then(stopOscTyping);
    }
  }

  var OSC_MAX_CHARS = 144, OSC_ELLIPSIS = '…', OSC_SNAP_WINDOW = 24, OSC_TRANSLATION_SHARE = 0.55;

  function oscTailWindow(text, budget) {
    if (text.length <= budget) return text;
    var cut = text.slice(-(budget - OSC_ELLIPSIS.length));
    var sp = cut.indexOf(' '); if (sp > -1 && sp <= OSC_SNAP_WINDOW) cut = cut.slice(sp + 1);
    return OSC_ELLIPSIS + cut;
  }

  function oscHeadWindow(text, budget) {
    if (text.length <= budget) return text;
    var cut = text.slice(0, budget - OSC_ELLIPSIS.length);
    var sp = cut.lastIndexOf(' '); if (sp > -1 && cut.length - sp <= OSC_SNAP_WINDOW) cut = cut.slice(0, sp);
    return cut + OSC_ELLIPSIS;
  }

  function buildOscPayload(originalText, translatedText) {
    var original = (originalText || '').trim(), translated = (translatedText || '').trim();
    if (!translated) return oscTailWindow(original, OSC_MAX_CHARS);
    var sep = '\n', combined = original + sep + translated;
    if (combined.length <= OSC_MAX_CHARS) return combined;
    var avail = OSC_MAX_CHARS - sep.length;
    var tBudget = Math.min(translated.length, Math.round(avail * OSC_TRANSLATION_SHARE));
    var oBudget = avail - tBudget;
    if (original.length < oBudget) { tBudget = Math.min(translated.length, avail - original.length); oBudget = avail - tBudget; }
    return oscTailWindow(original, oBudget) + sep + oscHeadWindow(translated, tBudget);
  }

  async function sendOsc(original, translated) {
    var payload = buildOscPayload(original, translated || '');
    if (payload) await send({ action: 'send_osc', text: payload });
  }

  function stopOscTyping() { return send({ action: 'osc_typing', flag: false }); }

  var ttsReads = 'original';
  var ttsVoice = '', ttsDevice = '';

  function autoSpeakOn(r) { return !!(r && TR[r] && TR[r].dest.tts); }

  function ttsSyncLight() { var t = $('.tool[data-tool="tts"]'); if (t) t.classList.toggle('on', !!(TR.you.dest.tts || TR.them.dest.tts)); }

  async function ttsSpeak(text) {
    if (!text) return;
    var body = { text: text };
    if (ttsVoice) body.voice = ttsVoice;
    if (ttsDevice) body.device = ttsDevice;
    try { await fetch('/tts/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (e) {}
  }

  function overlayShowing() { return overlaySource !== 'off'; }

  function overlaySourceActive() {
    if (overlaySource === 'win_captions') return true;
    if (overlaySource === 'you' || overlaySource === 'them') return dualMode ? !!running[overlaySource] : !!capturing;
    return false;
  }

  function ccSyncGlow() {
    var t = $('.tool[data-tool="cc"]'); if (t) t.classList.toggle('on', overlayShowing());
  }

  function syncOverlayToSource() {
    if (overlaySource !== 'you' && overlaySource !== 'them') return;
    var on = !!running[overlaySource];
    if (on) { try { send({ action: 'set_overlay_owner', slot: overlaySource }); } catch (e) {} }
    fetch('/captions/overlay/' + (on ? 'show' : 'hide'), { method: 'POST' }).catch(function () {});
    ccSyncGlow();
  }

  function ccSyncSrcValue() { var sel = $('#cc-src'); if (sel && sel.value !== overlaySource) sel.value = overlaySource; }

  async function setOverlaySource(val) {
    var sel = $('#cc-src'), note = $('#cc-src-note'), prev = overlaySource;
    if (val === 'win_captions' && (!ccWinStatus.win_captions_supported || !ccWinStatus.win_captions_installed)) {
      overlaySource = 'win_captions'; if (sel) sel.value = 'win_captions'; ccApplyWin(); ccSyncGlow(); save(); return;
    }
    overlaySource = val; if (sel) sel.value = val;
    var wantSrc = val === 'win_captions' ? 'win_captions' : 'current';
    var hadSrc = prev === 'win_captions' ? 'win_captions' : 'current';
    try {
      if (wantSrc !== hadSrc) {
        if (note) { note.hidden = false; note.textContent = val === 'win_captions' ? 'Starting Windows Live Captions…' : 'Switching to the app engine…'; }
        var res = await fetch('/captions/overlay/source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: wantSrc }) });
        if (!res.ok) {
          var b = await res.json().catch(function () { return {}; });
          if (note) { note.hidden = false; note.textContent = (b && b.detail) || 'Could not switch source.'; }
          overlaySource = prev; if (sel) sel.value = prev; ccApplyWin(); ccSyncGlow(); return;
        }
        if (note) note.hidden = true;
      }
      if (val === 'you' || val === 'them') send({ action: 'set_overlay_owner', slot: val });

      await fetch('/captions/overlay/' + (overlaySourceActive() ? 'show' : 'hide'), { method: 'POST' });
    } catch (e) { if (note) { note.hidden = false; note.textContent = 'Could not reach the app.'; } }
    ccApplyWin(); ccSyncGlow(); save();
  }

  function ccReconcileOverlay() {
    Promise.all([
      fetch('/captions/overlay/state').then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch('/captions/source/status').then(function (r) { return r.json(); }).catch(function () { return {}; })
    ]).then(function (res) {
      var st = res[0], src = res[1] || {};
      ccWinStatus = src.win_captions_present ? src : {};

      if (!st) { ccSyncGlow(); ccSyncSrcValue(); return; }
      if (!st.shown) overlaySource = 'off';
      else if (src.source === 'win_captions') overlaySource = 'win_captions';
      else if (overlaySource !== 'you' && overlaySource !== 'them') overlaySource = 'them';
      ccSyncGlow(); ccSyncSrcValue(); save();
    }).catch(function () {});
  }

  function emitLine(r, text, when) {
    var el = addFeedLine(r, text, when || new Date());
    var doOsc = !!r && oscOwner === r;
    if (r && TR[r] && TR[r].translate) requestTranslation(text, el, r, doOsc);
    else if (doOsc) sendOsc(text).then(stopOscTyping);

    if (autoSpeakOn(r) && !(TR[r] && TR[r].translate && ttsReads === 'translation')) ttsSpeak(text);
    return el;
  }

  function cleanCommitText(raw, isEnglishSrc) {
    var text = raw ? stripBlockedPhrases(raw).text : '';
    if (discardOtherAlphabets && text && isEnglishSrc) {
      var latin = stripOtherAlphabets(text);
      if (latin.removed) text = latin.text;
    }
    return { text: text, dropped: !!(raw && !text) };
  }

  function commitActiveLine() {
    var raw = (activeText || '').trim();
    var res = cleanCommitText(raw, englishModeSelected());
    var text = res.text;
    var owner = liveKind || active;
    if (res.dropped) {
      shownChars = latestLineLength; lastCommittedText = raw;
      if (owner && oscOwner === owner) stopOscTyping();
    } else if (text) {
      shownChars = latestLineLength;
      emitLine(owner, text, activeLineTime);
      lastCommittedText = raw;
    }
    activeText = ''; activeLineTime = null;
    if (capturing && active) setListening(active); else setIdle();
  }

  function handleServerMessage(data) {
    var lines = Array.isArray(data.lines) ? data.lines : [];
    var visible = lines.filter(function (l) { return l.speaker !== -2 && (l.text || '').trim(); });
    var latest = visible[visible.length - 1];
    if (!latest) return;

    engineSignalsFinal = data.line_count !== undefined;
    var count = data.line_count !== undefined ? data.line_count : visible.length;
    if (count !== lineCount) {
      if (count > lineCount) commitActiveLine();
      lineCount = count; shownChars = 0; lastCommittedText = '';
      latency.stt = latency.translate = latency.tts = null; renderLatency();
    }
    if (typeof data.decode_ms === 'number') { latency.stt = data.decode_ms; renderLatency(); }

    var fullText = latest.text.trim();
    if (fullText.length < shownChars) shownChars = 0;
    latestLineLength = fullText.length;

    var newText = fullText.slice(shownChars).trim().replace(/^[。．？！?!]+/, '');
    var deduped = stripCommittedOverlap(newText);

    if (hasRepetition(fullText)) { commitActiveLine(); if (dualMode) restartDualSlot(streamSlot); else reconnectCapture(); return; }
    if (!deduped) return;
    if (/^[。．？！?!.,\s]+$/.test(deduped)) return;
    if (deduped !== activeText) updateActiveLine(deduped);
    if (data.final) {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      commitActiveLine();
    }
  }

  function send(obj) {
    openWs();
    return new Promise(function (resolve) {
      var go = function () { ws.send(JSON.stringify(obj)); resolve(); };
      if (ws.readyState === WebSocket.OPEN) go();
      else ws.addEventListener('open', go, { once: true });
    });
  }

  function openWs() {
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    ws = new WebSocket('ws://' + location.host + '/control');
    var sock = ws;
    ws.addEventListener('message', function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.type === 'audio_level') {
        var lvlR;
        if (dualMode) {
          if (msg.stream !== 'you' && msg.stream !== 'them') return;
          lvlR = msg.stream;
        } else { lvlR = active; }
        if (!lvlR) return;
        var f = $('#tr-' + lvlR + ' .lvl-fill');
        if (f) { f.style.width = Math.round(msg.level * 100) + '%'; f.classList.toggle('gated', !!msg.gated); }
        if (lvlR === 'you') {
          lastMicLevel = msg.level;
          var gf = $('#gate-fill');
          if (gf) {
            gf.style.width = Math.round(msg.level * 100) + '%';

            gf.classList.toggle('gated', gateDragging ? gatePreviewGated() : !!msg.gated);
          }
        }
        return;
      }
      if (msg.type === 'state') {
        if (capturing) foot(msg.state === 'processing' ? 'Processing…' : 'Listening');
        return;
      }
      if (msg.type === 'capture_ended') {
        if (dualMode) {
          var slot = (msg.stream === 'you' || msg.stream === 'them') ? msg.stream : active;
          if (slot === 'you' || slot === 'them') stopDualSlot(slot);
          else stopDual();
          return;
        }
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        commitActiveLine(); resetOffsets(); pendingStart = false; capturing = false;
        running.you = running.them = false; active = null;
        clearMeters(); refreshStatus(); foot('Stopped'); setIdle();
        return;
      }
      if (msg.type === 'ocr_overlay') {
        ocrOverlayOn = !!msg.shown;
        var ot = $('.tool[data-tool="ocr"]'); if (ot) ot.setAttribute('aria-pressed', msg.shown ? 'true' : 'false');
        return;
      }
      if (msg.type === 'toast') {
        var tact = msg.action === 'ocr_settings'
          ? { label: 'Open Settings', onClick: function () { openSettings('ocr'); } } : null;
        toast(msg.kind || '', msg.eyebrow || '', msg.msg || '', tact);
        return;
      }
      settleAck(msg);
      if (msg.error) {
        stopStartupPoll(); console.error('control:', msg.error);
        if (pendingStart) { failStart(msg.error); return; }
        foot(msg.error); return;
      }
      if (msg.status === 'capture_started' || msg.status === 'capture_stopped') return;
      if (msg.status === 'dual_started') { pendingStart = false; capturing = true; foot('Dual: listening'); return; }
      if (msg.status === 'dual_stopped') { capturing = false; return; }
      if (msg.status === 'language_loading') { foot('Loading ' + msg.language + '…'); return; }
      if (msg.status === 'language_set') { return; }
      if (msg.status === 'engine_loading') { foot('Switching engine…'); return; }
      if (msg.status === 'engine_set') {
        if (engineInfo) {
          engineInfo.active_engine = msg.engine;
          engineInfo.engine_models[msg.engine] = msg.model;
          engineInfo.language = msg.language;
        }
        return;
      }

      if (msg.type === 'config') { if (dualMode) return; pendingStart = false; capturing = true; foot('Listening'); return; }

      if (msg.stream === 'win_captions') { handleWinFrame(msg); return; }
      if (msg.type === 'translation') { handleWinTranslation(msg); return; }
      if (dualMode) {
        if (streamSlot && msg.stream === streamSlot) handleServerMessage(msg);
        else handleDualFrame(msg);
        return;
      }
      handleServerMessage(msg);
    });
    ws.addEventListener('close', function () {
      if (userClosing) return;
      var failedStart = false;
      if (pendingStart && ws === sock) { failStart('Lost the connection while starting'); failedStart = true; }
      if (dualMode) {
        dualMode = false; capturing = false; running.you = running.them = false; active = null;
        clearMeters(); refreshStatus(); foot('Dual disconnected'); setIdle(); return;
      }
      if (!failedStart) foot('Reconnecting…');
      setTimeout(function () {
        ws = null; openWs();
        ws.addEventListener('open', function () {
          if (capturing && active) startCaptureOnly(active);
        }, { once: true });
      }, 1500);
    });
  }

  function resetOffsets() {
    shownChars = latestLineLength = lineCount = 0; lastCommittedText = ''; activeText = '';
    engineSignalsFinal = false; activeLineTime = null;
  }

  function clearMeters() {
    $$('.lvl-fill').forEach(function (f) { f.style.width = '0%'; f.classList.remove('gated'); });
  }

  function deviceFor(r) {
    var list = r === 'you' ? allDevices.mic : allDevices.loopback;
    var c = TR[r];
    return list.filter(function (d) { return d.name === c.device; })[0] || list[0] || null;
  }

  var acks = [];

  function sendAwait(frame, okStatuses, ms) {
    return new Promise(function (resolve) {
      var w = { ok: okStatuses };
      var t = setTimeout(function () { settle({ timeout: true }); }, ms || 300000);
      function settle(v) {
        if (w.done) return;
        w.done = true; clearTimeout(t);
        var i = acks.indexOf(w); if (i >= 0) acks.splice(i, 1);
        resolve(v);
      }
      w.settle = settle;
      acks.push(w);
      send(frame);
    });
  }

  function settleAck(msg) {
    if (!acks.length || (!msg.error && !msg.status)) return;
    for (var i = 0; i < acks.length; i++) {
      if (msg.error || acks[i].ok.indexOf(msg.status) >= 0) {
        acks[i].settle(msg.error ? { error: msg.error } : { ok: true });
        return;
      }
    }
  }

  function abandonInFlight() {
    var pending = acks.slice();
    for (var i = 0; i < pending.length; i++) pending[i].settle({ aborted: true });
  }

  function startCaptureOnly(r) {
    var dev = deviceFor(r);
    if (!isProgram(r) && !dev) return;
    pendingStart = true;
    send({ action: 'start_capture',
           device_index: isProgram(r) ? null : dev.index,
           program: isProgram(r) ? TR[r].program : null });
  }

  async function applyBackendConfig(r) {
    var c = TR[r], dev = deviceFor(r);
    var body = { source_mode: c.source, target_language: c.tgt };
    if (c.source !== 'program') body[c.source === 'mic' ? 'mic_device_name' : 'loopback_device_name'] = c.device;
    try {
      await fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {}
    return dev;
  }

  async function ensureEngineModel(c) {
    var eng = c.engine, need;
    if (eng === 'parakeet') need = c.src === 'ja' ? 'parakeet-ja' : 'parakeet-tdt-0.6b-v3-int8';
    else if (eng === 'whisper' || eng === 'whisper-batch') need = c.model || 'large-v3-turbo';
    else return true;
    var md;
    try {
      var info = await (await fetch('/models?engine=' + encodeURIComponent(eng))).json();
      md = (info.models || []).filter(function (m) { return m.id === need; })[0];
    } catch (e) { return true; }
    if (!md || md.installed) return true;
    var label = md.label || need, size = md.est_download || 'a download';
    var go = await dialog({
      k: 'Model needed', h: 'Download the ' + (engName(eng) || 'engine') + ' model?',
      p: engName(eng) + ' needs the <b>' + escHtml(label) + '</b> model (<b>' + escHtml(size) + '</b>) before it can start.',
      ok: 'Download', cancel: 'Not now'
    });
    if (!go) {
      toast('info', '', 'Model not downloaded. Pick another engine, or download it in Settings > Engines.');
      return false;
    }
    return await runModelDownload(eng, md);
  }

  var activating = null;

  function activate(gen, body) {
    var prev = activating;
    var release;
    var mine = new Promise(function (res) { release = res; });
    activating = mine;
    var run = (async function () {
      if (prev) { abandonInFlight(); try { await prev; } catch (e) {} }
      if (gen !== startGen) return;
      return await body();
    })();
    run.then(function () {}, function () {}).then(function () {
      release();
      if (activating === mine) activating = null;
    });
    return run;
  }

  function startTransport(r) {
    var dev = deviceFor(r);
    if (!isProgram(r) && !dev) { foot('No ' + (r === 'you' ? 'microphone' : 'desktop') + ' device'); return; }
    var gen = ++startGen;
    return activate(gen, async function () {
      if (!(await ensureEngineModel(TR[r]))) { setIdle(); return; }
      if (gen !== startGen) return;
      userClosing = false;
      running.you = running.them = false; running[r] = true; active = r;
      resetOffsets(); clearMeters(); refreshStatus(); foot('Connecting…');
      setPreparing('Starting engine…'); startStartupPoll();
      pendingStart = true;
      openWs();
      await applyBackendConfig(r);
      if (gen !== startGen) return;
      var c = TR[r];

      var step;
      if (c.engine) {
        step = await sendAwait({ action: 'set_engine', engine: c.engine, model: c.model }, ['engine_set']);
        if (step.error || gen !== startGen) return;
        if (step.timeout) { failStart('The engine did not respond'); return; }
      }
      if (c.src) {
        step = await sendAwait({ action: 'set_language', language: c.src }, ['language_set']);
        if (step.error || gen !== startGen) return;
        if (step.timeout) { failStart('The engine did not respond'); return; }
      }
      step = await sendAwait({ action: 'start_capture',
                               device_index: isProgram(r) ? null : dev.index,
                               program: isProgram(r) ? c.program : null }, ['capture_started']);
      if (step.error || gen !== startGen) return;
      if (step.timeout) { failStart('Capture did not start'); return; }
      setListening(r);
      if (overlaySource === r) setOverlaySource(r);
    });
  }

  async function stopTransport() {
    userClosing = true;
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    commitActiveLine();
    if (ws && ws.readyState === WebSocket.OPEN) { try { await send({ action: 'stop_capture' }); } catch (e) {} }
    pendingStart = false; startGen++; capturing = false; running.you = running.them = false; active = null;
    resetOffsets(); clearMeters(); refreshStatus(); foot('Stopped'); setIdle();
  }

  async function relaunchIfLive(r) {
    if (!running[r]) return;
    if (dualMode) { await reconfigureDualSlot(r); return; }
    await stopTransport();
    await startTransport(r);
  }

  async function reconfigureDualSlot(r) {
    var c = TR[r], dev = deviceFor(r);
    if (!isProgram(r) && !dev) return;
    if (!(await ensureEngineModel(c))) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { send({ action: 'reconfigure_dual_slot', slot: r,
                   device: isProgram(r) ? null : dev.index, program: isProgram(r) ? c.program : null,
                   engine: c.engine, language: c.src, model: c.model }); } catch (e) {}
    }

    var prev = streamSlot;
    streamSlot = STREAM_ENGINES[TR.you.engine] && running.you ? 'you'
               : (STREAM_ENGINES[TR.them.engine] && running.them ? 'them' : null);
    if (streamSlot !== prev) { active = streamSlot; if (streamSlot) setListening(streamSlot); else setDualListening(); }
    syncOverlayToSource();
  }

  function reconnectCapture() {
    if (!active) return;
    var r = active;
    send({ action: 'stop_capture' }).then(function () { startCaptureOnly(r); });
  }

  var lastDualRestart = 0;

  function restartDualSlot(r) {
    if (!r) return;
    var now = Date.now();
    if (now - lastDualRestart < 2500) return;
    lastDualRestart = now;
    resetOffsets();
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { send({ action: 'restart_dual_slot', slot: r }); } catch (e) {}
    }
  }

  var DUAL_ENGINES = { nano: true, qwen3: true, parakeet: true, 'whisper-batch': true };
  var STREAM_ENGINES = { whisper: true, 'parakeet-stream': true };
  var streamSlot = null;

  function dualSlotOk(e) { return !!(DUAL_ENGINES[e] || STREAM_ENGINES[e]); }

  var DUAL_SHARED_ENGINES = { 'whisper-batch': true };

  function sharedModelDual() {
    return dualMode && !!TR.you.engine && TR.you.engine === TR.them.engine && !!DUAL_SHARED_ENGINES[TR.you.engine];
  }

  function applyEdit(r) {
    if (dualMode && sharedModelDual()) startDual();
    else relaunchIfLive(r);
  }

  function isWhisper(e) { return e === 'whisper' || e === 'whisper-batch'; }

  function canDual() {
    var eu = TR.you.engine, et = TR.them.engine;
    var nStream = (STREAM_ENGINES[eu] ? 1 : 0) + (STREAM_ENGINES[et] ? 1 : 0);

    if (isWhisper(eu) && isWhisper(et) && eu !== et) return false;
    return dualSlotOk(eu) && dualSlotOk(et) && nStream <= 1;
  }

  function setDualListening() {
    liveKind = null; live.className = 'current'; liveWho.textContent = 'Dual';
    liveO.textContent = 'Listening'; liveO.classList.remove('capcursor');
    showLiveLine(false);
  }

  function startDual() {
    var youDev = deviceFor('you'), themDev = deviceFor('them');
    if (!youDev || (!themDev && !isProgram('them'))) { foot('Dual needs a microphone and a desktop device'); return; }
    var gen = ++startGen;
    return activate(gen, async function () {
    if (!(await ensureEngineModel(TR.you)) || !(await ensureEngineModel(TR.them))) { setIdle(); return; }
    if (gen !== startGen) return;
    userClosing = false;

    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }

    try { send({ action: 'stop_capture' }); } catch (e) {}
    resetOffsets();
    dualMode = true; capturing = false;
    running.you = running.them = true;

    streamSlot = STREAM_ENGINES[TR.you.engine] ? 'you'
               : (STREAM_ENGINES[TR.them.engine] ? 'them' : null);
    active = streamSlot;

    var heavy = ['whisper', 'whisper-batch', 'qwen3'];
    var slow = heavy.indexOf(TR.you.engine) >= 0 || heavy.indexOf(TR.them.engine) >= 0;
    clearMeters(); refreshStatus();
    foot(slow ? 'Dual: loading model, this can take up to a minute…' : 'Dual: starting…');
    pendingStart = true;
    openWs();
    send({ action: 'start_dual',
           you_device: youDev.index, you_engine: TR.you.engine, you_lang: TR.you.src, you_model: TR.you.model,
           you_program: isProgram('you') ? TR.you.program : null,
           them_device: isProgram('them') ? null : themDev.index,
           them_engine: TR.them.engine, them_lang: TR.them.src, them_model: TR.them.model,
           them_program: isProgram('them') ? TR.them.program : null });
    syncOverlayToSource();
    if (streamSlot) setListening(streamSlot); else setDualListening();
    });
  }

  function failStart(reason) {
    pendingStart = false;
    startGen++;

    if (ws && ws.readyState === WebSocket.OPEN) { try { send({ action: 'stop_capture' }); } catch (e) {} }
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    dualMode = false; capturing = false; streamSlot = null;
    running.you = running.them = false; active = null;
    resetOffsets(); clearMeters(); refreshStatus(); setIdle();
    foot(reason || 'Could not start');
    toast('warn', '', reason || 'Could not start.');
  }

  function stopDual() {
    dualMode = false; userClosing = true; pendingStart = false; startGen++; capturing = false;
    if (ws && ws.readyState === WebSocket.OPEN) { try { send({ action: 'stop_dual' }); } catch (e) {} }
    running.you = running.them = false; active = null; streamSlot = null;
    syncOverlayToSource();
    clearMeters(); refreshStatus(); foot('Stopped'); setIdle();
  }

  function stopDualSlot(r) {
    var other = r === 'you' ? 'them' : 'you';
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { send({ action: 'stop_dual_slot', slot: r }); } catch (e) {}
    }
    running[r] = false;
    var f = $('#tr-' + r + ' .lvl-fill');
    if (f) { f.style.width = '0%'; f.classList.remove('gated'); }
    if (r === streamSlot) {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      commitActiveLine();
      resetOffsets(); streamSlot = null; active = null;
    }
    if (running[other]) {
      if (r === overlaySource) syncOverlayToSource();
      if (!streamSlot) setDualListening();
      refreshStatus(); foot((r === 'you' ? 'You' : 'Them') + ' stopped');
    } else {
      stopDual();
    }
  }

  var dualLastCommitted = { you: '', them: '' };

  function handleDualFrame(data) {
    var r = data.stream;
    if (r !== 'you' && r !== 'them') return;
    var lines = Array.isArray(data.lines) ? data.lines : [];
    var visible = lines.filter(function (l) { return l.speaker !== -2 && (l.text || '').trim(); });
    var latest = visible[visible.length - 1];
    if (!latest) return;
    var full = latest.text.trim();
    if (!full || /^[。．？！?!.,\s]+$/.test(full)) return;
    if (typeof data.decode_ms === 'number') { latency.stt = data.decode_ms; renderLatency(); }

    if (hasRepetition(full)) { dualLastCommitted[r] = ''; return; }

    var deduped = stripCommittedOverlap(full, dualLastCommitted[r]);
    dualLastCommitted[r] = full;
    if (!deduped) return;
    var res = cleanCommitText(deduped, !!(TR[r] && TR[r].src === 'en'));
    if (!res.text || /^[。．？！?!.,\s]+$/.test(res.text)) return;
    emitLine(r, res.text);
  }

  var winRowByIdx = {}, winTr = {}, winCur = null, winMaxIdx = -1, winSeen = [];

  var WIN_SEEN_MAX = 60, WIN_SIM = 0.8;

  function winNorm(t) { return (t || '').replace(/\s+/g, ''); }

  function winLev(a, b) {
    var la = a.length, lb = b.length;
    if (!la) return lb; if (!lb) return la;
    if (la > lb) { var s = a; a = b; b = s; var n = la; la = lb; lb = n; }
    var prev = [], cur = [], i, j;
    for (i = 0; i <= la; i++) prev[i] = i;
    for (j = 1; j <= lb; j++) {
      cur[0] = j;
      for (i = 1; i <= la; i++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[i] = Math.min(cur[i - 1] + 1, prev[i] + 1, prev[i - 1] + cost);
      }
      var t = prev; prev = cur; cur = t;
    }
    return prev[la];
  }

  function winSim(a, b) {
    if (a === b) return 1;
    var m = Math.min(a.length, b.length), M = Math.max(a.length, b.length);
    if (!M) return 0;

    if ((a.indexOf(b) === 0 || b.indexOf(a) === 0) && m >= M * 0.6) return 1;
    return 1 - winLev(a, b) / M;
  }

  function winIsDup(t) {
    var tn = winNorm(t);
    for (var i = winSeen.length - 1; i >= 0; i--) if (winSim(tn, winSeen[i]) >= WIN_SIM) return true;
    return false;
  }

  function winRemember(t) { winSeen.push(winNorm(t)); if (winSeen.length > WIN_SEEN_MAX) winSeen.shift(); }

  function winRenderRow(row) { row.el.dataset.oRaw = row.text; renderOriginal(row.el); }

  function winApplyTr(row) {
    var parts = row.idxs.map(function (i) { return winTr[i]; }).filter(Boolean);
    if (parts.length) setTranslation(row.el, parts.join(' '));
  }

  function winPrune() {
    var idxs = Object.keys(winRowByIdx).map(Number).sort(function (a, b) { return a - b; });
    while (idxs.length > 80) { var o = idxs.shift(); delete winRowByIdx[o]; delete winTr[o]; }
  }

  function handleWinFrame(data) {
    if (!Array.isArray(data.lines)) return;
    var vis = data.lines.filter(function (l) { return (l.text || '').trim(); });
    var latest = vis[vis.length - 1]; if (!latest) return;
    var idx = (data.line_count !== undefined) ? data.line_count : 0;
    if (idx < winMaxIdx) { winRowByIdx = {}; winTr = {}; winCur = null; winSeen = []; }
    winMaxIdx = Math.max(winMaxIdx, idx);
    if (!data.final) return;
    var text = latest.text.trim();
    if (!text || winRowByIdx[idx]) return;
    if (winIsDup(text)) return;
    if (winCur && winNorm(winCur.text).indexOf(winNorm(text)) >= 0) return;
    if (winCur) {
      var glue = (/[぀-ヿ㐀-鿿ｦ-ﾟ]$/.test(winCur.text) && /^[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(text)) ? '' : ' ';
      winCur.text = (winCur.text + glue + text).trim();
      winCur.idxs.push(idx);
    } else {
      winCur = { el: addFeedLine('win', text, new Date()), idxs: [idx], text: text };
    }
    winRowByIdx[idx] = winCur;
    winRenderRow(winCur);
    winApplyTr(winCur);

    if (data.hard || winNorm(winCur.text).length > 200) { winRemember(winCur.text); winCur = null; }
    winPrune();
  }

  function handleWinTranslation(data) {
    var tr = (data.text || '').trim(); if (!tr || typeof data.line !== 'number') return;
    winTr[data.line] = tr;
    var row = winRowByIdx[data.line];
    if (row) winApplyTr(row);
  }

  $$('[data-run]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var r = b.dataset.run;
      if (dualMode) {
        if (running[r]) stopDualSlot(r); else startDual();
        return;
      }
      var other = r === 'you' ? 'them' : 'you';
      if (running[r]) { stopTransport(); return; }

      if (running[other]) {
        if (canDual()) { startDual(); return; }

        var twoWhisper = isWhisper(TR.you.engine) && isWhisper(TR.them.engine) && TR.you.engine !== TR.them.engine;
        var twoStream = STREAM_ENGINES[TR.you.engine] && STREAM_ENGINES[TR.them.engine];
        foot((twoWhisper
                ? 'Running both Whisper engines at once loads the model twice. Use two Whisper (accurate), or pair one with Parakeet, Fun-ASR, or Qwen3. '
                : twoStream
                ? 'Only one streaming engine (Whisper or Parakeet Streaming) can run in dual; pair it with Parakeet, Fun-ASR, or Qwen3. '
                : 'To run both at once, use dual-capable engines (Parakeet, Fun-ASR, Qwen3, or one Whisper slot). ')
             + 'Now: ' + engName(TR.you.engine) + ' + ' + engName(TR.them.engine)
             + '. Stop ' + (other === 'you' ? 'You' : 'Them') + ' first to switch instead.');
        return;
      }

      startTransport(r);
    });
  });

  function closePop() { pop.style.display = 'none'; }

  function positionDrawer() { drawer.style.top = (strip.offsetTop + strip.offsetHeight) + 'px'; }

  function toggleCell(r) {
    closePop(); positionDrawer();
    var cell = $('#dc-' + r), tr = $('#tr-' + r);
    var open = cell.classList.toggle('open');
    tr.classList.toggle('open', open); tr.setAttribute('aria-expanded', open);
  }

  function closeDrawer() {
    $$('.dcell.open').forEach(function (c) { c.classList.remove('open'); });
    $$('.tr.open').forEach(function (t) { t.classList.remove('open'); t.setAttribute('aria-expanded', 'false'); });
  }
  $$('.tr').forEach(function (tr) {
    var r = tr.id.replace('tr-', '');
    tr.addEventListener('click', function (e) { e.stopPropagation(); toggleCell(r); });
    tr.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCell(r); }
    });
  });
  $$('.drawer,.pop').forEach(function (c) { c.addEventListener('click', function (e) { e.stopPropagation(); }); });
  document.addEventListener('click', closePop);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closePop(); closeDrawer(); closeMenus(); closeSettings(); } });

  ['you', 'them'].forEach(function (r) {
    var dc = $('#dc-' + r), c = TR[r];
    var engSel = $('[data-cfg="engine"]', dc), mdlSel = $('[data-cfg="model"]', dc),
        srcSel = $('[data-cfg="src"]', dc), tgtSel = $('[data-cfg="tgt"]', dc),
        devSel = $('[data-cfg="device"]', dc),
        xt = $('[data-cfg="translate"]', dc), sw = $('.swap', dc);

    engSel.addEventListener('change', function () {
      c.engine = engSel.value;
      var e = engById(c.engine);
      if (e) {
        c.model = (engineInfo.engine_models && engineInfo.engine_models[e.id]) || e.default_model || e.models[0] || '';
        if (e.languages.indexOf(c.src) < 0) c.src = e.languages[0] || 'auto';
      }

      if (sharedModelDual()) TR.them.model = TR.you.model;
      renderDrawer('you'); renderDrawer('them'); renderStrip(r); save(); applyEdit(r);
    });
    mdlSel.addEventListener('change', function () {
      c.model = mdlSel.value;

      if (sharedModelDual()) { TR.them.model = c.model; renderDrawer('them'); renderStrip('them'); }
      renderStrip(r); save(); applyEdit(r);
    });
    srcSel.addEventListener('change', function () { c.src = srcSel.value; renderStrip(r); save(); relaunchIfLive(r); });
    tgtSel.addEventListener('change', function () {
      c.tgt = tgtSel.value; renderStrip(r); save();

      if (!dualMode && running[r]) applyBackendConfig(r);
    });
    devSel.addEventListener('change', function () {
      var val = devSel.value || '';
      if (val.indexOf('prog:') === 0) {
        c.source = 'program'; c.program = val.slice(5); c.device = '';
      } else {
        c.source = r === 'you' ? 'mic' : 'loopback';
        c.program = '';
        c.device = devSel.selectedOptions[0] ? devSel.selectedOptions[0].text : '';
      }
      renderStrip(r); save(); relaunchIfLive(r);
    });
    if (r === 'them') {
      devSel.addEventListener('mousedown', function () { loadPrograms(); });
    }
    xt.addEventListener('click', function (e) {
      e.stopPropagation();
      c.translate = xt.getAttribute('aria-pressed') !== 'true';
      xt.setAttribute('aria-pressed', c.translate); xt.textContent = c.translate ? 'On' : 'Off';
      $('.xlate', dc).classList.toggle('off', !c.translate);
      renderStrip(r); save();
    });

    sw.addEventListener('click', function (e) {
      e.stopPropagation();
      var newTgt = TRANS_SRC[c.src] || '';
      var newSrc = (c.tgt || '').split('-')[0];
      var e2 = engById(c.engine);
      var srcOk = e2 && e2.languages.indexOf(newSrc) >= 0;
      var tgtOk = targetLangOpts().some(function (t) { return t.v === newTgt; });
      if (!srcOk || !tgtOk) return;
      c.src = newSrc; c.tgt = newTgt;
      renderDrawer(r); renderStrip(r); save(); relaunchIfLive(r);
    });
  });

  $$('.dst[data-d]').forEach(function (c) {
    c.addEventListener('click', function (e) {
      e.stopPropagation();
      var d = c.dataset.d, r = c.closest('.dcell').id === 'dc-you' ? 'you' : 'them';
      if (d === 'osc') {
        oscOwner = (oscOwner === r) ? null : r;
        $$('.dst[data-d="osc"]').forEach(function (o) {
          var or = o.closest('.dcell').id === 'dc-you' ? 'you' : 'them';
          o.setAttribute('aria-pressed', oscOwner === or);
        });
        save(); return;
      }
      var on = c.getAttribute('aria-pressed') !== 'true';
      c.setAttribute('aria-pressed', on);
      TR[r].dest[d] = on; save();
      if (d === 'tts') ttsSyncLight();
    });
  });

  function applyFilter(el) { el.style.display = (filter === 'all' || filter === el.dataset.kind) ? '' : 'none'; }
  $$('[data-f]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      filter = b.dataset.f;
      $$('[data-f]').forEach(function (x) { x.setAttribute('aria-pressed', x.dataset.f === filter); });
      $$('.ln', feed).forEach(applyFilter);
    });
  });

  $$('[data-v]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var v = b.dataset.v;
      $$('[data-v]').forEach(function (x) { x.setAttribute('aria-pressed', x.dataset.v === v); });
      feed.classList.toggle('talk', v === 'talk');
    });
  });

  function setReading(mode) {
    if (window.jadict && window.jadict.setReadingMode) window.jadict.setReadingMode(mode);
    var m = (window.jadict && window.jadict.readingMode) || 'off';
    $$('[data-r]').forEach(function (x) { x.setAttribute('aria-pressed', x.dataset.r === m); });
    feed.classList.toggle('furi', m === 'furigana');
    feed.classList.toggle('kana', m === 'hiragana');
    feed.classList.toggle('roma', m === 'romaji');
    try { localStorage.setItem('v2Reading', m); } catch (e) {}
    refreshReading();
  }
  $$('[data-r]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.stopPropagation(); setReading(b.dataset.r); });
  });

  $('#btn-clear').addEventListener('click', function (e) { e.stopPropagation(); feed.innerHTML = EMPTY; });
  $('#btn-copyall').addEventListener('click', function (e) {
    e.stopPropagation();
    var text = $$('.ln .o', feed).map(function (o) { return o.textContent; }).join('\n');
    var btn = this, t = btn.textContent;
    if (text && navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
    btn.textContent = 'Copied';
    setTimeout(function () { btn.textContent = t; }, 1100);
  });

  var menuBackdrop = $('#menu-backdrop');

  function closeMenus() {
    $$('.menu').forEach(function (m) {
      m.removeAttribute('data-open');
      var t = $('.tool[data-tool="' + m.id.replace('-menu', '') + '"]');
      if (t) t.setAttribute('aria-pressed', 'false');
    });
    if (menuBackdrop) menuBackdrop.removeAttribute('data-open');
  }

  function openMenu(menu, btn) {
    var wasOpen = menu.hasAttribute('data-open');
    closePop(); closeMenus();
    if (wasOpen) return;
    menu.setAttribute('data-open', '');
    btn.setAttribute('aria-pressed', 'true');
    if (menuBackdrop) menuBackdrop.setAttribute('data-open', '');
  }
  $$('.menu').forEach(function (m) { m.addEventListener('click', function (e) { e.stopPropagation(); }); });
  $$('.menu [data-close]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); closeMenus(); }); });
  if (menuBackdrop) menuBackdrop.addEventListener('click', closeMenus);
  document.addEventListener('click', closeMenus);

  var ccMenu = $('#cc-menu'), ccTool = $('.tool[data-tool="cc"]');

  function setTog(btn, on) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); btn.textContent = on ? 'On' : 'Off'; }

  function togState(btn) { return btn.getAttribute('aria-pressed') === 'true'; }

  async function ccOverlayPref(kind, on) {
    try { await fetch('/captions/overlay/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: on }) }); } catch (e) {}
  }
  if (ccTool) ccTool.addEventListener('click', function (e) {
    e.stopPropagation();
    openMenu(ccMenu, ccTool);
    if (!ccMenu.hasAttribute('data-open')) return;
    fetch('/captions/overlay/state').then(function (r) { return r.json(); }).then(function (s) {
      setTog($('#cc-blur'), !!s.blur); setTog($('#cc-pos'), !!s.pos_color);
      var rd = $('#cc-reading'); if (rd) rd.value = s.reading || 'off';
    }).catch(function () {});
    ccLoadSource();
  });

  var WIN_BACKENDS = [
    { v: '', n: '(use app translator)' }, { v: 'google', n: 'Google' }, { v: 'deepl', n: 'DeepL' },
    { v: 'lmstudio', n: 'LM Studio' }, { v: 'ollama', n: 'Ollama' }, { v: 'openai', n: 'OpenAI-compatible' },
    { v: 'openrouter', n: 'OpenRouter' }, { v: 'libretranslate', n: 'LibreTranslate' }
  ];

  function ccFillWinTgt(backend, current) {
    var t = $('#cc-win-tgt'); if (!t) return;
    var opts = targetLangOpts(backend || translateBackend);
    if (current && !opts.some(function (o) { return o.v === current; })) {
      opts = [{ v: current, n: tgtName(current) + ' (not supported)' }].concat(opts);
    }

    t.innerHTML = opts.map(function (l) { return '<option value="' + escHtml(l.v) + '"' + (l.disabled ? ' disabled' : '') + '>' + escHtml(l.n) + '</option>'; }).join('');
    if (current) t.value = current;
  }

  function ccPopulateWinPickers() {
    ccFillWinTgt('', '');
    var b = $('#cc-win-backend'); if (b) { b.innerHTML = WIN_BACKENDS.map(function (l) { return '<option value="' + l.v + '">' + l.n + '</option>'; }).join(''); }
  }

  function ccShowWinOpts(show) { var o = $('#cc-win-opts'); if (o) o.hidden = !show; }
  var ccWinStatus = {};

  function ccApplyWin() {
    var sel = $('#cc-src'), isWin = sel && sel.value === 'win_captions';
    var sec = $('#cc-win-sec'), note = $('#cc-src-note'), manage = $('#cc-win-manage'), mbtn = $('#cc-win-btn');
    if (!isWin) { if (sec) sec.hidden = true; ccShowWinOpts(false); if (note) note.hidden = true; if (manage) manage.hidden = true; return; }
    if (sec) sec.hidden = false;
    if (!ccWinStatus.win_captions_supported) {
      ccShowWinOpts(false); manage.hidden = true;
      note.hidden = false; note.innerHTML = 'Windows Live Captions needs <b>Windows 11 22H2+</b>.';
      return;
    }
    manage.hidden = false; mbtn.disabled = false;
    if (!ccWinStatus.win_captions_installed) {
      note.hidden = false; note.innerHTML = 'Windows captions need the <b>Live Captions pack</b> installed. Install it below, then this source turns on.';
      ccShowWinOpts(false);
      mbtn.textContent = 'Install'; mbtn.classList.remove('warn'); mbtn.onclick = ccWinInstall;
    } else {
      note.hidden = true; ccShowWinOpts(true);
      mbtn.textContent = 'Uninstall'; mbtn.classList.add('warn'); mbtn.onclick = ccWinUninstall;
    }
  }

  async function ccLoadSource() {
    var sel = $('#cc-src'), winOpt = sel && sel.querySelector('option[value="win_captions"]');
    try {
      var s = await (await fetch('/captions/source/status')).json();
      if (!s.win_captions_present) { ccWinStatus = {}; if (winOpt) winOpt.hidden = true; }
      else { ccWinStatus = s; if (winOpt) { winOpt.hidden = false; winOpt.disabled = false; } }
    } catch (e) { ccWinStatus = {}; if (winOpt) winOpt.hidden = true; }
    if (sel) sel.value = overlaySource;
    ccApplyWin();
    fetch('/config').then(function (r) { return r.json(); }).then(function (c) {
      var t = $('#cc-win-tgt'), b = $('#cc-win-backend');

      if (b) b.value = c.win_captions_backend || '';
      if (t) {
        if (!c.win_captions_target) ccSaveWin({ win_captions_target: 'en-US' });
        ccFillWinTgt(c.win_captions_backend, c.win_captions_target || 'en-US');
      }
      setTog($('#cc-win-transcript'), !!c.win_captions_to_transcript);
    }).catch(function () {});
  }
  var ccSrc = $('#cc-src');
  if (ccSrc) ccSrc.addEventListener('change', function (e) { e.stopPropagation(); setOverlaySource(this.value); });

  function ccSaveWin(patch) {
    fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(function () {});
  }
  if ($('#cc-win-tgt')) $('#cc-win-tgt').addEventListener('change', function (e) { e.stopPropagation(); ccSaveWin({ win_captions_target: this.value }); });
  if ($('#cc-win-backend')) $('#cc-win-backend').addEventListener('change', function (e) {
    e.stopPropagation(); ccSaveWin({ win_captions_backend: this.value });
    ccFillWinTgt(this.value, $('#cc-win-tgt') ? $('#cc-win-tgt').value : '');
  });
  if ($('#cc-win-transcript')) $('#cc-win-transcript').addEventListener('click', function (e) { e.stopPropagation(); var on = !togState(this); setTog(this, on); ccSaveWin({ win_captions_to_transcript: on }); });

  async function ccWinInstall() {
    if (engBusy) return; engBusy = true; var b = $('#cc-win-btn'); b.disabled = true; var p = $('#cc-win-prog'); p.hidden = false; p.textContent = 'Installing…';
    try { await fetch('/engines/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'win_captions' }) }); }
    catch (e) { p.textContent = 'Failed to start.'; engBusy = false; b.disabled = false; return; }
    var s = await pollInstall(function (st) { p.textContent = (st.detail || st.phase || 'Installing') + '…'; });
    engBusy = false; p.hidden = true;
    if (s.error) { p.hidden = false; p.textContent = 'Failed: ' + s.error; ccLoadSource(); return; }
    await ccLoadSource();
    var sel = $('#cc-src'); sel.value = 'win_captions'; sel.dispatchEvent(new Event('change'));
  }

  async function ccWinUninstall() {
    if (!(await dialog({ k: 'Uninstall', h: 'Uninstall the Windows Live Captions pack?', p: 'The overlay falls back to the app engine.', ok: 'Uninstall', cancel: 'Cancel', danger: true }))) return;
    engBusy = true; var b = $('#cc-win-btn'); b.disabled = true;
    try { await fetch('/captions/overlay/source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'current' }) }); } catch (e) {}
    overlaySource = 'off';
    try { await fetch('/captions/overlay/hide', { method: 'POST' }); } catch (e) {}
    try { await fetch('/engines/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'win_captions' }) }); } catch (e) {}
    engBusy = false; ccSyncGlow(); save(); ccLoadSource();
  }
  $('#cc-blur').addEventListener('click', function (e) {
    e.stopPropagation(); var on = !togState(this); setTog(this, on); ccOverlayPref('blur', on);
  });
  $('#cc-pos').addEventListener('click', function (e) {
    e.stopPropagation(); var on = !togState(this); setTog(this, on); ccOverlayPref('poscolor', on);
  });
  $('#cc-reading').addEventListener('change', function (e) {
    e.stopPropagation();
    fetch('/captions/overlay/reading', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: this.value }) }).catch(function () {});
  });

  var ttsMenu = $('#tts-menu'), ttsTool = $('.tool[data-tool="tts"]');
  var ttsByKey = {};
  var ttsIdToKey = {};

  function escHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function ttsShow(which) {
    $('#tts-off').hidden = which !== 'install';
    $('#tts-starting').hidden = which !== 'starting';
    $('#tts-body').hidden = which !== 'form';
  }

  function ttsBuildVoices(packs) {
    ttsByKey = {}; ttsIdToKey = {};
    var byEngine = {}, packName = {};
    packs.forEach(function (p) { packName[p.id] = p.name; });
    packs.filter(function (p) { return p.installed; }).forEach(function (p) {
      var list = byEngine[p.id] || (byEngine[p.id] = []);
      if (p.id === 'voicevox') {
        var groups = {};
        (p.voices || []).forEach(function (v) {
          var g = groups[v.speaker] || (groups[v.speaker] = {
            key: 'vv:' + v.speaker, engine: p.id, credit: v.credit || '', terms_url: v.terms_url || '',
            styles: [], label: v.speaker + (v.en ? ' (' + v.en + ')' : '')
          });
          g.styles.push({ id: String(v.id), name: v.style || v.label, en: v.style_en || '' });
        });
        Object.keys(groups).forEach(function (k) { list.push(groups[k]); });
      } else {
        (p.voices || []).forEach(function (v) {
          list.push({ key: p.id + ':' + v.id, engine: p.id, label: v.label,
            credit: v.credit || '', terms_url: v.terms_url || '', voiceId: String(v.id) });
        });
      }
    });
    Object.keys(byEngine).forEach(function (eng) {
      byEngine[eng].forEach(function (c) {
        ttsByKey[c.key] = c;
        if (c.styles) c.styles.forEach(function (s) { ttsIdToKey[s.id] = c.key; });
        else ttsIdToKey[c.voiceId] = c.key;
      });
    });
    return Object.keys(byEngine).map(function (eng) {
      return '<optgroup label="' + escHtml(packName[eng] || eng) + '">' +
        byEngine[eng].map(function (c) { return '<option value="' + escHtml(c.key) + '">' + escHtml(c.label) + '</option>'; }).join('') +
        '</optgroup>';
    }).join('');
  }

  function ttsPopulateStyles(charKey) {
    var c = ttsByKey[charKey], wrap = $('#tts-style-wrap');
    if (c && c.styles) {
      $('#tts-style').innerHTML = c.styles.map(function (s) {
        return '<option value="' + escHtml(s.id) + '">' + escHtml(s.name) + (s.en ? ' (' + escHtml(s.en) + ')' : '') + '</option>';
      }).join('');
      wrap.style.display = '';
    } else { $('#tts-style').innerHTML = ''; wrap.style.display = 'none'; }
  }

  function ttsCurrentVoiceId() {
    var c = ttsByKey[$('#tts-voice').value];
    if (!c) return '';
    return c.styles ? $('#tts-style').value : c.voiceId;
  }

  function ttsUpdateCredit() {
    var c = ttsByKey[$('#tts-voice').value], has = !!(c && c.credit), el = $('#tts-credit');
    el.hidden = !has;
    if (has) {
      $('#tts-credit-text').textContent = c.credit;
      var a = $('#tts-credit-link');
      if (c.terms_url) { a.href = c.terms_url; a.style.display = ''; } else { a.style.display = 'none'; }
    }
  }

  async function ttsLoadDevices() {
    var d;
    try { d = await fetch('/tts/devices').then(function (r) { return r.json(); }); } catch (e) { return; }
    var sel = $('#tts-device');
    sel.innerHTML = '<option value="">System default</option>' + (d.devices || []).map(function (x) {
      return '<option value="' + escHtml(x.name) + '">' + escHtml(x.name) + (x.cable ? '  ← VB-Cable' : '') + '</option>';
    }).join('');
    var cable = (d.devices || []).filter(function (x) { return x.cable; })[0];
    var saved = (d.devices || []).filter(function (x) { return x.name === d.selected; })[0];
    sel.value = saved ? saved.name : (cable ? cable.name : '');
    ttsDevice = sel.value;

    if (!saved && cable) ttsSelect({ device: cable.name });
    var mon = $('#tts-monitor');
    mon.innerHTML = '<option value="">Off</option>' + (d.devices || []).map(function (x) {
      return '<option value="' + escHtml(x.name) + '">' + escHtml(x.name) + '</option>';
    }).join('');
    mon.value = (d.devices || []).some(function (x) { return x.name === d.monitor; }) ? d.monitor : '';
    setTog($('#tts-passthru'), !!d.passthru);
  }

  async function ttsRefresh() {
    var s;
    try { s = await fetch('/tts/status').then(function (r) { return r.json(); }); }
    catch (e) { $('#tts-starting').textContent = 'Error contacting the app.'; ttsShow('starting'); return; }
    if (!s.installed) { ttsShow('install'); return; }
    $('#tts-voice').innerHTML = ttsBuildVoices(s.packs || []);
    var sv = String(s.selected_voice || '');
    var key = ttsIdToKey[sv] || ($('#tts-voice').options[0] || {}).value || '';
    if (key) $('#tts-voice').value = key;
    ttsPopulateStyles($('#tts-voice').value);
    var c = ttsByKey[$('#tts-voice').value];
    if (c && c.styles && c.styles.some(function (st) { return st.id === sv; })) $('#tts-style').value = sv;
    ttsVoice = ttsCurrentVoiceId();
    ttsUpdateCredit();
    await ttsLoadDevices();
    $('#tts-reads').value = ttsReads;
    ttsShow('form');
  }

  function ttsSelect(patch) {
    fetch('/tts/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(function () {});
  }
  if (ttsTool) ttsTool.addEventListener('click', function (e) {
    e.stopPropagation();
    openMenu(ttsMenu, ttsTool);
    if (ttsMenu.hasAttribute('data-open')) ttsRefresh();
  });
  $('#tts-voice').addEventListener('change', function () {
    ttsPopulateStyles(this.value); ttsUpdateCredit();
    ttsVoice = ttsCurrentVoiceId(); ttsSelect({ voice: ttsVoice });
  });
  $('#tts-style').addEventListener('change', function () {
    ttsUpdateCredit(); ttsVoice = ttsCurrentVoiceId(); ttsSelect({ voice: ttsVoice });
  });
  $('#tts-device').addEventListener('change', function () { ttsDevice = this.value; ttsSelect({ device: this.value }); });
  $('#tts-monitor').addEventListener('change', function () { ttsSelect({ monitor: this.value }); });
  $('#tts-passthru').addEventListener('click', function (e) {
    e.stopPropagation();
    var on = !togState(this); setTog(this, on);
    var self = this;
    fetch('/tts/passthru', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (on && d && d.active === false) { setTog(self, false); $('#tts-status').textContent = 'Could not start mic passthru (check the mic/cable device).'; }
      }).catch(function () { setTog(self, !on); });
  });
  $('#tts-reads').addEventListener('change', function () { ttsReads = this.value; });
  $('#tts-credit-copy').addEventListener('click', function (e) {
    e.stopPropagation();
    if (navigator.clipboard) navigator.clipboard.writeText($('#tts-credit-text').textContent || '').catch(function () {});
  });
  $('#tts-speed').addEventListener('input', function () { $('#tts-speed-val').textContent = (+this.value).toFixed(2) + '×'; });

  async function ttsPlay() {
    var text = $('#tts-input').value.trim();
    if (!text) { $('#tts-status').textContent = 'Enter some text first.'; return; }
    var btn = $('#tts-say'); btn.disabled = true; $('#tts-status').textContent = 'Working…';
    try {
      var res = await fetch('/tts/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, voice: ttsCurrentVoiceId(), speed: parseFloat($('#tts-speed').value),
          device: $('#tts-device').value, monitor: $('#tts-monitor').value }) });
      var data = await res.json().catch(function () { return {}; });
      $('#tts-status').textContent = res.ok ? ('Played ' + (data.duration || 0).toFixed(2) + 's of audio.') : ('Error: ' + (data.detail || res.status));
      if (res.ok && typeof data.gen_ms === 'number') { latency.tts = data.gen_ms; renderLatency(); }
    } catch (err) { $('#tts-status').textContent = 'Error: ' + err.message; }
    finally { btn.disabled = false; }
  }
  $('#tts-say').addEventListener('click', function (e) { e.stopPropagation(); ttsPlay(); });
  $('#tts-stop').addEventListener('click', function (e) { e.stopPropagation(); fetch('/tts/stop', { method: 'POST' }).catch(function () {}); });

  var ocrOverlayOn = false;

  async function setOcrOverlay(on) {
    try {
      await fetch('/overlay/' + (on ? 'show' : 'hide'), { method: 'POST' });
      ocrOverlayOn = on;
      var t = $('.tool[data-tool="ocr"]'); if (t) t.setAttribute('aria-pressed', on ? 'true' : 'false');
    } catch (e) {}
  }
  var ocrTool = $('.tool[data-tool="ocr"]');
  if (ocrTool) ocrTool.addEventListener('click', async function (e) {
    e.stopPropagation(); closeMenus();
    if (!ocrOverlayOn) {
      var st = {}; try { st = await (await fetch('/ocr/status')).json(); } catch (err) {}
      if (!st.installed) {
        toast('warn', 'Not installed', "Screen OCR isn't installed yet.",
              { label: 'Open Settings', onClick: function () { openSettings('ocr'); } });
        return;
      }
    }
    setOcrOverlay(!ocrOverlayOn);
  });

  var setScreen = $('#settings-screen'), setTool = $('.tool[data-tool="settings"]');

  var psetFactory = {}, psetUser = {}, psetActive = '';

  function psetAllNames() { return Object.keys(psetFactory).concat(Object.keys(psetUser)); }

  function psetTextOf(n) { return psetUser.hasOwnProperty(n) ? psetUser[n] : (psetFactory[n] || ''); }

  function psetIsBuiltin(n) { return psetFactory.hasOwnProperty(n) && !psetUser.hasOwnProperty(n); }

  function psetFlash() { var s = $('#pset-saved'); if (!s) return; s.classList.add('on'); clearTimeout(psetFlash.t); psetFlash.t = setTimeout(function () { s.classList.remove('on'); }, 900); }
  var psetSaveT;

  function psetSave() {
    clearTimeout(psetSaveT);
    psetSaveT = setTimeout(function () {
      fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_presets: psetUser, default_prompt_preset: psetActive }) })
        .then(function () { psetFlash(); }).catch(function () {});
    }, 300);
  }

  function psetUniqueName(base) {
    var name = base, i = 2;
    while (psetFactory.hasOwnProperty(name) || psetUser.hasOwnProperty(name)) name = base + ' ' + (i++);
    return name;
  }

  function psetRender() {
    var pick = $('#pset-pick'); if (!pick) return;
    var names = psetAllNames();
    if (names.indexOf(psetActive) < 0) psetActive = names[0] || '';
    pick.innerHTML = '';
    names.forEach(function (n) {
      var o = document.createElement('option'); o.value = n;
      o.textContent = n + (psetIsBuiltin(n) ? '  (built-in)' : '');
      pick.appendChild(o);
    });
    pick.value = psetActive;
    var box = $('#pset-box'); box.value = psetTextOf(psetActive);
    var builtin = psetIsBuiltin(psetActive);
    box.readOnly = builtin;
    $('#pset-del').style.display = builtin ? 'none' : '';
    var right = $('#pset-right'); right.innerHTML = '';
    if (builtin) {
      var dup = document.createElement('button'); dup.className = 'pset-dup'; dup.type = 'button'; dup.textContent = 'Duplicate to edit';
      dup.addEventListener('click', function () {
        var name = psetUniqueName(psetActive.replace(/\s*\([^)]*\)\s*$/, '').trim() + ' copy');
        psetUser[name] = psetTextOf(psetActive); psetActive = name; psetRender(); psetSave(); $('#pset-box').focus();
      });
      right.appendChild(dup);
    } else {
      var s = document.createElement('span'); s.className = 'pset-saved'; s.id = 'pset-saved'; s.textContent = 'Saved';
      right.appendChild(s);
    }
  }

  async function psetLoad() {
    var cfg = {}; try { cfg = await (await fetch('/config')).json(); } catch (e) { return; }
    psetFactory = cfg.factory_prompt_presets || {};
    psetUser = cfg.prompt_presets || {};
    psetActive = cfg.default_prompt_preset || Object.keys(psetFactory)[0] || '';
    psetRender();
  }
  $('#pset-pick').addEventListener('change', function () { psetActive = this.value; psetRender(); psetSave(); });
  $('#pset-box').addEventListener('input', function () { if (!psetIsBuiltin(psetActive)) { psetUser[psetActive] = this.value; psetSave(); } });
  $('#pset-new').addEventListener('click', function () {
    var name = psetUniqueName('My prompt');
    psetUser[name] = 'Translate the 🔤-wrapped line to {language}. Output only the translation.';
    psetActive = name; psetRender(); psetSave(); $('#pset-box').focus();
  });
  $('#pset-del').addEventListener('click', function () {
    if (psetIsBuiltin(psetActive)) return;
    delete psetUser[psetActive]; psetActive = psetAllNames()[0] || ''; psetRender(); psetSave();
  });

  var SECTION_LOADERS = { engines: setLoadEngines, translation: setLoadTranslation, audio: setLoadAudio, phrases: setLoadPhrases, voices: setLoadVoices, dictionary: setLoadDictionary, ocr: setLoadOcr, about: setLoadAbout };

  function setShowSection(sec) {
    $$('#snav .snav-b').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-sec') === sec); });
    $$('#spane .spage').forEach(function (p) { p.classList.toggle('on', p.getAttribute('data-sec') === sec); });
    if (SECTION_LOADERS[sec]) SECTION_LOADERS[sec]();
  }

  function openSettings(sec) {
    closePop(); closeDrawer(); closeMenus();
    setScreen.hidden = false;
    setTool.setAttribute('aria-pressed', 'true');
    setShowSection(sec || 'engines');
  }

  function closeSettings() { setScreen.hidden = true; setTool.setAttribute('aria-pressed', 'false'); }
  if (setTool) setTool.addEventListener('click', function (e) { e.stopPropagation(); openSettings(); });
  $('#sset-close').addEventListener('click', closeSettings);
  setScreen.addEventListener('click', function (e) { if (e.target === setScreen) closeSettings(); });
  $$('#snav .snav-b').forEach(function (b) {
    b.addEventListener('click', function () { setShowSection(this.getAttribute('data-sec')); });
  });

  async function setLoadAudio() {
    var cfg = {}; try { cfg = await (await fetch('/config')).json(); } catch (e) { return; }
    var g = $('#set-gate'); g.value = Math.round((cfg.min_sound_level || 0) * 100); $('#set-gate-val').textContent = g.value + '%'; gateWarn();
    var p = $('#set-phrase'); p.value = cfg.stt_max_phrase_s || 12; $('#set-phrase-val').textContent = p.value + 's';
    setTog($('#set-mute-sup'), cfg.suppress_osc_when_muted !== false);

    var perappRow = $('#srow-perapp');
    if (perappRow) perappRow.hidden = !cfg.program_capture_supported;
    setTog($('#set-perapp'), !!cfg.program_capture_enabled);
  }

  function setSaveCfg(patch) { fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(function () {}); }

  var gateDragging = false, lastMicLevel = 0;
  function gatePreviewGated() { var t = (+$('#set-gate').value) / 100; return t > 0 && lastMicLevel < t; }
  function gatePreview() { var gf = $('#gate-fill'); if (gf) gf.classList.toggle('gated', gatePreviewGated()); }

  function gateWarn() { var w = $('#set-gate-warn'); if (w) w.classList.toggle('show', (+$('#set-gate').value) > 0); }
  $('#set-gate').addEventListener('input', function () { $('#set-gate-val').textContent = this.value + '%'; gateDragging = true; gatePreview(); gateWarn(); });
  $('#set-gate').addEventListener('change', function () { gateDragging = false; setSaveCfg({ min_sound_level: (+this.value) / 100 }); });
  $('#set-phrase').addEventListener('input', function () { $('#set-phrase-val').textContent = this.value + 's'; });
  $('#set-phrase').addEventListener('change', function () { setSaveCfg({ stt_max_phrase_s: +this.value }); });
  $('#set-mute-sup').addEventListener('click', function () { var on = !togState(this); setTog(this, on); setSaveCfg({ suppress_osc_when_muted: on }); });
  $('#set-perapp').addEventListener('click', function () {
    var on = !togState(this); setTog(this, on); setSaveCfg({ program_capture_enabled: on });

    if (!on && TR.them.source === 'program') {
      TR.them.source = 'loopback'; TR.them.program = '';
      renderDrawer('them'); renderStrip('them'); save(); relaunchIfLive('them');
    }
    loadPrograms();
  });

  async function setLoadPhrases() {
    var cfg = {}; try { cfg = await (await fetch('/config')).json(); } catch (e) { return; }
    $('#set-blocked').value = (cfg.blocked_phrases || []).join('\n');
    setTog($('#set-discard'), !!cfg.discard_other_alphabets);
  }
  $('#set-blocked').addEventListener('change', function () {
    var list = this.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    setSaveCfg({ blocked_phrases: list });
  });
  $('#set-discard').addEventListener('click', function () { var on = !togState(this); setTog(this, on); setSaveCfg({ discard_other_alphabets: on }); });

  async function setLoadAbout() {
    try { var j = await (await fetch('/version')).json(); $('#set-version').textContent = j && j.version ? 'v' + j.version : '-'; } catch (e) { $('#set-version').textContent = '-'; }
  }
  $('#set-update-check').addEventListener('click', async function () {
    var note = $('#set-update-note'); note.textContent = 'Checking…';
    try {
      var j = await (await fetch('/update/check?force=1')).json();
      note.textContent = j.update_available ? ('Update available: v' + j.latest + ' (you have v' + j.current + ')') : 'You are up to date.';
    } catch (e) { note.textContent = 'Could not check.'; }
  });
  $('#set-shortcut').addEventListener('click', async function () {
    var note = $('#set-shortcut-note');
    note.textContent = 'Creating…';
    try {
      var r = await fetch('/shortcut/create', { method: 'POST' });
      if (r.ok) { note.textContent = 'Added to your Desktop.'; toast('good', '', 'Shortcut created.'); }
      else { var j = await r.json().catch(function () { return {}; }); note.textContent = (j && j.detail) || 'Could not create the shortcut.'; }
    } catch (e) { note.textContent = 'Could not create the shortcut.'; }
  });

  var TBK_SEC = '#spane .spage[data-sec="translation"] ';
  var LLM_BACKENDS = { lmstudio: 1, ollama: 1, openai: 1, openrouter: 1 };

  function tbkShow(bk) {
    $$(TBK_SEC + '.tbk').forEach(function (g) { g.classList.toggle('on', g.getAttribute('data-bk') === bk); });
    var pb = $('#prompt-block'); if (pb) pb.classList.toggle('on', !!LLM_BACKENDS[bk]);
  }

  async function setLoadTranslation() {
    var cfg = {}; try { cfg = await (await fetch('/config')).json(); } catch (e) { return; }
    var bk = cfg.translation_backend || 'google';
    $('#set-tbk').value = bk;

    var lms = $('#set-lms-model'); lms.innerHTML = '';
    var o = document.createElement('option'); o.value = cfg.lmstudio_model || ''; o.textContent = cfg.lmstudio_model || '(server default)'; lms.appendChild(o);
    $$(TBK_SEC + '[data-cfg]').forEach(function (el) {
      var v = cfg[el.getAttribute('data-cfg')];
      el.value = (v === undefined || v === null) ? '' : v;
    });
    tbkShow(bk);
    psetLoad();
    if (bk === 'lmstudio') lmsRefresh(cfg.lmstudio_model || '');
  }

  async function lmsRefresh(keep) {
    var sel = $('#set-lms-model'); if (keep === undefined) keep = sel.value;
    var url = $('#set-lms-url').value.trim();
    sel.innerHTML = '<option>Loading…</option>';
    try {
      var j = await (await fetch('/translate/lmstudio/models?url=' + encodeURIComponent(url))).json();
      sel.innerHTML = '';
      var blank = document.createElement('option'); blank.value = ''; blank.textContent = '(server default)'; sel.appendChild(blank);
      (j.models || []).forEach(function (m) {
        var o = document.createElement('option'); o.value = m.id;
        o.textContent = m.label + (m.params ? ' · ' + m.params : '') + (m.quant ? ' · ' + m.quant : '');
        sel.appendChild(o);
      });
      if (keep && !Array.prototype.some.call(sel.options, function (o) { return o.value === keep; })) {
        var k = document.createElement('option'); k.value = keep; k.textContent = keep + ' (saved)'; sel.appendChild(k);
      }
      sel.value = keep;
    } catch (e) {
      sel.innerHTML = '';
      var er = document.createElement('option'); er.value = keep || ''; er.textContent = keep || '(could not reach LM Studio)'; sel.appendChild(er);
      sel.value = keep || '';
    }
  }
  $('#set-tbk').addEventListener('change', function () {
    setSaveCfg({ translation_backend: this.value }); tbkShow(this.value);
    translateBackend = this.value;
    ['you', 'them'].forEach(function (r) { renderDrawer(r); });
    if (this.value === 'lmstudio') lmsRefresh();
  });
  $$(TBK_SEC + '[data-cfg]').forEach(function (el) {
    el.addEventListener('change', function () {
      var v = this.value;
      if (this.type === 'number') v = (v === '' ? 1.0 : parseFloat(v));
      var patch = {}; patch[this.getAttribute('data-cfg')] = v; setSaveCfg(patch);
    });
  });
  $('#set-lms-refresh').addEventListener('click', function () { lmsRefresh(); });

  var engBusy = false;
  var engJobWatched = false;

  function engShowProg(engId, text) {
    var card = document.querySelector('#set-eng-list .ecard[data-eng="' + engId + '"]');
    if (!card) return;
    var p = card.querySelector('.eprog'); if (p) { p.hidden = false; p.textContent = text; }
    var b = card.querySelector('.etop .sbtn'); if (b) b.disabled = true;
  }

  function watchEngineJob(engId) {
    if (engJobWatched) return;
    engJobWatched = true; engBusy = true;
    pollInstall(function (st) { engShowProg(engId, (st.detail || st.phase || 'Working') + '…'); }).then(function (s) {
      engJobWatched = false; engBusy = false;
      if (s.error) {
        engShowProg(engId, 'Failed: ' + s.error);
        var card = document.querySelector('#set-eng-list .ecard[data-eng="' + engId + '"]');
        var b = card && card.querySelector('.etop .sbtn'); if (b) b.disabled = false;
        return;
      }
      setLoadEngines(); refreshEnginesEverywhere();
    });
  }

  function fmtBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '';
    var u = ['B', 'KB', 'MB', 'GB'], i = Math.floor(Math.log(n) / Math.log(1024));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  function pollInstall(onProg) {
    return new Promise(function (res) {
      var t = setInterval(async function () {
        var s = {}; try { s = await (await fetch('/engines/install/status')).json(); } catch (e) {}
        if (onProg) onProg(s);
        if (s.done || s.error) { clearInterval(t); res(s); }
      }, 800);
    });
  }

  async function setLoadEngines() {
    var wrap = $('#set-eng-list');
    var data; try { data = await (await fetch('/engines')).json(); } catch (e) { wrap.innerHTML = '<div class="snote">Could not load engines.</div>'; return; }
    wrap.innerHTML = '';

    (data.engines || []).slice()
      .sort(function (a, b) { return engRank(a.id) - engRank(b.id) || a.name.localeCompare(b.name); })
      .forEach(function (e) { wrap.appendChild(engCard(e)); });
    var free = null;
    for (var i = 0; i < (data.engines || []).length; i++) {
      if (data.engines[i].installed) {
        try { var m = await (await fetch('/models?engine=' + encodeURIComponent(data.engines[i].id))).json(); free = m.disk_free_bytes; } catch (e) {}
        break;
      }
    }
    $('#set-eng-store').textContent = free != null ? (fmtBytes(free) + ' free on disk') : '';

    var job = data.install_job;
    if (job && !job.done && job.engine) {
      engShowProg(job.engine, (job.detail || job.phase || 'Working') + '…');
      watchEngineJob(job.engine);
    }
  }

  function engCard(e) {
    var card = document.createElement('div'); card.className = 'ecard'; card.dataset.eng = e.id;
    var top = document.createElement('div'); top.className = 'etop';
    var name = document.createElement('div'); name.className = 'ename';

    var paren = /\(([^)]*)\)\s*$/.exec(e.name || '');
    name.textContent = (e.name || '').replace(/\s*\([^)]*\)\s*$/, '').trim() || e.name;
    if (paren) paren[1].split(',').forEach(function (t) {
      t = t.trim(); if (!t) return;
      var tag = document.createElement('span'); tag.className = 'etag'; tag.textContent = t;
      name.appendChild(tag);
    });
    if (e.experimental) { var tg = document.createElement('span'); tg.className = 'etag exp'; tg.textContent = 'experimental'; name.appendChild(tg); }
    var stat = document.createElement('div'); stat.className = 'estat' + (e.installed ? ' ok' : ''); stat.textContent = e.installed ? 'Installed' : 'Not installed';
    var removable = e.installed && e.source === 'installed';
    var btn = document.createElement('button'); btn.className = 'sbtn' + (removable ? ' warn' : '');
    btn.textContent = e.installed ? (removable ? 'Uninstall' : 'Built in') : 'Install';
    if (e.installed && !removable) btn.disabled = true;
    var prog = document.createElement('div'); prog.className = 'eprog'; prog.hidden = true;
    var models = document.createElement('div'); models.className = 'emodels'; models.hidden = true;
    top.appendChild(name); top.appendChild(stat); top.appendChild(btn);
    card.appendChild(top);
    if (e.description) { var desc = document.createElement('div'); desc.className = 'edesc'; desc.textContent = e.description; card.appendChild(desc); }
    card.appendChild(prog); card.appendChild(models);
    btn.addEventListener('click', function () {
      if (engBusy) return;
      if (e.installed) engUninstall(e, btn, prog); else engInstall(e, btn, prog);
    });
    if (e.installed) engLoadModels(e, models);
    return card;
  }

  async function refreshEnginesEverywhere() {
    try { engineInfo = await (await fetch('/engines')).json(); } catch (e) { return; }
    renderAll();
  }

  async function engInstall(e, btn, prog) {
    engBusy = true; btn.disabled = true; prog.hidden = false; prog.textContent = 'Starting install…';
    try { await fetch('/engines/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: e.id }) }); }
    catch (err) { prog.textContent = 'Could not start install.'; engBusy = false; btn.disabled = false; return; }
    watchEngineJob(e.id);
  }

  async function engUninstall(e, btn, prog) {
    if (!(await dialog({ k: 'Uninstall', h: 'Uninstall ' + e.name + '?', p: 'Downloaded models are kept. You can reinstall the engine any time.', ok: 'Uninstall', cancel: 'Cancel', danger: true }))) return;
    engBusy = true; btn.disabled = true; prog.hidden = false; prog.textContent = 'Removing…';
    try { await fetch('/engines/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: e.id }) }); } catch (err) {}
    engBusy = false; setLoadEngines(); refreshEnginesEverywhere();
  }

  var SHARED_MODELS = { 'whisper': 'whisper-batch', 'whisper-batch': 'whisper', 'parakeet': 'parakeet-stream', 'parakeet-stream': 'parakeet' };

  async function engLoadModels(e, box) {
    var m; try { m = await (await fetch('/models?engine=' + encodeURIComponent(e.id))).json(); } catch (err) { return; }
    if (!m.models || m.models.length <= 1) { box.hidden = true; return; }
    box.hidden = false; box.innerHTML = '';
    m.models.forEach(function (md) {
      var r = document.createElement('div'); r.className = 'mrow2';
      var nm = document.createElement('span'); nm.className = 'mn'; nm.textContent = md.label || md.id; r.appendChild(nm);
      if (md.active) { var a = document.createElement('span'); a.className = 'mact'; a.textContent = 'active'; r.appendChild(a); }
      var sz = document.createElement('span'); sz.className = 'msz';

      sz.textContent = md.installed ? fmtBytes(md.size_bytes) : (md.est_download ? ('~' + md.est_download) : ''); r.appendChild(sz);
      var b = document.createElement('button'); b.className = 'sbtn';
      if (md.installed) {
        b.textContent = 'Delete'; b.classList.add('warn');
        b.addEventListener('click', function () { if (!engBusy) engDelModel(e, md, box); });
      } else if (md.can_download !== false) {
        b.textContent = 'Download';
        b.addEventListener('click', function () { if (!engBusy) engDlModel(e, md, r, b); });
      } else { b.style.display = 'none'; }
      r.appendChild(b);
      box.appendChild(r);
    });

    var partner = SHARED_MODELS[e.id];
    if (partner && engById(partner) && engById(partner).installed) {
      var snote = document.createElement('div'); snote.className = 'snote shared';
      snote.textContent = 'Shared with ' + engName(partner) + ': one download serves both, deleting frees both.';
      box.appendChild(snote);
    }
  }

  async function engDlModel(e, md, row, btn) {
    engBusy = true; btn.disabled = true; btn.textContent = '…';
    try {
      var resp = await fetch('/models/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: e.id, model: md.id }) });
      if (!resp.ok) {
        var detail = ''; try { detail = (await resp.json()).detail; } catch (e2) {}
        toast('warn', '', detail || 'Could not start the download.');
        engBusy = false; btn.disabled = false; btn.textContent = 'Download'; return;
      }
    }
    catch (err) { engBusy = false; btn.disabled = false; btn.textContent = 'Download'; return; }
    watchEngineJob(e.id);
  }

  async function engDelModel(e, md, box) {
    var go = await dialog({ k: 'Delete model', h: 'Delete ' + (md.label || md.id) + '?',
      p: 'You can download it again later.', ok: 'Delete', cancel: 'Cancel', danger: true });
    if (!go) return;
    engBusy = true;
    var res;
    try { res = await fetch('/models/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: e.id, model: md.id }) }); }
    catch (err) { engBusy = false; toast('bad', '', 'Could not reach the app to delete the model.'); return; }
    engBusy = false;
    if (!res.ok) {
      var b = await res.json().catch(function () { return {}; });
      toast('warn', '', (b && b.detail) || 'Could not delete the model.');
      return;
    }
    engLoadModels(e, box); setLoadEngines();
  }

  async function setLoadDictionary() {
    var st = {}; try { st = await (await fetch('/lang/status')).json(); } catch (e) { return; }
    var b = $('#set-lang-btn'); b.disabled = false; b.classList.toggle('warn', st.installed);
    b.textContent = st.installed ? 'Remove' : 'Download';
    b.onclick = st.installed ? langRemove : langDownload;
    $('#set-tok').hidden = !st.installed;
    if (st.installed) {
      var tk = {}; try { tk = await (await fetch('/lang/tokenizer')).json(); } catch (e) {}
      $('#set-tok-sel').value = tk.enabled ? 'hi' : 'std';
      $('#set-tok-remove-row').hidden = !tk.available;
    }
  }

  async function langDownload() {
    if (engBusy) return; engBusy = true; var b = $('#set-lang-btn'); b.disabled = true; var p = $('#set-lang-prog'); p.hidden = false; p.textContent = 'Downloading…';
    try {
      var resp = await fetch('/lang/download', { method: 'POST' });
      if (!resp.ok) { var detail = ''; try { detail = (await resp.json()).detail; } catch (e2) {} p.textContent = detail || 'Failed to start.'; engBusy = false; b.disabled = false; return; }
    } catch (e) { p.textContent = 'Failed to start.'; engBusy = false; b.disabled = false; return; }
    var s = await pollInstall(function (st) { p.textContent = (st.detail || st.phase || 'Downloading') + '…'; });
    engBusy = false; p.hidden = true;
    if (s.error) { p.hidden = false; p.textContent = 'Failed: ' + s.error; }
    setLoadDictionary();
  }

  async function langRemove() {
    if (!(await dialog({ k: 'Remove', h: 'Remove the dictionary data?', p: 'Frees about <b>63 MB</b>. You can download it again later.', ok: 'Remove', cancel: 'Cancel', danger: true }))) return;
    engBusy = true; try { await fetch('/lang/remove', { method: 'POST' }); } catch (e) {} engBusy = false; setLoadDictionary();
  }

  function pollTok(onProg) {
    return new Promise(function (res) {
      var t = setInterval(async function () {
        var s = {}; try { s = await (await fetch('/lang/tokenizer')).json(); } catch (e) {}
        if (onProg) onProg(s);
        if (!s.downloading) { clearInterval(t); res(s); }
      }, 800);
    });
  }
  $('#set-tok-sel').addEventListener('change', async function () {
    var v = this.value, p = $('#set-tok-prog');
    if (v === 'std') { try { await fetch('/lang/tokenizer/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) }); } catch (e) {} setLoadDictionary(); return; }
    var tk = {}; try { tk = await (await fetch('/lang/tokenizer')).json(); } catch (e) {}
    if (tk.available) { try { await fetch('/lang/tokenizer/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) }); } catch (e) {} setLoadDictionary(); return; }
    p.hidden = false; p.textContent = 'Downloading Sudachi…';
    try { await fetch('/lang/tokenizer/download', { method: 'POST' }); } catch (e) { p.textContent = 'Failed to start.'; return; }
    await pollTok(function (s) { p.textContent = 'Downloading Sudachi… ' + Math.round((s.progress || 0) * 100) + '%'; });
    p.hidden = true; setLoadDictionary();
  });
  $('#set-tok-remove').addEventListener('click', async function () {
    if (!(await dialog({ k: 'Remove', h: 'Remove the high-accuracy word splitting?', p: 'Frees about <b>215 MB</b> of Sudachi data. Word splitting falls back to the built-in tokenizer.', ok: 'Remove', cancel: 'Cancel', danger: true }))) return;
    try { await fetch('/lang/tokenizer/remove', { method: 'POST' }); } catch (e) {} setLoadDictionary();
  });

  async function setLoadOcr() {
    var st = {}; try { st = await (await fetch('/ocr/status')).json(); } catch (e) { return; }
    var b = $('#set-ocr-btn'); b.disabled = false; b.classList.toggle('warn', st.installed);
    b.textContent = st.installed ? 'Uninstall' : 'Install';
    b.onclick = st.installed ? ocrRemove : ocrInstall;
  }

  async function ocrInstall() {
    if (engBusy) return; engBusy = true; var b = $('#set-ocr-btn'); b.disabled = true; var p = $('#set-ocr-prog'); p.hidden = false; p.textContent = 'Installing…';
    try { await fetch('/engines/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'ocr' }) }); } catch (e) { p.textContent = 'Failed to start.'; engBusy = false; b.disabled = false; return; }
    var s = await pollInstall(function (st) { p.textContent = (st.detail || st.phase || 'Installing') + '…'; });
    engBusy = false; p.hidden = true;
    if (s.error) { p.hidden = false; p.textContent = 'Failed: ' + s.error; setLoadOcr(); return; }
    try { await fetch('/ocr/start', { method: 'POST' }); } catch (e) {}
    setLoadOcr();
  }

  async function ocrRemove() {
    if (!(await dialog({ k: 'Uninstall', h: 'Uninstall Screen OCR?', p: 'Frees about <b>700 MB</b>. You can reinstall it any time.', ok: 'Uninstall', cancel: 'Cancel', danger: true }))) return;
    engBusy = true;
    try { await fetch('/ocr/stop', { method: 'POST' }); await fetch('/engines/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'ocr' }) }); } catch (e) {}
    engBusy = false; setLoadOcr();
  }

  var ttsChars = [];

  async function setLoadVoices() {
    var wrap = $('#set-tts-list');
    var st = {}; try { st = await (await fetch('/tts/status')).json(); } catch (e) { wrap.innerHTML = '<div class="snote">Could not load voices.</div>'; return; }
    wrap.innerHTML = '';
    (st.packs || []).forEach(function (p) { wrap.appendChild(ttsPackCard(p, st.vc_runtime || {})); });

    var cat = {}; try { cat = await (await fetch('/tts/catalog')).json(); } catch (e) {}
    $('#set-tts-cat').hidden = !cat.engine_installed;
    if (cat.engine_installed) { ttsChars = cat.characters || []; ttsRenderChars(); }
  }

  function ttsPackCard(p, vc) {
    var card = document.createElement('div'); card.className = 'ecard';
    var top = document.createElement('div'); top.className = 'etop';
    var name = document.createElement('div'); name.className = 'ename'; name.textContent = p.name;
    if (p.languages && p.languages.length) { var tg = document.createElement('span'); tg.className = 'etag'; tg.textContent = p.languages.join(', '); name.appendChild(tg); }
    var stat = document.createElement('div'); stat.className = 'estat' + (p.installed ? ' ok' : ''); stat.textContent = p.installed ? 'Installed' : 'Not installed';
    var removable = p.installed && p.source === 'installed';
    var btn = document.createElement('button'); btn.className = 'sbtn' + (removable ? ' warn' : '');
    btn.textContent = p.installed ? (removable ? 'Uninstall' : 'Built in') : 'Install';
    if (p.installed && !removable) btn.disabled = true;
    var prog = document.createElement('div'); prog.className = 'eprog'; prog.hidden = true;
    top.appendChild(name); top.appendChild(stat); top.appendChild(btn);
    card.appendChild(top);
    if (p.needs_vc_runtime && vc && !vc.ok) {
      var w = document.createElement('div'); w.className = 'snote';
      w.innerHTML = 'Needs the Microsoft Visual C++ runtime' + (vc.url ? ' (<a href="' + vc.url + '" target="_blank" rel="noopener">download</a>)' : '') + '.';
      card.appendChild(w);
    }
    card.appendChild(prog);
    btn.addEventListener('click', function () { if (engBusy) return; if (p.installed) ttsRemovePack(p, btn, prog); else ttsInstallPack(p, btn, prog); });
    return card;
  }

  async function ttsInstallPack(p, btn, prog) {
    if (p.agreement_required && !p.terms_accepted) {
      var lic = p.license || {};
      var pHtml = 'This voice requires accepting its license'
        + (lic.name ? ' (<b>' + escHtml(lic.name) + '</b>)' : '') + '.'
        + (lic.summary ? '<br><br>' + escHtml(lic.summary) : '');
      var links = (lic.terms_urls || []).filter(function (t) { return t && t.url; });
      if (links.length) {
        pHtml += '<br><br>' + links.map(function (t) {
          return '<a href="' + escHtml(t.url) + '" target="_blank" rel="noopener">' + escHtml(t.label || 'Terms') + ' ↗</a>';
        }).join(' &middot; ');
      }
      if (!(await dialog({ k: 'License', h: 'Accept the license and download?', p: pHtml, ok: 'Accept and download', cancel: 'Cancel' }))) return;
      try { await fetch('/tts/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: p.id }) }); } catch (e) {}
    }
    engBusy = true; btn.disabled = true; prog.hidden = false; prog.textContent = 'Installing…';
    try { await fetch('/engines/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: p.id }) }); }
    catch (e) { prog.textContent = 'Failed to start.'; engBusy = false; btn.disabled = false; return; }
    var s = await pollInstall(function (st) { prog.textContent = (st.detail || st.phase || 'Installing') + '…'; });
    engBusy = false;
    if (s.error) { prog.textContent = 'Failed: ' + s.error; btn.disabled = false; return; }
    setLoadVoices();
  }

  async function ttsRemovePack(p, btn, prog) {
    if (!(await dialog({ k: 'Uninstall', h: 'Uninstall ' + p.name + '?', p: 'You can reinstall this voice any time.', ok: 'Uninstall', cancel: 'Cancel', danger: true }))) return;
    engBusy = true; btn.disabled = true; prog.hidden = false; prog.textContent = 'Removing…';
    try { await fetch('/engines/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: p.id }) }); } catch (e) {}
    engBusy = false; setLoadVoices();
  }

  function ttsRenderChars() {
    var box = $('#set-tts-chars'), f = ($('#set-tts-filter').value || '').toLowerCase();
    box.innerHTML = '';
    ttsChars.filter(function (ch) { return !f || (ch.speaker + ' ' + (ch.en || '')).toLowerCase().indexOf(f) >= 0; })
      .forEach(function (ch) {
        var total = Array.isArray(ch.styles) ? ch.styles.length : (ch.styles || 0);
        var r = document.createElement('div'); r.className = 'mrow2';
        var nm = document.createElement('span'); nm.className = 'mn'; nm.textContent = ch.speaker + (ch.en ? ' (' + ch.en + ')' : ''); r.appendChild(nm);
        var sc = document.createElement('span'); sc.className = 'msz'; sc.textContent = total + (total === 1 ? ' style' : ' styles'); r.appendChild(sc);
        if (ch.downloaded) {
          var ok = document.createElement('span'); ok.className = 'mact'; ok.textContent = 'installed ✓'; r.appendChild(ok);
        } else {
          var b = document.createElement('button'); b.className = 'sbtn';
          b.textContent = (ch.styles_available > 0) ? ('Get ' + (total - ch.styles_available) + ' more') : 'Download';
          b.addEventListener('click', function () { if (!engBusy) ttsDlChar(ch, b); });
          r.appendChild(b);
        }
        box.appendChild(r);
      });
  }

  async function ttsDlChar(ch, btn) {
    engBusy = true; btn.disabled = true; btn.textContent = '…';
    try { await fetch('/tts/voices/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speaker: ch.speaker }) }); }
    catch (e) { engBusy = false; btn.disabled = false; return; }
    await new Promise(function (res) {
      var t = setInterval(async function () {
        var s = {}; try { s = await (await fetch('/tts/voices/download/status')).json(); } catch (e) {}
        if (s.detail) btn.textContent = s.detail;
        if (s.done || s.error) { clearInterval(t); res(s); }
      }, 800);
    });
    engBusy = false; ttsLoadCatalogRefresh();
  }

  async function ttsLoadCatalogRefresh() {
    var cat = {}; try { cat = await (await fetch('/tts/catalog')).json(); } catch (e) { return; }
    ttsChars = cat.characters || []; ttsRenderChars();
  }
  $('#set-tts-filter').addEventListener('input', ttsRenderChars);

  fetch('/version').then(function (r) { return r.json(); }).then(function (j) {
    var v = $('#ver'); if (v && j && j.version) v.textContent = 'v' + j.version;
  }).catch(function () {});
  fetch('/update/check').then(function (r) { return r.json(); }).then(function (j) {
    if (!j || !j.update_available) return;
    var u = $('#upd'); if (!u) return;
    u.hidden = false;
    u.textContent = 'Update ' + (j.latest || '') + ' available';
    u.addEventListener('click', function () { fetch('/update/open', { method: 'POST' }).catch(function () {}); });
  }).catch(function () {});

  function bindWords(scope) {
    $$('.w', scope).forEach(function (w) {
      if (w._b) return; w._b = 1;
      w.addEventListener('click', function (e) { e.stopPropagation();  });
    });
  }

  var wizScreen = $('#wiz'), wizChoice = null;

  function wizStep(id) { $$('#wiz .wstep').forEach(function (s) { s.classList.toggle('on', s.id === id); }); }

  function openWizard() {
    wizScreen.hidden = false;

    var WIZ_HIDE = { whisper: true };
    var all = engineInfo ? engineInfo.engines : [];
    var offered = all.filter(function (e) { return !e.experimental && !WIZ_HIDE[e.id]; });
    var choices = offered.length ? offered : all;
    var rec = engineInfo && engineInfo.has_nvidia_gpu ? 'whisper-batch' : 'parakeet';
    wizChoice = choices.some(function (e) { return e.id === rec; }) ? rec : (choices[0] && choices[0].id) || null;
    var box = $('#wiz-engines');
    box.innerHTML = choices.map(function (e) {
      var size = (e.id === 'whisper' || e.id === 'whisper-batch') ? '2-4 GB download' : 'about 1 GB download';
      var badge = e.id === wizChoice ? '<span class="weng-badge">Recommended for your PC</span>' : '';
      return '<div class="weng-card' + (e.id === wizChoice ? ' sel' : '') + '" data-engine="' + escHtml(e.id) + '">' +
        '<span class="weng-name">' + escHtml(e.name) + badge + '</span>' +
        '<span class="weng-blurb">' + size + '</span></div>';
    }).join('');
    $$('.weng-card', box).forEach(function (c) {
      c.addEventListener('click', function () {
        wizChoice = c.dataset.engine;
        $$('.weng-card', box).forEach(function (x) { x.classList.toggle('sel', x === c); });
      });
    });

    if (engineInfo && engineInfo.install_job && !engineInfo.install_job.done) {
      wizStep('wiz-install-step'); wizResumeInstall();
    } else {
      wizStep('wiz-engine');
    }
  }

  function closeWizard() {
    wizScreen.hidden = true;
    if (engineInfo) engineInfo.wizard_done = true;

    fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wizard_done: true }) }).catch(function () {});
  }

  async function wizRefreshEngines() {
    try { engineInfo = await (await fetch('/engines')).json(); } catch (e) {}
  }

  function wizResumeInstall() {
    var prog = $('#wiz-prog'), back = $('#wiz-install-back'); back.hidden = true;
    pollInstall(function (st) { prog.textContent = (st.detail || st.phase || 'Installing') + '…'; }).then(function (s) {
      if (s.error) { prog.textContent = 'Failed: ' + s.error; back.hidden = false; return; }
      wizRefreshEngines().then(wizEnterSetup);
    });
  }

  async function wizInstall() {
    var e = engById(wizChoice);
    if (e && e.installed) { wizEnterSetup(); return; }
    wizStep('wiz-install-step');
    var prog = $('#wiz-prog'), back = $('#wiz-install-back'); back.hidden = true; prog.textContent = 'Starting install…';
    try {
      var res = await fetch('/engines/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: wizChoice }) });
      if (!res.ok && res.status !== 409) { var p = await res.json().catch(function () { return {}; }); throw new Error(p.detail || 'Install failed to start'); }
    } catch (err) { prog.textContent = err.message; back.hidden = false; return; }
    var s = await pollInstall(function (st) { prog.textContent = (st.detail || st.phase || 'Installing') + '…'; });
    if (s.error) { prog.textContent = 'Failed: ' + s.error; back.hidden = false; return; }
    await wizRefreshEngines();
    wizEnterSetup();
  }

  function wizSetTranslate(on) {
    var t = $('#wiz-translate'); t.setAttribute('aria-pressed', on ? 'true' : 'false'); t.textContent = on ? 'On' : 'Off';
    $('#wiz-target').disabled = !on;
  }

  function wizEnterSetup() {
    wizStep('wiz-setup');
    var e = engById(wizChoice), langs = (e && e.languages) || [];
    var def = langs.indexOf(engineInfo.language) >= 0 ? engineInfo.language
      : (langs.indexOf('en') >= 0 ? 'en' : langs[0]);
    $('#wiz-lang').innerHTML = srcLangOpts(langs).map(function (o) {
      return '<option value="' + escHtml(o.v) + '"' + (o.disabled ? ' disabled' : '')
        + (o.v === def ? ' selected' : '') + '>' + escHtml(o.n) + '</option>';
    }).join('');
    var list = allDevices.mic || [];
    $('#wiz-device').innerHTML = list.length
      ? list.map(function (d) { return '<option value="' + d.index + '">' + escHtml(d.name) + '</option>'; }).join('')
      : '<option value="">No microphones found</option>';
    $('#wiz-target').innerHTML = targetLangOpts().map(function (l) { return '<option value="' + escHtml(l.v) + '"' + (l.disabled ? ' disabled' : '') + '>' + escHtml(l.n) + '</option>'; }).join('');
    $('#wiz-target').value = TR.you.tgt || 'ja-JP';
    wizSetTranslate(TR.you.translate !== false);

    wizTog($('#wiz-feat-dict'), true);
  }

  function wizTog(btn, on) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); btn.textContent = on ? 'On' : 'Off'; }

  async function wizFinish() {
    var lang = $('#wiz-lang').value;
    var devSel = $('#wiz-device');
    var devName = devSel.selectedOptions[0] ? devSel.selectedOptions[0].textContent : '';
    var translate = $('#wiz-translate').getAttribute('aria-pressed') === 'true';
    var tgt = $('#wiz-target').value;
    var e = engById(wizChoice);
    var model = (engineInfo.engine_models && engineInfo.engine_models[wizChoice]) || (e && e.default_model) || (e && e.models[0]) || '';
    var c = TR.you;
    c.engine = wizChoice; c.model = model;
    if (lang) c.src = lang;
    if (devName) c.device = devName;
    c.translate = translate;
    if (tgt) c.tgt = tgt;

    if (!engById(TR.them.engine) || !engById(TR.them.engine).installed) { TR.them.engine = wizChoice; TR.them.model = model; }

    var themE = engById(TR.them.engine);
    if (themE && (!TR.them.src || themE.languages.indexOf(TR.them.src) < 0)) {
      TR.them.src = themE.languages.indexOf(engineInfo.language) >= 0 ? engineInfo.language : (themE.languages[0] || 'auto');
    }
    var wantDict = $('#wiz-feat-dict').getAttribute('aria-pressed') === 'true';
    save();
    fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mic_device_name: devName, target_language: tgt }) }).catch(function () {});
    renderAll();
    closeWizard();

    var jobs = [];

    if (wizChoice === 'whisper' || wizChoice === 'whisper-batch') {
      jobs.push({ label: 'Whisper model', begin: async function () {
        var info = await (await fetch('/models?engine=' + wizChoice)).json();
        var md = (info.models || []).filter(function (m) { return m.id === model; })[0];
        if (!md || md.installed) return false;
        var r = await fetch('/models/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: wizChoice, model: model }) });
        if (!r.ok) throw new Error('download rejected');
        return true;
      } });
    }

    if (wizChoice === 'parakeet' && lang === 'ja') {
      jobs.push({ label: 'Japanese model', begin: async function () {
        var info = await (await fetch('/models?engine=parakeet')).json();
        var ja = (info.models || []).filter(function (m) { return m.id === 'parakeet-ja'; })[0];
        if (!ja || ja.installed) return false;
        var r = await fetch('/models/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'parakeet', model: 'parakeet-ja' }) });
        if (!r.ok) throw new Error('download rejected');
        return true;
      } });
    }
    if (wantDict) {
      jobs.push({ label: 'Japanese dictionary', begin: async function () {
        var st = await (await fetch('/lang/status')).json().catch(function () { return {}; });
        if (st.installed) return false;
        var r = await fetch('/lang/download', { method: 'POST' });
        if (!r.ok) throw new Error('download rejected');
        return true;
      } });
    }
    wizRunJobs(jobs);
  }

  async function wizRunJobs(jobs) {
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i], started;
      try { started = await j.begin(); }
      catch (e) { foot(j.label + ' could not start. Add it later in Settings.'); continue; }
      if (!started) continue;
      foot('Downloading ' + j.label + '…');
      var s = await pollInstall((function (label) { return function (st) { foot(label + ': ' + (st.detail || st.phase || 'working') + '…'); }; })(j.label));
      if (s.error) { foot(j.label + ' failed. Add it later in Settings.'); continue; }
      if (j.after) { try { await j.after(); } catch (e) {} }
    }
    foot('Ready. Press You to start.');
  }

  $('#wiz-install').addEventListener('click', wizInstall);
  $('#wiz-install-back').addEventListener('click', function () { wizStep('wiz-engine'); });
  $('#wiz-translate').addEventListener('click', function () { wizSetTranslate($('#wiz-translate').getAttribute('aria-pressed') !== 'true'); });
  $('#wiz-feat-dict').addEventListener('click', function () { wizTog(this, this.getAttribute('aria-pressed') !== 'true'); });
  $('#wiz-finish').addEventListener('click', wizFinish);
  $('#wiz-skip').addEventListener('click', function () {
    closeWizard();
    foot('No engine installed. Open Settings > Engines to install one.');
  });

  window.__v2 = {
    TR: TR, running: running, renderAll: renderAll, bindWords: bindWords,
    engById: engById, openWizard: openWizard,
    get active() { return active; }, get engineInfo() { return engineInfo; }
  };

  feed.innerHTML = EMPTY;
  try { setReading(localStorage.getItem('v2Reading') || 'off'); } catch (e) { setReading('off'); }

  fetch('/lang.json').then(function (r) { return r.json(); })
    .then(applyLangData).catch(function () {})
    .then(function () {
      loadStored();
      renderAll();
      ccPopulateWinPickers();
      ccReconcileOverlay();
      ttsSyncLight();
      loadBackend();
      openWs();

    });
})();
