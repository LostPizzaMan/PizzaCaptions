const AUX_VERBS = new Set([
  'みる', 'おく', 'くれる', 'あげる', 'もらう', 'いく', '行く', 'くる', '来る',
  'くださる', 'ある', '有る', '始める', '始まる',
]);

const BREAK_PARTICLES = new Set(['し', 'けど', 'けれど', 'が', 'のに', 'ので', 'から', 'と', 'ながら']);

const PROG = new Set(['いる', 'おる', 'てる', 'でる']);

function normBase(tok) {
  let b = tok.base || tok.surface;
  if ((tok.ctype || '').startsWith('サ行変格') && b.length > 2 && b.endsWith('ずる')) b = b.slice(0, -2) + 'じる';
  return b;
}

function getRelatedTokens(toks, idx) {
  const head = toks[idx];
  const out = [head];
  if (head.pos !== '動詞' && head.pos !== '形容詞' && head.pos !== '形状詞') return out;
  for (let i = idx + 1; i < toks.length; i++) {
    const t = toks[i];
    const ct = t.ctype || '', cf = t.cform || '';
    if (t.pos === '助動詞') {
      if (ct === '助動詞-ダ') break;
      if (ct === '助動詞-デス' && !cf.startsWith('連用形')) break;
      out.push(t); continue;
    }

    if (t.pos === '形容詞' && t.detail === '非自立可能' && t.base === 'ない') { out.push(t); continue; }

    if (t.pos === '動詞' && (t.detail === '非自立可能' || t.detail === '接尾辞')
        && !AUX_VERBS.has(t.base)) { out.push(t); continue; }
    if (t.pos === '助詞') {
      if (t.detail === '接続助詞') {
        if (BREAK_PARTICLES.has(t.base) || BREAK_PARTICLES.has(t.surface)) break;
        out.push(t); continue;
      }
      if (t.detail === '副助詞' && (t.base === 'たり' || t.base === 'だり')) { out.push(t); continue; }
      break;
    }
    break;
  }
  return out;
}

function getConjugationLabel(related) {
  const head = related[0];
  if (related.length <= 1) {
    const cf = head.cform || '';
    if (cf.startsWith('命令')) return 'imperative';
    if (cf === '意志推量形') return 'volitional';
    if (cf.startsWith('連用形')) return 'continuative';
    return '';
  }
  const sfx = related.slice(1);
  const headGodan = (head.ctype || '').startsWith('五段')
    || head.ctype === 'サ行変格' || head.ctype === 'カ行変格';
  const has = (fn) => sfx.some(fn);

  const causative = has((s) => s.pos === '助動詞' && (s.base === 'せる' || s.base === 'させる'));
  const rareru = has((s) => s.base === 'られる');
  const reru = has((s) => s.base === 'れる');
  const progressive = has((s) => PROG.has(s.base));
  const teForm = has((s) => s.pos === '助詞' && s.detail === '接続助詞' && (s.surface === 'て' || s.surface === 'で'));
  const past = has((s) => s.ctype === '助動詞-タ' && !(s.cform || '').startsWith('仮定形'));
  const taCond = has((s) => s.ctype === '助動詞-タ' && (s.cform || '').startsWith('仮定形'));
  const polite = has((s) => s.ctype === '助動詞-マス');
  const negative = has((s) => s.base === 'ない' || s.ctype === '助動詞-ヌ');
  const negCond = has((s) => s.base === 'ない' && (s.cform || '').startsWith('仮定形'));
  const desider = has((s) => s.ctype === '助動詞-タイ');
  const volit = has((s) => s.cform === '意志推量形');
  const shimau = has((s) => s.base === 'しまう');
  const chau = has((s) => s.base === 'ちゃう' || s.base === 'じゃう');
  const chimau = has((s) => s.base === 'ちまう' || s.base === 'じまう');
  const excessive = has((s) => s.base === 'すぎる' || s.base === '過ぎる');
  const tari = has((s) => s.pos === '助詞' && (s.base === 'たり' || s.base === 'だり'));
  const ba = has((s) => s.pos === '助詞' && s.detail === '接続助詞' && s.surface === 'ば');
  const nasaru = has((s) => s.base === 'なさる');

  const tags = [];
  if (causative) tags.push('causative');
  if (rareru) tags.push('potential or passive');
  else if (reru) tags.push(headGodan ? 'passive' : 'potential');
  if (progressive) tags.push('progressive');
  if (shimau) tags.push('〜しまう');
  if (chimau) tags.push('〜ちまう');
  if (chau) tags.push('〜ちゃう');
  if (excessive) tags.push('excessive');
  if (desider) tags.push('〜たい');
  if (polite) tags.push('polite');
  if (negative) tags.push('negative');
  if (past) tags.push('past');
  if (volit) tags.push('volitional');
  if (nasaru) tags.push('imperative');
  if (tari) tags.push('〜たり');
  if (teForm && tags.length === 0) tags.push('te-form');
  if (taCond || ba || negCond) tags.push('conditional');
  return tags.join(' · ');
}

function mergeCopulaNeg(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], n = toks[i + 1];
    if (n && (t.surface === 'じゃ' || t.surface === 'では') && n.base === 'ない') {
      let surface = t.surface + n.surface, j = i + 1;
      const p = toks[j + 1];
      if (p && (p.surface === 'た' || p.surface === 'だ')) { surface += p.surface; j++; }
      out.push({
        surface, base: (t.surface === 'では') ? 'ではない' : 'じゃない', reading: '',
        pos: '', detail: '', ctype: '', cform: '', unk: false,
      });
      i = j;
      continue;
    }
    out.push(t);
  }
  return out;
}

export { getRelatedTokens, getConjugationLabel, mergeCopulaNeg, normBase };
