/* IndexedDB の口を 1 つにまとめる。
 * ライブラリのフォルダハンドルと変換キャッシュで同じ DB を使うので、
 * バージョンとストアの定義はここだけに置く (別々に open するとバージョン衝突で固まる)。
 * file:// では失敗しうるので、呼び出し側は必ず catch すること。 */
var IDB = (function () {
  var NAME = 'library-viewer', VERSION = 3, STORES = { handles: {}, conv: { keyPath: null }, cat: { keyPath: null } };
  var opening = null;

  function open() {
    if (opening) return opening;
    opening = new Promise(function (res, rej) {
      var r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
        if (!db.objectStoreNames.contains('conv')) db.createObjectStore('conv');
        if (!db.objectStoreNames.contains('cat')) db.createObjectStore('cat');   // ライブラリ一覧の差分スキャン用
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
      r.onblocked = function () { rej(new Error('IndexedDB blocked')); };
    });
    opening.catch(function () { opening = null; });
    return opening;
  }
  function get(store, key) {
    return open().then(function (db) {
      return new Promise(function (res) {
        var g = db.transaction(store, 'readonly').objectStore(store).get(key);
        g.onsuccess = function () { res(g.result); }; g.onerror = function () { res(undefined); };
      });
    });
  }
  function put(store, key, value) {
    return open().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = function () { res(true); }; tx.onerror = function () { res(false); }; tx.onabort = function () { res(false); };
      });
    });
  }
  function del(store, key) {
    return open().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = function () { res(true); }; tx.onerror = function () { res(false); };
      });
    });
  }
  /* まとめて書く。1 件ずつ put すると件数分のトランザクション (= ディスクへの flush) になる
   * (実測: 1000 件で 600ms → 1 本なら 30ms)。走査の控えはこれで書く */
  function batch(store, puts, dels) {
    return open().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(store, 'readwrite'), os = tx.objectStore(store);
        (puts || []).forEach(function (p) { os.put(p.value, p.key); });
        (dels || []).forEach(function (k) { os.delete(k); });
        tx.oncomplete = function () { res(true); }; tx.onerror = function () { res(false); }; tx.onabort = function () { res(false); };
      });
    });
  }
  function entries(store) {
    return open().then(function (db) {
      return new Promise(function (res) {
        var out = [], c = db.transaction(store, 'readonly').objectStore(store).openCursor();
        c.onsuccess = function () {
          var cur = c.result;
          if (!cur) { res(out); return; }
          out.push({ key: cur.key, value: cur.value });
          cur.continue();
        };
        c.onerror = function () { res(out); };
      });
    });
  }
  return { open: open, get: get, put: put, del: del, batch: batch, entries: entries, STORES: STORES };
})();
