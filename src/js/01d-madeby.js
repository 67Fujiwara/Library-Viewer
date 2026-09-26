/* 「私が作りました」マーク。
 *
 *   ヘッダーの版 (v50) の代わりに、黒板を持った絵を出す。黒板には今の版を書き、顔の穴には
 *   ユーザーが選んだ画像を貼る。絵は build.py が src/assets/made-by-me.webp を埋め込む
 *   (顔の穴は tools/make_mark_asset.mjs で透明に抜いてある → 顔画像を下に敷いて、絵を上に重ねるだけ)。
 *   顔の画像は縮小して localStorage (`lv.face`) に置く。この PC のブラウザにだけ残り、外には送らない。
 *   出す / 出さないは設定 (歯車 → 表示 → 私が作りましたマーク、`lv.madeBy`)。出さないときは版の文字。
 */
var MadeBy = (function () {
  var KEY_ON = 'lv.madeBy', KEY_FACE = 'lv.face';
  var HOLE = { cx: 0.505, cy: 0.36, rx: 0.21, ry: 0.16 };     // 顔の穴 (絵の一辺に対する比。make_mark_asset.mjs と同じ楕円)
  var BOARD = { cx: 0.505, cy: 0.745 };                       // 黒板の中心
  var FACE_PX = 384;                                          // 保存する顔画像の一辺
  var base = null, face = null, btn, small, big, textEl, dialog, fileInput, chk;

  function loadImage(src) {
    return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = src; });
  }
  function enabled() { return Storage.get(KEY_ON, false) === true; }

  /* 絵 + 顔 + 黒板の文字を 1 枚に描く (ヘッダーの小さいのも、ダイアログの大きいのも同じ) */
  function draw(canvas) {
    if (!canvas || !base) return;
    var s = canvas.width, g = canvas.getContext('2d');
    g.clearRect(0, 0, s, s);
    if (face) {
      g.save();
      g.beginPath(); g.ellipse(HOLE.cx * s, HOLE.cy * s, HOLE.rx * s, HOLE.ry * s, 0, 0, Math.PI * 2); g.clip();
      // 楕円に cover で収める (縦横比は変えない)
      var w = HOLE.rx * 2 * s, h = HOLE.ry * 2 * s, k = Math.max(w / face.width, h / face.height);
      g.drawImage(face, HOLE.cx * s - face.width * k / 2, HOLE.cy * s - face.height * k / 2, face.width * k, face.height * k);
      g.restore();
    }
    g.drawImage(base, 0, 0, s, s);
    // 黒板: チョークで書いたように白く。版は大きく、名前は小さく
    g.save();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,0.93)';
    g.shadowColor = 'rgba(255,255,255,0.35)'; g.shadowBlur = s * 0.012;
    g.font = '500 ' + Math.round(s * 0.072) + 'px ' + cssVar('--font-sans');
    g.fillText('Library Viewer', BOARD.cx * s, (BOARD.cy - 0.075) * s);
    g.font = '600 ' + Math.round(s * 0.19) + 'px ' + cssVar('--font-mono');
    g.fillText('v' + APP_VERSION, BOARD.cx * s, (BOARD.cy + 0.055) * s);
    g.restore();
  }
  function render() { draw(small); if (dialog && dialog.open) draw(big); }

  function apply() {
    var on = enabled();
    btn.hidden = !on; textEl.hidden = on;
    if (chk) chk.checked = on;
    if (on) render();
  }
  function setEnabled(on) { Storage.set(KEY_ON, !!on); apply(); }

  /* 顔の画像: 縮小して正方形に (cover) → JPEG の data URL で保存 */
  function setFace(dataUrl) {
    if (!dataUrl) { face = null; Storage.remove(KEY_FACE); render(); return Promise.resolve(); }
    return loadImage(dataUrl).then(function (img) {
      var c = document.createElement('canvas'); c.width = c.height = FACE_PX;
      var g = c.getContext('2d'), k = Math.max(FACE_PX / img.width, FACE_PX / img.height);
      g.drawImage(img, (FACE_PX - img.width * k) / 2, (FACE_PX - img.height * k) / 2, img.width * k, img.height * k);
      var out = c.toDataURL('image/jpeg', 0.86);
      face = c;
      Storage.set(KEY_FACE, out);
      render();
    });
  }
  function pickFile(file) {
    if (!file) return;
    var r = new FileReader();
    r.onload = function () { setFace(String(r.result)).catch(function () { if (window.showMessage) showMessage('画像を読めません', file.name + ' は画像として開けませんでした。'); }); };
    r.readAsDataURL(file);
  }
  function openDialog() { draw(big); dialog.showModal(); }

  function init() {
    btn = $('#made-by'); small = btn.querySelector('canvas'); textEl = $('#ver-text');
    dialog = $('#made-by-dialog'); big = $('#made-by-big'); fileInput = $('#made-by-file'); chk = $('#chk-made-by');
    btn.addEventListener('click', openDialog);
    $('#made-by-pick').addEventListener('click', function () { fileInput.value = ''; fileInput.click(); });
    fileInput.addEventListener('change', function () { pickFile(fileInput.files && fileInput.files[0]); });
    $('#made-by-clear').addEventListener('click', function () { setFace(null); });
    chk.addEventListener('change', function () { setEnabled(chk.checked); });
    apply();
    // 絵と保存してある顔を読む (絵は埋め込みなので必ずある。顔は無ければ穴のまま)
    var saved = Storage.get(KEY_FACE, null);
    Promise.all([loadImage(MARK_IMG_SRC), saved ? loadImage(saved).catch(function () { return null; }) : Promise.resolve(null)])
      .then(function (r) { base = r[0]; face = r[1]; apply(); })
      .catch(function () { /* 絵が読めなければ版の文字のまま */ });
  }

  return { init: init, setEnabled: setEnabled, enabled: enabled, setFace: setFace, render: render, openDialog: openDialog,
    hasFace: function () { return !!face; } };
})();
