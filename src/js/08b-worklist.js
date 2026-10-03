/* 左パネルの「ワーク」「取引先」タブ: ライブラリの装置を 案件コード_対象ワーク / 案件コード_取引先 の題名で並べる。
 * 一覧はライブラリの走査結果 (Library.entries) をそのまま使う (別に走査しない)。
 * 行の左に検査方法 (雑多 / 単品) のチップ。並びは 雑多 → 単品 → 未設定 に分けてから案件コードの若い順。
 * 題名にホバーすると、ミスミのカテゴリメニューのように右へ浮いた枠に装置のサムネイル (thumb.jpg) を出す。
 * サムネイルは装置フォルダから 1 回だけ読む (Library.thumbURL)。無い装置は「画像なし」と出し、開いたときに作られる。 */
var WorkList = (function () {
  var MODES = {
    work: { field: 'workpiece', label: '対象ワーク', empty: '対象ワークが入っている装置がありません', missing: '対象ワークの無い装置' },
    customer: { field: 'customer', label: '取引先', empty: '取引先が入っている装置がありません', missing: '取引先の無い装置' }
  };
  var INSPECTION_ORDER = ['雑多', '単品', ''];   // 並びの第 1 鍵 (未設定は最後)
  var mode = null, panel, listEl, noteEl, pop, popImg, popCap, hoverTimer = null, hideTimer = null, popFor = null, dirty = true;

  function init() {
    panel = $('#wl-panel'); listEl = $('#wl-list'); noteEl = $('#wl-note');
    pop = $('#wl-pop'); popImg = $('#wl-pop-img'); popCap = $('#wl-pop-cap');
    // 枠の上にポインタがある間は消さない (枠の中へ移っても消えないように)
    pop.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    pop.addEventListener('mouseleave', function () { scheduleHide(); });
    listEl.addEventListener('scroll', function () { hidePop(); });
    window.addEventListener('resize', function () { hidePop(); });
  }

  /* タブが選ばれたとき (App.showLeftTab から) */
  function show(name) {
    mode = MODES[name] ? name : null;
    panel.hidden = !mode;
    if (mode) render();
    else hidePop();
  }
  /* ライブラリの一覧が変わったとき (Library.renderList から)。見えていなければ次に開いたときに描く */
  function refresh() {
    dirty = true;
    if (mode && !panel.hidden) render();
  }
  function inspectionOf(e) {
    var v = e.meta && e.meta.inspection;
    return Store.INSPECTIONS.indexOf(v) >= 0 ? v : '';
  }
  function titleOf(e, field) { return (e.meta.projectCode || '') + '_' + (e.meta[field] || ''); }
  function cmpCode(a, b) { return String(a).localeCompare(String(b), 'ja', { numeric: true, sensitivity: 'base' }); }
  /* 並び: 検査方法 (雑多 → 単品 → 未設定) → 案件コードの若い順 → 題名 → 装置名 */
  function sorted(list, field) {
    return list.slice().sort(function (a, b) {
      var ia = INSPECTION_ORDER.indexOf(inspectionOf(a)), ib = INSPECTION_ORDER.indexOf(inspectionOf(b));
      if (ia !== ib) return ia - ib;
      return cmpCode(a.meta.projectCode || '', b.meta.projectCode || '') || cmpCode(titleOf(a, field), titleOf(b, field)) || cmpCode(a.meta.deviceName || '', b.meta.deviceName || '');
    });
  }
  function entriesFor(name) {
    var field = MODES[name].field, all = Library.entries();
    var list = all.filter(function (e) { return !!(e.meta && e.meta[field]); });
    return { list: sorted(list, field), missing: all.length - list.length, field: field };
  }

  function render() {
    dirty = false;
    hidePop();
    listEl.textContent = '';
    var m = MODES[mode], r = entriesFor(mode);
    if (!Library.connected()) {
      listEl.appendChild(el('p.empty', { text: '「ライブラリを開く」で共有フォルダを選ぶと、\n' + m.label + 'ごとの一覧がここに出ます。' }));
      noteEl.hidden = true;
      return;
    }
    if (!r.list.length) listEl.appendChild(el('p.empty', { text: m.empty }));
    var last = null, box = null;
    r.list.forEach(function (e) {
      var ins = inspectionOf(e);
      if (ins !== last || !box) {
        last = ins;
        box = el('div.wl-group', {}, [el('h3', {}, [el('span', { text: ins || '未設定' }), el('span.cnt.mono', { text: String(r.list.filter(function (x) { return inspectionOf(x) === ins; }).length) })])]);
        listEl.appendChild(box);
      }
      box.appendChild(row(e, r.field, ins));
    });
    noteEl.hidden = !r.missing;
    noteEl.textContent = r.missing ? m.missing + ' ' + r.missing + ' 件は「ライブラリ」タブから開けます' : '';
  }
  function row(e, field, ins) {
    var b = el('button.wl-row', { type: 'button', dataset: { id: e.id, inspection: ins }, title: '開く: ' + (e.meta.deviceName || '') + '\n' + e.rel.join('/') + '/' }, [
      el('span.insp' + (ins === '単品' ? '.single' : ins === '雑多' ? '.misc' : '.none'), { text: ins || '—' }),
      el('span.title', { text: titleOf(e, field) }),
      el('span.sub', { text: e.meta.deviceName || '' })
    ]);
    b.addEventListener('click', function () { hidePop(); Library.openEntry(e); });
    b.addEventListener('mouseenter', function () { scheduleShow(b, e); });
    b.addEventListener('mouseleave', function () { clearTimeout(hoverTimer); scheduleHide(); });
    b.addEventListener('focus', function () { scheduleShow(b, e); });
    b.addEventListener('blur', function () { clearTimeout(hoverTimer); scheduleHide(); });
    return b;
  }

  /* ---- ホバーの枠 (サムネイル + 案件情報)。行の右、左パネルの外に浮かべる ---- */
  function scheduleShow(rowEl, e) {
    clearTimeout(hoverTimer); clearTimeout(hideTimer);
    hoverTimer = setTimeout(function () { showPop(rowEl, e); }, 140);
  }
  function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hidePop, 160); }
  function hidePop() { clearTimeout(hoverTimer); pop.hidden = true; popFor = null; popImg.removeAttribute('src'); }
  async function showPop(rowEl, e) {
    popFor = e;
    var m = e.meta, field = MODES[mode].field;
    popCap.textContent = '';
    popCap.appendChild(el('div.t', { text: titleOf(e, field) }));
    popCap.appendChild(el('div.m', { text: (m.deviceName || '') + (m.customer && field !== 'customer' ? ' · ' + m.customer : '') + (m.workpiece && field !== 'workpiece' ? ' · ' + m.workpiece : '') }));
    popCap.appendChild(el('div.m.muted', { text: (m.department || '') + ' / ' + (m.owner || '') + '  ' + fmtDate(m.savedAt) }));
    pop.classList.toggle('noimg', !e.thumb);
    popImg.hidden = !e.thumb; $('#wl-pop-none').hidden = !!e.thumb;
    pop.hidden = false;
    place(rowEl);
    if (e.thumb) {
      var url = await Library.thumbURL(e);
      if (popFor !== e) return;                 // 待っている間に別の行へ移った
      if (url) { popImg.src = url; popImg.hidden = false; $('#wl-pop-none').hidden = true; }
      else { popImg.hidden = true; $('#wl-pop-none').hidden = false; }
    }
  }
  function place(rowEl) {
    var r = rowEl.getBoundingClientRect(), pr = panel.getBoundingClientRect();
    pop.style.left = Math.round(pr.right + 6) + 'px';
    var h = pop.offsetHeight || 220;
    var top = Math.min(r.top, window.innerHeight - h - 8);
    pop.style.top = Math.max(8, Math.round(top)) + 'px';
  }

  return { init: init, show: show, refresh: refresh, inspectionOf: inspectionOf, entriesFor: entriesFor, mode: function () { return mode; } };
})();
