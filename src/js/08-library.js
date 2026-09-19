/* ライブラリ: 共有フォルダそのものをデータベースとして扱う (管理者レス)。
 * フォルダを走査して meta.json を持つディレクトリを装置エントリとして拾う。
 * 登録作業は不要。設計者が「格納する」か Fusion のスクリプトで置いたものが即一覧に出る。 */
var Library = (function () {
  var handle = null, entries = [], config = null, members = null, listEl, emptyEl, statusEl, searchEl, countEl, pathEl;
  var IDB_STORE = 'handles';
  var SKIP_DIRS = { step: 1, node_modules: 1, inbox: 1 };
  var INBOX = 'inbox', inbox = [];   // [{name, handle, dir, fields|null}]

  function supported() { return typeof window.showDirectoryPicker === 'function'; }

  function init() {
    listEl = $('#lib-list'); emptyEl = $('#lib-empty'); statusEl = $('#lib-status'); searchEl = $('#lib-search'); countEl = $('#lib-count'); pathEl = $('#lib-path');
    $('#btn-open-lib').addEventListener('click', open);
    $('#btn-rescan').addEventListener('click', function () { scan(); });
    $('#btn-inbox').addEventListener('click', function () { processInbox(); });
    $('#btn-rules').addEventListener('click', openRules);
    $('#rule-cancel').addEventListener('click', function () { $('#rules-dialog').close(); });
    $('#rules-dialog form').addEventListener('submit', function (e) { e.preventDefault(); saveRules(); });
    ['#rule-pattern', '#rule-sep', '#rule-try'].forEach(function (id) { $(id).addEventListener('input', updateRulePreview); });
    searchEl.addEventListener('input', debounce(renderList, 120));
    if (!supported()) { $('#btn-open-lib').disabled = true; statusEl.textContent = 'このブラウザではフォルダを開けません'; return; }
    restoreHandle().then(function (h) {
      if (!h) return;
      handle = h;
      return h.queryPermission({ mode: 'readwrite' }).then(function (p) {
        if (p === 'granted') return scan();
        statusEl.textContent = '前回: ' + h.name + '（クリックで再接続）';
      });
    }).catch(function () { });
  }

  /* ---- ハンドルの保存 (IndexedDB は file:// でも使えるが失敗しうるので握りつぶす) ---- */
  function saveHandle(h) { return IDB.put(IDB_STORE, 'library', h).catch(function () { }); }
  function restoreHandle() { return IDB.get(IDB_STORE, 'library').then(function (v) { return v || null; }).catch(function () { return null; }); }

  async function open() {
    try {
      if (handle) {
        var p = await handle.queryPermission({ mode: 'readwrite' });
        if (p !== 'granted') p = await handle.requestPermission({ mode: 'readwrite' });
        if (p === 'granted' && !(await confirmSwitch())) { await scan(); return; }
      }
      handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'library' });
      await saveHandle(handle);
      await scan();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      showMessage('ライブラリを開けませんでした', String(e && e.message || e));
    }
  }
  /* 既に接続済みなら、そのまま再読み込みするか別フォルダを選ぶか */
  function confirmSwitch() {
    return Promise.resolve(entries.length > 0 && window.confirm('別のライブラリフォルダを選びますか？\n（キャンセルで現在のフォルダを再読み込み）'));
  }

  async function readJson(dir, name) {
    try { var f = await (await dir.getFileHandle(name)).getFile(); return JSON.parse(await f.text()); } catch (e) { return null; }
  }
  async function writeFile(dir, name, data) {
    var fh = await dir.getFileHandle(name, { create: true });
    var w = await fh.createWritable(); await w.write(data); await w.close();
  }
  async function ensureDir(segments) {
    var d = handle;
    for (var i = 0; i < segments.length; i++) d = await d.getDirectoryHandle(segments[i], { create: true });
    return d;
  }
  async function hasFile(dir, name) { try { await dir.getFileHandle(name); return true; } catch (e) { return false; } }

  async function scan() {
    if (!handle) return;
    statusEl.textContent = '読み込み中…'; statusEl.className = 'status muted';
    entries = [];
    config = (await readJson(handle, 'library.json')) || null;
    var mj = await readJson(handle, 'members.json');
    members = Array.isArray(mj) ? mj : (mj && Array.isArray(mj.members) ? mj.members : null);
    var modelsDir = null;
    try { modelsDir = await handle.getDirectoryHandle('models'); } catch (e) { modelsDir = null; }
    await walk(modelsDir || handle, modelsDir ? ['models'] : [], 0);
    entries.sort(function (a, b) { return String(b.meta.savedAt || '').localeCompare(String(a.meta.savedAt || '')); });
    statusEl.textContent = handle.name + ' · ' + entries.length + ' 件'; statusEl.className = 'status ok';
    pathEl.textContent = handle.name + '/';
    $('#btn-rescan').disabled = false;
    countEl.hidden = false; countEl.textContent = String(entries.length);
    renderList();
    App.onLibraryChanged();
    writeCatalog();
    await scanInbox();
    if (config && config.inboxAuto && inbox.some(function (f) { return f.fields; })) await processInbox();
  }

  /* ---- 受信箱: inbox/ に置かれた STEP を、ファイル名のルールで決まる階層へ格納する ---- */
  async function scanInbox() {
    inbox = [];
    var dir = null;
    try { dir = await handle.getDirectoryHandle(INBOX); } catch (e) { dir = null; }
    if (dir) await collectInbox(dir, [], 0);
    renderInbox();
  }
  async function collectInbox(dir, rel, depth) {
    if (depth > 3) return;
    for await (var [name, h] of dir.entries()) {
      if (h.kind === 'directory') { if (name[0] !== '.') await collectInbox(h, rel.concat([name]), depth + 1); continue; }
      if (!/\.(step|stp)$/i.test(name)) continue;
      inbox.push({ name: name, handle: h, dir: dir, rel: rel, fields: Naming.parse(name) });
    }
  }
  function renderInbox() {
    var box = $('#inbox'), list = $('#inbox-list');
    box.hidden = inbox.length === 0;
    $('#inbox-count').textContent = String(inbox.length);
    $('#btn-inbox').disabled = !inbox.some(function (f) { return f.fields; });
    list.textContent = '';
    inbox.forEach(function (f) {
      var li = el('li' + (f.fields ? '' : '.bad'), { title: f.name });
      li.appendChild(el('span.nm', { text: f.name }));
      li.appendChild(el('span.to', { text: f.fields ? '→ ' + Store.segmentsFor(f.fields, config ? config.layout : 0).join('/') : '（ルールに合いません: ' + Naming.describe() + '）' }));
      list.appendChild(li);
    });
  }
  async function processInbox() {
    var targets = inbox.filter(function (f) { return f.fields; });
    if (!targets.length) return;
    var done = [], failed = [];
    for (var i = 0; i < targets.length; i++) {
      var f = targets[i];
      App.showOverlay('受信箱を取り込み中  ' + (i + 1) + ' / ' + targets.length, f.name);
      await nextFrames(2);
      try {
        var bytes = new Uint8Array(await (await f.handle.getFile()).arrayBuffer());
        var model = await Occt.convert(bytes, App.precision(), baseName(f.name));
        await ensureConfig(0);
        var pkg = Store.buildPackage([{ fileName: f.name, model: model, stepBytes: bytes }], f.fields, config.layout, App.precision(), { cad: 'step', app: 'library-viewer', via: 'inbox' });
        await writeFiles(pkg.segs, pkg.files);
        await Store.ensureMember(f.fields.department, f.fields.owner);
        await f.dir.removeEntry(f.name);   // 格納できたものだけ受信箱から消す
        done.push(pkg.segs.join('/'));
      } catch (e) { failed.push(f.name + ': ' + (e && e.message || e)); }
    }
    App.hideOverlay();
    showMessage('受信箱を取り込みました', (done.length ? done.length + ' 件を格納:\n' + done.map(function (d) { return '  ' + d + '/'; }).join('\n') : '格納できたものはありません') + (failed.length ? '\n\n失敗:\n' + failed.join('\n') : ''));
    await scan();
  }

  /* ---- ルール (library.json の naming / inboxAuto) ---- */
  function openRules() {
    var r = Naming.current();
    $('#rule-pattern').value = r.pattern; $('#rule-sep').value = r.separator || '_';
    $('#rule-inbox-auto').checked = !!(config && config.inboxAuto);
    $('#rule-inbox-auto').disabled = !handle;
    $('#rule-try').value = '';
    updateRulePreview();
    $('#rules-dialog').showModal();
  }
  function ruleFromForm() { return { pattern: $('#rule-pattern').value.trim(), separator: $('#rule-sep').value || '_' }; }
  function updateRulePreview() {
    var r = ruleFromForm(), err = Naming.validate(r), errEl = $('#rule-error');
    errEl.hidden = !err; errEl.textContent = err || '';
    $('#rule-save').disabled = !!err;
    $('#rule-example').textContent = err ? '' : Naming.example(r);
    var t = $('#rule-try').value.trim(), out = $('#rule-try-out');
    if (!t || err) { out.textContent = ''; return; }
    var f = Naming.parse(t, r);
    out.textContent = f ? Object.keys(f).map(function (k) { return Naming.FIELDS[k] + '=' + (f[k] || '(空)'); }).join('  ') + '  →  ' + Store.segmentsFor(f, config ? config.layout : 0).join('/') + '/' : '解析できません';
  }
  async function saveRules() {
    var r = ruleFromForm();
    if (Naming.validate(r)) return;
    Naming.saveLocal(r);
    if (handle) {
      await ensureConfig(0);
      config.naming = r; config.inboxAuto = $('#rule-inbox-auto').checked; config.updatedAt = isoNowLocal();
      try { await writeFile(handle, 'library.json', JSON.stringify(config, null, 2)); } catch (e) { showMessage('ルール', 'library.json に書き込めませんでした。この PC にだけ保存しました。'); }
      renderInbox(); inbox.forEach(function (f) { f.fields = Naming.parse(f.name); }); renderInbox();
    }
    $('#rules-dialog').close();
  }
  async function walk(dir, rel, depth) {
    if (depth > 6) return;
    var meta = await readJson(dir, 'meta.json');
    if (meta && meta.schema && String(meta.schema).indexOf('library-viewer') === 0) {
      var files = [];
      for (var i = 0; i < (meta.files || []).length; i++) {
        var f = meta.files[i];
        files.push({ name: f.name, glb: f.glb && await hasFile(dir, f.glb) ? f.glb : null, step: f.step && await hasStepFile(dir, f.step) ? f.step : null, meta: f });
      }
      entries.push({ id: rel.join('/'), rel: rel, dir: dir, meta: meta, files: files });
      return; // 装置フォルダの下は辿らない
    }
    for await (var [name, h] of dir.entries()) {
      if (h.kind !== 'directory' || SKIP_DIRS[name.toLowerCase()] || name[0] === '.') continue;
      await walk(h, rel.concat([name]), depth + 1);
    }
  }
  async function hasStepFile(dir, relPath) {
    var parts = relPath.split('/'), d = dir;
    try { for (var i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i]); await d.getFileHandle(parts[parts.length - 1]); return true; } catch (e) { return false; }
  }
  async function readFileBytes(dir, relPath) {
    var parts = relPath.split('/'), d = dir;
    for (var i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i]);
    var f = await (await d.getFileHandle(parts[parts.length - 1])).getFile();
    return new Uint8Array(await f.arrayBuffer());
  }

  /* 一覧用のキャッシュ。Fusion スクリプト等が案件コードの候補に使う。失敗しても無視 */
  async function writeCatalog() {
    try {
      var cat = { schema: 'library-viewer/catalog/1', generatedAt: isoNowLocal(), count: entries.length, entries: entries.map(function (e) {
        var m = e.meta; return { path: e.rel.join('/'), projectCode: m.projectCode, deviceName: m.deviceName, workpiece: m.workpiece, department: m.department, owner: m.owner, savedAt: m.savedAt, files: e.files.map(function (f) { return { name: f.name, glb: !!f.glb, step: !!f.step }; }) };
      }) };
      await writeFile(handle, 'catalog.json', JSON.stringify(cat, null, 2));
    } catch (e) { /* 読み取り専用など */ }
  }

  function renderList() {
    listEl.textContent = '';
    var q = searchEl.value.trim().toLowerCase();
    var list = entries.filter(function (e) {
      if (!q) return true;
      var m = e.meta; return [m.projectCode, m.deviceName, m.workpiece, m.department, m.owner, e.rel.join('/')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    emptyEl.hidden = entries.length > 0;
    if (entries.length && !list.length) listEl.appendChild(el('p.empty', { text: '一致する装置がありません' }));
    var groups = {};
    list.forEach(function (e) { var g = e.meta.department || '（部署なし）'; (groups[g] = groups[g] || []).push(e); });
    Object.keys(groups).sort().forEach(function (g) {
      var box = el('div.lib-group', {}, [el('h3', { text: g })]);
      groups[g].forEach(function (e) { box.appendChild(card(e)); });
      listEl.appendChild(box);
    });
  }
  function card(e) {
    var m = e.meta, needConv = e.files.some(function (f) { return !f.glb && f.step; });
    var acts = el('div.acts', {}, [
      el('button.btn.small.primary', { type: 'button', text: '開く', onclick: function () { openEntry(e); } }),
      el('button.btn.small.secondary', { type: 'button', text: '追加', title: '今の表示に追加して読み込む（横断比較）', onclick: function () { openEntry(e, true); } })
    ]);
    if (m.source && m.source.fusionWebURL) acts.appendChild(el('a', { href: m.source.fusionWebURL, target: '_blank', rel: 'noopener', text: 'Fusion で開く', title: 'Autodesk Fusion のデータパネルで開きます（ブラウザで外部サイトへ移動）' }));
    acts.appendChild(el('span.spacer'));
    acts.appendChild(el('button.btn.small.ghost-danger', {
      type: 'button', title: 'ライブラリから削除します（共有フォルダから消えます）',
      onclick: function () { deleteEntry(e); }
    }, [svgIcon('M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13M10 11v6M14 11v6'), '削除']));
    return el('div.lib-card', {}, [
      el('div.t', {}, [el('span', { text: m.deviceName || e.rel[e.rel.length - 1] }), el('span.code', { text: m.projectCode || '' })]),
      el('div.m', {}, [
        m.workpiece ? el('span', { text: 'ワーク: ' + m.workpiece }) : null,
        el('span', { text: m.owner || '' }),
        el('span.mono', { text: fmtDate(m.savedAt) }),
        m.source && m.source.cad === 'fusion' ? el('span.badge', { text: 'Fusion' }) : null
      ]),
      el('div.m.mono', { text: e.files.map(function (f) { return f.name; }).join(', ') }),
      needConv ? el('div.warn', { text: '未変換の STEP があります（開くと変換して glb を保存します）' }) : null,
      acts
    ]);
  }

  /* エントリを開く: glb があればそれを、なければ STEP を変換して glb を書き戻す */
  async function openEntry(e, append) {
    if (!append) App.clearDevices();
    var devices = [];
    for (var i = 0; i < e.files.length; i++) {
      var f = e.files[i];
      try {
        if (f.glb) {
          var bytes = await readFileBytes(e.dir, f.glb);
          devices.push({ model: GLB.read(bytes), fileName: f.step ? f.step.split('/').pop() : f.name + '.step', stepBytes: null, source: { kind: 'library', entry: e, file: f } });
        } else if (f.step) {
          var sb = await readFileBytes(e.dir, f.step);
          App.showOverlay('変換中', (i + 1) + ' / ' + e.files.length + '  ' + f.step.split('/').pop());
          await nextFrames(2);
          var model = await Occt.convert(sb, App.precision(), f.name);
          var dev = { model: model, fileName: f.step.split('/').pop(), stepBytes: sb, source: { kind: 'library', entry: e, file: f } };
          devices.push(dev);
          try { await writeFile(e.dir, f.name + '.glb', GLB.write(model)); f.glb = f.name + '.glb'; } catch (werr) { /* 書けなくても表示は続ける */ }
        }
      } catch (err) {
        App.hideOverlay();
        showMessage('読み込みに失敗しました', f.name + '\n' + (err && err.message || err));
      }
    }
    App.hideOverlay();
    devices.forEach(function (d) { App.addDevice(d); });
    if (devices.length) { App.showLeftTab('tree'); App.stepSource(e); Viewer3D.fitAll(); }
    if (e.files.some(function (f) { return f.glb && f.glb.indexOf('.glb') > 0; })) { renderList(); }
  }

  /* ---- 削除: 装置フォルダごと消し、空になった親フォルダも掃除する ---- */
  async function dirAt(segments) {
    var d = handle;
    for (var i = 0; i < segments.length; i++) d = await d.getDirectoryHandle(segments[i]);
    return d;
  }
  async function isEmpty(dir) {
    for await (var entry of dir.entries()) { return false; }
    return true;
  }
  async function deleteEntry(e) {
    if (!handle || !e.rel.length) { showMessage('削除できません', 'ライブラリの直下にあるため削除できません。'); return; }
    var fileList = [];
    e.files.forEach(function (f) { if (f.glb) fileList.push(f.glb); if (f.step) fileList.push(f.step); });
    fileList.push('meta.json', 'index.json');
    var m = e.meta;
    var body = [
      (m.deviceName || '') + '  ' + (m.projectCode || ''),
      '格納者: ' + (m.department || '') + ' / ' + (m.owner || '') + '   ' + fmtDate(m.savedAt),
      '',
      handle.name + '/' + e.rel.join('/') + '/',
      fileList.map(function (f) { return '  ' + f; }).join('\n'),
      '',
      'このフォルダを共有フォルダから削除します。ライブラリを見ている全員から見えなくなります。'
    ].join('\n');
    if (!await showConfirm('ライブラリから削除しますか？', body)) return;
    try {
      var parent = await dirAt(e.rel.slice(0, -1));
      await parent.removeEntry(e.rel[e.rel.length - 1], { recursive: true });
      // 空になった親を models/ の 1 つ下まで遡って削除する
      for (var d = e.rel.length - 2; d >= 1; d--) {
        var up = await dirAt(e.rel.slice(0, d));
        var dir = await up.getDirectoryHandle(e.rel[d]);
        if (!await isEmpty(dir)) break;
        await up.removeEntry(e.rel[d]);
      }
      showMessage('削除しました', e.rel.join('/') + '/');
    } catch (err) {
      showMessage('削除に失敗しました', String(err && err.message || err));
      return;
    }
    await scan();
  }

  /* Store から呼ばれる: パス配下にファイル群を書き込む */
  async function writeFiles(segments, files) {
    var dir = await ensureDir(segments);
    for (var i = 0; i < files.length; i++) {
      var parts = files[i].name.split('/'), d = dir;
      for (var k = 0; k < parts.length - 1; k++) d = await d.getDirectoryHandle(parts[k], { create: true });
      await writeFile(d, parts[parts.length - 1], files[i].data);
    }
    return dir;
  }
  async function ensureConfig(layout) {
    if (config) return config;
    config = { schema: 'library-viewer/library/1', layout: layout, naming: Naming.current(), inboxAuto: false, createdAt: isoNowLocal(), note: 'このファイルはライブラリの保存階層とネーミングルールを固定します。編集はビューアの「ルール」から。' };
    try { await writeFile(handle, 'library.json', JSON.stringify(config, null, 2)); } catch (e) { }
    return config;
  }
  async function saveMembers(list) {
    members = list;
    if (!handle) return false;
    try { await writeFile(handle, 'members.json', JSON.stringify({ schema: 'library-viewer/members/1', updatedAt: isoNowLocal(), members: list }, null, 2)); return true; } catch (e) { return false; }
  }

  return {
    init: init, supported: supported, open: open, scan: scan, writeFiles: writeFiles, ensureConfig: ensureConfig, saveMembers: saveMembers,
    connected: function () { return !!handle; }, name: function () { return handle ? handle.name : ''; }, processInbox: processInbox,
    entries: function () { return entries; }, config: function () { return config; }, members: function () { return members; }, deleteEntry: deleteEntry
  };
})();
