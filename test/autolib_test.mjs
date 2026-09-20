// 既定のライブラリ: 場所を覚えておき、開いた時点で自動読み込みする。
// 権限が切れているときはフォルダ選択を出さずに 1 クリックで戻せること。
//
// File System Access のハンドルは構造化複製できないので、IndexedDB の代わりに
// IDB.get を差し替えて「前回のフォルダを覚えている」状態を作る。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const html = path.resolve('dist/library-viewer.html');
const outDir = path.resolve('test/out');
const b64 = p => fs.readFileSync(p).toString('base64');
const stored = outDir + '/browser-unz/models/設計1課/山田/P2026-001_検査装置A/ワークX';
if (!fs.existsSync(stored)) { console.error('先に npm run test:browser を実行してください'); process.exit(1); }
const seed = {
  'models/設計1課/山田/P2026-001_検査装置A/ワークX/assembly.glb': b64(stored + '/assembly.glb'),
  'models/設計1課/山田/P2026-001_検査装置A/ワークX/meta.json': b64(stored + '/meta.json'),
  'members.json': Buffer.from(JSON.stringify({ members: [{ department: '設計1課', name: '山田' }] })).toString('base64'),
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--allow-file-access-from-files', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
function check(c, m) { if (!c) throw new Error('FAIL: ' + m); console.log('  ok  ' + m); }

/* permission = 覚えているフォルダの権限状態。auto = 自動読み込み設定 */
async function openPage({ permission, auto, remembered = true }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(({ seed, permission, auto, remembered }) => {
    class FileH { constructor(n, b) { this.kind = 'file'; this.name = n; this._d = b; }
      async getFile() { return new File([this._d], this.name); }
      async createWritable() { const s = this; const buf = []; return { async write(d) { buf.push(typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d)); }, async close() { const n = buf.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(n); let p = 0; buf.forEach(x => { o.set(x, p); p += x.length; }); s._d = o; } }; } }
    class DirH { constructor(n) { this.kind = 'directory'; this.name = n; this._e = new Map(); }
      async getFileHandle(n, o) { const h = this._e.get(n); if (h && h.kind === 'file') return h; if (o && o.create) { const f = new FileH(n, new Uint8Array()); this._e.set(n, f); return f; } throw Object.assign(new Error('nf'), { name: 'NotFoundError' }); }
      async getDirectoryHandle(n, o) { const h = this._e.get(n); if (h && h.kind === 'directory') return h; if (o && o.create) { const d = new DirH(n); this._e.set(n, d); return d; } throw Object.assign(new Error('nf'), { name: 'NotFoundError' }); }
      async *entries() { for (const kv of [...this._e]) yield kv; }
      async removeEntry(n, o) { this._e.delete(n); }
      async queryPermission() { return window.__perm; }
      async requestPermission() { window.__requests = (window.__requests || 0) + 1; window.__perm = 'granted'; return 'granted'; } }
    const root = new DirH('共有ライブラリ');
    const dec = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    for (const [p, data] of Object.entries(seed)) { const parts = p.split('/'); let d = root; for (let i = 0; i < parts.length - 1; i++) { if (!d._e.has(parts[i])) d._e.set(parts[i], new DirH(parts[i])); d = d._e.get(parts[i]); } d._e.set(parts.at(-1), new FileH(parts.at(-1), dec(data))); }
    window.__root = root; window.__perm = permission; window.__pickerCalls = 0;
    window.showDirectoryPicker = async () => { window.__pickerCalls++; return root; };
    try { localStorage.setItem('lv.libraryAuto', JSON.stringify(auto)); } catch (e) {}
    // 「前回のフォルダを覚えている」状態にする (ハンドルは構造化複製できないため IDB.get を差し替える)
    document.addEventListener('DOMContentLoaded', () => {
      const orig = IDB.get;
      IDB.get = (store, key) => (remembered && store === 'handles' && key === 'library') ? Promise.resolve(window.__root) : orig(store, key);
    }, { once: true });
  }, { seed, permission, auto, remembered });
  await page.goto('file://' + html);
  await page.waitForTimeout(1500);
  return page;
}

// --- 1) 権限が残っていて自動読み込みが有効 → 開いた時点で読み込まれている ---
{
  const page = await openPage({ permission: 'granted', auto: true });
  await page.waitForFunction(() => document.querySelector('#lib-status').textContent.includes('件'), null, { timeout: 15000 });
  check((await page.textContent('#lib-status')).includes('共有ライブラリ'), 'library loaded automatically on open: ' + await page.textContent('#lib-status'));
  check((await page.$$('.lib-card')).length === 1, 'the entry is listed without any click');
  check(await page.evaluate(() => window.__pickerCalls) === 0, 'no folder picker was shown');
  check(await page.$eval('#lib-panel', e => !e.hidden), 'the library tab is shown');
  check(await page.$eval('#lh-connect', e => e.hidden), 'no reconnect button needed');
  check((await page.textContent('#lh-note')).includes('自動で読み込みます'), 'the panel says it auto-loads');
  await page.screenshot({ path: outDir + '/shot-31-autoload.png' });
  await page.close();
}

// --- 2) 自動読み込みを切っていれば読み込まない ---
{
  const page = await openPage({ permission: 'granted', auto: false });
  check((await page.$$('.lib-card')).length === 0, 'nothing is loaded when the setting is off');
  check(await page.$eval('#lib-home', e => !e.hidden), 'the remembered folder is still shown');
  check((await page.textContent('#lh-note')).includes('自動で読み込まない'), 'the panel explains why');
  await page.close();
}

// --- 3) 権限が切れている → フォルダ選択なしの 1 クリックで戻る ---
{
  const page = await openPage({ permission: 'prompt', auto: true });
  check((await page.$$('.lib-card')).length === 0, 'not loaded while the permission is gone');
  check(!(await page.$eval('#lh-connect', e => e.hidden)), 'the reconnect button is offered');
  check((await page.textContent('#lh-note')).includes('毎回このサイトで許可'), 'it tells the user how to make it automatic');
  check(await page.$eval('#lib-home', e => e.classList.contains('needs-connect')), 'the block is highlighted');
  await page.screenshot({ path: outDir + '/shot-32-reconnect.png' });
  await page.click('#lh-connect');
  await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 1, null, { timeout: 15000 });
  check(await page.evaluate(() => window.__requests) === 1, 'it asked for permission once');
  check(await page.evaluate(() => window.__pickerCalls) === 0, 'and never opened the folder picker');
  check((await page.textContent('#lib-status')).includes('1 件'), 'the library is loaded after one click');
  await page.close();
}

// --- 4) 覚えていなければ案内は出ない / 「変更…」ではフォルダを選び直す ---
{
  const page = await openPage({ permission: 'prompt', auto: true, remembered: false });
  check(await page.$eval('#lib-home', e => e.hidden), 'no default-library block when nothing is remembered');
  await page.click('#btn-open-lib');
  await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 1, null, { timeout: 15000 });
  check(await page.evaluate(() => window.__pickerCalls) === 1, 'the picker is used when there is nothing remembered');
  check(await page.$eval('#lib-home', e => !e.hidden), 'it becomes the default library after picking');
  await page.close();
}

// --- 5) 解除すると忘れる ---
{
  const page = await openPage({ permission: 'granted', auto: true });
  await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 1, null, { timeout: 15000 });
  await page.click('#lh-forget');
  await page.waitForSelector('#confirm-dialog[open]');
  check((await page.textContent('#confirm-body')).includes('ファイルは消えません'), 'it says the files are kept');
  await page.click('#confirm-ok');
  await page.waitForTimeout(400);
  check(await page.$eval('#lib-home', e => e.hidden), 'the default library is forgotten');
  check((await page.$$('.lib-card')).length === 0, 'and the list is cleared');
  await page.close();
}

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
console.log('AUTO LIBRARY TEST PASSED');
