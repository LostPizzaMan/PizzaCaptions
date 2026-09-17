const AUX_VERBS = new Set([
  'みる', 'おく', 'くれる', 'あげる', 'もらう', 'いく', '行く', 'くる', '来る',
  'くださる', 'ある', '有る', '始める', '始まる',
]);

const BREAK_PARTICLES = new Set(['し', 'けど', 'けれど', 'が', 'のに', 'ので', 'から', 'と', 'ながら']);

function getRelatedTokens(tokens, idx) {
  const el = tokens[idx];
  const related = [el];
  const basePos = el.dataset.pos;
  if (basePos !== '動詞' && basePos !== '形容詞' && basePos !== '形容動詞') return related;

  for (let i = idx + 1; i < tokens.length; i++) {
    const s = tokens[i];
    const pos = s.dataset.pos;
    const detail = s.dataset.posDetail || '';

    if ((s.dataset.word === 'です' && s.dataset.conjugatedForm !== '連用形') || s.dataset.word === 'だ') break;
    if (pos === '助詞' && detail === '接続助詞' && BREAK_PARTICLES.has(s.dataset.word)) break;

    if (pos === '助動詞') { related.push(s); continue; }
    if (pos === '動詞' && detail === '接尾') { related.push(s); continue; }
    if (pos === '動詞' && detail === '非自立' && !AUX_VERBS.has(s.dataset.word)) { related.push(s); continue; }
    if (pos === '助詞' && detail === '接続助詞') { related.push(s); continue; }
    if (pos === '助詞' && detail === '並立助詞' && (s.dataset.word === 'たり' || s.dataset.word === 'だり')) { related.push(s); continue; }

    break;
  }
  return related;
}

function getConjugationLabel(related) {
  const baseConjForm = related[0].dataset.conjugatedForm || '';

  if (related.length <= 1) {
    if (baseConjForm.startsWith('命令')) return 'imperative';
    if (baseConjForm === '連用形') return 'continuative';
    if (baseConjForm === '体言接続特殊') return 'negative';
    return '';
  }

  const suffixes = related.slice(1).map(s => ({ word: s.dataset.word, surface: s.dataset.surface || s.textContent }));
  const words = new Set(suffixes.map(s => s.word));
  const surfaces = new Set(suffixes.map(s => s.surface));

  const baseConjType = related[0].dataset.conjugatedType || '';
  const isGodan = baseConjType.startsWith('五段') || baseConjType === 'サ変・スル' || baseConjType === 'カ変・クル';

  const hasTeForm = surfaces.has('て') || surfaces.has('で');
  const hasTa = (surfaces.has('た') || surfaces.has('だ')) && !surfaces.has('たら') && !surfaces.has('だら');
  const hasPolite = words.has('ます');
  const hasShimau = words.has('てしまう') || words.has('しまう');
  const hasChimau = words.has('ちまう') || words.has('じまう');
  const hasChau = words.has('ちゃう') || words.has('じゃう') || surfaces.has('じゃ');
  const hasTari = words.has('たり') || words.has('だり');
  const hasProgressiveAux = words.has('いる') || words.has('おる') || words.has('てる');
  const hasTeContraction = hasTeForm && hasTa && !hasShimau && !hasChimau && !hasChau;
  const hasTePolite = hasTeForm && hasPolite;
  const hasProgressive = hasProgressiveAux || hasTeContraction || hasTePolite;

  const tags = [];

  if (words.has('せる') || words.has('させる')) tags.push('causative');
  if (words.has('られる')) tags.push('potential or passive');
  else if (words.has('れる')) tags.push(isGodan ? 'passive' : 'potential');

  if (hasProgressive) tags.push('progressive');
  if (hasShimau) tags.push('〜しまう');
  if (hasChimau) tags.push('〜ちまう');
  if (hasChau) tags.push('〜ちゃう');
  if (words.has('すぎる')) tags.push('excessive');

  if (words.has('たい')) tags.push('〜たい');

  if (hasPolite) tags.push('polite');

  if (words.has('ない') || words.has('ぬ') || words.has('ん')) tags.push('negative');

  if (hasTa && (!hasTeForm || hasShimau || hasChimau || hasChau || hasProgressive)) tags.push('past');
  if (words.has('う') || words.has('よう')) tags.push('volitional');
  if (words.has('なさる')) tags.push('imperative');

  if (hasTari) tags.push('〜たり');
  if (hasTeForm && tags.length === 0) tags.push('te-form');
  if (surfaces.has('たら') || surfaces.has('だら') || words.has('ば') ||
      suffixes.some(s => s.word === 'ない' && (s.surface === 'なきゃ' || s.surface === 'なけれ'))) tags.push('conditional');

  return tags.join(' · ');
}

export { getRelatedTokens, getConjugationLabel };
