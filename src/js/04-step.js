/* STEP 読み込み: Web Worker のプールで並列に変換する
 *
 * 計測して分かったこと (test/perf_test.mjs):
 *   - 時間の大半は STEP の解析と B-rep 構築で、メッシュ精度を極端に粗くしても速くならない
 *     (1.4MB / 150 部品: 極粗 4.2 秒 / 標準 3.7 秒 / 細かい 4.4 秒)
 *   - つまり「精度を下げて速くする」は効かない。効くのは (1) 複数ファイルの並列化
 *     (2) 一度変換した結果のキャッシュ (ConvCache: 3.7 秒 → 2 ミリ秒)
 *
 * WASM は 1 回だけ展開・コンパイルし、できた WebAssembly.Module を各ワーカーへ渡す
 * (file:// でも postMessage できることを確認済み)。ワーカーは blob URL から起こす。
 */
var Occt = (function () {
  var PRESETS = {
    coarse:   { label: '粗い（最軽量）', linearDeflection: 0.006,  angularDeflection: 1.0 },
    standard: { label: '標準',           linearDeflection: 0.0012, angularDeflection: 0.5 },
    fine:     { label: '細かい',         linearDeflection: 0.0003, angularDeflection: 0.25 }
  };
  /* 同時に動かすワーカー数。
   * 実測 (1.4MB / 150 部品の STEP、4 コア): 1 本 4.0 秒 / 2 本同時 7.3 秒 (throughput 1.09 倍) /
   * 3 本同時 11.7 秒 (1.05 倍)。素の JS の busy loop は 3 本で 2.96 倍出るので CPU の割り当てではなく、
   * OCC の B-rep 構築がメモリ帯域・アロケータ律速で並列に伸びない。
   * 本数を増やすと「最初の 1 件が出るまで」が遅くなるだけなので 2 本に抑える。 */
  var MAX_WORKERS = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
  var loading = null, wasmModule = null, workerURL = null;
  var pool = [], queue = [], nextId = 1;

  var HARNESS = [
    'var __occt = null;',
    'self.onmessage = function (e) {',
    '  var msg = e.data;',
    '  if (msg.type === "init") {',
    '    occtimportjs({ instantiateWasm: function (imports, success) {',
    '      WebAssembly.instantiate(msg.module, imports).then(function (inst) { success(inst, msg.module); });',
    '      return {};',
    '    } }).then(function (m) { __occt = m; self.postMessage({ type: "ready" }); },',
    '      function (err) { self.postMessage({ type: "fatal", message: String(err && err.message || err) }); });',
    '    return;',
    '  }',
    '  if (msg.type === "convert") {',
    '    try {',
    '      var r = __occt.ReadStepFile(new Uint8Array(msg.bytes), msg.params);',
    '      if (!r || !r.success) throw new Error("STEP の読み込みに失敗しました");',
    '      var transfer = [];',
    '      var meshes = r.meshes.map(function (m, i) {',
    '        var pos = Float32Array.from(m.attributes.position.array);',
    '        var nrm = (m.attributes.normal && m.attributes.normal.array) ? Float32Array.from(m.attributes.normal.array) : null;',
    '        var idx = Uint32Array.from(m.index.array);',
    '        transfer.push(pos.buffer, idx.buffer); if (nrm) transfer.push(nrm.buffer);',
    '        return { name: m.name || ("solid_" + i), positions: pos, normals: nrm, indices: idx,',
    '                 color: m.color ? [m.color[0], m.color[1], m.color[2]] : null };',
    '      });',
    '      self.postMessage({ type: "done", id: msg.id, root: r.root, meshes: meshes }, transfer);',
    '    } catch (err) {',
    '      self.postMessage({ type: "error", id: msg.id, message: String(err && err.message || err) });',
    '    }',
    '  }',
    '};'
  ].join('\n');

  function load() {
    if (loading) return loading;
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('このブラウザは DecompressionStream に対応していません。Windows の Chrome / Edge で開いてください。'));
    }
    if (typeof Worker === 'undefined') return Promise.reject(new Error('このブラウザは Web Worker に対応していません。'));
    loading = (async function () {
      var stream = new Blob([b64ToBytes(WASM_GZ_B64)]).stream().pipeThrough(new DecompressionStream('gzip'));
      var buf = await new Response(stream).arrayBuffer();
      WASM_GZ_B64 = null;                                  // 展開後は不要
      wasmModule = await WebAssembly.compile(buf);          // 1 回だけコンパイルして全ワーカーで共有
      var src = document.getElementById('occt-src').textContent;
      workerURL = URL.createObjectURL(new Blob([src + '\n' + HARNESS], { type: 'text/javascript' }));
      await spawn();                                        // 1 本目はここで立ち上げておく
      return true;
    })();
    return loading;
  }

  function spawn() {
    var rec = { w: new Worker(workerURL), ready: false, job: null };
    pool.push(rec);
    rec.w.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'ready') { rec.ready = true; if (rec.onReady) rec.onReady(); pump(); return; }
      if (m.type === 'fatal') { failAll(new Error(m.message)); return; }
      var job = rec.job;
      if (!job || job.id !== m.id) return;
      rec.job = null;
      if (m.type === 'done') job.resolve(buildModel(m, job.fallbackName));
      else job.reject(new Error(m.message));
      pump();
    };
    rec.w.onerror = function (ev) { failAll(new Error('変換ワーカーでエラーが発生しました: ' + (ev.message || ''))); };
    rec.w.postMessage({ type: 'init', module: wasmModule });
    return new Promise(function (res) { rec.onReady = res; });
  }
  function failAll(err) {
    queue.splice(0).forEach(function (j) { j.reject(err); });
    pool.forEach(function (r) { if (r.job) { r.job.reject(err); r.job = null; } });
  }

  function pump() {
    if (!queue.length) return;
    for (var i = 0; i < pool.length && queue.length; i++) {
      if (pool[i].ready && !pool[i].job) {
        var job = queue.shift();
        pool[i].job = job;
        pool[i].w.postMessage({ type: 'convert', id: job.id, bytes: job.bytes, params: job.params });
      }
    }
    // 待ちが残っていて、まだ増やせるならワーカーを足す (使う分だけ立てる)
    if (queue.length && pool.length < MAX_WORKERS) spawn();
  }

  /* occt の root (name, meshes[], children[]) → ビューア内部ツリー */
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
  function buildModel(m, fallbackName) {
    var meshes = m.meshes;
    var root = toTree(m.root, meshes);
    if (!root.name && root.children.length === 1 && root.meshIndex == null) root = root.children[0];
    if (!root.name) root.name = fallbackName || 'model';
    return { name: root.name, root: root, meshes: meshes };
  }

  /* bytes はワーカーへコピーで渡す (呼び出し側が再変換・格納のために原本を持ち続けるため) */
  async function convert(bytes, presetKey, fallbackName) {
    await load();
    var p = PRESETS[presetKey] || PRESETS.standard;
    return new Promise(function (resolve, reject) {
      queue.push({
        id: nextId++, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        params: { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: p.linearDeflection, angularDeflection: p.angularDeflection },
        fallbackName: fallbackName, resolve: resolve, reject: reject
      });
      pump();
    });
  }

  return { load: load, convert: convert, PRESETS: PRESETS, workers: function () { return pool.length; }, maxWorkers: MAX_WORKERS };
})();
