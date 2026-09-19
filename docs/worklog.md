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
