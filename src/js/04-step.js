/* STEP 読み込み (occt-import-js / WASM をブラウザ内で展開) */
var Occt = (function () {
  var instance = null, loading = null;
  var PRESETS = {
    coarse:   { label: '粗い（最軽量）', linearDeflection: 0.006,  angularDeflection: 1.0 },
    standard: { label: '標準',           linearDeflection: 0.0012, angularDeflection: 0.5 },
    fine:     { label: '細かい',         linearDeflection: 0.0003, angularDeflection: 0.25 }
  };

  function load() {
    if (instance) return Promise.resolve(instance);
    if (loading) return loading;
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('このブラウザは DecompressionStream に対応していません。Windows の Chrome / Edge で開いてください。'));
    }
    loading = (async function () {
      var stream = new Blob([b64ToBytes(WASM_GZ_B64)]).stream().pipeThrough(new DecompressionStream('gzip'));
      var buf = await new Response(stream).arrayBuffer();
      WASM_GZ_B64 = null; // 展開後は不要
      instance = await occtimportjs({ wasmBinary: new Uint8Array(buf) });
      return instance;
    })();
    return loading;
  }

  /* occt の root (name, meshes[], children[]) → ビューア内部ツリー
   * ノード直下の meshes は葉として展開。子なし・メッシュ 1 つのノードはそれ自身を葉にする。 */
  function toTree(node, meshes) {
    var t = { name: node.name || '', meshIndex: null, children: [] };
    var kids = (node.children || []).map(function (c) { return toTree(c, meshes); });
    var ms = node.meshes || [];
    if (ms.length === 1 && kids.length === 0) {
      t.meshIndex = ms[0];
      if (!t.name) t.name = meshes[ms[0]].name || '';
    } else {
      ms.forEach(function (i) { kids.push({ name: meshes[i].name || ('solid_' + i), meshIndex: i, children: [] }); });
    }
    t.children = kids;
    return t;
  }

  async function convert(bytes, presetKey, fallbackName) {
    var occt = await load();
    var p = PRESETS[presetKey] || PRESETS.standard;
    var r = occt.ReadStepFile(bytes, { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: p.linearDeflection, angularDeflection: p.angularDeflection });
    if (!r || !r.success) throw new Error('STEP の読み込みに失敗しました');
    var meshes = r.meshes.map(function (m, i) {
      return {
        name: m.name || ('solid_' + i),
        positions: m.attributes.position.array instanceof Float32Array ? m.attributes.position.array : new Float32Array(m.attributes.position.array),
        normals: m.attributes.normal && m.attributes.normal.array ? (m.attributes.normal.array instanceof Float32Array ? m.attributes.normal.array : new Float32Array(m.attributes.normal.array)) : null,
        indices: m.index.array instanceof Uint32Array ? m.index.array : new Uint32Array(m.index.array),
        color: m.color ? [m.color[0], m.color[1], m.color[2]] : null
      };
    });
    // occt の root は名前なしのラッパー。子が 1 つならそれをルートにする
    var root = toTree(r.root, meshes);
    if (!root.name && root.children.length === 1 && root.meshIndex == null) root = root.children[0];
    if (!root.name) root.name = fallbackName || 'model';
    return { name: root.name, root: root, meshes: meshes };
  }

  return { load: load, convert: convert, PRESETS: PRESETS };
})();
