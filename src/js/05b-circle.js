/* メッシュから円 (穴・丸軸の断面) を検出する。
 *
 * OpenCASCADE のメッシュ節点は元の曲面の上に厳密に乗っている (粗い設定でも分割数が減るだけ)。
 * そのため、円形の境界ループに円を当てはめれば中心と半径は STEP の公称値と実質同じ精度で復元できる。
 * STEP を直接読む必要はなく、glb だけを開いた場合にも同じように使える。
 *
 * 手順: 当たった三角形から法線の連続する面を辿る → その領域の境界ループを取り出す
 *       → ループごとに円を当てはめ、残差が十分小さいものを円とみなす
 */
var CircleFit = (function () {
  var SMOOTH_COS = Math.cos(45 * Math.PI / 180);   // 隣接面がこれより折れていたら別の面とみなす
  var MAX_TRIS = 8000;                              // 巨大な面で探索が止まらなくなるのを防ぐ
  var ROUND_RMS = 1e-3;                             // 残差 / 半径 がこれ以下なら円と認める
  var topoCache = new WeakMap(), resultCache = new WeakMap();

  /* 位置が同じ頂点をまとめ、辺 → 三角形の対応を作る */
  function topology(geo) {
    var t = topoCache.get(geo);
    if (t) return t;
    var pos = geo.attributes.position.array, idx = geo.index.array;
    var n = pos.length / 3, remap = new Int32Array(n), seen = Object.create(null);
    for (var i = 0; i < n; i++) {
      var k = pos[i * 3].toFixed(4) + ',' + pos[i * 3 + 1].toFixed(4) + ',' + pos[i * 3 + 2].toFixed(4);
      if (seen[k] === undefined) seen[k] = i;
      remap[i] = seen[k];
    }
    var triCount = idx.length / 3, edges = Object.create(null), normals = new Float32Array(triCount * 3);
    var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3();
    for (var t2 = 0; t2 < triCount; t2++) {
      var i0 = idx[t2 * 3], i1 = idx[t2 * 3 + 1], i2 = idx[t2 * 3 + 2];
      a.fromArray(pos, i0 * 3); b.fromArray(pos, i1 * 3); c.fromArray(pos, i2 * 3);
      u.subVectors(b, a); v.subVectors(c, a); u.cross(v).normalize();
      normals[t2 * 3] = u.x; normals[t2 * 3 + 1] = u.y; normals[t2 * 3 + 2] = u.z;
      var r0 = remap[i0], r1 = remap[i1], r2 = remap[i2];
      [[r0, r1], [r1, r2], [r2, r0]].forEach(function (e) {
        var key = (e[0] < e[1] ? e[0] + '_' + e[1] : e[1] + '_' + e[0]);
        (edges[key] || (edges[key] = [])).push(t2);
      });
    }
    t = { remap: remap, edges: edges, normals: normals, triCount: triCount, pos: pos, idx: idx };
    topoCache.set(geo, t);
    return t;
  }

  /* 法線が連続する範囲を広げる */
  function smoothRegion(topo, startTri) {
    var region = Object.create(null), stack = [startTri], count = 0;
    region[startTri] = 1;
    while (stack.length && count < MAX_TRIS) {
      var t = stack.pop(); count++;
      var nx = topo.normals[t * 3], ny = topo.normals[t * 3 + 1], nz = topo.normals[t * 3 + 2];
      var i0 = topo.remap[topo.idx[t * 3]], i1 = topo.remap[topo.idx[t * 3 + 1]], i2 = topo.remap[topo.idx[t * 3 + 2]];
      [[i0, i1], [i1, i2], [i2, i0]].forEach(function (e) {
        var key = (e[0] < e[1] ? e[0] + '_' + e[1] : e[1] + '_' + e[0]);
        var tris = topo.edges[key]; if (!tris) return;
        for (var k = 0; k < tris.length; k++) {
          var o = tris[k];
          if (o === t || region[o]) continue;
          var d = nx * topo.normals[o * 3] + ny * topo.normals[o * 3 + 1] + nz * topo.normals[o * 3 + 2];
          if (d < SMOOTH_COS) continue;
          region[o] = 1; stack.push(o);
        }
      });
    }
    return count >= MAX_TRIS ? null : region;
  }

  /* 領域の境界 (領域内の三角形 1 つだけが持つ辺) をループに繋ぐ */
  function boundaryLoops(topo, region) {
    var bnd = Object.create(null), adj = Object.create(null);
    Object.keys(region).forEach(function (ts) {
      var t = +ts;
      var i0 = topo.remap[topo.idx[t * 3]], i1 = topo.remap[topo.idx[t * 3 + 1]], i2 = topo.remap[topo.idx[t * 3 + 2]];
      [[i0, i1], [i1, i2], [i2, i0]].forEach(function (e) {
        var key = (e[0] < e[1] ? e[0] + '_' + e[1] : e[1] + '_' + e[0]);
        var tris = topo.edges[key] || [], inside = 0;
        for (var k = 0; k < tris.length; k++) if (region[tris[k]]) inside++;
        if (inside === 1 && !bnd[key]) {
          bnd[key] = 1;
          (adj[e[0]] || (adj[e[0]] = [])).push(e[1]);
          (adj[e[1]] || (adj[e[1]] = [])).push(e[0]);
        }
      });
    });
    var loops = [], visited = Object.create(null);
    Object.keys(adj).forEach(function (vs) {
      var start = +vs;
      if (visited[start]) return;
      var loop = [], cur = start, prev = -1, guard = 0;
      while (guard++ < 100000) {
        visited[cur] = 1; loop.push(cur);
        var nb = adj[cur] || [], next = -1;
        for (var k = 0; k < nb.length; k++) if (nb[k] !== prev && !visited[nb[k]]) { next = nb[k]; break; }
        if (next < 0) { if (nb.indexOf(start) >= 0) loops.push(loop); break; }
        prev = cur; cur = next;
      }
    });
    return loops;
  }

  /* 3D の点群に円を当てはめる (平面を求めて投影 → Kåsa の線形最小二乗) */
  function fitCircle(points) {
    var n = points.length;
    if (n < 5) return null;
    var c = new THREE.Vector3();
    points.forEach(function (p) { c.add(p); });
    c.multiplyScalar(1 / n);
    // 共分散の最小固有ベクトル = 平面の法線 (べき乗法を逆行列なしで: 3x3 なので直接解く)
    var xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    points.forEach(function (p) {
      var dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
      xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
    });
    // 各軸を法線候補としたときの行列式から、最も平面に近い向きを選ぶ (three の方式と同等)
    var dx0 = yy * zz - yz * yz, dy0 = xx * zz - xz * xz, dz0 = xx * yy - xy * xy;
    var nrm = new THREE.Vector3();
    if (dx0 >= dy0 && dx0 >= dz0) { if (dx0 <= 0) return null; nrm.set(dx0, xz * yz - xy * zz, xy * yz - xz * yy); }
    else if (dy0 >= dz0) { if (dy0 <= 0) return null; nrm.set(xz * yz - xy * zz, dy0, xy * xz - yz * xx); }
    else { if (dz0 <= 0) return null; nrm.set(xy * yz - xz * yy, xy * xz - yz * xx, dz0); }
    nrm.normalize();
    var ex = new THREE.Vector3(1, 0, 0);
    if (Math.abs(nrm.dot(ex)) > 0.9) ex.set(0, 1, 0);
    var e1 = new THREE.Vector3().crossVectors(nrm, ex).normalize();
    var e2 = new THREE.Vector3().crossVectors(nrm, e1).normalize();
    // Kåsa: x^2 + y^2 + D x + E y + F = 0 を正規方程式で解く
    var Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0, uu = [], vv = [];
    for (var i = 0; i < n; i++) {
      var d = points[i].clone().sub(c);
      var x = d.dot(e1), y = d.dot(e2), z = x * x + y * y;
      uu.push(x); vv.push(y);
      Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y; Sxz += x * z; Syz += y * z; Sz += z;
    }
    var A = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]], B = [Sxz, Syz, Sz];
    var sol = solve3(A, B);
    if (!sol) return null;
    var cx = sol[0] / 2, cy = sol[1] / 2;
    var r2 = sol[2] + cx * cx + cy * cy;
    if (!(r2 > 0)) return null;
    var r = Math.sqrt(r2), rms = 0;
    for (var j = 0; j < n; j++) { var e = Math.hypot(uu[j] - cx, vv[j] - cy) - r; rms += e * e; }
    rms = Math.sqrt(rms / n);
    return { center: c.clone().addScaledVector(e1, cx).addScaledVector(e2, cy), normal: nrm, radius: r, rms: rms, count: n };
  }
  function solve3(A, B) {
    var M = [[A[0][0], A[0][1], A[0][2], B[0]], [A[1][0], A[1][1], A[1][2], B[1]], [A[2][0], A[2][1], A[2][2], B[2]]];
    for (var i = 0; i < 3; i++) {
      var p = i;
      for (var k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
      if (Math.abs(M[p][i]) < 1e-12) return null;
      var tmp = M[i]; M[i] = M[p]; M[p] = tmp;
      for (var k2 = 0; k2 < 3; k2++) {
        if (k2 === i) continue;
        var f = M[k2][i] / M[i][i];
        for (var j = i; j < 4; j++) M[k2][j] -= f * M[i][j];
      }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  }

  /* 当たった三角形の近くにある円を返す。無ければ null */
  function detect(mesh, triIndex, hitPoint) {
    var geo = mesh.geometry;
    if (!geo.index) return null;
    var cache = resultCache.get(geo) || (resultCache.set(geo, Object.create(null)), resultCache.get(geo));
    var key = String(triIndex);
    if (cache[key] !== undefined) return pickNearest(cache[key], hitPoint);
    var topo = topology(geo);
    var region = smoothRegion(topo, triIndex);
    var circles = [];
    if (region) {
      boundaryLoops(topo, region).forEach(function (loop) {
        if (loop.length < 5) return;
        var pts = loop.map(function (vi) { return new THREE.Vector3().fromArray(topo.pos, vi * 3); });
        var f = fitCircle(pts);
        if (f && f.rms / f.radius < ROUND_RMS) circles.push(f);
      });
    }
    cache[key] = circles;
    return pickNearest(circles, hitPoint);
  }
  /* 当たった点から「円周まで」の距離が最も近い円を選ぶ。
   * 穴の内壁をクリックすれば近い方の端の円、穴のまわりの平面をクリックすればその穴の円になる。 */
  function pickNearest(circles, hitPoint) {
    if (!circles || !circles.length) return null;
    var best = null, bd = Infinity, t = new THREE.Vector3();
    circles.forEach(function (c) {
      t.subVectors(hitPoint, c.center);
      var h = t.dot(c.normal);                                   // 円の面から離れている距離
      var inPlane = Math.sqrt(Math.max(0, t.lengthSq() - h * h));  // 面内で中心から離れている距離
      var d = Math.hypot(h, inPlane - c.radius);
      if (d < bd) { bd = d; best = c; }
    });
    return best;
  }

  return { detect: detect, fitCircle: fitCircle };
})();
if (typeof module !== 'undefined') module.exports = CircleFit;
