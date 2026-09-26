// File System Access API をメモリ上の偽ハンドルで置き換え、ライブラリ走査 → 未変換 STEP の自動変換と glb 書き戻し →
// 格納 (直接書き込み) → 名簿共有 (members.json) までを通しで確認する
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const html = path.resolve('dist/library-viewer.html');
const outDir = path.resolve('test/out');
const exe = '/opt/pw-browsers/chromium';
const b64 = p => fs.readFileSync(p).toString('base64');
const stored = outDir + '/browser-unz/models/設計1課/山田/P2026-001_検査装置A/ワークX';
// 検査装置A は **旧形式 (素の .glb)** で置く。前の版で作ったライブラリが
// そのまま開けること (下位互換) をここで見る。meta.json も .glb を指すように直す
const unzip = p => zlib.gunzipSync(fs.readFileSync(p)).toString('base64');
const oldMeta = JSON.parse(fs.readFileSync(stored + '/meta.json', 'utf8'));
oldMeta.files.forEach(f => { f.glb = f.name + '.glb'; f.step = 'step/' + f.name + '.step'; });
// Fusion スクリプトが「メッシュで格納」した想定: glb.gz が最初からあり STEP は無い (glbwrite.py が書いたもの)
const meshStat = JSON.parse(execFileSync('python3', ['test/fusion_glb_box.py']).toString());
const seed = {
  'models/設計1課/藤原/P2026-007_メッシュ機H/_/fusion_mesh.glb.gz': b64('test/out/fusion_mesh.glb.gz'),
  'models/設計1課/藤原/P2026-007_メッシュ機H/_/meta.json': Buffer.from(JSON.stringify({
    schema: 'library-viewer/1', projectCode: 'P2026-007', deviceName: 'メッシュ機H', workpiece: '', department: '設計1課', owner: '藤原',
    savedAt: '2026-09-25T10:00:00+09:00', precision: { preset: 'normal', by: 'fusion-mesh' }, split: false,
    files: [{ name: 'fusion_mesh', step: null, glb: 'fusion_mesh.glb.gz', stepSize: null, glbSize: meshStat.gz, rawGlbSize: meshStat.raw, triangles: meshStat.triangles, solids: meshStat.solids, rootName: 'MESH_MACHINE' }],
    source: { cad: 'fusion', app: 'fusion-library-export', document: 'MESH_MACHINE v2' }
  })).toString('base64'),
  'models/設計1課/藤原/P2026-007_メッシュ機H/_/index.json': Buffer.from(JSON.stringify({ schema: 'library-viewer/index/1', devices: [{ file: 'fusion_mesh', rootName: 'MESH_MACHINE',
    tree: [{ name: 'MESH_MACHINE', path: 'MESH_MACHINE', depth: 0, solids: 3 }, { name: 'BASE_PLATE', path: 'MESH_MACHINE/BASE_PLATE', depth: 1, solids: 1 },
           { name: 'UNIT_A:1', path: 'MESH_MACHINE/UNIT_A:1', depth: 1, solids: 1 }, { name: 'POST', path: 'MESH_MACHINE/UNIT_A:1/POST', depth: 2, solids: 1 }] }] })).toString('base64'),
  'models/設計1課/山田/P2026-001_検査装置A/ワークX/assembly.glb': unzip(stored + '/assembly.glb.gz'),
  'models/設計1課/山田/P2026-001_検査装置A/ワークX/step/assembly.step': b64('test/out/assembly.step'),
  'models/設計1課/山田/P2026-001_検査装置A/ワークX/assembly_b.glb': unzip(stored + '/assembly_b.glb.gz'),
  'models/設計1課/山田/P2026-001_検査装置A/ワークX/step/assembly_b.step': b64('test/out/assembly_b.step'),
  'models/設計1課/山田/P2026-001_検査装置A/ワークX/meta.json': Buffer.from(JSON.stringify(oldMeta)).toString('base64'),
  'models/設計1課/山田/P2026-001_検査装置A/ワークX/index.json': b64(stored + '/index.json'),
  // Fusion スクリプトが置いた想定: STEP + meta.json のみ (glb 未生成)
  'models/設計2課/鈴木/P2026-002_搬送装置B/_/step/assembly_b.step': b64('test/out/assembly_b.step'),
  'models/設計2課/鈴木/P2026-002_搬送装置B/_/meta.json': Buffer.from(JSON.stringify({
    schema: 'library-viewer/1', projectCode: 'P2026-002', deviceName: '搬送装置B', workpiece: '', customer: '△△製作所', department: '設計2課', owner: '鈴木', savedAt: '2026-09-18T10:00:00+09:00', precision: null,
    files: [{ name: 'assembly_b', step: 'step/assembly_b.step', glb: 'assembly_b.glb' }],
    source: { cad: 'fusion', document: 'DEVICE_B v3', fusionWebURL: 'https://example.autodesk360.com/g/data/xxxx' }
  })).toString('base64'),
  // Fusion が「ユニットごとに分けて」書き出した想定: STEP 2 本 + それぞれの組立位置
  'models/設計1課/山田/P2026-006_分割機G/_/step/unit_a.step': b64('test/out/box.step'),
  'models/設計1課/山田/P2026-006_分割機G/_/step/unit_b.step': b64('test/out/box.step'),
  'models/設計1課/山田/P2026-006_分割機G/_/meta.json': Buffer.from(JSON.stringify({
    schema: 'library-viewer/1', projectCode: 'P2026-006', deviceName: '分割機G', workpiece: '', department: '設計1課', owner: '山田',
    savedAt: '2026-09-20T10:00:00+09:00', precision: null, split: true,
    files: [
      // 同じ形 (box.step) を別の位置に置く。片方は原点、もう片方は x+1000mm へ z 軸まわり 90°
      { name: 'unit_a', step: 'step/unit_a.step', glb: 'unit_a.glb', rootName: 'UNIT_A',
        placement: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } },
      { name: 'unit_b', step: 'step/unit_b.step', glb: 'unit_b.glb', rootName: 'UNIT_B',
        placement: { origin: [1000, 0, 0], x: [0, 1, 0], y: [-1, 0, 0], z: [0, 0, 1] } },
    ],
    source: { cad: 'fusion', app: 'fusion-library-export' }
  })).toString('base64'),
  // 受信箱: ルール一致 (階層は library.json 未作成 → 既定 0) と不一致
  'inbox/P2026-004_溶接装置D_ワークY_設計1課_田中.step': b64('test/out/box.step'),
  'inbox/フォルダ/P2026-005_組立_ライン_E__設計2課_鈴木 v2.stp': b64('test/out/assembly.step'),
  'inbox/名前が違う.step': b64('test/out/box.step'),
  // 前回の走査結果。1 件 (幽霊装置) はもうフォルダに無い → 先出しの一覧には出るが、走査で消える
  'catalog.json': Buffer.from(JSON.stringify({ schema: 'library-viewer/catalog/2', count: 2, entries: [
    { path: 'models/設計1課/山田/P2026-001_検査装置A/ワークX', files: [{ name: 'assembly', glb: 'assembly.glb', step: 'step/assembly.step' }, { name: 'assembly_b', glb: 'assembly_b.glb', step: 'step/assembly_b.step' }], meta: oldMeta },
    { path: 'models/設計9課/幽霊/P2000-000_幽霊装置/_', files: [{ name: 'ghost', glb: 'ghost.glb.gz', step: null }],
      meta: { schema: 'library-viewer/1', projectCode: 'P2000-000', deviceName: '幽霊装置', department: '設計9課', owner: '幽霊', savedAt: '2020-01-01T00:00:00+09:00', files: [{ name: 'ghost', glb: 'ghost.glb.gz' }] } }
  ] })).toString('base64'),
  'members.json': Buffer.from(JSON.stringify({ members: [{ department: '設計1課', name: '山田' }, { department: '設計2課', name: '鈴木' }] })).toString('base64'),
};

const browser = await chromium.launch({ executablePath: exe, args: ['--allow-file-access-from-files', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
function check(c, m) { if (!c) throw new Error('FAIL: ' + m); console.log('  ok  ' + m); }

await page.addInitScript((seed) => {
  // 本物の File System Access API と同じく、更新日時は書き込んだときだけ変わる
  // (毎回 new File() すると lastModified が現在時刻になり、差分スキャンもキャッシュも当たらない)
  let __mtime = 1758600000000;
  window.__ops = { getFileHandle: 0, entries: 0, getFile: 0 };
  window.__resetOps = () => { window.__ops = { getFileHandle: 0, entries: 0, getFile: 0 }; };
  class FileH { constructor(name, bytes) { this.kind = 'file'; this.name = name; this._d = bytes; this._m = ++__mtime; }
    async getFile() { window.__ops.getFile++; return new File([this._d], this.name, { lastModified: this._m }); }
    async createWritable() { const self = this; let buf = []; return { async write(d) { buf.push(typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d)); }, async close() { const n = buf.reduce((s, b) => s + b.length, 0); const o = new Uint8Array(n); let p = 0; buf.forEach(b => { o.set(b, p); p += b.length; }); self._d = o; self._m = ++__mtime; } }; } }
  class DirH { constructor(name) { this.kind = 'directory'; this.name = name; this._e = new Map(); }
    async getFileHandle(n, o) { window.__ops.getFileHandle++; const h = this._e.get(n); if (h && h.kind === 'file') return h; if (o && o.create) { const f = new FileH(n, new Uint8Array()); this._e.set(n, f); return f; } throw Object.assign(new Error('NotFound ' + n), { name: 'NotFoundError' }); }
    async getDirectoryHandle(n, o) { const h = this._e.get(n); if (h && h.kind === 'directory') return h; if (o && o.create) { const d = new DirH(n); this._e.set(n, d); return d; } throw Object.assign(new Error('NotFound ' + n), { name: 'NotFoundError' }); }
    async *entries() { window.__ops.entries++; for (const kv of [...this._e]) yield kv; }
    async removeEntry(n, o) {
      const h = this._e.get(n);
      if (!h) throw Object.assign(new Error('NotFound ' + n), { name: 'NotFoundError' });
      if (h.kind === 'directory' && h._e.size && !(o && o.recursive)) throw Object.assign(new Error('not empty: ' + n), { name: 'InvalidModificationError' });
      this._e.delete(n);
    }
    async queryPermission() { return 'granted'; } async requestPermission() { return 'granted'; } }
  const root = new DirH('Library');
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  for (const [p, data] of Object.entries(seed)) { const parts = p.split('/'); let d = root; for (let i = 0; i < parts.length - 1; i++) { if (!d._e.has(parts[i])) d._e.set(parts[i], new DirH(parts[i])); d = d._e.get(parts[i]); } d._e.set(parts.at(-1), new FileH(parts.at(-1), b64(data))); }
  window.__root = root;
  window.showDirectoryPicker = async () => root;
  window.__ls = (p) => { const parts = p.split('/'); let d = root; for (const s of parts) { if (!s) continue; d = d._e.get(s); if (!d) return null; } return d.kind === 'file' ? { file: d.name, size: d._d.length, text: d._d.length < 20000 ? new TextDecoder().decode(d._d) : null } : [...d._e.keys()]; };
}, seed);

// 設定は左下の歯車の中にまとまっているので、触る前に開く
const openSettings = async () => { if (await page.getAttribute('#btn-settings', 'aria-expanded') !== 'true') await page.click('#btn-settings'); };
const closeSettings = async () => { if (await page.getAttribute('#btn-settings', 'aria-expanded') === 'true') await page.click('#btn-settings'); };
await page.goto('file://' + html);
await page.waitForTimeout(1500);
await page.click('#btn-open-lib');
await page.waitForFunction(() => document.querySelector('#lib-status').textContent.includes('件'), null, { timeout: 15000 });
check((await page.textContent('#lib-status')).includes('4 件'), 'library scan found 4 entries');
check(/catalog\.json で先出し/.test(await page.getAttribute('#lib-status', 'title')), 'the first open showed the list from catalog.json before walking: ' + await page.getAttribute('#lib-status', 'title'));
check(!(await page.evaluate(() => Library.entries().some(e => e.meta.deviceName === '幽霊装置'))), 'a device that is no longer in the folder is dropped once the walk finishes');
check(await page.evaluate(() => Library.entries().every(e => e.dir)), 'every entry has a real folder handle after the walk');

// ---- 保存先パスの語で検索できる (担当者の名前で、その人が担当した装置が出る) ----
const hitTitles = () => page.$$eval('#search-list .hit-card .dev > span:first-of-type', ss => ss.map(s => s.textContent.trim()));
await page.fill('#tree-search', '鈴木');          // 名簿にしかいない担当者 = 保存先パスの語
await page.waitForTimeout(350);
const byOwner = await hitTitles();
console.log('    「鈴木」の検索結果:', JSON.stringify(byOwner), await page.textContent('#search-sum'));
check(byOwner.includes('搬送装置B'), 'searching an owner name finds what they stored, even unloaded: ' + byOwner);
check((await page.textContent('#search-sum')).includes('ライブラリ 1'), 'and it is counted as a library hit');
await page.fill('#tree-search', '設計1課');       // 部署でも当たる
await page.waitForTimeout(350);
check((await hitTitles()).includes('検査装置A'), 'searching a department finds its devices: ' + await hitTitles());
// ライブラリタブの絞り込みも部品名で当たる (開かなくてよい)
await page.click('label[for="tab-lib"]');
await page.fill('#lib-search', 'POST');
await page.waitForFunction(() => [...document.querySelectorAll('.lib-card')].some(c => c.textContent.includes('メッシュ機H')) && document.querySelectorAll('.lib-card').length === 1, null, { timeout: 10000 });
check((await page.$$('.lib-card')).length === 1, 'the library tab filter narrows by part name without opening');
await page.fill('#lib-search', '');
await page.waitForTimeout(300);
// 読み込んでいない装置でも、中の部品名で当たる (index.json を検索時に読む)
await page.fill('#tree-search', 'BASE_PLATE');
// 前の検索 (設計1課) の結果にもメッシュ機H は出るので、新しい問い合わせで部品名が当たるまで待つ
await page.waitForFunction(() => Search.query() === 'BASE_PLATE' && Search.hits().lib.some(h => h.part === 'BASE_PLATE'), null, { timeout: 10000 });
check((await hitTitles()).includes('メッシュ機H'), 'a part name finds an unloaded library device: ' + await hitTitles());
check(await page.locator('#search-list .hit-card', { hasText: 'メッシュ機H' }).locator('.badge', { hasText: 'BASE_PLATE' }).count() === 1, 'the card shows which part matched');
check((await page.evaluate(() => App.devices().length)) === 0, 'without loading it');
const namesCached = await page.evaluate(() => Library.entries().filter(e => Array.isArray(e.partList)).length);
check(namesCached === (await page.evaluate(() => Library.entries().length)), 'part names were read for every unloaded entry (' + namesCached + ')');
// 結果を押すとライブラリから読み込まれる (glb 済みの 検査装置A で試す。未変換のものは後の検証に残す)
await page.locator('#search-list .hit-card', { hasText: '検査装置A' }).first().click();
await page.waitForFunction(() => App.devices().length > 0, null, { timeout: 60000 });
await page.waitForSelector('#overlay', { state: 'hidden', timeout: 60000 });
await page.waitForTimeout(400);
check(await page.evaluate(() => App.devices().length) >= 1, 'clicking a library hit loads it');
check(!(await hitTitles()).includes('検査装置A'), 'once loaded it drops out of the unloaded list: ' + await hitTitles());
await page.fill('#tree-search', 'P2026-002');     // 案件コードでも当たる
await page.waitForTimeout(350);
check((await hitTitles()).includes('搬送装置B'), 'searching a project code works too');
await page.fill('#tree-search', '△△製作所');     // 取引先でも当たる
await page.waitForTimeout(350);
check((await hitTitles()).includes('搬送装置B'), 'searching a customer finds their devices: ' + await hitTitles());
await page.fill('#tree-search', '');
await page.waitForTimeout(300);
await page.evaluate(() => App.clearDevices());
await page.waitForTimeout(200);
await page.click('label[for="tab-lib"]');
check(!(await page.$eval('#inbox', e => e.hidden)), 'inbox section shown');
const inboxRows = await page.$$eval('#inbox-list li', l => l.map(x => [x.className, x.textContent]));
console.log('  inbox:', JSON.stringify(inboxRows));
check(inboxRows.length === 3 && inboxRows.filter(r => r[0] === 'bad').length === 1, 'inbox lists 3 files, 1 not matching');
check(inboxRows.some(r => r[1].includes('models/設計2課/鈴木/P2026-005_組立_ライン_E/_')), 'greedy device name with underscores and empty workpiece resolved');
await page.screenshot({ path: outDir + '/shot-7-inbox.png' });
await page.click('#btn-inbox');
await page.waitForSelector('#msg-dialog[open]', { timeout: 60000 });
console.log('  ' + (await page.textContent('#msg-body')).split('\n').join(' / '));
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.querySelector('#lib-status').textContent.includes('6 件'), null, { timeout: 15000 });
check(true, 'inbox processed: 5 entries');
const stored4 = await page.evaluate(() => window.__ls('models/設計1課/田中/P2026-004_溶接装置D/ワークY'));
check(stored4 && stored4.includes('meta.json') && stored4.includes('P2026-004_溶接装置D_ワークY_設計1課_田中.glb.gz'), 'inbox file stored as gzipped glb at the rule path: ' + stored4);
check(!stored4.includes('step'), 'and the STEP is not copied into the shared folder: ' + stored4);
const meta4 = JSON.parse((await page.evaluate(() => window.__ls('models/設計1課/田中/P2026-004_溶接装置D/ワークY/meta.json'))).text);
check(meta4.owner === '田中' && meta4.workpiece === 'ワークY' && meta4.source.via === 'inbox' && meta4.files[0].triangles === 12, 'meta.json from naming rule');
check((await page.evaluate(() => window.__ls('members.json'))).text.includes('田中'), 'unknown owner added to members.json');
const inboxLeft = await page.evaluate(() => window.__ls('inbox'));
check(inboxLeft.length === 2 && inboxLeft.includes('名前が違う.step') && !inboxLeft.includes('P2026-004_溶接装置D_ワークY_設計1課_田中.step'), 'processed files removed from inbox, unmatched kept: ' + inboxLeft);
check((await page.evaluate(() => window.__ls('inbox/フォルダ'))).length === 0, 'nested inbox file removed');
check((await page.evaluate(() => window.__ls('library.json'))).text.includes('"naming"'), 'library.json carries naming rule');

// ルール変更 → 未一致だったファイルが一致する
await openSettings();
await page.click('#btn-rules');
await page.waitForSelector('#rules-dialog[open]');
await page.fill('#rule-pattern', '{deviceName}');
check(!(await page.$eval('#rule-error', e => e.hidden)), 'rule validation rejects pattern without projectCode');
await page.fill('#rule-pattern', '{projectCode}-{deviceName}');
await page.fill('#rule-sep', '-');
await page.fill('#rule-try', 'Z1-テスト機.step');
check((await page.textContent('#rule-try-out')).includes('models/_/_/Z1_テスト機'), 'rule try-out shows target path: ' + await page.textContent('#rule-try-out'));
// 項目のボタンでパターンを組める (押すと末尾に足す / もう一度で外す / 必須は外れない / 既定に戻す)
const pressed = () => page.$$eval('#rule-fields .rule-field[aria-pressed="true"]', b => b.map(x => x.dataset.field));
check(JSON.stringify(await pressed()) === JSON.stringify(['projectCode', 'deviceName']), 'field buttons reflect the pattern: ' + await pressed());
await page.click('#rule-fields .rule-field[data-field="customer"]');
check(await page.inputValue('#rule-pattern') === '{projectCode}-{deviceName}-{customer}', 'pressing 取引先 appends it: ' + await page.inputValue('#rule-pattern'));
await page.click('#rule-fields .rule-field[data-field="customer"]');
check(await page.inputValue('#rule-pattern') === '{projectCode}-{deviceName}', 'pressing it again removes it');
// 外して戻した項目は末尾ではなく決まった位置に戻る (順番が崩れない)
await page.click('#rule-fields .rule-field[data-field="customer"]');
await page.click('#rule-fields .rule-field[data-field="owner"]');
await page.click('#rule-fields .rule-field[data-field="workpiece"]');
check(await page.inputValue('#rule-pattern') === '{projectCode}-{deviceName}-{workpiece}-{owner}-{customer}', 'a re-added item goes back to its fixed position, not the end: ' + await page.inputValue('#rule-pattern'));
await page.click('#rule-fields .rule-field[data-field="workpiece"]');
await page.click('#rule-fields .rule-field[data-field="workpiece"]');
check(await page.inputValue('#rule-pattern') === '{projectCode}-{deviceName}-{workpiece}-{owner}-{customer}', 'toggling an item off and on leaves the order unchanged');
const beforeReq = await page.inputValue('#rule-pattern');
await page.click('#rule-fields .rule-field[data-field="projectCode"]');
check(await page.inputValue('#rule-pattern') === beforeReq, 'a required field cannot be removed');
await page.click('#rule-reset');
check(await page.inputValue('#rule-pattern') === '{projectCode}_{deviceName}_{workpiece}_{department}_{owner}_{customer}' && await page.inputValue('#rule-sep') === '_', '既定に戻す restores the default (with 取引先 last)');
await page.fill('#rule-try', 'P2026-009_旧名の装置_ワークZ_設計1課_山田.step');
check((await page.textContent('#rule-try-out')).includes('取引先=(空)') && (await page.textContent('#rule-try-out')).includes('担当者=山田'), 'a legacy name without 取引先 still parses under the default: ' + await page.textContent('#rule-try-out'));
await page.click('#rule-cancel');

check((await page.evaluate(() => window.__ls('catalog.json'))).text.includes('P2026-002'), 'catalog.json written to library root');
await page.click('label[for="tab-lib"]');
await page.waitForTimeout(200);
await page.screenshot({ path: outDir + '/shot-6-library.png' });
const cards = await page.$$('.lib-card');
check(cards.length === 6, '6 cards rendered (4 seeded + 2 from inbox)');
check(await page.$('.lib-card .warn') !== null, 'unconverted STEP warns');
check(await page.$('.lib-card a[href^="https://example.autodesk360.com"]') !== null, 'Fusion で開く link present');

// 未変換エントリを開く → 変換 → glb 書き戻し
await page.locator('.lib-card', { hasText: '搬送装置B' }).locator('button', { hasText: '開く' }).click();
await page.waitForSelector('#overlay', { state: 'hidden', timeout: 60000 });
await page.waitForTimeout(400);
check((await page.$$eval('.tree-row.device .name', r => r.map(x => x.textContent))).join().includes('assembly_b'), 'opened the entry from the library');
const glbInfo = await page.evaluate(() => window.__ls('models/設計2課/鈴木/P2026-002_搬送装置B/_/assembly_b.glb.gz'));
check(glbInfo && glbInfo.size > 1000, 'glb written back into library (' + (glbInfo && glbInfo.size) + ' bytes)');
await page.click('label[for="tab-lib"]');
check(await page.locator('.lib-card', { hasText: '搬送装置B' }).locator('.warn').count() === 0, 'warning cleared after conversion');

// 追加読み込み (横断比較)
await page.locator('.lib-card', { hasText: '検査装置A' }).locator('button', { hasText: '追加' }).click();
await page.waitForTimeout(500);
check((await page.$$('.tree-row.device')).length === 3, '3 devices after 追加 (glb 2 files)');

// 格納 (直接書き込み)
await page.click('#btn-store');
await page.waitForSelector('#store-dialog[open]');
check((await page.textContent('#st-method')).includes('直接書き込み'), 'store dialog says direct write');
check((await page.$$eval('#dl-projects option', o => o.map(x => x.value))).includes('P2026-001'), 'project code suggestions from library');
await page.fill('#st-project', 'P2026-003');
await page.fill('#st-device', '組立装置C');
await page.locator('#st-roster button.dept', { hasText: '設計2課' }).click();
await page.locator('#st-roster label.member', { hasText: '鈴木' }).click();
check((await page.textContent('#st-preview')) === 'Library/models/設計2課/鈴木/P2026-003_組立装置C/_/', 'preview uses roster dept (from members.json)');
await page.click('#st-save');
await page.waitForSelector('#msg-dialog[open]', { timeout: 30000 });
console.log('  ' + (await page.textContent('#msg-body')).split('\n').join(' / '));
await page.keyboard.press('Escape');
const files = await page.evaluate(() => window.__ls('models/設計2課/鈴木/P2026-003_組立装置C/_'));
check(files && files.includes('meta.json') && files.includes('assembly_b.glb.gz'), 'files written into library: ' + files);
check(!files.includes('step'), 'no step/ folder is created (the master lives in Fusion cloud): ' + files);
check((await page.evaluate(() => window.__ls('library.json'))).text.includes('部署 / 担当者 / 案件コード_装置名'), 'library.json records the (fixed) layout');
await page.waitForFunction(() => document.querySelector('#lib-status').textContent.includes('7 件'), null, { timeout: 15000 });
check(true, 'library rescanned: 7 entries');

check(files.filter(f => f.endsWith('.glb.gz')).length === 3, 'duplicate base names get suffix: ' + files.filter(f => f.endsWith('.glb.gz')));

// 名簿 → members.json
await page.click('label[for="tab-lib"]');
await openSettings();
await page.click('#btn-roster');
await page.waitForSelector('#roster-dialog[open]');
await page.fill('#roster-text', '設計1課, 山田\n設計2課, 鈴木\n生産技術, 高橋');
await page.click('#roster-save');
await page.waitForTimeout(300);
check((await page.evaluate(() => window.__ls('members.json'))).text.includes('高橋'), 'members.json updated in library');

// ---- 2 回目以降は差分だけ読む / 開いた装置はキャッシュから ----
// 1 回目は meta.json を全部読む。2 回目は更新日時とサイズが同じものを読み直さない
const scanStats = () => page.evaluate(() => document.querySelector('#lib-status').title);
console.log('    1 回目のスキャン:', await scanStats());
await page.evaluate(() => window.__resetOps());
await page.click('#btn-rescan');
await page.waitForFunction(() => document.querySelector('#lib-status').className.includes('ok'), null, { timeout: 15000 });
await page.waitForTimeout(300);
const s2 = await scanStats();
console.log('    2 回目のスキャン:', s2);
check(/読み直し 0 件/.test(s2), 'the second scan re-reads no meta.json: ' + s2);
check(/前回のまま [1-9]/.test(s2), 'and reuses the cached entries: ' + s2);
const ops2 = await page.evaluate(() => window.__ops);
console.log('    2 回目の往復:', JSON.stringify(ops2));
// getFileHandle は library.json / members.json / catalog.json の読み書きと、まだ STEP が残る装置の分だけ。
// 装置フォルダで meta.json や glb を探しに行かない (一覧に載っているかで判断する)
const nDev = await page.evaluate(() => Library.entries().length);
const nStep = await page.evaluate(() => Library.entries().reduce((n, e) => n + e.files.filter(f => f.step).length, 0));
check(ops2.getFileHandle <= 4 + nStep, 'a rescan does not probe meta.json / glb with getFileHandle (' + ops2.getFileHandle + ' calls for ' + nDev + ' devices, ' + nStep + ' with STEP)');
check(ops2.getFile === nDev + 2, 'a rescan reads one timestamp per device (' + ops2.getFile + ' getFile for ' + nDev + ' devices + library.json + members.json)');
// meta.json を書き換えたものだけ読み直す
await page.evaluate(() => {
  const p = 'models/設計2課/鈴木/P2026-002_搬送装置B/_/meta.json'.split('/');
  let d = window.__root; for (let i = 0; i < p.length - 1; i++) d = d._e.get(p[i]);
  const h = d._e.get('meta.json');
  h._d = new TextEncoder().encode(new TextDecoder().decode(h._d).replace('搬送装置B', '搬送装置B2'));
});
await page.click('#btn-rescan');
await page.waitForFunction(() => document.querySelector('#lib-status').className.includes('ok'), null, { timeout: 15000 });
await page.waitForTimeout(300);
const s3 = await scanStats();
console.log('    書き換えた 1 件だけ:', s3);
check(/読み直し 1 件/.test(s3), 'only the changed entry is read again: ' + s3);

// ---- ユニット分割で格納されたエントリ: 組立位置が戻る ----
await page.click('label[for="tab-lib"]');
await page.waitForTimeout(200);
await page.evaluate(() => App.clearDevices());
await page.locator('.lib-card', { hasText: '分割機G' }).locator('button', { hasText: '開く' }).click();
await page.waitForFunction(() => App.devices().length === 2, null, { timeout: 90000 });
await page.waitForSelector('#overlay', { state: 'hidden', timeout: 60000 });
await page.waitForTimeout(400);
const placed = await page.evaluate(() => App.devices().map(d => {
  const b = new THREE.Box3();
  Viewer3D.leavesOf(d.root).forEach(n => { if (n.mesh) b.union(n.mesh.geometry.boundingBox); });
  const c = b.getCenter(new THREE.Vector3());
  return { name: d.fileName, x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) };
}).sort((a, b) => a.name.localeCompare(b.name)));
console.log('    ユニットの中心:', JSON.stringify(placed));
check(placed.length === 2, 'both units of the split entry are loaded as one entry');
check(Math.abs(placed[0].x) < 200, 'unit_a stays at the origin: x=' + placed[0].x);
check(placed[1].x > 800, 'unit_b is moved to its assembly position (x=' + placed[1].x + ', +1000mm)');
check(Math.abs(placed[1].x - placed[0].x) > 800, 'the units do not pile up on each other');
// glb は位置を焼いた状態で書き戻される (2 回目以降は placement を当てない)
const glbA = await page.evaluate(() => window.__ls('models/設計1課/山田/P2026-006_分割機G/_/unit_b.glb.gz'));
check(glbA && glbA.size > 0, 'a glb was written back for the unit');
await page.evaluate(() => App.clearDevices());
await page.click('label[for="tab-lib"]');   // 開くと構成タブへ切り替わるので戻す

// ---- Fusion が「メッシュで格納」したエントリ: 変換なしでそのまま開く ----
check(await page.locator('.lib-card', { hasText: 'メッシュ機H' }).locator('.warn').count() === 0, 'a mesh-stored entry does not warn about unconverted STEP');
const meshT0 = Date.now();
await page.locator('.lib-card', { hasText: 'メッシュ機H' }).locator('button', { hasText: '開く' }).click();
await page.waitForFunction(() => App.devices().length === 1, null, { timeout: 30000 });
await page.waitForTimeout(300);
const meshMs = Date.now() - meshT0;
const meshNames = await page.$$eval('.tree-row .name', r => r.map(x => x.textContent));
check(meshNames.includes('BASE_PLATE') && meshNames.includes('UNIT_A:1') && meshNames.includes('UNIT_A:2') && meshNames.filter(n => n === 'POST').length === 2, 'Fusion occurrence hierarchy shows in the tree (POST instanced twice): ' + meshNames.filter(n => /BASE|UNIT|POST|fusion/.test(n)).join(' / '));
check(meshMs < 3000, 'opened without conversion (' + meshMs + ' ms)');
const meshGlb = await page.evaluate(() => window.__ls('models/設計1課/藤原/P2026-007_メッシュ機H/_/fusion_mesh.glb.gz'));
check(meshGlb.size === meshStat.gz, 'the glb.gz written by Fusion is used as-is (not rewritten)');
check(await page.evaluate(() => window.__ls('models/設計1課/藤原/P2026-007_メッシュ機H/_/step')) === null, 'no step/ folder for a mesh-stored entry');
const meshBox = await page.evaluate(() => { const b = new THREE.Box3(); Viewer3D.leavesOf(App.devices()[0].root).forEach(n => { if (n.mesh) b.union(n.mesh.geometry.boundingBox); }); return { x: Math.round(b.max.x - b.min.x), z: Math.round(b.max.z - b.min.z) }; });
check(meshBox.x === 260 && meshBox.z === 110, 'geometry is in mm, instances placed by their matrices (x 260 = ' + meshBox.x + ', z 110 = ' + meshBox.z + ')');
await page.evaluate(() => App.clearDevices());
await page.click('label[for="tab-lib"]');
await page.waitForTimeout(200);
await page.locator('.lib-card', { hasText: '分割機G' }).locator('button', { hasText: '開く' }).click();
await page.waitForFunction(() => App.devices().length === 2, null, { timeout: 60000 });
await page.waitForTimeout(400);
const again = await page.evaluate(() => App.devices().map(d => {
  const b = new THREE.Box3();
  Viewer3D.leavesOf(d.root).forEach(n => { if (n.mesh) b.union(n.mesh.geometry.boundingBox); });
  return Math.round(b.getCenter(new THREE.Vector3()).x);
}).sort((a, b) => a - b));
console.log('    2 回目 (glb から):', JSON.stringify(again));
check(again[1] > 800 && Math.abs(again[0]) < 200, 'reopening from the written-back glb keeps the same positions (not doubled)');
await page.evaluate(() => App.clearDevices());

// ---- 削除: 装置フォルダごと消え、空になった親も掃除される ----
await page.click('label[for="tab-lib"]');
await page.waitForTimeout(200);
const before = (await page.$$('.lib-card')).length;
check((await page.evaluate(() => window.__ls('models/設計2課/鈴木'))).length === 3, '鈴木 has 3 project folders before delete');

// 確認ダイアログでキャンセルすると消えない
await page.locator('.lib-card', { hasText: '組立装置C' }).locator('button', { hasText: '削除' }).click();
await page.waitForSelector('#confirm-dialog[open]');
const cbody = await page.textContent('#confirm-body');
check(cbody.includes('models/設計2課/鈴木/P2026-003_組立装置C/_/') && cbody.includes('meta.json'), 'confirm shows the path and files');
check(cbody.includes('全員から見えなくなります'), 'confirm warns it is shared');
await page.click('#confirm-cancel');
await page.waitForTimeout(300);
check((await page.$$('.lib-card')).length === before, 'cancel keeps the entry');
check(await page.evaluate(() => window.__ls('models/設計2課/鈴木/P2026-003_組立装置C')) !== null, 'cancel keeps the folder');

// 削除する
await page.locator('.lib-card', { hasText: '組立装置C' }).locator('button', { hasText: '削除' }).click();
await page.waitForSelector('#confirm-dialog[open]');
await page.click('#confirm-ok');
await page.waitForSelector('#msg-dialog[open]', { timeout: 15000 });
await page.keyboard.press('Escape');
await page.waitForFunction((n) => document.querySelectorAll('.lib-card').length === n, before - 1, { timeout: 15000 });
check(true, 'entry removed from the list (' + before + ' → ' + (before - 1) + ')');
check(await page.evaluate(() => window.__ls('models/設計2課/鈴木/P2026-003_組立装置C')) === null, 'device folder deleted from the library');
check((await page.evaluate(() => window.__ls('models/設計2課/鈴木'))).length === 2, 'sibling folders untouched');

// 部署が空になったら、その部署フォルダも消える
// Fusion が新しく格納した (= フォルダに増えた) 装置は、ブラウザの窓に戻るだけで一覧に出る
await page.evaluate(() => {
  const p = 'models/設計1課/藤原/P2026-008_新着機J/_'.split('/'); let d = window.__root;
  for (const seg of p) { if (!d._e.has(seg)) d._e.set(seg, new (Object.getPrototypeOf(window.__root).constructor)(seg)); d = d._e.get(seg); }
  const enc = new TextEncoder();
  const meta = { schema: 'library-viewer/1', projectCode: 'P2026-008', deviceName: '新着機J', workpiece: '', department: '設計1課', owner: '藤原', savedAt: '2026-09-27T09:00:00+09:00', files: [{ name: 'x', glb: 'x.glb.gz' }] };
  const FileH = Object.getPrototypeOf(window.__root._e.get('members.json')).constructor;
  d._e.set('meta.json', new FileH('meta.json', enc.encode(JSON.stringify(meta))));
  d._e.set('x.glb.gz', new FileH('x.glb.gz', new Uint8Array(10)));
});
const nBefore = await page.evaluate(() => Library.entries().length);
await page.waitForTimeout(2200);   // 直前の走査から 2 秒以内は読み直さない
await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
await page.waitForFunction((n) => Library.entries().length === n + 1, nBefore, { timeout: 15000 });
check(await page.evaluate(() => Library.entries().some(e => e.meta.deviceName === '新着機J')), 'a device stored while the viewer was in the background appears on window focus, without 再読み込み');
await page.waitForFunction(() => document.querySelector('#lib-status').className.includes('ok'), null, { timeout: 15000 });
await page.waitForTimeout(300);
check((await page.evaluate(() => window.__ls('models/設計1課'))).length === 3, '設計1課 has 3 owner folders (山田 / 田中 / 藤原)');
for (const name of ['溶接装置D', '検査装置A', '分割機G', 'メッシュ機H', '新着機J']) {
  await page.locator('.lib-card', { hasText: name }).locator('button', { hasText: '削除' }).click();
  await page.waitForSelector('#confirm-dialog[open]');
  await page.click('#confirm-ok');
  await page.waitForSelector('#msg-dialog[open]', { timeout: 15000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
}
check(await page.evaluate(() => window.__ls('models/設計1課')) === null, 'empty owner and department folders cleaned up too');
check(await page.evaluate(() => window.__ls('models/設計1課/山田')) === null, 'the split entry folder is gone with its units');
check(await page.evaluate(() => window.__ls('models')) !== null, 'models/ itself is kept');
await page.screenshot({ path: outDir + '/shot-18-after-delete.png' });

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
console.log('LIBRARY TEST PASSED');
