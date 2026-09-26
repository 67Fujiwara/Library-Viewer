/* サンプルライブラリ生成 — 自宅など DirectCloud の無い環境で開発 / 動作確認するためのツール。
 *
 *   node tools/make_sample_library.mjs [出力先] [--clean]
 *
 * ビューアが実運用で見るのと同じ形のフォルダを手元に作ります。
 * DirectCloud は「同期されたただのフォルダ」でしかないので、これを選べば全機能が再現できます。
 *
 *   <出力先>/
 *     library-viewer.html        ビルド済みビューア (dist からコピー)
 *     library.json               保存階層とネーミングルール
 *     members.json               名簿
 *     models/...                 格納済みの装置 (変換済み / 未変換の両方を用意)
 *     inbox/...                  受信箱 (ルール一致 2 件 + 不一致 1 件)
 *     sample-step/               ドラッグ&ドロップ用の STEP (ルール一致 / 不一致)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const occtimportjs = require('occt-import-js');
const GLB = require('../src/js/02-glb.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const clean = args.includes('--clean');
const OUT = path.resolve(args.find(a => !a.startsWith('--')) || 'sample-library');
const VIEWER = path.join(ROOT, 'dist', 'library-viewer.html');
const TMP = path.join(OUT, '.tmp-step');

const PRECISION = { preset: 'standard', linearDeflection: 0.0012, angularDeflection: 0.5 };

/* ライブラリに入れておく装置。BASE_PLATE / ARM_UNIT / COLUMN / HEAD_UNIT を共有するので
 * 複数を読み込むと「案件横断」パネルで同名ユニットを比較できる。 */
const ENTRIES = [
  { projectCode: 'P2026-001', deviceName: '検査装置A', workpiece: 'ワークX', customer: '〇〇食品', department: '設計1課', owner: '山田', scale: 1.0, convert: true, savedAt: '2026-09-10T09:15:00+09:00' },
  { projectCode: 'P2026-007', deviceName: '検査装置A2', workpiece: 'ワークX', customer: '〇〇食品', department: '設計1課', owner: '山田', scale: 1.25, convert: true, savedAt: '2026-09-16T14:02:00+09:00' },
  { projectCode: 'P2026-002', deviceName: '搬送装置B', workpiece: 'ワークY', customer: '△△製作所', department: '設計2課', owner: '鈴木', scale: 1.6, convert: false, savedAt: '2026-09-18T10:00:00+09:00',
    source: { cad: 'fusion', app: 'fusion-library-export', document: '搬送装置B v3', version: 3, exportedBy: '鈴木', fusionWebURL: 'https://myhub.autodesk360.com/' } },
];
/* 受信箱に置くファイル (ファイル名だけで格納先が決まることの確認用) */
const INBOX = [
  { file: 'P2026-004_溶接装置D_ワークY_設計1課_田中.step', root: '溶接装置D', scale: 1.1 },
  { file: 'サブフォルダ/P2026-005_組立_ライン_E__設計2課_鈴木.step', root: '組立ラインE', scale: 0.85 },
  { file: '名前が違う.step', root: 'UNKNOWN', scale: 1.0 },
];
const MEMBERS = [
  { department: '設計1課', name: '山田' }, { department: '設計1課', name: '田中' },
  { department: '設計2課', name: '鈴木' }, { department: '生産技術', name: '高橋' },
];

function genStep(target, rootName, scale) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync('python3', [path.join(ROOT, 'tools', 'gen_test_step.py'), '--assembly', target, rootName, String(scale)], { stdio: 'pipe' });
  return fs.readFileSync(target);
}
function write(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }
function json(p, o) { write(p, JSON.stringify(o, null, 2) + '\n'); }

if (clean && fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(VIEWER)) {
  console.error('dist/library-viewer.html がありません。先に `python3 build.py` を実行してください。');
  process.exit(1);
}
fs.copyFileSync(VIEWER, path.join(OUT, 'library-viewer.html'));

const occt = await occtimportjs();
function convert(bytes, fallbackName) {
  const r = occt.ReadStepFile(new Uint8Array(bytes), { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: PRECISION.linearDeflection, angularDeflection: PRECISION.angularDeflection });
  if (!r.success) throw new Error('STEP 変換に失敗: ' + fallbackName);
  const meshes = r.meshes.map((m, i) => ({
    name: m.name || 'solid_' + i,
    positions: Float32Array.from(m.attributes.position.array),
    normals: Float32Array.from(m.attributes.normal.array),
    indices: Uint32Array.from(m.index.array),
    color: m.color ? [m.color[0], m.color[1], m.color[2]] : null,
  }));
  const toTree = (node) => {
    const t = { name: node.name || '', meshIndex: null, children: [] };
    const kids = (node.children || []).map(toTree);
    const ms = node.meshes || [];
    if (ms.length === 1 && kids.length === 0) { t.meshIndex = ms[0]; if (!t.name) t.name = meshes[ms[0]].name; }
    else ms.forEach(i => kids.push({ name: meshes[i].name, meshIndex: i, children: [] }));
    t.children = kids;
    return t;
  };
  let root = toTree(r.root);
  if (!root.name && root.children.length === 1 && root.meshIndex == null) root = root.children[0];
  if (!root.name) root.name = fallbackName;
  return { name: root.name, root, meshes };
}
function flatten(root) {
  const out = [];
  (function walk(t, depth, p) {
    const pp = p.concat([t.name || '']);
    let solids = 0;
    (function cnt(n) { if (n.meshIndex != null) solids++; (n.children || []).forEach(cnt); })(t);
    out.push({ name: t.name, path: pp.join('/'), depth, solids });
    (t.children || []).forEach(c => walk(c, depth + 1, pp));
  })(root, 0, []);
  return out;
}

// ---- models/ (models / 部署 / 担当者 / 案件コード_装置名 / 対象ワーク) ----
const made = [];
for (const e of ENTRIES) {
  const base = `${e.projectCode}_${e.deviceName}_${e.workpiece}_${e.department}_${e.owner}`;
  const dir = path.join(OUT, 'models', e.department, e.owner, `${e.projectCode}_${e.deviceName}`, e.workpiece);
  const stepBytes = genStep(path.join(TMP, base + '.step'), e.deviceName, e.scale);
  const model = convert(stepBytes, e.deviceName);
  const tris = model.meshes.reduce((s, m) => s + m.indices.length / 3, 0);
  // 変換済みのものは gzip した glb だけを置く (STEP のマスターは Fusion のクラウド)。
  // 未変換のものは Fusion スクリプトが置いた直後の想定なので STEP だけ
  let glbSize = null;
  if (e.convert) {
    const gz = zlib.gzipSync(GLB.write(model), { level: 9 });
    write(path.join(dir, base + '.glb.gz'), gz);
    glbSize = gz.length;
  } else {
    write(path.join(dir, 'step', base + '.step'), stepBytes);
  }
  json(path.join(dir, 'meta.json'), {
    schema: 'library-viewer/1', projectCode: e.projectCode, deviceName: e.deviceName, workpiece: e.workpiece,
    customer: e.customer || '', department: e.department, owner: e.owner, savedAt: e.savedAt,
    precision: e.convert ? PRECISION : null,
    files: [{ name: base, glb: base + '.glb.gz', step: e.convert ? null : 'step/' + base + '.step', stepSize: e.convert ? null : stepBytes.length, glbSize, triangles: e.convert ? tris : null, solids: model.meshes.length, rootName: model.name }],
    source: e.source || { cad: 'step', app: 'library-viewer' },
  });
  json(path.join(dir, 'index.json'), { schema: 'library-viewer/index/1', devices: [{ file: base, rootName: model.name, tree: flatten(model.root) }] });
  made.push(path.relative(OUT, dir) + (e.convert ? '' : '   (未変換: 開くと glb を生成して書き戻します)'));
}

// ---- inbox/ ----
for (const f of INBOX) {
  write(path.join(OUT, 'inbox', f.file), genStep(path.join(TMP, 'inbox-' + path.basename(f.file)), f.root, f.scale));
}
// ---- ドラッグ&ドロップ用 ----
write(path.join(OUT, 'sample-step', 'P2026-009_試験機F_ワークZ_生産技術_高橋.step'), genStep(path.join(TMP, 'drop-1.step'), '試験機F', 1.15));
write(path.join(OUT, 'sample-step', '名前にルールのないファイル.step'), genStep(path.join(TMP, 'drop-2.step'), 'PLAIN_DEVICE', 0.9));
// 計測を試す用: 穴の中心・径が分かっている板 (200x120x10、φ16 の穴が (50,60) と (150,60) → 中心間 100mm)
execFileSync('python3', [path.join(ROOT, 'tools', 'gen_test_step.py'), path.join(TMP, 'std')], { stdio: 'pipe' });
fs.copyFileSync(path.join(TMP, 'std', 'holes.step'), path.join(OUT, 'sample-step', '計測練習_穴あき板_中心間100mm.step'));

json(path.join(OUT, 'library.json'), {
  schema: 'library-viewer/library/1', layout: 'models / 部署 / 担当者 / 案件コード_装置名 / 対象ワーク',
  naming: { pattern: '{projectCode}_{deviceName}_{workpiece}_{department}_{owner}_{customer}', separator: '_' },
  inboxAuto: false, createdAt: new Date().toISOString().replace(/\.\d+Z$/, '+09:00'),
  note: 'このファイルはライブラリの保存階層とネーミングルールを記録します。編集はビューアの「ネーミングルール」から。',
});
json(path.join(OUT, 'members.json'), { schema: 'library-viewer/members/1', updatedAt: new Date().toISOString().replace(/\.\d+Z$/, '+09:00'), members: MEMBERS });
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`サンプルライブラリを作りました: ${OUT}`);
console.log('  models/');
made.forEach(m => console.log('    ' + m));
console.log('  inbox/          ' + INBOX.length + ' 件 (うち 1 件はルールに合わない名前)');
console.log('  sample-step/    ドラッグ&ドロップ用 3 件 (計測練習用の穴あき板を含む)');
console.log('\n次の手順:');
console.log(`  1. ${path.join(OUT, 'library-viewer.html')} をダブルクリック (Chrome / Edge)`);
console.log(`  2. 「ライブラリを開く」で ${OUT} を選ぶ`);
