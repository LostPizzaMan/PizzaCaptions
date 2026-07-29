let userClosing = false;
let isReconnecting = false;
let sourceMode = 'mic'; 
let controlWs = null;
let allDevices = { mic: [], loopback: [] };
let savedDeviceNames = { mic: '', loopback: '' };

let activeLine = null;
let activeLineTimer = null;
let activeLineTime = null;
let lastLineUpdateAt = 0;

let engineSignalsFinal = false;

let shownChars = 0;
let latestLineLength = 0;

let lineCount = 0;
let lastCommittedText = '';

const latency = { stt: null, translate: null, tts: null };
let translationEnabled = false;

const TRANSLATION_FAILURE_LIMIT = 5;
let translationFailures = 0;

const btnStart      = document.getElementById('btn-start');
const btnStop       = document.getElementById('btn-stop');
const btnClear      = document.getElementById('btn-clear');
const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const activeZone    = document.getElementById('active-zone');
const historyZone   = document.getElementById('history-zone');
const rawFeed       = document.getElementById('raw-feed');
const micLabel      = document.getElementById('mic-label');
const oscToggle       = document.getElementById('osc-toggle');
const muteSuppress    = document.getElementById('cfg-mute-suppress');
const translateToggle = document.getElementById('translate-toggle');
const speakToggle     = document.getElementById('speak-toggle');
const translateBanner     = document.getElementById('translate-banner');
const translateBannerText = document.getElementById('translate-banner-text');
const sourceLangSelect = document.getElementById('lang-select');
const targetLangSelect = document.getElementById('target-lang-select');
const swapLangBtn   = document.getElementById('btn-swap-lang');
const srcMicBtn     = document.getElementById('src-mic');
const srcLoopBtn    = document.getElementById('src-loopback');
const deviceSelect  = document.getElementById('device-select');
const levelBar      = document.getElementById('level-bar');
const levelSlider   = document.getElementById('level-slider');
const levelValue    = document.getElementById('level-value');
const gateLineFill  = document.getElementById('gate-line-fill');
const gateLineMark  = document.getElementById('gate-line-mark');

function setGateMark(pct) {
  const p = Number(pct) || 0;
  gateLineMark.style.display = p > 0 ? 'block' : 'none';
  gateLineMark.style.left = `${p}%`;
}

const TRANSCRIPTION_TO_TRANSLATION_SOURCE = {
  ja: 'ja-JP', en: 'en-US', zh: 'zh-CN', ko: 'ko-KR', fr: 'fr-FR',
  es: 'es-ES', pt: 'pt-BR', de: 'de-DE', ru: 'ru-RU', ar: 'ar-SA',
  ms: 'ms-MY', th: 'th-TH', tr: 'tr-TR', lv: 'lv-LV', nl: 'nl-NL',
  it: 'it-IT', pl: 'pl-PL', uk: 'uk-UA', cs: 'cs-CZ', sk: 'sk-SK',
  sl: 'sl-SI', bg: 'bg-BG', hr: 'hr-HR', ro: 'ro-RO', hu: 'hu-HU',
  el: 'el-GR', da: 'da-DK', sv: 'sv-SE', fi: 'fi-FI', et: 'et-EE',
  lt: 'lt-LT', mt: 'mt-MT',
  auto: ''
};

const LANGUAGE_NAMES = {
  auto: 'Auto', ja: 'Japanese', en: 'English', zh: 'Chinese', ko: 'Korean',
  fr: 'French', es: 'Spanish', pt: 'Portuguese', de: 'German', ru: 'Russian',
  ar: 'Arabic', ms: 'Malay', lv: 'Latvian', nl: 'Dutch', it: 'Italian',
  pl: 'Polish', uk: 'Ukrainian', cs: 'Czech', sk: 'Slovak', sl: 'Slovenian',
  bg: 'Bulgarian', hr: 'Croatian', ro: 'Romanian', hu: 'Hungarian',
  el: 'Greek', da: 'Danish', sv: 'Swedish', fi: 'Finnish', et: 'Estonian',
  lt: 'Lithuanian', mt: 'Maltese', th: 'Thai', tr: 'Turkish'
};

let engineInfo = null; 

function populateLangSelect(languages, selected) {
  sourceLangSelect.innerHTML = languages.map(code =>
    `<option value="${code}"${code === selected ? ' selected' : ''}>${LANGUAGE_NAMES[code] || code}</option>`
  ).join('');
}

function updateModelSelect() {
  const eng = engineInfo?.engines.find(e => e.id === cfgEngine.value);
  if (!eng) return;
  const current = engineInfo.engine_models[eng.id] || eng.default_model;
  cfgModel.innerHTML = eng.models.map(m =>
    `<option value="${m}"${m === current ? ' selected' : ''}>${m}</option>`
  ).join('');
  cfgModelRow.style.display = eng.models.length > 1 ? '' : 'none';
}

async function loadEngines() {
  try {
    const res = await fetch('/engines');
    engineInfo = await res.json();
    cfgEngine.innerHTML = engineInfo.engines.map(e =>
      `<option value="${e.id}"${e.id === engineInfo.active_engine ? ' selected' : ''}>${e.name}${e.experimental ? ' [Experimental]' : ''}${e.installed ? '' : ' (not installed)'}</option>`
    ).join('');
    updateModelSelect();
    updateEngineInstallUI();
    const active = engineInfo.engines.find(e => e.id === engineInfo.active_engine);
    if (active) populateLangSelect(active.languages, engineInfo.language);
    if (engineInfo.install_job && !engineInfo.install_job.done) pollInstall();
    
    if (engineInfo.engines.length && engineInfo.engines.every(e => !e.installed)) {
      if (engineInfo.wizard_done) {
        setStatus('error', 'No engine installed. Pick one and click Install');
        openConfigPanel();
      } else {
        openWizard();
      }
    }
  } catch (e) {
    console.error('Failed to load engines:', e);
  }
}

function applyEngine() {
  sendControl({ action: 'set_engine', engine: cfgEngine.value, model: cfgModel.value });
}

let installPollTimer = null;

function selectedEngine() {
  return engineInfo?.engines.find(e => e.id === cfgEngine.value);
}

function updateEngineInstallUI() {
  const eng = selectedEngine();
  const row = document.getElementById('cfg-engine-install');
  const uninstall = document.getElementById('cfg-uninstall-btn');
  const experimental = document.getElementById('cfg-engine-experimental');
  experimental.style.display = (eng && eng.experimental) ? 'flex' : 'none';
  uninstall.style.display = (eng && eng.installed && eng.source === 'installed') ? '' : 'none';
  if (!eng || eng.installed) { row.style.display = 'none'; return; }
  row.style.display = '';
}

async function uninstallEngine() {
  const eng = selectedEngine();
  if (!eng) return;
  if (!confirm(`Uninstall the ${eng.name} engine? Its runtime is removed; downloaded models are kept and it can be reinstalled anytime.`)) return;
  const res = await fetch('/engines/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: eng.id })
  });
  if (!res.ok) {
    const p = await res.json().catch(() => ({}));
    alert(p.detail || 'Uninstall failed');
  }
  await loadEngines();
  loadModels();
}

async function installEngine() {
  const eng = selectedEngine();
  if (!eng) return;
  const btn = document.getElementById('cfg-install-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/engines/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: eng.id })
    });
    if (!res.ok) {
      const p = await res.json().catch(() => ({}));
      document.getElementById('cfg-install-progress').textContent = p.detail || 'Install failed to start';
      btn.disabled = false;
      return;
    }
    pollInstall();
  } catch (e) {
    document.getElementById('cfg-install-progress').textContent = e.message;
    btn.disabled = false;
  }
}

function pollInstall() {
  if (installPollTimer) clearInterval(installPollTimer);
  const progress = document.getElementById('cfg-install-progress');
  const btn = document.getElementById('cfg-install-btn');
  btn.disabled = true;
  installPollTimer = setInterval(async () => {
    try {
      const s = await (await fetch('/engines/install/status')).json();
      if (s.error) {
        progress.textContent = 'Install failed. See console or log for details';
      } else {
        progress.textContent = `${s.phase} ${s.detail || ''}`;
      }
      if (s.done) {
        clearInterval(installPollTimer);
        installPollTimer = null;
        btn.disabled = false;
        if (!s.error) {
          progress.textContent = 'Installed ✓';
          await loadEngines();
          applyEngine();
        }
      }
    } catch {  }
  }, 1000);
}

let modelPollTimer = null;

function fmtBytes(n) {
  if (!n) return '0 MB';
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

async function loadModels() {
  const engine = cfgEngine.value;
  const box = document.getElementById('cfg-models');
  const footer = document.getElementById('cfg-models-footer');
  if (!engine) { box.innerHTML = ''; footer.textContent = ''; return; }
  try {
    const res = await fetch(`/models?engine=${encodeURIComponent(engine)}`);
    if (!res.ok) { box.innerHTML = ''; footer.textContent = ''; return; }
    const info = await res.json();
    box.innerHTML = info.models.map(m => {
      const size = m.installed ? fmtBytes(m.size_bytes) : `~${m.est_download}`;
      const status = m.installed
        ? `<span style="color:#7dbd8a;">on disk · ${size}</span>`
        : `<span style="color:#666;">${m.can_download ? 'not downloaded' : 'downloads on first use'} · ${size}</span>`;
      const btn = m.installed
        ? `<button class="model-del" data-model="${m.id}" data-label="${m.label}" data-size="${m.size_bytes}" style="background:#2a2a2a;border:1px solid #3a3a3a;border-radius:5px;color:#c66;font-size:11px;padding:3px 8px;cursor:pointer;">Delete</button>`
        : (m.can_download
          ? `<button class="model-dl" data-model="${m.id}" style="background:#685EBD;border:none;border-radius:5px;color:#fff;font-size:11px;padding:3px 8px;cursor:pointer;">Download</button>`
          : '');
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <span>${m.label}${m.active ? ' <span style="color:#685EBD;">•</span>' : ''}</span>
        <span style="display:flex;align-items:center;gap:8px;">${status}${btn}</span>
      </div>`;
    }).join('');
    footer.textContent = `Total on disk: ${fmtBytes(info.total_bytes)} · Free space: ${fmtBytes(info.disk_free_bytes)}`;
    box.querySelectorAll('.model-del').forEach(b => b.addEventListener('click', () => {
      if (confirm(`Delete ${b.dataset.label}? Frees ${fmtBytes(parseInt(b.dataset.size))}. It will be re-downloaded if needed.`)) {
        deleteModel(b.dataset.model);
      }
    }));
    box.querySelectorAll('.model-dl').forEach(b => b.addEventListener('click', () => downloadModel(b.dataset.model)));
  } catch (e) {
    console.error('loadModels failed:', e);
  }
}

async function deleteModel(model) {
  const engine = cfgEngine.value;
  const res = await fetch('/models/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine, model })
  });
  const p = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(p.detail || 'Delete failed');
  }
  await loadModels();
}

async function downloadModel(model, engine = cfgEngine.value) {
  const res = await fetch('/models/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine, model })
  });
  if (!res.ok) {
    const p = await res.json().catch(() => ({}));
    alert(p.detail || 'Download failed to start');
    return;
  }
  const footer = document.getElementById('cfg-models-footer');
  if (modelPollTimer) clearInterval(modelPollTimer);
  modelPollTimer = setInterval(async () => {
    try {
      const s = await (await fetch('/engines/install/status')).json();
      if (s.error) {
        footer.textContent = 'Download failed. See console or log for details';
      } else {
        footer.textContent = `${s.phase} ${s.detail || ''}`;
      }
      if (s.done) {
        clearInterval(modelPollTimer);
        modelPollTimer = null;
        await loadModels();
      }
    } catch {  }
  }, 1000);
}

let blockedPhrases = [];

const ALNUM = /[\p{L}\p{N}]/u;

function normalizeForBlocklist(text) {
  return (text || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function normalizeWithMap(chars) {
  let norm = '';
  const map = [];
  chars.forEach((ch, i) => {
    if (!ALNUM.test(ch)) return;
    const low = ch.toLowerCase();
    norm += low;
    for (let k = 0; k < low.length; k++) map.push(i);  
  });
  return { norm, map };
}

const UNSPACED = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u0e00-\u0e7f\u{20000}-\u{2fa1f}]/u;

function isWordy(ch) {
  return ALNUM.test(ch) && !UNSPACED.test(ch);
}

function boundaryOk(chars, start, end) {
  if (start > 0 && isWordy(chars[start - 1]) && isWordy(chars[start])) return false;
  if (end + 1 < chars.length && isWordy(chars[end + 1]) && isWordy(chars[end])) return false;
  return true;
}

function stripBlockedPhrases(text) {
  const chars = Array.from(text || '');
  const { norm, map } = normalizeWithMap(chars);
  if (!norm) return { text: text || '', removed: false };
  const drop = new Array(chars.length).fill(false);
  let removed = false;
  for (const p of blockedPhrases) {
    if (!p) continue;
    let i = norm.indexOf(p);
    while (i !== -1) {
      const from = map[i], to = map[i + p.length - 1];
      if (!boundaryOk(chars, from, to)) {
        i = norm.indexOf(p, i + 1);  
        continue;
      }
      
      for (let c = from; c <= to; c++) drop[c] = true;
      removed = true;
      i = norm.indexOf(p, i + p.length);
    }
  }
  if (!removed) return { text, removed: false };
  widenCuts(chars, drop);
  return { text: tidyAfterStrip(chars.filter((_, i) => !drop[i]).join('')), removed: true };
}

function widenCuts(chars, drop) {
  const n = chars.length;
  let i = 0;
  while (i < n) {
    if (!drop[i]) { i++; continue; }
    let end = i;
    while (end < n && drop[end]) end++;
    let after = end;
    while (after < n && !ALNUM.test(chars[after])) after++;
    for (let x = end; x < after; x++) drop[x] = true;  
    if (after >= n) {
      
      for (let x = i - 1; x >= 0 && !ALNUM.test(chars[x]); x--) drop[x] = true;
    }
    i = after + 1;
  }
}

function tidyAfterStrip(text) {
  const out = [];
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (out.length && out[out.length - 1] !== ' ') out.push(' ');
      continue;
    }
    if (!ALNUM.test(ch)) {
      let j = out.length - 1;
      while (j >= 0 && out[j] === ' ') j--;
      if (j >= 0 && !ALNUM.test(out[j])) continue;  
      while (out.length && out[out.length - 1] === ' ') out.pop();
    }
    out.push(ch);
  }
  let chars = out;
  while (chars.length && !ALNUM.test(chars[0])) chars = chars.slice(1);
  return chars.join('').trim();
}

async function loadBlockedPhrases() {
  try {
    const res = await fetch('/config');
    const c = await res.json();
    blockedPhrases = [...(c.default_blocked_phrases || []), ...(c.blocked_phrases || [])]
      .map(normalizeForBlocklist)
      .filter(Boolean);
  } catch (e) {
    console.error('Failed to load blocked phrases:', e);
  }
}

function hasRepetition(text) {
  if (!text || text.length < 3) return false;

  const normalized = text.replace(/\s+/g, '').replace(/[。、.,!?！？]/g, '');

  if (/(.{1,20})\1{2,}/.test(normalized)) return true;

  return false;
}

function setStatus(state, text) {
  statusDot.className = state;
  statusText.textContent = text;
}

function formatTime(date) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function resetUI() {
  btnStart.disabled = false;
  btnStop.disabled = true;
  micLabel.textContent = '';
  levelBar.style.width = '0%';
  levelBar.classList.remove('gated');
  gateLineFill.style.width = '0%';
  gateLineFill.classList.remove('gated');
}

function isCapturing() {
  return !btnStop.disabled;
}

function setSegmentTranslation(segment, translatedText, pending = false) {
  const translationDiv = segment.querySelector('.translation');
  if (!translationDiv) return;
  translationDiv.classList.toggle('pending', pending);
  if (!translatedText) {
    translationDiv.textContent = '';
    translationDiv.style.display = 'none';
    return;
  }
  translationDiv.textContent = translatedText;
  translationDiv.style.display = 'block';
}

function stripCommittedOverlap(text) {
  if (!text || !lastCommittedText) return text;

  const normalizedCommitted = lastCommittedText.trim();
  const maxOverlap = Math.min(normalizedCommitted.length, text.length, 8);

  for (let size = maxOverlap; size >= 4; size--) {
    const committedSuffix = normalizedCommitted.slice(-size);
    if (text.startsWith(committedSuffix)) {
      return text.slice(size).trimStart();
    }
  }

  return text;
}

const OSC_ELLIPSIS = '…';
const OSC_SNAP_WINDOW = 24;  

const OSC_TRANSLATION_SHARE = 0.55;

function oscTailWindow(text, budget) {
  if (text.length <= budget) return text;
  let cut = text.slice(-(budget - OSC_ELLIPSIS.length));
  const sp = cut.indexOf(' ');
  if (sp > -1 && sp <= OSC_SNAP_WINDOW) cut = cut.slice(sp + 1);
  return OSC_ELLIPSIS + cut;
}

function oscHeadWindow(text, budget) {
  if (text.length <= budget) return text;
  let cut = text.slice(0, budget - OSC_ELLIPSIS.length);
  const sp = cut.lastIndexOf(' ');
  if (sp > -1 && cut.length - sp <= OSC_SNAP_WINDOW) cut = cut.slice(0, sp);
  return cut + OSC_ELLIPSIS;
}

function buildOscPayload(originalText, translatedText = '') {
  const original = (originalText || '').trim();
  const translated = (translatedText || '').trim();
  if (!translated) return oscTailWindow(original, OSC_MAX_CHARS);

  const separator = '\n';
  const combined = `${original}${separator}${translated}`;
  if (combined.length <= OSC_MAX_CHARS) return combined;

  const avail = OSC_MAX_CHARS - separator.length;
  let tBudget = Math.min(translated.length, Math.round(avail * OSC_TRANSLATION_SHARE));
  let oBudget = avail - tBudget;
  if (original.length < oBudget) {
    tBudget = Math.min(translated.length, avail - original.length);
    oBudget = avail - tBudget;
  }
  return `${oscTailWindow(original, oBudget)}${separator}${oscHeadWindow(translated, tBudget)}`;
}

async function sendOscTranscript(originalText, translatedText = '') {
  if (!oscToggle.checked) return;
  const payload = buildOscPayload(originalText, translatedText);
  if (payload) await sendControl({ action: 'send_osc', text: payload });
}

async function stopOscTyping() {
  if (!oscToggle.checked) return;
  await sendControl({ action: 'osc_typing', flag: false });
}

function hideTranslateBanner() {
  translateBanner.hidden = true;
}

function noteTranslationFailure(detail) {
  if (!translationEnabled) return; 
  if (++translationFailures < TRANSLATION_FAILURE_LIMIT) return;
  translationEnabled = false;
  translateToggle.checked = false;
  translationFailures = 0;
  
  translateBannerText.textContent =
    `Translation disabled after ${TRANSLATION_FAILURE_LIMIT} consecutive failures: ${detail}`;
  translateBanner.hidden = false;
}

async function requestTranslation(text, segment) {
  try {
    setSegmentTranslation(segment, 'Translating...', true);
    const sourceLanguage = TRANSCRIPTION_TO_TRANSLATION_SOURCE[sourceLangSelect.value] || '';
    const targetLanguage = targetLangSelect.value || '';
    const res = await fetch('/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sourceLanguage, targetLanguage })
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof payload.detail === 'string' ? payload.detail : 'Translation failed';
      setSegmentTranslation(segment, `[Translation unavailable] ${detail}`);
      noteTranslationFailure(detail);
      if (speakToggle.checked && window.ttsApi && speakSource() === 'translation') {
        window.ttsApi.speakLine(text); 
      }
      await sendOscTranscript(text);
      await stopOscTyping();
      return;
    }

    const translatedText = payload.translated || '';
    translationFailures = 0;
    if (typeof payload.translate_ms === 'number') { latency.translate = payload.translate_ms; renderLatency(); }
    setSegmentTranslation(segment, translatedText);
    if (speakToggle.checked && window.ttsApi && speakSource() === 'translation') {
      window.ttsApi.speakLine(translatedText || text);
    }
    await sendOscTranscript(text, translatedText);
    await stopOscTyping();
  } catch (err) {
    setSegmentTranslation(segment, `[Translation unavailable] ${err.message}`);
    noteTranslationFailure(err.message);
    if (speakToggle.checked && window.ttsApi && speakSource() === 'translation') {
      window.ttsApi.speakLine(text); 
    }
    await sendOscTranscript(text);
    await stopOscTyping();
  }
}

function ensureActiveLine() {
  const empty = document.getElementById('empty-state');
  if (empty) empty.remove();
  if (!activeLine) {
    activeLine = document.createElement('div');
    activeLine.className = 'segment partial';
    const textDiv = document.createElement('div');
    textDiv.className = 'text';
    activeLine.appendChild(textDiv);
    const translationDiv = document.createElement('div');
    translationDiv.className = 'translation';
    activeLine.appendChild(translationDiv);
    activeZone.innerHTML = '';
    activeZone.appendChild(activeLine);
    activeLineTime = new Date();
    if (oscToggle.checked) {
      sendControl({ action: 'osc_typing', flag: true });
    }
  }
}

function commitActiveLine() {
  if (!activeLine) return;
  const raw = activeLine.querySelector('.text').textContent.trim();
  
  const stripped = raw ? stripBlockedPhrases(raw) : { text: '', removed: false };
  const text = stripped.text;
  if (stripped.removed) console.warn('Blocked phrase filtered:', raw, '->', text || '(dropped)');
  
  if (raw && !text) {
    shownChars = latestLineLength;
    lastCommittedText = raw;
    stopOscTyping().catch(console.error);
  } else if (text) {
    shownChars = latestLineLength;
    const hist = document.createElement('div');
    hist.className = 'segment final';
    const timeDiv = document.createElement('div');
    timeDiv.className = 'time';
    timeDiv.textContent = formatTime(activeLineTime || new Date());
    hist.appendChild(timeDiv);
    const textDiv = document.createElement('div');
    textDiv.className = 'text';
    textDiv.textContent = text;
    hist.appendChild(textDiv);
    const translationDiv = document.createElement('div');
    translationDiv.className = 'translation';
    hist.appendChild(translationDiv);
    historyZone.insertBefore(hist, historyZone.firstChild);
    lastCommittedText = raw;
    if (translationEnabled) requestTranslation(text, hist);
    else sendOscTranscript(text).then(stopOscTyping).catch(console.error);
    
    if (speakToggle.checked && window.ttsApi &&
        !(translationEnabled && speakSource() === 'translation')) {
      window.ttsApi.speakLine(text);
    }
  }
  activeZone.innerHTML = '';
  activeLine = null;
  activeLineTime = null;
}

const SILENCE_COMMIT_MS = 1250;

const SILENCE_FORCE_MARKED_MS = 8000;

function resetSilenceTimer() {
  if (activeLineTimer) clearTimeout(activeLineTimer);
  lastLineUpdateAt = Date.now();
  activeLineTimer = setTimeout(onSilence, SILENCE_COMMIT_MS);
}

function onSilence() {
  const text = activeLine ? activeLine.querySelector('.text').textContent : '';
  
  if (engineSignalsFinal && text &&
      Date.now() - lastLineUpdateAt < SILENCE_FORCE_MARKED_MS) {
    activeLineTimer = setTimeout(onSilence, SILENCE_COMMIT_MS);
    return;
  }
  commitActiveLine();
  activeLineTimer = null;
}

const SENTENCE_ENDERS = /[。．！？!?]/;
const SOFT_LENGTH_LIMIT = 30;

const OSC_MAX_CHARS = 144;

function endsWithSentenceEnder(text) {
  if (SENTENCE_ENDERS.test(text.slice(-2))) return true;
  return text.endsWith('.') && !/\d\.$/.test(text);
}

function updateActiveLine(text) {
  ensureActiveLine();
  activeLine.querySelector('.text').textContent = text;
  
  if (!engineSignalsFinal &&
      text.length >= SOFT_LENGTH_LIMIT && endsWithSentenceEnder(text)) {
    if (activeLineTimer) { clearTimeout(activeLineTimer); activeLineTimer = null; }
    commitActiveLine();
  } else {
    resetSilenceTimer();
  }
}

function handleServerMessage(event) {
  try {
    const data = JSON.parse(event.data);
    if (data.type === 'config' || data.type === 'ready_to_stop') return;

    const lines = Array.isArray(data.lines) ? data.lines : [];
    const visible = lines.filter(l => l.speaker !== -2 && (l.text || '').trim());
    const latest = visible[visible.length - 1];
    if (!latest) return;

    engineSignalsFinal = data.line_count !== undefined;
    const count = data.line_count ?? visible.length;
    if (count !== lineCount) {
      if (count > lineCount) commitActiveLine();
      lineCount = count;
      shownChars = 0;
      lastCommittedText = ''; 
      latency.stt = null;        
      latency.translate = null;
      latency.tts = null;
      renderLatency();
    }

    if (typeof data.decode_ms === 'number') { latency.stt = data.decode_ms; renderLatency(); }

    const fullText = latest.text.trim();
    rawFeed.textContent = fullText;

    if (fullText.length < shownChars) shownChars = 0;
    latestLineLength = fullText.length;

    const newText = fullText.slice(shownChars)
      .trim()
      .replace(/^[。．？！?!]+/, '');
    const dedupedText = stripCommittedOverlap(newText);

    if (hasRepetition(fullText)) {
      console.warn('Repetition detected, reconnecting...');
      commitActiveLine();
      reconnect();
      return;
    }

    if (!dedupedText) return;

    if (/^[。．？！?!.,\s]+$/.test(dedupedText)) return;

    const currentText = activeLine ? activeLine.querySelector('.text').textContent : '';
    if (dedupedText !== currentText) updateActiveLine(dedupedText);

    if (data.final) {
      if (activeLineTimer) { clearTimeout(activeLineTimer); activeLineTimer = null; }
      commitActiveLine();
    }

  } catch (e) {
    if (typeof event.data === 'string' && event.data.trim()) {
      updateActiveLine(event.data);
    }
  }
}

let latencyHudEnabled = localStorage.getItem('latencyHud') === '1';

function renderLatency() {
  const el = document.getElementById('latency-hud');
  if (!el) return;
  const parts = [];
  if (latency.stt != null) parts.push(`STT ${latency.stt}ms`);
  if (latency.translate != null) parts.push(`TL ${latency.translate}ms`);
  if (latency.tts != null) parts.push(`TTS ${latency.tts}ms`);
  if (!latencyHudEnabled || !parts.length) { el.hidden = true; return; }
  const total = (latency.stt || 0) + (latency.translate || 0) + (latency.tts || 0);
  el.textContent = parts.join('  +  ') + (parts.length > 1 ? `  =  ${total}ms` : '');
  el.hidden = false;
}

function setLatencyHud(on) {
  latencyHudEnabled = on;
  localStorage.setItem('latencyHud', on ? '1' : '0');
  renderLatency();
}

function openControlWs() {
  if (controlWs && controlWs.readyState <= WebSocket.OPEN) return;
  controlWs = new WebSocket(`ws://${location.host}/control`);
  controlWs.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'audio_level') {
        const w = `${Math.round(msg.level * 100)}%`;
        levelBar.style.width = w;
        levelBar.classList.toggle('gated', msg.gated);
        gateLineFill.style.width = w;
        gateLineFill.classList.toggle('gated', msg.gated);
        return;
      }
      
      if (msg.type === 'state') {
        if (isCapturing()) {
          if (msg.state === 'processing') setStatus('processing', 'Processing…');
          else setStatus('live', 'Listening');
        }
        return;
      }
      if (msg.type === 'capture_ended') {
        
        stopStartupPolling();
        if (activeLineTimer) { clearTimeout(activeLineTimer); activeLineTimer = null; }
        commitActiveLine();
        shownChars = 0;
        latestLineLength = 0;
        lineCount = 0;
        lastCommittedText = '';
        engineSignalsFinal = false;
        setStatus('', 'Stopped');
        resetUI();
        return;
      }
      if (msg.error) {
        console.error('Control:', msg.error);
        stopStartupPolling();
        setStatus('error', msg.error);
        if (!isCapturing()) btnStart.disabled = false;
        return;
      }
      if (msg.status === 'capture_started' || msg.status === 'capture_stopped') return;
      if (msg.status === 'language_loading') { setStatus('connecting', `Loading ${msg.language}...`); return; }
      if (msg.status === 'language_set') {
        sourceLangSelect.value = msg.language;
        if (!isCapturing()) setStatus('', 'Ready');
        return;
      }
      if (msg.status === 'engine_loading') { setStatus('connecting', 'Switching engine...'); return; }
      if (msg.status === 'engine_set') {
        if (engineInfo) {
          engineInfo.active_engine = msg.engine;
          engineInfo.engine_models[msg.engine] = msg.model;
          engineInfo.language = msg.language;
        }
        populateLangSelect(msg.languages, msg.language);
        if (!isCapturing()) setStatus('', 'Ready');
        return;
      }
      if (msg.type === 'config') {
        stopStartupPolling();
        setStatus('live', 'Listening');
        btnStop.disabled = false;
        return;
      }
      handleServerMessage(e);
    } catch {}
  });
  controlWs.addEventListener('close', () => {
    if (userClosing) return;
    
    setStatus('connecting', 'Reconnecting...');
    startStartupPolling();
    setTimeout(async () => {
      controlWs = null;
      openControlWs();
      await new Promise(r => controlWs.addEventListener('open', r, { once: true }));
      const deviceIndex = deviceSelect.value !== '' ? parseInt(deviceSelect.value) : null;
      if (deviceIndex !== null && isCapturing()) {
        await sendControl({ action: 'start_capture', device_index: deviceIndex });
      }
    }, 1500);
  });
}

function sendControl(obj) {
  openControlWs();
  return new Promise((resolve) => {
    const send = () => {
      controlWs.send(JSON.stringify(obj));
      resolve();
    };
    if (controlWs.readyState === WebSocket.OPEN) {
      send();
    } else {
      controlWs.addEventListener('open', send, { once: true });
    }
  });
}

async function loadDevices() {
  try {
    const res = await fetch('/devices');
    allDevices = await res.json();
    populateDeviceSelect();
  } catch {
    deviceSelect.innerHTML = '<option value="">Error loading devices</option>';
  }
}

function populateDeviceSelect() {
  const list = sourceMode === 'mic' ? allDevices.mic : allDevices.loopback;
  deviceSelect.innerHTML = list.length
    ? list.map(d => `<option value="${d.index}">${d.name}</option>`).join('')
    : `<option value="">No ${sourceMode} devices</option>`;
  
  const match = list.find(d => d.name === savedDeviceNames[sourceMode]);
  if (match) deviceSelect.value = String(match.index);
}

function saveDeviceChoice() {
  const body = { source_mode: sourceMode };
  
  if (deviceSelect.value !== '') {
    const name = deviceSelect.selectedOptions[0]?.text || '';
    savedDeviceNames[sourceMode] = name;
    body[sourceMode === 'mic' ? 'mic_device_name' : 'loopback_device_name'] = name;
  }
  fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function applySourceMode(mode) {
  sourceMode = mode;
  srcMicBtn.classList.toggle('active', mode === 'mic');
  srcLoopBtn.classList.toggle('active', mode === 'loopback');
  populateDeviceSelect();
}

function onDeviceChanged() {
  micLabel.textContent = deviceSelect.selectedOptions[0]?.text || '';
  saveDeviceChoice();
  if (isCapturing()) reconnect();
}

srcMicBtn.addEventListener('click', () => {
  if (sourceMode === 'mic') return;
  applySourceMode('mic');
  onDeviceChanged();
});

srcLoopBtn.addEventListener('click', () => {
  if (sourceMode === 'loopback') return;
  applySourceMode('loopback');
  onDeviceChanged();
});

let startupPollTimer = null;

function startStartupPolling() {
  stopStartupPolling();
  startupPollTimer = setInterval(async () => {
    try {
      const s = await (await fetch('/engine/startup')).json();
      if (statusDot.className !== 'connecting') return; 
      if (s.phase === 'downloading') {
        setStatus('connecting', `Downloading model: ${s.detail || '...'}`);
      } else if (s.phase === 'loading') {
        setStatus('connecting', 'Loading model...');
      }
    } catch {  }
  }, 600);
}

function stopStartupPolling() {
  if (startupPollTimer) { clearInterval(startupPollTimer); startupPollTimer = null; }
}

async function startTranscription() {
  try {
    userClosing = false;
    btnStart.disabled = true;
    setStatus('connecting', 'Connecting...');
    const deviceIndex = deviceSelect.value !== '' ? parseInt(deviceSelect.value) : null;
    if (deviceIndex === null) {
      throw new Error('No device selected');
    }
    openControlWs();
    await new Promise(r => {
      const go = () => { sendControl({ action: 'start_capture', device_index: deviceIndex }); r(); };
      if (controlWs.readyState === WebSocket.OPEN) go();
      else controlWs.addEventListener('open', go, { once: true });
    });
    micLabel.textContent = deviceSelect.selectedOptions[0]?.text || '';
    setStatus('connecting', 'Connecting...');
    startStartupPolling();
    btnStop.disabled = false;
  } catch (err) {
    console.error(err);
    stopStartupPolling();
    setStatus('error', `Error: ${err.message}`);
    btnStart.disabled = false;
  }
}

async function stopTranscription() {
  userClosing = true;
  stopStartupPolling();
  if (activeLineTimer) { clearTimeout(activeLineTimer); activeLineTimer = null; }
  commitActiveLine();
  shownChars = 0;
  latestLineLength = 0;
  lineCount = 0;
  lastCommittedText = '';
  engineSignalsFinal = false;
  await sendControl({ action: 'stop_capture' });
  setStatus('', 'Stopped');
  resetUI();
}

async function reconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  if (activeLineTimer) { clearTimeout(activeLineTimer); activeLineTimer = null; }
  activeLine = null;
  activeZone.innerHTML = '';
  shownChars = 0;
  latestLineLength = 0;
  lineCount = 0;
  lastCommittedText = '';
  try {
    setStatus('connecting', 'Reconnecting...');
    startStartupPolling();
    const deviceIndex = deviceSelect.value !== '' ? parseInt(deviceSelect.value) : null;
    if (deviceIndex !== null) await sendControl({ action: 'start_capture', device_index: deviceIndex });
    stopStartupPolling();
    setStatus('live', 'Live');
  } catch (e) {
    console.error('Reconnect failed:', e);
    stopStartupPolling();
    setStatus('error', 'Reconnect failed');
    resetUI();
  } finally {
    isReconnecting = false;
  }
}

loadBlockedPhrases();
loadEngines();
fetch('/version').then(r => r.json()).then(v => {
  document.getElementById('cfg-version').textContent = `v${v.version}`;
}).catch(() => {});

async function checkForUpdate({ force = false, announce = false } = {}) {
  const status = document.getElementById('cfg-update-status');
  const banner = document.getElementById('update-banner');
  if (announce) status.textContent = 'Checking...';
  try {
    const res = await fetch(`/update/check${force ? '?force=1' : ''}`);
    const u = await res.json();
    if (u.update_available) {
      document.getElementById('ub-latest').textContent = u.latest;
      document.getElementById('ub-current').textContent = u.current;
      banner.classList.add('show');
      btnConfig.classList.add('update-available');
      if (announce) status.textContent = `Update available: v${u.latest}`;
    } else {
      banner.classList.remove('show');
      btnConfig.classList.remove('update-available');
      if (announce) status.textContent = u.latest ? `Up to date (v${u.current})` : 'No releases found';
    }
  } catch {
    if (announce) status.textContent = 'Update check failed';
  }
}

document.getElementById('cfg-update-check')
  .addEventListener('click', () => checkForUpdate({ force: true, announce: true }));
document.getElementById('ub-download')
  .addEventListener('click', () => { fetch('/update/open', { method: 'POST' }).catch(() => {}); });
checkForUpdate();

document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    fetch('/open-external', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: href }),
    }).catch(() => {});
  }
});

(async () => {
  try {
    const c = await fetch('/config').then(r => r.json());
    if (c.target_language) targetLangSelect.value = c.target_language;
    savedDeviceNames = {
      mic: c.mic_device_name || '',
      loopback: c.loopback_device_name || '',
    };
    levelSlider.value = Math.round((c.min_sound_level || 0) * 100);
    levelValue.textContent = `${levelSlider.value}%`;
    setGateMark(levelSlider.value);
    if (typeof c.suppress_osc_when_muted === 'boolean') muteSuppress.checked = c.suppress_osc_when_muted;
    if (c.source_mode === 'loopback') applySourceMode('loopback');
  } catch {  }
  await loadDevices();
  micLabel.textContent = deviceSelect.selectedOptions[0]?.text || '';
})();

sourceLangSelect.addEventListener('change', (e) => {
  userClosing = false; 
  if (isCapturing()) setStatus('connecting', 'Restarting...');
  sendControl({ action: 'set_language', language: e.target.value });
});

deviceSelect.addEventListener('change', onDeviceChanged);

levelSlider.addEventListener('input', () => {
  levelValue.textContent = `${levelSlider.value}%`;
  setGateMark(levelSlider.value);
});

levelSlider.addEventListener('change', () => {
  fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ min_sound_level: levelSlider.value / 100 }),
  }).catch(() => {});
});

muteSuppress.addEventListener('change', () => {
  fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ suppress_osc_when_muted: muteSuppress.checked }),
  }).catch(() => {});
});

const latencyHudToggle = document.getElementById('cfg-latency-hud');
if (latencyHudToggle) {
  latencyHudToggle.checked = latencyHudEnabled;
  latencyHudToggle.addEventListener('change', () => setLatencyHud(latencyHudToggle.checked));
}

targetLangSelect.addEventListener('change', () => {
  fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_language: targetLangSelect.value }),
  }).catch(() => {});
  if (!translateToggle.checked) return;
  const firstTranslation = historyZone.querySelector('.segment.final .translation');
  if (firstTranslation) {
    setStatus('', `Translate to ${targetLangSelect.selectedOptions[0]?.text || targetLangSelect.value}`);
  }
});

const hasOption = (select, value) =>
  [...select.options].some(o => o.value === value);

swapLangBtn.addEventListener('click', () => {
  const newTarget = TRANSCRIPTION_TO_TRANSLATION_SOURCE[sourceLangSelect.value] || '';
  const newSource = targetLangSelect.value.split('-')[0];
  if (!hasOption(sourceLangSelect, newSource) || !hasOption(targetLangSelect, newTarget)) {
    
    setStatus('', "Can't swap these two languages");
    return;
  }
  if (newSource === sourceLangSelect.value && newTarget === targetLangSelect.value) return;
  sourceLangSelect.value = newSource;
  targetLangSelect.value = newTarget;
  sourceLangSelect.dispatchEvent(new Event('change'));
  targetLangSelect.dispatchEvent(new Event('change'));
});

oscToggle.addEventListener('change', () => {
  if (!oscToggle.checked) {
    sendControl({ action: 'osc_typing', flag: false });
  }
});

translateToggle.addEventListener('change', () => {
  translationEnabled = translateToggle.checked;
  translationFailures = 0; 
  hideTranslateBanner();
});

const speakSourceSel = document.getElementById('tts-speak-source');
function speakSource() { return speakSourceSel ? speakSourceSel.value : 'original'; }
if (speakSourceSel) {
  const saved = localStorage.getItem('ttsSpeakSource');
  if (saved) speakSourceSel.value = saved;
  speakSourceSel.addEventListener('change', () => {
    localStorage.setItem('ttsSpeakSource', speakSourceSel.value);
  });
}

speakToggle.addEventListener('change', async () => {
  if (!speakToggle.checked || !window.ttsApi) return;
  const ready = await window.ttsApi.prepare();
  if (ready === 'not-installed') {
    speakToggle.checked = false;
    document.getElementById('btn-speak').click(); 
  }
});

document.getElementById('translate-banner-dismiss')
  .addEventListener('click', hideTranslateBanner);

document.getElementById('translate-banner-settings')
  .addEventListener('click', async () => {
    hideTranslateBanner();
    await loadConfig();
    openConfigPanel();
    loadModels();
  });

const wizardBackdrop = document.getElementById('wizard-backdrop');
let wizEngineChoice = null;
let wizMode = 'mic';
let wizPollTimer = null;

function wizardStep(id) {
  document.querySelectorAll('.wizard-step').forEach(s =>
    s.classList.toggle('active', s.id === id));
}

function openWizard() {
  setStatus('', 'Welcome');
  wizardBackdrop.classList.add('open');
  const box = document.getElementById('wiz-engines');
  const rec = engineInfo?.has_nvidia_gpu ? 'whisper' : 'parakeet';
  wizEngineChoice = engineInfo.engines.some(e => e.id === rec) ? rec : engineInfo.engines[0]?.id;
  box.innerHTML = engineInfo.engines.map(e => {
    const size = e.id === 'whisper' ? '2-4 GB download' : 'about 1 GB download';
    const badge = e.id === wizEngineChoice ? '<span class="badge">Recommended for your PC</span>' : '';
    return `<div class="wiz-engine-card${e.id === wizEngineChoice ? ' selected' : ''}" data-engine="${e.id}">
      <span class="name">${e.name}${badge}</span>
      <div class="blurb">${size}</div>
    </div>`;
  }).join('');
  box.querySelectorAll('.wiz-engine-card').forEach(c => c.addEventListener('click', () => {
    wizEngineChoice = c.dataset.engine;
    box.querySelectorAll('.wiz-engine-card').forEach(x => x.classList.toggle('selected', x === c));
  }));
  
  if (engineInfo.install_job && !engineInfo.install_job.done) {
    wizardStep('wiz-step-install');
    wizardPollInstall();
  } else {
    wizardStep('wiz-step-engine');
  }
}

function closeWizard() {
  
  if (engineInfo) engineInfo.wizard_done = true;
  fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wizard_done: true }),
  }).catch(() => {});
  wizardBackdrop.classList.remove('open');
}

function wizardPollInstall() {
  if (wizPollTimer) clearInterval(wizPollTimer);
  const progress = document.getElementById('wiz-progress');
  wizPollTimer = setInterval(async () => {
    try {
      const s = await (await fetch('/engines/install/status')).json();
      if (s.error) {
        clearInterval(wizPollTimer);
        wizPollTimer = null;
        progress.textContent = `Install failed: ${s.error}`;
        document.getElementById('wiz-install-back').style.display = '';
        return;
      }
      progress.textContent = `${s.phase} ${s.detail || ''}`;
      if (s.done) {
        clearInterval(wizPollTimer);
        wizPollTimer = null;
        await loadEngines();
        enterWizardSetup();
      }
    } catch {  }
  }, 1000);
}

function wizApplyMode(mode) {
  wizMode = mode;
  document.getElementById('wiz-src-mic').classList.toggle('active', mode === 'mic');
  document.getElementById('wiz-src-loopback').classList.toggle('active', mode === 'loopback');
  const list = mode === 'mic' ? allDevices.mic : allDevices.loopback;
  document.getElementById('wiz-device').innerHTML = list.length
    ? list.map(d => `<option value="${d.index}">${d.name}</option>`).join('')
    : `<option value="">No ${mode} devices</option>`;
}

async function enterWizardSetup() {
  wizardStep('wiz-step-setup');
  if (!allDevices.mic.length && !allDevices.loopback.length) await loadDevices();
  wizApplyMode(sourceMode);
  const eng = engineInfo.engines.find(e => e.id === wizEngineChoice);
  const langs = eng?.languages || [];
  const def = langs.includes(engineInfo.language) ? engineInfo.language
    : (langs.includes('en') ? 'en' : langs[0]);
  document.getElementById('wiz-lang').innerHTML = langs.map(c =>
    `<option value="${c}"${c === def ? ' selected' : ''}>${LANGUAGE_NAMES[c] || c}</option>`).join('');
  const wizTarget = document.getElementById('wiz-target');
  wizTarget.innerHTML = targetLangSelect.innerHTML;
  wizTarget.value = targetLangSelect.value;
}

document.getElementById('wiz-src-mic').addEventListener('click', () => wizApplyMode('mic'));
document.getElementById('wiz-src-loopback').addEventListener('click', () => wizApplyMode('loopback'));
document.getElementById('wiz-translate').addEventListener('change', (e) => {
  document.getElementById('wiz-target').disabled = !e.target.checked;
});
document.getElementById('wiz-install-back').addEventListener('click', () => wizardStep('wiz-step-engine'));

document.getElementById('wiz-skip').addEventListener('click', () => {
  closeWizard();
  setStatus('error', 'No engine installed. Open Settings to install one');
});

document.getElementById('wiz-install').addEventListener('click', async () => {
  const eng = engineInfo.engines.find(e => e.id === wizEngineChoice);
  if (eng?.installed) { enterWizardSetup(); return; }
  wizardStep('wiz-step-install');
  document.getElementById('wiz-install-back').style.display = 'none';
  try {
    const res = await fetch('/engines/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: wizEngineChoice })
    });
    
    if (!res.ok && res.status !== 409) {
      const p = await res.json().catch(() => ({}));
      throw new Error(p.detail || 'Install failed to start');
    }
    wizardPollInstall();
  } catch (e) {
    document.getElementById('wiz-progress').textContent = e.message;
    document.getElementById('wiz-install-back').style.display = '';
  }
});

document.getElementById('wiz-finish').addEventListener('click', async () => {
  const lang = document.getElementById('wiz-lang').value;
  const wizDevice = document.getElementById('wiz-device');
  applySourceMode(wizMode);
  if (wizDevice.value !== '') deviceSelect.value = wizDevice.value;
  onDeviceChanged(); 
  const eng = engineInfo.engines.find(e => e.id === wizEngineChoice);
  await sendControl({
    action: 'set_engine', engine: wizEngineChoice,
    model: engineInfo.engine_models[wizEngineChoice] || eng?.default_model,
  });
  if (lang) await sendControl({ action: 'set_language', language: lang });
  const target = document.getElementById('wiz-target').value;
  targetLangSelect.value = target;
  fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_language: target }),
  }).catch(() => {});
  const wantTranslate = document.getElementById('wiz-translate').checked;
  translateToggle.checked = wantTranslate;
  translationEnabled = wantTranslate;
  closeWizard();
  
  if (wizEngineChoice === 'parakeet' && lang === 'ja') {
    try {
      const info = await (await fetch('/models?engine=parakeet')).json();
      const ja = info.models.find(m => m.id === 'parakeet-ja');
      if (ja && !ja.installed) {
        await fetch('/models/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine: 'parakeet', model: 'parakeet-ja' }),
        });
        setStatus('connecting', 'Downloading the Japanese model (~620 MB)...');
        const t = setInterval(async () => {
          try {
            const s = await (await fetch('/engines/install/status')).json();
            if (!s.done) {
              setStatus('connecting', `Downloading Japanese model: ${s.detail || s.phase}`);
              return;
            }
            clearInterval(t);
            if (s.error) setStatus('error', 'Model download failed. See Settings > Engine');
            else setStatus('', 'Ready - press Start');
          } catch {  }
        }, 1000);
        return;
      }
    } catch {  }
  }
  if (wizEngineChoice === 'whisper') {
    setStatus('', 'Ready - the model downloads on first Start');
  } else {
    setStatus('', 'Ready - press Start');
  }
});

function parseTemp(id) {
  const v = document.getElementById(id).value;
  return v === '' ? 1.0 : parseFloat(v);
}

const configPanel    = document.getElementById('config-panel');
const configBackdrop = document.getElementById('config-backdrop');
const btnConfig      = document.getElementById('btn-config');
const configClose    = document.getElementById('config-close');
const cfgBackend     = document.getElementById('cfg-backend');
const cfgSave        = document.getElementById('cfg-save');
const cfgStatus      = document.getElementById('cfg-status');
const cfgEngine      = document.getElementById('cfg-engine');
const cfgModel       = document.getElementById('cfg-model');
const cfgModelRow    = document.getElementById('cfg-model-row');

cfgEngine.addEventListener('change', () => {
  updateModelSelect();
  updateEngineInstallUI();
  loadModels();
  const eng = selectedEngine();
  if (eng && eng.installed) applyEngine();
});
cfgModel.addEventListener('change', applyEngine);
document.getElementById('cfg-install-btn').addEventListener('click', installEngine);
document.getElementById('cfg-uninstall-btn').addEventListener('click', uninstallEngine);

const CFG_SECTIONS = ['deepl', 'openai', 'openrouter', 'lmstudio', 'libretranslate', 'ollama'];

function openConfigPanel() {
  configPanel.classList.add('open');
  configBackdrop.classList.add('open');
}

function closeConfigPanel() {
  configPanel.classList.remove('open');
  configBackdrop.classList.remove('open');
}

const configNav    = document.getElementById('config-nav');
const configFooter = document.getElementById('config-footer');

function switchSettingsPage(page) {
  configNav.querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.settings-page').forEach(s =>
    s.classList.toggle('active', s.id === `page-${page}`));
  
  configFooter.style.display = (page === 'translation' || page === 'phrases') ? '' : 'none';
  document.getElementById('config-body').scrollTop = 0;
  if (page === 'voices') window.ttsPacks?.reload?.();
}

configNav.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-page]');
  if (btn) switchSettingsPage(btn.dataset.page);
});
switchSettingsPage('engine');

function updateConfigSections() {
  CFG_SECTIONS.forEach(name => {
    const sec = document.getElementById(`cfg-${name}-section`);
    if (sec) sec.classList.toggle('visible', cfgBackend.value === name);
  });
  if (cfgBackend.value === 'lmstudio') loadLmstudioModels({ quiet: true });
}

function setLmstudioModel(id) {
  const sel = document.getElementById('cfg-lmstudio-model');
  if (!sel) return;
  if (id && !Array.from(sel.options).some(o => o.value === id)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = id;
    sel.appendChild(o);
  }
  sel.value = id || '';
}

async function loadLmstudioModels({ quiet = false } = {}) {
  const sel = document.getElementById('cfg-lmstudio-model');
  const note = document.getElementById('cfg-lmstudio-model-note');
  if (!sel) return;
  const keep = sel.value;
  const url = (document.getElementById('cfg-lmstudio-url').value || '').trim();
  if (!quiet && note) note.textContent = 'Loading…';
  try {
    const r = await fetch(`/translate/lmstudio/models?url=${encodeURIComponent(url)}`);
    const body = await r.json();
    if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
    const models = body.models || [];
    sel.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.id;
      const bits = [m.params, m.quant].filter(Boolean).join(' ');
      o.textContent = `${m.label}${bits ? `  (${bits})` : ''}`;
      o.title = m.id;
      sel.appendChild(o);
    }
    setLmstudioModel(keep);
    if (note) {
      note.textContent = models.length
        ? `${models.length} model${models.length === 1 ? '' : 's'} found`
        : 'LM Studio reported no usable models.';
    }
  } catch (e) {
    setLmstudioModel(keep);
    if (note) note.textContent = `Could not read the model list (${e.message}). ` +
      'Check LM Studio is running with its server started, then press ↻.';
  }
}

const lmstudioRefresh = document.getElementById('cfg-lmstudio-refresh');
if (lmstudioRefresh) lmstudioRefresh.addEventListener('click', () => loadLmstudioModels());

async function loadConfig() {
  try {
    const res = await fetch('/config');
    const c = await res.json();
    document.getElementById('cfg-system-prompt').value = c.system_prompt_override || c.default_system_prompt || '';
    document.getElementById('cfg-system-prompt').dataset.defaultPrompt = c.default_system_prompt || '';
    cfgBackend.value = c.translation_backend || 'google';
    document.getElementById('cfg-deepl-url').value           = c.deepl_api_url || '';
    document.getElementById('cfg-deepl-key').value           = c.deepl_api_key || '';
    document.getElementById('cfg-openai-url').value          = c.openai_base_url || '';
    document.getElementById('cfg-openai-key').value          = c.openai_api_key || '';
    document.getElementById('cfg-openai-model').value        = c.openai_model || '';
    document.getElementById('cfg-openai-temp').value         = c.openai_temperature ?? '';
    document.getElementById('cfg-openrouter-key').value      = c.openrouter_api_key || '';
    document.getElementById('cfg-openrouter-model').value    = c.openrouter_model || '';
    document.getElementById('cfg-openrouter-temp').value     = c.openrouter_temperature ?? '';
    document.getElementById('cfg-lmstudio-url').value        = c.lmstudio_url || '';
    setLmstudioModel(c.lmstudio_model || '');
    document.getElementById('cfg-lmstudio-temp').value       = c.lmstudio_temperature ?? '';
    document.getElementById('cfg-libretranslate-url').value  = c.libretranslate_url || '';
    document.getElementById('cfg-libretranslate-key').value  = c.libretranslate_api_key || '';
    document.getElementById('cfg-ollama-url').value          = c.ollama_url || '';
    document.getElementById('cfg-ollama-model').value        = c.ollama_model || '';
    document.getElementById('cfg-ollama-temp').value         = c.ollama_temperature ?? '';
    document.getElementById('cfg-blocked-phrases').value     = (c.blocked_phrases || []).join('\n');
    updateConfigSections();
  } catch (e) {
    console.error('Failed to load config:', e);
  }
}

btnConfig.addEventListener('click', async () => { await loadConfig(); openConfigPanel(); loadModels(); });
configClose.addEventListener('click', closeConfigPanel);
configBackdrop.addEventListener('click', closeConfigPanel);
cfgBackend.addEventListener('change', updateConfigSections);

cfgSave.addEventListener('click', async () => {
  cfgStatus.textContent = '';
  translationFailures = 0; 
  hideTranslateBanner();
  try {
    await fetch('/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_prompt_override: (() => {
          const el = document.getElementById('cfg-system-prompt');
          const val = el.value.trim();
          return val === (el.dataset.defaultPrompt || '').trim() ? '' : val;
        })(),
        translation_backend:    cfgBackend.value,
        deepl_api_url:          document.getElementById('cfg-deepl-url').value,
        deepl_api_key:          document.getElementById('cfg-deepl-key').value,
        openai_base_url:        document.getElementById('cfg-openai-url').value,
        openai_api_key:         document.getElementById('cfg-openai-key').value,
        openai_model:           document.getElementById('cfg-openai-model').value,
        openai_temperature:     parseTemp('cfg-openai-temp'),
        openrouter_api_key:     document.getElementById('cfg-openrouter-key').value,
        openrouter_model:       document.getElementById('cfg-openrouter-model').value,
        openrouter_temperature: parseTemp('cfg-openrouter-temp'),
        lmstudio_url:           document.getElementById('cfg-lmstudio-url').value,
        lmstudio_model:         document.getElementById('cfg-lmstudio-model').value,
        lmstudio_temperature:   parseTemp('cfg-lmstudio-temp'),
        libretranslate_url:     document.getElementById('cfg-libretranslate-url').value,
        libretranslate_api_key: document.getElementById('cfg-libretranslate-key').value,
        ollama_url:             document.getElementById('cfg-ollama-url').value,
        ollama_model:           document.getElementById('cfg-ollama-model').value,
        ollama_temperature:     parseTemp('cfg-ollama-temp'),
        blocked_phrases:        document.getElementById('cfg-blocked-phrases').value
                                  .split('\n').map(s => s.trim()).filter(Boolean),
      })
    });
    await loadBlockedPhrases();
    cfgStatus.style.color = '';
    cfgStatus.textContent = 'Saved ✓';
    setTimeout(() => { cfgStatus.textContent = ''; }, 2000);
  } catch (e) {
    cfgStatus.style.color = '#ef4444';
    cfgStatus.textContent = 'Save failed';
  }
});

btnStart.addEventListener('click', startTranscription);
btnStop.addEventListener('click', stopTranscription);
btnClear.addEventListener('click', () => {
  activeZone.innerHTML = '';
  historyZone.innerHTML = '';
  const d = document.createElement('div');
  d.id = 'empty-state';
  d.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:#444';
  d.innerHTML = '<div style="font-size:48px">🎙️</div><p style="font-size:16px">Press Start to begin transcription</p>';
  historyZone.appendChild(d);
  if (activeLineTimer) { clearTimeout(activeLineTimer); activeLineTimer = null; }
  activeLine = null;
  activeLineTime = null;
  shownChars = 0;
  latestLineLength = 0;
  lineCount = 0;
  lastCommittedText = '';
});

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setToolbarCredit(credit, termsUrl) {
  const chip = document.getElementById('tts-credit-chip');
  if (!chip) return;
  if (credit) {
    document.getElementById('tts-credit-chip-text').textContent = credit;
    
    const link = document.getElementById('tts-credit-chip-link');
    if (link) {
      if (termsUrl) link.href = termsUrl;
      else link.removeAttribute('href');
    }
    chip.style.display = 'inline-flex';
  } else {
    chip.style.display = 'none';
  }
}

(function () {
  const $ = (id) => document.getElementById(id);
  const panel = $('tts-panel');
  const backdrop = $('tts-backdrop');

  function showSection(which) {
    $('tts-install').style.display = which === 'install' ? '' : 'none';
    $('tts-starting').style.display = which === 'starting' ? '' : 'none';
    $('tts-form').style.display = which === 'form' ? '' : 'none';
  }

  async function loadDevices() {
    try {
      const d = await (await fetch('/tts/devices')).json();
      
      const sel = $('tts-device');
      sel.innerHTML = ['<option value="">System default</option>'].concat(
        d.devices.map((x) => `<option value="${escHtml(x.name)}">${escHtml(x.name)}${x.cable ? '  ← VB-Cable' : ''}</option>`)).join('');
      const cable = d.devices.find((x) => x.cable);
      const saved = d.devices.find((x) => x.name === d.selected);
      sel.value = saved ? saved.name : (cable ? cable.name : '');
      
      const mon = $('tts-monitor');
      mon.innerHTML = ['<option value="">Off</option>'].concat(
        d.devices.map((x) => `<option value="${escHtml(x.name)}">${escHtml(x.name)}</option>`)).join('');
      mon.value = d.devices.some((x) => x.name === d.monitor) ? d.monitor : '';
      
      $('tts-passthru').checked = !!d.passthru;
    } catch {  }
  }

  let byKey = {};     
  let idToKey = {};   

  function buildCharacters(packs) {
    byKey = {}; idToKey = {};
    const byEngine = {};
    const packName = {};
    packs.forEach((p) => { packName[p.id] = p.name; });
    packs.filter((p) => p.installed).forEach((p) => {
      const list = byEngine[p.id] || (byEngine[p.id] = []);
      if (p.id === 'voicevox') {
        const groups = {};
        (p.voices || []).forEach((v) => {
          const g = groups[v.speaker] || (groups[v.speaker] = {
            key: 'vv:' + v.speaker, engine: p.id, credit: v.credit || '',
            terms_url: v.terms_url || '', styles: [],
            label: v.speaker + (v.en ? ' (' + v.en + ')' : ''),
          });
          g.styles.push({ id: String(v.id), name: v.style || v.label, en: v.style_en || '' });
        });
        Object.values(groups).forEach((g) => list.push(g));
      } else {
        (p.voices || []).forEach((v) => list.push({
          key: p.id + ':' + v.id, engine: p.id, label: v.label,
          credit: v.credit || '', terms_url: v.terms_url || '', voiceId: String(v.id),
        }));
      }
    });
    Object.values(byEngine).flat().forEach((c) => {
      byKey[c.key] = c;
      if (c.styles) c.styles.forEach((s) => { idToKey[s.id] = c.key; });
      else idToKey[c.voiceId] = c.key;
    });
    return Object.entries(byEngine).map(([eng, cs]) =>
      `<optgroup label="${escHtml(packName[eng] || eng)}">` +
      cs.map((c) => `<option value="${escHtml(c.key)}">${escHtml(c.label)}</option>`).join('') +
      '</optgroup>').join('');
  }

  function populateStyles(charKey) {
    const c = byKey[charKey];
    const wrap = $('tts-style-wrap');
    if (c && c.styles) {
      $('tts-style').innerHTML = c.styles.map((s) =>
        `<option value="${escHtml(s.id)}">${escHtml(s.name)}${s.en ? ' (' + escHtml(s.en) + ')' : ''}</option>`).join('');
      wrap.style.display = '';
    } else {
      $('tts-style').innerHTML = '';
      wrap.style.display = 'none';
    }
  }

  function currentVoiceId() {
    const c = byKey[$('tts-voice').value];
    if (!c) return '';
    return c.styles ? $('tts-style').value : c.voiceId;
  }

  function updateCredit() {
    const c = byKey[$('tts-voice').value];
    const has = !!(c && c.credit);
    $('tts-credit').style.display = has ? '' : 'none';
    if (has) {
      $('tts-credit-text').textContent = c.credit;
      const terms = $('tts-credit-terms');
      if (c.terms_url) { terms.href = c.terms_url; terms.style.display = ''; }
      else terms.style.display = 'none';
    }
    setToolbarCredit(has ? c.credit : '', has ? c.terms_url : '');
  }

  async function refreshState() {
    let s;
    try {
      s = await (await fetch('/tts/status')).json();
    } catch {
      $('tts-starting-text').textContent = 'Error contacting the app.';
      showSection('starting');
      return;
    }
    if (!s.installed) { showSection('install'); return; }
    $('tts-voice').innerHTML = buildCharacters(s.packs || []);
    const sel = String(s.selected_voice || '');
    const key = idToKey[sel] || ($('tts-voice').options[0] || {}).value || '';
    if (key) $('tts-voice').value = key;
    populateStyles($('tts-voice').value);
    const c = byKey[$('tts-voice').value];
    if (c && c.styles && c.styles.some((st) => st.id === sel)) $('tts-style').value = sel;
    updateCredit();
    await loadDevices();
    showSection('form');
  }

  function persistSelection(patch) {
    fetch('/tts/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {});
  }

  async function speak() {
    const text = $('tts-text').value.trim();
    if (!text) { $('tts-status').textContent = 'Enter some text first.'; return; }
    const btn = $('tts-speak-btn');
    btn.disabled = true;
    
    $('tts-status').textContent = 'Working…';
    try {
      const res = await fetch('/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice: currentVoiceId(),
          speed: parseFloat($('tts-speed').value),
          device: $('tts-device').value,
          monitor: $('tts-monitor').value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) $('tts-status').textContent = 'Error: ' + (data.detail || res.status);
      else $('tts-status').textContent = `Played ${data.duration.toFixed(2)}s of audio.`;
    } catch (e) {
      $('tts-status').textContent = 'Error: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  function openVoicesSettings() {
    close();
    if (typeof openConfigPanel === 'function') openConfigPanel();
    if (typeof switchSettingsPage === 'function') switchSettingsPage('voices');
  }

  function open() {
    panel.classList.add('open');
    backdrop.classList.add('open');
    refreshState();
  }

  function close() {
    panel.classList.remove('open');
    backdrop.classList.remove('open');
  }

  $('btn-speak').addEventListener('click', open);
  $('tts-close').addEventListener('click', close);
  backdrop.addEventListener('click', close);
  $('tts-speak-btn').addEventListener('click', speak);
  $('tts-open-voices').addEventListener('click', openVoicesSettings);
  $('tts-manage-voices').addEventListener('click', (e) => { e.preventDefault(); openVoicesSettings(); });
  $('tts-voice').addEventListener('change', () => {
    populateStyles($('tts-voice').value);
    updateCredit();
    persistSelection({ voice: currentVoiceId() });
  });
  $('tts-style').addEventListener('change', () => {
    updateCredit();
    persistSelection({ voice: currentVoiceId() });
  });
  $('tts-device').addEventListener('change', (e) => persistSelection({ device: e.target.value }));
  $('tts-monitor').addEventListener('change', (e) => persistSelection({ monitor: e.target.value }));
  $('tts-passthru').addEventListener('change', (e) => {
    const enabled = e.target.checked;
    fetch('/tts/passthru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).then((r) => r.json()).then((d) => {
      
      if (enabled && d && d.active === false) {
        e.target.checked = false;
        $('tts-status').textContent = 'Could not start mic passthru (check the mic/cable device).';
      }
    }).catch(() => { e.target.checked = !enabled; });
  });
  $('tts-credit-copy').addEventListener('click', () => {
    navigator.clipboard?.writeText($('tts-credit-text').textContent || '').catch(() => {});
  });
  $('tts-speed').addEventListener('input', (e) => {
    $('tts-speed-val').textContent = (+e.target.value).toFixed(2) + '×';
  });

  async function prepare() {
    let s;
    try { s = await (await fetch('/tts/status')).json(); } catch { return 'error'; }
    if (!s.installed) return 'not-installed';
    if (s.running) return 'ready';
    fetch('/tts/start', { method: 'POST' }).catch(() => {});
    return 'starting'; 
  }
  async function speakLine(text) {
    const t = (text || '').trim();
    if (!t) return;
    try {
      const res = await fetch('/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t }),
      });
      const data = await res.json().catch(() => ({}));
      if (typeof data.gen_ms === 'number') { latency.tts = data.gen_ms; renderLatency(); }
    } catch {  }
  }
  
  async function refreshCredit() {
    let s;
    try { s = await (await fetch('/tts/status')).json(); } catch { return; }
    const installed = !!s.installed;
    const btn = document.getElementById('btn-speak');
    const lbl = document.getElementById('speak-toggle-label');
    if (btn) btn.style.display = installed ? '' : 'none';
    if (lbl) lbl.style.display = installed ? 'flex' : 'none';
    if (!installed) {
      const tog = document.getElementById('speak-toggle');
      if (tog) tog.checked = false;   
      setToolbarCredit('');
      return;
    }
    let credit = '', termsUrl = '';
    for (const p of s.packs || []) {
      if (!p.installed) continue;
      const v = (p.voices || []).find((x) => x.id === s.selected_voice);
      if (v) { credit = v.credit || ''; termsUrl = v.terms_url || ''; break; }
    }
    setToolbarCredit(credit, termsUrl);
  }
  window.ttsApi = { prepare, speakLine, refreshCredit, reopen: refreshState };
})();

(function () {
  const $ = (id) => document.getElementById(id);
  let pollTimer = null;
  let pending = null; 

  async function reload() {
    let s;
    try { s = await (await fetch('/tts/status')).json(); } catch { return; }
    const list = $('cfg-tts-list');
    const vc = s.vc_runtime;
    list.innerHTML = (s.packs || []).map((p) => {
      const langs = (p.languages || []).join(', ').toUpperCase();
      const right = p.installed
        ? `<span class="tts-pack-ok">Installed ✓</span>${p.source === 'installed'
            ? ` <button class="tts-pack-btn tts-pack-remove" data-engine="${escHtml(p.id)}">Uninstall</button>` : ''}`
        : `<button class="tts-pack-btn tts-pack-install" data-engine="${escHtml(p.id)}">Install</button>`;
      const note = p.agreement_required
        ? `<div class="tts-pack-note">Requires accepting the VOICEVOX terms · credit each clip “${escHtml((p.voices[0] || {}).credit || 'VOICEVOX:キャラ名')}”.</div>`
        : '';
      
      const vcNote = (p.needs_vc_runtime && vc && !vc.ok)
        ? `<div class="tts-pack-warn">Needs the Microsoft Visual C++ runtime, which this PC is missing.
           <a href="${escHtml(vc.url)}">Get it from Microsoft ↗</a> (one time, then restart the app).</div>`
        : '';
      return `<div class="tts-pack-row">
        <div class="tts-pack-info"><span class="tts-pack-name">${escHtml(p.name)}</span>
        <span class="tts-pack-lang">${escHtml(langs)}</span>${note}${vcNote}</div>
        <div class="tts-pack-actions">${right}</div></div>`;
    }).join('') || '<p style="font-size:12px;color:#777;">No voice packs found.</p>';

    list.querySelectorAll('.tts-pack-install').forEach((b) =>
      b.addEventListener('click', () => onInstall(b.dataset.engine, s)));
    list.querySelectorAll('.tts-pack-remove').forEach((b) =>
      b.addEventListener('click', () => onUninstall(b.dataset.engine, s)));
    
    window.ttsApi?.refreshCredit?.();
    reloadCatalog();
  }

  let catalog = [];
  let dlPollTimer = null;

  async function reloadCatalog() {
    const section = $('cfg-tts-catalog-section');
    let c;
    try { c = await (await fetch('/tts/catalog')).json(); } catch { section.style.display = 'none'; return; }
    if (!c.engine_installed || !(c.characters || []).length) { section.style.display = 'none'; return; }
    section.style.display = '';
    catalog = c.characters;
    renderCatalog();
    if (c.download && !c.download.done) pollDownload();
  }

  function renderCatalog() {
    const q = ($('cfg-tts-catalog-filter').value || '').trim().toLowerCase();
    const rows = catalog.filter((c) => !q || c.speaker.toLowerCase().includes(q)
      || (c.en || '').toLowerCase().includes(q)).map((c) => {
      const total = c.styles.length;
      const label = c.downloaded ? '<span class="tts-pack-ok">Installed ✓</span>'
        : c.styles_available > 0
          ? `<button class="tts-pack-btn tts-char-get" data-speaker="${escHtml(c.speaker)}">Get ${total - c.styles_available} more</button>`
          : `<button class="tts-pack-btn tts-char-get" data-speaker="${escHtml(c.speaker)}">Download</button>`;
      const terms = c.terms_url ? `<a class="tts-link" href="${escHtml(c.terms_url)}" target="_blank" rel="noopener">terms ↗</a>` : '';
      const name = escHtml(c.speaker) + (c.en ? ` <span class="tts-char-en">${escHtml(c.en)}</span>` : '');
      return `<div class="tts-char-row">
        <div class="tts-char-info"><span class="tts-char-name">${name}</span>
        <span class="tts-char-sub">${total} style${total === 1 ? '' : 's'} · ${escHtml(c.credit)}</span></div>
        <div class="tts-char-actions">${terms}${label}</div></div>`;
    }).join('');
    $('cfg-tts-catalog-list').innerHTML = rows || '<p style="font-size:12px;color:#777;">No matches.</p>';
    $('cfg-tts-catalog-list').querySelectorAll('.tts-char-get').forEach((b) =>
      b.addEventListener('click', () => downloadVoice(b.dataset.speaker, b)));
  }

  async function downloadVoice(speaker, btn) {
    btn.disabled = true;
    try {
      const res = await fetch('/tts/voices/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speaker }),
      });
      if (!res.ok) {
        const p = await res.json().catch(() => ({}));
        $('cfg-tts-catalog-progress').textContent = p.detail || 'Download failed to start';
        btn.disabled = false;
        return;
      }
      pollDownload();
    } catch (e) { $('cfg-tts-catalog-progress').textContent = e.message; btn.disabled = false; }
  }

  function pollDownload() {
    if (dlPollTimer) clearInterval(dlPollTimer);
    const prog = $('cfg-tts-catalog-progress');
    dlPollTimer = setInterval(async () => {
      let s;
      try { s = await (await fetch('/tts/voices/download/status')).json(); } catch { return; }
      prog.textContent = s.error ? 'Download failed (see log).'
        : s.done ? '' : `Downloading ${s.speaker}… ${s.detail || ''}`;
      if (s.done) {
        clearInterval(dlPollTimer); dlPollTimer = null;
        if (!s.error) prog.textContent = `Added ${s.speaker} ✓`;
        reloadCatalog();                 
        window.ttsApi?.refreshCredit?.(); 
      }
    }, 1000);
  }

  document.getElementById('cfg-tts-catalog-filter')
    .addEventListener('input', () => renderCatalog());

  function onInstall(engine, status) {
    const pack = (status.packs || []).find((p) => p.id === engine);
    
    if (pack && pack.agreement_required) {
      showAgreement(pack);
    } else {
      startInstall(engine);
    }
  }

  function showAgreement(pack) {
    pending = { engine: pack.id };
    const lic = pack.license || {};
    $('cfg-tts-agree-title').textContent = lic.name || 'License terms';
    $('cfg-tts-agree-summary').textContent = lic.summary || '';
    $('cfg-tts-agree-links').innerHTML = (lic.terms_urls || []).map((t) =>
      `<a href="${escHtml(t.url)}" target="_blank" rel="noopener">${escHtml(t.label)} ↗</a>`).join('');
    $('cfg-tts-agree-box').checked = false;
    $('cfg-tts-agree-continue').disabled = true;
    $('cfg-tts-agree').style.display = '';
  }

  function hideAgreement() {
    pending = null;
    $('cfg-tts-agree').style.display = 'none';
  }

  async function acceptAndInstall() {
    if (!pending) return;
    const engine = pending.engine;
    try {
      await fetch('/tts/accept', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine }),
      });
    } catch {  }
    hideAgreement();
    startInstall(engine);
  }

  async function startInstall(engine) {
    const prog = $('cfg-tts-progress');
    prog.textContent = 'Starting…';
    try {
      const res = await fetch('/engines/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine }),
      });
      if (!res.ok) {
        const p = await res.json().catch(() => ({}));
        prog.textContent = p.detail || 'Install failed to start';
        return;
      }
      poll();
    } catch (e) { prog.textContent = e.message; }
  }

  function poll() {
    if (pollTimer) clearInterval(pollTimer);
    const prog = $('cfg-tts-progress');
    pollTimer = setInterval(async () => {
      let s;
      try { s = await (await fetch('/engines/install/status')).json(); } catch { return; }
      prog.textContent = s.error ? 'Install failed (see log).' : `${s.phase} ${s.detail || ''}`;
      if (s.done) {
        clearInterval(pollTimer); pollTimer = null;
        if (!s.error) prog.textContent = 'Installed ✓';
        reload();
      }
    }, 1000);
  }

  async function onUninstall(engine, status) {
    const pack = (status.packs || []).find((p) => p.id === engine);
    if (!confirm(`Uninstall ${pack ? pack.name : engine}? Its runtime is removed; downloaded voice models are kept and it can be reinstalled anytime.`)) return;
    try {
      await fetch('/engines/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine }),
      });
    } catch {  }
    reload();
  }

  $('cfg-tts-agree-box').addEventListener('change', (e) => {
    $('cfg-tts-agree-continue').disabled = !e.target.checked;
  });
  $('cfg-tts-agree-continue').addEventListener('click', acceptAndInstall);
  $('cfg-tts-agree-cancel').addEventListener('click', hideAgreement);

  window.ttsPacks = { reload };
})();

document.getElementById('tts-credit-chip-copy')?.addEventListener('click', () => {
  navigator.clipboard?.writeText(document.getElementById('tts-credit-chip-text').textContent || '').catch(() => {});
});
window.ttsApi?.refreshCredit?.();