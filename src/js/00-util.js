/* 共通ユーティリティ */
'use strict';
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

/* 要素生成: el('button.btn', {type:'button', onclick: fn}, ['text', childEl]) */
function el(tag, attrs, children) {
  var m = tag.split('.'), e = document.createElement(m[0]);
  if (m.length > 1) e.className = m.slice(1).join(' ');
  if (attrs) Object.keys(attrs).forEach(function (k) {
    var v = attrs[k];
    if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.keys(v).forEach(function (d) { e.dataset[d] = v[d]; });
    else if (v === false || v == null) { /* skip */ }
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  });
  (children || []).forEach(function (c) {
    if (c == null) return;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return e;
}
function svgIcon(path, size) {
  var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  if (size) { s.style.width = size + 'px'; s.style.height = size + 'px'; }
  var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  s.appendChild(p);
  return s;
}
var ICON = {
  chevron: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  open: 'M4 4h10l6 6v10H4z M14 4v6h6',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.5 1.5 M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.5-1.5'
};

/* 変換前にオーバーレイを確実に描画させるための 2 フレーム待ち */
function nextFrames(n) {
  return new Promise(function (res) {
    (function tick(k) { if (k <= 0) return res(); requestAnimationFrame(function () { tick(k - 1); }); })(n == null ? 2 : n);
  });
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* localStorage は file:// で失敗しうるので必ず try/catch */
var Storage = {
  get: function (k, def) { try { var v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};

function b64ToBytes(b64) {
  var bin = atob(b64), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function downloadBytes(bytes, name, mime) {
  var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  var a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function fmtBytes(n) {
  if (n == null) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function fmtInt(n) { return (n == null) ? '-' : Number(n).toLocaleString('en-US'); }
function fmtDate(iso) {
  var d = new Date(iso); if (isNaN(d)) return iso || '';
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function isoNowLocal() {
  var d = new Date(), tz = -d.getTimezoneOffset(), sign = tz >= 0 ? '+' : '-';
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + sign + p(Math.floor(Math.abs(tz) / 60)) + ':' + p(Math.abs(tz) % 60);
}
/* パスの各セグメント: \ / : * ? " < > | を _ に */
function sanitizeSegment(s) { return String(s || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+$/, '_'); }
function baseName(filename) { return String(filename).replace(/\.(step|stp|glb)$/i, ''); }
function debounce(fn, ms) { var t; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms); }; }

function showMessage(title, body) {
  $('#msg-title').textContent = title; $('#msg-body').textContent = body;
  var d = $('#msg-dialog'); if (!d.open) d.showModal();
}
