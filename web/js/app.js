import * as api from './lib/api.js';
import { state } from './lib/state.js';
import { $, $$, escHtml, label, fillOpts, matchDeviceValue, shortSrc, shortTgt } from './lib/util.js';
import { foot, toast, dialog, setTog, togState, closePop, closeDrawer, closeMenus, openMenu } from './lib/ui.js';
import { engById, engName, engRank, engShort } from './core/engines.js';
import { setLangData, setSupportedTargets, targetLangOpts, tgtName, langName, transSrc } from './core/lang.js';
import { initSettings, openSettings, closeSettings, pollInstall, ccApplyWin, ccPopulateWinPickers, gatePreviewGated } from './features/settings.js';
import { normalizeForBlocklist, stripBlockedPhrases, stripOtherAlphabets, stripCommittedOverlap, hasRepetition, endsWithSentenceEnder } from './lib/text.js';
import { initWizard, openWizard } from './features/wizard.js';
import { initDownloads, runModelDownload } from './features/downloads.js';

(function () {
  'use strict';

  var TR = {
    you:   { source: 'mic',      engine: '', model: '', src: '', tgt: 'ja-JP', device: '', program: '', translate: true,
             dest: { tts: false } },
    them: { source: 'loopback', engine: '', model: '', src: '', tgt: 'en-US', device: '', program: '', translate: true,
             dest: { tts: false } }
  };
  var oscOwner = 'you';

  var allPrograms = [];
  var programsAvailable = false;
  function isProgram(r) { return TR[r].source === 'program' && !!TR[r].program; }

  function loadPrograms() {
    return api.getAudioPrograms().then(function (d) {
      programsAvailable = !!(d && d.available);
      allPrograms = (d && d.programs) || [];
      renderDrawer('them');
    }).catch(function () {});
  }

  function loadDevices() {
    return api.getDevices().then(function (d) {
      state.allDevices = { mic: (d && d.mic) || [], loopback: (d && d.loopback) || [] };
      renderDrawer('you'); renderDrawer('them');
    }).catch(function () {});
  }

  var ws = null, userClosing = false, capturing = false;

  function bothRunning() { return state.running.you && state.running.them; }

  function loneSlot() { return state.running.you && !state.running.them ? 'you'
                             : (state.running.them && !state.running.you ? 'them' : null); }

  function primarySlot() { return bothRunning() ? streamSlot : loneSlot(); }

  var pendingStart = false;

  var startGen = 0;
  var activeText = '', liveKind = null, activeLineTime = null;
  var shownChars = 0, latestLineLength = 0, lineCount = 0, lastCommittedText = '', engineSignalsFinal = false;
  var silenceTimer = null, lastLineUpdateAt = 0;
  var blockedPhrases = [], discardOtherAlphabets = false;
  var latency = { stt: null, translate: null, tts: null };

  var app = $('#app'), feed = $('#feed');
  var strip = $('.strip'), drawer = $('#drawer');
  var live = $('#cur-line'), liveWho = $('.who', live), liveO = $('.cap-o', live);
  var curBox = $('#current');
  var EMPTY = '<div class="empty">No captions yet. Start a transport to begin.</div>';

  function engineStreamsPartials(id) { return !BATCH_ENGINES[id]; }

  function showLiveLine(on) { if (curBox) curBox.style.display = on ? '' : 'none'; }
  showLiveLine(false);

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

  var _serverSaveTimer = null, _bootDone = false;

  function saveServer() {
    var reading = (window.jadict && window.jadict.readingMode) || 'off';
    api.saveConfig({ ui_state: { TR: TR, oscOwner: oscOwner, overlaySource: state.overlaySource, reading: reading } })
       .catch(function () {});
  }
  function scheduleServerSave() {
    if (!_bootDone) return;
    if (_serverSaveTimer) clearTimeout(_serverSaveTimer);
    _serverSaveTimer = setTimeout(function () { _serverSaveTimer = null; saveServer(); }, 500);
  }

  function save() {
    try {
      localStorage.setItem('v2Transports', JSON.stringify({ TR: TR, oscOwner: oscOwner, overlaySource: state.overlaySource }));
    } catch (e) {}
    scheduleServerSave();
  }

  function applyStored(s) {
    if (!s || typeof s !== 'object') return;

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
    if (s.overlaySource !== undefined) state.overlaySource = s.overlaySource;
    if (typeof s.reading === 'string') setReading(s.reading);
  }

  function loadStored() {
    try { applyStored(JSON.parse(localStorage.getItem('v2Transports') || 'null')); } catch (e) {}
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && _serverSaveTimer) {
      clearTimeout(_serverSaveTimer); _serverSaveTimer = null; saveServer();
    }
  });

  function installedEngines() {
    if (!state.engineInfo) return [];
    return state.engineInfo.engines.filter(function (e) { return e.installed; })
      .sort(function (a, b) { return engRank(a.id) - engRank(b.id) || a.name.localeCompare(b.name); });
  }

  function seedDefaults(cfg) {
    var engs = installedEngines();
    var fallbackEngine = (state.engineInfo && engById(state.engineInfo.active_engine) && engById(state.engineInfo.active_engine).installed)
      ? state.engineInfo.active_engine : (engs[0] ? engs[0].id : '');
    ['you', 'them'].forEach(function (r) {
      var c = TR[r];

      if (!c.engine || !engById(c.engine) || !engById(c.engine).installed) c.engine = fallbackEngine;
      var e = engById(c.engine);
      if (e) {
        if (!c.model || e.models.indexOf(c.model) < 0) {
          var cfgModel = state.engineInfo.engine_models && state.engineInfo.engine_models[e.id];

          var hwDefault = (e.id === 'whisper-batch' && !state.engineInfo.has_nvidia_gpu) ? 'small' : e.default_model;
          c.model = cfgModel || hwDefault || e.models[0] || '';
        }
        if (!c.src || e.languages.indexOf(c.src) < 0) {
          c.src = (e.languages.indexOf(state.engineInfo.language) >= 0 ? state.engineInfo.language : (e.languages[0] || 'auto'));
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
        api.getEngines(),
        api.getDevices(),
        api.getConfig()
      ]);
      eng = results[0]; dev = results[1]; cfg = results[2];
    } catch (e) {
      renderAll(); return;
    }
    state.engineInfo = eng;
    state.allDevices = { mic: (dev && dev.mic) || [], loopback: (dev && dev.loopback) || [] };
    loadPrograms();

    blockedPhrases = ((cfg.default_blocked_phrases || []).concat(cfg.blocked_phrases || []))
      .map(normalizeForBlocklist).filter(Boolean);
    discardOtherAlphabets = cfg.discard_other_alphabets === true;
    state.translateBackend = cfg.translation_backend || 'google';
    state.oscChatbox = cfg.osc_chatbox || 'original_first';
    setSupportedTargets(cfg.translate_supported_targets || {});

    var hadUiState = !!(cfg.ui_state && Object.keys(cfg.ui_state).length);
    if (hadUiState) applyStored(cfg.ui_state);
    _bootDone = true;
    seedDefaults(cfg);
    renderAll();

    if (!hadUiState) saveServer();

    if (state.engineInfo.engines.length && state.engineInfo.engines.every(function (e) { return !e.installed; })) {
      if (state.engineInfo.wizard_done) foot('No engine installed. Open Settings > Engines to install one.');
      else openWizard();
    }
  }

  var PINNED_LANGS = ['auto'];

  function langOpts(codes, pin, valueOf) {
    var has = {};
    codes.forEach(function (c) { has[c] = true; });
    var top = pin.filter(function (c) { return has[c]; });
    var rest = codes.filter(function (c) { return pin.indexOf(c) < 0; });
    rest.sort(function (a, b) {
      return langName(a).localeCompare(langName(b));
    });
    function opt(c) { return { v: valueOf(c), n: langName(c) }; }
    return top.map(opt).concat(rest.map(opt));
  }

  function srcLangOpts(langs) {
    return langOpts(langs, PINNED_LANGS, function (c) { return c; });
  }

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

    var lockModel = (r === 'them' && sharedModelBoth() && e && e.models.length > 1);
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

    var list = r === 'you' ? state.allDevices.mic : state.allDevices.loopback;
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
    var n = (state.running.you ? 1 : 0) + (state.running.them ? 1 : 0);
    $('#srcs').textContent = n === 0 ? 'idle' : n + ' source' + (n > 1 ? 's' : '');
    var live = $('#live');
    live.classList.toggle('off', n === 0);
    live.textContent = n === 0 ? 'Idle' : 'Listening';
    $('#fstate').textContent = n === 0 ? 'Idle' : 'Listening';
    ['you', 'them'].forEach(function (r) { $('#tr-' + r).classList.toggle('on', state.running[r]); });
  }

  function openExternal(url) {
    if (url) api.openExternal(url).catch(function () {});
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[target="_blank"]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) { e.preventDefault(); openExternal(href); }
  }, true);

  initDownloads({ refreshStatus: refreshStatus });

  function renderLatency() {
    var parts = [];
    if (latency.stt != null) parts.push('STT ' + latency.stt + 'ms');
    if (latency.translate != null) parts.push('TL ' + latency.translate + 'ms');
    if (latency.tts != null) parts.push('TTS ' + latency.tts + 'ms');
    $('#flat').textContent = parts.length ? parts.join(' + ') : '-';
  }

  function englishModeSelected() { var p = primarySlot(); return !!p && TR[p].src === 'en'; }
  var SOFT_LENGTH_LIMIT = 30;

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
      api.getEngineStartup().then(function (s) {
        if (capturing || !pendingStart) return;
        var txt = s.phase === 'ready' ? '' : 'Loading model…';
        if (txt) { foot(txt); setPreparing(txt); }
        if (s.phase !== 'ready') startupPoll = setTimeout(tick, 500);
      }).catch(function () { if (!capturing && pendingStart) startupPoll = setTimeout(tick, 900); });
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
    var p = primarySlot();
    var fresh = !activeLineTime;
    if (liveKind !== p || live.classList.contains('idle')) setListening(p);
    if (fresh) {
      activeLineTime = new Date();
      if (p && oscOwner === p) send({ action: 'osc_typing', flag: true });
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
      var body = { text: text, sourceLanguage: transSrc(c.src), targetLanguage: c.tgt || '' };
      var res = await api.translate(body);
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

      if (translated && autoSpeakOn(r) && state.ttsReads === 'translation') ttsSpeak(translated, c.tgt);
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
    var mode = state.oscChatbox || 'original_first';

    if (!translated) return oscTailWindow(original, OSC_MAX_CHARS);
    if (mode === 'original_only') return oscTailWindow(original, OSC_MAX_CHARS);
    if (mode === 'translation_only') return oscHeadWindow(translated, OSC_MAX_CHARS);
    var flip = mode === 'translation_first';
    var sep = '\n', combined = flip ? translated + sep + original : original + sep + translated;
    if (combined.length <= OSC_MAX_CHARS) return combined;
    var avail = OSC_MAX_CHARS - sep.length;
    var tBudget = Math.min(translated.length, Math.round(avail * OSC_TRANSLATION_SHARE));
    var oBudget = avail - tBudget;
    if (original.length < oBudget) { tBudget = Math.min(translated.length, avail - original.length); oBudget = avail - tBudget; }
    var o = oscTailWindow(original, oBudget), t = oscHeadWindow(translated, tBudget);
    return flip ? t + sep + o : o + sep + t;
  }

  async function sendOsc(original, translated) {
    var payload = buildOscPayload(original, translated || '');
    if (payload) await send({ action: 'send_osc', text: payload });
  }

  function stopOscTyping() { return send({ action: 'osc_typing', flag: false }); }

  function autoSpeakOn(r) { return !!(r && TR[r] && TR[r].dest.tts); }

  function ttsSyncLight() { var t = $('.tool[data-tool="tts"]'); if (t) t.classList.toggle('on', !!(TR.you.dest.tts || TR.them.dest.tts)); }

  async function ttsSpeak(text, lang) {
    if (!text) return;
    var body = { text: text };
    if (lang && lang !== 'auto') body.lang = String(lang).split('-')[0].toLowerCase();
    if (state.ttsVoice) body.voice = state.ttsVoice;
    if (state.ttsDevice) body.device = state.ttsDevice;
    try { await api.speak(body); } catch (e) {}
  }

  function overlayShowing() { return state.overlaySource !== 'off'; }

  function overlaySourceActive() {
    if (state.overlaySource === 'win_captions') return true;
    if (state.overlaySource === 'you' || state.overlaySource === 'them') return !!state.running[state.overlaySource];
    return false;
  }

  function ccSyncGlow() {
    var t = $('.tool[data-tool="cc"]'); if (t) t.classList.toggle('on', overlayShowing());
  }

  function syncOverlayToSource() {
    if (state.overlaySource !== 'you' && state.overlaySource !== 'them') return;
    var on = !!state.running[state.overlaySource];
    if (on) { try { send({ action: 'set_overlay_owner', slot: state.overlaySource }); } catch (e) {} }
    api.setCaptionsOverlay(on).catch(function () {});
    ccSyncGlow();
  }

  function ccSyncSrcValue() { var sel = $('#cc-src'); if (sel && sel.value !== state.overlaySource) sel.value = state.overlaySource; }

  async function setOverlaySource(val) {
    var sel = $('#cc-src'), note = $('#cc-src-note'), prev = state.overlaySource;
    if (val === 'win_captions' && (!state.ccWinStatus.win_captions_supported || !state.ccWinStatus.win_captions_installed)) {
      state.overlaySource = 'win_captions'; if (sel) sel.value = 'win_captions'; ccApplyWin(); ccSyncGlow(); save(); return;
    }
    state.overlaySource = val; if (sel) sel.value = val;
    var wantSrc = val === 'win_captions' ? 'win_captions' : 'current';
    var hadSrc = prev === 'win_captions' ? 'win_captions' : 'current';
    try {
      if (wantSrc !== hadSrc) {
        if (note) { note.hidden = false; note.textContent = val === 'win_captions' ? 'Starting Windows Live Captions…' : 'Switching to the app engine…'; }
        var res = await api.setCaptionsOverlaySource(wantSrc);
        if (!res.ok) {
          var b = await res.json().catch(function () { return {}; });
          if (note) { note.hidden = false; note.textContent = (b && b.detail) || 'Could not switch source.'; }
          state.overlaySource = prev; if (sel) sel.value = prev; ccApplyWin(); ccSyncGlow(); return;
        }
        if (note) note.hidden = true;
      }
      if (val === 'you' || val === 'them') send({ action: 'set_overlay_owner', slot: val });

      await api.setCaptionsOverlay(overlaySourceActive());
    } catch (e) { if (note) { note.hidden = false; note.textContent = 'Could not reach the app.'; } }
    ccApplyWin(); ccSyncGlow(); save();
  }

  function ccReconcileOverlay() {
    Promise.all([
      api.getCaptionsOverlayState().catch(function () { return null; }),
      api.getCaptionsSourceStatus().catch(function () { return {}; })
    ]).then(function (res) {
      var st = res[0], src = res[1] || {};
      state.ccWinStatus = src.win_captions_present ? src : {};

      if (!st) { ccSyncGlow(); ccSyncSrcValue(); return; }
      if (!st.shown) state.overlaySource = 'off';
      else if (src.source === 'win_captions') state.overlaySource = 'win_captions';
      else if (state.overlaySource !== 'you' && state.overlaySource !== 'them') state.overlaySource = 'them';
      ccSyncGlow(); ccSyncSrcValue(); save();
    }).catch(function () {});
  }

  function emitLine(r, text, when) {
    var el = addFeedLine(r, text, when || new Date());
    var doOsc = !!r && oscOwner === r;
    if (r && TR[r] && TR[r].translate) requestTranslation(text, el, r, doOsc);
    else if (doOsc) sendOsc(text).then(stopOscTyping);

    if (autoSpeakOn(r) && !(TR[r] && TR[r].translate && state.ttsReads === 'translation')) ttsSpeak(text, TR[r] && TR[r].src);
    return el;
  }

  function cleanCommitText(raw, isEnglishSrc) {
    var text = raw ? stripBlockedPhrases(raw, blockedPhrases).text : '';
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
    var p = primarySlot();
    var owner = liveKind || p;
    if (res.dropped) {
      shownChars = latestLineLength; lastCommittedText = raw;
      if (owner && oscOwner === owner) stopOscTyping();
    } else if (text) {
      shownChars = latestLineLength;
      emitLine(owner, text, activeLineTime);
      lastCommittedText = raw;
    }
    activeText = ''; activeLineTime = null;
    if (capturing && p) setListening(p); else setIdle();
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
    var deduped = stripCommittedOverlap(newText, lastCommittedText);

    if (hasRepetition(fullText)) { commitActiveLine(); restartSlot(primarySlot()); return; }
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
        var lvlR = msg.stream;
        if (lvlR !== 'you' && lvlR !== 'them') return;
        var f = $('#tr-' + lvlR + ' .lvl-fill');
        if (f) { f.style.width = Math.round(msg.level * 100) + '%'; f.classList.toggle('gated', !!msg.gated); }
        if (lvlR === 'you') {
          state.lastMicLevel = msg.level;
          var gf = $('#gate-fill');
          if (gf) {
            gf.style.width = Math.round(msg.level * 100) + '%';

            gf.classList.toggle('gated', state.gateDragging ? gatePreviewGated() : !!msg.gated);
          }
        }
        return;
      }
      if (msg.type === 'state') {
        if (capturing) foot(msg.state === 'processing' ? 'Processing…' : 'Listening');
        return;
      }
      if (msg.type === 'capture_ended') {
        var slot = (msg.stream === 'you' || msg.stream === 'them') ? msg.stream : loneSlot();
        if (slot === 'you' || slot === 'them') stopSlot(slot);
        else stopAllSlots();

        userClosing = false;
        return;
      }
      if (msg.type === 'ocr_overlay') {
        state.ocrOverlayOn = !!msg.shown;
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
        if (pendingStart || msg.running) { failStart(msg.error, msg.running); return; }
        foot(msg.error); return;
      }

      if (msg.status === 'slots_set') { pendingStart = false; capturing = true; foot(bothRunning() ? 'Dual: listening' : 'Listening'); return; }
      if (msg.status === 'all_slots_stopped') { capturing = false; return; }

      if (msg.type === 'config') { if (bothRunning()) return; pendingStart = false; capturing = true; foot('Listening'); return; }

      if (msg.stream === 'win_captions') { handleWinFrame(msg); return; }
      if (msg.type === 'translation') { handleWinTranslation(msg); return; }

      if (msg.stream === 'you' || msg.stream === 'them') {
        if (msg.stream === primarySlot()) handleServerMessage(msg);
        else handleBatchFrame(msg);
      } else {
        handleServerMessage(msg);
      }
    });
    ws.addEventListener('close', function () {
      if (userClosing) return;
      var failedStart = false;
      if (pendingStart && ws === sock) { failStart('Lost the connection while starting'); failedStart = true; }
      if (bothRunning()) {
        capturing = false; state.running.you = state.running.them = false; streamSlot = null;
        clearMeters(); refreshStatus(); foot('Disconnected'); setIdle(); return;
      }
      if (!failedStart) foot('Reconnecting…');
      setTimeout(function () {
        ws = null; openWs();
        ws.addEventListener('open', function () {
          var r = loneSlot();

          if (capturing && r) startTransport(r);
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
    var list = r === 'you' ? state.allDevices.mic : state.allDevices.loopback;
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

  async function applyBackendConfig(r) {
    var c = TR[r], dev = deviceFor(r);
    var body = { target_language: c.tgt };
    if (c.source !== 'program') body[c.source === 'mic' ? 'mic_device_name' : 'loopback_device_name'] = c.device;
    try {
      await api.saveConfig(body);
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
      var info = await api.getModels(eng);
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

  function slotsFrame(want) {
    var msg = { action: 'set_slots' };

    if (want.you && want.them && sharedModelPair() && TR.them.model !== TR.you.model) {
      TR.them.model = TR.you.model; renderDrawer('them'); renderStrip('them'); save();
    }
    ['you', 'them'].forEach(function (r) {
      if (!want[r]) return;
      var c = TR[r], dev = deviceFor(r);
      msg[r + '_device']  = isProgram(r) ? null : (dev ? dev.index : null);
      msg[r + '_engine']  = c.engine;
      msg[r + '_lang']    = c.src;
      msg[r + '_model']   = c.model;
      msg[r + '_program'] = isProgram(r) ? c.program : null;
      msg[r + '_is_mic']  = (c.source === 'mic') && !isProgram(r);
    });
    return msg;
  }

  function startTransport(r) {
    var dev = deviceFor(r);
    if (!isProgram(r) && !dev) { foot('No ' + (r === 'you' ? 'microphone' : 'desktop') + ' device'); return; }
    var gen = ++startGen;
    return activate(gen, async function () {
      if (!(await ensureEngineModel(TR[r]))) { setIdle(); return; }
      if (gen !== startGen) return;
      await loadDevices();
      if (gen !== startGen) return;
      userClosing = false;

      state.running.you = state.running.them = false; state.running[r] = true; streamSlot = null;
      resetOffsets(); clearMeters(); refreshStatus(); foot('Connecting…');
      setPreparing('Starting engine…'); startStartupPoll();
      pendingStart = true;
      openWs();
      await applyBackendConfig(r);
      if (gen !== startGen) return;

      var want = {}; want[r] = true;
      var step = await sendAwait(slotsFrame(want), ['slots_set']);
      if (step.error || gen !== startGen) return;
      if (step.timeout) { failStart('Capture did not start'); return; }
      setListening(r);
      if (state.overlaySource === r) setOverlaySource(r);
    });
  }

  async function applyIfLive(r) {
    if (!state.running[r]) return;
    var c = TR[r], dev = deviceFor(r);
    if (!isProgram(r) && !dev) return;
    var gen = ++startGen;
    return activate(gen, async function () {
      if (!(await ensureEngineModel(c))) return;
      if (gen !== startGen) return;
      await loadDevices();
      if (gen !== startGen) return;
      await applyBackendConfig(r);
      if (gen !== startGen) return;
      if (primarySlot() === r) {
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        commitActiveLine(); resetOffsets();
      }
      pendingStart = true; capturing = false;
      if (!bothRunning()) setPreparing('Starting engine…');
      startStartupPoll();
      var step = await sendAwait(slotsFrame(state.running), ['slots_set']);
      if (step.error || gen !== startGen) return;
      if (step.timeout) { failStart('Capture did not restart'); return; }

      if (bothRunning()) {
        streamSlot = STREAM_ENGINES[TR.you.engine] ? 'you' : (STREAM_ENGINES[TR.them.engine] ? 'them' : null);
        if (streamSlot) setListening(streamSlot); else setSlotsListening();
      } else {
        streamSlot = null; setListening(r);
      }
      syncOverlayToSource();
    });
  }

  var lastSlotRestart = 0;

  function restartSlot(r) {
    if (!r) return;
    var now = Date.now();
    if (now - lastSlotRestart < 2500) return;
    lastSlotRestart = now;
    resetOffsets();
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { send({ action: 'restart_slot', slot: r }); } catch (e) {}
    }
  }

  var BATCH_ENGINES = { nano: true, qwen3: true, parakeet: true, 'whisper-batch': true };
  var STREAM_ENGINES = { whisper: true, 'parakeet-stream': true, 'nemotron-stream': true };
  var streamSlot = null;

  function concurrentCapable(e) { return !!(BATCH_ENGINES[e] || STREAM_ENGINES[e]); }

  var MODEL_LOCK_ENGINES = { 'whisper-batch': true };

  function sharedModelPair() {
    return !!TR.you.engine && TR.you.engine === TR.them.engine && !!MODEL_LOCK_ENGINES[TR.you.engine];
  }
  function sharedModelBoth() { return bothRunning() && sharedModelPair(); }
  function isWhisper(e) { return e === 'whisper' || e === 'whisper-batch'; }

  function canRunBoth() {
    var eu = TR.you.engine, et = TR.them.engine;
    var nStream = (STREAM_ENGINES[eu] ? 1 : 0) + (STREAM_ENGINES[et] ? 1 : 0);

    if (isWhisper(eu) && isWhisper(et) && eu !== et) return false;
    return concurrentCapable(eu) && concurrentCapable(et) && nStream <= 1;
  }

  function setSlotsListening() {
    liveKind = null; live.className = 'current';

    var lone = loneSlot();
    liveWho.textContent = lone ? (lone === 'you' ? 'You' : 'Them') : 'Dual';
    liveO.textContent = 'Listening'; liveO.classList.remove('capcursor');
    showLiveLine(false);
  }

  function startBoth() {
    var youDev = deviceFor('you'), themDev = deviceFor('them');
    if (!youDev || (!themDev && !isProgram('them'))) { foot('Dual needs a microphone and a desktop device'); return; }
    var gen = ++startGen;
    return activate(gen, async function () {
    if (!(await ensureEngineModel(TR.you)) || !(await ensureEngineModel(TR.them))) { setIdle(); return; }
    if (gen !== startGen) return;
    await loadDevices();
    if (gen !== startGen) return;
    userClosing = false;

    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    var preRunning = { you: state.running.you, them: state.running.them };
    var wasLive = preRunning.you || preRunning.them;
    state.running.you = state.running.them = true;

    streamSlot = STREAM_ENGINES[TR.you.engine] ? 'you'
               : (STREAM_ENGINES[TR.them.engine] ? 'them' : null);

    var keptStream = wasLive && streamSlot && preRunning[streamSlot];
    if (!keptStream) resetOffsets();
    if (!wasLive) { capturing = false; clearMeters(); }

    var heavy = ['whisper', 'whisper-batch', 'qwen3'];
    var slow = heavy.indexOf(TR.you.engine) >= 0 || heavy.indexOf(TR.them.engine) >= 0;
    refreshStatus();
    foot(slow ? 'Dual: loading model, this can take up to a minute…' : 'Dual: starting…');
    pendingStart = true;
    openWs();
    syncOverlayToSource();
    if (streamSlot) setListening(streamSlot); else setSlotsListening();
    var step = await sendAwait(slotsFrame({ you: true, them: true }), ['slots_set']);
    if (step.error || gen !== startGen) return;
    if (step.timeout) failStart('Capture did not start');
    });
  }

  function failStart(reason, running) {
    pendingStart = false;
    startGen++;
    stopStartupPoll();
    var live = Array.isArray(running) ? running : null;
    if (live && live.length) {
      ['you', 'them'].forEach(function (r) { if (state.running[r] && live.indexOf(r) < 0) stopSlot(r); });
      capturing = true;
      if (!streamSlot) setSlotsListening();
      refreshStatus();
    } else {
      if (ws && ws.readyState === WebSocket.OPEN) { try { send({ action: 'stop_all_slots' }); } catch (e) {} }
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      capturing = false; streamSlot = null;
      state.running.you = state.running.them = false;
      resetOffsets(); clearMeters(); refreshStatus(); setIdle();
    }
    foot(reason || 'Could not start');
    toast('warn', '', reason || 'Could not start.');
  }

  function stopAllSlots() {
    userClosing = true; pendingStart = false; startGen++; capturing = false;
    if (ws && ws.readyState === WebSocket.OPEN) { try { send({ action: 'stop_all_slots' }); } catch (e) {} }
    state.running.you = state.running.them = false; streamSlot = null;
    syncOverlayToSource();
    clearMeters(); refreshStatus(); foot('Stopped'); setIdle();
  }

  function stopSlot(r) {
    var other = r === 'you' ? 'them' : 'you';
    var wasPrimary = (primarySlot() === r);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { send({ action: 'stop_slot', slot: r }); } catch (e) {}
    }
    state.running[r] = false;
    var f = $('#tr-' + r + ' .lvl-fill');
    if (f) { f.style.width = '0%'; f.classList.remove('gated'); }
    if (r === streamSlot) streamSlot = null;
    if (wasPrimary) {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      commitActiveLine();
      resetOffsets();
    }
    if (state.running[other]) {
      if (r === state.overlaySource) syncOverlayToSource();
      if (!streamSlot) setSlotsListening();
      refreshStatus(); foot((r === 'you' ? 'You' : 'Them') + ' stopped');
    } else {
      stopAllSlots();
    }
  }

  var slotLastCommitted = { you: '', them: '' };

  function handleBatchFrame(data) {
    var r = data.stream;
    if (r !== 'you' && r !== 'them') return;
    var lines = Array.isArray(data.lines) ? data.lines : [];
    var visible = lines.filter(function (l) { return l.speaker !== -2 && (l.text || '').trim(); });
    var latest = visible[visible.length - 1];
    if (!latest) return;
    var full = latest.text.trim();
    if (!full || /^[。．？！?!.,\s]+$/.test(full)) return;
    if (typeof data.decode_ms === 'number') { latency.stt = data.decode_ms; renderLatency(); }

    if (hasRepetition(full)) { slotLastCommitted[r] = ''; return; }

    var deduped = stripCommittedOverlap(full, slotLastCommitted[r]);
    slotLastCommitted[r] = full;
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
      var other = r === 'you' ? 'them' : 'you';

      if (state.running[r]) { stopSlot(r); return; }

      if (state.running[other]) {
        if (canRunBoth()) { startBoth(); return; }

        var twoWhisper = isWhisper(TR.you.engine) && isWhisper(TR.them.engine) && TR.you.engine !== TR.them.engine;
        var twoStream = STREAM_ENGINES[TR.you.engine] && STREAM_ENGINES[TR.them.engine];

        var pairList = function (skipWhisper) {
          var names = Object.keys(BATCH_ENGINES)
            .filter(function (id) { return engById(id) && !(skipWhisper && isWhisper(id)); })

            .map(function (id) { return id === 'whisper-batch' ? 'Whisper (accurate)' : engShort(id); });

          if (names.length < 2) return names.join('');
          if (names.length === 2) return names.join(' or ');
          return names.slice(0, -1).join(', ') + ', or ' + names[names.length - 1];
        };
        var why = twoWhisper
          ? 'Running both Whisper engines at once loads the model twice. Use two Whisper (accurate), or pair one with ' + pairList(true) + '.'
          : twoStream
          ? 'Only one streaming engine can run at a time; pair it with ' + pairList(false) + '.'
          : 'To run both at once, pair a streaming engine with ' + pairList(false) + '.';

        dialog({
          k: 'Cannot run both',
          h: 'These two engines cannot run at the same time',
          p: escHtml(why) + '<br><br>Now: <b>' + escHtml(engName(TR.you.engine)) + '</b> + <b>'
             + escHtml(engName(TR.them.engine)) + '</b>.',

          ok: 'Run "' + (r === 'you' ? 'You' : 'Them') + '" only',
          cancel: 'Cancel'
        }).then(function (go) { if (go) startTransport(r); });
        return;
      }

      startTransport(r);
    });
  });

  function positionDrawer() { drawer.style.top = (strip.offsetTop + strip.offsetHeight) + 'px'; }

  function toggleCell(r) {
    closePop(); positionDrawer();
    var cell = $('#dc-' + r), tr = $('#tr-' + r);
    var open = cell.classList.toggle('open');
    tr.classList.toggle('open', open); tr.setAttribute('aria-expanded', open);
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
        c.model = (state.engineInfo.engine_models && state.engineInfo.engine_models[e.id]) || e.default_model || e.models[0] || '';
        if (e.languages.indexOf(c.src) < 0) c.src = e.languages[0] || 'auto';
      }

      if (sharedModelBoth()) TR.them.model = TR.you.model;
      renderDrawer('you'); renderDrawer('them'); renderStrip(r); save(); applyIfLive(r);
    });
    mdlSel.addEventListener('change', function () {
      c.model = mdlSel.value;

      if (sharedModelBoth()) { TR.them.model = c.model; renderDrawer('them'); renderStrip('them'); }
      renderStrip(r); save(); applyIfLive(r);
    });
    srcSel.addEventListener('change', function () { c.src = srcSel.value; renderStrip(r); save(); applyIfLive(r); });
    tgtSel.addEventListener('change', function () {
      c.tgt = tgtSel.value; renderStrip(r); save();

      if (!bothRunning() && state.running[r]) applyBackendConfig(r);
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
      renderStrip(r); save(); applyIfLive(r);
    });

    devSel.addEventListener('mousedown', function () { loadDevices(); if (r === 'them') loadPrograms(); });
    xt.addEventListener('click', function (e) {
      e.stopPropagation();
      c.translate = xt.getAttribute('aria-pressed') !== 'true';
      xt.setAttribute('aria-pressed', c.translate); xt.textContent = c.translate ? 'On' : 'Off';
      $('.xlate', dc).classList.toggle('off', !c.translate);
      renderStrip(r); save();
    });

    sw.addEventListener('click', function (e) {
      e.stopPropagation();
      var newTgt = transSrc(c.src);
      var newSrc = (c.tgt || '').split('-')[0];
      var e2 = engById(c.engine);
      var srcOk = e2 && e2.languages.indexOf(newSrc) >= 0;
      var tgtOk = targetLangOpts().some(function (t) { return t.v === newTgt; });
      if (!srcOk || !tgtOk) return;
      c.src = newSrc; c.tgt = newTgt;
      renderDrawer(r); renderStrip(r); save(); applyIfLive(r);
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

  function applyFilter(el) { el.style.display = (state.filter === 'all' || state.filter === el.dataset.kind) ? '' : 'none'; }
  $$('[data-f]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      state.filter = b.dataset.f;
      $$('[data-f]').forEach(function (x) { x.setAttribute('aria-pressed', x.dataset.f === state.filter); });
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
    scheduleServerSave();
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

  initSettings({
    renderAll: renderAll, renderDrawer: renderDrawer, renderStrip: renderStrip,
    setOverlaySource: setOverlaySource, applyIfLive: applyIfLive,
    ccSyncGlow: ccSyncGlow, loadPrograms: loadPrograms, save: save, TR: TR,
    reportTtsLatency: function (ms) { latency.tts = ms; renderLatency(); },
  });

  initWizard({ TR: TR, save: save, renderAll: renderAll, srcLangOpts: srcLangOpts });

  feed.innerHTML = EMPTY;
  try { setReading(localStorage.getItem('v2Reading') || 'off'); } catch (e) { setReading('off'); }

  api.getLangJson()
    .then(setLangData).catch(function () {})
    .then(async function () {
      loadStored();
      renderAll();
      ccPopulateWinPickers();
      ttsSyncLight();
      openWs();

      await loadBackend();
      ccReconcileOverlay();
    });
})();
