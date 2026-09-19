// tools/make_sample_library.mjs が作ったフォルダを、ビューアが実際に読めるか確認する。
// File System Access API は偽ハンドルで置き換えるが、中身はディスク上の本物のサンプルを読み込む。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const LIB = path.resolve(process.argv[2] || 'sample-library');
if (!fs.existsSync(LIB)) { console.error('先に `npm run sample` を実行してください:', LIB); process.exit(1); }

// サンプルフォルダを {相対パス: base64} に読み込む (ビューア本体は除く)
const seed = {};
(function walk(dir, rel) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n), r = rel ? rel + '/' + n : n;
    if (fs.statSync(p).isDirectory()) walk(p, r);
    else if (r !== 'library-viewer.html' && !r.startsWith('sample-step/')) seed[r] = fs.readFileSync(p).toString('base64');
  }
})(LIB, '');
console.log('  seeded', Object.keys(seed).length, 'files from', path.basename(LIB));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--allow-file-access-from-files', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
function check(c, m) { if (!c) throw new Error('FAIL: ' + m); console.log('  ok  ' + m); }

await page.addInitScript((seed) => {
  class FileH { constructor(name, bytes) { this.kind = 'file'; this.name = name; this._d = bytes; }
    async getFile() { return new File([this._d], this.name); }
    async createWritable() { const self = this; const buf = []; return { async write(d) { buf.push(typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d)); }, async close() { const n = buf.reduce((s, b) => s + b.length, 0); const o = new Uint8Array(n); let p = 0; buf.forEach(b => { o.set(b, p); p += b.length; }); self._d = o; } }; } }
  class DirH { constructor(name) { this.kind = 'directory'; this.name = name; this._e = new Map(); }
    async getFileHandle(n, o) { const h = this._e.get(n); if (h && h.kind === 'file') return h; if (o && o.create) { const f = new FileH(n, new Uint8Array()); this._e.set(n, f); return f; } throw Object.assign(new Error('NotFound ' + n), { name: 'NotFoundError' }); }
    async getDirectoryHandle(n, o) { const h = this._e.get(n); if (h && h.kind === 'directory') return h; if (o && o.create) { const d = new DirH(n); this._e.set(n, d); return d; } throw Object.assign(new Error('NotFound ' + n), { name: 'NotFoundError' }); }
    async *entries() { for (const kv of [...this._e]) yield kv; }
    async removeEntry(n) { if (!this._e.delete(n)) throw Object.assign(new Error('NotFound'), { name: 'NotFoundError' }); }
    async queryPermission() { return 'granted'; } async requestPermission() { return 'granted'; } }
  const root = new DirH('sample-library');
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  for (const [p, data] of Object.entries(seed)) { const parts = p.split('/'); let d = root; for (let i = 0; i < parts.length - 1; i++) { if (!d._e.has(parts[i])) d._e.set(parts[i], new DirH(parts[i])); d = d._e.get(parts[i]); } d._e.set(parts.at(-1), new FileH(parts.at(-1), b64(data))); }
  window.__root = root;
  window.showDirectoryPicker = async () => root;
  window.__ls = (p) => { let d = root; for (const s of p.split('/')) { if (!s) continue; d = d._e.get(s); if (!d) return null; } return d.kind === 'file' ? { size: d._d.length } : [...d._e.keys()]; };
}, seed);

await page.goto('file://' + path.resolve('dist/library-viewer.html'));
await page.waitForTimeout(1500);
await page.click('#btn-open-lib');
await page.waitForFunction(() => document.querySelector('#lib-status').textContent.includes('件'), null, { timeout: 20000 });
await page.click('label[for="tab-lib"]');
check((await page.$$('.lib-card')).length === 3, '3 devices listed from sample library');
check((await page.$$('.lib-card .warn')).length === 1, '1 unconverted entry flagged');
check(await page.$('.lib-card a[href^="https://myhub.autodesk360.com"]') !== null, 'Fusion link from sample meta.json');
const inboxRows = await page.$$eval('#inbox-list li', l => l.map(x => x.className));
check(inboxRows.length === 3 && inboxRows.filter(c => c === 'bad').length === 1, 'inbox: 3 files, 1 not matching the rule');
await page.screenshot({ path: 'test/out/shot-9-sample.png' });

// 変換済みエントリ → 即表示。未変換エントリ → 変換して glb 書き戻し
await page.locator('.lib-card', { hasText: '検査装置A2' }).locator('button', { hasText: '開く' }).click();
await page.waitForFunction(() => App.devices().length === 1, null, { timeout: 60000 });
check((await page.$$eval('.tree-row.device .name', r => r.map(x => x.textContent))).join() === '検査装置A2', 'opened pre-converted entry');
await page.click('label[for="tab-lib"]');
await page.locator('.lib-card', { hasText: '搬送装置B' }).locator('button', { hasText: '追加' }).click();
await page.waitForFunction(() => App.devices().length === 2, null, { timeout: 60000 });
await page.waitForSelector('#overlay', { state: 'hidden', timeout: 60000 });
const glb = await page.evaluate(() => window.__ls('models/設計2課/P2026-002_搬送装置B/ワークY/P2026-002_搬送装置B_ワークY_設計2課_鈴木.glb'));
check(glb && glb.size > 1000, 'unconverted entry converted and glb written back (' + (glb && glb.size) + ' bytes)');

// 案件横断: 2 装置がユニット名を共有している
await page.click('label[for="tab-tree"]');
await page.locator('.tree-row', { hasText: 'ARM_UNIT' }).first().locator('button.name').click();
await page.waitForTimeout(300);
check((await page.$$('.xref-card')).length >= 1, 'cross-reference finds shared unit across devices');
await page.screenshot({ path: 'test/out/shot-10-sample-xref.png' });

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
console.log('SAMPLE LIBRARY TEST PASSED');
