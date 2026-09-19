/* 左右サイドバーの開閉。状態は localStorage に保存 (file:// で失敗しうるので Storage 経由)。
 * 3D は ResizeObserver で追従するのでここでは幅だけ変える。 */
var Panels = (function () {
  var KEY = 'lv.panels', state = { left: true, right: true }, listeners = [];

  function apply(anim) {
    if (anim) document.documentElement.classList.add('panel-anim');
    document.body.classList.toggle('left-collapsed', !state.left);
    document.body.classList.toggle('right-collapsed', !state.right);
    $('#btn-toggle-left').setAttribute('aria-pressed', String(state.left));
    $('#btn-toggle-right').setAttribute('aria-pressed', String(state.right));
    $('#edge-left').hidden = state.left;
    $('#edge-right').hidden = state.right;
  }
  function set(side, open) {
    state[side] = open;
    Storage.set(KEY, state);
    apply(true);
  }
  function toggle(side) { set(side, !state[side]); }
  /* ユーザー自身が開閉したときだけ呼ぶ (検索が自動で開けた分と区別するため) */
  function userSet(side, open) { set(side, open); listeners.forEach(function (fn) { fn(side, open); }); }

  function init() {
    var saved = Storage.get(KEY, null);
    if (saved && typeof saved.left === 'boolean') state = { left: saved.left, right: saved.right !== false };
    else if (window.innerWidth < 1200) state.right = false;   // 初回だけ: 狭い窓では右を畳んでおく
    apply(false);
    $('#btn-toggle-left').addEventListener('click', function () { userSet('left', !state.left); });
    $('#btn-toggle-right').addEventListener('click', function () { userSet('right', !state.right); });
    $('#edge-left').addEventListener('click', function () { userSet('left', true); });
    $('#edge-right').addEventListener('click', function () { userSet('right', true); });
  }
  // 3D で部品を選んだときなどに勝手に開かないこと。畳んだ状態はユーザーの意思として尊重する
  return {
    init: init, toggle: function (s) { userSet(s, !state[s]); }, set: set, isOpen: function (s) { return state[s]; },
    onUserToggle: function (fn) { listeners.push(fn); }
  };
})();
