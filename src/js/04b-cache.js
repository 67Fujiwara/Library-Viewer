/* 変換キャッシュ
 *
 * STEP の解析は 1MB あたり数秒かかり、メッシュ精度を落としても速くならない (解析自体が重い)。
 * 一度変換した結果は自前の GLB にして IndexedDB に置き、同じファイルを開いたときは読み直す。
 * 実測: 1.4MB / 150 部品の STEP で 変換 3.7 秒 → キャッシュ 2 ミリ秒。
 *
 * 鍵はファイル名・サイズ・更新日時・精度。内容が変われば更新日時かサイズが変わるので当たらなくなる。
 */
var ConvCache = (function () {
  var STORE = 'conv', MAX_ENTRIES = 40, MAX_BYTES = 256 * 1024 * 1024;
  var enabled = true;

  function keyFor(file, preset) {
    return [file.name, file.size, file.lastModified || 0, preset].join('|');
  }
  async function get(file, preset) {
    if (!enabled) return null;
    try {
      var rec = await IDB.get(STORE, keyFor(file, preset));
      if (!rec || !rec.glb) return null;
      IDB.put(STORE, keyFor(file, preset), { glb: rec.glb, at: Date.now(), size: rec.glb.byteLength }).catch(function () { });
      return GLB.read(new Uint8Array(rec.glb));
    } catch (e) { enabled = false; return null; }
  }
  async function put(file, preset, model) {
    if (!enabled) return;
    try {
      var glb = GLB.write(model);
      await IDB.put(STORE, keyFor(file, preset), { glb: glb.buffer, at: Date.now(), size: glb.byteLength });
      trim();
    } catch (e) { /* 容量超過などは黙って諦める */ }
  }
  /* 古いものから消して、件数と合計サイズを抑える */
  async function trim() {
    try {
      var list = await IDB.entries(STORE);
      var total = list.reduce(function (s, r) { return s + (r.value.size || 0); }, 0);
      if (list.length <= MAX_ENTRIES && total <= MAX_BYTES) return;
      list.sort(function (a, b) { return (a.value.at || 0) - (b.value.at || 0); });
      while (list.length && (list.length > MAX_ENTRIES || total > MAX_BYTES)) {
        var victim = list.shift();
        total -= victim.value.size || 0;
        await IDB.del(STORE, victim.key);
      }
    } catch (e) { }
  }
  async function clear() {
    try {
      var list = await IDB.entries(STORE);
      for (var i = 0; i < list.length; i++) await IDB.del(STORE, list[i].key);
      return list.length;
    } catch (e) { return 0; }
  }
  async function stats() {
    try {
      var list = await IDB.entries(STORE);
      return { count: list.length, bytes: list.reduce(function (s, r) { return s + (r.value.size || 0); }, 0) };
    } catch (e) { return { count: 0, bytes: 0 }; }
  }
  return { get: get, put: put, clear: clear, stats: stats, keyFor: keyFor };
})();
