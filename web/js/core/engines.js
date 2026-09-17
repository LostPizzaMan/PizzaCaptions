import { state } from '../lib/state.js';

const ENGINE_ORDER = ['whisper-batch', 'parakeet', 'nano', 'qwen3', 'whisper', 'parakeet-stream', 'nemotron-stream'];

export function engById(id) {
  return state.engineInfo && state.engineInfo.engines.filter(function (e) { return e.id === id; })[0];
}

export function engRank(id) {
  var i = ENGINE_ORDER.indexOf(id);
  return i < 0 ? ENGINE_ORDER.length : i;
}

export function engName(id) {
  var e = engById(id);
  return e ? e.name : (id || '-');
}

export function engShort(id) { return engName(id).replace(/\s*\([^)]*\)\s*$/, '').trim(); }
