import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--allow-file-access-from-files', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const f = 'test/out/big120.step';
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
let crashed = false;
page.on('crash', () => { crashed = true; });
await page.goto('file://' + path.resolve('dist/library-viewer.html'));
await page.waitForTimeout(1200);
const t = Date.now();
await page.setInputFiles('#file-input', [path.resolve(f)]);
let out = 'TIMEOUT';
try {
  out = await page.waitForFunction(() => {
    if (App.devices().length) return 'OK ' + App.devices()[0].model.meshes.length + ' solids';
    const d = document.querySelector('#msg-dialog');
    if (d && d.open) return 'DIALOG: ' + document.querySelector('#msg-body').textContent.replace(/\n/g, ' | ');
    return null;
  }, null, { timeout: 5400000 }).then(h => h.jsonValue());
} catch (e) { out = crashed ? 'PAGE CRASH (メモリ不足でタブが落ちた)' : String(e.message).slice(0, 80); }
console.log(`  ${path.basename(f)}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB  ${((Date.now() - t) / 1000).toFixed(0)} s  → ${out}`);
await browser.close();
