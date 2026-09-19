/* 計測モード (Fusion の「計測」に相当)
 *
 * 距離 (2 点) と 角度 (3 点)。スナップは 自動 / 頂点 / 円 / エッジ / 面。
 *
 * 「円」は穴や丸軸の中心を拾う。STEP はメッシュに変換済みで B-rep の位相を持たないが、
 * OpenCASCADE のメッシュ節点は元の曲面上に厳密に乗っているため、円形の境界ループに円を
 * 当てはめれば中心・径は公称値と実質同じ精度で復元できる (CircleFit を参照)。
 * glb だけを開いた場合も同じように使える。
 *
 * 色は CSS カスタムプロパティから読む (JS 内に色を持たない)。
 */
var Measure = (function () {
  var active = false, snapMode = 'auto', measMode = 'distance';
  var points = [];            // 確定した点 [{v: Vector3, kind, radius?}]
  var preview = null;         // カーソル下のスナップ候補
  var group = null, labelEl = null, barEl, colors = {};
  var VERTEX_PX = 14, EDGE_PX = 10;
  var HINTS = { distance: ['1 点目をクリック', '2 点目をクリック', 'もう一度クリックすると測り直します'],
                angle: ['1 点目をクリック', '角の頂点をクリック', '3 点目をクリック', 'もう一度クリックすると測り直します'] };

  function need() { return measMode === 'angle' ? 3 : 2; }

  function init() {
    barEl = $('#measure-bar'); labelEl = $('#measure-label');
    $('#chk-measure').addEventListener('change', function (e) { setActive(e.target.checked); });
    $('#measure-clear').addEventListener('click', clear);
    $('#measure-close').addEventListener('click', function () { setActive(false); });
    $$('input[name="snapmode"]').forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) { snapMode = r.value; preview = null; redraw(); readout(); } });
    });
    $$('input[name="measmode"]').forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) { measMode = r.value; clear(); syncRows(); } });
    });
    Viewer3D.onRender(placeLabel);
    Theme.onChange(function () { readColors(); redraw(); });
    readColors(); syncRows();
  }
  function readColors() {
    colors = { line: cssVar('--measure-line'), axis: cssVar('--measure-axis'), point: cssVar('--measure-point'), preview: cssVar('--measure-preview') };
  }
  function syncRows() {
    $('#readout-dist').hidden = measMode !== 'distance';
    $('#readout-angle').hidden = measMode !== 'angle';
  }

  function setActive(on) {
    if (active === on) return;
    active = on;
    $('#chk-measure').checked = on;
    barEl.hidden = !on;
    document.body.classList.toggle('measuring', on);
    Viewer3D.setPickHandler(on ? onPick : null);
    if (!on) clear(); else hint();
    Viewer3D.requestRender();
  }
  function hint() { $('#measure-hint').textContent = HINTS[measMode][Math.min(points.length, HINTS[measMode].length - 1)]; }

  function clear() {
    points = []; preview = null;
    redraw(); readout();
    if (active) hint();
  }

  /* ---- スナップ ---- */
  function nearestOnSegment(a, b, p) {
    var ab = b.clone().sub(a), t = ab.lengthSq() ? p.clone().sub(a).dot(ab) / ab.lengthSq() : 0;
    return a.clone().addScaledVector(ab, Math.max(0, Math.min(1, t)));
  }
  function snap(hit, e) {
    if (!hit) return null;
    if (snapMode === 'circle') {
      var c = CircleFit.detect(hit.object, hit.faceIndex, hit.point);
      if (c) return { v: c.center.clone(), kind: 'circle', radius: c.radius, circle: c };
      return { v: hit.point.clone(), kind: 'face' };   // 円が見つからなければ面の点
    }
    if (snapMode === 'face') return { v: hit.point.clone(), kind: 'face' };
    var geo = hit.object.geometry, pos = geo.attributes.position, f = hit.face;
    if (!f) return { v: hit.point.clone(), kind: 'face' };
    var verts = [f.a, f.b, f.c].map(function (i) { return new THREE.Vector3().fromBufferAttribute(pos, i); });
    var rect = $('#gl').getBoundingClientRect();
    var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
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
    if (points.length >= need()) points = [];
    points.push(s);
    preview = null;
    hint(); redraw(); readout();
  }

  /* ---- 描画 ---- */
  function disposeGroup() {
    if (!group) return;
    group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    Viewer3D.overlay().remove(group);
    group = null;
  }
  function dot(v, color, size) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([v.x, v.y, v.z]), 3));
    var p = new THREE.Points(g, new THREE.PointsMaterial({ color: new THREE.Color(color), size: size, sizeAttenuation: false, depthTest: false, transparent: true }));
    p.renderOrder = 1000;
    return p;
  }
  function polyline(pts, color, dashed, loop) {
    var arr = [];
    pts.forEach(function (p) { arr.push(p.x, p.y, p.z); });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
    var m = dashed
      ? new THREE.LineDashedMaterial({ color: new THREE.Color(color), depthTest: false, transparent: true, opacity: 0.85, dashSize: Viewer3D.sceneRadius() * 0.02, gapSize: Viewer3D.sceneRadius() * 0.014 })
      : new THREE.LineBasicMaterial({ color: new THREE.Color(color), depthTest: false, transparent: true });
    var l = loop ? new THREE.LineLoop(g, m) : new THREE.Line(g, m);
    if (dashed) l.computeLineDistances();
    l.renderOrder = 1000;
    return l;
  }
  /* 検出した円をリングで見せる (何を拾ったか分かるように) */
  function ring(c, color) {
    var e1 = new THREE.Vector3(1, 0, 0);
    if (Math.abs(c.normal.dot(e1)) > 0.9) e1.set(0, 1, 0);
    var u = new THREE.Vector3().crossVectors(c.normal, e1).normalize();
    var v = new THREE.Vector3().crossVectors(c.normal, u).normalize();
    var pts = [];
    for (var i = 0; i < 64; i++) {
      var a = i / 64 * Math.PI * 2;
      pts.push(c.center.clone().addScaledVector(u, Math.cos(a) * c.radius).addScaledVector(v, Math.sin(a) * c.radius));
    }
    return polyline(pts, color, false, true);
  }
  function arc(center, a, b, color) {
    var u = a.clone().sub(center), v = b.clone().sub(center);
    var r = Math.min(u.length(), v.length()) * 0.28;
    if (!(r > 0)) return null;
    u.normalize(); v.normalize();
    var n = new THREE.Vector3().crossVectors(u, v);
    if (n.lengthSq() < 1e-12) return null;
    n.normalize();
    var w = new THREE.Vector3().crossVectors(n, u).normalize();
    var ang = Math.acos(Math.max(-1, Math.min(1, u.dot(v)))), pts = [];
    for (var i = 0; i <= 32; i++) {
      var t = ang * i / 32;
      pts.push(center.clone().addScaledVector(u, Math.cos(t) * r).addScaledVector(w, Math.sin(t) * r));
    }
    return polyline(pts, color, false, false);
  }

  function redraw() {
    disposeGroup();
    group = new THREE.Group();
    Viewer3D.overlay().add(group);
    points.forEach(function (p) {
      group.add(dot(p.v, colors.point, 9));
      if (p.circle) group.add(ring(p.circle, colors.point));
    });
    if (preview) {
      group.add(dot(preview.v, colors.preview, 7));
      if (preview.circle) group.add(ring(preview.circle, colors.preview));
    }
    var pts = shownPoints();
    if (measMode === 'distance' && pts.length === 2) {
      var a = pts[0], b = pts[1];
      group.add(polyline([a, b], colors.line, false, false));
      // ΔX / ΔY / ΔZ を破線で (Fusion と同じく差の内訳が見えるように)
      var c1 = new THREE.Vector3(b.x, a.y, a.z), c2 = new THREE.Vector3(b.x, b.y, a.z);
      [[a, c1], [c1, c2], [c2, b]].forEach(function (seg) {
        if (seg[0].distanceTo(seg[1]) > 1e-9) group.add(polyline(seg, colors.axis, true, false));
      });
    } else if (measMode === 'angle' && pts.length === 3) {
      group.add(polyline([pts[1], pts[0]], colors.line, false, false));
      group.add(polyline([pts[1], pts[2]], colors.line, false, false));
      var ar = arc(pts[1], pts[0], pts[2], colors.axis);
      if (ar) group.add(ar);
    }
    Viewer3D.requestRender();
  }
  /* 確定点 + (未確定なら) カーソル位置 */
  function shownPoints() {
    var out = points.map(function (p) { return p.v; });
    if (points.length < need() && preview) out.push(preview.v);
    return out;
  }

  /* ---- 読み取り値 ---- */
  function fmt(n) { return (Math.abs(n) < 0.0005 ? 0 : n).toFixed(2); }
  function kindLabel(p) {
    var k = { vertex: '頂点', edge: 'エッジ', face: '面', circle: '円' }[p.kind] || '';
    return p.kind === 'circle' ? k + ' φ' + fmt(p.radius * 2) : k;
  }
  function ptText(p) { return p ? kindLabel(p) + '  ' + fmt(p.v.x) + ', ' + fmt(p.v.y) + ', ' + fmt(p.v.z) : '–'; }
  function allPicks() {
    var out = points.slice();
    if (out.length < need() && preview) out.push(preview);
    return out;
  }
  function readout() {
    var picks = allPicks(), live = points.length < need() && !!preview;
    var set = function (id, v) { var el = $(id); if (el) el.textContent = v; };
    if (measMode === 'distance') {
      set('#m-p1', ptText(picks[0])); set('#m-p2', ptText(picks[1]));
      if (picks.length < 2) { ['#m-dist', '#m-dx', '#m-dy', '#m-dz'].forEach(function (id) { set(id, '–'); }); }
      else {
        var a = picks[0].v, b = picks[1].v;
        set('#m-dist', fmt(a.distanceTo(b)));
        set('#m-dx', fmt(b.x - a.x)); set('#m-dy', fmt(b.y - a.y)); set('#m-dz', fmt(b.z - a.z));
      }
    } else {
      set('#a-p1', ptText(picks[0])); set('#a-p2', ptText(picks[1])); set('#a-p3', ptText(picks[2]));
      if (picks.length < 3) { ['#m-ang', '#m-l1', '#m-l2'].forEach(function (id) { set(id, '–'); }); }
      else {
        var u = picks[0].v.clone().sub(picks[1].v), v = picks[2].v.clone().sub(picks[1].v);
        var lu = u.length(), lv = v.length();
        set('#m-l1', fmt(lu)); set('#m-l2', fmt(lv));
        set('#m-ang', (lu > 0 && lv > 0) ? (Math.acos(Math.max(-1, Math.min(1, u.dot(v) / (lu * lv)))) * 180 / Math.PI).toFixed(2) : '–');
      }
    }
    barEl.classList.toggle('live', live);
  }

  /* ---- 3D 上のラベル (HTML を投影位置に置く) ---- */
  function placeLabel() {
    if (!active) { labelEl.hidden = true; return; }
    var picks = allPicks(), at = null, text = null;
    if (measMode === 'distance' && picks.length === 2) {
      at = picks[0].v.clone().add(picks[1].v).multiplyScalar(0.5);
      text = fmt(picks[0].v.distanceTo(picks[1].v)) + ' mm';
    } else if (measMode === 'angle' && picks.length === 3) {
      at = picks[1].v;
      var u = picks[0].v.clone().sub(at), v = picks[2].v.clone().sub(at);
      if (u.length() > 0 && v.length() > 0) text = (Math.acos(Math.max(-1, Math.min(1, u.dot(v) / (u.length() * v.length())))) * 180 / Math.PI).toFixed(2) + '°';
    }
    if (!at || !text) { labelEl.hidden = true; return; }
    var s = Viewer3D.toScreen(at);
    if (s.behind) { labelEl.hidden = true; return; }
    labelEl.hidden = false;
    labelEl.textContent = text;
    labelEl.style.left = s.x + 'px'; labelEl.style.top = s.y + 'px';
  }

  return {
    init: init, setActive: setActive, toggle: function () { setActive(!active); }, isActive: function () { return active; }, clear: clear,
    points: function () { return points.map(function (p) { return { x: p.v.x, y: p.v.y, z: p.v.z, kind: p.kind, radius: p.radius }; }); }
  };
})();
