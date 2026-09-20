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
    Tree.init({ onSelect: function (n) { select(n); }, onHover: function (n) { Viewer3D.setHover(n); }, onClose: function (d) { removeDevice(d); } });
    CrossRef.init(); Search.init(); TreeEdit.init(); Library.init(); Store.init(); Measure.init();
    bindUI();
    // 起動直後の空き時間に WASM を展開しておく (初回変換を速くする)
    setTimeout(function () { Occt.load().catch(function (e) { showMessage('初期化エラー', e.message); }); }, 400);
  }

  function bindUI() {
    // ファイル選択 / ドラッグ&ドロップ (ウィンドウ全体)
    $('#file-input').addEventListener('change', function (e) { loadFiles(Array.prototype.slice.call(e.target.files)); e.target.value = ''; });
    $('#dir-input').addEventListener('change', function (e) { loadFromDirInput(Array.prototype.slice.call(e.target.files)); e.target.value = ''; });
    var dragDepth = 0;
    function isInternalDrag(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'application/x-lv-node') >= 0; }
    window.addEventListener('dragenter', function (e) { if (isInternalDrag(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragover', function (e) { if (isInternalDrag(e)) return; e.preventDefault(); });
    window.addEventListener('dragleave', function (e) { if (isInternalDrag(e)) return; e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('drop', function (e) {
      if (isInternalDrag(e)) return;   // ツリー内での移動はここでは扱わない
      e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
      // items は同期のうちに取り出す (ハンドラを抜けると無効になる)
      var dirs = [], entries = [], items = e.dataTransfer.items;
      for (var i = 0; items && i < items.length; i++) {
        var it = items[i];
        if (it.kind !== 'file') continue;
        if (it.getAsFileSystemHandle) dirs.push(it.getAsFileSystemHandle());
        else if (it.webkitGetAsEntry) { var en = it.webkitGetAsEntry(); if (en) entries.push(en); }
      }
      var files = Array.prototype.slice.call(e.dataTransfer.files);
      handleDrop(dirs, entries, files);
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
    $('#btn-fit-sel').addEventListener('click', function () { if (selectedNode) Viewer3D.focusNode(selectedNode); });
    // 断面
    $$('input[name="secaxis"]').forEach(function (r) { r.addEventListener('change', function () { if (r.checked) { Viewer3D.setSection(r.value, null, null); Viewer3D.updateAllStates(); updateSectionLabel(); } }); });
    $('#sec-pos').addEventListener('input', function (e) { Viewer3D.setSection(null, e.target.value / 1000, null); updateSectionLabel(); });
    $('#chk-sec-flip').addEventListener('change', function (e) { Viewer3D.setSection(null, null, e.target.checked); updateSectionLabel(); });
    // 左タブ
    $$('input[name="left-tab"]').forEach(function (r) { r.addEventListener('change', function () { if (r.checked) showLeftTab(r.value); }); });
    // キーボード
    window.addEventListener('keydown', function (e) {
      var t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.closest('dialog'))) return;
      if (e.key === '/' || ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F'))) { Search.focus(); e.preventDefault(); }
      else if (e.key === 'm' || e.key === 'M') { Measure.toggle(); e.preventDefault(); }
      else if (e.key === '[') { Panels.toggle('left'); e.preventDefault(); }
      else if (e.key === ']') { Panels.toggle('right'); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { CrossRef.step(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { CrossRef.step(1); e.preventDefault(); }
      else if (e.key === 'Escape') { if (Measure.isActive()) { if (Measure.points().length) Measure.clear(); else Measure.setActive(false); } else select(null); }
      else if (e.key === 'f' || e.key === 'F') Viewer3D.fitAll();
    });
  }
  /* フォルダの中身を集めて読み込む。dirHandles は File System Access API、
   * dirEntries は旧 webkitGetAsEntry のディレクトリ。どちらも STEP だけを拾う。 */
  async function loadFolders(dirHandles, dirEntries) {
    dirHandles = dirHandles || []; dirEntries = dirEntries || [];
    if (!dirHandles.length && !dirEntries.length) return 0;
    showOverlay('フォルダを読み込み中', 'STEP を探しています');
    await nextFrames(2);
    var out = [];
    try {
      for (var i = 0; i < dirHandles.length; i++) await collectFromHandle(dirHandles[i], [dirHandles[i].name], out);
      for (var k = 0; k < dirEntries.length; k++) await collectFromEntry(dirEntries[k], [dirEntries[k].name], out);
    } catch (e) { hideOverlay(); showMessage('フォルダを読めませんでした', String(e && e.message || e)); return 0; }
    hideOverlay();
    if (!out.length) { showMessage('STEP が見つかりません', 'このフォルダには .step / .stp がありませんでした。'); return 0; }
    return await loadEntries(out);
  }

  /* ドロップされたもの: フォルダが含まれていればその中の STEP だけを読む */
  async function handleDrop(dirPromises, legacyEntries, files) {
    var handles = [];
    try { handles = (await Promise.all(dirPromises)).filter(Boolean); } catch (e) { handles = []; }
    var dirHandles = handles.filter(function (h) { return h.kind === 'directory'; });
    var dirEntries = legacyEntries.filter(function (en) { return en.isDirectory; });
    if (dirHandles.length || dirEntries.length) { await loadFolders(dirHandles, dirEntries); return; }
    var picked = files.filter(function (f) { return /\.(step|stp|glb)$/i.test(f.name); });
    var skipped = files.length - picked.length;
    if (picked.length) { await loadFiles(picked); if (skipped) reportSkipped(picked.length, skipped); }
    else if (skipped) showMessage('読み込めるファイルがありません', '.step / .stp / .glb だけを読み込みます。');
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

  /* ---- フォルダ読み込み: STEP だけを拾い、フォルダ構成をそのまま groupPath にする ---- */
  var MAX_FOLDER_FILES = 300;
  function isStepName(name) { return /\.(step|stp)$/i.test(name); }

  /* File System Access API のハンドルから集める (フォルダのドロップ) */
  async function collectFromHandle(h, rel, out) {
    if (out.length >= MAX_FOLDER_FILES) return;
    if (h.kind === 'file') {
      if (isStepName(h.name)) out.push({ file: await h.getFile(), rel: rel, name: h.name });
      return;
    }
    for await (var entry of h.entries()) {
      var name = entry[0], child = entry[1];
      if (name[0] === '.') continue;   // 隠しフォルダは見ない
      await collectFromHandle(child, child.kind === 'directory' ? rel.concat([name]) : rel, out);
      if (out.length >= MAX_FOLDER_FILES) return;
    }
  }
  /* 旧 API (webkitGetAsEntry) から集める */
  async function collectFromEntry(en, rel, out) {
    if (out.length >= MAX_FOLDER_FILES) return;
    if (en.isFile) {
      if (!isStepName(en.name)) return;
      var f = await new Promise(function (res, rej) { en.file(res, rej); });
      out.push({ file: f, rel: rel, name: en.name });
      return;
    }
    var reader = en.createReader(), batch;
    do {
      batch = await new Promise(function (res, rej) { reader.readEntries(res, rej); });
      for (var i = 0; i < batch.length; i++) {
        var c = batch[i];
        if (c.name[0] === '.') continue;
        await collectFromEntry(c, c.isDirectory ? rel.concat([c.name]) : rel, out);
        if (out.length >= MAX_FOLDER_FILES) return;
      }
    } while (batch.length);
  }

  function sortEntries(list) {
    list.sort(function (a, b) {
      var pa = a.rel.join('/'), pb = b.rel.join('/');
      if (pa !== pb) return pa.localeCompare(pb, 'ja', { numeric: true });
      return a.name.localeCompare(b.name, 'ja', { numeric: true });
    });
    return list;
  }

  /* 変換して装置として並べる。entries = [{file, rel, name}]
   * ワーカープールが並列にさばくので、まとめて投げて終わった順に数える。
   * 一度変換したファイルはキャッシュから戻すので、2 回目以降は一瞬で開く。 */
  async function loadEntries(entries) {
    sortEntries(entries);
    var total = entries.length, preset = currentPrecision, failed = [];

    // 1) まずキャッシュを当たる。全部当たればオーバーレイも待ちフレームも要らない
    var hits = await Promise.all(entries.map(function (e) {
      return ConvCache.get(e.file, preset).catch(function () { return null; });
    }));
    var misses = [], cachedCount = 0, shown = 0;
    var cached = [];
    for (var i = 0; i < total; i++) {
      if (hits[i]) { cached.push({ e: entries[i], model: hits[i] }); cachedCount++; }
      else misses.push(entries[i]);
    }
    if (cached.length) {
      var built = [];
      for (var k = 0; k < cached.length; k++) built.push(await toDevice(cached[k].e, cached[k].model));
      addDevices(built); shown += built.length;
      Viewer3D.fitAll();
    }

    // 2) 残りを変換する。できた端から画面に出す (全部終わるまで真っ白にしない)
    if (misses.length) {
      var done = 0, pending = [], timer = null;
      function flush() {
        timer = null;
        if (!pending.length) return;
        addDevices(pending.splice(0));
        Viewer3D.fitAll();
      }
      showOverlay('変換中  0 / ' + misses.length,
        misses.length > 1 ? '並列 ' + Math.min(Occt.maxWorkers, misses.length) + ' 本で処理します' : misses[0].rel.concat([misses[0].name]).join(' / '));
      await Occt.load().catch(function () { });
      await nextFrames(2);   // メインスレッドを止める前にオーバーレイを描画させる
      await Promise.all(misses.map(async function (e) {
        var label = e.rel.concat([e.name]).join(' / ');
        try {
          var bytes = new Uint8Array(await e.file.arrayBuffer());
          var model = await Occt.convert(bytes, preset, baseName(e.name));
          ConvCache.put(e.file, preset, model);          // 書き込みは待たない
          pending.push(await toDevice(e, model, bytes));
          if (!timer) timer = setTimeout(flush, 250);     // 連続で来ても描き直しは間引く
        } catch (err) {
          failed.push(label + ': ' + (err && err.message || err));
        }
        done++;
        $('#overlay-title').textContent = '変換中  ' + done + ' / ' + misses.length;
        $('#overlay-msg').textContent = label;
      }));
      if (timer) clearTimeout(timer);
      shown += pending.length;
      flush();
      hideOverlay();
    }

    if (failed.length) showMessage('変換できなかったファイルがあります', failed.join('\n'));
    if (cachedCount) reportCache(cachedCount, total);
    return total - failed.length;
  }
  /* 格納や再変換のために STEP の原本は持っておく */
  async function toDevice(e, model, bytes) {
    return { model: model, fileName: e.name, stepBytes: bytes || new Uint8Array(await e.file.arrayBuffer()),
             source: { kind: 'folder' }, groupPath: e.rel };
  }
  function reportCache(cached, total) {
    var el2 = $('#load-note');
    el2.hidden = false; el2.textContent = '';
    el2.appendChild(document.createTextNode(cached + ' / ' + total + ' 件は前回の変換結果を再利用しました（同じファイル・同じ精度のとき）'));
    el2.appendChild(document.createTextNode(' '));
    el2.appendChild(el('button.btn.link.small', {
      type: 'button', text: 'キャッシュを消す',
      onclick: async function () {
        var st = await ConvCache.stats();
        if (!await showConfirm('変換キャッシュを消しますか？', '保存済み ' + st.count + ' 件 (' + fmtBytes(st.bytes) + ') を消します。\n次に同じファイルを開くときは変換からやり直します。', '消す')) return;
        var n = await ConvCache.clear();
        el2.hidden = true;
        showMessage('変換キャッシュ', n + ' 件を消しました。');
      }
    }));
    clearTimeout(reportCache.t);
    reportCache.t = setTimeout(function () { el2.hidden = true; }, 12000);
  }

  /* <input webkitdirectory> から: webkitRelativePath が "ルート/下層/部品.step" になる */
  async function loadFromDirInput(files) {
    var steps = files.filter(function (f) { return isStepName(f.name); });
    var skipped = files.length - steps.length;
    if (!steps.length) {
      showMessage('STEP が見つかりません', 'このフォルダには .step / .stp がありませんでした' + (skipped ? '（' + skipped + ' 件のファイルは STEP ではないので読み込んでいません）' : '') + '。');
      return;
    }
    var over = steps.length > MAX_FOLDER_FILES;
    if (over) steps = steps.slice(0, MAX_FOLDER_FILES);
    var entries = steps.map(function (f) {
      var parts = (f.webkitRelativePath || f.name).split('/');
      return { file: f, name: parts[parts.length - 1], rel: parts.slice(0, -1) };
    });
    var n = await loadEntries(entries);
    if (over) showMessage('一部だけ読み込みました', 'STEP が多いため先頭 ' + MAX_FOLDER_FILES + ' 件だけ読み込みました。');
    else if (skipped) reportSkipped(n, skipped);
  }
  function reportSkipped(loaded, skipped) {
    var el2 = $('#load-note');
    el2.hidden = false;
    el2.textContent = 'STEP ' + loaded + ' 件を読み込みました（STEP 以外の ' + skipped + ' 件は読み込んでいません）';
    clearTimeout(reportSkipped.t);
    reportSkipped.t = setTimeout(function () { el2.hidden = true; }, 6000);
  }

  /* ---- ファイル読み込み ---- */
  async function loadFiles(files) {
    var stepFiles = files.filter(function (f) { return /\.(step|stp)$/i.test(f.name); });
    var glbFiles = files.filter(function (f) { return /\.glb$/i.test(f.name); });
    var glbDevices = [];
    for (var g = 0; g < glbFiles.length; g++) {
      try { var gb = new Uint8Array(await glbFiles[g].arrayBuffer()); glbDevices.push({ model: GLB.read(gb), fileName: glbFiles[g].name, stepBytes: null, source: { kind: 'file' } }); }
      catch (e) { showMessage('読み込みに失敗しました', glbFiles[g].name + '\n' + e.message); }
    }
    if (glbDevices.length) addDevices(glbDevices);
    if (stepFiles.length) await loadEntries(stepFiles.map(function (f) { return { file: f, name: f.name, rel: [] }; }));
    if (devices.length && glbDevices.length && !stepFiles.length) Viewer3D.fitAll();
  }

  /* まとめて追加する。1 件ずつ addDevice すると、ツリーと横断の作り直しが件数分走って遅い */
  function addDevices(list) {
    if (!list || !list.length) return [];
    var out = list.map(function (d) { return prepareDevice(d); });
    out.forEach(function (d) { devices.push(d); Viewer3D.addDevice(d); });
    Tree.registerDeviceFolders();   // 先にフォルダを登録してから描く (描き直すと横断バッジが消える)
    Tree.render(devices);
    CrossRef.rebuild(devices);
    afterDevicesChanged();
    return out;
  }
  function prepareDevice(d) {
    d.id = 'd' + (++seq); d.precision = currentPrecision;
    // 行の名前はファイル名。ユーザーが見て分かるのはこちらで、STEP 内部名はツールチップに出す
    d.name = baseName(d.fileName) || d.model.name || '(名称なし)';
    d.naming = Naming.parse(d.fileName);   // ファイル名がルールに合えば案件情報を持たせる
    d.groupPath = d.groupPath || [];       // 元フォルダの相対パス (ツリーの階層になる)
    // 同名の装置が既にあればファイル名で区別
    if (devices.some(function (x) { return x.name === d.name; })) d.name = d.name + ' (' + d.fileName + ')';
    Tree.buildDevice(d);
    return d;
  }
  function addDevice(d) { return addDevices([d])[0]; }
  function removeDevice(d) {
    var list = Array.isArray(d) ? d.slice() : [d];
    Measure.clear();   // 消える形状を指したままの計測が残らないように
    var clearSel = false;
    list.forEach(function (x) {
      var i = devices.indexOf(x); if (i < 0) return;
      Viewer3D.removeDevice(x); Tree.removeDevice(x);
      devices.splice(i, 1);
      if (selectedNode && selectedNode.device === x) clearSel = true;
    });
    if (clearSel) select(null);
    Tree.render(devices); CrossRef.rebuild(devices); afterDevicesChanged();
  }
  function clearDevices() { devices.slice().forEach(removeDevice); }
  function afterDevicesChanged() {
    var has = devices.length > 0;
    $('#drop-hint').hidden = has; $('#btn-store').disabled = !has;
    $('#btn-remesh').disabled = !devices.some(function (d) { return d.stepBytes; });
    if (selectedNode && !Search.query()) CrossRef.show(selectedNode);
    Search.refresh();   // 消えたノードを指したままの結果を残さない
  }

  /* 精度変更 → 保持している STEP バッファから再メッシュ */
  async function remeshAll() {
    var targets = devices.filter(function (d) { return d.stepBytes; });
    if (!targets.length) return;
    var selPath = selectedNode ? selectedNode.path.join('/') : null;
    Measure.clear();   // 再メッシュで頂点が変わるため
    var done = 0, preset = currentPrecision;
    showOverlay('再変換中  0 / ' + targets.length, Occt.PRESETS[preset].label);
    await Occt.load().catch(function () { });
    await nextFrames(2);
    var models = await Promise.all(targets.map(async function (d) {
      try {
        var m = await Occt.convert(d.stepBytes, preset, baseName(d.fileName));
        done++; $('#overlay-title').textContent = '再変換中  ' + done + ' / ' + targets.length;
        return m;
      } catch (e) { showMessage('再変換に失敗しました', d.fileName + '\n' + e.message); return null; }
    }));
    targets.forEach(function (d, i) {
      if (!models[i]) return;
      var hidden = {}; d.leaves.forEach(function (l) { if (!l.visible) hidden[l.path.join('/')] = 1; });
      Viewer3D.removeDevice(d); Tree.removeDevice(d);
      d.model = models[i]; d.precision = preset;
      Tree.buildDevice(d);
      d.leaves.forEach(function (l) { if (hidden[l.path.join('/')]) l.visible = false; });
      Viewer3D.addDevice(d);
    });
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
    addDevices: addDevices, loadEntries: loadEntries,
    showOverlay: showOverlay, hideOverlay: hideOverlay, showLeftTab: showLeftTab,
    onLibraryChanged: function () { }, stepSource: function (e) { lastLibraryEntry = e; }, loadFolders: loadFolders
  };
})();
document.addEventListener('DOMContentLoaded', function () { App.init(); });
