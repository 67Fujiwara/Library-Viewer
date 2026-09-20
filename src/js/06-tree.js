/* 構成ツリー。行 = [開閉] [チェックボックス] [部品名] [子の数] [ソロ]
 * チェック操作でカメラは動かさない。 */
var Tree = (function () {
  var container, counterEl, searchEl;
  var devices = [], nodesById = {}, rows = {}, soloNode = null, selectedNode = null, filter = '';
  var groups = [], groupIds = [], collapsedGroups = {};   // フォルダ階層 (元のフォルダ構成をそのまま出す)
  var folderPaths = {};      // ユーザーが作ったフォルダ。中身が空でも残す ("装置A/ユニット1" → true)
  var focusedId = null;      // 最後にクリックした行 (新規フォルダの作成先)。再描画で作り直されるので id で持つ
  var picked = [], anchorId = null;   // まとめて動かすための複数選択 (フォルダ行と装置行だけ)
  var callbacks = {};

  function init(opts) {
    callbacks = opts;
    container = $('#tree'); counterEl = $('#tree-counter'); searchEl = $('#tree-search');
    // イベント委譲 (行ごとにリスナーを付けない)
    container.addEventListener('change', function (e) {
      var cb = e.target; if (cb.type !== 'checkbox') return;
      var n = nodesById[cb.dataset.id]; if (!n) return;
      setVisible(n, cb.checked); soloNode = null; refresh();
    });
    container.addEventListener('mousedown', function (e) {
      var row = e.target.closest('.tree-row');
      var n = row ? nodesById[row.dataset.id] : null;
      setFocused(n);
      if (!n || !selectable(n)) { setPicked([]); anchorId = null; return; }
      if (e.shiftKey && anchorId && nodesById[anchorId]) setPicked(rangeIds(anchorId, n.id));
      else if (e.ctrlKey || e.metaKey) { togglePicked(n.id); anchorId = n.id; }
      else {
        // すでに選択に入っている行はここでは崩さない (そのままドラッグで全部動かせるように)。
        // ドラッグせずにクリックだけで終わったら click 側で 1 件に絞る
        if (!isPicked(n.id)) setPicked([n.id]);
        anchorId = n.id;
      }
    });
    container.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var row = b.closest('.tree-row'); var n = row && nodesById[row.dataset.id]; if (!n) return;
      if (b.classList.contains('twisty') || (b.classList.contains('name') && n.isGroup)) {
        n.collapsed = !n.collapsed;
        if (n.isGroup) collapsedGroups[n.path.join('/')] = n.collapsed;
        row.classList.toggle('collapsed', n.collapsed); applyRowVisibility();
      }
      else if (b.classList.contains('solo')) { toggleSolo(n); }
      else if (b.classList.contains('close')) {
        if (n.isGroup) { var list = devicesUnder(n); removeFolder(n); callbacks.onClose(list); }   // フォルダごと片づける
        else callbacks.onClose(n.device);
      }
      else if (b.classList.contains('tag')) { setSearch(b.dataset.tag); }
      else if (b.classList.contains('name')) { callbacks.onSelect(n); }   // フォルダは上の分岐で開閉になる
    });
    container.addEventListener('mouseover', function (e) {
      var row = e.target.closest('.tree-row'); var n = row && nodesById[row.dataset.id];
      callbacks.onHover(n || null);
    });
    container.addEventListener('mouseleave', function () { callbacks.onHover(null); });
    searchEl.addEventListener('input', debounce(function () { applySearch(searchEl.value); }, 120));
    $('#btn-show-all').addEventListener('click', function () { allLeaves().forEach(function (n) { n.visible = true; }); soloNode = null; refresh(); });
    $('#btn-invert').addEventListener('click', function () { allLeaves().forEach(function (n) { n.visible = !n.visible; }); soloNode = null; refresh(); });
    $('#chk-ghost').addEventListener('change', function (e) { Viewer3D.setGhost(e.target.checked); });
  }

  /* モデルの木構造 → ノードオブジェクト (device.root / device.nodes / device.leaves を作る) */
  function buildDevice(device) {
    var nodes = [], leaves = [], seq = 0;
    function build(t, parent, depth, path) {
      // ルート行は装置名 (フォルダから読んだものはファイル名) を使う
      var label = depth === 0 ? (device.name || t.name || '(名称なし)') : (t.name || '(名称なし)');
      var n = { id: device.id + ':' + (seq++), name: label, device: device, parent: parent, children: [], meshIndex: t.meshIndex, mesh: null, edges: null, depth: depth, path: path.concat([t.name || '']), visible: true, collapsed: depth >= 2, key: CrossRef.normalize(t.name || '') };
      nodes.push(n);
      (t.children || []).forEach(function (c) { n.children.push(build(c, n, depth + 1, n.path)); });
      if (n.meshIndex != null) leaves.push(n);
      // 集計: 配下のソリッド数
      n.leaves = n.meshIndex != null ? [n] : [];
      n.children.forEach(function (c) { n.leaves = n.leaves.concat(c.leaves); });
      n.solids = n.leaves.length;
      return n;
    }
    device.root = build(device.model.root, null, 0, []);
    device.root.collapsed = false;
    device.nodes = nodes; device.leaves = leaves;
    nodes.forEach(function (n) { nodesById[n.id] = n; });
  }

  function allLeaves() { var out = []; devices.forEach(function (d) { out = out.concat(d.leaves); }); return out; }
  function setVisible(n, v) { n.leaves.forEach(function (l) { l.visible = v; }); }
  function toggleSolo(n) {
    if (soloNode === n) { allLeaves().forEach(function (l) { l.visible = true; }); soloNode = null; }
    else { allLeaves().forEach(function (l) { l.visible = false; }); n.leaves.forEach(function (l) { l.visible = true; }); soloNode = n; }
    refresh();
  }

  function devicesUnder(n) {
    var out = [];
    (function walk(x) { if (x.isGroup) x.children.forEach(walk); else out.push(x.device); })(n);
    return out;
  }

  /* 装置の groupPath (元フォルダの相対パス) からフォルダのノードを作る */
  function buildForest() {
    groupIds.forEach(function (id) { delete nodesById[id]; });
    groups = []; groupIds = [];
    var roots = [], byPath = {};
    function groupFor(pathArr) {
      if (!pathArr.length) return null;
      var key = pathArr.join('/');
      if (byPath[key]) return byPath[key];
      var parent = groupFor(pathArr.slice(0, -1));
      var g = {
        id: 'g:' + key, isGroup: true, name: pathArr[pathArr.length - 1], device: null, parent: parent,
        children: [], meshIndex: null, depth: pathArr.length - 1, path: pathArr.slice(), leaves: [], solids: 0,
        collapsed: collapsedGroups[key] === true, key: ''
      };
      byPath[key] = g; groups.push(g); nodesById[g.id] = g; groupIds.push(g.id);
      if (parent) parent.children.push(g); else roots.push(g);
      return g;
    }
    Object.keys(folderPaths).forEach(function (key) { groupFor(key.split('/')); });   // 空のフォルダも残す
    devices.forEach(function (d) {
      var gp = d.groupPath || [];
      d.depthOffset = gp.length;
      var g = groupFor(gp);
      d.root.parent = g;
      if (g) g.children.push(d.root); else roots.push(d.root);
    });
    // VS Code の並び: フォルダが先、その中で名前順
    function order(list) {
      list.sort(function (a, b) {
        if (!!a.isGroup !== !!b.isGroup) return a.isGroup ? -1 : 1;
        return String(a.name).localeCompare(String(b.name), 'ja', { numeric: true, sensitivity: 'base' });
      });
      list.forEach(function (n) { if (n.isGroup) order(n.children); });
    }
    order(roots);
    // 子から親の順に leaves を集計する (groups は親→子の順に作られている)
    for (var i = groups.length - 1; i >= 0; i--) {
      var ls = [];
      groups[i].children.forEach(function (c) { ls = ls.concat(c.leaves || []); });
      groups[i].leaves = ls; groups[i].solids = ls.length;
    }
    return roots;
  }

  /* ---- 描画 ---- */
  function render(devs) {
    devices = devs;
    container.textContent = '';
    buildForest().forEach(function (n) { renderAny(n, container); });
    applyFocus();
    refresh();
  }
  function renderAny(n, parentEl) {
    if (!n.isGroup) { renderNode(n, parentEl); return; }
    renderGroupRow(n, parentEl);
    n.children.forEach(function (c) { renderAny(c, parentEl); });
  }
  function renderGroupRow(n, parentEl) {
    var row = el('div.tree-row.group', { role: 'treeitem', draggable: 'true', dataset: { id: n.id } });
    indent(row, n.depth);
    if (n.collapsed) row.classList.add('collapsed');
    var tw = el('button.twisty', { type: 'button', title: '開閉' }, [svgIcon(ICON.chevron)]);
    var cb = el('input', { type: 'checkbox', id: 'cb-' + n.id, dataset: { id: n.id }, title: 'このフォルダをまとめて表示 / 非表示' });
    cb.checked = true;
    // 中身のあるフォルダは塗りつぶして、空のフォルダと一目で区別できるようにする
    var icon = svgIcon(ICON.folder);
    if (n.children.length) icon.classList.add('filled');
    var nameBtn = el('button.name', { type: 'button', title: n.path.join(' / ') + (n.children.length ? '' : '（空）') }, [icon, el('label', { text: n.name })]);
    var tags = tagChips(n);
    var cnt = el('span.cnt', { text: devicesUnder(n).length + ' 件' });
    var solo = el('button.solo.btn.small.secondary', { type: 'button', text: 'ソロ', title: 'このフォルダだけ表示 / もう一度で全部戻す' });
    var close = el('button.close.btn.small', { type: 'button', title: 'このフォルダを閉じる（中の装置も表示から外します。ファイルは消えません）' }, [svgIcon('M6 6l12 12M18 6L6 18')]);
    [tw, cb, nameBtn, tags, cnt, actions(solo, close)].forEach(function (c) { row.appendChild(c); });
    parentEl.appendChild(row);
    rows[n.id] = row; n.row = row; n.cb = cb; n.xbadge = null;
  }
  /* 行の字下げ。`--guides` は上の階層の数 = 引く縦線の本数 (VS Code のインデントガイド)。
   * 線は CSS の ::before で親の開閉マークの真下に来る位置に引く (app.css) */
  function indent(row, level) {
    row.style.paddingLeft = (6 + level * 16) + 'px';
    row.style.setProperty('--guides', String(level));
  }

  /* 行の右端のボタン。VS Code と同じくホバーのときだけ名前の上に重ねる
   * (常に場所を取ると、狭い左パネルで名前とタグが入りきらない) */
  function actions(solo, close) {
    return el('span.row-actions', {}, [solo, close]);
  }

  /* フォルダ行のタグ。押すとそのタグで検索する (<div> に onclick を付けない)。
   * 行が名前で埋まらないよう、出すのは 2 つまでで残りは +N にする (全部はツールチップに) */
  var CHIPS = 2;
  function tagChips(n) {
    var box = el('span.tags'), list = Tags.get(n.path.join('/'));
    list.slice(0, CHIPS).forEach(function (t) {
      box.appendChild(el('button.tag', { type: 'button', dataset: { tag: t }, title: '「' + t + '」で検索', text: t }));
    });
    if (list.length > CHIPS) box.appendChild(el('span.tag.more', { text: '+' + (list.length - CHIPS), title: list.join(' · ') }));
    return box;
  }

  function renderNode(n, parentEl) {
    var row = el('div.tree-row', { role: 'treeitem', draggable: n.depth === 0 ? 'true' : 'false', dataset: { id: n.id } });
    indent(row, n.depth + ((n.device && n.device.depthOffset) || 0));
    if (n.depth === 0) row.classList.add('device');
    if (n.collapsed) row.classList.add('collapsed');
    var tw = el('button.twisty', { type: 'button', title: n.children.length ? '開閉' : '' }, [svgIcon(ICON.chevron)]);
    if (!n.children.length) tw.classList.add('leaf');
    var cb = el('input', { type: 'checkbox', id: 'cb-' + n.id, dataset: { id: n.id }, title: '表示 / 非表示' });
    cb.checked = true;
    var tip = n.path.join(' / ');
    if (n.depth === 0 && n.device) {
      tip = n.device.fileName + (n.device.model.name && n.device.model.name !== n.name ? '   (STEP 内の名称: ' + n.device.model.name + ')' : '');
      if (n.device.groupPath && n.device.groupPath.length) tip = n.device.groupPath.join(' / ') + ' / ' + tip;
    }
    var nameBtn = el('button.name', { type: 'button', title: tip }, [el('label', { text: n.name })]);
    var cnt = n.children.length ? el('span.cnt', { text: String(n.children.length) }) : null;
    var xb = el('span.xbadge', { hidden: true });
    var solo = el('button.solo.btn.small.secondary', { type: 'button', text: 'ソロ', title: 'この部品だけ表示 / もう一度で全部戻す' });
    // 装置の行だけ「閉じる」を出す (表示から外すだけで、ライブラリのファイルは消さない)
    var close = n.depth === 0
      ? el('button.close.btn.small', { type: 'button', title: 'この装置を閉じる（表示から外すだけで、ファイルは消えません）' }, [svgIcon('M6 6l12 12M18 6L6 18')])
      : null;
    [tw, cb, nameBtn, cnt, xb, actions(solo, close)].forEach(function (c) { if (c) row.appendChild(c); });
    parentEl.appendChild(row);
    rows[n.id] = row; n.row = row; n.cb = cb; n.xbadge = xb;
    n.children.forEach(function (c) { renderNode(c, parentEl); });
  }

  /* チェック状態 (親は 3 状態) とカウンタ、3D 側の表示を更新 */
  function updateCheck(n) {
    var vis = n.leaves.filter(function (l) { return l.visible; }).length;
    if (n.cb) { n.cb.checked = vis === n.leaves.length && n.leaves.length > 0; n.cb.indeterminate = vis > 0 && vis < n.leaves.length; }
    if (n.row) {
      n.row.classList.toggle('dim', vis === 0);
      var s = n.row.querySelector('.solo'); if (s) s.classList.toggle('active', soloNode === n);
    }
  }
  function refresh() {
    var total = 0, shown = 0;
    groups.forEach(updateCheck);
    devices.forEach(function (d) {
      d.nodes.forEach(function (n) {
        updateCheck(n);
      });
      total += d.leaves.length; shown += d.leaves.filter(function (l) { return l.visible; }).length;
    });
    counterEl.textContent = shown + ' / ' + total + ' 表示中';
    Viewer3D.updateAllStates();
    applyRowVisibility();
  }

  /* 名称かタグに当たるか (タグはフォルダだけが持つ) */
  function nodeMatches(n) {
    if (!filter) return false;
    if (Tags.fold(n.name).indexOf(filter) >= 0) return true;
    if (n.isGroup && Tags.hit(n.path.join('/'), filter)) return true;
    return false;
  }
  function rowVisibility(n) {
    var hidden = false;
    if (filter) {
      var match = nodeMatches(n) || n.leaves.some(function (l) { return Tags.fold(l.name).indexOf(filter) >= 0; });
      // 当たったフォルダの中身は、名前が違っても出す (タグで探して中を見るため)
      hidden = !match && !hasMatchingDescendant(n) && !hasMatchingAncestor(n);
    } else {
      for (var p = n.parent; p; p = p.parent) if (p.collapsed) { hidden = true; break; }
    }
    if (n.row) n.row.hidden = hidden;
  }
  function applyRowVisibility() {
    groups.forEach(rowVisibility);
    devices.forEach(function (d) {
      d.nodes.forEach(function (n) {
        rowVisibility(n);
      });
    });
  }
  function hasMatchingDescendant(n) {
    return n.children.some(function (c) { return nodeMatches(c) || hasMatchingDescendant(c); });
  }
  function hasMatchingAncestor(n) {
    for (var p = n.parent; p; p = p.parent) if (nodeMatches(p)) return true;
    return false;
  }

  /* ---- 検索 (左の絞り込みと右の結果一覧はひとつの問い合わせで動く) ---- */
  function applySearch(raw) {
    filter = Tags.fold(String(raw || '').trim());
    applyRowVisibility();
    if (window.Search) Search.run(raw);
  }
  function setSearch(raw) {
    searchEl.value = raw == null ? '' : raw;
    applySearch(searchEl.value);
  }

  /* 検索結果から選んだものだけ残す: 関係ない部品はチェックを外して非表示にする。
   * ソロと同じ状態にするので、もう一度ソロを押す / 「すべて表示」で戻せる */
  function isolate(n) {
    if (!n) return;
    allLeaves().forEach(function (l) { l.visible = false; });
    n.leaves.forEach(function (l) { l.visible = true; });
    soloNode = n;
    refresh();
    reveal(n);
  }
  /* その行が見えるところまで親を開いてスクロールする (選択はしない) */
  function reveal(n) {
    if (!n) return;
    for (var p = n.parent; p; p = p.parent) {
      if (!p.collapsed) continue;
      p.collapsed = false;
      if (p.isGroup) collapsedGroups[p.path.join('/')] = false;
      if (p.row) p.row.classList.remove('collapsed');
    }
    applyRowVisibility();
    if (n.row) n.row.scrollIntoView({ block: 'nearest' });
  }
  /* 検索が見に行くノード: フォルダ → 装置 → 部品 */
  function allNodes() {
    var out = groups.slice();
    devices.forEach(function (d) { out = out.concat(d.nodes); });
    return out;
  }

  function select(n) {
    if (selectedNode && selectedNode.row) selectedNode.row.classList.remove('selected');
    selectedNode = n;
    if (!n) return;
    if (n.row) {
      n.row.classList.add('selected');
      for (var p = n.parent; p; p = p.parent) { if (p.collapsed) { p.collapsed = false; p.row && p.row.classList.remove('collapsed'); } }
      applyRowVisibility();
      $('#tab-tree').checked = true; App.showLeftTab('tree');
      n.row.scrollIntoView({ block: 'nearest' });
    }
  }
  function setBadges(fn) {
    devices.forEach(function (d) { d.nodes.forEach(function (n) {
      var c = fn(n);
      if (!n.xbadge) return;
      n.xbadge.hidden = !c; n.xbadge.textContent = ''; if (c) n.xbadge.appendChild(el('span.badge', { text: '+' + c, title: '他の装置 ' + c + ' 件にも同名ユニット' }));
    }); });
  }
  /* ---- 複数選択 ---- */
  function selectable(n) { return !!n && (n.isGroup || n.depth === 0); }
  function isPicked(id) { return picked.indexOf(id) >= 0; }
  function setPicked(ids) { picked = (ids || []).filter(function (id) { return nodesById[id]; }); applyPicked(); }
  function togglePicked(id) {
    var i = picked.indexOf(id);
    if (i >= 0) picked.splice(i, 1); else picked.push(id);
    applyPicked();
  }
  function applyPicked() {
    $$('.tree-row.picked', container).forEach(function (r) { r.classList.remove('picked'); });
    picked.forEach(function (id) { var n = nodesById[id]; if (n && n.row) n.row.classList.add('picked'); });
    if (countEl2()) countEl2().textContent = picked.length > 1 ? picked.length + ' 件選択中' : '';
  }
  function countEl2() { return document.getElementById('tree-picked'); }
  /* 画面に出ている選択可能な行の並びで、2 点間をまとめて選ぶ */
  function rangeIds(fromId, toId) {
    var rows = $$('.tree-row', container).filter(function (r) {
      return !r.hidden && selectable(nodesById[r.dataset.id]);
    });
    var a = -1, b = -1;
    rows.forEach(function (r, i) { if (r.dataset.id === fromId) a = i; if (r.dataset.id === toId) b = i; });
    if (a < 0 || b < 0) return [toId];
    if (a > b) { var t = a; a = b; b = t; }
    return rows.slice(a, b + 1).map(function (r) { return r.dataset.id; });
  }
  function pickedNodes() {
    return picked.map(function (id) { return nodesById[id]; }).filter(Boolean);
  }

  function setFocused(n) {
    focusedId = n ? n.id : null;
    $$('.tree-row.focused', container).forEach(function (r) { r.classList.remove('focused'); });
    if (n && n.row) n.row.classList.add('focused');
  }
  function applyFocus() {
    var n = focusedId && nodesById[focusedId];
    if (n && n.row) n.row.classList.add('focused');
    setPicked(picked);   // 再描画で行が作り直されるので付け直す (消えた行は落ちる)
  }

  /* ---- フォルダの編集 (VS Code 風の操作は 06b-treeedit.js が呼ぶ) ---- */
  function folderExists(pathArr) { return folderPaths[pathArr.join('/')] === true; }
  function childNames(pathArr) {
    var prefix = pathArr.length ? pathArr.join('/') + '/' : '', out = {};
    Object.keys(folderPaths).forEach(function (k) {
      if (k.indexOf(prefix) !== 0) return;
      var rest = k.slice(prefix.length);
      if (rest && rest.indexOf('/') < 0) out[rest] = 'folder';
    });
    devices.forEach(function (d) { if ((d.groupPath || []).join('/') === pathArr.join('/')) out[d.name] = 'device'; });
    return out;
  }
  function uniqueName(pathArr, base) {
    var taken = childNames(pathArr), name = base, i = 2;
    while (taken[name]) name = base + ' ' + (i++);
    return name;
  }
  function addFolder(parentPath, name) {
    var p = (parentPath || []).slice();
    var n = uniqueName(p, name || '新しいフォルダー');
    var full = p.concat([n]);
    folderPaths[full.join('/')] = true;
    collapsedGroups[full.join('/')] = false;
    for (var i = 1; i < full.length; i++) {
      var anc = full.slice(0, i).join('/');
      folderPaths[anc] = true;
      collapsedGroups[anc] = false;   // 畳んだフォルダの中に作ったら開いて見せる
    }
    render(devices);
    return full;
  }
  /* パスの付け替え。フォルダの登録と装置の groupPath をまとめて書き換える。
   * フォルダの id はパスから作るので、選択中の行も付け替える */
  function repath(oldPath, newPath) {
    var oldKey = oldPath.join('/'), newKey = newPath.join('/');
    Tags.repath(oldKey, newKey);   // フォルダの id はパスから作るので、タグも一緒に動かす
    if (focusedId && focusedId.indexOf('g:') === 0) {
      var fk = focusedId.slice(2);
      if (fk === oldKey) focusedId = 'g:' + newKey;
      else if (fk.indexOf(oldKey + '/') === 0) focusedId = 'g:' + newKey + fk.slice(oldKey.length);
    }
    var updated = {};
    Object.keys(folderPaths).forEach(function (k) {
      if (k === oldKey) updated[newKey] = true;
      else if (k.indexOf(oldKey + '/') === 0) updated[newKey + k.slice(oldKey.length)] = true;
      else updated[k] = true;
    });
    folderPaths = updated;
    var col = {};
    Object.keys(collapsedGroups).forEach(function (k) {
      if (k === oldKey) col[newKey] = collapsedGroups[k];
      else if (k.indexOf(oldKey + '/') === 0) col[newKey + k.slice(oldKey.length)] = collapsedGroups[k];
      else col[k] = collapsedGroups[k];
    });
    collapsedGroups = col;
    devices.forEach(function (d) {
      var g = (d.groupPath || []).join('/');
      if (g === oldKey) d.groupPath = newPath.slice();
      else if (g.indexOf(oldKey + '/') === 0) d.groupPath = newPath.concat(g.slice(oldKey.length + 1).split('/'));
    });
  }
  function renameNode(n, name) {
    name = String(name || '').replace(/[\\/]/g, '_').trim();
    if (!name || name === n.name) return false;
    if (n.isGroup) {
      var parent = n.path.slice(0, -1);
      if (childNames(parent)[name]) return false;                 // 同じ階層に同名があるとき
      repath(n.path, parent.concat([name]));
    } else {
      if (childNames(n.device.groupPath || [])[name]) return false;
      n.device.name = name; n.name = name; n.key = CrossRef.normalize(name);
    }
    render(devices);
    CrossRef.rebuild(devices);
    return true;
  }
  /* 移動先フォルダへ入れる。targetPath = [] でルート */
  function moveNode(n, targetPath) {
    var ok = moveOne(n, targetPath);
    if (ok) render(devices);
    return ok;
  }
  /* まとめて移動。選択の中に親子が混ざっていたら親だけ動かす (子は付いてくる) */
  function moveNodes(nodes, targetPath) {
    var groupKeys = nodes.filter(function (n) { return n.isGroup; }).map(function (n) { return n.path.join('/'); });
    var list = nodes.filter(function (n) {
      var own = n.isGroup ? n.path.join('/') : null;
      var parentKey = n.isGroup ? n.path.slice(0, -1).join('/') : (n.device.groupPath || []).join('/');
      return !groupKeys.some(function (g) { return g !== own && (parentKey === g || parentKey.indexOf(g + '/') === 0); });
    });
    var moved = 0, refused = 0;
    list.forEach(function (n) { if (moveOne(n, targetPath)) moved++; else refused++; });
    if (moved) render(devices);
    return { moved: moved, refused: refused };
  }
  function moveOne(n, targetPath) {
    targetPath = (targetPath || []).slice();
    if (n.isGroup) {
      var oldKey = n.path.join('/'), tgt = targetPath.join('/');
      if (tgt === oldKey || tgt.indexOf(oldKey + '/') === 0) return false;   // 自分の中へは入れない
      if (n.path.slice(0, -1).join('/') === tgt) return false;               // すでにそこにある
      repath(n.path, targetPath.concat([n.name]));
    } else {
      if ((n.device.groupPath || []).join('/') === targetPath.join('/')) return false;
      n.device.groupPath = targetPath;
    }
    for (var i = 1; i <= targetPath.length; i++) folderPaths[targetPath.slice(0, i).join('/')] = true;
    return true;
  }
  /* フォルダごと片づける (中の装置は呼び出し側が閉じる) */
  function removeFolder(n) {
    if (!n || !n.isGroup) return;
    var key = n.path.join('/');
    Object.keys(folderPaths).forEach(function (k) { if (k === key || k.indexOf(key + '/') === 0) delete folderPaths[k]; });
    Object.keys(collapsedGroups).forEach(function (k) { if (k === key || k.indexOf(key + '/') === 0) delete collapsedGroups[k]; });
    if (focusedId === n.id) focusedId = null;
  }

  /* フォルダを解除して中身を親へ移す */
  function dissolveFolder(n) {
    if (!n.isGroup) return false;
    var parent = n.path.slice(0, -1), key = n.path.join('/');
    n.children.slice().forEach(function (c) { moveOne(c, parent); });
    delete folderPaths[key]; delete collapsedGroups[key];
    if (focusedId === n.id) focusedId = parent.length ? 'g:' + parent.join('/') : null;   // 消えた行を選んだままにしない
    render(devices);
    return true;
  }
  /* 装置が使っているフォルダを登録しておく (フォルダ読み込みの直後に呼ぶ) */
  function registerDeviceFolders() {
    devices.forEach(function (d) {
      var gp = d.groupPath || [];
      for (var i = 1; i <= gp.length; i++) folderPaths[gp.slice(0, i).join('/')] = true;
    });
  }

  function removeDevice(device) {
    device.nodes.forEach(function (n) { delete nodesById[n.id]; delete rows[n.id]; });
    device.root.parent = null;
    if (soloNode && soloNode.device === device) soloNode = null;
    if (selectedNode && selectedNode.device === device) selectedNode = null;
  }
  return {
    init: init, buildDevice: buildDevice, render: render, refresh: refresh, select: select, setBadges: setBadges,
    removeDevice: removeDevice, nodesById: function () { return nodesById; },
    addFolder: addFolder, renameNode: renameNode, moveNode: moveNode, dissolveFolder: dissolveFolder, removeFolder: removeFolder,
    devicesUnder: devicesUnder, registerDeviceFolders: registerDeviceFolders,
    focused: function () { return focusedId ? nodesById[focusedId] : null; }, setFocused: setFocused,
    picked: pickedNodes, setPicked: setPicked, isPicked: isPicked, moveNodes: moveNodes, selectable: selectable,
    nodeById: function (id) { return nodesById[id]; }, allNodes: allNodes,
    isolate: isolate, reveal: reveal, setSearch: setSearch, query: function () { return filter; },
    rerender: function () { render(devices); }, container: function () { return container; }
  };
})();
