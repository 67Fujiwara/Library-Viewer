/* 格納: 案件情報を付けてフォルダ階層に保存 (File System Access API が本命、無ければ ZIP) */
var Store = (function () {
  var dlg, form, rosterEl, ownerView, previewEl, methodEl, devicesEl;
  /* 保存先の階層は 1 つに固定する (選ばせない。ライブラリ全体で同じ形でないと探せない)。
   * 担当者を階層に入れてあるので、フォルダを辿るだけで「その人が担当した装置」が集まる。 */
  var LAYOUT = function (p) { return ['models', p.dept, p.owner, p.code + '_' + p.dev, p.work]; };
  var LAYOUT_LABEL = 'models / 部署 / 担当者 / 案件コード_装置名 / 対象ワーク';
  var ROSTER_KEY = 'lv.roster';
  var DEFAULT_ROSTER = '設計1課, 山田\n設計1課, 佐藤\n設計2課, 鈴木\n生産技術, 高橋';
  var selectedOwner = null;   // {dept, name}

  function init() {
    dlg = $('#store-dialog'); form = $('#store-form'); rosterEl = $('#st-roster'); ownerView = $('#st-owner-view');
    previewEl = $('#st-preview'); methodEl = $('#st-method'); devicesEl = $('#st-devices');
    $('#btn-store').addEventListener('click', open);
    $('#st-cancel').addEventListener('click', function () { dlg.close(); });
    ['#st-project', '#st-device', '#st-work', '#st-customer'].forEach(function (s) { $(s).addEventListener('input', updatePreview); $(s).addEventListener('change', updatePreview); });
    form.addEventListener('submit', function (e) { e.preventDefault(); save(); });
    $('#st-edit-roster').addEventListener('click', function () { openRoster(); });
    $('#btn-roster').addEventListener('click', function () { openRoster(); });
    $('#roster-cancel').addEventListener('click', function () { $('#roster-dialog').close(); });
    $('#roster-dialog form').addEventListener('submit', function (e) { e.preventDefault(); saveRoster(); });
    $('#roster-export').addEventListener('click', function () {
      downloadBytes(new TextEncoder().encode(JSON.stringify({ schema: 'library-viewer/members/1', updatedAt: isoNowLocal(), members: draftList() }, null, 2)), 'members.json', 'application/json');
    });
    initRosterEditor();
    rosterEl.addEventListener('click', function (e) {
      var b = e.target.closest('button.dept'); if (b) b.classList.toggle('open');
    });
    rosterEl.addEventListener('change', function (e) {
      if (e.target.name !== 'st-member') return;
      var v = e.target.value.split('\u0000'); selectedOwner = { dept: v[0], name: v[1] };
      ownerView.textContent = v[0] + ' / ' + v[1]; updatePreview();
    });
  }

  /* ---- 名簿 ---- */
  function parseRoster(text) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var m = line.split(/[,、，\t]/); if (m.length < 2) return;
      var d = m[0].trim(), n = m.slice(1).join(',').trim(); if (d && n) out.push({ department: d, name: n });
    });
    return out;
  }
  function rosterText(list) { return list.map(function (m) { return m.department + ', ' + m.name; }).join('\n'); }
  function currentRoster() {
    var lib = Library.members();
    if (lib && lib.length) return lib;
    return parseRoster(Storage.get(ROSTER_KEY, DEFAULT_ROSTER));
  }
  /* ---- 名簿の編集ダイアログ ----
   *   テキストで「部署, 担当者」を書かせない (知らない人には JSON にしか見えない。要望)。
   *   部署ごとのカードに担当者をチップで並べ、カードの中の欄でその場で足す / × で外す。下の欄で部署を足す。
   *   編集中は draft (部署名 → 担当者の配列。順序つき) に持ち、「保存」でいつもの {department, name} の配列に戻す。
   *   Enter は「足す」(フォームの submit = 保存 にしない) */
  var draft = [];   // [{ dept, names: [] }]
  var listEl, deptInput;
  function draftList() {
    var out = [];
    draft.forEach(function (d) { d.names.forEach(function (n) { out.push({ department: d.dept, name: n }); }); });
    return out;
  }
  function toDraft(list) {
    var byDept = {}, order = [];
    list.forEach(function (m) {
      if (!byDept[m.department]) { byDept[m.department] = []; order.push(m.department); }
      if (byDept[m.department].indexOf(m.name) < 0) byDept[m.department].push(m.name);
    });
    return order.map(function (d) { return { dept: d, names: byDept[d] }; });
  }
  function deptOf(name) { return draft.filter(function (d) { return d.dept === name; })[0] || null; }
  function addDept(name) {
    name = String(name || '').trim();
    if (!name) return null;
    var d = deptOf(name);
    if (!d) { d = { dept: name, names: [] }; draft.push(d); }
    return d;
  }
  function addName(d, name) {
    name = String(name || '').trim();
    if (!d || !name || d.names.indexOf(name) >= 0) return false;
    d.names.push(name);
    return true;
  }
  var ICON_PEOPLE = 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.1a3.5 3.5 0 0 1 0 6.8';
  function renderRosterEditor(focusDept) {
    listEl.textContent = '';
    if (!draft.length) {
      listEl.appendChild(el('p.empty', { text: 'まだ部署がありません。下の欄に部署名を入れて「部署を追加」を押してください。' }));
      return;
    }
    draft.forEach(function (d) {
      var card = el('div.rd-dept', { dataset: { dept: d.dept } });
      card.appendChild(el('div.rd-head', {}, [
        svgIcon(ICON_PEOPLE),
        el('span.rd-name', { text: d.dept }),
        el('span.cnt', { text: d.names.length + ' 名' }),
        el('button.btn.link.small.rd-del-dept', { type: 'button', text: '部署を削除', title: 'この部署と担当者をまとめて外します' })
      ]));
      var box = el('div.rd-members');
      d.names.forEach(function (n) {
        box.appendChild(el('span.rd-member', { dataset: { name: n } }, [
          n,
          el('button.rd-x', { type: 'button', title: n + ' を名簿から外す', 'aria-label': n + ' を外す', dataset: { name: n } }, [svgIcon('M6 6l12 12M18 6L6 18')])
        ]));
      });
      var input = el('input.rd-name-input', { type: 'text', placeholder: '担当者の名前', autocomplete: 'off', spellcheck: 'false', 'aria-label': d.dept + ' に担当者を追加' });
      box.appendChild(el('span.rd-add', {}, [input, el('button.btn.small.secondary.rd-add-name', { type: 'button', text: '追加' })]));
      card.appendChild(box);
      listEl.appendChild(card);
      if (focusDept === d.dept) input.focus();
    });
  }
  function initRosterEditor() {
    listEl = $('#roster-list'); deptInput = $('#roster-dept-input');
    function commitName(card) {
      var d = deptOf(card.dataset.dept), input = card.querySelector('.rd-name-input');
      if (!d || !addName(d, input.value)) { input.value = ''; input.focus(); return; }
      renderRosterEditor(d.dept);   // 同じ部署の欄にフォーカスを戻す (続けて何人も足せる)
    }
    function commitDept() {
      var d = addDept(deptInput.value);
      if (!d) { deptInput.focus(); return; }
      deptInput.value = '';
      renderRosterEditor(d.dept);   // 作った部署の担当者欄へ
    }
    listEl.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var card = b.closest('.rd-dept'), d = card && deptOf(card.dataset.dept); if (!d) return;
      if (b.classList.contains('rd-add-name')) commitName(card);
      else if (b.classList.contains('rd-x')) { d.names = d.names.filter(function (n) { return n !== b.dataset.name; }); renderRosterEditor(); }
      else if (b.classList.contains('rd-del-dept')) {
        var go = d.names.length ? showConfirm('部署を削除', '「' + d.dept + '」と担当者 ' + d.names.length + ' 名（' + d.names.join('、') + '）を名簿から外します。', '外す') : Promise.resolve(true);
        go.then(function (ok) { if (!ok) return; draft = draft.filter(function (x) { return x !== d; }); renderRosterEditor(); });
      }
    });
    listEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || !e.target.classList.contains('rd-name-input')) return;
      e.preventDefault(); commitName(e.target.closest('.rd-dept'));
    });
    $('#roster-add-dept').addEventListener('click', commitDept);
    deptInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commitDept(); } });
  }
  function openRoster() {
    draft = toDraft(currentRoster());
    deptInput.value = '';
    renderRosterEditor();
    $('#roster-dialog').showModal();
  }
  async function saveRoster() {
    var list = draftList();   // 担当者のいない部署は保存されない (名簿は 部署 + 担当者 の組の一覧)
    Storage.set(ROSTER_KEY, rosterText(list));
    var shared = await Library.saveMembers(list);
    $('#roster-dialog').close();
    if (dlg.open) renderRoster();
    if (Library.connected() && !shared) showMessage('名簿', 'この PC には保存しましたが、ライブラリの members.json には書き込めませんでした。');
  }
  /* 名簿にない部署 / 担当者はその場で追加する */
  async function ensureMember(dept, name) {
    var list = currentRoster();
    if (list.some(function (m) { return m.department === dept && m.name === name; })) return;
    list.push({ department: dept, name: name });
    Storage.set(ROSTER_KEY, rosterText(list));
    await Library.saveMembers(list);
  }
  function renderRoster() {
    rosterEl.textContent = '';
    var list = currentRoster().slice(), byDept = {};
    if (selectedOwner && !list.some(function (m) { return m.department === selectedOwner.dept && m.name === selectedOwner.name; })) list.push({ department: selectedOwner.dept, name: selectedOwner.name + '\u0001' });
    list.forEach(function (m) { (byDept[m.department] = byDept[m.department] || []).push(m.name); });
    var depts = Object.keys(byDept);
    if (!depts.length) { rosterEl.appendChild(el('p.empty', { text: '名簿が空です。「名簿を編集」から追加してください。' })); return; }
    depts.forEach(function (d) {
      var open = selectedOwner && selectedOwner.dept === d;
      var b = el('button.dept' + (open ? '.open' : ''), { type: 'button' }, [svgIcon(ICON.chevronRight), d, el('span.cnt.muted.small', { text: byDept[d].length + '名' })]);
      var box = el('div.members');
      byDept[d].forEach(function (n) {
        var id = 'm-' + Math.random().toString(36).slice(2, 8), isNew = n.slice(-1) === '\u0001';
        if (isNew) n = n.slice(0, -1);
        var r = el('input', { type: 'radio', name: 'st-member', id: id, value: d + '\u0000' + n });
        if (open && selectedOwner.name === n) r.checked = true;
        box.appendChild(el('label.member', { for: id }, [r, n, isNew ? el('span.badge', { text: '名簿に追加', title: '格納すると名簿に追加されます' }) : null]));
      });
      rosterEl.appendChild(b); rosterEl.appendChild(box);
    });
  }

  /* ---- ダイアログ ---- */
  function open() {
    var devs = App.devices(); if (!devs.length) return;
    var note = $('#st-naming'), nm = devs[0].naming;
    if (nm) {
      $('#st-project').value = nm.projectCode; $('#st-device').value = nm.deviceName; $('#st-work').value = nm.workpiece || '';
      if (nm.customer) $('#st-customer').value = nm.customer;
      selectedOwner = { dept: nm.department, name: nm.owner };
      note.hidden = false; note.className = 'naming-note small'; note.textContent = 'ファイル名のルール「' + Naming.describe() + '」に一致したので、案件情報を自動入力しました: ' + devs[0].fileName;
    } else {
      $('#st-device').value = $('#st-device').value || devs[0].name;
      note.hidden = false; note.className = 'naming-note miss small'; note.textContent = 'ファイル名を「' + Naming.example() + '」の形にすると、案件情報が自動で入ります。';
    }
    var lib = Library.entries();
    var dl = $('#dl-projects'); dl.textContent = ''; var seen = {};
    lib.forEach(function (e) { var c = e.meta.projectCode; if (c && !seen[c]) { seen[c] = 1; dl.appendChild(el('option', { value: c })); } });
    var dw = $('#dl-works'); dw.textContent = ''; var seenW = {};
    lib.forEach(function (e) { var c = e.meta.workpiece; if (c && !seenW[c]) { seenW[c] = 1; dw.appendChild(el('option', { value: c })); } });
    var dc = $('#dl-customers'); dc.textContent = ''; var seenC = {};
    lib.forEach(function (e) { var c = e.meta.customer; if (c && !seenC[c]) { seenC[c] = 1; dc.appendChild(el('option', { value: c })); } });
    devicesEl.textContent = '';
    devs.forEach(function (d, i) {
      var st = Viewer3D.stats(d.root);
      var cb = el('input', { type: 'checkbox', dataset: { id: d.id } }); cb.checked = true;
      devicesEl.appendChild(el('label', {}, [cb, d.name, el('span.mono', { text: d.fileName + ' · △ ' + fmtInt(st.tris) + (d.stepBytes ? '' : ' · STEP なし(glb のみ)') })]));
    });
    var stored = Storage.get('lv.lastOwner', null); if (stored && !selectedOwner) selectedOwner = stored;
    if (selectedOwner) ownerView.textContent = selectedOwner.dept + ' / ' + selectedOwner.name;
    renderRoster();
    $('#st-layout-label').textContent = LAYOUT_LABEL;
    methodEl.textContent = Library.connected()
      ? 'ライブラリ「' + Library.name() + '」に直接書き込みます。'
      : (Library.supported() ? 'ライブラリを開いていないので ZIP をダウンロードします。ZIP を共有フォルダに展開してください。' : 'このブラウザではフォルダに直接書けないため ZIP をダウンロードします。');
    updatePreview();
    dlg.showModal();
  }
  function params() {
    return {
      code: sanitizeSegment($('#st-project').value), dev: sanitizeSegment($('#st-device').value), work: sanitizeSegment($('#st-work').value) || '_',
      dept: sanitizeSegment(selectedOwner ? selectedOwner.dept : '') || '_', owner: sanitizeSegment(selectedOwner ? selectedOwner.name : '') || '_'
    };
  }
  function segments(p) { return LAYOUT(p).map(function (s) { return s || '_'; }); }
  function updatePreview() {
    var p = params();
    previewEl.textContent = (Library.connected() ? Library.name() + '/' : '') + segments(p).join('/') + '/';
  }

  /* ---- パッケージ生成 (純関数: 3D シーンに依存しない。受信箱の取り込みからも使う) ----
   *   devs: [{fileName, model, stepBytes, nodes?}]  fields: {projectCode, deviceName, workpiece, department, owner}
   *   → { files:[{name,data}], segs:[...], meta } */
  function modelStats(model) {
    var tris = 0; model.meshes.forEach(function (m) { tris += m.indices.length / 3; });
    return { tris: tris, solids: model.meshes.length };
  }
  function flattenTree(root) {
    var out = [];
    (function walk(t, depth, path) {
      var p = path.concat([t.name || '']), solids = 0;
      (function cnt(n) { if (n.meshIndex != null) solids++; (n.children || []).forEach(cnt); })(t);
      out.push({ name: t.name || '', path: p.join('/'), depth: depth, solids: solids });
      (t.children || []).forEach(function (c) { walk(c, depth + 1, p); });
    })(root, 0, []);
    return out;
  }
  function segmentsFor(fields) {
    return segments({
      code: sanitizeSegment(fields.projectCode), dev: sanitizeSegment(fields.deviceName),
      work: sanitizeSegment(fields.workpiece) || '_',
      dept: sanitizeSegment(fields.department) || '_', owner: sanitizeSegment(fields.owner) || '_'
    });
  }
  /* 共有フォルダに置くのは **gzip した glb だけ**。
   * 実測 (1.36MB の STEP): glb 1.31MB (96% — ほとんど減らない) / gzip 0.12MB (9%)。
   * STEP のマスターは Fusion のクラウドにあるので共有フォルダには残さない
   * (設定「変換後も STEP を残す」を入れたときだけ置く)。 */
  async function buildPackage(devs, fields, preset, source) {
    var pr = Occt.PRESETS[preset] || Occt.PRESETS.standard;
    var files = [], metaFiles = [], index = { schema: 'library-viewer/index/1', devices: [] }, used = {};
    var keepStep = Settings.keepStep();
    for (var i = 0; i < devs.length; i++) {
      var d = devs[i];
      var base = baseName(d.fileName), k = 2;
      while (used[base]) base = baseName(d.fileName) + '_' + (k++);   // 同名ファイルの上書きを防ぐ
      used[base] = 1;
      var glb = GLB.write(d.model);   // glb は格納時に初めて生成する
      var gz = await gzipBytes(glb);
      var st = modelStats(d.model);
      files.push({ name: base + '.glb.gz', data: gz });
      if (keepStep && d.stepBytes) files.push({ name: 'step/' + base + '.step', data: d.stepBytes });
      metaFiles.push({ name: base, glb: base + '.glb.gz', step: (keepStep && d.stepBytes) ? 'step/' + base + '.step' : null,
        stepSize: d.stepBytes ? d.stepBytes.length : null, glbSize: gz.length, rawGlbSize: glb.length,
        triangles: st.tris, solids: st.solids, rootName: d.model.name });
      index.devices.push({ file: base, rootName: d.model.name, tree: flattenTree(d.model.root) });
    }
    var meta = {
      schema: 'library-viewer/1', projectCode: fields.projectCode, deviceName: fields.deviceName, workpiece: fields.workpiece || '',
      customer: fields.customer || '', department: fields.department, owner: fields.owner, savedAt: isoNowLocal(),
      precision: { preset: preset, linearDeflection: pr.linearDeflection, angularDeflection: pr.angularDeflection },
      files: metaFiles, source: source || { cad: 'step', app: 'library-viewer' }
    };
    files.push({ name: 'meta.json', data: new TextEncoder().encode(JSON.stringify(meta, null, 2)) });
    files.push({ name: 'index.json', data: new TextEncoder().encode(JSON.stringify(index, null, 2)) });
    return { files: files, segs: segmentsFor(fields), meta: meta };
  }

  /* ---- 保存 ---- */
  async function save() {
    var p = params();
    if (!p.code || !p.dev) { showMessage('入力を確認してください', '案件コードと装置名は必須です。'); return; }
    if (!selectedOwner) { showMessage('入力を確認してください', '部署 / 担当者を名簿から選んでください。'); return; }
    var ids = $$('input[type="checkbox"]', devicesEl).filter(function (c) { return c.checked; }).map(function (c) { return c.dataset.id; });
    var devs = App.devices().filter(function (d) { return ids.indexOf(d.id) >= 0; });
    if (!devs.length) { showMessage('入力を確認してください', '格納する装置を 1 つ以上選んでください。'); return; }
    Storage.set('lv.lastOwner', selectedOwner);
    var preset = App.precision();
    App.showOverlay('格納中', 'glb を生成しています');
    await nextFrames(2);
    try {
      // Fusion スクリプト等から来た装置なら出所情報を引き継ぐ
      var src = devs[0].source && devs[0].source.entry && devs[0].source.entry.meta && devs[0].source.entry.meta.source;
      var fields = { projectCode: $('#st-project').value.trim(), deviceName: $('#st-device').value.trim(), workpiece: $('#st-work').value.trim(), customer: $('#st-customer').value.trim(), department: selectedOwner.dept, owner: selectedOwner.name };
      var pkg = await buildPackage(devs, fields, preset, src || null);
      var files = pkg.files;
      await ensureMember(selectedOwner.dept, selectedOwner.name);
      var segs = pkg.segs;
      if (Library.connected()) {
        await Library.ensureConfig();
        await Library.writeFiles(segs, files);
        App.hideOverlay(); dlg.close();
        showMessage('格納しました', segs.join('/') + '/\n' + files.map(function (f) { return '  ' + f.name + '  (' + fmtBytes(f.data.length) + ')'; }).join('\n'));
        Library.scan();
      } else {
        var zip = ZIP.write(files.map(function (f) { return { name: segs.join('/') + '/' + f.name, data: f.data }; }));
        App.hideOverlay(); dlg.close();
        downloadBytes(zip, p.code + '_' + p.dev + '.zip', 'application/zip');
        showMessage('ZIP を書き出しました', '共有フォルダ (ライブラリのルート) で展開すると、次のパスに格納されます:\n' + segs.join('/') + '/');
      }
    } catch (e) {
      App.hideOverlay();
      showMessage('格納に失敗しました', String(e && e.message || e));
    }
  }
  return { init: init, open: open, buildPackage: buildPackage, segmentsFor: segmentsFor, ensureMember: ensureMember, layoutLabel: function () { return LAYOUT_LABEL; } };
})();
