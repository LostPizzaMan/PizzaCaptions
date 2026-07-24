let userClosing = false;
let isReconnecting = false;
let sourceMode = 'mic'; 
let controlWs = null;
let allDevices = { mic: [], loopback: [] };
let savedDeviceNames = { mic: '', loopback: '' };

let activeLine = null;
let activeLineTimer = null;
let activeLineTime = null;

let shownChars = 0;
let latestLineLength = 0;

let lineCount = 0;
let lastCommittedText = '';
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

function normalizeForBlocklist(text) {
  return (text || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function isBlockedLine(text) {
  const norm = normalizeForBlocklist(text);
  if (!norm) return false;
  return blockedPhrases.some(p => norm.includes(p));
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

  for (let size = maxOverlap; size >= 1; size--) {
    const committedSuffix = normalizedCommitted.slice(-size);
    if (text.startsWith(committedSuffix)) {
      return text.slice(size).trimStart();
    }
  }

  return text;
}

function buildOscPayload(originalText, translatedText = '') {
  const original = (originalText || '').trim();
  const translated = (translatedText || '').trim();
  if (!translated) return original.slice(-OSC_MAX_CHARS);

  const separator = '\n';
  const combined = `${original}${separator}${translated}`;
  if (combined.length <= OSC_MAX_CHARS) return combined;

  const translatedBudget = Math.min(translated.length, Math.floor(OSC_MAX_CHARS * 0.55));
  const originalBudget = Math.max(0, OSC_MAX_CHARS - separator.length - translatedBudget);
  const clippedOriginal = original.slice(-originalBudget);
  const clippedTranslated = translated.slice(0, translatedBudget);
  return `${clippedOriginal}${separator}${clippedTranslated}`.slice(0, OSC_MAX_CHARS);
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
      await sendOscTranscript(text);
      await stopOscTyping();
      return;
    }

    const translatedText = payload.translated || '';
    translationFailures = 0;
    setSegmentTranslation(segment, translatedText);
    await sendOscTranscript(text, translatedText);
    await stopOscTyping();
  } catch (err) {
    setSegmentTranslation(segment, `[Translation unavailable] ${err.message}`);
    noteTranslationFailure(err.message);
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
  const text = activeLine.querySelector('.text').textContent.trim();
  if (text && isBlockedLine(text)) {
    console.warn('Blocked phrase filtered:', text);
    shownChars = latestLineLength;
    lastCommittedText = text;
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
    lastCommittedText = text;
    if (translationEnabled) requestTranslation(text, hist);
    else sendOscTranscript(text).then(stopOscTyping).catch(console.error);
  }
  activeZone.innerHTML = '';
  activeLine = null;
  activeLineTime = null;
}

function resetSilenceTimer() {
  if (activeLineTimer) clearTimeout(activeLineTimer);
  activeLineTimer = setTimeout(() => {
    commitActiveLine();
    activeLineTimer = null;
  }, 1250);
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
  if (text.length >= SOFT_LENGTH_LIMIT && endsWithSentenceEnder(text)) {
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

    const count = data.line_count ?? visible.length;
    if (count !== lineCount) {
      if (count > lineCount) commitActiveLine();
      lineCount = count;
      shownChars = 0;
      lastCommittedText = ''; 
    }

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

  } catch (e) {
    if (typeof event.data === 'string' && event.data.trim()) {
      updateActiveLine(event.data);
    }
  }
}

function openControlWs() {
  if (controlWs && controlWs.readyState <= WebSocket.OPEN) return;
  controlWs = new WebSocket(`ws://${location.host}/control`);
  controlWs.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'audio_level') {
        levelBar.style.width = `${Math.round(msg.level * 100)}%`;
        levelBar.classList.toggle('gated', msg.gated);
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
        setStatus('live', 'Live');
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
}

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
    document.getElementById('cfg-lmstudio-model').value      = c.lmstudio_model || '';
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