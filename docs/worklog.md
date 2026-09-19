# worklog

## 2026-09-19 初版

- `npx getdesign@latest add claude` で DESIGN.md を取得し、`src/app.css` の `:root` / `[data-theme="dark"]` に落とした
- occt-import-js 0.0.23 / three 0.128.0 を npm から取得。wasm 7.6MB → gzip 3.09MB → base64 3.92MB。ビルド結果 **4.70 MB**
- `tools/gen_test_step.py`: 直方体 / 3 部品 + サブアセンブリ (NAUO + CONTEXT_DEPENDENT_SHAPE_REPRESENTATION)。
  occt の `root` に `DEVICE_A → BASE_PLATE, ARM_UNIT(meshes [COLUMN, HEAD_UNIT])` と階層・名前が入ることを確認
  - 注意: occt-import-js はサブアセンブリ直下の葉部品を `node.meshes` に平坦化する。`Occt.toTree` で葉に展開
  - 注意: `attributes.position.array` が通常の Array で返る。GLB ライターで Float32Array に揃えた
- GLB: 2 チャンク・4 バイト境界・POSITION min/max・UNSIGNED_INT・階層ノード。ルートに Z-up mm → Y-up m の行列と `extras.libraryViewer`。
  `@gltf-transform/core` で名前・頂点数・bbox・色を確認。自前リーダーで往復確認
- ZIP: 格納方式 + bit 11。`unzip -t` OK、日本語フォルダ名 OK
- Playwright (`/opt/pw-browsers/chromium`) で `file://` から実機確認: 読み込み → 3 状態チェック → 開閉 → 検索 → 選択 → 横断 (+1 バッジ, ← →) → 半透明/断面/エッジ → ダーク/ライト → 格納 ZIP → 再変換
- File System Access API は偽ハンドルで置き換えて通し確認: 走査 → catalog.json → 未変換 STEP の自動変換と glb 書き戻し → 直接格納 → library.json → members.json
- Fusion スクリプト `fusion/LibraryExport/` を追加（ビューアと同じ階層プリセット・meta.json）。Fusion 実機では未検証

## 未検証 / 今後

- Fusion 実機でのスクリプト動作（`DataFile.fusionWebURL` が取れない環境では `source` から省かれるだけで格納は成功する）
- 大きい STEP（数万ソリッド）での変換時間。Web Worker 化は将来課題（初版は同期）
- 選択部品のツリー行ホバー連動は「ツリー → 3D」のみ。3D ホバー → ツリー行のハイライトは未実装

## 2026-09-19 ネーミングルールによる自動振り分け

- `src/js/03b-naming.js`: ファイル名 ⇔ 案件情報。既定 `{projectCode}_{deviceName}_{workpiece}_{department}_{owner}`
  - 区切りを含められるのは装置名だけ (左右を先に確定して残りを装置名に)。対象ワークのみ空を許す
  - Fusion の ` v3` と全角 `＿` を吸収。ルールは `library.json` の `naming` に入れて全員で共有
- ライブラリに `inbox/` を追加。置くだけ → 一覧に格納先を表示 → 「取り込む」で変換・格納・受信箱から削除。
  `inboxAuto` でライブラリを開いた時点の自動処理も可。ルール不一致のファイルは理由を出して残す
- 格納ダイアログ: ファイル名がルールに一致したら案件情報を事前入力。名簿にない担当者は「名簿に追加」バッジを出し、格納時に `members.json` へ追加
- `Store.buildPackage()` を純関数として切り出し、ダイアログと受信箱で共有 (3D シーンに依存しない)
- Fusion スクリプトにも同じ `naming_parse` / `naming_format` を実装。ドキュメント名からの事前入力と、書き出し STEP の命名に使う
  - ビューア側と同じ入力で同じ結果になることを Python 側でも突き合わせ確認
- テスト: 受信箱 3 件 (一致 2 / 不一致 1) → 取り込み → 階層・meta.json・members.json・受信箱の削除まで確認。
  ルールダイアログの検証と試し打ちも確認
  - 注意: Playwright の `setInputFiles` は非 ASCII のパスを渡せない。日本語ファイル名は `{name, buffer}` で渡す

## 2026-09-19 自宅（DirectCloud 無し）で開発できるようにする

- **前提の確認**: `file://` は Chrome / Edge で secure context。`showDirectoryPicker` / `showSaveFilePicker` /
  `DecompressionStream` / `indexedDB` / `localStorage` すべて使える (`npm run test:env`)。
  → 開発用に HTTP サーバーを立てる必要はない。DirectCloud かどうかもビューアには関係ない (ただのフォルダ)
- `tools/make_sample_library.mjs`: 実運用と同じ形の `sample-library/` を生成
  - 変換済み 2 件 (ユニット名を共有 → 横断比較が試せる) + 未変換 1 件 (初回変換の確認)
  - `inbox/` にルール一致 2 件 + 不一致 1 件、`sample-step/` にドロップ用 2 件、`library.json` / `members.json`
  - glb 生成には `src/js/02-glb.js` をそのまま require して使う (本番と同じコード)
- `tools/gen_test_step.py --assembly <path> <ルート名> [倍率]` を追加
- `test/sample_library_test.mjs`: 生成したサンプルをディスクから読んで偽ハンドルに流し込み、
  一覧 3 件・未変換フラグ・Fusion リンク・受信箱の判定・未変換エントリの変換と glb 書き戻し・横断一致 を確認
- `docs/自宅で開発する.md`: セットアップ、確認項目の表、会社でしか確認できないこと (Fusion 実機 / 同期の挙動 / 実物の STEP)
- npm scripts を整理: `build` / `sample` / `test` / `test:env`

## 2026-09-19 左右サイドバーの開閉

- `src/js/01b-panels.js`: ヘッダーのアイコンボタン / ビューポート端のハンドル / `[` `]` キーで開閉。
  状態は `lv.panels` に保存。`#main` の `--left-w` / `--right-w` を 0 にする方式
  （`display:none` にすると ResizeObserver が働かず 3D が追従しない）
- **畳んだ状態は尊重する。** 当初 `showLeftTab` で強制的に開いていたが、3D で部品を選ぶたびに
  サイドバーが戻ってきて邪魔だったので外した。テストで固定済み
- 初回のみ、窓幅 1200px 未満では右パネルを畳んだ状態で開く
- ヘッダーが狭い窓で 2 行に折り返していた問題も修正:
  1240px 未満でボタンのラベルを落としてアイコンのみ、1080px 未満でタイトル / ライブラリ状態 / HUD ヒントを隠す
  → 953px の窓で 56px 1 行に収まることを `test/panels_test.mjs` で確認
- 実測: 953x860 で左を畳むと 3D が 310px 広がる。両方畳むと 598px 分が 3D に回る

## 2026-09-19 計測モード

- `src/js/05c-measure.js`: 2 点間の距離と ΔX/ΔY/ΔZ。画面下にバー、3D 上に距離ラベル（HTML を投影位置に置く）
- スナップ: 自動 / 頂点 / エッジ / 面。自動は 頂点 14px → エッジ 10px → 面 の順。
  当たった三角形の 3 頂点と 3 辺をスクリーン距離で比べる。**B-rep が無いので円の中心は取れない**
- `Viewer3D` に `setPickHandler` / `toScreen` / `overlay` / `onRender` / `camera` を追加。
  計測中はクリックとホバーを横取りし、部品選択・ハイライトは走らせない
- ΔX/ΔY/ΔZ は破線で成分を描く（Fusion と同じく差の内訳が見えるように）。`computeLineDistances()` が要る
- M キーで切替、Escape は 1 回目で点をクリア・2 回目でモード終了
- 検証: 寸法が分かっている assembly.step（BASE_PLATE 300x200x20 / HEAD_UNIT 天面 z=330）で
  対角 360.56mm・ΔX300/ΔY200/ΔZ0、部品をまたぐ ΔZ=310、面スナップが z=330 ちょうど、頂点スナップが角に吸着、を確認
  - 注意: 角のちょうど上はシルエット際でレイが外れる。テストでは面の内側へ 9px 寄せてクリックしている

## 2026-09-19 サイドバー開閉時に画面が暗くなる問題

- 症状: 左右パネルを開閉するとアニメ中に画面が暗くちらつく
- 原因: `Viewer3D.resize()` が `renderer.setSize()` のあと `requestRender()` で次の rAF に描画を回していた。
  `setSize` は描画バッファを作り直して空にするため、その差のフレームが黒として合成される。
  ResizeObserver は rAF のあと・ペイントの前に走るので、**リサイズしたフレームは必ず黒**になり、
  0.18 秒のアニメ中は毎フレームそれが起きていた
- 計測: アプリより後に登録した ResizeObserver から `gl.readPixels` して確認
  - 修正前 5/5 のリサイズで `[0,0,0]` / 修正後 0/5（背景色 `[227,221,211]` が読める）
- 修正: `resize()` 内で `renderNow()` を呼び、同じフレームで描き切る。
  サイズが変わっていないときは早期 return して無駄な再描画もしない
- `test/panels_test.mjs` に黒フレーム 0 を確認する回帰テストを追加
