/* ネーミングルール: ファイル名から案件情報を取り出す / 案件情報からファイル名を作る
 *   既定: {projectCode}_{deviceName}_{workpiece}_{department}_{owner}
 *   例:   P2026-001_検査装置A_ワークX_設計1課_山田.step
 * 装置名だけは区切り文字を含んでよい (左右の項目を先に確定し、残りをすべて装置名にする)。
 * ルールは library.json の naming に保存し、ビューアと Fusion スクリプトで共有する。 */
var Naming = (function () {
  var FIELDS = { projectCode: '案件コード', deviceName: '装置名', workpiece: '対象ワーク', department: '部署', owner: '担当者' };
  var DEFAULT = { pattern: '{projectCode}_{deviceName}_{workpiece}_{department}_{owner}', separator: '_' };
  var GREEDY = 'deviceName';
  var KEY = 'lv.naming';

  function fieldsOf(rule) {
    var sep = rule.separator || '_';
    var parts = String(rule.pattern || '').split(sep), out = [];
    for (var i = 0; i < parts.length; i++) {
      var m = /^\{(\w+)\}$/.exec(parts[i].trim());
      if (!m || !FIELDS[m[1]]) return null;
      out.push(m[1]);
    }
    return out.length ? out : null;
  }
  function validate(rule) {
    var f = fieldsOf(rule);
    if (!f) return 'パターンは {項目} を区切り文字でつないだ形にしてください';
    if (f.indexOf('projectCode') < 0 || f.indexOf('deviceName') < 0) return '{projectCode} と {deviceName} は必須です';
    var seen = {}; for (var i = 0; i < f.length; i++) { if (seen[f[i]]) return '{' + f[i] + '} が重複しています'; seen[f[i]] = 1; }
    return null;
  }

  /* ファイル名 → {projectCode, deviceName, workpiece, department, owner} | null */
  function parse(filename, rule) {
    rule = rule || current();
    var fields = fieldsOf(rule); if (!fields) return null;
    var sep = rule.separator || '_';
    var base = String(filename).replace(/\.(step|stp|glb)$/i, '').replace(/\s+v\d+$/i, '').trim();   // Fusion の " v3" は落とす
    if (sep === '_') base = base.replace(/＿/g, '_');
    var parts = base.split(sep).map(function (s) { return s.trim(); });
    if (parts.length < fields.length) return null;
    var gi = fields.indexOf(GREEDY); if (gi < 0) gi = fields.length - 1;
    var out = {}, i;
    for (i = 0; i < gi; i++) out[fields[i]] = parts[i];
    var after = fields.length - gi - 1;
    for (i = 0; i < after; i++) out[fields[fields.length - 1 - i]] = parts[parts.length - 1 - i];
    out[fields[gi]] = parts.slice(gi, parts.length - after).join(sep);
    for (var k in out) if (!out[k] && k !== 'workpiece') return null;   // 対象ワーク以外は空を許さない
    return out;
  }
  /* 案件情報 → ファイル名 (拡張子なし) */
  function format(v, rule) {
    rule = rule || current();
    var fields = fieldsOf(rule) || fieldsOf(DEFAULT), sep = rule.separator || '_';
    return fields.map(function (f) { return sanitizeSegment(v[f] || '').replace(new RegExp(sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), f === GREEDY ? sep : '-'); }).join(sep);
  }
  function example(rule) {
    return format({ projectCode: 'P2026-001', deviceName: '検査装置A', workpiece: 'ワークX', department: '設計1課', owner: '山田' }, rule) + '.step';
  }
  function describe(rule) {
    var f = fieldsOf(rule || current()); if (!f) return '';
    return f.map(function (k) { return FIELDS[k]; }).join((rule || current()).separator || '_');
  }
  /* 現在のルール: ライブラリ (library.json) > この PC の設定 > 既定 */
  function current() {
    var cfg = (typeof Library !== 'undefined') ? Library.config() : null;
    if (cfg && cfg.naming && !validate(cfg.naming)) return cfg.naming;
    var local = Storage.get(KEY, null);
    if (local && !validate(local)) return local;
    return DEFAULT;
  }
  function saveLocal(rule) { Storage.set(KEY, rule); }
  return { FIELDS: FIELDS, DEFAULT: DEFAULT, parse: parse, format: format, example: example, describe: describe, validate: validate, current: current, saveLocal: saveLocal };
})();
if (typeof module !== 'undefined') module.exports = Naming;
