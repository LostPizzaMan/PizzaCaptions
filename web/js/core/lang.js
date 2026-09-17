import { state } from '../lib/state.js';

var LANG_DATA = {};
var TR_SUPPORTED = {};
var LANGUAGE_NAMES = {};
var TRANS_SRC = {};

export function setLangData(data) {
  LANG_DATA = data || {};
  LANGUAGE_NAMES = {}; TRANS_SRC = {};
  Object.keys(LANG_DATA).forEach(function (code) {
    var e = LANG_DATA[code] || {};
    if (e.name) LANGUAGE_NAMES[code] = e.name;
    TRANS_SRC[code] = e.src || '';
  });
}
export function setSupportedTargets(map) { TR_SUPPORTED = map || {}; }

export function langName(code) { return LANGUAGE_NAMES[code] || code; }
export function transSrc(code) { return TRANS_SRC[code] || ''; }

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

export function targetLangOpts(backend) {
  var bk = backend === undefined ? state.translateBackend : backend;
  var out = buildTargetOpts();
  var allow = TR_SUPPORTED[bk];
  if (allow && allow.length) {
    var set = {}; allow.forEach(function (c) { set[c] = 1; });
    out = out.filter(function (o) { return set[o.v]; });
  }
  return out;
}

export function tgtName(code) {
  var hit = buildTargetOpts().filter(function (o) { return o.v === code; })[0];
  return hit ? hit.n : code;
}
