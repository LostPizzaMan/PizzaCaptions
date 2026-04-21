// State
let userClosing = false;
let isReconnecting = false;
let sourceMode = 'mic'; // 'mic' | 'loopback'
let controlWs = null;
let allDevices = { mic: [], loopback: [] };

// Transcript state
let activeLine = null;
let activeLineTimer = null;
let activeLineTime = null;
let shownChars = 0;
let lastCommittedText = '';
let translationEnabled = false;

// DOM
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
const translateToggle = document.getElementById('translate-toggle');
const sourceLangSelect = document.getElementById('lang-select');
const targetLangSelect = document.getElementById('target-lang-select');
const srcMicBtn     = document.getElementById('src-mic');
const srcLoopBtn    = document.getElementById('src-loopback');
const deviceSelect  = document.getElementById('device-select');

const TRANSCRIPTION_TO_TRANSLATION_SOURCE = {
  ja: 'ja-JP',
  en: 'en-US',
  zh: 'zh-CN',
  ko: 'ko-KR',
  fr: 'fr-FR',
  es: 'es-ES',
  pt: 'pt-BR',
  de: 'de-DE',
  ru: 'ru-RU',
  ar: 'ar-SA',
  ms: 'ms-MY',
  th: 'th-TH',
  tr: 'tr-TR',
  auto: ''
};

function hasRepetition(text) {
  if (!text || text.length < 3) return false;

  // Normalize text (remove spaces/punctuation)
  const normalized = text.replace(/\s+/g, '').replace(/[。、.,!?！？]/g, '');

  // 1. Repeated char/phrase (1-20 chars repeated 3+ times)
  if (/(.{1,20})\1{2,}/.test(normalized)) return true;

  return false;
}

// UI helpers

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
      await sendOscTranscript(text);
      await stopOscTyping();
      return;
    }

    const translatedText = payload.translated || '';
    setSegmentTranslation(segment, translatedText);
    await sendOscTranscript(text, translatedText);
    await stopOscTyping();
  } catch (err) {
    setSegmentTranslation(segment, `[Translation unavailable] ${err.message}`);
    await sendOscTranscript(text);
    await stopOscTyping();
  }
}

// Transcript helpers

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
  if (text) {
    shownChars += text.length;
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

function updateActiveLine(text) {
  ensureActiveLine();
  activeLine.querySelector('.text').textContent = text;
  if (text.length >= SOFT_LENGTH_LIMIT && SENTENCE_ENDERS.test(text.slice(-2))) {
    if (activeLineTimer) { clearTimeout(activeLineTimer); activeLineTimer = null; }
    commitActiveLine();
  } else {
    resetSilenceTimer();
  }
}

// Server message handler

function handleServerMessage(event) {
  try {
    const data = JSON.parse(event.data);
    if (data.type === 'config' || data.type === 'ready_to_stop') return;

    const lines = Array.isArray(data.lines) ? data.lines : [];
    const latest = lines.filter(l => l.speaker !== -2 && (l.text || '').trim()).pop();
    if (!latest) return;

    const fullText = latest.text.trim();
    rawFeed.textContent = fullText;

    if (fullText.length < shownChars) shownChars = 0;

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

    // Ignore if only punctuation
    if (/^[。．？！?!.,\s]+$/.test(dedupedText)) return;

    const currentText = activeLine ? activeLine.querySelector('.text').textContent : '';
    if (dedupedText !== currentText) updateActiveLine(dedupedText);

  } catch (e) {
    if (typeof event.data === 'string' && event.data.trim()) {
      updateActiveLine(event.data);
    }
  }
}

// WebSocket

function openControlWs() {
  if (controlWs && controlWs.readyState <= WebSocket.OPEN) return;
  controlWs = new WebSocket(`ws://${location.host}/control`);
  controlWs.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.error) { console.error('Control:', msg.error); return; }
      if (msg.status === 'capture_started' || msg.status === 'capture_stopped') return;
      if (msg.status === 'language_loading') { setStatus('connecting', `Loading ${msg.language}...`); return; }
      if (msg.status === 'language_set') { setStatus('connecting', `Model loading... (${msg.language})`); sourceLangSelect.value = msg.language; return; }
      if (msg.type === 'config') {
        setStatus('live', 'Live');
        btnStop.disabled = false;
        return;
      }
      handleServerMessage(e);
    } catch {}
  });
  controlWs.addEventListener('close', () => {
    if (userClosing) return;
    // Server restarted (e.g. language change) - reconnect and resume capture
    setStatus('connecting', 'Reconnecting...');
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

// Device loading

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
}

// Source toggle

srcMicBtn.addEventListener('click', () => {
  sourceMode = 'mic';
  srcMicBtn.classList.add('active');
  srcLoopBtn.classList.remove('active');
  populateDeviceSelect();
});

srcLoopBtn.addEventListener('click', () => {
  sourceMode = 'loopback';
  srcLoopBtn.classList.add('active');
  srcMicBtn.classList.remove('active');
  populateDeviceSelect();
});

// Start / Stop / Reconnect

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
    btnStop.disabled = false;
  } catch (err) {
    console.error(err);
    setStatus('error', `Error: ${err.message}`);
    btnStart.disabled = false;
  }
}

async function stopTranscription() {
  userClosing = true;
  if (activeLineTimer) { clearTimeout(activeLineTimer); activeLineTimer = null; }
  commitActiveLine();
  shownChars = 0;
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
  lastCommittedText = '';
  try {
    setStatus('connecting', 'Reconnecting...');
    const deviceIndex = deviceSelect.value !== '' ? parseInt(deviceSelect.value) : null;
    if (deviceIndex !== null) await sendControl({ action: 'start_capture', device_index: deviceIndex });
    setStatus('live', 'Live');
  } catch (e) {
    console.error('Reconnect failed:', e);
    setStatus('error', 'Reconnect failed');
    resetUI();
  } finally {
    isReconnecting = false;
  }
}

// Init

loadDevices();

sourceLangSelect.addEventListener('change', (e) => {
  userClosing = false; // allow the WS close handler to reconnect after server restart
  if (isCapturing()) setStatus('connecting', 'Restarting...');
  sendControl({ action: 'set_language', language: e.target.value });
});

deviceSelect.addEventListener('change', () => {
  micLabel.textContent = deviceSelect.selectedOptions[0]?.text || '';
  if (isCapturing()) {
    reconnect();
  }
});

targetLangSelect.addEventListener('change', () => {
  if (!translateToggle.checked) return;
  const firstTranslation = historyZone.querySelector('.segment.final .translation');
  if (firstTranslation) {
    setStatus('', `Translate to ${targetLangSelect.selectedOptions[0]?.text || targetLangSelect.value}`);
  }
});

oscToggle.addEventListener('change', () => {
  if (!oscToggle.checked) {
    sendControl({ action: 'osc_typing', flag: false });
  }
});

translateToggle.addEventListener('change', () => {
  translationEnabled = translateToggle.checked;
});

// Config panel

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

const CFG_SECTIONS = ['deepl', 'openai', 'openrouter', 'lmstudio', 'libretranslate', 'ollama'];

function openConfigPanel() {
  configPanel.classList.add('open');
  configBackdrop.classList.add('open');
}

function closeConfigPanel() {
  configPanel.classList.remove('open');
  configBackdrop.classList.remove('open');
}

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
    updateConfigSections();
  } catch (e) {
    console.error('Failed to load config:', e);
  }
}

btnConfig.addEventListener('click', async () => { await loadConfig(); openConfigPanel(); });
configClose.addEventListener('click', closeConfigPanel);
configBackdrop.addEventListener('click', closeConfigPanel);
cfgBackend.addEventListener('change', updateConfigSections);

cfgSave.addEventListener('click', async () => {
  cfgStatus.textContent = '';
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

      })
    });
    cfgStatus.style.color = '';
    cfgStatus.textContent = 'Saved ✓';
    setTimeout(() => { cfgStatus.textContent = ''; }, 2000);
  } catch (e) {
    cfgStatus.style.color = '#ef4444';
    cfgStatus.textContent = 'Save failed';
  }
});

// Button handlers

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
  lastCommittedText = '';
});