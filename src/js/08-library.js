/* ライブラリ: 共有フォルダそのものをデータベースとして扱う (管理者レス)。
 * フォルダを走査して meta.json を持つディレクトリを装置エントリとして拾う。
 * 登録作業は不要。設計者が「格納する」か Fusion のスクリプトで置いたものが即一覧に出る。 */
var Library = (function () {
  var handle = null, entries = [], config = null, members = null, listEl, emptyEl, statusEl, searchEl, countEl, pathEl;
  var IDB_STORE = 'handles', AUTO_KEY = 'lv.libraryAuto';
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
    $('#rule-reset').addEventListener('click', function () { $('#rule-pattern').value = Naming.DEFAULT.pattern; $('#rule-sep').value = Naming.DEFAULT.separator; updateRulePreview(); });
    // 項目のボタン: 押すとパターンの末尾に足す / すでにあれば外す (必須の 2 つは外せない)
    Object.keys(Naming.FIELDS).forEach(function (k) {
      var b = el('button.tag.rule-field', { type: 'button', dataset: { field: k }, text: Naming.FIELDS[k], title: '{' + k + '}' });
      b.addEventListener('click', function () { toggleRuleField(k); });
      $('#rule-fields').appendChild(b);
    });
    searchEl.addEventListener('input', debounce(renderList, 120));
    $('#lh-connect').addEventListener('click', reconnect);
    $('#lh-change').addEventListener('click', function () { pick(); });
    $('#lh-forget').addEventListener('click', forget);
    $('#lh-auto').addEventListener('change', function (e) { Storage.set(AUTO_KEY, e.target.checked); renderHome(); });
    $('#lh-auto').checked = autoOpen();
    // Fusion で格納してブラウザに戻ってきたときに、「再読み込み」を押さなくても一覧に出るように。
    // フォルダの変更通知は File System Access API に無いので、窓が前に来たときに読み直す (2 秒に 1 回まで)
    var lastScan = 0;
    function rescanOnReturn() {
      if (!handle || !entries.length || document.hidden) return;
      if (Date.now() - lastScan < 2000) return;
      scan();
    }
    window.addEventListener('focus', rescanOnReturn);
    document.addEventListener('visibilitychange', rescanOnReturn);
    App.onLibraryScanned = function () { lastScan = Date.now(); };
    if (!supported()) { $('#btn-open-lib').disabled = true; statusEl.textContent = 'このブラウザではフォルダを開けません'; return; }
    restoreHandle().then(async function (h) {
      if (!h) { renderHome(); return; }
      handle = h;
      var p = 'prompt';
      try { p = await h.queryPermission({ mode: 'readwrite' }); } catch (e) { p = 'prompt'; }
      // 「毎回このサイトで許可」を選んでいれば granted のまま残るので、その場で読み込める
      if (p === 'granted' && autoOpen()) { await scan(); App.showLeftTab('lib'); return; }
      renderHome(p);
      // 再接続が要るときも案内が見えるようにタブを開く (隠れていると気づけない)
      if (autoOpen()) App.showLeftTab('lib');
    }).catch(function () { renderHome(); });
  }

  function autoOpen() { return Storage.get(AUTO_KEY, true) !== false; }

  /* 既定のライブラリの案内。権限が切れているときは「接続する」の 1 クリックで戻す */
  function renderHome(permission) {
    var box = $('#lib-home'), btn = $('#lh-connect');
    if (!handle) { box.hidden = true; return; }
    box.hidden = false;
    $('#lh-name').textContent = handle.name;
    var connected = entries.length > 0 || permission === 'granted';
    box.classList.toggle('needs-connect', !connected);
    btn.hidden = connected;
    $('#lh-note').textContent = connected
      ? (autoOpen() ? 'このフォルダを開いたときに自動で読み込みます。' : '自動で読み込まない設定です。「再読み込み」で読み込みます。')
      : 'ブラウザの決まりで、開き直したときは 1 回だけ許可が必要です。許可の画面で「毎回このサイトで許可」を選ぶと、次からは自動で読み込みます。';
  }

  /* 覚えているフォルダへ、フォルダ選択を出さずに接続し直す */
  async function reconnect() {
    if (!handle) return pick();
    try {
      var p = await handle.queryPermission({ mode: 'readwrite' });
      if (p !== 'granted') p = await handle.requestPermission({ mode: 'readwrite' });
      if (p !== 'granted') { renderHome(p); showMessage('接続できませんでした', 'フォルダへのアクセスが許可されませんでした。'); return; }
      await scan();
      App.showLeftTab('lib');
    } catch (e) {
      showMessage('接続できませんでした', String(e && e.message || e));
    }
  }
  /* フォルダを選び直す */
  async function pick() {
    try {
      handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'library' });
      await saveHandle(handle);
      await scan();
      App.showLeftTab('lib');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      showMessage('ライブラリを開けませんでした', String(e && e.message || e));
    }
  }
  /* 既定のライブラリを忘れる (別の共有フォルダに移るとき) */
  async function forget() {
    if (!handle) return;
    if (!await showConfirm('既定のライブラリを解除しますか？', '「' + handle.name + '」を覚えるのをやめます。\n共有フォルダのファイルは消えません。', '解除する')) return;
    handle = null; entries = []; inbox = []; config = null;
    await IDB.del(IDB_STORE, 'library').catch(function () { });
    statusEl.textContent = ''; pathEl.textContent = '';
    $('#btn-rescan').disabled = true; countEl.hidden = true;
    renderList(); renderInbox(); renderHome();
  }

  /* ---- ハンドルの保存 (IndexedDB は file:// でも使えるが失敗しうるので握りつぶす) ---- */
  function saveHandle(h) { return IDB.put(IDB_STORE, 'library', h).catch(function () { }); }
  function restoreHandle() { return IDB.get(IDB_STORE, 'library').then(function (v) { return v || null; }).catch(function () { return null; }); }

  /* ヘッダーの「ライブラリを開く」。覚えているフォルダがあればそれに接続し、無ければ選ばせる */
  async function open() {
    if (handle && !entries.length) return reconnect();
    if (!handle) return pick();
    return pick();
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

  /* 走査は 1 本だけ走らせる (自動読み込みと「開く」が重なると entries に二重に積まれる) */
  var scanning = null;
  function scan() {
    if (scanning) return scanning;
    scanning = doScan().finally(function () { scanning = null; });
    return scanning;
  }
  async function doScan() {
    if (!handle) return;
    statusEl.textContent = '読み込み中…'; statusEl.className = 'status muted';
    config = (await readJson(handle, 'library.json')) || null;
    var mj = await readJson(handle, 'members.json');
    members = Array.isArray(mj) ? mj : (mj && Array.isArray(mj.members) ? mj.members : null);
    var modelsDir = null;
    try { modelsDir = await handle.getDirectoryHandle('models'); } catch (e) { modelsDir = null; }
    await loadCatCache();
    // 1 回目は走査を待たない。前回の走査結果 (catalog.json) を 1 本読んで一覧を先に出し、
    // 裏で走査して違っていたら差し替える (往復 3 回 vs 装置数 × 3 回)
    var quick = !entries.length && await quickList();
    scanStats = { read: 0, reused: 0 };
    var seen = {}, found = [], t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    await walk(modelsDir || handle, modelsDir ? ['models'] : [], 0, seen, found);
    await saveCatCache(seen);
    scanStats.ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    if (App.onLibraryScanned) App.onLibraryScanned();
    found.sort(function (a, b) { return String(b.meta.savedAt || '').localeCompare(String(a.meta.savedAt || '')); });
    var changed = signature(found) !== signature(entries);
    entries = found;
    statusEl.textContent = handle.name + ' · ' + entries.length + ' 件'; statusEl.className = 'status ok';
    statusEl.title = '読み直し ' + scanStats.read + ' 件 / 前回のまま ' + scanStats.reused + ' 件 (' + scanStats.ms + ' ms)' + (quick ? ' / catalog.json で先出し' : '');
    pathEl.textContent = handle.name + '/';
    $('#btn-rescan').disabled = false;
    countEl.hidden = false; countEl.textContent = String(entries.length);
    renderHome('granted');
    if (changed || !quick) { renderList(); App.onLibraryChanged(); }   // 先出しと同じなら描き直さない
    writeCatalog();
    await scanInbox();
    if (config && config.inboxAuto && inbox.some(function (f) { return f.fields; })) await processInbox();
  }
  /* 一覧の中身を 1 本の文字列に。先出しした一覧と走査結果が同じかを見る */
  function signature(list) {
    return list.map(function (e) {
      return e.id + '|' + (e.meta.savedAt || '') + '|' + e.files.map(function (f) { return f.name + ':' + (f.glb || '') + ':' + (f.step || ''); }).join(',');
    }).join('\n');
  }
  /* catalog.json (前回の走査結果) から一覧を組む。フォルダのハンドルは開くときに引く (dir: null)。
   * 無い・古い形式なら何もしない (走査を待つ)。 */
  async function quickList() {
    var cat = await readJson(handle, 'catalog.json');
    if (!cat || cat.schema !== CATALOG_SCHEMA || !Array.isArray(cat.entries)) return false;
    var list = [];
    cat.entries.forEach(function (c) {
      if (!c || !c.path || !c.meta) return;
      var has = {};
      (c.files || []).forEach(function (f) { has[f.name] = f; });
      list.push({ id: c.path, rel: c.path.split('/'), dir: null, meta: c.meta, files: (c.meta.files || []).map(function (f) {
        var h = has[f.name] || {};
        return { name: f.name, glb: h.glb || null, step: h.step || null, placement: f.placement || null, meta: f };
      }) });
    });
    if (!list.length) return false;
    entries = list;
    statusEl.textContent = handle.name + ' · ' + entries.length + ' 件 · 確認中…';
    pathEl.textContent = handle.name + '/';
    countEl.hidden = false; countEl.textContent = String(entries.length);
    renderList();
    App.onLibraryChanged();
    return true;
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
        await ensureConfig();
        var pkg = await Store.buildPackage([{ fileName: f.name, model: model, stepBytes: bytes }], f.fields, App.precision(), { cad: 'step', app: 'library-viewer', via: 'inbox' });
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
  var RULE_REQUIRED = { projectCode: 1, deviceName: 1 };
  /* 項目のボタン: 外した項目をもう一度入れるとき、末尾ではなく **決まった位置** に戻す
   * (既定パターンの並び順。末尾に足すと外して戻すたびに順番が変わり、ファイル名の形が崩れる)。
   * 手で並べ替えた項目はそのまま、戻す項目だけを「並び順で後ろになる最初の項目」の前に入れる */
  var RULE_ORDER = Naming.fieldsOf(Naming.DEFAULT);
  function toggleRuleField(k) {
    var r = ruleFromForm(), sep = r.separator, fields = Naming.fieldsOf(r) || [];
    if (fields.indexOf(k) >= 0) { if (RULE_REQUIRED[k]) return; fields = fields.filter(function (f) { return f !== k; }); }
    else {
      var rank = RULE_ORDER.indexOf(k), at = fields.length;
      for (var i = 0; i < fields.length; i++) { if (RULE_ORDER.indexOf(fields[i]) > rank) { at = i; break; } }
      fields.splice(at, 0, k);
    }
    $('#rule-pattern').value = fields.map(function (f) { return '{' + f + '}'; }).join(sep);
    updateRulePreview();
    $('#rule-pattern').focus();
  }
  function renderRuleFields(r) {
    var used = Naming.fieldsOf(r) || [];
    $$('#rule-fields .rule-field').forEach(function (b) {
      var k = b.dataset.field, on = used.indexOf(k) >= 0;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = '{' + k + '}' + (on ? (RULE_REQUIRED[k] ? '（必須）' : '  押すと外す') : '  押すと末尾に足す');
    });
  }
  function updateRulePreview() {
    var r = ruleFromForm(), err = Naming.validate(r), errEl = $('#rule-error');
    errEl.hidden = !err; errEl.textContent = err || '';
    renderRuleFields(r);
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
      await ensureConfig();
      config.naming = r; config.inboxAuto = $('#rule-inbox-auto').checked; config.updatedAt = isoNowLocal();
      try { await writeFile(handle, 'library.json', JSON.stringify(config, null, 2)); } catch (e) { showMessage('ルール', 'library.json に書き込めませんでした。この PC にだけ保存しました。'); }
      renderInbox(); inbox.forEach(function (f) { f.fields = Naming.parse(f.name); }); renderInbox();
    }
    $('#rules-dialog').close();
  }
  /* 一覧の差分スキャン用の控え。鍵は装置フォルダのパス、値は {size, mtime, meta}。
   * meta.json の中身を読む (= DirectCloud では実体を取りに行く) のが一番高い処理なので、
   * 更新日時とサイズが前と同じなら読まずに控えを使う。存在確認 (getFileHandle) は毎回やる
   * ので、誰かが glb を足したことは次のスキャンで分かる。 */
  var catCache = {}, catDirty = false;
  async function loadCatCache() {
    catCache = {}; catDirty = false;
    try {
      (await IDB.entries('cat')).forEach(function (r) { catCache[r.key] = r.value; });
    } catch (e) { /* file:// で使えないことがある */ }
  }
  async function saveCatCache(seen) {
    if (!catDirty) return;
    try {
      var puts = [], dels = [];
      Object.keys(catCache).forEach(function (k) {
        var base = k.indexOf('names:') === 0 ? k.slice(6) : k;   // 部品名の控えは装置と運命を共にする
        if (seen[base]) puts.push({ key: k, value: catCache[k] });
        else { dels.push(k); delete catCache[k]; }   // 消えた装置は控えも捨てる
      });
      await IDB.batch('cat', puts, dels);            // 1 本のトランザクションで書く
    } catch (e) { }
  }
  async function readMeta(fh, key) {
    var f;
    try { f = await fh.getFile(); } catch (e) { return null; }
    var c = catCache[key];
    if (c && c.size === f.size && c.mtime === (f.lastModified || 0)) { scanStats.reused++; return c.meta; }
    var meta = null;
    try { meta = JSON.parse(await f.text()); } catch (e) { return null; }
    catCache[key] = { size: f.size, mtime: f.lastModified || 0, meta: meta };
    catDirty = true; scanStats.read++;
    return meta;
  }
  var scanStats = { read: 0, reused: 0 };

  /* 走査の往復は「フォルダの一覧 1 回 + meta.json の日時 1 回」だけにする。
   * meta.json も glb も、その場の一覧 (entries) に載っているかで判断し、getFileHandle で
   * 探しに行かない (空振りが階層の数だけ積み上がる)。これで往復は ディレクトリ数 + 装置数 =
   * フォルダを全部確かめる方式の下限。さらにフォルダは PAR 本ずつ同時に降りる。
   * 実測 (1000 装置・往復 2ms): 直列 14.2 秒 → 0.32 秒 / 手元の同期済みフォルダで 1.1 秒 → 0.35 秒 */
  var PAR = 8;
  async function pool(items, n, fn) {
    var i = 0;
    async function run() { while (i < items.length) { var k = i++; await fn(items[k]); } }
    var runners = [];
    for (var r = 0; r < Math.min(n, items.length); r++) runners.push(run());
    await Promise.all(runners);
  }
  async function walk(dir, rel, depth, seen, found) {
    if (depth > 6) return;
    var files = {}, dirs = {}, kids = [];
    for await (var [name, h] of dir.entries()) {
      if (h.kind === 'file') { files[name] = h; continue; }
      dirs[name] = h;
      if (!SKIP_DIRS[name.toLowerCase()] && name[0] !== '.') kids.push([name, h]);
    }
    var key = rel.join('/');
    var meta = files['meta.json'] ? await readMeta(files['meta.json'], key) : null;
    if (meta && meta.schema && String(meta.schema).indexOf('library-viewer') === 0) {
      seen[key] = 1;
      var list = [];
      for (var i = 0; i < (meta.files || []).length; i++) {
        var f = meta.files[i];
        list.push({ name: f.name, glb: f.glb && files[f.glb] ? f.glb : null, step: f.step && await hasStepFile(f.step, files, dirs) ? f.step : null, placement: f.placement || null, meta: f });
      }
      found.push({ id: key, rel: rel, dir: dir, meta: meta, files: list });
      return; // 装置フォルダの下は辿らない
    }
    await pool(kids, PAR, function (kv) {
      return walk(kv[1], rel.concat([kv[0]]), depth + 1, seen, found).catch(function () { /* 読めないフォルダは飛ばす */ });
    });
  }
  /* STEP は step/ の下にある。まだ STEP が残っている装置でだけ 1 往復する */
  async function hasStepFile(relPath, files, dirs) {
    var parts = relPath.split('/');
    if (parts.length === 1) return !!files[relPath];
    var d = dirs[parts[0]];
    if (!d) return false;
    try { for (var i = 1; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i]); await d.getFileHandle(parts[parts.length - 1]); return true; } catch (e) { return false; }
  }
  async function readFileBytes(dir, relPath) {
    return new Uint8Array(await (await fileOf(dir, relPath)).arrayBuffer());
  }
  async function fileOf(dir, relPath) {
    var parts = relPath.split('/'), d = dir;
    for (var i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i]);
    return (await d.getFileHandle(parts[parts.length - 1])).getFile();
  }
  /* 共有フォルダの glb を読む。`.gz` なら展開する。
   * 一度読んだものは変換キャッシュに置いて、2 回目は共有フォルダを読みに行かない
   * (DirectCloud ではここで実体の取得が走るため、効きが大きい)。 */
  async function readModel(dir, relPath) {
    var file = await fileOf(dir, relPath);
    var cached = await ConvCache.get(file, 'lib');
    if (cached) return cached;
    var bytes = new Uint8Array(await file.arrayBuffer());
    if (isGz(relPath)) bytes = await gunzipBytes(bytes);
    var model = GLB.read(bytes);
    ConvCache.put(file, 'lib', model);        // 書き込みは待たない
    return model;
  }

  /* 一覧のキャッシュ。次に開いたとき走査を待たずに一覧を出すのに使う (quickList)。
   * Fusion スクリプトも案件コードの候補に読む。ビューアが毎回書き直すので人は触らない。失敗しても無視 */
  var CATALOG_SCHEMA = 'library-viewer/catalog/2';
  async function writeCatalog() {
    try {
      var cat = { schema: CATALOG_SCHEMA, generatedAt: isoNowLocal(), count: entries.length, entries: entries.map(function (e) {
        var m = e.meta;
        return { path: e.rel.join('/'), projectCode: m.projectCode, deviceName: m.deviceName, workpiece: m.workpiece, customer: m.customer || '', department: m.department, owner: m.owner, savedAt: m.savedAt,
          files: e.files.map(function (f) { return { name: f.name, glb: f.glb || null, step: f.step || null }; }), meta: m };
      }) };
      await writeFile(handle, 'catalog.json', JSON.stringify(cat, null, 2));
    } catch (e) { /* 読み取り専用など */ }
  }

  /* 保存先パスと案件情報をつないだ 1 本の文字列。検索はこれに当てる
   * (部署・担当者・案件コード・装置名・対象ワークが全部入っている) */
  function haystack(e) {
    var m = e.meta || {};
    return Tags.fold([m.projectCode, m.deviceName, m.workpiece, m.customer, m.department, m.owner, e.rel.join('/')].join(' '));
  }
  function matches(e, folded) { return !folded || haystack(e).indexOf(folded) >= 0 || !!matchedPart(e, folded) || !!matchedTag(e, folded); }
  /* 読み込んでいない装置も、以前読み込んだときに付けたタグで当たる。
   * タグは行の鍵 '@<保存先>/<階層>' でブラウザに残っている (閉じても消さない) */
  function tagPrefix(e) { return '@' + e.rel.join('/') + '/'; }
  function matchedTag(e, folded) { return Tags.hitUnder(tagPrefix(e), folded); }
  function tagsOf(e) { return Tags.under(tagPrefix(e)); }
  /* 読み込んでいない装置でも部品名で当たるように、index.json (格納時に書かれる階層一覧) の名前を
   * 検索のときだけまとめて読む。読んだ結果は IndexedDB の控え ('names:' + 装置) に置き、
   * index.json の更新日時とサイズが同じなら次回は読まない。無い装置は '' (案件情報だけで当てる) */
  function matchedPart(e, folded) {
    if (!folded || !e.partList) return null;
    for (var i = 0; i < e.partList.length; i++) if (Tags.fold(e.partList[i]).indexOf(folded) >= 0) return e.partList[i];
    return null;
  }
  function needsNames() { return entries.some(function (e) { return e.partList === undefined; }); }
  var namesLoading = null;
  function loadNames() {
    if (namesLoading) return namesLoading;
    var todo = entries.filter(function (e) { return e.partList === undefined; });
    namesLoading = pool(todo, PAR, async function (e) {
      e.partList = null;                                   // 読み中 / 読めなかった
      try {
        if (!e.dir) e.dir = await dirAt(e.rel);
        var fh; try { fh = await e.dir.getFileHandle('index.json'); } catch (err) { e.partList = []; return; }
        var f = await fh.getFile(), key = 'names:' + e.id, c = catCache[key];
        if (c && c.size === f.size && c.mtime === (f.lastModified || 0)) { e.partList = c.names; return; }
        var idx = JSON.parse(await f.text()), seen = {}, names = [];
        (idx.devices || []).forEach(function (d) {
          (d.tree || []).forEach(function (r) { var n = String(r.name || '').trim(); if (n && !seen[n]) { seen[n] = 1; names.push(n); } });
        });
        e.partList = names;
        catCache[key] = { size: f.size, mtime: f.lastModified || 0, names: names };
        try { await IDB.put('cat', key, catCache[key]); } catch (err) { }
      } catch (err) { e.partList = []; }
    }).then(function () { namesLoading = null; });
    return namesLoading;
  }

  function renderList() {
    listEl.textContent = '';
    var q = Tags.fold(searchEl.value.trim());
    if (q && needsNames()) loadNames().then(function () { if (Tags.fold(searchEl.value.trim()) === q) renderList(); });
    var list = entries.filter(function (e) { return matches(e, q); });
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
  /* 以前読み込んだときに付けたタグ (閉じてもブラウザに残る)。押すとそのタグで絞り込む */
  function tagChips(tags) {
    if (!tags.length) return null;
    var shown = tags.slice(0, 3);
    return el('div.m.tags', {}, shown.map(function (t) {
      return el('button.tag', { type: 'button', text: t, title: 'タグ「' + t + '」で絞り込む', onclick: function () { searchEl.value = t; renderList(); } });
    }).concat(tags.length > 3 ? [el('span.tag.more', { text: '+' + (tags.length - 3), title: tags.slice(3).join(', ') })] : []));
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
        m.customer ? el('span', { text: '取引先: ' + m.customer }) : null,
        m.workpiece ? el('span', { text: 'ワーク: ' + m.workpiece }) : null,
        el('span', { text: m.owner || '' }),
        el('span.mono', { text: fmtDate(m.savedAt) }),
        m.source && m.source.cad === 'fusion' ? el('span.badge', { text: 'Fusion' }) : null
      ]),
      tagChips(tagsOf(e)),
      el('div.m.mono', { text: e.files.map(function (f) { return f.name; }).join(', ') }),
      needConv ? el('div.warn', { text: '未変換の STEP があります（開くと変換して glb を保存します）' }) : null,
      acts
    ]);
  }

  /* エントリを開く: glb があればそれを、なければ STEP を変換して glb を書き戻す */
  async function openEntry(e, append) {
    if (!e.dir) {   // catalog.json から先出しした一覧のエントリ
      try { e.dir = await dirAt(e.rel); }
      catch (err) { showMessage('読み込みに失敗しました', e.rel.join('/') + '\nフォルダが見つかりません。一覧を読み直します。'); scan(); return; }
    }
    if (!append) App.clearDevices();
    var devices = [];
    for (var i = 0; i < e.files.length; i++) {
      var f = e.files[i];
      try {
        if (f.glb) {
          devices.push({ model: await readModel(e.dir, f.glb), fileName: f.step ? f.step.split('/').pop() : f.name + '.step', stepBytes: null, source: { kind: 'library', entry: e, file: f } });
        } else if (f.step) {
          var sb = await readFileBytes(e.dir, f.step);
          App.showOverlay('変換中', (i + 1) + ' / ' + e.files.length + '  ' + f.step.split('/').pop());
          await nextFrames(2);
          var model = await Occt.convert(sb, App.precision(), f.name);
          // ユニットごとに分けて書き出された STEP は「自分の原点」に置かれている。
          // 組立位置は meta.json の placement から戻す (glb には焼いた状態で書き戻すので 1 回だけ)
          if (f.placement) GLB.place(model, f.placement);
          var dev = { model: model, fileName: f.step.split('/').pop(), stepBytes: sb, source: { kind: 'library', entry: e, file: f } };
          devices.push(dev);
          // glb は gzip して置く。書けたら STEP は片づける (マスターは Fusion のクラウド)
          try {
            var gz = await gzipBytes(GLB.write(model));
            await writeFile(e.dir, f.name + '.glb.gz', gz);
            f.glb = f.name + '.glb.gz';
            if (!Settings.keepStep()) await dropStep(e, f);
            await syncMeta(e, f, gz.length);   // meta.json を直さないと次のスキャンで見つからない
          } catch (werr) { /* 書けなくても表示は続ける */ }
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

  /* 書き戻した結果を meta.json に反映する。
   * Fusion スクリプトが書いた meta.json は「これから glb をここに置く」という予告なので、
   * 実際に置いた名前 (.glb.gz) と、STEP を片づけたことを書き戻しておく。 */
  async function syncMeta(e, f, glbSize) {
    var list = (e.meta && e.meta.files) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].name !== f.name) continue;
      list[i].glb = f.glb; list[i].step = f.step || null; list[i].glbSize = glbSize;
      try { await writeFile(e.dir, 'meta.json', JSON.stringify(e.meta, null, 2)); } catch (err) { }
      return;
    }
  }

  /* glb にできた STEP を装置フォルダから消す (空になった step/ も片づける)。
   * 容量は実測で 1/22 になる。マスターは Fusion のクラウドにあり、
   * 「Fusion で開く」から戻れるという前提。設定で残すこともできる。 */
  async function dropStep(e, f) {
    if (!f.step) return;
    var parts = f.step.split('/');
    try {
      var d = e.dir;
      for (var i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i]);
      await d.removeEntry(parts[parts.length - 1]);
      if (parts.length > 1 && await isEmpty(d)) await e.dir.removeEntry(parts[0]);
      f.step = null;
    } catch (err) { /* 読み取り専用などは放っておく */ }
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
  async function ensureConfig() {
    if (config) return config;
    config = { schema: 'library-viewer/library/1', layout: Store.layoutLabel(), naming: Naming.current(), inboxAuto: false, createdAt: isoNowLocal(), note: 'このファイルはライブラリの保存階層とネーミングルールを記録します。編集はビューアの「ネーミングルール」から。' };
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
    entries: function () { return entries; }, config: function () { return config; }, members: function () { return members; }, deleteEntry: deleteEntry,
    matches: matches, matchedPart: matchedPart, matchedTag: matchedTag, tagsOf: tagsOf, needsNames: needsNames, loadNames: loadNames, openEntry: openEntry
  };
})();
