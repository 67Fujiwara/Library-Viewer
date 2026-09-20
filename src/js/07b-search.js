/* 検索 (名称 / タグ) の結果一覧。左の絞り込みと同じ問い合わせで、当たったものを右パネルに並べる。
 *
 *   ヒットの選び方: フォルダはタグ・名称、装置はファイル名、部品は名称
 *   一覧から選ぶ → そのまとまりだけ表示に残し、関係のない部品はチェックを外す (Tree.isolate)
 *   カメラは角度を変えずに収める (Viewer3D.fitNode)。回り込むのは「この部品に寄る」だけ
 */
var Search = (function () {
  var panelEl, xrefEl, listEl, sumEl, inputEl, clearBtn, allBtn;
  var MAX_PARTS = 50;
  var hits = [], query = '', currentId = null;

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
      hits = []; currentId = null;
      listEl.textContent = ''; sumEl.textContent = '';   // 消し忘れた結果を DOM に残さない
      panelEl.hidden = true; xrefEl.hidden = false;
      CrossRef.show(App.selected());
      return hits;
    }
    hits = collect(Tags.fold(query));
    panelEl.hidden = false; xrefEl.hidden = true;
    render();
    return hits;
  }

  /* フォルダ → 装置 → 部品 の順。タグで当たったフォルダを先頭に出す */
  function collect(f) {
    var folders = [], devices = [], parts = [];
    Tree.allNodes().forEach(function (n) {
      if (n.isGroup) {
        var tag = Tags.hit(n.path.join('/'), f);
        if (tag) folders.unshift({ node: n, kind: 'folder', by: 'tag', tag: tag });
        else if (Tags.fold(n.name).indexOf(f) >= 0) folders.push({ node: n, kind: 'folder', by: 'name' });
      } else if (n.depth === 0) {
        if (Tags.fold(n.name).indexOf(f) >= 0 || Tags.fold(n.device.fileName || '').indexOf(f) >= 0) devices.push({ node: n, kind: 'device', by: 'name' });
      } else if (Tags.fold(n.name).indexOf(f) >= 0) {
        parts.push({ node: n, kind: 'part', by: 'name' });
      }
    });
    return { folders: folders, devices: devices, parts: parts };
  }
  function count() { return hits.folders.length + hits.devices.length + hits.parts.length; }

  function render() {
    listEl.textContent = '';
    var total = count();
    sumEl.textContent = total
      ? '「' + query + '」に ' + total + ' 件（フォルダ ' + hits.folders.length + ' / 装置 ' + hits.devices.length + ' / 部品 ' + hits.parts.length + '）'
      : '「' + query + '」に当たるフォルダ・装置・部品はありません。';
    if (!total) {
      listEl.appendChild(el('p.muted.small', { text: 'フォルダを右クリック →「タグを編集」でタグを付けると、ここから探せます。' }));
      return;
    }
    section('フォルダ', hits.folders);
    section('装置', hits.devices);
    section('部品', hits.parts.slice(0, MAX_PARTS));
    if (hits.parts.length > MAX_PARTS) listEl.appendChild(el('p.muted.small', { text: '部品は先頭 ' + MAX_PARTS + ' 件だけ出しています。' }));
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
