// File System Access API をメモリ上の偽ハンドルで置き換え、ライブラリ走査 → 未変換 STEP の自動変換と glb 書き戻し →
// 格納 (直接書き込み) → 名簿共有 (members.json) までを通しで確認する
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const html = path.resolve('dist/library-viewer.html');
const outDir = path.resolve('test/out');
const exe = '/opt/pw-browsers/chromium';
const b64 = p => fs.readFileSync(p).toString('base64');
const stored = outDir + '/browser-unz/models/設計1課/P2026-001_検査装置A/ワークX';
const seed = {
  'models/設計1課/P2026-001_検査装置A/ワークX/assembly.glb': b64(stored + '/assembly.glb'),
  'models/設計1課/P2026-001_検査装置A/ワークX/step/assembly.step': b64(stored + '/step/assembly.step'),
  'models/設計1課/P2026-001_検査装置A/ワークX/assembly_b.glb': b64(stored + '/assembly_b.glb'),
  'models/設計1課/P2026-001_検査装置A/ワークX/step/assembly_b.step': b64(stored + '/step/assembly_b.step'),
  'models/設計1課/P2026-001_検査装置A/ワークX/meta.json': b64(stored + '/meta.json'),
  'models/設計1課/P2026-001_検査装置A/ワークX/index.json': b64(stored + '/index.json'),
  // Fusion スクリプトが置いた想定: STEP + meta.json のみ (glb 未生成)
  'models/設計2課/P2026-002_搬送装置B/_/step/assembly_b.step': b64('test/out/assembly_b.step'),
  'models/設計2課/P2026-002_搬送装置B/_/meta.json': Buffer.from(JSON.stringify({
    schema: 'library-viewer/1', projectCode: 'P2026-002', deviceName: '搬送装置B', workpiece: '', department: '設計2課', owner: '鈴木', savedAt: '2026-09-18T10:00:00+09:00', precision: null,
    files: [{ name: 'assembly_b', step: 'step/assembly_b.step', glb: 'assembly_b.glb' }],
    source: { cad: 'fusion', document: 'DEVICE_B v3', fusionWebURL: 'https://example.autodesk360.com/g/data/xxxx' }
  })).toString('base64'),
  // 受信箱: ルール一致 (階層は library.json 未作成 → 既定 0) と不一致
  'inbox/P2026-004_溶接装置D_ワークY_設計1課_田中.step': b64('test/out/box.step'),
  'inbox/フォルダ/P2026-005_組立_ライン_E__設計2課_鈴木 v2.stp': b64('test/out/assembly.step'),
  'inbox/名前が違う.step': b64('test/out/box.step'),
  'members.json': Buffer.from(JSON.stringify({ members: [{ department: '設計1課', name: '山田' }, { department: '設計2課', name: '鈴木' }] })).toString('base64'),
};

const browser = await chromium.launch({ executablePath: exe, args: ['--allow-file-access-from-files', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
function check(c, m) { if (!c) throw new Error('FAIL: ' + m); console.log('  ok  ' + m); }

await page.addInitScript((seed) => {
  class FileH { constructor(name, bytes) { this.kind = 'file'; this.name = name; this._d = bytes; }
    async getFile() { return new File([this._d], this.name); }
    async createWritable() { const self = this; let buf = []; return { async write(d) { buf.push(typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d)); }, async close() { const n = buf.reduce((s, b) => s + b.length, 0); const o = new Uint8Array(n); let p = 0; buf.forEach(b => { o.set(b, p); p += b.length; }); self._d = o; } }; } }
  class DirH { constructor(name) { this.kind = 'directory'; this.name = name; this._e = new Map(); }
    async getFileHandle(n, o) { const h = this._e.get(n); if (h && h.kind === 'file') return h; if (o && o.create) { const f = new FileH(n, new Uint8Array()); this._e.set(n, f); return f; } throw Object.assign(new Error('NotFound ' + n), { name: 'NotFoundError' }); }
    async getDirectoryHandle(n, o) { const h = this._e.get(n); if (h && h.kind === 'directory') return h; if (o && o.create) { const d = new DirH(n); this._e.set(n, d); return d; } throw Object.assign(new Error('NotFound ' + n), { name: 'NotFoundError' }); }
    async *entries() { for (const kv of [...this._e]) yield kv; }
    async removeEntry(n, o) { if (!this._e.has(n)) throw Object.assign(new Error('NotFound ' + n), { name: 'NotFoundError' }); this._e.delete(n); }
    async queryPermission() { return 'granted'; } async requestPermission() { return 'granted'; } }
  const root = new DirH('Library');
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  for (const [p, data] of Object.entries(seed)) { const parts = p.split('/'); let d = root; for (let i = 0; i < parts.length - 1; i++) { if (!d._e.has(parts[i])) d._e.set(parts[i], new DirH(parts[i])); d = d._e.get(parts[i]); } d._e.set(parts.at(-1), new FileH(parts.at(-1), b64(data))); }
  window.__root = root;
  window.showDirectoryPicker = async () => root;
  window.__ls = (p) => { const parts = p.split('/'); let d = root; for (const s of parts) { if (!s) continue; d = d._e.get(s); if (!d) return null; } return d.kind === 'file' ? { file: d.name, size: d._d.length, text: d._d.length < 20000 ? new TextDecoder().decode(d._d) : null } : [...d._e.keys()]; };
}, seed);

await page.goto('file://' + html);
await page.waitForTimeout(1500);
await page.click('#btn-open-lib');
await page.waitForFunction(() => document.querySelector('#lib-status').textContent.includes('件'), null, { timeout: 15000 });
check((await page.textContent('#lib-status')).includes('2 件'), 'library scan found 2 entries');
await page.click('label[for="tab-lib"]');
check(!(await page.$eval('#inbox', e => e.hidden)), 'inbox section shown');
const inboxRows = await page.$$eval('#inbox-list li', l => l.map(x => [x.className, x.textContent]));
console.log('  inbox:', JSON.stringify(inboxRows));
check(inboxRows.length === 3 && inboxRows.filter(r => r[0] === 'bad').length === 1, 'inbox lists 3 files, 1 not matching');
check(inboxRows.some(r => r[1].includes('models/設計2課/P2026-005_組立_ライン_E/_')), 'greedy device name with underscores and empty workpiece resolved');
await page.screenshot({ path: outDir + '/shot-7-inbox.png' });
await page.click('#btn-inbox');
await page.waitForSelector('#msg-dialog[open]', { timeout: 60000 });
console.log('  ' + (await page.textContent('#msg-body')).split('\n').join(' / '));
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.querySelector('#lib-status').textContent.includes('4 件'), null, { timeout: 15000 });
check(true, 'inbox processed: 4 entries');
const stored4 = await page.evaluate(() => window.__ls('models/設計1課/P2026-004_溶接装置D/ワークY'));
check(stored4 && stored4.includes('meta.json') && stored4.includes('P2026-004_溶接装置D_ワークY_設計1課_田中.glb'), 'inbox file stored at rule path: ' + stored4);
const meta4 = JSON.parse((await page.evaluate(() => window.__ls('models/設計1課/P2026-004_溶接装置D/ワークY/meta.json'))).text);
check(meta4.owner === '田中' && meta4.workpiece === 'ワークY' && meta4.source.via === 'inbox' && meta4.files[0].triangles === 12, 'meta.json from naming rule');
check((await page.evaluate(() => window.__ls('members.json'))).text.includes('田中'), 'unknown owner added to members.json');
const inboxLeft = await page.evaluate(() => window.__ls('inbox'));
check(inboxLeft.length === 2 && inboxLeft.includes('名前が違う.step') && !inboxLeft.includes('P2026-004_溶接装置D_ワークY_設計1課_田中.step'), 'processed files removed from inbox, unmatched kept: ' + inboxLeft);
check((await page.evaluate(() => window.__ls('inbox/フォルダ'))).length === 0, 'nested inbox file removed');
check((await page.evaluate(() => window.__ls('library.json'))).text.includes('"naming"'), 'library.json carries naming rule');

// ルール変更 → 未一致だったファイルが一致する
await page.click('#btn-rules');
await page.waitForSelector('#rules-dialog[open]');
await page.fill('#rule-pattern', '{deviceName}');
check(!(await page.$eval('#rule-error', e => e.hidden)), 'rule validation rejects pattern without projectCode');
await page.fill('#rule-pattern', '{projectCode}-{deviceName}');
await page.fill('#rule-sep', '-');
await page.fill('#rule-try', 'Z1-テスト機.step');
check((await page.textContent('#rule-try-out')).includes('models/_/Z1_テスト機'), 'rule try-out shows target path: ' + await page.textContent('#rule-try-out'));
await page.click('#rule-cancel');

check((await page.evaluate(() => window.__ls('catalog.json'))).text.includes('P2026-002'), 'catalog.json written to library root');
await page.click('label[for="tab-lib"]');
await page.waitForTimeout(200);
await page.screenshot({ path: outDir + '/shot-6-library.png' });
const cards = await page.$$('.lib-card');
check(cards.length === 4, '4 cards rendered (2 seeded + 2 from inbox)');
check(await page.$('.lib-card .warn') !== null, 'unconverted STEP warns');
check(await page.$('.lib-card a[href^="https://example.autodesk360.com"]') !== null, 'Fusion で開く link present');

// 未変換エントリを開く → 変換 → glb 書き戻し
await page.locator('.lib-card', { hasText: '搬送装置B' }).locator('button', { hasText: '開く' }).click();
await page.waitForSelector('#overlay', { state: 'hidden', timeout: 60000 });
await page.waitForTimeout(400);
check((await page.$$eval('.tree-row.device .name', r => r.map(x => x.textContent))).join() === 'DEVICE_B', 'opened DEVICE_B from library');
const glbInfo = await page.evaluate(() => window.__ls('models/設計2課/P2026-002_搬送装置B/_/assembly_b.glb'));
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
check((await page.textContent('#st-preview')) === 'Library/models/設計2課/P2026-003_組立装置C/_/', 'preview uses roster dept (from members.json)');
await page.click('#st-save');
await page.waitForSelector('#msg-dialog[open]', { timeout: 30000 });
console.log('  ' + (await page.textContent('#msg-body')).split('\n').join(' / '));
await page.keyboard.press('Escape');
const files = await page.evaluate(() => window.__ls('models/設計2課/P2026-003_組立装置C/_'));
check(files && files.includes('meta.json') && files.includes('assembly_b.glb') && files.includes('step'), 'files written into library: ' + files);
check((await page.evaluate(() => window.__ls('library.json'))).text.includes('"layout": 0'), 'library.json has layout');
await page.waitForFunction(() => document.querySelector('#lib-status').textContent.includes('5 件'), null, { timeout: 15000 });
check(true, 'library rescanned: 5 entries');

check(files.filter(f => f.endsWith('.glb')).length === 3, 'duplicate base names get suffix: ' + files.filter(f => f.endsWith('.glb')));

// 名簿 → members.json
await page.click('label[for="tab-lib"]');
await page.click('#btn-roster');
await page.waitForSelector('#roster-dialog[open]');
await page.fill('#roster-text', '設計1課, 山田\n設計2課, 鈴木\n生産技術, 高橋');
await page.click('#roster-save');
await page.waitForTimeout(300);
check((await page.evaluate(() => window.__ls('members.json'))).text.includes('高橋'), 'members.json updated in library');

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
console.log('LIBRARY TEST PASSED');
