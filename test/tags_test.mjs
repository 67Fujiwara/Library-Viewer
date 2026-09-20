// ディレクトリのタグ → 名称・タグで検索 → 右パネルに一覧 → 選ぶとそれだけ表示に残る
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const html = path.resolve('dist/library-viewer.html');
const outDir = path.resolve('test/out');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--allow-file-access-from-files', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
function check(c, m) { if (!c) throw new Error('FAIL: ' + m); console.log('  ok  ' + m); }

const counter = () => page.textContent('#tree-counter');
const hitTitles = () => page.$$eval('#search-list .hit-card .dev > span:first-of-type', ss => ss.map(s => s.textContent.trim()));
const folderRow = (name) => page.locator('.tree-row.group', { hasText: name }).first();

async function menu(row, label) {
  await row.click({ button: 'right' });
  await page.waitForSelector('.ctx-menu');
  await page.locator('.ctx-item', { hasText: label }).first().click();
}
async function setTags(name, value) {
  await menu(folderRow(name), 'タグ');
  await page.waitForSelector('#tags-dialog[open]');
  await page.fill('#tag-input', value);
  await page.click('#tag-save');
  await page.waitForSelector('#tags-dialog[open]', { state: 'detached' }).catch(() => {});
  await page.waitForTimeout(250);
}
async function search(q) {
  await page.fill('#tree-search', q);
  await page.waitForTimeout(350);
}

await page.goto('file://' + html);
await page.waitForTimeout(1200);

// localStorage が使えるか (file:// では失敗しうる。使えるときだけ再読み込みの確認をする)
const canStore = await page.evaluate(() => { Storage.set('lv.probe', 1); return Storage.get('lv.probe', 0) === 1; });
console.log('    localStorage:', canStore ? '使える' : '使えない (永続の確認は飛ばす)');

// 3 件ドロップして、2 つのフォルダーに振り分ける
await page.setInputFiles('#file-input', [
  { name: 'アーム.step', mimeType: 'application/step', buffer: fs.readFileSync('test/out/assembly.step') },
  { name: 'ブラケット.step', mimeType: 'application/step', buffer: fs.readFileSync('test/out/box.step') },
  { name: 'ベース板.step', mimeType: 'application/step', buffer: fs.readFileSync('test/out/holes.step') },
]);
await page.waitForFunction(() => App.devices().length === 3, null, { timeout: 90000 });
await page.waitForSelector('#overlay', { state: 'hidden', timeout: 60000 });
await page.waitForTimeout(400);
const total = (await counter()).match(/\/\s*(\d+)/)[1];   // "5 / 5 表示中" の右側
await page.evaluate(() => {
  Tags.clear();
  Tree.addFolder([], '搬送ユニット'); Tree.addFolder([], '検査ユニット');
  const byName = (n) => Tree.allNodes().find(x => !x.isGroup && x.depth === 0 && x.name === n);
  Tree.moveNode(byName('アーム'), ['搬送ユニット']);
  Tree.moveNode(byName('ブラケット'), ['検査ユニット']);
});
await page.waitForTimeout(300);

// ---- 1. フォルダーにタグを付ける ----
await setTags('搬送ユニット', '搬送 客先A');
await setTags('検査ユニット', '検査, 客先A');
// ダイアログの見た目も 1 枚残す
await menu(folderRow('搬送ユニット'), 'タグ');
await page.waitForSelector('#tags-dialog[open]');
await page.screenshot({ path: outDir + '/shot-36-tag-dialog.png' });
await page.click('#tag-cancel');
await page.waitForTimeout(200);
const chips = await page.locator('.tree-row.group', { hasText: '搬送ユニット' }).locator('.tag').allTextContents();
check(JSON.stringify(chips) === JSON.stringify(['搬送', '客先A']), 'tags show up as chips on the folder row: ' + chips);
check(await page.evaluate(() => JSON.stringify(Tags.get('検査ユニット'))) === '["検査","客先A"]', 'comma separated tags are stored');
await page.screenshot({ path: outDir + '/shot-33-tags.png' });

// ---- 2. タグで検索 → 右パネルに一覧 ----
check(await page.locator('#search-panel').isHidden(), 'the search panel is hidden while nothing is searched');
await search('搬送');
check(await page.locator('#search-panel').isVisible(), 'searching shows the result panel');
check(await page.locator('#xref-panel').isHidden(), '案件横断 gives way to the results');
check((await hitTitles()).includes('搬送ユニット'), 'the tagged folder is listed: ' + await hitTitles());
check((await page.textContent('#search-sum')).includes('フォルダ 1'), 'summary counts the folder hit: ' + await page.textContent('#search-sum'));
check(await page.locator('#search-list .hit-card .badge').first().textContent() === '搬送', 'the card shows which tag matched');
// 名前は「搬送ユニット」なので名称でも当たる。タグでしか当たらない語で確かめる
await search('客先A');
const both = await hitTitles();
check(both.includes('搬送ユニット') && both.includes('検査ユニット'), 'a tag that is in no folder name finds both folders: ' + both);
await page.screenshot({ path: outDir + '/shot-34-search-tag.png' });

// ---- 3. 名称でも当たる ----
await search('ベース');
check((await hitTitles()).includes('ベース板'), 'searching a device name finds the device: ' + await hitTitles());
check((await page.textContent('#search-sum')).includes('装置 1'), 'the device hit is counted as 装置');
await search('COLUMN');   // STEP 内部の部品名
check((await page.textContent('#search-sum')).match(/部品 [1-9]/), 'part names are searched too: ' + await page.textContent('#search-sum'));

// ---- 4. 一覧から選ぶ → それだけ残り、関係ない部品はチェックが外れる ----
await search('客先A');
await page.locator('#search-list .hit-card', { hasText: '搬送ユニット' }).first().click();
await page.waitForTimeout(400);
check((await counter()).startsWith('3 / ' + total), 'only the solids under the chosen folder stay visible: ' + await counter());
const off = await page.evaluate(() => Tree.allNodes()
  .filter(n => !n.isGroup && n.depth === 0)
  .map(n => ({ name: n.name, on: n.leaves.some(l => l.visible) })));
check(off.find(d => d.name === 'アーム').on, 'the device inside the chosen folder is still checked');
check(!off.find(d => d.name === 'ブラケット').on && !off.find(d => d.name === 'ベース板').on, 'unrelated devices are unchecked: ' + JSON.stringify(off));
check(await page.evaluate(() => Viewer3D.leavesOf(Tree.allNodes().find(n => n.name === 'ブラケット')).every(l => !l.mesh.visible)),
  'the unrelated meshes are actually hidden in 3D');
check(await page.locator('#search-list .hit-card.current').count() === 1, 'the chosen card is marked');
await page.screenshot({ path: outDir + '/shot-35-isolated.png' });

// 「すべて表示に戻す」で元へ
await page.click('#search-showall');
await page.waitForTimeout(300);
check((await counter()).startsWith(total + ' / ' + total), 'すべて表示に戻す brings everything back: ' + await counter());

// 部品を選んだときは装置の中の 1 部品だけが残る
await search('COLUMN');
if ((await hitTitles()).length) {
  await page.locator('#search-list .hit-card').first().click();
  await page.waitForTimeout(400);
  const shown = Number((await counter()).split('/')[0].trim());
  check(shown >= 1 && shown < Number(total), 'choosing a part isolates it: ' + await counter());
  check(await page.evaluate(() => !!App.selected()), 'choosing a part also selects it (footer shows it)');
}

// ---- 5. タグのチップを押すとそのタグで検索 ----
await page.click('#search-clear');
await page.waitForTimeout(300);
await page.click('#btn-show-all');
await page.locator('.tree-row.group', { hasText: '検査ユニット' }).locator('.tag', { hasText: '検査' }).click();
await page.waitForTimeout(400);
check(await page.inputValue('#tree-search') === '検査', 'clicking a tag chip searches that tag');
check((await hitTitles()).includes('検査ユニット'), 'and the folder is listed: ' + await hitTitles());

// ---- 6. 検索をやめると案件横断に戻る ----
await page.click('#search-clear');
await page.waitForTimeout(300);
check(await page.inputValue('#tree-search') === '', 'the search box is cleared');
check(await page.locator('#search-panel').isHidden() && await page.locator('#xref-panel').isVisible(), '案件横断 comes back');

// ---- 7. 検索欄は右サイドバーの中。畳んでいても / で開いて飛べる ----
check(await page.evaluate(() => document.querySelector('#tree-search').closest('aside').id) === 'right', 'the search box lives in the right sidebar');
check(await page.$('#tree-panel .search-row') === null, 'and is gone from the left panel');
await page.click('#btn-toggle-right');
await page.waitForTimeout(300);
check(await page.evaluate(() => !Panels.isOpen('right')), 'right panel collapsed by the user');
await page.click('#gl', { position: { x: 700, y: 700 } });   // 3D にフォーカスを移してからキーを送る
await page.keyboard.press('/');
await page.waitForTimeout(400);
check(await page.evaluate(() => Panels.isOpen('right')), '"/" opens the right panel');
check(await page.evaluate(() => document.activeElement.id) === 'tree-search', 'and puts the cursor in the search box');
await page.keyboard.type('客先A');
await page.waitForTimeout(400);
check((await hitTitles()).length === 2, 'typing right after "/" searches: ' + await hitTitles());
await page.click('#search-clear');
await page.waitForTimeout(400);
check(await page.evaluate(() => Panels.isOpen('right')), 'ending the search leaves the panel open (the search box lives there)');

// ---- 8. 改名してもタグは付いてくる (フォルダの id はパスから作られる) ----
await folderRow('検査ユニット').click();
await page.keyboard.press('F2');
await page.waitForSelector('.rename-input');
await page.fill('.rename-input', '検査ユニット2');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
check(await page.evaluate(() => JSON.stringify(Tags.get('検査ユニット2'))) === '["検査","客先A"]', 'tags follow a rename');
check(await page.evaluate(() => Tags.get('検査ユニット').length) === 0, 'and are gone from the old path');
await search('客先A');
check((await hitTitles()).includes('検査ユニット2'), 'the renamed folder is still found by its tag: ' + await hitTitles());

// 移動でも付いてくる
await page.evaluate(() => Tree.moveNode(Tree.nodeById('g:検査ユニット2'), ['搬送ユニット']));
await page.waitForTimeout(300);
check(await page.evaluate(() => JSON.stringify(Tags.get('搬送ユニット/検査ユニット2'))) === '["検査","客先A"]', 'tags follow a move into another folder');

// ---- 9. 読み込み直してもタグは残る ----
if (canStore) {
  await page.reload();
  await page.waitForTimeout(1200);
  const back = await page.evaluate(() => JSON.stringify(Tags.get('搬送ユニット/検査ユニット2')));
  check(back === '["検査","客先A"]', 'tags survive a reload (stored per folder path): ' + back);
}

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
console.log('TAGS TEST PASSED');
