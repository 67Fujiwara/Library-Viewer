// 左右サイドバーの開閉。ユーザーの環境に近い 953x860 の窓で確認する。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const html = path.resolve('dist/library-viewer.html');
const outDir = path.resolve('test/out'); fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--allow-file-access-from-files', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 953, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
function check(c, m) { if (!c) throw new Error('FAIL: ' + m); console.log('  ok  ' + m); }
const widths = () => page.evaluate(() => ({
  left: document.querySelector('#left').getBoundingClientRect().width,
  right: document.querySelector('#right').getBoundingClientRect().width,
  view: document.querySelector('#viewport').getBoundingClientRect().width,
  canvas: document.querySelector('#gl').getBoundingClientRect().width,
  headerH: document.querySelector('#header').getBoundingClientRect().height,
}));

await page.goto('file://' + html);
await page.waitForTimeout(1200);
await page.setInputFiles('#file-input', [{ name: 'P2026-001_検査装置A_ワークX_設計1課_山田.step', mimeType: 'application/step', buffer: fs.readFileSync('test/out/assembly.step') }]);
await page.waitForFunction(() => App.devices().length === 1, null, { timeout: 60000 });
await page.waitForTimeout(400);

// 狭い窓ではヘッダーが 1 行に収まり、右パネルは初期状態で畳まれている
let w = await widths();
check(w.headerH <= 60, 'header stays one row at 953px (h=' + w.headerH + ')');
check(w.right === 0, 'right panel auto-collapsed on a narrow window');
check(await page.$eval('#edge-right', e => !e.hidden), 'right edge handle shown while collapsed');
await page.screenshot({ path: outDir + '/shot-11-narrow-default.png' });

// 左を畳む → 3D が広がる
const before = w.view;
await page.click('#btn-toggle-left');
await page.waitForTimeout(400);
w = await widths();
check(w.left === 0, 'left panel collapsed');
check(w.view > before + 300, '3D view widened by ' + Math.round(w.view - before) + 'px');
check(Math.abs(w.canvas - w.view) < 2, 'canvas resized with the viewport');
check(await page.evaluate(() => document.querySelector('#gl').width > 0), 'renderer still has a drawing buffer');
await page.screenshot({ path: outDir + '/shot-12-both-collapsed.png' });

// 端のハンドルで開く
await page.click('#edge-left');
await page.waitForTimeout(400);
check((await widths()).left > 300, 'left panel reopened from the edge handle');
check(await page.$eval('#edge-left', e => e.hidden), 'edge handle hidden once open');

// キーボード [ ]
await page.click('#gl', { position: { x: 400, y: 500 } });
await page.keyboard.press('[');
await page.waitForTimeout(300);
check((await widths()).left === 0, '"[" collapses the left panel');
await page.keyboard.press(']');
await page.waitForTimeout(300);
check((await widths()).right > 200, '"]" opens the right panel');

// 入力欄の中では [ ] がショートカットにならない
await page.keyboard.press('[');   // 左を開き直す
await page.waitForTimeout(300);
check((await widths()).left > 300, 'left panel reopened with "["');
await page.click('#tree-search');
await page.keyboard.type('[[');
check((await page.inputValue('#tree-search')) === '[[', '"[" typed into a text field is not a shortcut');
check((await widths()).left > 300, 'left panel unchanged while typing');
await page.fill('#tree-search', '');

// 畳んだ状態は尊重される: 3D で部品を選んでも勝手に開かない
await page.click('#btn-toggle-left');
await page.waitForTimeout(300);
check((await widths()).left === 0, 'left panel collapsed again');
await page.click('#gl', { position: { x: 400, y: 500 } });
await page.waitForTimeout(300);
check((await widths()).left === 0, 'clicking a part in 3D does not reopen the collapsed panel');
check((await page.textContent('#sel-info')).indexOf('未選択') < 0, 'selection still works while collapsed');

// 状態が再読み込み後も残る
await page.click('#btn-toggle-right');
await page.waitForTimeout(300);
const saved = await page.evaluate(() => localStorage.getItem('lv.panels'));
check(saved === '{"left":false,"right":false}', 'state saved to localStorage: ' + saved);
await page.reload();
await page.waitForTimeout(1200);
w = await widths();
check(w.left === 0 && w.right === 0, 'both panels still collapsed after reload');
await page.screenshot({ path: outDir + '/shot-13-restored.png' });

// 広い窓では既定で両方開く
const wide = await ctx.newPage();
await wide.evaluate(() => {}).catch(() => {});
await wide.addInitScript(() => { try { localStorage.removeItem('lv.panels'); } catch (e) {} });
await wide.setViewportSize({ width: 1600, height: 900 });
await wide.goto('file://' + html);
await wide.waitForTimeout(1200);
const ww = await wide.evaluate(() => ({ l: document.querySelector('#left').getBoundingClientRect().width, r: document.querySelector('#right').getBoundingClientRect().width }));
check(ww.l > 300 && ww.r > 200, 'wide window opens both panels by default');
await wide.close();

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
console.log('PANELS TEST PASSED');
