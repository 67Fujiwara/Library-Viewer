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
- 計測中に部品を選択しない。3D のクリックは `Viewer3D.setPickHandler()` で計測へ横取りする（二重に扱わない）
- 装置を消す・再メッシュするときは `Measure.clear()` を呼ぶ（無くなった形状を指した計測を残さない）
- ツリーのチェック操作でカメラを動かさない
- **フォルダから読むのは `.step` / `.stp` だけ。** 他の拡張子は読み込まず、件数だけ知らせる
  (`#load-note`)。`.glb` を読むのは「ファイルを開く」とライブラリからのときだけ
- 案件横断のカード移動は **角度を変えない**（`Viewer3D.fitNode` / `moveToNode`）。
  回り込むのは「この部品に寄る」（`focusNode`）だけ。この 2 つを 1 つの関数にまとめない
- Fusion スクリプト (`fusion/LibraryExport/`) とビューアで、フォルダ階層プリセット・`meta.json` のスキーマ・**ネーミングルールの解析規則**を別々に変えない。必ず両方を同時に直す
  （`src/js/03b-naming.js` の `parse`/`format` と `LibraryExport.py` の `naming_parse`/`naming_format` は同じ規則）
- 格納するファイル群の組み立ては `Store.buildPackage()` に集約する。格納ダイアログと受信箱で別々に作らない
- **共有フォルダを消す操作は必ず `showConfirm()` で確認を取る。** 何が消えるか（パス・ファイル一覧・格納者）を
  本文に出す。ツリーの × は表示から外すだけでファイルは消さない（この 2 つを混同しない）

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
- 中身のあるディレクトリは `removeEntry(name, { recursive: true })` でないと消せない。
  削除後は空になった親フォルダも `models/` の 1 つ下まで遡って片づける（空フォルダを残さない）
- ネーミングルールで区切り文字を含んでよいのは **装置名だけ**（左右の項目を先に確定し、残りを装置名にする）
- `inbox/` は装置フォルダの走査対象から外す（`SKIP_DIRS`）。取り込めたファイルだけ `removeEntry` で消す
- Playwright の `setInputFiles` は **非 ASCII のファイルパスを渡せない**。日本語ファイル名のテストは `{name, buffer}` 形式で渡す
  （フォルダのテストは `webkitRelativePath` を付けた `File` を `DataTransfer` 経由で `#dir-input` に流し込む）
- ドロップされた `DataTransferItem` は **ハンドラを抜けると無効になる**。`getAsFileSystemHandle()` /
  `webkitGetAsEntry()` は同期のうちに呼び、Promise だけを持ち越す
- ツリーの装置行 (depth 0) のラベルは `device.name` = **ファイル名**。STEP 内部のルート名は
  同名 (BOX など) が並んで区別できないので使わない。STEP 内の名称はツールチップに出す
- フォルダの id は `'g:' + パス` なので、**改名・移動でフォルダの id が変わる**。
  `repath()` が選択中の行 (`focusedId`) と `collapsedGroups` も付け替える。ここを忘れると
  「フォルダを作った直後にその中へ作れない」といった不具合になる
- ツリー内のドラッグは `dataTransfer` に `application/x-lv-node` を載せる。
  window 側のファイル読み込みドロップはこの型があるとき何もしない (二重処理を防ぐ)
- 計測は B-rep を持たないメッシュから拾うが、**精度は落ちない**。
  OpenCASCADE のメッシュ節点は元の曲面上に厳密に乗っている（粗い設定でも分割数が減るだけ）ため、
  円形の境界ループに円を当てはめれば中心・径は公称値と一致する。
  実測: 穴中心間距離の誤差は 粗い 2.5e-6 mm / 標準 0 mm / 細かい 1.2e-6 mm（`test/measure_test.mjs`）
  - **STEP を直接読む方式は採らない。** 理由は精度ではなく (1) アセンブリの座標変換チェーンを
    自前で再現する必要があり間違えやすい (2) ライブラリから glb を開いたときに STEP が手元に無い
  - 唯一の誤差源は座標を float32 で持っていること（約 3e-6 mm）。これで十分なので倍精度は持たない
- 計測の線・点は `Viewer3D.overlay()` に入れ、`depthTest: false` で常に手前に描く。
  `LineDashedMaterial` は `computeLineDistances()` を呼ばないと破線にならない
- テストで角をクリックするときはシルエット際でレイが外れる。面の内側へ数 px 寄せる（`clickWorld` の inset）
- 「この部品に寄る」の遮蔽判定は、**カメラを向いている面だけを分母にする**。
  閉じた立体は標本点の半分が裏側なので、全点を分母にすると遮る物が無くても 0.5 止まりになり
  しきい値が意味を持たなくなる（実測で判明）
- **リサイズ後は同じフレーム内で描き切る**（`Viewer3D.resize()` → `renderNow()`）。
  `setSize` は描画バッファを空にするので、`requestRender()` で次の rAF に回すとそのフレームが
  黒く合成される。サイドバーの開閉アニメ中はこれが毎フレーム起きて画面が暗く見えた
  （`test/panels_test.mjs` が `readPixels` で黒フレーム 0 を確認している）

## レイアウト（構成は変更しない）

ヘッダー / 左パネル 310px（構成ツリー | ライブラリ の 2 タブ） / 中央 3D ビュー / 右横断パネル 288px / フッター（選択部品の情報バー）

ツリーは編集できる (VS Code のエクスプローラに合わせた操作)。
ドロップした STEP は最初みな同じ階層に並ぶので、フォルダを作って好きな構成に組み替えられる。
- 新規フォルダはツールバーのアイコン / 右クリック。**選んでいるフォルダの中**に作り、その場で改名できる
- `F2` または右クリック → 名前の変更。行がそのまま入力欄になる (Enter 確定 / Esc 取り消し)
- 行をドラッグしてフォルダへドロップで移動。空白へ落とすと最上位へ。自分の中へは入れられない
- `Delete` または右クリック → 閉じる。フォルダは「解除」で中身を親へ上げられる
- 空のフォルダも残す (`folderPaths` に登録されているため)。並びは VS Code と同じくフォルダが先
- **これはビューア上の整理だけで、ディスク上のファイルは動かさない**

ツリーは 2 段構え: フォルダから読み込んだときは **フォルダのグループ行** → 装置 → 部品 の順に入れ子になる。
グループ行は `Tree.buildForest()` が `device.groupPath` から毎回組み立て直す（`nodesById` に混ぜるので
チェックの 3 状態・ソロ・検索・開閉はそのまま効く）。グループの行をクリックすると開閉する（選択はしない。
`CrossRef` や footer が `node.device` を前提にしているため）。

左右のパネルは畳める（`src/js/01b-panels.js`、ヘッダーのアイコン・端のハンドル・`[` `]` キー、状態は localStorage）。
- **畳んだ状態は尊重する。** 3D での部品選択やライブラリからの読み込みで勝手に開き直さない
- 幅は `#main` の `--left-w` / `--right-w` で 0 にする。`display:none` にしない（ResizeObserver で 3D が追従できなくなる）
- 初回のみ、窓幅 1200px 未満なら右パネルを畳んだ状態で開く（保存された設定があればそちらが優先）
- 窓が狭いときはヘッダーのラベルを落としてアイコンだけにする（折り返して 2 行にしない）

## ファイル構成

```
build.py                 テンプレート置換ビルド → dist/library-viewer.html
src/template.html        HTML 骨格 ({{APP_CSS}} {{THREE_JS}} {{OCCT_JS}} {{WASM_GZ_B64}} {{APP_JS}})
src/app.css              トークン (DESIGN.md) と UI
src/js/00-util.js        DOM ヘルパ, Storage, nextFrames, cssVar
src/js/01-theme.js       時刻によるライト/ダーク
src/js/01b-panels.js     左右サイドバーの開閉
src/js/02-glb.js         GLB ライター/リーダー (node でも require 可)
src/js/03-zip.js         ZIP ライター (格納方式, UTF-8 フラグ)
src/js/03b-naming.js     ネーミングルール (ファイル名 ⇔ 案件情報)
src/js/04-step.js        occt-import-js のロードと STEP → 内部モデル
src/js/05-viewer.js      three.js シーン・カメラ・表示モード・断面・エッジ・ハイライト
src/js/05b-circle.js     メッシュからの円検出 (穴・丸軸の中心と径)
src/js/05c-measure.js    計測モード (距離 / 角度、頂点・円・エッジ・面スナップ)
src/js/06-tree.js        構成ツリー (フォルダのグループ行・フォルダ登録・移動/改名の実体)
src/js/06b-treeedit.js   ツリーの編集 UI (新規フォルダ・F2 改名・ドラッグ移動・右クリックメニュー)
src/js/07-crossref.js    案件横断 (名寄せ)
src/js/08-library.js     ライブラリ (フォルダ走査 / 受信箱 inbox / ルール / 書き込み / members.json / catalog.json)
src/js/09-store.js       格納ダイアログ (FS Access API または ZIP)
src/js/10-app.js         配線
fusion/LibraryExport/    Fusion 360 スクリプト (STEP + meta.json をライブラリに直接格納)
tools/gen_test_step.py   AP214 STEP テストデータ生成 (箱 / 階層アセンブリ / 穴あき板 / 遮蔽の検証用)
tools/make_sample_library.mjs  サンプルライブラリ生成 (models / inbox / 名簿まで一式)
test/read_step.mjs       occt が階層を返すか
test/test_glb_zip.mjs    GLB を gltf-transform で / ZIP を unzip で
test/browser_test.mjs    file:// 通しテスト (読み込み→ツリー→横断→格納→再変換→ルール事前入力)
test/library_test.mjs    FS Access API を偽ハンドルにして 走査→受信箱→格納→ルール→名簿
test/sample_library_test.mjs  生成したサンプルライブラリをビューアが読めるか
test/panels_test.mjs     サイドバー開閉 (953px の窓で: 折りたたみ / 復元 / キー / 3D の追従)
test/measure_test.mjs    計測 (寸法既知の STEP でスナップ位置・距離・ΔXYZ・穴中心・角度を検証)
test/focus_test.mjs      「この部品に寄る」(隠れている部品へ回り込む / 見えていれば角度を保つ)
test/folder_test.mjs     フォルダ読み込み (STEP だけ拾う / 階層をツリーに再現 / ドロップ 2 経路)
test/treeedit_test.mjs   ツリーの編集 (フォルダ作成 / ドラッグ移動 / F2 改名 / 右クリック / 解除)
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
