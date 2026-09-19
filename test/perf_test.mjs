// 重い STEP の読み込み性能: 並列ワーカー と 変換キャッシュ の効果を実測する。
//
// 計測の注意: File を base64 から作る処理は重いので必ず計測の外でやる。
// キャッシュの鍵は名前・サイズ・更新日時・精度なので、lastModified を固定して作る。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const outDir = path.resolve('test/out');
if (!fs.existsSync(path.join(outDir, 'heavy.step'))) {
  console.error('先に `python3 tools/gen_test_step.py --heavy 150 test/out/heavy.step` を実行してください');
  process.exit(1);
}
const heavyB64 = fs.readFileSync(path.join(outDir, 'heavy.step')).toString('base64');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--allow-file-access-from-files', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
function check(c, m) { if (!c) throw new Error('FAIL: ' + m); console.log('  ok  ' + m); }

await page.goto('file://' + path.resolve('dist/library-viewer.html'));
await page.waitForFunction(() => typeof Occt !== 'undefined' && Occt.workers() > 0, null, { timeout: 60000 });
const cores = await page.evaluate(() => navigator.hardwareConcurrency);
console.log(`    コア ${cores} / ワーカー上限 ${await page.evaluate(() => Occt.maxWorkers)}`);
check(await page.evaluate(() => Occt.workers()) >= 1, 'a conversion worker is up before any file is opened');

await page.evaluate((b64) => {
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  window.__mk = (name) => new File([bin], name, { lastModified: 1700000000000 });   // 復号は 1 回だけ
}, heavyB64);

/* names のファイルを読み込み、所要時間(ms)を返す。File 生成は計測の外 */
async function load(names) {
  await page.evaluate(() => App.clearDevices());
  await page.waitForTimeout(150);
  return await page.evaluate(async (names) => {
    const entries = names.map(n => ({ file: window.__mk(n), name: n, rel: [] }));
    const t = performance.now();
    await App.loadEntries(entries);
    return Math.round(performance.now() - t);
  }, names);
}

// --- 1 件: 初回 (変換) と 2 回目 (キャッシュ) ---
const first = await load(['heavy.step']);
console.log(`    重い STEP 1 件 初回: ${first} ms`);
check(await page.evaluate(() => App.devices()[0].model.meshes.length) === 150, '150 solids loaded');
const second = await load(['heavy.step']);
console.log(`    同じファイル 2 回目: ${second} ms  (${(first / second).toFixed(0)}x)`);
check(second < first / 10, `cache is far faster (${first} ms → ${second} ms)`);
check((await page.textContent('#load-note')).includes('再利用'), 'the note says the cache was used');
check(await page.$eval('#overlay', e => e.hidden), 'no overlay is shown when everything is cached');

// --- 変換中に UI が固まらない ---
await page.evaluate(() => App.clearDevices());
await page.evaluate(() => {
  window.__ticks = 0; window.__stop = false; window.__t0 = performance.now();
  (function tick() { window.__ticks++; if (!window.__stop) requestAnimationFrame(tick); })();
});
await page.evaluate(async () => { await App.loadEntries([{ file: window.__mk('resp.step'), name: 'resp.step', rel: [] }]); });
const fps = await page.evaluate(() => { window.__stop = true; return window.__ticks / ((performance.now() - window.__t0) / 1000); });
console.log(`    変換中の描画: ${fps.toFixed(1)} fps`);
check(fps > 10, `UI keeps animating during conversion (${fps.toFixed(1)} fps)`);

// --- 複数ファイル: できた端から画面に出る (全部終わるまで待たせない) ---
await page.evaluate(() => App.clearDevices());
await page.waitForTimeout(150);
const progressive = await page.evaluate(async () => {
  const names = ['p1.step', 'p2.step', 'p3.step'];
  const entries = names.map(n => ({ file: window.__mk(n), name: n, rel: [] }));
  const t = performance.now();
  let firstAt = null;
  const iv = setInterval(() => { if (firstAt === null && App.devices().length > 0) firstAt = Math.round(performance.now() - t); }, 50);
  await App.loadEntries(entries);
  clearInterval(iv);
  return { total: Math.round(performance.now() - t), firstAt: firstAt, n: App.devices().length, workers: Occt.workers() };
});
console.log(`    重い STEP 3 件: 全体 ${progressive.total} ms / 最初の 1 件が出るまで ${progressive.firstAt} ms / ワーカー ${progressive.workers} 本`);
check(progressive.n === 3, '3 devices loaded');
check(progressive.workers > 1, `the pool grew to ${progressive.workers} workers`);
check(progressive.firstAt < progressive.total * 0.8,
  `the first model shows up well before the batch finishes (${progressive.firstAt} ms of ${progressive.total} ms)`);

// --- 精度を変えるとキャッシュは当たらない (当たってはいけない) ---
await page.selectOption('#precision', 'coarse');
const other = await load(['heavy.step']);
console.log(`    同じファイルを別の精度で: ${other} ms`);
check(other > second * 5, `a different precision must miss the cache (${other} ms)`);
await page.selectOption('#precision', 'standard');

const stats = await page.evaluate(() => ConvCache.stats());
console.log(`    キャッシュ: ${stats.count} 件 ${(stats.bytes / 1048576).toFixed(1)} MB`);
check(stats.count >= 3, 'entries stored in the cache');
check(await page.evaluate(async () => (await ConvCache.clear()) > 0), 'the cache can be cleared');
const afterClear = await load(['heavy.step']);
console.log(`    キャッシュを消した後: ${afterClear} ms`);
check(afterClear > second * 5, 'clearing the cache really empties it');

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
console.log('PERF TEST PASSED');
