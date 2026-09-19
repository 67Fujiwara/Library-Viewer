/* ライト / ダーク: 判定基準は OS 設定ではなく時刻 (6:00〜18:00 ライト)。 */
var Theme = (function () {
  var KEY = 'lv.theme', mode = 'auto', current = null, listeners = [], timer = null;

  function byClock() { var h = new Date().getHours(); return (h >= 6 && h < 18) ? 'light' : 'dark'; }
  function resolve() { return mode === 'auto' ? byClock() : mode; }

  function apply(force) {
    var t = resolve();
    if (t === current && !force) return;
    current = t;
    document.documentElement.setAttribute('data-theme', t);
    listeners.forEach(function (fn) { fn(t); });
  }
  function setMode(m) {
    mode = m; Storage.set(KEY, m); apply();
  }
  function init() {
    mode = Storage.get(KEY, 'auto');
    if (['auto', 'light', 'dark'].indexOf(mode) < 0) mode = 'auto';
    var r = $('#theme-' + mode); if (r) r.checked = true;
    apply(true);
    $$('input[name="theme"]').forEach(function (i) { i.addEventListener('change', function () { if (i.checked) setMode(i.value); }); });
    // 初回描画ではトランジションを走らせない (2 フレーム後に有効化)
    nextFrames(2).then(function () { document.documentElement.classList.add('theme-anim'); });
    // 自動のときは 1 分ごとに時刻を確認し、境界をまたいだら切り替える
    timer = setInterval(function () { if (mode === 'auto') apply(); }, 60 * 1000);
  }
  return { init: init, onChange: function (fn) { listeners.push(fn); }, current: function () { return current; }, mode: function () { return mode; } };
})();
