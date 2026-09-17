export const $ = function (s, r) { return (r || document).querySelector(s); };

export const $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

export function escHtml(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
  });
}

export function label(r) { return r === 'you' ? 'You' : (r === 'win' ? 'Windows' : 'Them'); }

export function fillOpts(sel, opts, value) {
  if (!sel) return;
  sel.innerHTML = '';
  opts.forEach(function (o) {
    var el = document.createElement('option');
    el.value = o.v; el.textContent = o.n;
    if (o.disabled) el.disabled = true;
    if (o.v === value) el.selected = true;
    sel.appendChild(el);
  });
}

export function matchDeviceValue(list, name) {
  var m = list.filter(function (d) { return d.name === name; })[0];
  return m ? String(m.index) : (list[0] ? String(list[0].index) : '');
}

export function shortSrc(code) { return code === 'auto' ? 'AUTO' : (code || '').toUpperCase(); }
export function shortTgt(code) { return (code || '').split('-')[0].toUpperCase(); }
