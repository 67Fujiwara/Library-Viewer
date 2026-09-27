/* 検索 (名称 / タグ / 保存先パス) の結果一覧。左の絞り込みと同じ問い合わせで、当たったものを右パネルに並べる。
 *
 *   ヒットの選び方: フォルダはタグ・名称、装置はファイル名と案件情報、部品は名称、
 *                   さらにライブラリの保存先パス (部署 / 担当者 / 案件コード_装置名 / 対象ワーク)。
 *   「藤原」で検索すれば、藤原が担当した装置は読み込んでいなくてもライブラリから出てくる。
 *   一覧から選ぶ → そのまとまりだけ表示に残し、関係のない部品はチェックを外す (Tree.isolate)
 *   カメラは角度を変えずに収める (Viewer3D.fitNode)。回り込むのは「この部品に寄る」だけ
 */
var Search = (function () {
  var panelEl, xrefEl, listEl, sumEl, inputEl, clearBtn;
  var MAX_PARTS = 50, MAX_LIB = 30;
  var EMPTY = { folders: [], devices: [], parts: [], lib: [] };
  var hits = EMPTY, query = '', currentId = null, byNode = {};   // byNode: ノード id → ヒット (左のツリーのフィルター判定に使う)

  /* ---- 当たった装置の自動読み込み ----
   *   ライブラリ (未読み込み) のカードを 1 枚ずつ押すのは面倒 (要望) なので、検索したら glb 済みの当たりは
   *   自動で読み込む。入力が落ち着いてから (AUTO_DELAY)、1 つの問い合わせにつき MAX_AUTO 件まで。
   *   未変換の STEP (変換に分単位) と上限を超えた分はカードに残す。設定 (歯車 → 検索) でオフにできる。
   *   読み込んだ装置は 3D に出さない (`hidden`)。結果のカードを選んだものだけ表示する (要望) */
  var AUTO_KEY = 'lv.autoLoadHits', AUTO_DELAY = 500, MAX_AUTO = 20;
  var autoTimer = null, autoQuery = '', autoCount = 0, loadingKeys = {};
  var chosenQuery = null;   // カードを選んだ問い合わせ。選んだ後は (閉じた装置を) 同じ問い合わせで読み直さない
  function autoLoad() { return Storage.get(AUTO_KEY, true) !== false; }
  function setAutoLoad(on) { Storage.set(AUTO_KEY, !!on); if (on && query) scheduleAutoLoad(); }
  function entryKey(e) { return e.rel.join('/'); }
  function isLoading(e) { return !!loadingKeys[entryKey(e)]; }
  function anyLoading() { return Object.keys(loadingKeys).length > 0; }
  function scheduleAutoLoad() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    if (!autoLoad() || !query) return;
    if (chosenQuery === query) return;   // カードを選んで初期化した後。読み直すと初期化が無かったことになる
    if (query !== autoQuery) { autoQuery = query; autoCount = 0; }   // 問い合わせが変わったら上限を数え直す
    var room = MAX_AUTO - autoCount;
    if (room <= 0) return;
    var ready = hits.lib.filter(function (h) { return Library.isReady(h.entry) && !isLoading(h.entry); }).slice(0, room);
    if (!ready.length) return;
    var q = query;
    autoTimer = setTimeout(function () {
      autoTimer = null;
      if (query !== q) return;
      autoCount += ready.length;
      ready.forEach(function (h) { loadingKeys[entryKey(h.entry)] = 1; });
      render();   // 「読み込み中」を出す
      Library.openEntries(ready.map(function (h) { return h.entry; }), { hidden: true }).then(function () {
        ready.forEach(function (h) { delete loadingKeys[entryKey(h.entry)]; });
        if (query) run(query);   // 読み込めたものはライブラリの欄から消え、装置・部品の当たりに移る
      });
    }, AUTO_DELAY);
  }

  /* ---- 保存先 (ファイルパス) の表示 ----
   *   区切りごとに役割 (部署 / 担当者 / 案件コード_装置名 / 対象ワーク / フォルダ / 部品の階層) を持たせ、
   *   設定 (歯車 → 検索 → 保存先の強調) で選んだ役割だけ太く濃く出す。パスは切らずに全部出す。
   *   装置のファイル名は出さない (保存先と同じ情報の繰り返しになるだけ。要望で非表示) */
  var EMPH_KEY = 'lv.pathEmphasis', EMPH_DEFAULT = ['project'];
  var ROLES = [
    { id: 'department', label: '部署' }, { id: 'owner', label: '担当者' }, { id: 'project', label: '案件コード_装置名' },
    { id: 'workpiece', label: '対象ワーク' }, { id: 'folder', label: 'フォルダ' },
    { id: 'unit', label: '部品の階層（ユニット）' }
  ];
  var LIB_ROLES = ['department', 'owner', 'project', 'workpiece'];   // models/ の下の並び (09-store.js の LAYOUT と同じ)
  function emphasized() { var v = Storage.get(EMPH_KEY, null); return Array.isArray(v) ? v : EMPH_DEFAULT.slice(); }
  function setEmphasized(id, on) {
    var list = emphasized().filter(function (x) { return x !== id; });
    if (on) list.push(id);
    Storage.set(EMPH_KEY, list);
    if (query) render();
  }
  function roleLabel(id) { var r = ROLES.filter(function (x) { return x.id === id; })[0]; return r ? r.label : ''; }
  function libSegs(rel) {
    var out = [];
    // 先頭の models だけ落とす。models/ の無いライブラリ (ルート直下に 部署/ が並ぶ) では rel に models が
    // 入らないので、無条件に 1 つ落とすと 部署 が消えて役割が 1 つずれる (実際にそうなった)
    var segs = (rel || []).slice(rel && rel[0] === 'models' ? 1 : 0);
    segs.forEach(function (s, i) {
      var role = LIB_ROLES[i] || 'folder';
      if (s === '_' && role === 'workpiece') return;   // 対象ワークなし
      out.push({ text: s, role: role });
    });
    return out;
  }
  function pathSegs(n) {
    var out = [];
    if (n.isGroup) { n.path.slice(0, -1).forEach(function (s) { out.push({ text: s, role: 'folder' }); }); return out; }
    var d = n.device, src = d.source || {};
    if (src.kind === 'library' && src.entry) out = libSegs(src.entry.rel);
    else (d.groupPath || []).forEach(function (s) { out.push({ text: s, role: 'folder' }); });
    if (n.depth > 0) n.path.slice(1, -1).forEach(function (s) { out.push({ text: s, role: 'unit' }); });
    return out;
  }
  function pathEl(segs) {
    var p = el('div.path'), em = emphasized();
    if (!segs.length) { p.textContent = '最上位'; return p; }
    segs.forEach(function (s, i) {
      if (i) p.appendChild(el('span.sep', { text: ' / ' }));
      p.appendChild(el('span.seg' + (em.indexOf(s.role) >= 0 ? '.em' : ''), { text: s.text, title: roleLabel(s.role) }));
    });
    return p;
  }
  function openEmphDialog() {
    var list = $('#path-emph-list'); list.textContent = '';
    var cur = emphasized();
    ROLES.forEach(function (r) {
      var id = 'emph-' + r.id;
      var cb = el('input.switch', { type: 'checkbox', id: id });
      cb.checked = cur.indexOf(r.id) >= 0;
      cb.addEventListener('change', function () { setEmphasized(r.id, cb.checked); });
      list.appendChild(el('div.sm-row', {}, [el('label.sm-label', { 'for': id, text: r.label }), cb, el('label.switch-label', { 'for': id, 'aria-hidden': 'true' })]));
    });
    $('#path-emph-dialog').showModal();
  }

  function init() {
    panelEl = $('#search-panel'); xrefEl = $('#xref-panel');
    listEl = $('#search-list'); sumEl = $('#search-sum');
    inputEl = $('#tree-search');
    clearBtn = $('#search-clear');
    // 検索をやめる = 検索で読み込んだものも含めて、構成にある装置を全部閉じる (次の検索を素の状態から始める)
    clearBtn.addEventListener('click', function () { Tree.setSearch(''); App.clearDevices(); inputEl.focus(); });
    // フィルター (結果の見出しの下)。変えたら一覧を描き直し、左のツリーにも同じ条件を掛ける
    SearchFilters.init({ onChange: function () { if (query) { render(); Tree.refilter(); } } });
    $('#btn-path-emph').addEventListener('click', openEmphDialog);
    var chk = $('#chk-auto-load');
    chk.checked = autoLoad();
    chk.addEventListener('change', function () { setAutoLoad(chk.checked); });
  }

  /* 検索欄は右パネルの中にあるので、畳んでいたら開いてから入れる (/ か Ctrl+F) */
  function focus() {
    if (!Panels.isOpen('right')) Panels.set('right', true);
    inputEl.focus(); inputEl.select();
  }

  function run(raw) {
    var prev = query;
    query = String(raw == null ? '' : raw).trim();
    if (query !== prev) chosenQuery = null;   // 問い合わせが変わったら自動読み込みは普段どおり
    if (!query) {
      hits = EMPTY; currentId = null; byNode = {};
      SearchFilters.reset();                               // 次の検索に前のフィルターを持ち越さない
      if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
      listEl.textContent = ''; sumEl.textContent = '';   // 消し忘れた結果を DOM に残さない
      panelEl.hidden = true; xrefEl.hidden = false;
      CrossRef.show(App.selected());
      return hits;
    }
    hits = collect(Tags.fold(query));
    panelEl.hidden = false; xrefEl.hidden = true;
    render();
    scheduleAutoLoad();
    // 読み込んでいない装置の部品名は index.json から。まだ読んでいなければ読んでから結果を出し直す
    if (Library.needsNames()) {
      var q = query;
      Library.loadNames().then(function () { if (query === q) run(q); });
    }
    return hits;
  }

  /* 装置に付いている案件情報 (ライブラリから開いたもの・ネーミングルールで解析できたもの) */
  function deviceWords(d) {
    var m = (d.source && d.source.entry && d.source.entry.meta) || d.naming || {};
    var rel = (d.source && d.source.entry && d.source.entry.rel) || [];
    return Tags.fold([d.name, d.fileName, m.projectCode, m.deviceName, m.workpiece, m.customer, m.department, m.owner, rel.join('/')].join(' '));
  }

  /* フォルダ → 装置 → 部品 → ライブラリ の順。タグで当たったものを先頭に出す。
   * 問い合わせはカンマ区切りで複数語 (AND)。語ごとに 名称 か タグ のどちらかで当たればよい。
   * by: 'name' (全語が名称) / 'tag' (全語がタグ) / 'mixed' (名称とタグの組み合わせ)。フィルターの「一致」がこれで分ける */
  function hitOf(n, kind, words, key, terms) {
    var byName = terms.every(function (t) { return words.indexOf(t) >= 0; });
    var tag = null, byTag = terms.every(function (t) { var h = Tags.hit(key, t); if (h && !tag) tag = h; return !!h; });
    if (byName) return { node: n, kind: kind, by: 'name', tag: byTag ? tag : null };   // タグでも当たっていればバッジは出す
    if (byTag) return { node: n, kind: kind, by: 'tag', tag: tag };
    var both = terms.every(function (t) { var h = Tags.hit(key, t); if (h && !tag) tag = h; return words.indexOf(t) >= 0 || !!h; });
    return both ? { node: n, kind: kind, by: 'mixed', tag: tag } : null;
  }
  function collect(f) {
    var terms = Tags.terms(f), folders = [], devices = [], parts = [];
    if (!terms.length) return EMPTY;
    function put(list, h) { if (h) { if (h.by === 'tag') list.unshift(h); else list.push(h); } }
    Tree.allNodes().forEach(function (n) {
      if (n.isGroup) put(folders, hitOf(n, 'folder', Tags.fold(n.name), n.path.join('/'), terms));
      else if (n.depth === 0) put(devices, hitOf(n, 'device', deviceWords(n.device), Tree.tagKey(n), terms));
      else put(parts, hitOf(n, 'part', Tags.fold(n.name), Tree.tagKey(n), terms));
    });
    // ライブラリ: 保存先パスの語 (部署・担当者・案件コード・装置名・対象ワーク)・部品名・以前付けたタグに当たるもの。
    // すでに読み込んである装置と同じものは出さない
    var open = {};
    App.devices().forEach(function (d) { if (d.source && d.source.entry) open[d.source.entry.rel.join('/')] = 1; });
    var lib = Library.entries().filter(function (e) {
      return Library.matches(e, f) && !open[e.rel.join('/')];
    }).map(function (e) { var part = Library.matchedPart(e, f); return { entry: e, kind: 'lib', part: part, tag: part ? null : Library.matchedTag(e, f) }; });
    byNode = {};
    folders.concat(devices, parts).forEach(function (h) { byNode[h.node.id] = h; });
    return { folders: folders, devices: devices, parts: parts, lib: lib };
  }
  function hitOfNode(n) { return (n && byNode[n.id]) || null; }
  function count() { return hits.folders.length + hits.devices.length + hits.parts.length + hits.lib.length; }

  function render() {
    listEl.textContent = '';
    var total = count();
    SearchFilters.render(hits);
    var shown = SearchFilters.apply(hits), left = shown.folders.length + shown.devices.length + shown.parts.length + shown.lib.length;
    sumEl.textContent = total
      ? '「' + query + '」に ' + total + ' 件（フォルダ ' + hits.folders.length + ' / 装置 ' + hits.devices.length + ' / 部品 ' + hits.parts.length + (hits.lib.length ? ' / ライブラリ ' + hits.lib.length : '') + '）'
        + (SearchFilters.anyActive() ? ' → 絞り込み ' + left + ' 件' : '')
        + (anyLoading() ? ' — ライブラリから読み込み中…' : '')
      : '「' + query + '」に当たるものはありません。';
    if (!total) {
      listEl.appendChild(el('p.muted.small', { text: '行を右クリック →「タグを付ける」でフォルダ・装置・部品にタグを付けると、ここから探せます。ライブラリは部署・担当者・案件コード・装置名・対象ワーク・中の部品名・以前付けたタグで探せます（読み込んでいない装置も当たります）。' }));
      return;
    }
    if (!left) {
      listEl.appendChild(el('p.muted.small', { text: 'フィルターに当たるものがありません。「クリア」で外せます。' }));
      return;
    }
    section('フォルダ', shown.folders);
    section('装置', shown.devices);
    section('部品', shown.parts.slice(0, MAX_PARTS));
    if (shown.parts.length > MAX_PARTS) listEl.appendChild(el('p.muted.small', { text: '部品は先頭 ' + MAX_PARTS + ' 件だけ出しています。' }));
    if (shown.lib.length) {
      listEl.appendChild(el('h3', { text: 'ライブラリ（未読み込み） ' + shown.lib.length }));
      shown.lib.slice(0, MAX_LIB).forEach(function (h) { listEl.appendChild(libCard(h)); });
      if (shown.lib.length > MAX_LIB) listEl.appendChild(el('p.muted.small', { text: 'ライブラリは先頭 ' + MAX_LIB + ' 件だけ出しています。' }));
      if (autoLoad()) {
        var unconv = shown.lib.filter(function (h) { return !Library.isReady(h.entry); }).length;
        var over = shown.lib.length - unconv - shown.lib.filter(function (h) { return isLoading(h.entry); }).length;
        var notes = [];
        if (unconv) notes.push('未変換の STEP ' + unconv + ' 件は変換に時間がかかるので自動では読み込みません（押すと変換して読み込みます）');
        if (over > 0 && autoCount >= MAX_AUTO) notes.push('自動で読み込むのは 1 回の検索で ' + MAX_AUTO + ' 件まで。残りは押して読み込みます');
        if (notes.length) listEl.appendChild(el('p.muted.small', { text: notes.join('。') + '。' }));
      }
    }
    mark();
  }
  function section(title, list) {
    if (!list.length) return;
    listEl.appendChild(el('h3', { text: title + ' ' + list.length }));
    list.forEach(function (h) { listEl.appendChild(card(h)); });
  }

  function card(h) {
    var n = h.node;
    var head = el('div.dev', {}, [
      n.isGroup ? svgIcon(ICON.folder) : null,
      el('span', { text: n.name }),
      h.tag ? el('span.brk') : null,   // バッジは名前の長さに関係なく次の行に (位置を揃える)
      h.tag ? el('span.badge.coral', { text: h.tag, title: h.by === 'tag' ? 'タグで当たりました' : '名称とタグで当たりました' }) : null
    ]);
    // ソリッド数・三角形数は出さない (要望。案件横断のカードには残す)
    var b = el('button.xref-card.hit-card', { type: 'button', dataset: { id: n.id }, title: 'これだけ表示する（関係のない部品はチェックを外し、構成にはこの装置だけを出します）' }, [
      head, pathEl(pathSegs(n))   // 保存先はすべて出す (切らない)。強調は設定
    ]);
    b.addEventListener('click', function () { apply(h); });
    return b;
  }

  /* まだ読み込んでいないライブラリの装置。押すと今の表示に足して読み込む */
  function libCard(h) {
    var m = h.entry.meta || {}, loading = isLoading(h.entry);
    var b = el('button.xref-card.hit-card' + (loading ? '.loading' : ''), { type: 'button', disabled: loading, title: loading ? '読み込み中…' : 'ライブラリから読み込みます（今の表示に追加）' }, [
      el('div.dev', {}, [svgIcon(ICON.folder), el('span', { text: m.deviceName || h.entry.rel[h.entry.rel.length - 1] }), el('span.brk'), h.part ? el('span.badge.coral', { text: h.part, title: 'この部品名で当たりました' }) : h.tag ? el('span.badge.coral', { text: h.tag, title: '以前読み込んだときに付けたタグで当たりました' }) : (m.owner ? el('span.badge', { text: m.owner }) : null)]),
      pathEl(libSegs(h.entry.rel)),
      el('div.stats', {}, [
        m.projectCode ? el('span', { text: m.projectCode }) : null,
        m.customer ? el('span', { text: m.customer }) : null,
        m.workpiece ? el('span', { text: m.workpiece }) : null,
        el('span', { text: loading ? '読み込み中…' : 'ファイル ' + h.entry.files.length })
      ])
    ]);
    // 読み込んだら装置全体ではなく、当たった部品 (無ければタグの行 → 装置) だけを残して見せる。
    // 先に構成を初期化する (ライブラリから読み込んだ装置を全部閉じる。カードを選ぶたびに 0 から)
    b.addEventListener('click', function () {
      chosenQuery = query;
      App.keepOnly([]);
      Library.openEntry(h.entry, true).then(function (devs) {
        var n = App.findLoaded(devs, { name: h.part, tag: h.tag });
        if (n) App.showOnly(n, { keepXref: true, select: false, only: true });
      });
    });
    return b;
  }

  /* 選んだものだけ残す: 関係のない部品はチェックを外して非表示にし、カメラを角度そのままで収める。
   * 選択 (ハイライト色) にはしない: 検索で残した部品は普通の色で見せる (要望)。
   * 構成は 0 から: その装置 (フォルダのカードなら中の装置) 以外のライブラリの装置は閉じる (`App.keepOnly`。
   * 自動読み込みで入った装置を構成に積み上げない。要望)。閉じた装置はライブラリ (未読み込み) のカードに戻り、
   * 同じ問い合わせでは自動で読み直さない (`chosenQuery`)。ファイルから読んだ装置は閉じずに表示から外す (`only`) */
  function apply(h) {
    var n = h.node;
    currentId = n.id;
    chosenQuery = query;
    App.keepOnly(n.isGroup ? Tree.devicesUnder(n) : [n.device]);
    App.showOnly(n, { keepXref: true, select: false, only: true });
    mark();
  }
  function mark() {
    $$('.hit-card', listEl).forEach(function (c) { c.classList.toggle('current', c.dataset.id === currentId); });
  }

  /* 装置を消した・読み込んだ後に一覧を作り直す (消えたノードを指したままにしない) */
  function refresh() { if (query) run(query); }

  return { init: init, run: run, refresh: refresh, focus: focus, query: function () { return query; }, hits: function () { return hits; }, hitOfNode: hitOfNode, shown: function () { return SearchFilters.apply(hits); },
    pathSegs: pathSegs, emphasized: emphasized, setEmphasized: setEmphasized, openEmphDialog: openEmphDialog,
    autoLoad: autoLoad, setAutoLoad: setAutoLoad, loading: anyLoading };
})();
