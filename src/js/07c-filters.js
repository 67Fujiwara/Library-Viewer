/* 検索結果のフィルター (右パネル、結果の見出しの下)。
 *
 *   検索は「1 本の問い合わせ」で、左のツリーと右の一覧を同時に絞る (Tree.applySearch → Search.run)。
 *   フィルターはその問い合わせに掛ける追加条件で、右の一覧と左のツリーの両方に同じ条件が効く
 *   (ここでも検索を 2 つにしない)。
 *
 *   見た目はピル型の facet (タグ ▾ / 名称 / 種類 ▾ …)。押すと候補と件数のポップオーバーが開き、
 *   複数選べる (同じ facet の中は OR、facet どうしは AND)。選んでいるピルは塗りつぶし。
 *   どの facet を出すかは設定 (歯車 → 検索結果のフィルター) で切り替える。既定はタグと名称。
 *   facet を足すときは FACETS に 1 行足すだけ (値の取り出し方だけ書く)。
 */
var SearchFilters = (function () {
  var KEY = 'lv.searchFilters';
  var DEFAULT = ['tag', 'name'];
  var barEl = null, dialogEl = null, listEl = null;
  var active = {};          // facet id → { '畳んだ値': '表示名' } (text は文字列)
  var openId = null;        // 開いているポップオーバーの facet
  var lastHits = null, onChange = null;

  /* ---- ヒットから値を取り出す ---- */
  function metaOf(h) {
    if (h.kind === 'lib') return h.entry.meta || {};
    var d = h.node.device;
    if (!d) return {};
    return (d.source && d.source.entry && d.source.entry.meta) || d.naming || {};
  }
  function nameOf(h) {
    if (h.kind === 'lib') { var m = h.entry.meta || {}; return m.deviceName || h.entry.rel[h.entry.rel.length - 1] || ''; }
    return h.node.name || '';
  }
  function tagsOf(h) {
    if (h.kind === 'lib') return Library.tagsOf(h.entry);
    return CrossRef.tagsOf(h.node);
  }
  function metaField(k) { return function (h) { var v = metaOf(h)[k]; return v ? [String(v)] : []; }; }
  var KIND_LABEL = { folder: 'フォルダ', device: '装置', part: '部品', lib: 'ライブラリ（未読み込み）' };

  var FACETS = [
    { id: 'tag', label: 'タグ', type: 'set', values: tagsOf },
    { id: 'name', label: '名称', type: 'text', placeholder: '名称に含む文字', values: function (h) { return [nameOf(h)]; } },
    { id: 'kind', label: '種類', type: 'set', values: function (h) { return [KIND_LABEL[h.kind] || h.kind]; } },
    { id: 'device', label: '装置', type: 'set', values: function (h) {
      if (h.kind === 'lib') return [nameOf(h)];
      return h.node.device ? [h.node.device.name] : [];
    } },
    { id: 'department', label: '部署', type: 'set', values: metaField('department') },
    { id: 'owner', label: '担当者', type: 'set', values: metaField('owner') },
    { id: 'projectCode', label: '案件コード', type: 'set', values: metaField('projectCode') },
    { id: 'customer', label: '取引先', type: 'set', values: metaField('customer') }
  ];
  function facet(id) { for (var i = 0; i < FACETS.length; i++) if (FACETS[i].id === id) return FACETS[i]; return null; }

  /* ---- どの facet を出すか (設定) ---- */
  function enabledIds() {
    var v = Storage.get(KEY, null);
    if (!Array.isArray(v)) return DEFAULT.slice();
    return FACETS.map(function (f) { return f.id; }).filter(function (id) { return v.indexOf(id) >= 0; });
  }
  function setEnabled(id, on) {
    var ids = enabledIds(), i = ids.indexOf(id);
    if (on && i < 0) ids.push(id);
    if (!on && i >= 0) ids.splice(i, 1);
    Storage.set(KEY, ids);
    if (!on) delete active[id];
    if (lastHits) render(lastHits);
    if (onChange) onChange();
  }
  function enabled() { var ids = enabledIds(); return FACETS.filter(function (f) { return ids.indexOf(f.id) >= 0; }); }

  /* ---- 判定 ---- */
  function isActive(id) {
    var a = active[id];
    if (a == null) return false;
    return typeof a === 'string' ? a.length > 0 : Object.keys(a).length > 0;
  }
  function anyActive() { return Object.keys(active).some(isActive); }
  function passesFacet(f, h) {
    if (!isActive(f.id)) return true;
    var vals = f.values(h);
    if (f.type === 'text') {
      var q = Tags.fold(active[f.id]);
      return vals.some(function (v) { return Tags.fold(v).indexOf(q) >= 0; });
    }
    var sel = active[f.id];
    return vals.some(function (v) { return !!sel[Tags.fold(v)]; });
  }
  /* 他の facet だけで絞ったときに残るか (候補の件数はこれで数える。選んだ facet の候補が消えない) */
  function passesExcept(h, skipId) {
    var fs = enabled();
    for (var i = 0; i < fs.length; i++) if (fs[i].id !== skipId && !passesFacet(fs[i], h)) return false;
    return true;
  }
  function passes(h) { return passesExcept(h, null); }
  function apply(hits) {
    if (!anyActive()) return hits;
    return { folders: hits.folders.filter(passes), devices: hits.devices.filter(passes), parts: hits.parts.filter(passes), lib: hits.lib.filter(passes) };
  }
  /* 左のツリーの行にも同じ条件を掛ける (Tree.nodeMatches から) */
  function nodePasses(n) {
    if (!anyActive()) return true;
    return passes({ node: n, kind: n.isGroup ? 'folder' : n.depth === 0 ? 'device' : 'part' });
  }
  function all(hits) { return hits.folders.concat(hits.devices, hits.parts, hits.lib); }

  /* ---- 描画 ---- */
  function render(hits) {
    lastHits = hits;
    if (!barEl) return;
    barEl.textContent = '';
    var fs = enabled();
    barEl.hidden = !fs.length;
    if (!fs.length) return;
    fs.forEach(function (f) { barEl.appendChild(f.type === 'text' ? textPill(f) : setPill(f, hits)); });
    if (anyActive()) {
      barEl.appendChild(el('button.fclear', { type: 'button', title: 'フィルターをすべて外す', onclick: function () { active = {}; openId = null; changed(); } }, [svgIcon('M6 6l12 12M18 6L6 18'), 'クリア']));
    }
    if (openId) {
      var f = facet(openId);
      if (f && f.type === 'set') barEl.appendChild(popover(f, hits));
      else openId = null;
    }
  }
  function chevron() { return svgIcon('M6 9l6 6 6-6'); }
  function setPill(f, hits) {
    var sel = active[f.id] || {}, keys = Object.keys(sel), on = keys.length > 0;
    var b = el('button.fpill' + (on ? '.on' : ''), { type: 'button', dataset: { facet: f.id }, 'aria-expanded': String(openId === f.id), 'aria-haspopup': 'listbox',
      title: on ? f.label + ': ' + keys.map(function (k) { return sel[k]; }).join(', ') : f.label + 'で絞り込む' }, [
      el('span.l', { text: f.label }),
      on ? el('span.v', { text: keys.length === 1 ? sel[keys[0]] : keys.length + ' 件' }) : null,
      chevron()
    ]);
    b.addEventListener('click', function (e) { e.stopPropagation(); openId = openId === f.id ? null : f.id; render(lastHits); });
    return b;
  }
  function textPill(f) {
    var v = active[f.id] || '', on = v.length > 0;
    var input = el('input', { type: 'search', placeholder: f.placeholder || f.label, value: v, dataset: { facet: f.id }, autocomplete: 'off', 'aria-label': f.label });
    input.addEventListener('input', debounce(function () { active[f.id] = input.value.trim(); changed({ keepFocus: input }); }, 120));
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    return el('span.fpill.text' + (on ? '.on' : ''), {}, [svgIcon('M4 7h16M7 12h10M10 17h4'), input]);
  }
  /* 候補と件数。件数は「他の facet で絞った残り」の中で数える */
  function popover(f, hits) {
    var counts = {}, disp = {};
    all(hits).forEach(function (h) {
      if (!passesExcept(h, f.id)) return;
      var seen = {};
      f.values(h).forEach(function (v) {
        var k = Tags.fold(v); if (!k || seen[k]) return; seen[k] = 1;
        counts[k] = (counts[k] || 0) + 1; disp[k] = disp[k] || v;
      });
    });
    var sel = active[f.id] || {};
    Object.keys(sel).forEach(function (k) { if (!disp[k]) { disp[k] = sel[k]; counts[k] = 0; } });   // 選んでいるものは 0 件でも残す
    var keys = Object.keys(disp).sort(function (a, b) { return (sel[b] ? 1 : 0) - (sel[a] ? 1 : 0) || counts[b] - counts[a] || disp[a].localeCompare(disp[b], 'ja'); });
    var pop = el('div.fpop', { role: 'listbox', 'aria-label': f.label });
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
    pop.appendChild(el('div.fhead', {}, [
      el('span', { text: f.label + ' · ' + keys.length }),
      Object.keys(sel).length ? el('button.fclear', { type: 'button', text: '解除', onclick: function () { delete active[f.id]; changed(); } }) : null
    ]));
    if (!keys.length) pop.appendChild(el('p.muted.small', { text: '候補がありません。' }));
    keys.forEach(function (k) {
      var id = 'fopt-' + f.id + '-' + keys.indexOf(k);
      var cb = el('input', { type: 'checkbox', id: id });
      cb.checked = !!sel[k];
      cb.addEventListener('change', function () {
        var s = active[f.id] = active[f.id] || {};
        if (cb.checked) s[k] = disp[k]; else delete s[k];
        changed();
      });
      pop.appendChild(el('label.fopt', { 'for': id }, [cb, el('span.n', { text: disp[k] }), el('span.c', { text: String(counts[k]) })]));
    });
    return pop;
  }
  function changed(opts) {
    if (onChange) onChange();
    if (opts && opts.keepFocus) {
      var q = '[data-facet="' + opts.keepFocus.dataset.facet + '"]';
      var again = barEl.querySelector('input' + q);
      if (again) { again.focus(); var n = again.value.length; try { again.setSelectionRange(n, n); } catch (e) { } }
    }
  }
  function reset() { active = {}; openId = null; }
  function closePopover() { if (openId) { openId = null; if (lastHits) render(lastHits); return true; } return false; }

  /* ---- 設定のダイアログ ---- */
  function openDialog() {
    listEl.textContent = '';
    var ids = enabledIds();
    FACETS.forEach(function (f) {
      var id = 'flt-' + f.id;
      var cb = el('input.switch', { type: 'checkbox', id: id });
      cb.checked = ids.indexOf(f.id) >= 0;
      cb.addEventListener('change', function () { setEnabled(f.id, cb.checked); });
      listEl.appendChild(el('div.sm-row', {}, [el('label.sm-label', { 'for': id, text: f.label }), cb, el('label.switch-label', { 'for': id, 'aria-hidden': 'true' })]));
    });
    dialogEl.showModal();
  }

  function init(opts) {
    barEl = $('#search-filters'); dialogEl = $('#filters-dialog'); listEl = $('#filters-list');
    onChange = opts && opts.onChange;
    $('#btn-filters').addEventListener('click', openDialog);
    document.addEventListener('click', function (e) {
      if (openId && !e.target.closest('#search-filters')) closePopover();
    });
  }

  return { init: init, render: render, apply: apply, passes: passes, nodePasses: nodePasses, anyActive: anyActive,
    reset: reset, closePopover: closePopover, enabled: enabled, setEnabled: setEnabled, openDialog: openDialog,
    active: function () { return active; } };
})();
