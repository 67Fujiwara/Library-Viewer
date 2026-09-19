/* 構成ツリー。行 = [開閉] [チェックボックス] [部品名] [子の数] [ソロ]
 * チェック操作でカメラは動かさない。 */
var Tree = (function () {
  var container, counterEl, emptyEl, searchEl;
  var devices = [], nodesById = {}, rows = {}, soloNode = null, selectedNode = null, filter = '';
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
      if (b.classList.contains('twisty')) { n.collapsed = !n.collapsed; row.classList.toggle('collapsed', n.collapsed); applyRowVisibility(); }
      else if (b.classList.contains('solo')) { toggleSolo(n); }
      else if (b.classList.contains('name')) { callbacks.onSelect(n); }
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
      var n = { id: device.id + ':' + (seq++), name: t.name || '(名称なし)', device: device, parent: parent, children: [], meshIndex: t.meshIndex, mesh: null, edges: null, depth: depth, path: path.concat([t.name || '']), visible: true, collapsed: depth >= 2, key: CrossRef.normalize(t.name || '') };
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

  /* ---- 描画 ---- */
  function render(devs) {
    devices = devs;
    container.textContent = '';
    devices.forEach(function (d) { renderNode(d.root, container); });
    emptyEl.hidden = devices.length > 0;
    refresh();
  }
  function renderNode(n, parentEl) {
    var row = el('div.tree-row', { role: 'treeitem', dataset: { id: n.id } });
    row.style.paddingLeft = (6 + n.depth * 16) + 'px';
    if (n.depth === 0) row.classList.add('device');
    if (n.collapsed) row.classList.add('collapsed');
    var tw = el('button.twisty', { type: 'button', title: n.children.length ? '開閉' : '' }, [svgIcon(ICON.chevron)]);
    if (!n.children.length) tw.classList.add('leaf');
    var cb = el('input', { type: 'checkbox', id: 'cb-' + n.id, dataset: { id: n.id }, title: '表示 / 非表示' });
    cb.checked = true;
    var nameBtn = el('button.name', { type: 'button', title: n.path.join(' / ') }, [el('label', { text: n.name })]);
    var cnt = n.children.length ? el('span.cnt', { text: String(n.children.length) }) : null;
    var xb = el('span.xbadge', { hidden: true });
    var solo = el('button.solo.btn.small.secondary', { type: 'button', text: 'ソロ', title: 'この部品だけ表示 / もう一度で全部戻す' });
    [tw, cb, nameBtn, cnt, xb, solo].forEach(function (c) { if (c) row.appendChild(c); });
    parentEl.appendChild(row);
    rows[n.id] = row; n.row = row; n.cb = cb; n.xbadge = xb;
    n.children.forEach(function (c) { renderNode(c, parentEl); });
  }

  /* チェック状態 (親は 3 状態) とカウンタ、3D 側の表示を更新 */
  function refresh() {
    var total = 0, shown = 0;
    devices.forEach(function (d) {
      d.nodes.forEach(function (n) {
        var vis = n.leaves.filter(function (l) { return l.visible; }).length;
        if (n.cb) { n.cb.checked = vis === n.leaves.length && n.leaves.length > 0; n.cb.indeterminate = vis > 0 && vis < n.leaves.length; }
        if (n.row) {
          n.row.classList.toggle('dim', vis === 0);
          var s = n.row.querySelector('.solo'); if (s) s.classList.toggle('active', soloNode === n);
        }
      });
      total += d.leaves.length; shown += d.leaves.filter(function (l) { return l.visible; }).length;
    });
    counterEl.textContent = shown + ' / ' + total + ' 表示中';
    Viewer3D.updateAllStates();
    applyRowVisibility();
  }

  function applyRowVisibility() {
    devices.forEach(function (d) {
      d.nodes.forEach(function (n) {
        var hidden = false;
        if (filter) {
          var match = n.name.toLowerCase().indexOf(filter) >= 0 || n.leaves.some(function (l) { return l.name.toLowerCase().indexOf(filter) >= 0; }) || n.nodesMatch;
          // 一致する子孫があれば見せる
          hidden = !match && !hasMatchingDescendant(n);
        } else {
          for (var p = n.parent; p; p = p.parent) if (p.collapsed) { hidden = true; break; }
        }
        if (n.row) n.row.hidden = hidden;
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
    if (soloNode && soloNode.device === device) soloNode = null;
    if (selectedNode && selectedNode.device === device) selectedNode = null;
  }
  return { init: init, buildDevice: buildDevice, render: render, refresh: refresh, select: select, setBadges: setBadges, removeDevice: removeDevice, nodesById: function () { return nodesById; } };
})();
