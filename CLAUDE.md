# Library Viewer

設計者が作った STEP ファイルを共有フォルダに集約し、誰でもブラウザだけで 3D 表示できる社内ツール。
CAD は Autodesk Fusion。**管理者レス**（フォルダに置いたものがそのまま一覧になる）で運用する。

成果物は `dist/library-viewer.html` **1 ファイルのみ**（ライブラリ・WASM 込み、5MB 以下）。
これをライブラリ（DirectCloud 同期フォルダ）のルートに置いて配布する。

詳細仕様: `docs/開発プロンプト.md` / 運用設計: `docs/ライブラリ運用.md` / 開発環境: `docs/自宅で開発する.md` / UI 基準: `DESIGN.md`

**開発に DirectCloud は要らない。** ビューアはローカルフォルダを File System Access API で開いているだけで、
DirectCloud かどうかは関係ない。`npm run sample` で実運用と同じ形のライブラリを手元に作れる。

## 絶対条件（設計の前提。ここを崩す提案はしない）

- **外部送信ゼロ。** CAD データは社外に出せない。fetch・CDN・解析・テレメトリを一切入れない
  （例外は「Fusion で開く」リンク。ユーザーが自分でクリックして Autodesk のページへ移動するだけで、データは送らない）
- **外部ファイル参照ゼロ。** `file://` からダブルクリックで開く。ES modules も fetch も使えない
- サーバーもバンドラも使わない。ビルドは `build.py` のテンプレート文字列置換だけ
- 対象は Windows の Chrome / Edge のみ
- **管理者レス。** ライブラリの真実はフォルダと各装置の `meta.json`。中央の一覧ファイルを人が保守する設計にしない
  （`catalog.json` はビューアが自動生成するキャッシュ。無くても動く）

## やってはいけないこと

- `<script type="module">` / `import` / `export` を書かない。**すべてクラシックスクリプト**
- three.js の `OrbitControls` と `GLTFExporter` を使わない（ES モジュール版しかない）。r128 の UMD を埋め込み、カメラ操作と GLB 書き出しは自前実装（`src/js/05-viewer.js`, `02-glb.js`）
- ZIP・GLB のためにライブラリを追加しない。`02-glb.js` / `03-zip.js` を使う
- `prefers-color-scheme` をテーマ分岐の条件に使わない（**判定基準は OS 設定ではなく時刻**）
- 色の値を JS 内に持たない。CSS カスタムプロパティを `getComputedStyle` で読む（`cssVar()`）
- `<div>` に onclick を付けない。`<button>` `<a>` `<input>`+`<label>` を使う
- 部品の選択・表示切替のたびに glb を生成しない（生成は「格納」を押したときと、ライブラリの未変換 STEP を開いたときだけ）
- ツリーのチェック操作でカメラを動かさない
- Fusion スクリプト (`fusion/LibraryExport/`) とビューアで、フォルダ階層プリセット・`meta.json` のスキーマ・**ネーミングルールの解析規則**を別々に変えない。必ず両方を同時に直す
  （`src/js/03b-naming.js` の `parse`/`format` と `LibraryExport.py` の `naming_parse`/`naming_format` は同じ規則）
- 格納するファイル群の組み立ては `Store.buildPackage()` に集約する。格納ダイアログと受信箱で別々に作らない

## 間違えやすい点

- 埋め込む JS に `</script>` という文字列が入ると HTML が壊れる。`build.py` が検査する
- WASM は gzip → base64 で埋め込み、`DecompressionStream('gzip')` で展開して `wasmBinary` に渡す。`wasmBinary` を渡せば `locateFile` は呼ばれない
- occt-import-js の `position.array` は **通常の Array** で返ることがある。型付き配列に揃えてから使う
- occt-import-js はサブアセンブリ直下の部品を `node.meshes` に平坦化して返す。`Occt.toTree` で葉として展開している
- ZIP のファイル名は日本語。汎用フラグ **bit 11 (0x0800)** を立てないと文字化けする
- テーマを切り替えても 3D シーンの色は自動で変わらない。`Viewer3D.applyTheme()` でクリアカラー / グリッド 2 色 / エッジ色 / 既定色 / 選択・ホバー色を更新する
- `localStorage` / IndexedDB は `file://` で失敗しうる。読み書きは必ず try/catch（`Storage`, `Library.saveHandle`）
- 変換前に 2 フレーム待たないとオーバーレイが描画されない（`nextFrames(2)`）
- `EdgesGeometry` は重い。初回 ON のときだけ生成する
- File System Access API のディレクトリハンドルは IndexedDB に保存できるが、次回は `requestPermission` にユーザー操作が要る
- ネーミングルールで区切り文字を含んでよいのは **装置名だけ**（左右の項目を先に確定し、残りを装置名にする）
- `inbox/` は装置フォルダの走査対象から外す（`SKIP_DIRS`）。取り込めたファイルだけ `removeEntry` で消す
- Playwright の `setInputFiles` は **非 ASCII のファイルパスを渡せない**。日本語ファイル名のテストは `{name, buffer}` 形式で渡す

## レイアウト（変更しない）

ヘッダー / 左パネル 310px（構成ツリー | ライブラリ の 2 タブ） / 中央 3D ビュー / 右横断パネル 288px / フッター（選択部品の情報バー）

## ファイル構成

```
build.py                 テンプレート置換ビルド → dist/library-viewer.html
src/template.html        HTML 骨格 ({{APP_CSS}} {{THREE_JS}} {{OCCT_JS}} {{WASM_GZ_B64}} {{APP_JS}})
src/app.css              トークン (DESIGN.md) と UI
src/js/00-util.js        DOM ヘルパ, Storage, nextFrames, cssVar
src/js/01-theme.js       時刻によるライト/ダーク
src/js/02-glb.js         GLB ライター/リーダー (node でも require 可)
src/js/03-zip.js         ZIP ライター (格納方式, UTF-8 フラグ)
src/js/03b-naming.js     ネーミングルール (ファイル名 ⇔ 案件情報)
src/js/04-step.js        occt-import-js のロードと STEP → 内部モデル
src/js/05-viewer.js      three.js シーン・カメラ・表示モード・断面・エッジ・ハイライト
src/js/06-tree.js        構成ツリー
src/js/07-crossref.js    案件横断 (名寄せ)
src/js/08-library.js     ライブラリ (フォルダ走査 / 受信箱 inbox / ルール / 書き込み / members.json / catalog.json)
src/js/09-store.js       格納ダイアログ (FS Access API または ZIP)
src/js/10-app.js         配線
fusion/LibraryExport/    Fusion 360 スクリプト (STEP + meta.json をライブラリに直接格納)
tools/gen_test_step.py   AP214 STEP テストデータ生成 (--assembly で名前・寸法を指定)
tools/make_sample_library.mjs  サンプルライブラリ生成 (models / inbox / 名簿まで一式)
test/read_step.mjs       occt が階層を返すか
test/test_glb_zip.mjs    GLB を gltf-transform で / ZIP を unzip で
test/browser_test.mjs    file:// 通しテスト (読み込み→ツリー→横断→格納→再変換→ルール事前入力)
test/library_test.mjs    FS Access API を偽ハンドルにして 走査→受信箱→格納→ルール→名簿
test/sample_library_test.mjs  生成したサンプルライブラリをビューアが読めるか
test/env_check.mjs       file:// / localhost で使える API の確認
```

## 検証のしかた

```
npm install          # occt-import-js, three@0.128, @gltf-transform/core, playwright
npm run build        # → dist/library-viewer.html (サイズを報告)
npm run sample       # → sample-library/ (手で確認するとき。--clean で作り直し)
npm test             # step → glb/zip → ブラウザ 3 本を通しで
npm run test:env     # file:// と localhost で使える API の確認
```

Playwright は `/opt/pw-browsers/chromium` の Chromium を `executablePath` で使う（`playwright install` はしない）。
`file://` は Chrome / Edge では secure context で、`showDirectoryPicker` も使える（`test:env` で確認済み）。
開発のために HTTP サーバーを立てる必要はない。

## 作業の進め方

- 完了報告の前に **ビルドしてブラウザテストを通す**。「書いただけ」で報告しない
- ビルド後に必ずファイルサイズを報告する（5MB 超は要相談）
- UI を書く前に `DESIGN.md` を読む。色・余白・角丸・影はトークンに従う
- 作業メモは `docs/worklog.md` に追記する（次のセッションで読む）
