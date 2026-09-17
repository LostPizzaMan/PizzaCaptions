const JSON_HEADERS = { 'Content-Type': 'application/json' };

function getJSON(path) {
  return fetch(path).then(function (r) { return r.json(); });
}
function post(path) {
  return fetch(path, { method: 'POST' });
}
function postJSON(path, body) {
  return fetch(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function getConfig() { return getJSON('/config'); }
export function saveConfig(patch) { return postJSON('/config', patch); }

export function getEngines() { return getJSON('/engines'); }
export function getDevices() { return getJSON('/devices'); }
export function getEngineStartup() { return getJSON('/engine/startup'); }
export function getInstallStatus() { return getJSON('/engines/install/status'); }
export function installEngine(engine) { return postJSON('/engines/install', { engine: engine }); }
export function removeEngine(engine) { return postJSON('/engines/remove', { engine: engine }); }

export function getModels(engine) { return getJSON('/models?engine=' + encodeURIComponent(engine)); }
export function downloadModel(engine, model) { return postJSON('/models/download', { engine: engine, model: model }); }
export function cancelDownload() { return post('/models/download/cancel'); }
export function deleteModel(engine, model) { return postJSON('/models/delete', { engine: engine, model: model }); }

export function translate(body) { return postJSON('/translate', body); }
export function getLmstudioModels(url) { return getJSON('/translate/lmstudio/models?url=' + encodeURIComponent(url)); }

export function getCaptionsOverlayState() { return getJSON('/captions/overlay/state'); }
export function getCaptionsSourceStatus() { return getJSON('/captions/source/status'); }
export function setCaptionsOverlay(on) { return post('/captions/overlay/' + (on ? 'show' : 'hide')); }
export function setCaptionsOverlaySource(source) { return postJSON('/captions/overlay/source', { source: source }); }
export function setCaptionsOverlayReading(mode) { return postJSON('/captions/overlay/reading', { mode: mode }); }
export function setCaptionsOverlayPref(kind, on) { return postJSON('/captions/overlay/' + kind, { on: on }); }

export function setCaptionsOverlayContent(mode) { return postJSON('/captions/overlay/content', { mode: mode }); }
export function setCaptionsOverlayMaxLines(lines) { return postJSON('/captions/overlay/maxlines', { lines: lines }); }
export function setCaptionsOverlayTextScale(scale) { return postJSON('/captions/overlay/textscale', { scale: scale }); }

export function setScreenOverlay(on) { return post('/overlay/' + (on ? 'show' : 'hide')); }

export function getOcrStatus() { return getJSON('/ocr/status'); }
export function startOcr() { return post('/ocr/start'); }
export function stopOcr() { return post('/ocr/stop'); }

export function speak(body) { return postJSON('/tts/speak', body); }
export function stopTts() { return post('/tts/stop'); }
export function getTtsDevices() { return getJSON('/tts/devices'); }
export function getTtsStatus() { return getJSON('/tts/status'); }
export function getTtsCatalog() { return getJSON('/tts/catalog'); }
export function selectTts(patch) { return postJSON('/tts/select', patch); }
export function setTtsPassthru(on) { return postJSON('/tts/passthru', { enabled: on }); }
export function acceptTts(engine) { return postJSON('/tts/accept', { engine: engine }); }
export function downloadVoice(speaker) { return postJSON('/tts/voices/download', { speaker: speaker }); }
export function getVoiceDownloadStatus() { return getJSON('/tts/voices/download/status'); }

export function getLangStatus() { return getJSON('/lang/status'); }
export function downloadLang() { return post('/lang/download'); }
export function removeLang() { return post('/lang/remove'); }
export function getTokenizer() { return getJSON('/lang/tokenizer'); }
export function enableTokenizer(on) { return postJSON('/lang/tokenizer/enable', { on: on }); }
export function downloadTokenizer() { return post('/lang/tokenizer/download'); }
export function removeTokenizer() { return post('/lang/tokenizer/remove'); }
export function getLangJson() { return getJSON('/lang.json'); }

export function getVersion() { return getJSON('/version'); }
export function checkUpdate(force) { return getJSON('/update/check' + (force ? '?force=1' : '')); }
export function openUpdate() { return post('/update/open'); }
export function openExternal(url) { return postJSON('/open-external', { url: url }); }
export function createShortcut() { return post('/shortcut/create'); }
export function getAudioPrograms() { return getJSON('/audio/programs'); }
