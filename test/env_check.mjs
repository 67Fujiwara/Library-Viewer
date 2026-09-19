// file:// と http://localhost で File System Access API / DecompressionStream が使えるかを確認する
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { chromium } from 'playwright';

const html = path.resolve('dist/library-viewer.html');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });

async function probe(url, label) {
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => ({
    secure: window.isSecureContext,
    picker: typeof window.showDirectoryPicker,
    saveFile: typeof window.showSaveFilePicker,
    decomp: typeof DecompressionStream,
    idb: typeof indexedDB,
    ls: (() => { try { localStorage.setItem('t', '1'); return 'ok'; } catch (e) { return e.name; } })(),
    btnDisabled: document.querySelector('#btn-open-lib').disabled,
    status: document.querySelector('#lib-status').textContent,
  }));
  console.log(label, JSON.stringify(r));
  await page.close();
}

await probe('file://' + html, 'file:// ');

const srv = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); fs.createReadStream(html).pipe(res); }).listen(8099);
await probe('http://localhost:8099/', 'http://localhost');
srv.close();
await browser.close();
