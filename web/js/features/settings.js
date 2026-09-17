import { $, $$, escHtml, label } from '../lib/util.js';
import { state } from '../lib/state.js';
import * as api from '../lib/api.js';
import { dialog, toast, setTog, togState, closePop, closeDrawer, closeMenus, openMenu } from '../lib/ui.js';
import { targetLangOpts, tgtName } from '../core/lang.js';
import { engById, engName, engRank } from '../core/engines.js';

let host = null;
export function initSettings(h) { host = h; }

  $$('.menu').forEach(function (m) { m.addEventListener('click', function (e) { e.stopPropagation(); }); });
  $$('.menu [data-close]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); closeMenus(); }); });
  var menuBackdrop = $('#menu-backdrop');
  if (menuBackdrop) menuBackdrop.addEventListener('click', closeMenus);
  document.addEventListener('click', closeMenus);

  var ccMenu = $('#cc-menu'), ccTool = $('.tool[data-tool="cc"]');

  async function ccOverlayPref(kind, on) {
    try { await api.setCaptionsOverlayPref(kind, on); } catch (e) {}
  }

  function ccPickNum(sel, v, dflt) {
    if (!sel) return;
    var want = parseFloat(v); if (!(want > 0)) want = dflt;
    for (var i = 0; i < sel.options.length; i++) {
      if (parseFloat(sel.options[i].value) === want) { sel.selectedIndex = i; return; }
    }
    sel.value = String(dflt);
  }
  if (ccTool) ccTool.addEventListener('click', function (e) {
    e.stopPropagation();
    openMenu(ccMenu, ccTool);
    if (!ccMenu.hasAttribute('data-open')) return;
    api.getCaptionsOverlayState().then(function (s) {
      setTog($('#cc-blur'), !!s.blur); setTog($('#cc-pos'), !!s.pos_color);
      var rd = $('#cc-reading'); if (rd) rd.value = s.reading || 'off';
      $('#cc-show').value = s.show || 'both';
      $('#cc-maxlines').value = String(s.max_lines || 0);

      ccPickNum($('#cc-textsize'), s.text_scale, 1);
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
    var opts = targetLangOpts(backend || state.translateBackend);
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

  function ccApplyWin() {
    var sel = $('#cc-src'), isWin = sel && sel.value === 'win_captions';
    var sec = $('#cc-win-sec'), note = $('#cc-src-note'), manage = $('#cc-win-manage'), mbtn = $('#cc-win-btn');
    if (!isWin) { if (sec) sec.hidden = true; ccShowWinOpts(false); if (note) note.hidden = true; if (manage) manage.hidden = true; return; }
    if (sec) sec.hidden = false;
    if (!state.ccWinStatus.win_captions_supported) {
      ccShowWinOpts(false); manage.hidden = true;
      note.hidden = false; note.innerHTML = 'Windows Live Captions needs <b>Windows 11 22H2+</b>.';
      return;
    }
    manage.hidden = false; mbtn.disabled = false;
    if (!state.ccWinStatus.win_captions_installed) {
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
      var s = await api.getCaptionsSourceStatus();
      if (!s.win_captions_present) { state.ccWinStatus = {}; if (winOpt) winOpt.hidden = true; }
      else { state.ccWinStatus = s; if (winOpt) { winOpt.hidden = false; winOpt.disabled = false; } }
    } catch (e) { state.ccWinStatus = {}; if (winOpt) winOpt.hidden = true; }
    if (sel) sel.value = state.overlaySource;
    ccApplyWin();
    api.getConfig().then(function (c) {
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
  if (ccSrc) ccSrc.addEventListener('change', function (e) { e.stopPropagation(); host.setOverlaySource(this.value); });

  function ccSaveWin(patch) {
    api.saveConfig(patch).catch(function () {});
  }
  if ($('#cc-win-tgt')) $('#cc-win-tgt').addEventListener('change', function (e) { e.stopPropagation(); ccSaveWin({ win_captions_target: this.value }); });
  if ($('#cc-win-backend')) $('#cc-win-backend').addEventListener('change', function (e) {
    e.stopPropagation(); ccSaveWin({ win_captions_backend: this.value });
    ccFillWinTgt(this.value, $('#cc-win-tgt') ? $('#cc-win-tgt').value : '');
  });
  if ($('#cc-win-transcript')) $('#cc-win-transcript').addEventListener('click', function (e) { e.stopPropagation(); var on = !togState(this); setTog(this, on); ccSaveWin({ win_captions_to_transcript: on }); });

  async function ccWinInstall() {
    if (engBusy) return; engBusy = true; var b = $('#cc-win-btn'); b.disabled = true; var p = $('#cc-win-prog'); p.hidden = false; p.textContent = 'Installing…';
    try { await api.installEngine('win_captions'); }
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
    try { await api.setCaptionsOverlaySource('current'); } catch (e) {}
    state.overlaySource = 'off';
    try { await api.setCaptionsOverlay(false); } catch (e) {}
    try { await api.removeEngine('win_captions'); } catch (e) {}
    engBusy = false; host.ccSyncGlow(); host.save(); ccLoadSource();
  }
  $('#cc-blur').addEventListener('click', function (e) {
    e.stopPropagation(); var on = !togState(this); setTog(this, on); ccOverlayPref('blur', on);
  });
  $('#cc-pos').addEventListener('click', function (e) {
    e.stopPropagation(); var on = !togState(this); setTog(this, on); ccOverlayPref('poscolor', on);
  });
  $('#cc-reading').addEventListener('change', function (e) {
    e.stopPropagation();
    api.setCaptionsOverlayReading(this.value).catch(function () {});
  });

  $('#cc-show').addEventListener('change', function (e) {
    e.stopPropagation();
    api.setCaptionsOverlayContent(this.value).catch(function () {});
  });
  $('#cc-maxlines').addEventListener('change', function (e) {
    e.stopPropagation();
    api.setCaptionsOverlayMaxLines(parseInt(this.value, 10)).catch(function () {});
  });
  $('#cc-textsize').addEventListener('change', function (e) {
    e.stopPropagation();
    api.setCaptionsOverlayTextScale(parseFloat(this.value)).catch(function () {});
  });

  var ttsMenu = $('#tts-menu'), ttsTool = $('.tool[data-tool="tts"]');
  var ttsByKey = {};
  var ttsIdToKey = {};

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
    try { d = await api.getTtsDevices(); } catch (e) { return; }
    var sel = $('#tts-device');
    sel.innerHTML = '<option value="">System default</option>' + (d.devices || []).map(function (x) {
      return '<option value="' + escHtml(x.name) + '">' + escHtml(x.name) + (x.cable ? '  ← VB-Cable' : '') + '</option>';
    }).join('');
    var cable = (d.devices || []).filter(function (x) { return x.cable; })[0];
    var saved = (d.devices || []).filter(function (x) { return x.name === d.selected; })[0];
    sel.value = saved ? saved.name : (cable ? cable.name : '');
    state.ttsDevice = sel.value;

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
    try { s = await api.getTtsStatus(); }
    catch (e) { $('#tts-starting').textContent = 'Error contacting the app.'; ttsShow('starting'); return; }
    if (!s.installed) { ttsShow('install'); return; }
    $('#tts-voice').innerHTML = ttsBuildVoices(s.packs || []);
    var sv = String(s.selected_voice || '');
    var key = ttsIdToKey[sv] || ($('#tts-voice').options[0] || {}).value || '';
    if (key) $('#tts-voice').value = key;
    ttsPopulateStyles($('#tts-voice').value);
    var c = ttsByKey[$('#tts-voice').value];
    if (c && c.styles && c.styles.some(function (st) { return st.id === sv; })) $('#tts-style').value = sv;
    state.ttsVoice = ttsCurrentVoiceId();
    ttsUpdateCredit();
    await ttsLoadDevices();
    $('#tts-reads').value = state.ttsReads;
    ttsShow('form');
  }

  function ttsSelect(patch) {
    api.selectTts(patch).catch(function () {});
  }
  if (ttsTool) ttsTool.addEventListener('click', function (e) {
    e.stopPropagation();
    openMenu(ttsMenu, ttsTool);
    if (ttsMenu.hasAttribute('data-open')) ttsRefresh();
  });
  $('#tts-voice').addEventListener('change', function () {
    ttsPopulateStyles(this.value); ttsUpdateCredit();
    state.ttsVoice = ttsCurrentVoiceId(); ttsSelect({ voice: state.ttsVoice });
  });
  $('#tts-style').addEventListener('change', function () {
    ttsUpdateCredit(); state.ttsVoice = ttsCurrentVoiceId(); ttsSelect({ voice: state.ttsVoice });
  });
  $('#tts-device').addEventListener('change', function () { state.ttsDevice = this.value; ttsSelect({ device: this.value }); });
  $('#tts-monitor').addEventListener('change', function () { ttsSelect({ monitor: this.value }); });
  $('#tts-passthru').addEventListener('click', function (e) {
    e.stopPropagation();
    var on = !togState(this); setTog(this, on);
    var self = this;
    api.setTtsPassthru(on)
      .then(function (r) { return r.json(); }).then(function (d) {
        if (on && d && d.active === false) { setTog(self, false); $('#tts-status').textContent = 'Could not start mic passthru (check the mic/cable device).'; }
      }).catch(function () { setTog(self, !on); });
  });
  $('#tts-reads').addEventListener('change', function () { state.ttsReads = this.value; });
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
      var typedLang = (host.TR.you && host.TR.you.src) || '';
      var res = await api.speak({ text: text, voice: ttsCurrentVoiceId(), speed: parseFloat($('#tts-speed').value),
        device: $('#tts-device').value, monitor: $('#tts-monitor').value,
        lang: typedLang === 'auto' ? '' : typedLang });
      var data = await res.json().catch(function () { return {}; });
      $('#tts-status').textContent = res.ok ? ('Played ' + (data.duration || 0).toFixed(2) + 's of audio.') : ('Error: ' + (data.detail || res.status));
      if (res.ok && typeof data.gen_ms === 'number') { host.reportTtsLatency(data.gen_ms); }
    } catch (err) { $('#tts-status').textContent = 'Error: ' + err.message; }
    finally { btn.disabled = false; }
  }
  $('#tts-say').addEventListener('click', function (e) { e.stopPropagation(); ttsPlay(); });
  $('#tts-stop').addEventListener('click', function (e) { e.stopPropagation(); api.stopTts().catch(function () {}); });

  async function setOcrOverlay(on) {
    try {
      await api.setScreenOverlay(on);
      state.ocrOverlayOn = on;
      var t = $('.tool[data-tool="ocr"]'); if (t) t.setAttribute('aria-pressed', on ? 'true' : 'false');
    } catch (e) {}
  }
  var ocrTool = $('.tool[data-tool="ocr"]');
  if (ocrTool) ocrTool.addEventListener('click', async function (e) {
    e.stopPropagation(); closeMenus();
    if (!state.ocrOverlayOn) {
      var st = {}; try { st = await api.getOcrStatus(); } catch (err) {}
      if (!st.installed) {
        toast('warn', 'Not installed', "Screen OCR isn't installed yet.",
              { label: 'Open Settings', onClick: function () { openSettings('ocr'); } });
        return;
      }
    }
    setOcrOverlay(!state.ocrOverlayOn);
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
      api.saveConfig({ prompt_presets: psetUser, default_prompt_preset: psetActive })
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
    var cfg = {}; try { cfg = await api.getConfig(); } catch (e) { return; }
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

  var SECTION_LOADERS = { engines: setLoadEngines, translation: setLoadTranslation, audio: setLoadAudio, vrchat: setLoadVrchat, phrases: setLoadPhrases, voices: setLoadVoices, dictionary: setLoadDictionary, ocr: setLoadOcr, about: setLoadAbout };

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
    var cfg = {}; try { cfg = await api.getConfig(); } catch (e) { return; }
    var g = $('#set-gate'); g.value = Math.round((cfg.min_sound_level || 0) * 100); $('#set-gate-val').textContent = g.value + '%'; gateWarn();
    var p = $('#set-phrase'); p.value = cfg.stt_max_phrase_s || 12; $('#set-phrase-val').textContent = p.value + 's';

    var perappRow = $('#srow-perapp');
    if (perappRow) perappRow.hidden = !cfg.program_capture_supported;
    setTog($('#set-perapp'), !!cfg.program_capture_enabled);
  }

  function setSaveCfg(patch) { api.saveConfig(patch).catch(function () {}); }

  function gatePreviewGated() { var t = (+$('#set-gate').value) / 100; return t > 0 && state.lastMicLevel < t; }
  function gatePreview() { var gf = $('#gate-fill'); if (gf) gf.classList.toggle('gated', gatePreviewGated()); }

  function gateWarn() { var w = $('#set-gate-warn'); if (w) w.classList.toggle('show', (+$('#set-gate').value) > 0); }
  $('#set-gate').addEventListener('input', function () { $('#set-gate-val').textContent = this.value + '%'; state.gateDragging = true; gatePreview(); gateWarn(); });
  $('#set-gate').addEventListener('change', function () { state.gateDragging = false; setSaveCfg({ min_sound_level: (+this.value) / 100 }); });
  $('#set-phrase').addEventListener('input', function () { $('#set-phrase-val').textContent = this.value + 's'; });
  $('#set-phrase').addEventListener('change', function () { setSaveCfg({ stt_max_phrase_s: +this.value }); });
  $('#set-mute-sup').addEventListener('click', function () { var on = !togState(this); setTog(this, on); setSaveCfg({ suppress_osc_when_muted: on }); });
  $('#set-perapp').addEventListener('click', function () {
    var on = !togState(this); setTog(this, on); setSaveCfg({ program_capture_enabled: on });

    if (!on && host.TR.them.source === 'program') {
      host.TR.them.source = 'loopback'; host.TR.them.program = '';
      host.renderDrawer('them'); host.renderStrip('them'); host.save(); host.applyIfLive('them');
    }
    host.loadPrograms();
  });

  async function setLoadVrchat() {
    var cfg = {}; try { cfg = await api.getConfig(); } catch (e) { return; }

    state.oscChatbox = cfg.osc_chatbox || 'original_first';
    $('#set-osc-chatbox').value = state.oscChatbox;
    setTog($('#set-mute-sup'), cfg.suppress_osc_when_muted !== false);
  }

  $('#set-osc-chatbox').addEventListener('change', function () {
    state.oscChatbox = this.value;
    setSaveCfg({ osc_chatbox: this.value });
  });

  async function setLoadPhrases() {
    var cfg = {}; try { cfg = await api.getConfig(); } catch (e) { return; }
    $('#set-blocked').value = (cfg.blocked_phrases || []).join('\n');
    setTog($('#set-discard'), !!cfg.discard_other_alphabets);
  }
  $('#set-blocked').addEventListener('change', function () {
    var list = this.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    setSaveCfg({ blocked_phrases: list });
  });
  $('#set-discard').addEventListener('click', function () { var on = !togState(this); setTog(this, on); setSaveCfg({ discard_other_alphabets: on }); });

  async function setLoadAbout() {
    try { var j = await api.getVersion(); $('#set-version').textContent = j && j.version ? 'v' + j.version : '-'; } catch (e) { $('#set-version').textContent = '-'; }
  }
  $('#set-update-check').addEventListener('click', async function () {
    var note = $('#set-update-note'); note.textContent = 'Checking…';
    try {
      var j = await api.checkUpdate(true);
      note.textContent = j.update_available ? ('Update available: v' + j.latest + ' (you have v' + j.current + ')') : 'You are up to date.';
    } catch (e) { note.textContent = 'Could not check.'; }
  });
  $('#set-shortcut').addEventListener('click', async function () {
    var note = $('#set-shortcut-note');
    note.textContent = 'Creating…';
    try {
      var r = await api.createShortcut();
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
    var cfg = {}; try { cfg = await api.getConfig(); } catch (e) { return; }
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
      var j = await api.getLmstudioModels(url);
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
    state.translateBackend = this.value;
    ['you', 'them'].forEach(function (r) { host.renderDrawer(r); });
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
        var s = {}; try { s = await api.getInstallStatus(); } catch (e) {}
        if (onProg) onProg(s);
        if (s.done || s.error) { clearInterval(t); res(s); }
      }, 800);
    });
  }

  async function setLoadEngines() {
    var wrap = $('#set-eng-list');
    var data; try { data = await api.getEngines(); } catch (e) { wrap.innerHTML = '<div class="snote">Could not load engines.</div>'; return; }
    wrap.innerHTML = '';

    (data.engines || []).slice()
      .sort(function (a, b) { return engRank(a.id) - engRank(b.id) || a.name.localeCompare(b.name); })
      .forEach(function (e) { wrap.appendChild(engCard(e)); });
    var free = null;
    for (var i = 0; i < (data.engines || []).length; i++) {
      if (data.engines[i].installed) {
        try { var m = await api.getModels(data.engines[i].id); free = m.disk_free_bytes; } catch (e) {}
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
    try { state.engineInfo = await api.getEngines(); } catch (e) { return; }
    host.renderAll();
  }

  async function engInstall(e, btn, prog) {
    engBusy = true; btn.disabled = true; prog.hidden = false; prog.textContent = 'Starting install…';
    try { await api.installEngine(e.id); }
    catch (err) { prog.textContent = 'Could not start install.'; engBusy = false; btn.disabled = false; return; }
    watchEngineJob(e.id);
  }

  async function engUninstall(e, btn, prog) {
    if (!(await dialog({ k: 'Uninstall', h: 'Uninstall ' + e.name + '?', p: 'Downloaded models are kept. You can reinstall the engine any time.', ok: 'Uninstall', cancel: 'Cancel', danger: true }))) return;
    engBusy = true; btn.disabled = true; prog.hidden = false; prog.textContent = 'Removing…';
    try { await api.removeEngine(e.id); } catch (err) {}
    engBusy = false; setLoadEngines(); refreshEnginesEverywhere();
  }

  var SHARED_MODELS = { 'whisper': 'whisper-batch', 'whisper-batch': 'whisper', 'parakeet': 'parakeet-stream', 'parakeet-stream': 'parakeet' };

  async function engLoadModels(e, box) {
    var m; try { m = await api.getModels(e.id); } catch (err) { return; }
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
      var resp = await api.downloadModel(e.id, md.id);
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
    try { res = await api.deleteModel(e.id, md.id); }
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
    var st = {}; try { st = await api.getLangStatus(); } catch (e) { return; }
    var b = $('#set-lang-btn'); b.disabled = false; b.classList.toggle('warn', st.installed);
    b.textContent = st.installed ? 'Remove' : 'Download';
    b.onclick = st.installed ? langRemove : langDownload;
    $('#set-tok').hidden = !st.installed;
    if (st.installed) {
      var tk = {}; try { tk = await api.getTokenizer(); } catch (e) {}
      $('#set-tok-sel').value = tk.enabled ? 'hi' : 'std';
      $('#set-tok-remove-row').hidden = !tk.available;
    }
  }

  function jadictChanged() {
    var j = window.jadict;
    if (!j) return;
    try { j.refresh(); } catch (e) {}
    try { j.tokenizerChanged(); } catch (e) {}
  }

  async function langDownload() {
    if (engBusy) return; engBusy = true; var b = $('#set-lang-btn'); b.disabled = true; var p = $('#set-lang-prog'); p.hidden = false; p.textContent = 'Downloading…';
    try {
      var resp = await api.downloadLang();
      if (!resp.ok) { var detail = ''; try { detail = (await resp.json()).detail; } catch (e2) {} p.textContent = detail || 'Failed to start.'; engBusy = false; b.disabled = false; return; }
    } catch (e) { p.textContent = 'Failed to start.'; engBusy = false; b.disabled = false; return; }
    var s = await pollInstall(function (st) { p.textContent = (st.detail || st.phase || 'Downloading') + '…'; });
    engBusy = false; p.hidden = true;
    if (s.error) { p.hidden = false; p.textContent = 'Failed: ' + s.error; }
    setLoadDictionary(); jadictChanged();
  }

  async function langRemove() {
    if (!(await dialog({ k: 'Remove', h: 'Remove the dictionary data?', p: 'Frees about <b>63 MB</b>. You can download it again later.', ok: 'Remove', cancel: 'Cancel', danger: true }))) return;
    engBusy = true; try { await api.removeLang(); } catch (e) {} engBusy = false; setLoadDictionary(); jadictChanged();
  }

  function pollTok(onProg) {
    return new Promise(function (res) {
      var t = setInterval(async function () {
        var s = {}; try { s = await api.getTokenizer(); } catch (e) {}
        if (onProg) onProg(s);
        if (!s.downloading) { clearInterval(t); res(s); }
      }, 800);
    });
  }
  $('#set-tok-sel').addEventListener('change', async function () {
    var v = this.value, p = $('#set-tok-prog');
    if (v === 'std') { try { await api.enableTokenizer(false); } catch (e) {} setLoadDictionary(); jadictChanged(); return; }
    var tk = {}; try { tk = await api.getTokenizer(); } catch (e) {}
    if (tk.available) { try { await api.enableTokenizer(true); } catch (e) {} setLoadDictionary(); jadictChanged(); return; }
    p.hidden = false; p.textContent = 'Downloading Sudachi…';
    try { await api.downloadTokenizer(); } catch (e) { p.textContent = 'Failed to start.'; return; }
    await pollTok(function (s) { p.textContent = 'Downloading Sudachi… ' + Math.round((s.progress || 0) * 100) + '%'; });
    p.hidden = true; setLoadDictionary(); jadictChanged();
  });
  $('#set-tok-remove').addEventListener('click', async function () {
    if (!(await dialog({ k: 'Remove', h: 'Remove the high-accuracy word splitting?', p: 'Frees about <b>215 MB</b> of Sudachi data. Word splitting falls back to the built-in tokenizer.', ok: 'Remove', cancel: 'Cancel', danger: true }))) return;
    try { await api.removeTokenizer(); } catch (e) {} setLoadDictionary(); jadictChanged();
  });

  async function setLoadOcr() {
    var st = {}; try { st = await api.getOcrStatus(); } catch (e) { return; }
    var b = $('#set-ocr-btn'); b.disabled = false; b.classList.toggle('warn', st.installed);
    b.textContent = st.installed ? 'Uninstall' : 'Install';
    b.onclick = st.installed ? ocrRemove : ocrInstall;
  }

  async function ocrInstall() {
    if (engBusy) return; engBusy = true; var b = $('#set-ocr-btn'); b.disabled = true; var p = $('#set-ocr-prog'); p.hidden = false; p.textContent = 'Installing…';
    try { await api.installEngine('ocr'); } catch (e) { p.textContent = 'Failed to start.'; engBusy = false; b.disabled = false; return; }
    var s = await pollInstall(function (st) { p.textContent = (st.detail || st.phase || 'Installing') + '…'; });
    engBusy = false; p.hidden = true;
    if (s.error) { p.hidden = false; p.textContent = 'Failed: ' + s.error; setLoadOcr(); return; }
    try { await api.startOcr(); } catch (e) {}
    setLoadOcr();
  }

  async function ocrRemove() {
    if (!(await dialog({ k: 'Uninstall', h: 'Uninstall Screen OCR?', p: 'Frees about <b>700 MB</b>. You can reinstall it any time.', ok: 'Uninstall', cancel: 'Cancel', danger: true }))) return;
    engBusy = true;
    try { await api.stopOcr(); await api.removeEngine('ocr'); } catch (e) {}
    engBusy = false; setLoadOcr();
  }

  var ttsChars = [];

  async function setLoadVoices() {
    var wrap = $('#set-tts-list');
    var st = {}; try { st = await api.getTtsStatus(); } catch (e) { wrap.innerHTML = '<div class="snote">Could not load voices.</div>'; return; }
    wrap.innerHTML = '';
    (st.packs || []).forEach(function (p) { wrap.appendChild(ttsPackCard(p, st.vc_runtime || {})); });

    var cat = {}; try { cat = await api.getTtsCatalog(); } catch (e) {}
    $('#set-tts-cat').hidden = !cat.engine_installed;
    if (cat.engine_installed) { ttsChars = cat.characters || []; ttsRenderChars(); }
  }

  function packLangTag(langs) {
    var real = (langs || []).filter(function (c) { return c !== 'auto'; });
    if (!real.length) return null;
    var tg = document.createElement('span'); tg.className = 'etag';
    tg.textContent = real.length <= 4 ? real.join(', ')
      : real.slice(0, 3).join(', ') + ' +' + (real.length - 3);
    if (real.length > 4) tg.title = real.join(', ');
    return tg;
  }

  function ttsPackCard(p, vc) {
    var card = document.createElement('div'); card.className = 'ecard';
    var top = document.createElement('div'); top.className = 'etop';
    var name = document.createElement('div'); name.className = 'ename'; name.textContent = p.name;
    var lt = packLangTag(p.languages); if (lt) name.appendChild(lt);
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
      try { await api.acceptTts(p.id); } catch (e) {}
    }
    engBusy = true; btn.disabled = true; prog.hidden = false; prog.textContent = 'Installing…';
    try { await api.installEngine(p.id); }
    catch (e) { prog.textContent = 'Failed to start.'; engBusy = false; btn.disabled = false; return; }
    var s = await pollInstall(function (st) { prog.textContent = (st.detail || st.phase || 'Installing') + '…'; });
    engBusy = false;
    if (s.error) { prog.textContent = 'Failed: ' + s.error; btn.disabled = false; return; }
    setLoadVoices();
  }

  async function ttsRemovePack(p, btn, prog) {
    if (!(await dialog({ k: 'Uninstall', h: 'Uninstall ' + p.name + '?', p: 'You can reinstall this voice any time.', ok: 'Uninstall', cancel: 'Cancel', danger: true }))) return;
    engBusy = true; btn.disabled = true; prog.hidden = false; prog.textContent = 'Removing…';
    try { await api.removeEngine(p.id); } catch (e) {}
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
    try { await api.downloadVoice(ch.speaker); }
    catch (e) { engBusy = false; btn.disabled = false; return; }
    await new Promise(function (res) {
      var t = setInterval(async function () {
        var s = {}; try { s = await api.getVoiceDownloadStatus(); } catch (e) {}
        if (s.detail) btn.textContent = s.detail;
        if (s.done || s.error) { clearInterval(t); res(s); }
      }, 800);
    });
    engBusy = false; ttsLoadCatalogRefresh();
  }

  async function ttsLoadCatalogRefresh() {
    var cat = {}; try { cat = await api.getTtsCatalog(); } catch (e) { return; }
    ttsChars = cat.characters || []; ttsRenderChars();
  }
  $('#set-tts-filter').addEventListener('input', ttsRenderChars);

  api.getVersion().then(function (j) {
    var v = $('#ver'); if (v && j && j.version) v.textContent = 'v' + j.version;
  }).catch(function () {});
  api.checkUpdate().then(function (j) {
    if (!j || !j.update_available) return;
    var u = $('#upd'); if (!u) return;
    u.hidden = false;
    u.textContent = 'Update ' + (j.latest || '') + ' available';
    u.addEventListener('click', function () { api.openUpdate().catch(function () {}); });
  }).catch(function () {});

export { openSettings, closeSettings, pollInstall, ccApplyWin, ccPopulateWinPickers, gatePreviewGated };
