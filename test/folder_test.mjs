// フォルダごと渡したとき: STEP だけを読み、フォルダ構成をそのままツリーにする
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const html = path.resolve('dist/library-viewer.html');
const outDir = path.resolve('test/out');
const SRC = path.join(outDir, 'tree-src');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--allow-file-access-from-files', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
function check(c, m) { if (!c) throw new Error('FAIL: ' + m); console.log('  ok  ' + m); }

// フォルダ配下を {webkitRelativePath, buffer} として渡す (Playwright は日本語パスを渡せないため)
const files = [];
(function walk(dir, rel) {
  for (const n of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, n), r = rel + '/' + n;
    if (fs.statSync(p).isDirectory()) walk(p, r);
    else files.push({ rel: r, b64: fs.readFileSync(p).toString('base64') });
  }
})(SRC, 'tree-src');
console.log('  渡すファイル:', files.map(f => f.rel).join('\n                '));

await page.goto('file://' + html);
await page.waitForTimeout(1200);

// <input webkitdirectory> と同じ形 (webkitRelativePath 付き) の FileList を流し込む
await page.evaluate((files) => {
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = Uint8Array.from(atob(f.b64), c => c.charCodeAt(0));
    const file = new File([bin], f.rel.split('/').pop());
    Object.defineProperty(file, 'webkitRelativePath', { value: f.rel });
    dt.items.add(file);
  }
  const input = document.querySelector('#dir-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, files);
await page.waitForFunction(() => App.devices().length === 5, null, { timeout: 90000 });
await page.waitForSelector('#overlay', { state: 'hidden', timeout: 60000 });
await page.waitForTimeout(500);

// STEP だけが読まれている (.txt / .md / .glb は無視)
const names = await page.evaluate(() => App.devices().map(d => d.fileName));
console.log('   ', JSON.stringify(names));
check(names.length === 5, 'only the 5 STEP files were loaded, other file types ignored');
check(!names.some(n => /\.(txt|md|glb)$/i.test(n)), 'no .txt / .md / .glb was loaded');

// フォルダ構成がそのままツリーになっている
const rows = await page.$$eval('.tree-row', rs => rs.map(r => ({
  group: r.classList.contains('group'),
  device: r.classList.contains('device'),
  indent: parseInt(r.style.paddingLeft, 10),
  name: r.querySelector('.name').textContent.trim(),
})));
const shape = rows.filter(r => r.group || r.device).map(r => '  '.repeat((r.indent - 6) / 16) + (r.group ? '[' + r.name + ']' : r.name));
console.log('    ツリー:\n' + shape.map(s => '      ' + s).join('\n'));
check(rows.some(r => r.group && r.name === 'tree-src' && r.indent === 6), 'root folder is the top group');
check(rows.some(r => r.group && r.name === '装置A' && r.indent === 22), '装置A folder nested one level in');
check(rows.some(r => r.group && r.name === 'ユニット1' && r.indent === 38), 'ユニット1 nested two levels in');
check(rows.some(r => r.device && r.name === 'アーム' && r.indent === 54), 'device sits under its folder, named after the file');
const devNames = rows.filter(r => r.device).map(r => r.name).sort();
check(JSON.stringify(devNames) === JSON.stringify(['アーム', 'カバー', 'ブラケット', 'ベース板', '直下部品'].sort()),
  'devices are named after their files, not the STEP internal name: ' + devNames);
check(!rows.some(r => r.group && r.name === '図面'), 'folder without any STEP is not shown');
check((await page.textContent('#load-note')).includes('STEP 以外'), 'note says non-STEP files were skipped');
await page.screenshot({ path: outDir + '/shot-22-folder-tree.png' });

// フォルダのチェックで配下をまとめて表示 / 非表示
const counter = () => page.textContent('#tree-counter');
// アーム(3 ソリッド) + ブラケット + カバー + ベース板 + 直下部品 = 7
check((await counter()).startsWith('7 / 7'), 'all solids visible at first: ' + await counter());
await page.locator('.tree-row.group', { hasText: '装置A' }).locator('input[type=checkbox]').click();
await page.waitForTimeout(200);
check((await counter()).startsWith('2 / 7'), 'unchecking 装置A hid its 5 solids: ' + await counter());
check(await page.locator('.tree-row.group', { hasText: 'tree-src' }).locator('input[type=checkbox]').evaluate(c => c.indeterminate), 'root folder is indeterminate');
await page.locator('.tree-row.group', { hasText: '装置A' }).locator('input[type=checkbox]').click();
await page.waitForTimeout(200);
check((await counter()).startsWith('7 / 7'), 're-checking restores them');

// フォルダの開閉
await page.locator('.tree-row.group', { hasText: 'ユニット1' }).locator('.twisty').click();
await page.waitForTimeout(200);
check(await page.locator('.tree-row.device', { hasText: 'アーム' }).first().isHidden(), 'collapsing a folder hides the devices inside');
await page.locator('.tree-row.group', { hasText: 'ユニット1' }).locator('button.name').click();
await page.waitForTimeout(200);
check(await page.locator('.tree-row.device', { hasText: 'アーム' }).first().isVisible(), 'clicking the folder name expands it again');

// フォルダの × で配下の装置をまとめて閉じる
await page.locator('.tree-row.group', { hasText: '装置A' }).locator('button.close').click();
await page.waitForTimeout(400);
check(await page.evaluate(() => App.devices().length) === 2, 'closing 装置A removed its 3 devices');
check(!(await page.$$eval('.tree-row.group', rs => rs.map(r => r.querySelector('.name').textContent.trim()))).includes('装置A'), '装置A folder is gone from the tree');
check((await page.$$eval('.tree-row.group', rs => rs.map(r => r.querySelector('.name').textContent.trim()))).includes('装置B'), '装置B folder remains');
await page.screenshot({ path: outDir + '/shot-23-folder-closed.png' });

// ---- ドロップ経路: フォルダのハンドル / 旧 entry API のどちらからも同じ結果になる ----
for (const mode of ['handle', 'entry']) {
  await page.evaluate(() => App.clearDevices());
  await page.waitForTimeout(200);
  const n = await page.evaluate(async ([files, mode]) => {
    const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    // 渡されたパス一覧から、偽のフォルダツリーを組み立てる
    const root = { name: 'tree-src', dirs: new Map(), files: new Map() };
    for (const f of files) {
      const parts = f.rel.split('/').slice(1);          // 先頭の 'tree-src' は root 自身
      let d = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!d.dirs.has(parts[i])) d.dirs.set(parts[i], { name: parts[i], dirs: new Map(), files: new Map() });
        d = d.dirs.get(parts[i]);
      }
      d.files.set(parts.at(-1), new File([b64(f.b64)], parts.at(-1)));
    }
    function asHandle(node) {
      return {
        kind: 'directory', name: node.name,
        async *entries() {
          for (const [n2, f] of node.files) yield [n2, { kind: 'file', name: n2, async getFile() { return f; } }];
          for (const [n2, d] of node.dirs) yield [n2, asHandle(d)];
        }
      };
    }
    function asEntry(node) {
      const kids = [...node.files].map(([n2, f]) => ({ isFile: true, isDirectory: false, name: n2, file: cb => cb(f) }))
        .concat([...node.dirs].map(([, d]) => asEntry(d)));
      return {
        isFile: false, isDirectory: true, name: node.name,
        createReader() { let done = false; return { readEntries: cb => { cb(done ? [] : kids); done = true; } }; }
      };
    }
    return mode === 'handle' ? App.loadFolders([asHandle(root)], []) : App.loadFolders([], [asEntry(root)]);
  }, [files, mode]);
  check(n === 5, `drop via ${mode}: 5 STEP files loaded (other types ignored)`);
  const groups = await page.$$eval('.tree-row.group', rs => rs.map(r => r.querySelector('.name').textContent.trim()));
  check(JSON.stringify(groups) === JSON.stringify(['tree-src', '装置A', 'ユニット1', 'ユニット2', '装置B']),
    `drop via ${mode}: folder hierarchy rebuilt: ` + groups);
}

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
console.log('FOLDER TEST PASSED');
