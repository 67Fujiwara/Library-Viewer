// ドロップした STEP をビューア上で整理する (フォルダ作成 / 移動 / 名前変更)。VS Code 風の操作。
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

// ツリーの見た目 (インデント込み) を文字列で取る
const shape = () => page.$$eval('.tree-row', rs => rs
  .filter(r => r.classList.contains('group') || r.classList.contains('device'))
  .map(r => '  '.repeat((parseInt(r.style.paddingLeft, 10) - 6) / 16) + (r.classList.contains('group') ? '[' + r.querySelector('.name').textContent.trim() + ']' : r.querySelector('.name').textContent.trim()))
  .join('\n'));
const show = async (t) => console.log('    ' + t + ':\n' + (await shape()).split('\n').map(l => '      ' + l).join('\n'));

await page.goto('file://' + html);
await page.waitForTimeout(1200);

// 同じ階層に 3 つの STEP を落とす (ドロップした直後の状態)
await page.setInputFiles('#file-input', [
  { name: 'アーム.step', mimeType: 'application/step', buffer: fs.readFileSync('test/out/assembly.step') },
  { name: 'ブラケット.step', mimeType: 'application/step', buffer: fs.readFileSync('test/out/box.step') },
  { name: 'ベース板.step', mimeType: 'application/step', buffer: fs.readFileSync('test/out/holes.step') },
]);
await page.waitForFunction(() => App.devices().length === 3, null, { timeout: 90000 });
await page.waitForSelector('#overlay', { state: 'hidden', timeout: 60000 });
await page.waitForTimeout(400);
check((await shape()).split('\n').every(l => !l.startsWith('  ')), 'dropped files all sit at the same level');
await show('ドロップ直後');
await page.screenshot({ path: outDir + '/shot-24-flat.png' });

// 新規フォルダ → その場で名前を入力できる
await page.click('#btn-new-folder');
await page.waitForSelector('.rename-input');
check(await page.inputValue('.rename-input') === '新しいフォルダー', 'new folder starts in rename mode');
await page.fill('.rename-input', '装置A');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
check((await shape()).includes('[装置A]'), 'folder created and renamed');

// フォルダの中にさらにフォルダ (選択中のフォルダの下に作られる)
await page.click('#btn-new-folder');
await page.fill('.rename-input', 'ユニット1');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
check((await shape()).includes('[装置A]\n  [ユニット1]'), 'nested folder created inside the selected one');

// ドラッグで装置をフォルダへ入れる
async function dragRow(fromText, toText) {
  const from = page.locator('.tree-row', { hasText: fromText }).first();
  const to = toText === null ? page.locator('#tree') : page.locator('.tree-row.group', { hasText: toText }).first();
  await from.hover(); await page.mouse.down();
  await to.hover(); await to.hover();
  await page.mouse.up();
  await page.waitForTimeout(250);
}
await dragRow('アーム', 'ユニット1');
await dragRow('ブラケット', 'ユニット1');
await dragRow('ベース板', '装置A');
await show('整理後');
check((await shape()) === '[装置A]\n  [ユニット1]\n    アーム\n    ブラケット\n  ベース板', 'devices moved into the folders: \n' + await shape());
await page.screenshot({ path: outDir + '/shot-25-organised.png' });

// F2 で装置の名前を変える
await page.locator('.tree-row.device', { hasText: 'アーム' }).first().click();
await page.keyboard.press('F2');
await page.waitForSelector('.rename-input');
await page.fill('.rename-input', 'アーム組立');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
check((await shape()).includes('アーム組立'), 'device renamed with F2');
check(await page.evaluate(() => App.devices().some(d => d.name === 'アーム組立')), 'device name updated in the model too');

// Esc で取り消せる
await page.keyboard.press('F2');
await page.waitForSelector('.rename-input');
await page.fill('.rename-input', 'ぜんぜん違う名前');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check((await shape()).includes('アーム組立'), 'Escape cancels the rename');

// 同じ階層に同名は作らせない
await page.locator('.tree-row.device', { hasText: 'ブラケット' }).first().click();
await page.keyboard.press('F2');
await page.fill('.rename-input', 'アーム組立');
await page.keyboard.press('Enter');
await page.waitForSelector('#msg-dialog[open]');
check((await page.textContent('#msg-body')).includes('すでにあります'), 'duplicate name is refused with a message');
await page.keyboard.press('Escape');
check((await shape()).includes('ブラケット'), 'name unchanged after the refusal');

// 右クリックメニュー
await page.locator('.tree-row.group', { hasText: 'ユニット1' }).first().click({ button: 'right' });
await page.waitForSelector('.ctx-menu');
const items = await page.$$eval('.ctx-item span:first-child', ss => ss.map(s => s.textContent));
console.log('    メニュー:', items.join(' / '));
check(items.includes('名前の変更') && items.includes('新しいフォルダー') && items.includes('フォルダを解除（中身を上へ）'), 'context menu has the expected items');
await page.screenshot({ path: outDir + '/shot-26-ctxmenu.png' });

// フォルダを解除すると中身が親へ上がる
await page.click('.ctx-item:has-text("フォルダを解除（中身を上へ）")');
await page.waitForTimeout(300);
check(!(await shape()).includes('[ユニット1]'), 'folder dissolved');
check((await shape()) === '[装置A]\n  アーム組立\n  ブラケット\n  ベース板', 'its devices moved up to the parent: \n' + await shape());

// フォルダを自分の中へは入れられない
await page.locator('.tree-row.group', { hasText: '装置A' }).first().click();
await page.click('#btn-new-folder');
await page.fill('.rename-input', '内側');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
check((await shape()).includes('[装置A]\n  [内側]'), '内側 was created inside 装置A: \n' + await shape());
await dragRow('装置A', '内側');
check((await shape()).includes('[装置A]'), 'moving a folder into its own child is refused');
check(await page.evaluate(() => !!document.querySelector('#msg-dialog[open]')), 'and it says why');
await page.keyboard.press('Escape');

// 空白へドロップすると最上位に戻る
await dragRow('アーム組立', null);
await show('最上位へ戻した後');
check((await shape()).split('\n')[0] === 'アーム組立' || (await shape()).includes('\nアーム組立'), 'dropping on empty space moves to the root');
check(await page.evaluate(() => App.devices().find(d => d.name === 'アーム組立').groupPath.length === 0), 'groupPath cleared');

// 空のフォルダも残る (装置が入っていなくても消えない)
check((await shape()).includes('[内側]'), 'an empty folder stays in the tree');
// 空のフォルダは × で片づけられる
await page.locator('.tree-row.group', { hasText: '内側' }).first().locator('button.close').click();
await page.waitForTimeout(300);
check(!(await shape()).includes('[内側]'), 'closing an empty folder removes it');

// Delete で閉じる
await page.locator('.tree-row.device', { hasText: 'ブラケット' }).first().click();
await page.keyboard.press('Delete');
await page.waitForTimeout(300);
check(await page.evaluate(() => App.devices().length) === 2, 'Delete closes the focused device');

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
console.log('TREE EDIT TEST PASSED');
