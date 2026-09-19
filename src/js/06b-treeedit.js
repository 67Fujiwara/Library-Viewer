/* 構成ツリーの編集 (VS Code のエクスプローラに合わせた操作)
 *
 *   新規フォルダ      ツールバーのボタン / 右クリック → 「新しいフォルダー」
 *   名前の変更        F2 / 右クリック → 「名前の変更」。行がそのまま入力欄になる
 *                     Enter で確定、Esc で取り消し、拡張子の手前まで選択される
 *   移動              行をドラッグしてフォルダへドロップ。空白へ落とすと最上位へ
 *   閉じる            Delete / 右クリック → 「閉じる」
 *
 * ドロップした STEP は最初みな同じ階層に並ぶので、ここで好きな構成に組み替えられる。
 */
var TreeEdit = (function () {
  var container, menuEl = null, dragId = null, dropTarget = null, editing = null;
  var MIME = 'application/x-lv-node';   // 外から来たファイルのドロップと区別するため

  function init() {
    container = Tree.container();
    $('#btn-new-folder').addEventListener('click', function () { newFolder(parentForNew()); });
    container.addEventListener('contextmenu', onContextMenu);
    container.addEventListener('dragstart', onDragStart);
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('dragleave', onDragLeave);
    container.addEventListener('drop', onDrop);
    container.addEventListener('dragend', clearDrop);
    container.addEventListener('keydown', onKeyDown);
    container.setAttribute('tabindex', '0');
    window.addEventListener('keydown', function (e) {
      if (editing || e.target.closest('input, textarea, dialog')) return;
      var n = Tree.focused(); if (!n) return;
      if (e.key === 'F2') { e.preventDefault(); startRename(n); }
      else if (e.key === 'Delete') { e.preventDefault(); closeNode(n); }
    });
    document.addEventListener('click', hideMenu, true);
    window.addEventListener('blur', hideMenu);
  }

  /* 新規フォルダの作成先: フォルダを選んでいればその中、装置ならその親、無ければ最上位 */
  function parentForNew() {
    var n = Tree.focused();
    if (!n) return [];
    if (n.isGroup) return n.path.slice();
    if (n.device) return (n.device.groupPath || []).slice();
    return [];
  }
  function newFolder(parentPath) {
    var path = Tree.addFolder(parentPath, '新しいフォルダー');
    var node = Tree.nodeById('g:' + path.join('/'));
    if (node) { Tree.setFocused(node); scrollTo(node); startRename(node); }
  }
  function scrollTo(n) { if (n.row) n.row.scrollIntoView({ block: 'nearest' }); }

  /* ---- 名前の変更 (行を入力欄に差し替える) ---- */
  function startRename(n) {
    if (editing || !n || !n.row) return;
    var nameBtn = n.row.querySelector('button.name');
    if (!nameBtn) return;
    var input = el('input.rename-input', { type: 'text', value: n.name, spellcheck: 'false' });
    nameBtn.hidden = true;
    nameBtn.insertAdjacentElement('afterend', input);
    editing = { node: n, input: input, btn: nameBtn };
    input.focus();
    // VS Code と同じく、装置は拡張子の手前まで選択する
    var dot = n.isGroup ? -1 : n.name.lastIndexOf('.');
    if (dot > 0) input.setSelectionRange(0, dot); else input.select();
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', function () { commit(true); });
  }
  function commit(apply) {
    if (!editing) return;
    var e = editing; editing = null;
    var value = e.input.value;
    e.input.remove(); e.btn.hidden = false;
    if (apply) {
      if (!Tree.renameNode(e.node, value) && value.trim() && value !== e.node.name) {
        showMessage('名前を変更できません', '同じ階層に「' + value.trim() + '」がすでにあります。');
      }
    }
  }

  /* ---- ドラッグで移動 ---- */
  function onDragStart(e) {
    var row = e.target.closest('.tree-row');
    var n = row && Tree.nodeById(row.dataset.id);
    if (!n || (!n.isGroup && n.depth !== 0)) { e.preventDefault(); return; }   // 部品の行は動かさない
    dragId = n.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(MIME, n.id);
    e.dataTransfer.setData('text/plain', n.name);
    row.classList.add('dragging-row');
  }
  function targetPathFor(e) {
    var row = e.target.closest('.tree-row');
    if (!row) return { path: [], row: null };                     // 空白 = 最上位へ
    var n = Tree.nodeById(row.dataset.id);
    if (!n) return { path: [], row: null };
    if (n.isGroup) return { path: n.path.slice(), row: row };
    if (n.device) return { path: (n.device.groupPath || []).slice(), row: null };   // 装置の上 = その親フォルダ
    return { path: [], row: null };
  }
  function onDragOver(e) {
    if (!dragId || Array.prototype.indexOf.call(e.dataTransfer.types, MIME) < 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var t = targetPathFor(e);
    setDropTarget(t.row);
    container.classList.toggle('drop-root', !t.row);
  }
  function onDragLeave(e) { if (e.target === container) clearDrop(); }
  function setDropTarget(row) {
    if (dropTarget === row) return;
    if (dropTarget) dropTarget.classList.remove('drop-into');
    dropTarget = row;
    if (dropTarget) dropTarget.classList.add('drop-into');
  }
  function clearDrop() {
    setDropTarget(null);
    container.classList.remove('drop-root');
    $$('.dragging-row', container).forEach(function (r) { r.classList.remove('dragging-row'); });
    dragId = null;
  }
  function onDrop(e) {
    if (!dragId || Array.prototype.indexOf.call(e.dataTransfer.types, MIME) < 0) return;
    e.preventDefault(); e.stopPropagation();
    var n = Tree.nodeById(dragId), t = targetPathFor(e);
    clearDrop();
    if (!n) return;
    if (!Tree.moveNode(n, t.path) && n.isGroup) {
      var tgt = t.path.join('/'), me = n.path.join('/');
      if (tgt === me || tgt.indexOf(me + '/') === 0) showMessage('移動できません', 'フォルダを自分自身の中へは移動できません。');
    }
  }

  /* ---- 右クリックメニュー ---- */
  function onContextMenu(e) {
    var row = e.target.closest('.tree-row');
    var n = row && Tree.nodeById(row.dataset.id);
    e.preventDefault();
    if (row) { row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); }
    showMenu(e.clientX, e.clientY, buildItems(n));
  }
  function buildItems(n) {
    var items = [];
    var parent = n ? (n.isGroup ? n.path.slice() : (n.device ? (n.device.groupPath || []).slice() : [])) : [];
    items.push({ label: '新しいフォルダー', run: function () { newFolder(parent); } });
    if (n && (n.isGroup || n.depth === 0)) {
      items.push({ sep: true });
      items.push({ label: '名前の変更', hint: 'F2', run: function () { startRename(n); } });
      if (n.isGroup) items.push({ label: 'フォルダを解除（中身を上へ）', run: function () { Tree.dissolveFolder(n); } });
      if (parent.length) items.push({ label: '最上位へ移動', run: function () { Tree.moveNode(n, []); } });
      items.push({ sep: true });
      items.push({ label: n.isGroup ? 'このフォルダを閉じる（中の装置も）' : '閉じる', hint: 'Delete', danger: true, run: function () { closeNode(n); } });
    }
    return items;
  }
  function closeNode(n) {
    if (!n) return;
    if (n.isGroup) {
      var list = Tree.devicesUnder(n);
      Tree.removeFolder(n);          // フォルダごと片づける (中身を残したいときは「フォルダを解除」)
      if (list.length) App.removeDevice(list); else Tree.rerender();
    } else if (n.depth === 0 && n.device) App.removeDevice(n.device);
  }
  function showMenu(x, y, items) {
    hideMenu();
    menuEl = el('div.ctx-menu', { role: 'menu' });
    items.forEach(function (it) {
      if (it.sep) { menuEl.appendChild(el('div.ctx-sep')); return; }
      var b = el('button.ctx-item' + (it.danger ? '.danger' : ''), { type: 'button', role: 'menuitem' }, [
        el('span', { text: it.label }), it.hint ? el('span.hint', { text: it.hint }) : null
      ]);
      b.addEventListener('click', function () { hideMenu(); it.run(); });
      menuEl.appendChild(b);
    });
    document.body.appendChild(menuEl);
    var r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    menuEl.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  }
  function hideMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function onKeyDown(e) { if (e.key === 'Escape') hideMenu(); }

  return { init: init, newFolder: newFolder, startRename: startRename, isEditing: function () { return !!editing; } };
})();
