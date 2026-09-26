/* ディレクトリのタグ。
 *
 * ツリーの整理と同じで **ビューア側の情報**。ディスク上のファイルは触らない。
 * フォルダのパス ("設計1課/P2026-001_検査装置A") を鍵に localStorage へ持つので、
 * 同じフォルダをもう一度読み込めばタグも戻る (閉じても消さない)。
 * 改名・移動でパスが変わるときは Tree.repath() が付け替える。
 */
var Tags = (function () {
  var KEY = 'lv.folderTags';
  var MAX_PATHS = 500, MAX_PER_PATH = 12, MAX_LEN = 24;
  var map = Storage.get(KEY, null) || {};

  /* 検索用に畳む: 全角半角と大文字小文字を無視する */
  function fold(s) { return String(s == null ? '' : s).normalize('NFKC').toLowerCase(); }
  /* 入力文字列 → タグの配列。区切りは カンマ・読点・空白 (タグ自体に空白は入れられない) */
  function parse(str) {
    return String(str || '').split(/[,、\s]+/).map(function (t) {
      return t.normalize('NFKC').trim().slice(0, MAX_LEN);
    }).filter(Boolean);
  }
  function uniq(list) {
    var seen = {}, out = [];
    list.forEach(function (t) { var k = fold(t); if (!seen[k]) { seen[k] = 1; out.push(t); } });
    return out.slice(0, MAX_PER_PATH);
  }
  function save() {
    // 古い鍵が溜まり続けないように上限で打ち切る (入れた順に残す)
    var keys = Object.keys(map);
    if (keys.length > MAX_PATHS) keys.slice(0, keys.length - MAX_PATHS).forEach(function (k) { delete map[k]; });
    Storage.set(KEY, map);
  }

  function get(key) { return (map[key] || []).slice(); }
  function set(key, list) {
    var tags = uniq(Array.isArray(list) ? list.map(function (t) { return String(t).trim(); }).filter(Boolean) : parse(list));
    if (tags.length) map[key] = tags; else delete map[key];
    save();
    return tags;
  }
  function has(key) { return !!(map[key] && map[key].length); }

  /* 畳んだ問い合わせ文字列に当たるタグを 1 つ返す (当たらなければ null) */
  function hit(key, folded) {
    if (!folded) return null;
    var list = map[key] || [];
    for (var i = 0; i < list.length; i++) if (fold(list[i]).indexOf(folded) >= 0) return list[i];
    return null;
  }

  /* prefix で始まる鍵 (= その装置の行) に付いたタグのうち、畳んだ問い合わせに当たる最初の 1 つ。
   * 読み込んでいない装置を検索でタグから当てるのに使う (行の鍵は '@<保存先>/<階層>' で残っている) */
  function hitUnder(prefix, folded) {
    if (!folded) return null;
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(prefix) !== 0) continue;
      var t = hit(keys[i], folded);
      if (t) return t;
    }
    return null;
  }
  /* prefix で始まる鍵に付いたタグを全部 (重複なし)。ライブラリのカードに「付いているタグ」を出す */
  function under(prefix) {
    var out = [], seen = {};
    Object.keys(map).forEach(function (k) {
      if (k.indexOf(prefix) !== 0) return;
      map[k].forEach(function (t) { var f = fold(t); if (!seen[f]) { seen[f] = 1; out.push(t); } });
    });
    return out;
  }

  /* 畳んだタグの集合 ({畳んだ形: 1}) と共通のタグを持つ鍵をすべて返す ([{key, tag}])。
   * 案件横断が「同じタグの行」を探すのに使う (読み込んでいない装置の行も鍵で残っている) */
  function withAny(foldedSet) {
    var out = [];
    if (!foldedSet) return out;
    Object.keys(map).forEach(function (k) {
      var list = map[k];
      for (var i = 0; i < list.length; i++) if (foldedSet[fold(list[i])]) { out.push({ key: k, tag: list[i] }); return; }
    });
    return out;
  }

  /* 使われているタグを件数の多い順に (タグの候補として出す) */
  function all() {
    var count = {}, disp = {};
    Object.keys(map).forEach(function (k) {
      map[k].forEach(function (t) { var f = fold(t); count[f] = (count[f] || 0) + 1; disp[f] = disp[f] || t; });
    });
    return Object.keys(count).map(function (f) { return { tag: disp[f], count: count[f] }; })
      .sort(function (a, b) { return b.count - a.count || a.tag.localeCompare(b.tag, 'ja'); });
  }

  /* 改名・移動: oldKey とその配下をまとめて付け替える */
  function repath(oldKey, newKey) {
    var out = {};
    Object.keys(map).forEach(function (k) {
      if (k === oldKey) out[newKey] = map[k];
      else if (k.indexOf(oldKey + '/') === 0) out[newKey + k.slice(oldKey.length)] = map[k];
      else out[k] = map[k];
    });
    map = out; save();
  }
  function removeUnder(key) {
    Object.keys(map).forEach(function (k) { if (k === key || k.indexOf(key + '/') === 0) delete map[k]; });
    save();
  }
  function clear() { map = {}; save(); }

  return { fold: fold, parse: parse, get: get, set: set, has: has, hit: hit, hitUnder: hitUnder, under: under, withAny: withAny, all: all, repath: repath, removeUnder: removeUnder, clear: clear };
})();
