# Library Viewer

設計者が Fusion で作った STEP を共有フォルダに集めて、**誰でもダブルクリックで 3D 表示**できる社内ツールです。
サーバーもインストールも不要。CAD データは PC の外に出ません。

![screenshot](docs/screenshot.png)

## 使う人（見るだけ）

1. 共有フォルダ（ライブラリ）にある `library-viewer.html` をダブルクリック（Chrome / Edge）
2. 「ライブラリを開く」で共有フォルダを選ぶ → 格納済みの装置が「ライブラリ」タブに並ぶ
3. 「開く」で 3D 表示。構成ツリーのチェックで部品の表示 / 非表示、クリックで選択、断面・半透明・エッジ表示
4. 複数の装置を「追加」で読み込むと、同名ユニットを右パネルで横断比較（← → キーで順送り）

STEP ファイルを直接ウィンドウにドロップしても見られます。

## 格納する人（設計者）

- **Fusion から**: `fusion/LibraryExport` をスクリプトとして登録 → 実行 → 案件情報を入力 → 格納。管理者の作業はありません
- **ビューアから**: STEP をドロップ → 「格納する」

詳細は [docs/ライブラリ運用.md](docs/ライブラリ運用.md)。

## 開発

```
npm install
npm run build            # → dist/library-viewer.html (約 4.7 MB)
npm run test:step        # STEP 生成と occt 読み込み確認
npm run test:glb         # GLB / ZIP の検証
node test/browser_test.mjs
node test/library_test.mjs
```

構成・制約は [CLAUDE.md](CLAUDE.md)、仕様は [docs/開発プロンプト.md](docs/開発プロンプト.md)。
