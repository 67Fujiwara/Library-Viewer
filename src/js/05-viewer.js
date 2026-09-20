/* 3D ビュー (three.js r128 UMD)。カメラ操作は pointer イベントで自前実装 (OrbitControls は ES モジュール版のみのため)。
 * 色は JS 内に持たず、CSS カスタムプロパティを getComputedStyle で読む。 */
var Viewer3D = (function () {
  var canvas, viewport, renderer, scene, camera, worldGroup, grid = null, dirLight;
  var ctrl = { target: null, dist: 1000, theta: -Math.PI / 4, phi: Math.PI / 3 };
  var needsRender = true, running = false;
  var mode = 'normal', ghost = false, edgesOn = false;
  var section = { axis: 'z', t: 0.5, flip: false, plane: null };
  var sceneBox = null, sceneRadius = 100;
  var selected = null, hoverLeaves = [], selectedLeaves = [];
  var leaves = [];          // 全メッシュ葉ノード (raycast 対象)
  var colors = {};
  var edgeMat = null, ghostOpacity = 0.07;
  var raycaster, pointer = { down: false, button: 0, x: 0, y: 0, sx: 0, sy: 0, moved: 0, shift: false };
  var callbacks = { onSelect: null, onHover: null };
  var pickHandler = null, overlayGroup = null, renderHooks = [], camAnim = null;

  function init(opts) {
    canvas = $('#gl'); viewport = $('#viewport');
    callbacks.onSelect = opts.onSelect; callbacks.onHover = opts.onHover;
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.localClippingEnabled = true;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(40, 1, 1, 100000);
    camera.up.set(0, 0, 1);
    ctrl.target = new THREE.Vector3();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 0.55));
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    dirLight = new THREE.DirectionalLight(0xffffff, 0.75);
    dirLight.position.set(0.6, 0.8, 1.6);
    camera.add(dirLight); scene.add(camera);   // ライトはカメラに追随させ、回転しても陰影が安定するように
    worldGroup = new THREE.Group(); scene.add(worldGroup);
    overlayGroup = new THREE.Group(); overlayGroup.renderOrder = 999; scene.add(overlayGroup);   // 計測の線・点 (クリッピングの影響を受けない)
    edgeMat = new THREE.LineBasicMaterial({ color: 0x000000 });
    section.plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    raycaster = new THREE.Raycaster();
    applyTheme();
    bindPointer();
    new ResizeObserver(resize).observe(viewport);
    resize();
    loop();
  }

  var lastW = 0, lastH = 0;
  function resize() {
    var w = viewport.clientWidth || 1, h = viewport.clientHeight || 1;
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    // setSize で描画バッファが空になる。次の rAF まで待つとそのフレームが黒く合成され、
    // サイドバーの開閉アニメ中はフレームごとに黒が挟まって画面が暗く見える。ここで描き切る。
    renderNow();
  }
  function requestRender() { needsRender = true; }
  function renderNow() {
    needsRender = false;
    renderer.render(scene, camera);
    for (var i = 0; i < renderHooks.length; i++) renderHooks[i]();
  }
  function loop() {
    if (!running) { running = true; }
    requestAnimationFrame(loop);
    if (camAnim) camAnim();
    if (!needsRender) return;
    renderNow();
  }

  /* 視点を滑らかに移す。位置関係を見失わないよう、瞬間移動はしない */
  function animateTo(to, ms) {
    var from = { theta: ctrl.theta, phi: ctrl.phi, dist: ctrl.dist, target: ctrl.target.clone() };
    var dTheta = to.theta - from.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;      // 近い方に回る
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    var t0 = performance.now();
    camAnim = function () {
      var k = Math.min(1, (performance.now() - t0) / ms);
      var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // easeInOutQuad
      ctrl.theta = from.theta + dTheta * e;
      ctrl.phi = from.phi + (to.phi - from.phi) * e;
      ctrl.dist = from.dist * Math.pow(to.dist / from.dist, e);        // 距離は対数で補間
      ctrl.target.lerpVectors(from.target, to.target, e);
      updateCamera();
      if (k >= 1) camAnim = null;
    };
  }

  /* ---- テーマ: CSS 変数を読んで 3D 側の色をすべて更新 ---- */
  function applyTheme() {
    colors = {
      bg: cssVar('--viewport-bg'), gridMajor: cssVar('--grid-major'), gridMinor: cssVar('--grid-minor'),
      edge: cssVar('--edge-color'), solid: cssVar('--solid-default'), select: cssVar('--select-color'), hover: cssVar('--hover-color')
    };
    ghostOpacity = parseFloat(cssVar('--ghost-opacity')) || 0.07;
    renderer.setClearColor(new THREE.Color(colors.bg), 1);
    edgeMat.color.set(colors.edge);
    leaves.forEach(function (n) { if (n.mesh && !n.mesh.userData.hasColor) n.mesh.userData.baseColor.set(colors.solid); });
    rebuildGrid();
    updateAllStates();
    requestRender();
  }

  /* ---- グリッド: モデルのスケールに合わせて再生成 ---- */
  function rebuildGrid() {
    if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); grid = null; }
    var span = niceNumber(sceneRadius * 3), step = niceNumber(span / 20);
    var divisions = Math.max(2, Math.round(span / step));
    grid = new THREE.GridHelper(step * divisions, divisions, new THREE.Color(colors.gridMajor), new THREE.Color(colors.gridMinor));
    grid.rotation.x = Math.PI / 2;    // XZ 平面 → XY 平面 (Z-up)
    if (sceneBox) { grid.position.set((sceneBox.min.x + sceneBox.max.x) / 2, (sceneBox.min.y + sceneBox.max.y) / 2, sceneBox.min.z); }
    grid.material.transparent = true; grid.material.opacity = 0.9;
    scene.add(grid);
  }
  function niceNumber(v) {
    if (!(v > 0)) return 100;
    var e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * e;
  }

  /* ---- 部品 (メッシュ) 生成 ---- */
  function createMesh(rec, node) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(rec.positions, 3));
    g.setIndex(new THREE.BufferAttribute(rec.indices, 1));
    if (rec.normals) g.setAttribute('normal', new THREE.BufferAttribute(rec.normals, 3)); else g.computeVertexNormals();
    g.computeBoundingBox(); g.computeBoundingSphere();
    var mat = new THREE.MeshStandardMaterial({ color: rec.color ? new THREE.Color(rec.color[0], rec.color[1], rec.color[2]) : new THREE.Color(colors.solid), roughness: 0.62, metalness: 0.08, side: THREE.DoubleSide });
    var mesh = new THREE.Mesh(g, mat);
    mesh.userData.node = node; mesh.userData.hasColor = !!rec.color; mesh.userData.baseColor = mat.color.clone();
    node.mesh = mesh; node.edges = null;
    node.tris = rec.indices.length / 3; node.verts = rec.positions.length / 3;
    return mesh;
  }

  function addDevice(device) {
    var group = new THREE.Group(); group.name = device.name;
    device.leaves.forEach(function (n) { group.add(createMesh(device.model.meshes[n.meshIndex], n)); leaves.push(n); });
    worldGroup.add(group); device.group = group;
    recomputeScene();
    device.leaves.forEach(applyState);
    if (edgesOn) device.leaves.forEach(ensureEdges);
    requestRender();
  }
  function removeDevice(device) {
    if (!device.group) return;
    worldGroup.remove(device.group);
    device.leaves.forEach(function (n) {
      leaves.splice(leaves.indexOf(n), 1);
      if (n.mesh) { n.mesh.geometry.dispose(); n.mesh.material.dispose(); if (n.edges) n.edges.geometry.dispose(); }
      n.mesh = null; n.edges = null;
    });
    device.group = null;
    if (selected && selected.device === device) selected = null;
    selectedLeaves = selectedLeaves.filter(function (n) { return n.device !== device; });
    hoverLeaves = hoverLeaves.filter(function (n) { return n.device !== device; });
    recomputeScene();
    requestRender();
  }

  function recomputeScene() {
    sceneBox = null;
    leaves.forEach(function (n) {
      if (!n.mesh) return;
      var b = n.mesh.geometry.boundingBox;
      if (!sceneBox) sceneBox = b.clone(); else sceneBox.union(b);
    });
    if (sceneBox) {
      var s = new THREE.Vector3(); sceneBox.getSize(s);
      sceneRadius = Math.max(s.length() / 2, 1);
    } else sceneRadius = 100;
    rebuildGrid();
    updateSectionPlane();
  }

  /* ---- 表示状態 (表示/非表示・ゴースト・半透明・ハイライト・エッジ) ---- */
  function applyState(n) {
    var m = n.mesh; if (!m) return;
    var mat = m.material;
    var vis = n.visible !== false;
    var isSel = selectedLeaves.indexOf(n) >= 0, isHov = hoverLeaves.indexOf(n) >= 0;
    if (!vis) {
      if (ghost) { m.visible = true; mat.transparent = true; mat.opacity = ghostOpacity; mat.depthWrite = false; }
      else m.visible = false;
    } else {
      m.visible = true;
      if (mode === 'xray' && !isSel) { mat.transparent = true; mat.opacity = 0.22; mat.depthWrite = false; }
      else { mat.transparent = false; mat.opacity = 1; mat.depthWrite = true; }
    }
    mat.clippingPlanes = (mode === 'section') ? [section.plane] : null;
    var base = m.userData.baseColor;
    if (isSel) { mat.color.set(colors.select); mat.emissive.set(colors.select); mat.emissiveIntensity = 0.25; }
    else if (isHov) { mat.color.copy(base).lerp(new THREE.Color(colors.hover), 0.55); mat.emissive.set(colors.hover); mat.emissiveIntensity = 0.15; }
    else { mat.color.copy(base); mat.emissive.set(0x000000); mat.emissiveIntensity = 0; }
    mat.needsUpdate = false;
    if (n.edges) n.edges.visible = edgesOn && vis;
  }
  function updateAllStates() {
    edgeMat.clippingPlanes = (mode === 'section') ? [section.plane] : null;
    leaves.forEach(applyState);
    requestRender();
  }
  function updateStates(nodes) { nodes.forEach(applyState); requestRender(); }

  function leavesOf(node) {
    if (!node) return [];
    if (node.leaves) return node.leaves;
    if (node.mesh) return [node];
    var out = [];
    (function walk(n) { if (n.mesh) out.push(n); (n.children || []).forEach(walk); })(node);
    return out;
  }
  function setHover(node) {
    var next = leavesOf(node), prev = hoverLeaves;
    hoverLeaves = next;
    // 変化した分だけ更新 (毎回全走査しない)
    var changed = prev.filter(function (n) { return next.indexOf(n) < 0; }).concat(next.filter(function (n) { return prev.indexOf(n) < 0; }));
    updateStates(changed);
  }
  function setSelected(node) {
    var next = leavesOf(node), prev = selectedLeaves;
    selected = node; selectedLeaves = next;
    var changed = prev.concat(next.filter(function (n) { return prev.indexOf(n) < 0; }));
    if (mode === 'xray') updateAllStates(); else updateStates(changed);
  }

  function setMode(m) { mode = m; updateAllStates(); }
  function setGhost(on) { ghost = !!on; updateAllStates(); }
  function ensureEdges(n) {
    if (!n.mesh || n.edges) return;
    // EdgesGeometry は重いので初回 ON のときだけ生成
    n.edges = new THREE.LineSegments(new THREE.EdgesGeometry(n.mesh.geometry, 28), edgeMat);
    n.mesh.add(n.edges);
  }
  function setEdges(on) {
    edgesOn = !!on;
    if (edgesOn) leaves.forEach(ensureEdges);
    updateAllStates();
  }

  /* ---- 断面 ---- */
  function setSection(axis, t, flip) {
    if (axis != null) section.axis = axis;
    if (t != null) section.t = t;
    if (flip != null) section.flip = !!flip;
    updateSectionPlane();
    requestRender();
  }
  function updateSectionPlane() {
    if (!sceneBox) return;
    var a = section.axis, min = sceneBox.min[a], max = sceneBox.max[a];
    var pos = min + (max - min) * section.t;
    var n = new THREE.Vector3(); n[a] = section.flip ? 1 : -1;
    section.plane.set(n, -n[a] * pos);
    section.value = pos;
  }
  function sectionValue() { return section.value; }

  /* ---- カメラ ---- */
  function updateCamera() {
    var d = ctrl.dist, sp = Math.sin(ctrl.phi);
    camera.position.set(ctrl.target.x + d * sp * Math.cos(ctrl.theta), ctrl.target.y + d * sp * Math.sin(ctrl.theta), ctrl.target.z + d * Math.cos(ctrl.phi));
    camera.lookAt(ctrl.target);
    camera.near = Math.max(0.05, d * 0.002);
    camera.far = d * 10 + sceneRadius * 40;
    camera.updateProjectionMatrix();
    requestRender();
  }
  function boxOf(node) {
    var ls = node ? leavesOf(node) : leaves.filter(function (n) { return n.visible !== false; });
    if (!ls.length) ls = leaves;
    var box = null;
    ls.forEach(function (n) { if (!n.mesh) return; var b = n.mesh.geometry.boundingBox; box = box ? box.union(b) : b.clone(); });
    return box;
  }
  /* 注視点と距離だけ移す (角度は変えない) */
  function moveToBox(box) {
    if (!box) return;
    var c = new THREE.Vector3(), s = new THREE.Vector3();
    box.getCenter(c); box.getSize(s);
    var r = Math.max(s.length() / 2, 0.5);
    ctrl.target.copy(c);
    ctrl.dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15;
    updateCamera();
  }
  function fitAll() { moveToBox(boxOf(null)); }
  function fitNode(node) { moveToBox(boxOf(node)); }

  /* ---- 「この部品に寄る」: いちばん面積が大きく見える角度へ回り込んでから寄る ---- */
  var occRay = new THREE.Raycaster();

  /* 部品の三角形を (重心・法線・面積) の一覧にする。
   * 多いときは間引くが、**間引いた分だけ面積を割り増す**。ここを忘れると、
   * 大きな面が数枚 + 穴まわりの小さな面が大量、という板で面積を大きく見誤る。 */
  function faceList(node, maxN) {
    var ls = leavesOf(node).filter(function (n) { return n.mesh && n.visible !== false; });
    var total = 0;
    ls.forEach(function (n) { total += n.tris || 0; });
    var out = [];
    if (!total) return out;
    var va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3();
    ls.forEach(function (n) {
      var geo = n.mesh.geometry, idx = geo.index.array, pos = geo.attributes.position.array;
      var triCount = idx.length / 3;
      var want = Math.max(1, Math.round(maxN * (n.tris || 0) / total));
      var step = Math.max(1, Math.floor(triCount / want));
      for (var t = 0; t < triCount; t += step) {
        va.fromArray(pos, idx[t * 3] * 3); vb.fromArray(pos, idx[t * 3 + 1] * 3); vc.fromArray(pos, idx[t * 3 + 2] * 3);
        u.subVectors(vb, va); v.subVectors(vc, va);
        var cr = new THREE.Vector3().crossVectors(u, v);
        var area = cr.length() / 2;
        if (!(area > 0)) continue;
        out.push({
          p: new THREE.Vector3((va.x + vb.x + vc.x) / 3, (va.y + vb.y + vc.y) / 3, (va.z + vb.z + vc.z) / 3),
          n: cr.normalize(), a: area * step
        });
      }
    });
    return out;
  }
  /* 向き u (部品 → カメラ) から見える投影面積。遮蔽は見ない (安いので候補をたくさん試せる) */
  function faceArea(u, faces) {
    var s = 0;
    for (var i = 0; i < faces.length; i++) {
      var c = faces[i].n.dot(u);
      if (c > 0) s += c * faces[i].a;
    }
    return s;
  }
  /* 面積の大きい法線の向きを k 個。板ならその板の面がまっすぐ正面に来る向きが出る。
   * 角度を格子で撒くだけだと、水平な板を真上から見る向き (phi≈0) に永久にたどり着けない。 */
  function dominantDirs(faces, k) {
    var cl = [];
    for (var i = 0; i < faces.length; i++) {
      var f = faces[i], hit = null;
      for (var j = 0; j < cl.length; j++) if (cl[j].n.dot(f.n) > 0.94) { hit = cl[j]; break; }   // 20° 以内は同じ向き
      if (hit) { hit.a += f.a; hit.n.addScaledVector(f.n, f.a / hit.a).normalize(); }
      else if (cl.length < 64) cl.push({ n: f.n.clone(), a: f.a });
    }
    cl.sort(function (a, b) { return b.a - a.a; });
    return cl.slice(0, k).map(function (c) { return c.n; });
  }
  function camPosFor(target, dist, theta, phi) {
    var sp = Math.sin(phi);
    return new THREE.Vector3(target.x + dist * sp * Math.cos(theta), target.y + dist * sp * Math.sin(theta), target.z + dist * Math.cos(phi));
  }
  /* 向きベクトル → カメラ角。真上・真下は少しだけ倒す (phi=0 ちょうどだと上方向が決まらない) */
  function anglesFor(u) {
    var z = Math.max(-1, Math.min(1, u.z));
    return { theta: Math.atan2(u.y, u.x), phi: Math.min(Math.PI - 0.06, Math.max(0.06, Math.acos(z))) };
  }
  function dirFor(theta, phi) {
    var sp = Math.sin(phi);
    return new THREE.Vector3(sp * Math.cos(theta), sp * Math.sin(theta), Math.cos(phi));
  }
  /* 角度の差 (回り込む量)。同じくらい見えるなら動きの小さい方を選ぶための物差し */
  function moveCost(theta, phi) {
    var dT = Math.abs(((theta - ctrl.theta + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
    return dT + Math.abs(phi - ctrl.phi);
  }
  /* その位置から実際に見える投影面積。遮られている標本は数えない。
   * 対象自身も遮蔽物に含めるので、自分の手前の面に隠れる部分は見えない扱いになる。 */
  function visibleArea(camPos, pts, objs, eps) {
    var sum = 0, dir = new THREE.Vector3();
    for (var i = 0; i < pts.length; i++) {
      dir.subVectors(pts[i].p, camPos);
      var len = dir.length();
      if (!(len > eps)) continue;
      dir.divideScalar(len);
      var c = -dir.dot(pts[i].n);
      if (c <= 0) continue;                   // カメラに背を向けている面
      occRay.set(camPos, dir);
      occRay.near = 0; occRay.far = len - eps;
      if (occRay.intersectObjects(objs, false).length) continue;
      sum += c * pts[i].a;
    }
    return sum;
  }
  /* 遮蔽を見るための標本は少しでいい (レイが高い)。面積の重みは保ったまま間引く */
  function thinOut(faces, maxN) {
    if (faces.length <= maxN) return faces;
    var step = Math.ceil(faces.length / maxN), out = [];
    for (var i = 0; i < faces.length; i += step) out.push({ p: faces[i].p, n: faces[i].n, a: faces[i].a * step });
    return out;
  }

  function focusNode(node) {
    var box = boxOf(node);
    if (!box) return;
    var c = box.getCenter(new THREE.Vector3()), s2 = box.getSize(new THREE.Vector3());
    var r = Math.max(s2.length() / 2, 0.5);
    var dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15;
    var faces = faceList(node, 1200);
    if (!faces.length) { animateTo({ theta: ctrl.theta, phi: ctrl.phi, dist: dist, target: c }, 420); return { rotated: false, score: 0 }; }

    // 1) まず遮蔽を無視して「面積がいちばん大きく見える向き」を探す (安いので広く探せる)
    var cands = [{ theta: ctrl.theta, phi: ctrl.phi }];
    dominantDirs(faces, 8).forEach(function (u) { cands.push(anglesFor(u)); });   // 板の面をまっすぐ向く角度
    var PH = [0.08, 0.22, 0.36, 0.5, 0.64, 0.78, 0.92];
    for (var pi = 0; pi < PH.length; pi++) {
      for (var ti = 0; ti < 12; ti++) cands.push({ theta: ctrl.theta + ti * Math.PI * 2 / 12, phi: PH[pi] * Math.PI });
    }
    cands.forEach(function (k) { k.area = faceArea(dirFor(k.theta, k.phi), faces); });
    cands.sort(function (a, b) { return b.area - a.area || moveCost(a.theta, a.phi) - moveCost(b.theta, b.phi); });

    // 2) いちばん良かった向きの周りを細かく詰める (格子の 30° 刻みのままだと面が斜めを向く)
    var top = cands[0], stepA = Math.PI / 12;
    for (var pass = 0; pass < 4; pass++, stepA /= 2) {
      var improved = false;
      for (var d = 0; d < 4; d++) {
        var t2 = top.theta + (d === 0 ? stepA : d === 1 ? -stepA : 0);
        var p2 = Math.min(Math.PI - 0.06, Math.max(0.06, top.phi + (d === 2 ? stepA : d === 3 ? -stepA : 0)));
        var a2 = faceArea(dirFor(t2, p2), faces);
        if (a2 > top.area * 1.0005) { top = { theta: t2, phi: p2, area: a2 }; improved = true; }
      }
      if (!improved) continue;
      pass--; stepA *= 2;                    // 良くなっている間は同じ刻みで進む
      if (stepA < 1e-3) break;
    }
    cands.unshift(top);

    // 3) 上位だけ遮蔽を確かめる (レイは高いので数を絞る)。隠れている角度はここで落ちる
    var pts = thinOut(faces, 48);
    var objs = [];
    leaves.forEach(function (n) { if (n.mesh && n.visible !== false) objs.push(n.mesh); });
    var eps = Math.max(r * 1e-3, 1e-4);
    var seen = {}, tried = [];
    for (var k = 0; k < cands.length && tried.length < 10; k++) {
      var key = Math.round(cands[k].theta * 20) + ':' + Math.round(cands[k].phi * 20);
      if (seen[key]) continue;
      seen[key] = 1;
      tried.push(cands[k]);
    }
    var current = visibleArea(camPosFor(c, dist, ctrl.theta, ctrl.phi), pts, objs, eps);
    var best = { theta: ctrl.theta, phi: ctrl.phi, area: current };
    tried.forEach(function (k) {
      var area = visibleArea(camPosFor(c, dist, k.theta, k.phi), pts, objs, eps);
      // 同じくらい見えるなら動きの小さい方
      if (area > best.area * 1.02 || (area > best.area * 0.98 && moveCost(k.theta, k.phi) < moveCost(best.theta, best.phi) && area > best.area)) {
        best = { theta: k.theta, phi: k.phi, area: area };
      }
    });
    // 今の角度でも十分よく見えているなら回さない (むやみに視点を変えない)
    var rotated = best.area > current / 0.85;
    if (!rotated) { best.theta = ctrl.theta; best.phi = ctrl.phi; }
    animateTo({ theta: best.theta, phi: best.phi, dist: dist, target: c }, 420);
    return { rotated: rotated, score: best.area ? Math.min(1, current / best.area) : 1, area: best.area };
  }

  function bindPointer() {
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('pointerdown', function (e) {
      camAnim = null;
      pointer.down = true; pointer.button = e.button; pointer.shift = e.shiftKey;
      pointer.x = pointer.sx = e.clientX; pointer.y = pointer.sy = e.clientY; pointer.moved = 0;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!pointer.down) { hoverPick(e); return; }
      var dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;
      pointer.x = e.clientX; pointer.y = e.clientY; pointer.moved += Math.abs(dx) + Math.abs(dy);
      if (pointer.button === 0 && !pointer.shift) {
        ctrl.theta -= dx * 0.006;
        ctrl.phi = Math.min(Math.PI - 0.02, Math.max(0.02, ctrl.phi - dy * 0.006));
      } else {
        var h = viewport.clientHeight || 1;
        var k = 2 * ctrl.dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / h;
        var right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        var up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
        ctrl.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      }
      updateCamera();
    });
    canvas.addEventListener('pointerup', function (e) {
      if (!pointer.down) return;
      pointer.down = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { }
      if (pointer.button === 0 && pointer.moved < 5) clickPick(e);
    });
    canvas.addEventListener('pointerleave', function () { if (!pointer.down && hoverLeaves.length) { setHover(null); if (callbacks.onHover) callbacks.onHover(null); } });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      camAnim = null;
      ctrl.dist *= Math.exp(e.deltaY * 0.0012);
      ctrl.dist = Math.max(sceneRadius * 0.005, Math.min(sceneRadius * 100, ctrl.dist));
      updateCamera();
    }, { passive: false });
  }
  /* レイキャストして最前面の交点を返す (計測はここから頂点・エッジを取る) */
  function rayHit(e) {
    var r = canvas.getBoundingClientRect();
    var v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(v, camera);
    var objs = [];
    leaves.forEach(function (n) { if (n.mesh && n.visible !== false) objs.push(n.mesh); });
    var hits = raycaster.intersectObjects(objs, false);
    if (mode === 'section') {
      // 断面で切り取られた側は無視する
      hits = hits.filter(function (h) { return section.plane.distanceToPoint(h.point) >= -1e-6; });
    }
    return hits.length ? hits[0] : null;
  }
  function pick(e) { var h = rayHit(e); return h ? h.object.userData.node : null; }
  var hoverPick = (function () {
    var last = 0;
    return function (e) {
      var now = performance.now(); if (now - last < 40) return; last = now;
      if (pickHandler) { pickHandler('hover', rayHit(e), e); return; }
      var n = pick(e);
      if (n !== (hoverLeaves.length === 1 ? hoverLeaves[0] : null)) { setHover(n); if (callbacks.onHover) callbacks.onHover(n); }
    };
  })();
  function clickPick(e) {
    if (pickHandler) { pickHandler('click', rayHit(e), e); return; }
    var n = pick(e); if (callbacks.onSelect) callbacks.onSelect(n);
  }

  /* ---- 計測など、別ツールに拾わせるための差し込み口 ---- */
  function setPickHandler(fn) {
    pickHandler = fn;
    if (!fn && hoverLeaves.length) { setHover(null); if (callbacks.onHover) callbacks.onHover(null); }
  }
  /* ワールド座標 → ビューポート内の CSS ピクセル */
  function toScreen(v) {
    var p = v.clone().project(camera), r = canvas.getBoundingClientRect();
    return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height, behind: p.z > 1 };
  }
  function overlay() { return overlayGroup; }
  function onRender(fn) { renderHooks.push(fn); }
  function cameraRef() { return camera; }

  function estimateGlbBytes(node) {
    var b = 0; leavesOf(node).forEach(function (n) { b += n.verts * 24 + n.tris * 12 + 200; });
    return b + 400;
  }
  function stats(node) {
    var ls = leavesOf(node), tris = 0, verts = 0;
    ls.forEach(function (n) { tris += n.tris || 0; verts += n.verts || 0; });
    var box = boxOf(node), size = box ? box.getSize(new THREE.Vector3()) : null;
    return { solids: ls.length, tris: tris, verts: verts, size: size, box: box, glbEstimate: estimateGlbBytes(node) };
  }

  return {
    init: init, addDevice: addDevice, removeDevice: removeDevice, applyTheme: applyTheme,
    setHover: setHover, setSelected: setSelected, setMode: setMode, setGhost: setGhost, setEdges: setEdges,
    setSection: setSection, sectionValue: sectionValue, updateAllStates: updateAllStates, updateStates: updateStates,
    fitAll: fitAll, fitNode: fitNode, focusNode: focusNode, moveToNode: fitNode, leavesOf: leavesOf, stats: stats, requestRender: requestRender,
    sceneBox: function () { return sceneBox; }, sceneRadius: function () { return sceneRadius; },
    setPickHandler: setPickHandler, toScreen: toScreen, overlay: overlay, onRender: onRender, camera: cameraRef
  };
})();
