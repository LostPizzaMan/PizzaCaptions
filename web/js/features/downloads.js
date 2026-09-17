import { $ } from '../lib/util.js';
import * as api from '../lib/api.js';
import { foot, toast } from '../lib/ui.js';
import { engName } from '../core/engines.js';
import { pollInstall } from './settings.js';

let host = null;
export function initDownloads(h) { host = h; }

var _dlpCancelled = false;
function dlpUpdate(st) {
  var d = (st && st.detail) || '';

  var fill = $('#dlp-fill');
  var frac = (st && typeof st.progress === 'number' && isFinite(st.progress)) ? st.progress : null;
  if (frac !== null) {
    var pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    fill.classList.remove('indet'); fill.style.width = pct + '%';
    $('#dlp-pct').textContent = pct + '%'; $('#dlp-size').textContent = d;
  } else {
    fill.classList.add('indet'); $('#dlp-pct').textContent = 'Downloading…';
    $('#dlp-size').textContent = d && d.indexOf('%') < 0 ? d : '';
  }
}
var dlpCancelBtn = $('#dlp-cancel');
if (dlpCancelBtn) dlpCancelBtn.addEventListener('click', function () {
  _dlpCancelled = true; dlpCancelBtn.disabled = true; dlpCancelBtn.textContent = 'Cancelling…';
  api.cancelDownload().catch(function () {});
});

export async function runModelDownload(engine, md) {
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
    host.refreshStatus();
    return false;
  }
  try {
    var resp = await api.downloadModel(engine, md.id);
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
