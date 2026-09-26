/* 検索 (名称 / タグ / 保存先パス) の結果一覧。左の絞り込みと同じ問い合わせで、当たったものを右パネルに並べる。
 *
 *   ヒットの選び方: フォルダはタグ・名称、装置はファイル名と案件情報、部品は名称、
 *                   さらにライブラリの保存先パス (部署 / 担当者 / 案件コード_装置名 / 対象ワーク)。
 *   「藤原」で検索すれば、藤原が担当した装置は読み込んでいなくてもライブラリから出てくる。
 *   一覧から選ぶ → そのまとまりだけ表示に残し、関係のない部品はチェックを外す (Tree.isolate)
 *   カメラは角度を変えずに収める (Viewer3D.fitNode)。回り込むのは「この部品に寄る」だけ
 */
var Search = (function () {
  var panelEl, xrefEl, listEl, sumEl, inputEl, clearBtn, allBtn;
  var MAX_PARTS = 50, MAX_LIB = 30;
  var EMPTY = { folders: [], devices: [], parts: [], lib: [] };
  var hits = EMPTY, query = '', currentId = null;

  function init() {
    panelEl = $('#search-panel'); xrefEl = $('#xref-panel');
    listEl = $('#search-list'); sumEl = $('#search-sum');
    inputEl = $('#tree-search');
    clearBtn = $('#search-clear'); allBtn = $('#search-showall');
    clearBtn.addEventListener('click', function () { Tree.setSearch(''); inputEl.focus(); });
    allBtn.addEventListener('click', function () { $('#btn-show-all').click(); currentId = null; mark(); });
  }

  /* 検索欄は右パネルの中にあるので、畳んでいたら開いてから入れる (/ か Ctrl+F) */
  function focus() {
    if (!Panels.isOpen('right')) Panels.set('right', true);
    inputEl.focus(); inputEl.select();
  }

  function run(raw) {
    query = String(raw == null ? '' : raw).trim();
    if (!query) {
      hits = EMPTY; currentId = null;
      listEl.textContent = ''; sumEl.textContent = '';   // 消し忘れた結果を DOM に残さない
      panelEl.hidden = true; xrefEl.hidden = false;
      CrossRef.show(App.selected());
      return hits;
    }
    hits = collect(Tags.fold(query));
    panelEl.hidden = false; xrefEl.hidden = true;
    render();
    // 読み込んでいない装置の部品名は index.json から。まだ読んでいなければ読んでから結果を出し直す
    if (Library.needsNames()) {
      var q = query;
      Library.loadNames().then(function () { if (query === q) run(q); });
    }
    return hits;
  }

  /* 装置に付いている案件情報 (ライブラリから開いたもの・ネーミングルールで解析できたもの) */
  function deviceWords(d) {
    var m = (d.source && d.source.entry && d.source.entry.meta) || d.naming || {};
    var rel = (d.source && d.source.entry && d.source.entry.rel) || [];
    return Tags.fold([d.name, d.fileName, m.projectCode, m.deviceName, m.workpiece, m.customer, m.department, m.owner, rel.join('/')].join(' '));
  }

  /* フォルダ → 装置 → 部品 → ライブラリ の順。タグで当たったフォルダを先頭に出す */
  function collect(f) {
    var folders = [], devices = [], parts = [];
    Tree.allNodes().forEach(function (n) {
      if (n.isGroup) {
        var tag = Tags.hit(n.path.join('/'), f);
        if (tag) folders.unshift({ node: n, kind: 'folder', by: 'tag', tag: tag });
        else if (Tags.fold(n.name).indexOf(f) >= 0) folders.push({ node: n, kind: 'folder', by: 'name' });
      } else if (n.depth === 0) {
        var dtag = Tags.hit(Tree.tagKey(n), f);
        if (dtag) devices.unshift({ node: n, kind: 'device', by: 'tag', tag: dtag });
        else if (deviceWords(n.device).indexOf(f) >= 0) devices.push({ node: n, kind: 'device', by: 'name' });
      } else {
        var ptag = Tags.hit(Tree.tagKey(n), f);
        if (ptag) parts.unshift({ node: n, kind: 'part', by: 'tag', tag: ptag });
        else if (Tags.fold(n.name).indexOf(f) >= 0) parts.push({ node: n, kind: 'part', by: 'name' });
      }
    });
    // ライブラリ: 保存先パスの語 (部署・担当者・案件コード・装置名・対象ワーク) に当たるもの。
    // すでに読み込んである装置と同じものは出さない
    var open = {};
    App.devices().forEach(function (d) { if (d.source && d.source.entry) open[d.source.entry.rel.join('/')] = 1; });
    var lib = Library.entries().filter(function (e) {
      return Library.matches(e, f) && !open[e.rel.join('/')];
    }).map(function (e) { return { entry: e, kind: 'lib', part: Library.matchedPart(e, f) }; });
    return { folders: folders, devices: devices, parts: parts, lib: lib };
  }
  function count() { return hits.folders.length + hits.devices.length + hits.parts.length + hits.lib.length; }

  function render() {
    listEl.textContent = '';
    var total = count();
    sumEl.textContent = total
      ? '「' + query + '」に ' + total + ' 件（フォルダ ' + hits.folders.length + ' / 装置 ' + hits.devices.length + ' / 部品 ' + hits.parts.length + (hits.lib.length ? ' / ライブラリ ' + hits.lib.length : '') + '）'
      : '「' + query + '」に当たるものはありません。';
    if (!total) {
      listEl.appendChild(el('p.muted.small', { text: '行を右クリック →「タグを付ける」でフォルダ・装置・部品にタグを付けると、ここから探せます。ライブラリは部署・担当者・案件コード・装置名・対象ワークで探せます。' }));
      return;
    }
    section('フォルダ', hits.folders);
    section('装置', hits.devices);
    section('部品', hits.parts.slice(0, MAX_PARTS));
    if (hits.parts.length > MAX_PARTS) listEl.appendChild(el('p.muted.small', { text: '部品は先頭 ' + MAX_PARTS + ' 件だけ出しています。' }));
    if (hits.lib.length) {
      listEl.appendChild(el('h3', { text: 'ライブラリ（未読み込み） ' + hits.lib.length }));
      hits.lib.slice(0, MAX_LIB).forEach(function (h) { listEl.appendChild(libCard(h)); });
      if (hits.lib.length > MAX_LIB) listEl.appendChild(el('p.muted.small', { text: 'ライブラリは先頭 ' + MAX_LIB + ' 件だけ出しています。' }));
    }
    mark();
  }
  function section(title, list) {
    if (!list.length) return;
    listEl.appendChild(el('h3', { text: title + ' ' + list.length }));
    list.forEach(function (h) { listEl.appendChild(card(h)); });
  }

  function card(h) {
    var n = h.node, st = Viewer3D.stats(n);
    var where = n.isGroup ? (n.path.slice(0, -1).join(' / ') || '最上位')
      : n.depth === 0 ? ((n.device.groupPath || []).join(' / ') || '最上位')
        : n.device.name + ' · ' + (n.path.slice(1, -1).join(' / ') || 'ルート直下');
    var head = el('div.dev', {}, [
      n.isGroup ? svgIcon(ICON.folder) : null,
      el('span', { text: n.name }),
      h.by === 'tag' ? el('span.badge.coral', { text: h.tag }) : null
    ]);
    var stats = el('div.stats', {}, [
      n.isGroup ? el('span', { text: '装置 ' + Tree.devicesUnder(n).length }) : null,
      el('span', { text: 'ソリッド ' + st.solids }),
      el('span', { text: '△ ' + fmtInt(st.tris) })
    ]);
    var b = el('button.xref-card.hit-card', { type: 'button', dataset: { id: n.id }, title: 'これだけ表示する（関係のない部品はチェックを外します）' }, [
      head, el('div.path', { text: where }), stats
    ]);
    b.addEventListener('click', function () { apply(h); });
    return b;
  }

  /* まだ読み込んでいないライブラリの装置。押すと今の表示に足して読み込む */
  function libCard(h) {
    var m = h.entry.meta || {};
    var b = el('button.xref-card.hit-card', { type: 'button', title: 'ライブラリから読み込みます（今の表示に追加）' }, [
      el('div.dev', {}, [svgIcon(ICON.folder), el('span', { text: m.deviceName || h.entry.rel[h.entry.rel.length - 1] }), h.part ? el('span.badge.coral', { text: h.part, title: 'この部品名で当たりました' }) : (m.owner ? el('span.badge', { text: m.owner }) : null)]),
      el('div.path', { text: h.entry.rel.join(' / ') }),
      el('div.stats', {}, [
        m.projectCode ? el('span', { text: m.projectCode }) : null,
        m.customer ? el('span', { text: m.customer }) : null,
        m.workpiece ? el('span', { text: m.workpiece }) : null,
        el('span', { text: 'ファイル ' + h.entry.files.length })
      ])
    ]);
    b.addEventListener('click', function () { Library.openEntry(h.entry, true); });
    return b;
  }

  /* 選んだものだけ残す: 関係のない部品はチェックを外して非表示にし、カメラを角度そのままで収める */
  function apply(h) {
    var n = h.node;
    currentId = n.id;
    Tree.isolate(n);
    if (n.isGroup) { App.select(null, { keepXref: true }); Viewer3D.fitNode(n); }
    else App.select(n, { keepAngle: true, keepXref: true });
    mark();
  }
  function mark() {
    $$('.hit-card', listEl).forEach(function (c) { c.classList.toggle('current', c.dataset.id === currentId); });
  }

  /* 装置を消した・読み込んだ後に一覧を作り直す (消えたノードを指したままにしない) */
  function refresh() { if (query) run(query); }

  return { init: init, run: run, refresh: refresh, focus: focus, query: function () { return query; }, hits: function () { return hits; } };
})();
