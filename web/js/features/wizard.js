import { $, $$, escHtml } from '../lib/util.js';
import { state } from '../lib/state.js';
import * as api from '../lib/api.js';
import { foot } from '../lib/ui.js';
import { targetLangOpts } from '../core/lang.js';
import { engById } from '../core/engines.js';
import { pollInstall } from './settings.js';

let host = null;
export function initWizard(h) { host = h; }

  var wizScreen = $('#wiz'), wizChoice = null;

  function wizStep(id) { $$('#wiz .wstep').forEach(function (s) { s.classList.toggle('on', s.id === id); }); }

  function openWizard() {
    wizScreen.hidden = false;

    var WIZ_HIDE = { whisper: true };
    var all = state.engineInfo ? state.engineInfo.engines : [];
    var offered = all.filter(function (e) { return !e.experimental && !WIZ_HIDE[e.id]; });
    var choices = offered.length ? offered : all;
    var rec = state.engineInfo && state.engineInfo.has_nvidia_gpu ? 'whisper-batch' : 'parakeet';
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

    if (state.engineInfo && state.engineInfo.install_job && !state.engineInfo.install_job.done) {
      wizStep('wiz-install-step'); wizResumeInstall();
    } else {
      wizStep('wiz-engine');
    }
  }

  function closeWizard() {
    wizScreen.hidden = true;
    if (state.engineInfo) state.engineInfo.wizard_done = true;

    api.saveConfig({ wizard_done: true }).catch(function () {});
  }

  async function wizRefreshEngines() {
    try { state.engineInfo = await api.getEngines(); } catch (e) {}
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
      var res = await api.installEngine(wizChoice);
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
    var def = langs.indexOf(state.engineInfo.language) >= 0 ? state.engineInfo.language
      : (langs.indexOf('en') >= 0 ? 'en' : langs[0]);
    $('#wiz-lang').innerHTML = host.srcLangOpts(langs).map(function (o) {
      return '<option value="' + escHtml(o.v) + '"' + (o.disabled ? ' disabled' : '')
        + (o.v === def ? ' selected' : '') + '>' + escHtml(o.n) + '</option>';
    }).join('');
    var list = state.allDevices.mic || [];
    $('#wiz-device').innerHTML = list.length
      ? list.map(function (d) { return '<option value="' + d.index + '">' + escHtml(d.name) + '</option>'; }).join('')
      : '<option value="">No microphones found</option>';
    $('#wiz-target').innerHTML = targetLangOpts().map(function (l) { return '<option value="' + escHtml(l.v) + '"' + (l.disabled ? ' disabled' : '') + '>' + escHtml(l.n) + '</option>'; }).join('');
    $('#wiz-target').value = host.TR.you.tgt || 'ja-JP';
    wizSetTranslate(host.TR.you.translate !== false);

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
    var model = (state.engineInfo.engine_models && state.engineInfo.engine_models[wizChoice]) || (e && e.default_model) || (e && e.models[0]) || '';
    var c = host.TR.you;
    c.engine = wizChoice; c.model = model;
    if (lang) c.src = lang;
    if (devName) c.device = devName;
    c.translate = translate;
    if (tgt) c.tgt = tgt;

    if (!engById(host.TR.them.engine) || !engById(host.TR.them.engine).installed) { host.TR.them.engine = wizChoice; host.TR.them.model = model; }

    var themE = engById(host.TR.them.engine);
    if (themE && (!host.TR.them.src || themE.languages.indexOf(host.TR.them.src) < 0)) {
      host.TR.them.src = themE.languages.indexOf(state.engineInfo.language) >= 0 ? state.engineInfo.language : (themE.languages[0] || 'auto');
    }
    var wantDict = $('#wiz-feat-dict').getAttribute('aria-pressed') === 'true';
    host.save();
    api.saveConfig({ mic_device_name: devName, target_language: tgt }).catch(function () {});
    host.renderAll();
    closeWizard();

    var jobs = [];

    if (wizChoice === 'whisper' || wizChoice === 'whisper-batch') {
      jobs.push({ label: 'Whisper model', begin: async function () {
        var info = await api.getModels(wizChoice);
        var md = (info.models || []).filter(function (m) { return m.id === model; })[0];
        if (!md || md.installed) return false;
        var r = await api.downloadModel(wizChoice, model);
        if (!r.ok) throw new Error('download rejected');
        return true;
      } });
    }

    if (wizChoice === 'parakeet' && lang === 'ja') {
      jobs.push({ label: 'Japanese model', begin: async function () {
        var info = await api.getModels('parakeet');
        var ja = (info.models || []).filter(function (m) { return m.id === 'parakeet-ja'; })[0];
        if (!ja || ja.installed) return false;
        var r = await api.downloadModel('parakeet', 'parakeet-ja');
        if (!r.ok) throw new Error('download rejected');
        return true;
      } });
    }
    if (wantDict) {
      jobs.push({ label: 'Japanese dictionary', begin: async function () {
        var st = await api.getLangStatus().catch(function () { return {}; });
        if (st.installed) return false;
        var r = await api.downloadLang();
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

export { openWizard };
