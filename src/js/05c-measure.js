/* 計測モード (Fusion の「計測」に相当)
 *
 * STEP はメッシュに変換済みで B-rep の位相を持たないため、レイキャストで当たった三角形から
 * 頂点・辺・面上の点を求めてスナップする。2 点を拾うと距離と ΔX/ΔY/ΔZ を画面下のバーに出す。
 *
 * 色は CSS カスタムプロパティから読む (JS 内に色を持たない)。
 */
var Measure = (function () {
  var active = false, snapMode = 'auto';
  var points = [];            // 確定した点 [{v: Vector3, kind}]
  var preview = null;         // カーソル下のスナップ候補
  var group, dotsA, dotsB, mainLine, axisLines = [], labelEls = [], barEl, colors = {};
  var VERTEX_PX = 14, EDGE_PX = 10;

  function init() {
    barEl = $('#measure-bar');
    $('#chk-measure').addEventListener('change', function (e) { setActive(e.target.checked); });
    $('#measure-clear').addEventListener('click', clear);
    $('#measure-close').addEventListener('click', function () { setActive(false); });
    $$('input[name="snapmode"]').forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) { snapMode = r.value; preview = null; redraw(); } });
    });
    Viewer3D.onRender(placeLabels);
    Theme.onChange(function () { readColors(); redraw(); });
    readColors();
  }
  function readColors() {
    colors = { line: cssVar('--measure-line'), axis: cssVar('--measure-axis'), point: cssVar('--measure-point'), preview: cssVar('--measure-preview') };
  }

  function setActive(on) {
    if (active === on) return;
    active = on;
    $('#chk-measure').checked = on;
    barEl.hidden = !on;
    document.body.classList.toggle('measuring', on);
    Viewer3D.setPickHandler(on ? onPick : null);
    if (!on) clear();
    else { $('#measure-hint').textContent = '1 点目をクリック'; }
    Viewer3D.requestRender();
  }

  function clear() {
    points = []; preview = null;
    redraw();
    if (active) $('#measure-hint').textContent = '1 点目をクリック';
    readout();
  }

  /* ---- スナップ ---- */
  function nearestOnSegment(a, b, p) {
    var ab = b.clone().sub(a), t = ab.lengthSq() ? p.clone().sub(a).dot(ab) / ab.lengthSq() : 0;
    return a.clone().addScaledVector(ab, Math.max(0, Math.min(1, t)));
  }
  function snap(hit, e) {
    if (!hit) return null;
    if (snapMode === 'face') return { v: hit.point.clone(), kind: 'face' };
    var geo = hit.object.geometry, pos = geo.attributes.position, f = hit.face;
    if (!f) return { v: hit.point.clone(), kind: 'face' };
    var verts = [f.a, f.b, f.c].map(function (i) { return new THREE.Vector3().fromBufferAttribute(pos, i); });
    var canvasRect = $('#gl').getBoundingClientRect();
    var cx = e.clientX - canvasRect.left, cy = e.clientY - canvasRect.top;
    function px(v) { var s = Viewer3D.toScreen(v); return Math.hypot(s.x - cx, s.y - cy); }

    var bestV = null, bestVd = Infinity;
    verts.forEach(function (v) { var d = px(v); if (d < bestVd) { bestVd = d; bestV = v; } });
    var bestE = null, bestEd = Infinity;
    for (var i = 0; i < 3; i++) {
      var p = nearestOnSegment(verts[i], verts[(i + 1) % 3], hit.point), d = px(p);
      if (d < bestEd) { bestEd = d; bestE = p; }
    }
    if (snapMode === 'vertex') return { v: bestV, kind: 'vertex' };
    if (snapMode === 'edge') return { v: bestE, kind: 'edge' };
    if (bestVd <= VERTEX_PX) return { v: bestV, kind: 'vertex' };
    if (bestEd <= EDGE_PX) return { v: bestE, kind: 'edge' };
    return { v: hit.point.clone(), kind: 'face' };
  }

  function onPick(type, hit, e) {
    var s = snap(hit, e);
    if (type === 'hover') { preview = s; redraw(); readout(); return; }
    if (!s) return;               // 何も無いところをクリックしても消さない
    if (points.length >= 2) points = [];
    points.push(s);
    preview = null;
    $('#measure-hint').textContent = points.length === 1 ? '2 点目をクリック' : 'もう一度クリックすると測り直します';
    redraw(); readout();
  }

  /* ---- 描画 ---- */
  function disposeGroup() {
    if (!group) return;
    group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    Viewer3D.overlay().remove(group);
    group = null; dotsA = dotsB = mainLine = null; axisLines = [];
  }
  function dot(v, color, size) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([v.x, v.y, v.z]), 3));
    var m = new THREE.PointsMaterial({ color: new THREE.Color(color), size: size, sizeAttenuation: false, depthTest: false, transparent: true });
    var p = new THREE.Points(g, m); p.renderOrder = 1000;
    return p;
  }
  function line(a, b, color, dashed) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z]), 3));
    var m = dashed
      ? new THREE.LineDashedMaterial({ color: new THREE.Color(color), depthTest: false, transparent: true, opacity: 0.85, dashSize: Viewer3D.sceneRadius() * 0.02, gapSize: Viewer3D.sceneRadius() * 0.014 })
      : new THREE.LineBasicMaterial({ color: new THREE.Color(color), depthTest: false, transparent: true });
    var l = new THREE.Line(g, m);
    if (dashed) l.computeLineDistances();
    l.renderOrder = 1000;
    return l;
  }
  function redraw() {
    disposeGroup();
    group = new THREE.Group();
    Viewer3D.overlay().add(group);
    points.forEach(function (p) { group.add(dot(p.v, colors.point, 9)); });
    if (preview) group.add(dot(preview.v, colors.preview, 7));
    var a = points[0] && points[0].v;
    var b = points[1] ? points[1].v : (points.length === 1 && preview ? preview.v : null);
    if (a && b) {
      group.add(line(a, b, colors.line, false));
      // ΔX / ΔY / ΔZ を破線で (Fusion と同じく成分が見えるように)
      var c1 = new THREE.Vector3(b.x, a.y, a.z), c2 = new THREE.Vector3(b.x, b.y, a.z);
      [[a, c1], [c1, c2], [c2, b]].forEach(function (seg) {
        if (seg[0].distanceTo(seg[1]) > 1e-9) group.add(line(seg[0], seg[1], colors.axis, true));
      });
    }
    Viewer3D.requestRender();
  }

  /* ---- 読み取り値 ---- */
  function fmt(n) { return (Math.abs(n) < 0.0005 ? 0 : n).toFixed(2); }
  function kindLabel(k) { return { vertex: '頂点', edge: 'エッジ', face: '面' }[k] || ''; }
  function readout() {
    var a = points[0] && points[0].v;
    var b = points[1] ? points[1].v : (points.length === 1 && preview ? preview.v : null);
    var live = points.length === 1 && preview;
    function set(id, v) { $(id).textContent = v; }
    if (!a) {
      ['#m-dist', '#m-dx', '#m-dy', '#m-dz'].forEach(function (id) { set(id, '–'); });
      set('#m-p1', preview ? kindLabel(preview.kind) + '  ' + fmt(preview.v.x) + ', ' + fmt(preview.v.y) + ', ' + fmt(preview.v.z) : '–');
      set('#m-p2', '–');
      return;
    }
    set('#m-p1', kindLabel(points[0].kind) + '  ' + fmt(a.x) + ', ' + fmt(a.y) + ', ' + fmt(a.z));
    if (!b) { ['#m-dist', '#m-dx', '#m-dy', '#m-dz'].forEach(function (id) { set(id, '–'); }); set('#m-p2', '–'); return; }
    set('#m-p2', (points[1] ? kindLabel(points[1].kind) : kindLabel(preview.kind)) + '  ' + fmt(b.x) + ', ' + fmt(b.y) + ', ' + fmt(b.z));
    set('#m-dist', fmt(a.distanceTo(b)));
    set('#m-dx', fmt(b.x - a.x)); set('#m-dy', fmt(b.y - a.y)); set('#m-dz', fmt(b.z - a.z));
    barEl.classList.toggle('live', !!live);
  }

  /* ---- 3D 上のラベル (HTML を投影位置に置く) ---- */
  function placeLabels() {
    if (!active) { labelEls.forEach(function (el) { el.hidden = true; }); return; }
    var a = points[0] && points[0].v;
    var b = points[1] ? points[1].v : (points.length === 1 && preview ? preview.v : null);
    var el = labelEls[0] || (labelEls[0] = $('#measure-label'));
    if (!a || !b) { el.hidden = true; return; }
    var mid = a.clone().add(b).multiplyScalar(0.5), s = Viewer3D.toScreen(mid);
    if (s.behind) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = fmt(a.distanceTo(b)) + ' mm';
    el.style.left = s.x + 'px'; el.style.top = s.y + 'px';
  }

  return { init: init, setActive: setActive, toggle: function () { setActive(!active); }, isActive: function () { return active; }, clear: clear,
           points: function () { return points.map(function (p) { return { x: p.v.x, y: p.v.y, z: p.v.z, kind: p.kind }; }); } };
})();
