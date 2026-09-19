/* 構成ツリー。行 = [開閉] [チェックボックス] [部品名] [子の数] [ソロ]
 * チェック操作でカメラは動かさない。 */
var Tree = (function () {
  var container, counterEl, emptyEl, searchEl;
  var devices = [], nodesById = {}, rows = {}, soloNode = null, selectedNode = null, filter = '';
  var groups = [], groupIds = [], collapsedGroups = {};   // フォルダ階層 (元のフォルダ構成をそのまま出す)
  var callbacks = {};

  function init(opts) {
    callbacks = opts;
    container = $('#tree'); counterEl = $('#tree-counter'); emptyEl = $('#tree-empty'); searchEl = $('#tree-search');
    // イベント委譲 (行ごとにリスナーを付けない)
    container.addEventListener('change', function (e) {
      var cb = e.target; if (cb.type !== 'checkbox') return;
      var n = nodesById[cb.dataset.id]; if (!n) return;
      setVisible(n, cb.checked); soloNode = null; refresh();
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
      else if (b.classList.contains('close')) { callbacks.onClose(n.isGroup ? devicesUnder(n) : n.device); }
      else if (b.classList.contains('name')) { callbacks.onSelect(n); }   // フォルダは上の分岐で開閉になる
    });
    container.addEventListener('mouseover', function (e) {
      var row = e.target.closest('.tree-row'); var n = row && nodesById[row.dataset.id];
      callbacks.onHover(n || null);
    });
    container.addEventListener('mouseleave', function () { callbacks.onHover(null); });
    searchEl.addEventListener('input', debounce(function () { filter = searchEl.value.trim().toLowerCase(); applyRowVisibility(); }, 120));
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
    devices.forEach(function (d) {
      var gp = d.groupPath || [];
      d.depthOffset = gp.length;
      var g = groupFor(gp);
      d.root.parent = g;
      if (g) g.children.push(d.root); else roots.push(d.root);
    });
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
    emptyEl.hidden = devices.length > 0;
    refresh();
  }
  function renderAny(n, parentEl) {
    if (!n.isGroup) { renderNode(n, parentEl); return; }
    renderGroupRow(n, parentEl);
    n.children.forEach(function (c) { renderAny(c, parentEl); });
  }
  function renderGroupRow(n, parentEl) {
    var row = el('div.tree-row.group', { role: 'treeitem', dataset: { id: n.id } });
    row.style.paddingLeft = (6 + n.depth * 16) + 'px';
    if (n.collapsed) row.classList.add('collapsed');
    var tw = el('button.twisty', { type: 'button', title: '開閉' }, [svgIcon(ICON.chevron)]);
    var cb = el('input', { type: 'checkbox', id: 'cb-' + n.id, dataset: { id: n.id }, title: 'このフォルダをまとめて表示 / 非表示' });
    cb.checked = true;
    var nameBtn = el('button.name', { type: 'button', title: n.path.join(' / ') }, [svgIcon(ICON.folder), el('label', { text: n.name })]);
    var cnt = el('span.cnt', { text: devicesUnder(n).length + ' 件' });
    var solo = el('button.solo.btn.small.secondary', { type: 'button', text: 'ソロ', title: 'このフォルダだけ表示 / もう一度で全部戻す' });
    var close = el('button.close.btn.small', { type: 'button', title: 'このフォルダの装置をすべて閉じる（ファイルは消えません）' }, [svgIcon('M6 6l12 12M18 6L6 18')]);
    [tw, cb, nameBtn, cnt, solo, close].forEach(function (c) { row.appendChild(c); });
    parentEl.appendChild(row);
    rows[n.id] = row; n.row = row; n.cb = cb; n.xbadge = null;
  }
  function renderNode(n, parentEl) {
    var row = el('div.tree-row', { role: 'treeitem', dataset: { id: n.id } });
    row.style.paddingLeft = (6 + (n.depth + ((n.device && n.device.depthOffset) || 0)) * 16) + 'px';
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
    [tw, cb, nameBtn, cnt, xb, solo, close].forEach(function (c) { if (c) row.appendChild(c); });
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

  function rowVisibility(n) {
    var hidden = false;
    if (filter) {
      var match = n.name.toLowerCase().indexOf(filter) >= 0 || n.leaves.some(function (l) { return l.name.toLowerCase().indexOf(filter) >= 0; });
      hidden = !match && !hasMatchingDescendant(n);
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
    return n.children.some(function (c) { return c.name.toLowerCase().indexOf(filter) >= 0 || hasMatchingDescendant(c); });
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
  function removeDevice(device) {
    device.nodes.forEach(function (n) { delete nodesById[n.id]; delete rows[n.id]; });
    device.root.parent = null;
    if (soloNode && soloNode.device === device) soloNode = null;
    if (selectedNode && selectedNode.device === device) selectedNode = null;
  }
  return { init: init, buildDevice: buildDevice, render: render, refresh: refresh, select: select, setBadges: setBadges, removeDevice: removeDevice, nodesById: function () { return nodesById; } };
})();
