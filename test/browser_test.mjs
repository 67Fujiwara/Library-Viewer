// dist/library-viewer.html を file:// で開き、STEP 読み込み〜ツリー〜格納 (ZIP) まで実機確認する
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const html = path.resolve('dist/library-viewer.html');
const outDir = path.resolve('test/out'); fs.mkdirSync(outDir, { recursive: true });
const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium'
  : fs.readdirSync('/opt/pw-browsers').filter(d => /^chromium-\d+$/.test(d)).map(d => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find(p => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--allow-file-access-from-files', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

function check(cond, msg) { if (!cond) { throw new Error('FAIL: ' + msg); } console.log('  ok  ' + msg); }

await page.goto('file://' + html);
await page.waitForTimeout(1500);
check(await page.title() === 'Library Viewer', 'title');
check(await page.$eval('html', h => h.dataset.theme) !== undefined, 'theme attribute set');

// STEP 読み込み (2 装置)
await page.setInputFiles('#file-input', ['test/out/assembly.step', 'test/out/assembly_b.step']);
await page.waitForSelector('#overlay', { state: 'hidden', timeout: 60000 });
await page.waitForTimeout(500);
const rows = await page.$$eval('.tree-row', rs => rs.map(r => r.querySelector('.name').textContent));
console.log('  tree rows:', rows.join(' | '));
check(rows.length === 10, 'tree has 10 rows (2 devices × 5 nodes)');
check(rows.includes('assembly') && rows.includes('ARM_UNIT') && rows.includes('HEAD_UNIT'), 'device row uses the file name, inner hierarchy keeps the STEP names');
check((await page.textContent('#tree-counter')).includes('6 / 6'), 'counter 6 / 6');
await page.screenshot({ path: outDir + '/shot-1-loaded.png' });

// チェックボックスで非表示 → 親が indeterminate
const armRow = page.locator('.tree-row', { hasText: 'ARM_UNIT' }).first();
await page.locator('.tree-row', { hasText: 'COLUMN' }).first().locator('input[type=checkbox]').click();
await page.waitForTimeout(200);
check((await page.textContent('#tree-counter')).includes('5 / 6'), 'counter 5 / 6 after hiding COLUMN');
check(await armRow.locator('input[type=checkbox]').evaluate(c => c.indeterminate), 'ARM_UNIT checkbox indeterminate');
check(await page.locator('.tree-row.device', { hasText: 'assembly' }).first().locator('input[type=checkbox]').evaluate(c => c.indeterminate), 'device row indeterminate');
// 開閉
await armRow.locator('.twisty').click(); await page.waitForTimeout(100);
check(await page.locator('.tree-row', { hasText: 'COLUMN' }).first().isHidden(), 'collapse hides COLUMN row');
await armRow.locator('.twisty').click(); await page.waitForTimeout(100);
check(await page.locator('.tree-row', { hasText: 'COLUMN' }).first().isVisible(), 'expand shows COLUMN row');
// 検索
await page.fill('#tree-search', 'head'); await page.waitForTimeout(300);
check(await page.locator('.tree-row', { hasText: 'BASE_PLATE' }).first().isHidden() && await page.locator('.tree-row', { hasText: 'HEAD_UNIT' }).first().isVisible(), 'search filters rows');
await page.fill('#tree-search', ''); await page.waitForTimeout(300);

// 選択 → フッターと横断パネル
await page.locator('.tree-row', { hasText: 'HEAD_UNIT' }).first().locator('button.name').click();
await page.waitForTimeout(200);
check((await page.textContent('#sel-info')).includes('HEAD_UNIT'), 'footer shows selected HEAD_UNIT');
const xrefCards = await page.$$('.xref-card');
check(xrefCards.length === 1, 'xref panel lists 1 same-name unit in other device');
check((await page.textContent('.xref-card .dev')) === 'assembly_b', 'xref card points at the other file');
const badge = await page.locator('.tree-row', { hasText: 'HEAD_UNIT' }).first().locator('.badge').textContent();
check(badge === '+1', 'tree badge +1');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(200);
check((await page.textContent('#sel-info')).includes('assembly_b'), '→ key moved selection to the other device');
await page.screenshot({ path: outDir + '/shot-2-selected.png' });

// 表示モード・エッジ・断面
await page.click('label[for="vm-xray"]'); await page.waitForTimeout(100);
await page.click('label[for="chk-edges"]'); await page.waitForTimeout(300);
await page.click('label[for="vm-section"]'); await page.waitForTimeout(100);
check(!(await page.$eval('#section-ctl', e => e.hidden)), 'section controls shown');
await page.fill('#sec-pos', '300'); await page.dispatchEvent('#sec-pos', 'input');
await page.waitForTimeout(200);
await page.screenshot({ path: outDir + '/shot-3-section-edges.png' });
await page.click('label[for="vm-normal"]');

// ダークテーマ (3D 側の連動も含めて画面が変わること)
await page.click('label[for="theme-dark"]');
await page.waitForTimeout(400);
check(await page.$eval('html', h => h.dataset.theme) === 'dark', 'dark theme applied');
await page.screenshot({ path: outDir + '/shot-4-dark.png' });
await page.click('label[for="theme-light"]');
await page.waitForTimeout(400);
check(await page.$eval('html', h => h.dataset.theme) === 'light', 'light theme applied');
await page.screenshot({ path: outDir + '/shot-4b-light.png' });

// 格納ダイアログ → ZIP
await page.click('#btn-store');
await page.waitForSelector('#store-dialog[open]');
await page.fill('#st-project', 'P2026-001');
await page.fill('#st-device', '検査装置A');
await page.fill('#st-work', 'ワークX');
await page.click('#st-roster button.dept >> nth=0');
await page.click('#st-roster label.member >> nth=0');
const preview = await page.textContent('#st-preview');
console.log('  preview:', preview);
check(preview === 'models/設計1課/P2026-001_検査装置A/ワークX/', 'path preview');
await page.selectOption('#st-layout', '2');
check((await page.textContent('#st-preview')) === 'models/ワークX/P2026-001_検査装置A/', 'layout 3 preview');
await page.selectOption('#st-layout', '0');
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#st-save')]);
const zipPath = outDir + '/browser-store.zip';
await download.saveAs(zipPath);
fs.rmSync(outDir + '/browser-unz', { recursive: true, force: true });
const listing = execSync(`cd ${outDir} && unzip -o -q browser-store.zip -d browser-unz && find browser-unz -type f | sort`).toString();
console.log(listing);
check(listing.includes('browser-unz/models/設計1課/P2026-001_検査装置A/ワークX/assembly.glb'), 'zip contains glb at Japanese path');
check(listing.includes('/step/assembly_b.step') && listing.includes('/meta.json') && listing.includes('/index.json'), 'zip contains step/meta/index');
const meta = JSON.parse(fs.readFileSync(outDir + '/browser-unz/models/設計1課/P2026-001_検査装置A/ワークX/meta.json', 'utf8'));
check(meta.owner === '山田' && meta.files.length === 2 && meta.files[0].triangles === 36, 'meta.json content');
await page.waitForTimeout(300);
await page.screenshot({ path: outDir + '/shot-5-stored.png' });

// 再変換 (精度変更)
await page.keyboard.press('Escape');
await page.selectOption('#precision', 'coarse');
await page.click('#btn-remesh');
await page.waitForSelector('#overlay', { state: 'hidden', timeout: 60000 });
check((await page.$$('.tree-row')).length === 10, 'tree rebuilt after remesh');

// ツリーの装置行「閉じる」でその装置だけ表示から外す
check((await page.$$('.tree-row.device')).length === 2, '2 devices loaded');
await page.locator('.tree-row.device', { hasText: 'assembly' }).first().locator('button.close').click();
await page.waitForTimeout(300);
const left = await page.$$eval('.tree-row.device .name', r => r.map(x => x.textContent));
check(left.length === 1 && left[0] === 'assembly_b', 'closing the first device leaves only the other: ' + left);
check((await page.textContent('#tree-counter')).includes('3 / 3'), 'counter reflects the remaining device');
check(await page.evaluate(() => App.devices().length) === 1, 'App state has one device');
check((await page.textContent('#sel-info')).includes('assembly_b'), 'selection kept: it belongs to the device still open');
await page.screenshot({ path: outDir + '/shot-19-closed.png' });

// 選択していた部品の装置を閉じたら選択は解除される
await page.locator('.tree-row.device', { hasText: 'assembly_b' }).first().locator('button.close').click();
await page.waitForTimeout(300);
check((await page.textContent('#sel-info')).includes('未選択'), 'selection cleared when its own device is closed');
check((await page.$$('.tree-row')).length === 0, 'tree is empty after closing every device');
check(await page.$('#tree-empty') === null, 'no leftover hint text in the tree panel');
check(await page.$eval('#btn-store', e => e.disabled), '格納する disabled with nothing loaded');
check(!(await page.$eval('#drop-hint', e => e.hidden)), 'drop hint shown again');

// ネーミングルール一致のファイル → 格納ダイアログが自動入力される
await page.evaluate(() => App.clearDevices());
// 日本語ファイル名は Playwright がパスで渡せないのでバッファで渡す (ブラウザ側は実運用と同じ)
await page.setInputFiles('#file-input', [{ name: 'P2026-009_試験機F_ワークZ_生産技術_高橋.step', mimeType: 'application/step', buffer: fs.readFileSync('test/out/box.step') }]);
await page.waitForFunction(() => App.devices().length === 1, null, { timeout: 60000 });
await page.waitForSelector('#overlay', { state: 'hidden', timeout: 60000 });
await page.click('#btn-store');
await page.waitForSelector('#store-dialog[open]');
check(await page.inputValue('#st-project') === 'P2026-009' && await page.inputValue('#st-device') === '試験機F' && await page.inputValue('#st-work') === 'ワークZ', 'store dialog prefilled from file name');
check((await page.textContent('#st-owner-view')) === '生産技術 / 高橋', 'owner prefilled from file name');
check((await page.textContent('#st-preview')) === 'models/生産技術/P2026-009_試験機F/ワークZ/', 'path derived from naming rule');
check((await page.textContent('#st-naming')).includes('自動入力'), 'naming note shown');
await page.screenshot({ path: outDir + '/shot-8-prefill.png' });
await page.click('#st-cancel');

const realErrors = errors.filter(e => !/GPU|swiftshader|WebGL|GroupMarkerNotSet|Automatic fallback/i.test(e));
console.log('console errors:', realErrors.length ? realErrors : 'none');
await browser.close();
if (realErrors.length) process.exit(1);
console.log('BROWSER TEST PASSED');
