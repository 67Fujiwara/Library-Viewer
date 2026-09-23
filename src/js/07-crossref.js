/* 案件横断: 複数装置の同名ユニットを串刺しで見る */
var CrossRef = (function () {
  var index = {}, keys = [], devices = [], current = null, list = [], cursor = -1;
  var listEl, curEl;

  /* 名寄せ: 全角半角・空白・_・- を無視し、末尾の連番やリビジョン表記を落とす */
  function normalize(name) {
    var s = String(name || '').normalize('NFKC').toLowerCase();
    s = s.replace(/:\d+$/, '');                 // CAD のインスタンス番号 "PART:1"
    s = s.replace(/\(\d+\)$/, '');              // コピー "(2)"
    s = s.replace(/[\s_\-‐–—]+/g, '');
    var t = s.replace(/(rev\.?[a-z0-9]{0,3}|ver\.?\d{1,3}|r\d{1,3}|v\d{1,3}|\d{1,4})$/, '');
    if (t.length >= 2) s = t;
    return s;
  }

  function init() { listEl = $('#xref-list'); curEl = $('#xref-current'); }

  function rebuild(devs) {
    devices = devs; index = {};
    devices.forEach(function (d) {
      d.nodes.forEach(function (n) {
        if (n.depth === 0 || !n.key) return;
        (index[n.key] = index[n.key] || []).push(n);
      });
    });
    keys = Object.keys(index);
    Tree.setBadges(function (n) {
      if (n.depth === 0 || !n.key) return 0;
      var others = {};
      (index[n.key] || []).forEach(function (m) { if (m.device !== n.device) others[m.device.id] = 1; });
      return Object.keys(others).length;
    });
    if (current) show(current);
  }

  function matchesFor(n) {
    var exact = [], similar = [];
    if (!n || n.depth === 0 || !n.key) return { exact: exact, similar: similar };
    (index[n.key] || []).forEach(function (m) { if (m.device !== n.device) exact.push(m); });
    if (n.key.length >= 3) {
      keys.forEach(function (k) {
        if (k === n.key || k.length < 3) return;
        if (k.indexOf(n.key) === 0 || n.key.indexOf(k) === 0) index[k].forEach(function (m) { if (m.device !== n.device) similar.push(m); });
      });
    }
    return { exact: exact, similar: similar.slice(0, 40) };
  }

  function card(m, curStats) {
    var st = Viewer3D.stats(m);
    var diff = curStats && curStats.tris ? Math.round((st.tris - curStats.tris) / curStats.tris * 100) : null;
    var b = el('button.xref-card', { type: 'button', dataset: { id: m.id } }, [
      el('div.dev', { text: m.device.name }),
      el('div.path', { text: m.path.slice(1).join(' / ') || m.name }),
      el('div.stats', {}, [
        el('span', { text: 'ソリッド ' + st.solids }),
        el('span', { text: '△ ' + fmtInt(st.tris) }),
        diff == null ? null : el('span.diff' + (diff > 0 ? '.up' : diff < 0 ? '.down' : ''), { text: (diff > 0 ? '+' : '') + diff + '%' })
      ])
    ]);
    b.addEventListener('click', function () { go(m); });
    return b;
  }

  function show(n) {
    current = n; list = []; cursor = -1;
    listEl.textContent = ''; curEl.textContent = '';
    // 常設の案内は置かない。何か選ばれているときだけ、その状況を出す
    if (!n || n.depth === 0) {
      curEl.hidden = true;
      if (n) listEl.appendChild(el('p.muted.small', { text: '装置全体が選択されています。ユニットや部品を選ぶと他の装置と比較できます。' }));
      return;
    }
    var st = Viewer3D.stats(n), r = matchesFor(n);
    curEl.hidden = false;
    curEl.appendChild(el('div.n', { text: n.name }));
    curEl.appendChild(el('div.muted', { text: n.device.name + ' · ' + (n.path.slice(1, -1).join(' / ') || 'ルート直下') }));
    curEl.appendChild(el('div.mono.small', { text: 'ソリッド ' + st.solids + ' · △ ' + fmtInt(st.tris) }));
    if (!r.exact.length && !r.similar.length) {
      listEl.appendChild(el('p.muted.small', { text: devices.length < 2 ? '他の装置を読み込むと、同名ユニットがここに並びます。' : '他の装置に同名・類似名のユニットはありません。' }));
      return;
    }
    if (r.exact.length) { listEl.appendChild(el('h3', { text: '同一名 ' + r.exact.length })); r.exact.forEach(function (m) { listEl.appendChild(card(m, st)); list.push(m); }); }
    if (r.similar.length) { listEl.appendChild(el('h3', { text: '類似 ' + r.similar.length })); r.similar.forEach(function (m) { listEl.appendChild(card(m, st)); list.push(m); }); }
  }

  /* カードへ移動: カメラの角度は変えず、注視点と距離だけ移す */
  function go(m) {
    App.select(m, { keepAngle: true });
  }
  function step(dir) {
    // 現在の選択がリスト内なら順送り。リスト外 (起点) なら先頭 / 末尾へ
    var all = current ? [current].concat(list) : list;
    if (!all.length) return;
    var i = all.indexOf(App.selected());
    i = i < 0 ? 0 : (i + dir + all.length) % all.length;
    var target = all[i];
    if (target === current) App.select(target, { keepAngle: true, keepXref: true }); else go(target);
  }
  function markCurrent(n) {
    $$('.xref-card', listEl).forEach(function (c) { c.classList.toggle('current', c.dataset.id === (n && n.id)); });
  }
  return { init: init, normalize: normalize, rebuild: rebuild, show: show, step: step, markCurrent: markCurrent };
})();
