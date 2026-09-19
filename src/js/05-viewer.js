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
  var pickHandler = null, overlayGroup = null, renderHooks = [];

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

  function resize() {
    var w = viewport.clientWidth || 1, h = viewport.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    requestRender();
  }
  function requestRender() { needsRender = true; }
  function loop() {
    if (!running) { running = true; }
    requestAnimationFrame(loop);
    if (!needsRender) return;
    needsRender = false;
    renderer.render(scene, camera);
    for (var i = 0; i < renderHooks.length; i++) renderHooks[i]();
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

  function bindPointer() {
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('pointerdown', function (e) {
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
    fitAll: fitAll, fitNode: fitNode, moveToNode: fitNode, leavesOf: leavesOf, stats: stats, requestRender: requestRender,
    sceneBox: function () { return sceneBox; }, sceneRadius: function () { return sceneRadius; },
    setPickHandler: setPickHandler, toScreen: toScreen, overlay: overlay, onRender: onRender, camera: cameraRef
  };
})();
