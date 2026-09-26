/* GLB ライター / リーダー (自作。GLTFExporter は ES モジュール版しかないため)
 *
 * 入力モデル:
 *   { name, root: {name, meshIndex|null, children:[...]}, meshes: [{name, positions, normals, indices, color}] }
 *   positions/normals: Float32Array (mm, Z-up), indices: Uint32Array, color: [r,g,b] | null
 *
 * 出力 GLB は glTF 2.0 準拠。ジオメトリは mm / Z-up のまま格納し、
 * ルートノードに Y-up / m への変換行列を持たせる (他ビューアでも正しく見える)。
 * 1 ソリッド = 1 プリミティブ + 1 マテリアル + 1 ノード。
 */
var GLB = (function () {
  var GLB_MAGIC = 0x46546C67, CHUNK_JSON = 0x4E4F534A, CHUNK_BIN = 0x004E4942;
  var ROOT_EXTRAS = { libraryViewer: { upAxis: 'Z', unit: 'mm' } };
  var ROOT_MATRIX = [0.001, 0, 0, 0, 0, 0, -0.001, 0, 0, 0.001, 0, 0, 0, 0, 0, 1]; // Z-up mm → Y-up m

  function pad4(n) { return (n + 3) & ~3; }

  function write(model) {
    var json = {
      asset: { version: '2.0', generator: 'Library Viewer' },
      scene: 0, scenes: [{ nodes: [0] }],
      nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: []
    };
    var parts = [];   // Uint8Array の並び
    var offset = 0;

    function addView(arr, target) {
      var bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target: target });
      parts.push(bytes);
      var padded = pad4(bytes.byteLength);
      if (padded !== bytes.byteLength) parts.push(new Uint8Array(padded - bytes.byteLength));
      offset += padded;
      return json.bufferViews.length - 1;
    }

    var meshIdMap = [];
    model.meshes.forEach(function (m, i) {
      // occt-import-js は通常の Array で返すことがあるので型付き配列に揃える
      var pos = m.positions instanceof Float32Array ? m.positions : new Float32Array(m.positions);
      var nrm = m.normals instanceof Float32Array ? m.normals : new Float32Array(m.normals);
      var idx = m.indices instanceof Uint32Array ? m.indices : new Uint32Array(m.indices);
      var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (var k = 0; k < pos.length; k += 3) {
        for (var a = 0; a < 3; a++) { var v = pos[k + a]; if (v < min[a]) min[a] = v; if (v > max[a]) max[a] = v; }
      }
      if (pos.length === 0) { min = [0, 0, 0]; max = [0, 0, 0]; }
      var pv = addView(pos, 34962), nv = addView(nrm, 34962), iv = addView(idx, 34963);
      var pa = json.accessors.push({ bufferView: pv, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: min, max: max }) - 1;
      var na = json.accessors.push({ bufferView: nv, componentType: 5126, count: nrm.length / 3, type: 'VEC3' }) - 1;
      var ia = json.accessors.push({ bufferView: iv, componentType: 5125, count: idx.length, type: 'SCALAR' }) - 1;
      var c = m.color || null;
      var mat = json.materials.push({
        name: m.name || ('solid_' + i),
        pbrMetallicRoughness: { baseColorFactor: c ? [c[0], c[1], c[2], 1] : [0.8, 0.8, 0.8, 1], metallicFactor: 0.1, roughnessFactor: 0.6 },
        doubleSided: true,
        extras: c ? undefined : { defaultColor: true }
      }) - 1;
      meshIdMap[i] = json.meshes.push({ name: m.name || ('solid_' + i), primitives: [{ attributes: { POSITION: pa, NORMAL: na }, indices: ia, material: mat }] }) - 1;
    });

    // ノード階層 (ルートは変換行列だけ持つラッパー)
    function addNode(t) {
      var n = { name: t.name || '' };
      var id = json.nodes.push(n) - 1;
      if (t.meshIndex != null && meshIdMap[t.meshIndex] != null) n.mesh = meshIdMap[t.meshIndex];
      if (t.children && t.children.length) n.children = t.children.map(addNode);
      return id;
    }
    json.nodes.push({ name: model.name || 'model', matrix: ROOT_MATRIX, extras: ROOT_EXTRAS });
    json.nodes[0].children = [addNode(model.root)];
    json.buffers.push({ byteLength: offset });

    var jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    var jsonPadded = pad4(jsonBytes.length);
    var total = 12 + 8 + jsonPadded + 8 + offset;
    var out = new Uint8Array(total), dv = new DataView(out.buffer);
    dv.setUint32(0, GLB_MAGIC, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jsonPadded, true); dv.setUint32(16, CHUNK_JSON, true);
    out.set(jsonBytes, 20);
    for (var p = 20 + jsonBytes.length; p < 20 + jsonPadded; p++) out[p] = 0x20; // JSON は空白でパディング
    var binStart = 20 + jsonPadded;
    dv.setUint32(binStart, offset, true); dv.setUint32(binStart + 4, CHUNK_BIN, true);
    var cur = binStart + 8;
    parts.forEach(function (b) { out.set(b, cur); cur += b.byteLength; });
    return out;
  }

  /* 読み込み: 自前で書いた GLB (および同等の単純な GLB) をモデル構造に戻す。
   * Fusion スクリプト (glbwrite.py) が書くものは
   *   - 同じメッシュを複数のノードから参照する (インスタンス化。ノードの matrix / translation / scale で位置を持つ)
   *   - 位置が int16 (KHR_mesh_quantization。translation / scale で戻す)
   *   - 法線が無い (ここで計算する)
   * ので、ノードを辿って **配置ごとに座標を焼き込んだメッシュ** を作る。ビューアの他の部分は今までどおり
   * 「1 ノード = 1 メッシュ = ワールド座標」で動く (ファイルだけ小さく、メモリ上は展開する)。 */
  function read(bytes) {
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('GLB ではありません');
    var len = dv.getUint32(8, true), p = 12, json = null, bin = null;
    while (p < len) {
      var clen = dv.getUint32(p, true), ctype = dv.getUint32(p + 4, true);
      var body = bytes.subarray(p + 8, p + 8 + clen);
      if (ctype === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body));
      else if (ctype === CHUNK_BIN) bin = body;
      p += 8 + clen;
    }
    if (!json || !bin) throw new Error('GLB のチャンクが不正です');

    function accessor(i) {
      var a = json.accessors[i], bv = json.bufferViews[a.bufferView];
      var comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
      var start = bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0);
      var n = a.count * comps;
      switch (a.componentType) {
        case 5126: return new Float32Array(bin.buffer.slice(start, start + n * 4));
        case 5125: return new Uint32Array(bin.buffer.slice(start, start + n * 4));
        case 5123: return new Uint32Array(new Uint16Array(bin.buffer.slice(start, start + n * 2)));
        case 5122: return new Float32Array(new Int16Array(bin.buffer.slice(start, start + n * 2)));   // 量子化した位置
        case 5121: return new Uint32Array(new Uint8Array(bin.buffer.slice(start, start + n)));
      }
      throw new Error('未対応の componentType ' + a.componentType);
    }

    // ファイル上のメッシュ (共有される元)。配置ごとに焼き込んだものは meshes に積む
    var srcMeshes = (json.meshes || []).map(function (m) {
      var pr = m.primitives[0], mat = pr.material != null ? json.materials[pr.material] : null;
      var bc = mat && mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorFactor;
      var isDefault = mat && mat.extras && mat.extras.defaultColor;
      var pos = accessor(pr.attributes.POSITION);
      var nrm = pr.attributes.NORMAL != null ? accessor(pr.attributes.NORMAL) : null;
      var idx = pr.indices != null ? accessor(pr.indices) : null;
      if (!idx) { idx = new Uint32Array(pos.length / 3); for (var i = 0; i < idx.length; i++) idx[i] = i; }
      return { name: m.name || '', positions: pos, normals: nrm, indices: idx, color: (bc && !isDefault) ? [bc[0], bc[1], bc[2]] : null, uses: 0 };
    });
    var meshes = [];

    function localMatrix(n) {
      if (n.matrix) return n.matrix.slice();
      if (!n.translation && !n.rotation && !n.scale) return null;
      var t = n.translation || [0, 0, 0], q = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
      var x = q[0], y = q[1], z = q[2], w = q[3];
      var xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
      // 列優先 (glTF)
      return [(1 - 2 * (yy + zz)) * s[0], (2 * (xy + wz)) * s[0], (2 * (xz - wy)) * s[0], 0,
              (2 * (xy - wz)) * s[1], (1 - 2 * (xx + zz)) * s[1], (2 * (yz + wx)) * s[1], 0,
              (2 * (xz + wy)) * s[2], (2 * (yz - wx)) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
              t[0], t[1], t[2], 1];
    }
    function mul(a, b) {   // a × b (列優先)
      var o = new Array(16);
      for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
      return o;
    }
    function isIdentity(m) {
      if (!m) return true;
      for (var i = 0; i < 16; i++) if (Math.abs(m[i] - ((i % 5) === 0 ? 1 : 0)) > 1e-12) return false;
      return true;
    }
    function bake(src, m) {
      if (isIdentity(m)) {
        if (src.uses++ === 0) { if (!src.normals) src.normals = computeNormals(src.positions, src.indices); return src; }
        return { name: src.name, positions: src.positions, normals: src.normals, indices: src.indices, color: src.color };
      }
      var p = src.positions, out = new Float32Array(p.length);
      for (var i = 0; i < p.length; i += 3) {
        var x = p[i], y = p[i + 1], z = p[i + 2];
        out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
        out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      }
      var nrm;
      if (src.normals) {
        var sn = src.normals; nrm = new Float32Array(sn.length);
        for (var k = 0; k < sn.length; k += 3) {
          var nx = m[0] * sn[k] + m[4] * sn[k + 1] + m[8] * sn[k + 2], ny = m[1] * sn[k] + m[5] * sn[k + 1] + m[9] * sn[k + 2], nz = m[2] * sn[k] + m[6] * sn[k + 1] + m[10] * sn[k + 2];
          var l = Math.hypot(nx, ny, nz) || 1; nrm[k] = nx / l; nrm[k + 1] = ny / l; nrm[k + 2] = nz / l;
        }
      } else nrm = computeNormals(out, src.indices);
      src.uses++;
      return { name: src.name, positions: out, normals: nrm, indices: src.indices, color: src.color };
    }

    function toTree(ni, parentM) {
      var n = json.nodes[ni], lm = localMatrix(n), wm = parentM ? (lm ? mul(parentM, lm) : parentM) : lm;
      var t = { name: n.name || '', meshIndex: null, children: [] };
      if (n.mesh != null && srcMeshes[n.mesh]) { meshes.push(bake(srcMeshes[n.mesh], wm)); t.meshIndex = meshes.length - 1; }
      (n.children || []).forEach(function (c) { t.children.push(toTree(c, wm)); });
      // glbwrite.py は量子化の戻しを名無しの子ノードに持たせる。ツリーでは 1 段にまとめる
      if (t.meshIndex == null && t.children.length === 1 && t.children[0].meshIndex != null && !t.children[0].children.length && !t.children[0].name) {
        t.meshIndex = t.children[0].meshIndex; t.children = [];
      }
      return t;
    }
    var sceneNodes = (json.scenes && json.scenes[json.scene || 0] || { nodes: [0] }).nodes;
    var first = json.nodes[sceneNodes[0]];
    var root, name;
    if (first.extras && first.extras.libraryViewer && first.children && first.children.length === 1) {
      root = toTree(first.children[0], null); name = first.name;     // ルートの Y-up 行列はファイルの約束事なので当てない
    } else {
      root = sceneNodes.length === 1 ? toTree(sceneNodes[0], null) : { name: 'model', meshIndex: null, children: sceneNodes.map(function (i) { return toTree(i, null); }) };
      name = root.name;
    }
    return { name: name, root: root, meshes: meshes };
  }

  function computeNormals(pos, idx) {
    var n = new Float32Array(pos.length);
    for (var i = 0; i < idx.length; i += 3) {
      var a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      var vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      n[a] += nx; n[a + 1] += ny; n[a + 2] += nz; n[b] += nx; n[b + 1] += ny; n[b + 2] += nz; n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
    }
    for (var k = 0; k < n.length; k += 3) {
      var l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1; n[k] /= l; n[k + 1] /= l; n[k + 2] /= l;
    }
    return n;
  }

  /* 組立位置を焼き込む。
   * Fusion は部品を「自分の原点」に置いた STEP として書き出すので、
   * アセンブリでの位置は meta.json の placement から復元する。
   * placement は行列ではなく **原点 + 3 軸** で持つ (行優先/列優先の取り違えが起きない)。
   *   p' = origin + x*px + y*py + z*pz     単位は mm
   * 法線は平行移動を無視して軸だけで回す (Fusion の配置は回転 + 平行移動で、拡大縮小はない)。 */
  function place(model, pl) {
    if (!model || !pl) return model;
    var o = pl.origin || [0, 0, 0], ax = pl.x || [1, 0, 0], ay = pl.y || [0, 1, 0], az = pl.z || [0, 0, 1];
    model.meshes.forEach(function (m) {
      var p = m.positions;
      for (var i = 0; i < p.length; i += 3) {
        var px = p[i], py = p[i + 1], pz = p[i + 2];
        p[i]     = o[0] + ax[0] * px + ay[0] * py + az[0] * pz;
        p[i + 1] = o[1] + ax[1] * px + ay[1] * py + az[1] * pz;
        p[i + 2] = o[2] + ax[2] * px + ay[2] * py + az[2] * pz;
      }
      var n = m.normals;
      if (!n) return;
      for (var k = 0; k < n.length; k += 3) {
        var nx = n[k], ny = n[k + 1], nz = n[k + 2];
        n[k]     = ax[0] * nx + ay[0] * ny + az[0] * nz;
        n[k + 1] = ax[1] * nx + ay[1] * ny + az[1] * nz;
        n[k + 2] = ax[2] * nx + ay[2] * ny + az[2] * nz;
      }
    });
    return model;
  }

  return { write: write, read: read, place: place };
})();
if (typeof module !== 'undefined') module.exports = GLB;
