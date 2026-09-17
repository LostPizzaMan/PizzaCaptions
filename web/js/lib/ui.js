import { $, $$ } from './util.js';

export function foot(text) { $('#fstate').textContent = text; }

export function setTog(btn, on) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); btn.textContent = on ? 'On' : 'Off'; }
export function togState(btn) { return btn.getAttribute('aria-pressed') === 'true'; }

export function toast(kind, eyebrow, msg, action) {
  var wrap = $('#toasts'); if (!wrap) { foot(msg); return; }
  var t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.innerHTML = '<div class="stripe"></div><div class="tbody">'
    + (eyebrow ? '<div class="tk"></div>' : '')
    + '<div class="tmsg"></div>'
    + (action ? '<div class="tact"><button class="go"></button><button class="mute" data-close>Dismiss</button></div>' : '')
    + '</div><button class="tx" data-close aria-label="Close">×</button>'
    + (action ? '' : '<div class="tlife"></div>');
  if (eyebrow) $('.tk', t).textContent = eyebrow;
  $('.tmsg', t).textContent = msg;
  if (action) $('.tact .go', t).textContent = action.label;
  wrap.appendChild(t);
  var kill = function () {
    if (!t.parentNode) return;
    t.classList.add('out'); setTimeout(function () { if (t.parentNode) t.remove(); }, 220);
  };
  $$('[data-close]', t).forEach(function (b) { b.addEventListener('click', kill); });
  if (action) $('.tact .go', t).addEventListener('click', function () { kill(); if (action.onClick) action.onClick(); });
  else setTimeout(kill, 4400);
  return t;
}

export function dialog(opts) {
  return new Promise(function (resolve) {
    var bd = $('#dlg-backdrop'), card = $('#dlg');
    if (!bd || !card) { resolve(window.confirm((opts.h || '') + (opts.p ? '\n\n' + opts.p.replace(/<[^>]+>/g, '') : ''))); return; }
    card.innerHTML = '<div class="dk"></div><h2></h2><p></p>'
      + '<div class="dacts"><button class="sbtn" data-x></button><button class="sbtn primary" data-ok></button></div>';
    $('.dk', card).textContent = opts.k || 'Confirm';
    $('h2', card).textContent = opts.h || '';
    $('p', card).innerHTML = opts.p || '';
    $('[data-x]', card).textContent = opts.cancel || 'Cancel';
    var okb = $('[data-ok]', card);
    okb.textContent = opts.ok || 'OK';
    if (opts.danger) okb.classList.add('danger');
    var onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    var done = function (v) { bd.removeAttribute('data-open'); document.removeEventListener('keydown', onKey, true); resolve(v); };
    $('[data-x]', card).onclick = function () { done(false); };
    okb.onclick = function () { done(true); };
    bd.onclick = function (e) { if (e.target === bd) done(false); };
    document.addEventListener('keydown', onKey, true);
    bd.setAttribute('data-open', '');
    setTimeout(function () { okb.focus(); }, 0);
  });
}

export function closePop() { var p = $('#pop'); if (p) p.style.display = 'none'; }

export function closeDrawer() {
  $$('.dcell.open').forEach(function (c) { c.classList.remove('open'); });
  $$('.tr.open').forEach(function (t) { t.classList.remove('open'); t.setAttribute('aria-expanded', 'false'); });
}

export function closeMenus() {
  $$('.menu').forEach(function (m) {
    m.removeAttribute('data-open');
    var t = $('.tool[data-tool="' + m.id.replace('-menu', '') + '"]');
    if (t) t.setAttribute('aria-pressed', 'false');
  });
  var mb = $('#menu-backdrop'); if (mb) mb.removeAttribute('data-open');
}

export function openMenu(menu, btn) {
  var wasOpen = menu.hasAttribute('data-open');
  closePop(); closeMenus();
  if (wasOpen) return;
  menu.setAttribute('data-open', '');
  btn.setAttribute('aria-pressed', 'true');
  var mb = $('#menu-backdrop'); if (mb) mb.setAttribute('data-open', '');
}
