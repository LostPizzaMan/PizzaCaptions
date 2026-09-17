var ALNUM = /[\p{L}\p{N}]/u;
var UNSPACED = /[぀-ヿ㐀-䶿一-鿿豈-﫿฀-๿\u{20000}-\u{2fa1f}]/u;
var OTHER_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
var WORTH_SHOWING = /[\p{Script=Latin}\p{Nd}]/u;
var SENTENCE_ENDERS = /[。．！？!?]/;

export function normalizeForBlocklist(t) { return (t || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase(); }

function normalizeWithMap(chars) {
  var norm = '', map = [];
  chars.forEach(function (ch, i) {
    if (!ALNUM.test(ch)) return;
    var low = ch.toLowerCase(); norm += low;
    for (var k = 0; k < low.length; k++) map.push(i);
  });
  return { norm: norm, map: map };
}

function isWordy(ch) { return ALNUM.test(ch) && !UNSPACED.test(ch); }

function boundaryOk(chars, start, end) {
  if (start > 0 && isWordy(chars[start - 1]) && isWordy(chars[start])) return false;
  if (end + 1 < chars.length && isWordy(chars[end + 1]) && isWordy(chars[end])) return false;
  return true;
}

function widenCuts(chars, drop) {
  var n = chars.length, i = 0;
  while (i < n) {
    if (!drop[i]) { i++; continue; }
    var end = i; while (end < n && drop[end]) end++;
    var after = end; while (after < n && !ALNUM.test(chars[after])) after++;
    for (var x = end; x < after; x++) drop[x] = true;
    for (var y = i - 1; y >= 0 && !ALNUM.test(chars[y]) && !/\s/.test(chars[y]); y--) drop[y] = true;
    if (after >= n) { for (var z = i - 1; z >= 0 && !ALNUM.test(chars[z]); z--) drop[z] = true; }
    i = after + 1;
  }
}

function tidyAfterStrip(text) {
  var out = [];
  for (var ci = 0; ci < text.length; ci++) {
    var ch = text[ci];
    if (/\s/.test(ch)) { if (out.length && out[out.length - 1] !== ' ') out.push(' '); continue; }
    if (!ALNUM.test(ch)) {
      var j = out.length - 1; while (j >= 0 && out[j] === ' ') j--;
      if (j >= 0 && !ALNUM.test(out[j])) continue;
      while (out.length && out[out.length - 1] === ' ') out.pop();
    }
    out.push(ch);
  }
  var chars = out; while (chars.length && !ALNUM.test(chars[0])) chars = chars.slice(1);
  return chars.join('').trim();
}

export function stripBlockedPhrases(text, blockedPhrases) {
  var chars = Array.from(text || '');
  var nm = normalizeWithMap(chars), norm = nm.norm, map = nm.map;
  if (!norm) return { text: text || '', removed: false };
  var drop = new Array(chars.length).fill(false), removed = false;
  (blockedPhrases || []).forEach(function (p) {
    if (!p) return;
    var i = norm.indexOf(p);
    while (i !== -1) {
      var from = map[i], to = map[i + p.length - 1];
      if (!boundaryOk(chars, from, to)) { i = norm.indexOf(p, i + 1); continue; }
      for (var c = from; c <= to; c++) drop[c] = true;
      removed = true; i = norm.indexOf(p, i + p.length);
    }
  });
  if (!removed) return { text: text, removed: false };
  widenCuts(chars, drop);
  return { text: tidyAfterStrip(chars.filter(function (_, i) { return !drop[i]; }).join('')), removed: true };
}

export function stripOtherAlphabets(text) {
  var original = text || '', chars = Array.from(original);
  var drop = chars.map(function (ch) { return OTHER_SCRIPT.test(ch); });
  var kept = original;
  if (drop.some(Boolean)) { widenCuts(chars, drop); kept = tidyAfterStrip(chars.filter(function (_, i) { return !drop[i]; }).join('')); }
  if (!WORTH_SHOWING.test(kept)) kept = '';
  return { text: kept, removed: kept !== original };
}

export function stripCommittedOverlap(text, committed) {
  if (!text || !committed) return text;
  committed = committed.trim();
  var maxOverlap = Math.min(committed.length, text.length, 8);
  for (var size = maxOverlap; size >= 4; size--) {
    var suffix = committed.slice(-size);
    if (text.indexOf(suffix) === 0) return text.slice(size).replace(/^\s+/, '');
  }
  return text;
}

export function hasRepetition(text) {
  if (!text || text.length < 3) return false;
  var normalized = text.replace(/\s+/g, '').replace(/[。、.,!?！？]/g, '');

  return /(.{2,20})\1{2,}/.test(normalized);
}

export function endsWithSentenceEnder(text) {
  if (SENTENCE_ENDERS.test(text.slice(-2))) return true;
  return text.slice(-1) === '.' && !/\d\.$/.test(text);
}
