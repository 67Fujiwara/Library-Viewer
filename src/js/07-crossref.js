/* 案件横断: 複数装置の同名ユニットを串刺しで見る。
 * 当て方は 3 つ: (1) 名寄せした名前 (2) 同じタグ (3) 読み込んでいないライブラリの装置
 * (index.json の部品名 / その装置の行に付けたタグ)。(3) は押すと追加読み込みして (1)(2) に移る */
var CrossRef = (function () {
  var index = {}, keys = [], devices = [], current = null, list = [], cursor = -1;
  var listEl, curEl, MAX_LIB = 30;

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

  /* ---- タグで当てる (読み込み済みの他装置) ---- */
  function foldedTags(n) {
    var set = {}, list = Tags.get(Tree.tagKey(n));
    list.forEach(function (t) { set[Tags.fold(t)] = 1; });
    return { list: list, set: set, any: list.length > 0 };
  }
  function sharedTag(set, key) {
    var list = Tags.get(key);
    for (var i = 0; i < list.length; i++) if (set[Tags.fold(list[i])]) return list[i];
    return null;
  }
  function tagMatches(n, tags) {
    var out = [];
    if (!tags.any) return out;
    devices.forEach(function (d) {
      if (d === n.device) return;
      d.nodes.forEach(function (m) {
        var t = sharedTag(tags.set, Tree.tagKey(m));
        if (t) out.push({ node: m, tag: t });
      });
    });
    return out;
  }

  /* ---- 読み込んでいないライブラリの装置 ----
   * index.json の部品名 (検索と同じ Library.loadNames の結果) を名寄せの鍵にして当てる。
   * タグは行の鍵 '@<保存先>/<階層>' で localStorage に残っているので、読み込んでいなくても当たる */
  function partKeysOf(e) {
    if (!e.partList) return null;
    if (!e.partKeys || e.partKeys.src !== e.partList) {
      var map = {};
      e.partList.forEach(function (nm) { var k = normalize(nm); if (k && !map[k]) map[k] = nm; });
      e.partKeys = { src: e.partList, map: map };
    }
    return e.partKeys.map;
  }
  function libMatches(n, tags) {
    var out = [];
    if (typeof Library === 'undefined') return out;
    var open = {};
    devices.forEach(function (d) { if (d.source && d.source.entry) open[d.source.entry.rel.join('/')] = 1; });
    var tagged = tags.any ? Tags.withAny(tags.set).filter(function (t) { return t.key.charAt(0) === '@'; }) : [];
    Library.entries().forEach(function (e) {
      var rel = e.rel.join('/');
      if (open[rel]) return;
      var keys = n.depth > 0 && n.key ? partKeysOf(e) : null;
      if (keys && keys[n.key]) { out.push({ entry: e, part: keys[n.key] }); return; }
      var prefix = '@' + rel + '/';
      for (var i = 0; i < tagged.length; i++) if (tagged[i].key.indexOf(prefix) === 0) { out.push({ entry: e, tag: tagged[i].tag }); return; }
    });
    return out;
  }
  function libCard(h) {
    var e = h.entry, m = e.meta || {};
    var b = el('button.xref-card.hit-card', { type: 'button', title: 'ライブラリから読み込んで比較します（今の表示に追加）' }, [
      el('div.dev', {}, [svgIcon(ICON.folder), el('span', { text: m.deviceName || e.rel[e.rel.length - 1] }),
        h.part ? el('span.badge', { text: h.part, title: '同じ名前の部品' }) : el('span.badge.coral', { text: h.tag, title: '同じタグ' })]),
      el('div.path', { text: e.rel.join(' / ') }),
      el('div.stats', {}, [
        m.projectCode ? el('span', { text: m.projectCode }) : null,
        m.owner ? el('span', { text: m.owner }) : null,
        el('span', { text: '未読み込み' })
      ])
    ]);
    b.addEventListener('click', function () { Library.openEntry(e, true); });
    return b;
  }

  function card(m, curStats, tag) {
    var st = Viewer3D.stats(m);
    var diff = curStats && curStats.tris ? Math.round((st.tris - curStats.tris) / curStats.tris * 100) : null;
    var b = el('button.xref-card.hit-card', { type: 'button', dataset: { id: m.id } }, [
      el('div.dev', {}, [el('span', { text: m.device.name }), tag ? el('span.badge.coral', { text: tag, title: '同じタグ' }) : null]),
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
    if (!n) { curEl.hidden = true; return; }
    var isDev = n.depth === 0, tags = foldedTags(n);
    var st = Viewer3D.stats(n), r = isDev ? { exact: [], similar: [] } : matchesFor(n);
    var byTag = tagMatches(n, tags), lib = libMatches(n, tags);
    curEl.hidden = false;
    curEl.appendChild(el('div.n', { text: n.name }));
    curEl.appendChild(el('div.muted', { text: isDev ? ((n.device.groupPath || []).join(' / ') || '装置') : n.device.name + ' · ' + (n.path.slice(1, -1).join(' / ') || 'ルート直下') }));
    curEl.appendChild(el('div.mono.small', { text: 'ソリッド ' + st.solids + ' · △ ' + fmtInt(st.tris) }));
    if (tags.any) curEl.appendChild(el('div.tags', {}, tags.list.map(function (t) { return el('span.badge.coral', { text: t }); })));
    if (!r.exact.length && !r.similar.length && !byTag.length && !lib.length) {
      listEl.appendChild(el('p.muted.small', { text: isDev
        ? '装置全体が選択されています。ユニットや部品を選ぶと、他の案件の同名ユニットを探します。装置にタグを付けると、同じタグの装置がここに並びます。'
        : '同じ名前・同じタグのユニットは他の案件にありません。名前が違うものは、右クリック →「タグを付ける」で同じタグを付けると横断できます。' }));
    }
    if (r.exact.length) { listEl.appendChild(el('h3', { text: '同一名 ' + r.exact.length })); r.exact.forEach(function (m) { listEl.appendChild(card(m, st)); list.push(m); }); }
    if (r.similar.length) { listEl.appendChild(el('h3', { text: '類似 ' + r.similar.length })); r.similar.forEach(function (m) { listEl.appendChild(card(m, st)); list.push(m); }); }
    if (byTag.length) { listEl.appendChild(el('h3', { text: '同じタグ ' + byTag.length })); byTag.forEach(function (h) { listEl.appendChild(card(h.node, st, h.tag)); list.push(h.node); }); }
    if (lib.length) {
      listEl.appendChild(el('h3', { text: 'ライブラリ（未読み込み） ' + lib.length }));
      lib.slice(0, MAX_LIB).forEach(function (h) { listEl.appendChild(libCard(h)); });
      if (lib.length > MAX_LIB) listEl.appendChild(el('p.muted.small', { text: 'ライブラリは先頭 ' + MAX_LIB + ' 件だけ出しています。' }));
    }
    // 読み込んでいない装置の部品名は index.json から。まだ読んでいなければ読んでから出し直す (検索と同じ)
    if (typeof Library !== 'undefined' && Library.needsNames()) {
      Library.loadNames().then(function () { if (current === n) show(n); });
    }
  }
  function refresh() { if (current) show(current); }

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
  return { init: init, normalize: normalize, rebuild: rebuild, show: show, refresh: refresh, step: step, markCurrent: markCurrent };
})();
