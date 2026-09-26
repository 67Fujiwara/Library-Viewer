/* 設定は 1 か所に集める。左下の歯車から上に開く小さなパネル。
 * 中身の実体 (テーマ・精度・非表示の薄さ) は今までどおり各モジュールが
 * `input` を拾っているだけで、ここは置き場所と開け閉めだけを持つ。 */
var Settings = (function () {
  var KEEP_STEP = 'lv.keepStep';
  var menu, btn, open = false;

  function init() {
    menu = $('#settings-menu'); btn = $('#btn-settings');
    btn.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    // パネルの外を押したら閉じる (中のボタンやセレクトでは閉じない)
    document.addEventListener('click', function (e) {
      if (!open) return;
      if (e.target.closest('#settings-menu') || e.target.closest('#btn-settings')) return;
      set(false);
    });
    // ダイアログを開くものは、開いたら設定パネルを畳む
    ['#btn-roster', '#btn-rules', '#btn-clear-cache', '#btn-filters'].forEach(function (sel) {
      $(sel).addEventListener('click', function () { set(false); });
    });
    $('#btn-clear-cache').addEventListener('click', function () { App.clearCache(); });
    var keep = $('#chk-keep-step');
    keep.checked = Storage.get(KEEP_STEP, false) === true;
    keep.addEventListener('change', function () { Storage.set(KEEP_STEP, keep.checked); });
    $('#btn-lib-home').addEventListener('click', function () {
      set(false);
      if (!Panels.isOpen('left')) Panels.set('left', true);
      App.showLeftTab('lib');
      var home = $('#lib-home');
      if (home && !home.hidden) home.scrollIntoView({ block: 'nearest' });
    });
  }
  function set(v) {
    open = v;
    menu.hidden = !v;
    btn.setAttribute('aria-expanded', String(v));
  }
  function toggle() { set(!open); }

  /* 共有フォルダに STEP を残すか。既定は残さない (glb を gzip すれば容量は 1/22。
   * STEP のマスターは Fusion のクラウドにある) */
  function keepStep() { return Storage.get(KEEP_STEP, false) === true; }

  return { init: init, open: function () { set(true); }, close: function () { set(false); }, toggle: toggle,
    isOpen: function () { return open; }, keepStep: keepStep };
})();
