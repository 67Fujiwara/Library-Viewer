/* アプリ本体: 状態と UI の配線 */
var App = (function () {
  var devices = [], selectedNode = null, seq = 0, currentPrecision = 'standard', lastLibraryEntry = null;
  var overlay, overlayTitle, overlayMsg;

  function init() {
    overlay = $('#overlay'); overlayTitle = $('#overlay-title'); overlayMsg = $('#overlay-msg');
    Theme.init();
    Panels.init();
    Viewer3D.init({ onSelect: function (n) { select(n); }, onHover: function (n) { /* 3D 側ホバーはツリー連動なし */ } });
    Theme.onChange(function () { Viewer3D.applyTheme(); });
    Tree.init({ onSelect: function (n) { select(n); }, onHover: function (n) { Viewer3D.setHover(n); } });
    CrossRef.init(); Library.init(); Store.init();
    bindUI();
    // 起動直後の空き時間に WASM を展開しておく (初回変換を速くする)
    setTimeout(function () { Occt.load().catch(function (e) { showMessage('初期化エラー', e.message); }); }, 400);
  }

  function bindUI() {
    // ファイル選択 / ドラッグ&ドロップ (ウィンドウ全体)
    $('#file-input').addEventListener('change', function (e) { loadFiles(Array.prototype.slice.call(e.target.files)); e.target.value = ''; });
    var dragDepth = 0;
    window.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function (e) { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('drop', function (e) {
      e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
      var files = Array.prototype.slice.call(e.dataTransfer.files).filter(function (f) { return /\.(step|stp|glb)$/i.test(f.name); });
      if (files.length) loadFiles(files);
    });
    // 精度
    $('#precision').addEventListener('change', function (e) { currentPrecision = e.target.value; });
    $('#btn-remesh').addEventListener('click', remeshAll);
    // 表示モード
    $$('input[name="viewmode"]').forEach(function (r) { r.addEventListener('change', function () {
      if (!r.checked) return; Viewer3D.setMode(r.value); $('#section-ctl').hidden = r.value !== 'section'; updateSectionLabel();
    }); });
    $('#chk-edges').addEventListener('change', function (e) { Viewer3D.setEdges(e.target.checked); });
    $('#btn-fit').addEventListener('click', function () { Viewer3D.fitAll(); });
    $('#btn-fit-sel').addEventListener('click', function () { if (selectedNode) Viewer3D.fitNode(selectedNode); });
    // 断面
    $$('input[name="secaxis"]').forEach(function (r) { r.addEventListener('change', function () { if (r.checked) { Viewer3D.setSection(r.value, null, null); Viewer3D.updateAllStates(); updateSectionLabel(); } }); });
    $('#sec-pos').addEventListener('input', function (e) { Viewer3D.setSection(null, e.target.value / 1000, null); updateSectionLabel(); });
    $('#chk-sec-flip').addEventListener('change', function (e) { Viewer3D.setSection(null, null, e.target.checked); updateSectionLabel(); });
    // 左タブ
    $$('input[name="left-tab"]').forEach(function (r) { r.addEventListener('change', function () { if (r.checked) showLeftTab(r.value); }); });
    // キーボード
    window.addEventListener('keydown', function (e) {
      var t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.closest('dialog'))) return;
      if (e.key === '[') { Panels.toggle('left'); e.preventDefault(); }
      else if (e.key === ']') { Panels.toggle('right'); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { CrossRef.step(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { CrossRef.step(1); e.preventDefault(); }
      else if (e.key === 'Escape') select(null);
      else if (e.key === 'f' || e.key === 'F') Viewer3D.fitAll();
    });
  }
  function updateSectionLabel() {
    var v = Viewer3D.sectionValue();
    $('#sec-val').textContent = v == null ? '' : ($('input[name="secaxis"]:checked').value.toUpperCase() + ' = ' + v.toFixed(1) + ' mm');
  }
  function showLeftTab(name) {
    $('#tree-panel').hidden = name !== 'tree'; $('#lib-panel').hidden = name !== 'lib';
    $('#tab-' + name).checked = true;
  }

  /* ---- オーバーレイ ---- */
  function showOverlay(title, msg) { overlayTitle.textContent = title; overlayMsg.textContent = msg || ''; overlay.hidden = false; }
  function hideOverlay() { overlay.hidden = true; }

  /* ---- ファイル読み込み ---- */
  async function loadFiles(files) {
    var stepFiles = files.filter(function (f) { return /\.(step|stp)$/i.test(f.name); });
    var glbFiles = files.filter(function (f) { return /\.glb$/i.test(f.name); });
    for (var g = 0; g < glbFiles.length; g++) {
      try { var gb = new Uint8Array(await glbFiles[g].arrayBuffer()); addDevice({ model: GLB.read(gb), fileName: glbFiles[g].name, stepBytes: null, source: { kind: 'file' } }); }
      catch (e) { showMessage('読み込みに失敗しました', glbFiles[g].name + '\n' + e.message); }
    }
    for (var i = 0; i < stepFiles.length; i++) {
      var f = stepFiles[i];
      showOverlay('変換中  ' + (i + 1) + ' / ' + stepFiles.length, f.name);
      await nextFrames(2);   // メインスレッドが止まる前にオーバーレイを描画させる
      try {
        var bytes = new Uint8Array(await f.arrayBuffer());
        var model = await Occt.convert(bytes, currentPrecision, baseName(f.name));
        addDevice({ model: model, fileName: f.name, stepBytes: bytes, source: { kind: 'file' } });
      } catch (e) {
        hideOverlay();
        showMessage('変換に失敗しました', f.name + '\n' + (e && e.message || e));
      }
    }
    hideOverlay();
    if (devices.length && (stepFiles.length || glbFiles.length)) Viewer3D.fitAll();
  }

  function addDevice(d) {
    d.id = 'd' + (++seq); d.name = d.model.name || baseName(d.fileName); d.precision = currentPrecision;
    d.naming = Naming.parse(d.fileName);   // ファイル名がルールに合えば案件情報を持たせる
    // 同名の装置が既にあればファイル名で区別
    if (devices.some(function (x) { return x.name === d.name; })) d.name = d.name + ' (' + d.fileName + ')';
    Tree.buildDevice(d);
    devices.push(d);
    Viewer3D.addDevice(d);
    Tree.render(devices);
    CrossRef.rebuild(devices);
    afterDevicesChanged();
    return d;
  }
  function removeDevice(d) {
    Viewer3D.removeDevice(d); Tree.removeDevice(d);
    devices.splice(devices.indexOf(d), 1);
    if (selectedNode && selectedNode.device === d) select(null);
    Tree.render(devices); CrossRef.rebuild(devices); afterDevicesChanged();
  }
  function clearDevices() { devices.slice().forEach(removeDevice); }
  function afterDevicesChanged() {
    var has = devices.length > 0;
    $('#drop-hint').hidden = has; $('#btn-store').disabled = !has;
    $('#btn-remesh').disabled = !devices.some(function (d) { return d.stepBytes; });
    if (selectedNode) CrossRef.show(selectedNode);
  }

  /* 精度変更 → 保持している STEP バッファから再メッシュ */
  async function remeshAll() {
    var targets = devices.filter(function (d) { return d.stepBytes; });
    if (!targets.length) return;
    var selPath = selectedNode ? selectedNode.path.join('/') : null;
    for (var i = 0; i < targets.length; i++) {
      var d = targets[i];
      showOverlay('再変換中  ' + (i + 1) + ' / ' + targets.length, d.fileName + '  (' + Occt.PRESETS[currentPrecision].label + ')');
      await nextFrames(2);
      try {
        var model = await Occt.convert(d.stepBytes, currentPrecision, baseName(d.fileName));
        var hidden = {}; d.leaves.forEach(function (l) { if (!l.visible) hidden[l.path.join('/')] = 1; });
        Viewer3D.removeDevice(d); Tree.removeDevice(d);
        d.model = model; d.precision = currentPrecision;
        Tree.buildDevice(d);
        d.leaves.forEach(function (l) { if (hidden[l.path.join('/')]) l.visible = false; });
        Viewer3D.addDevice(d);
      } catch (e) { showMessage('再変換に失敗しました', d.fileName + '\n' + e.message); }
    }
    hideOverlay();
    Tree.render(devices); CrossRef.rebuild(devices);
    if (selPath) { var n = null; devices.forEach(function (d) { d.nodes.forEach(function (x) { if (x.path.join('/') === selPath) n = x; }); }); select(n); }
  }

  /* ---- 選択 ---- */
  function select(n, opts) {
    opts = opts || {};
    selectedNode = n;
    Viewer3D.setSelected(n);
    Tree.select(n);
    $('#btn-fit-sel').disabled = !n;
    if (n && opts.keepAngle) Viewer3D.moveToNode(n);
    if (!opts.keepXref) CrossRef.show(n);
    CrossRef.markCurrent(n);
    renderFooter(n);
  }
  function renderFooter(n) {
    var box = $('#sel-info'); box.textContent = '';
    if (!n) { box.appendChild(el('span.muted', { text: '未選択' })); return; }
    var st = Viewer3D.stats(n);
    function kv(k, v) { return el('span', {}, [el('span.k', { text: k }), el('span.v', { text: v })]); }
    box.appendChild(el('span.n', { text: n.name }));
    box.appendChild(kv('装置', n.device.name));
    box.appendChild(kv('パス', n.path.slice(1).join(' / ') || '-'));
    box.appendChild(kv('ソリッド', String(st.solids)));
    box.appendChild(kv('三角形', fmtInt(st.tris)));
    if (st.size) box.appendChild(kv('寸法', st.size.x.toFixed(1) + ' × ' + st.size.y.toFixed(1) + ' × ' + st.size.z.toFixed(1) + ' mm'));
    box.appendChild(kv('glb 概算', fmtBytes(st.glbEstimate)));
  }

  return {
    init: init, addDevice: addDevice, removeDevice: removeDevice, clearDevices: clearDevices, select: select,
    devices: function () { return devices; }, selected: function () { return selectedNode; }, precision: function () { return currentPrecision; },
    showOverlay: showOverlay, hideOverlay: hideOverlay, showLeftTab: showLeftTab,
    onLibraryChanged: function () { }, stepSource: function (e) { lastLibraryEntry = e; }
  };
})();
document.addEventListener('DOMContentLoaded', function () { App.init(); });
