// 「私が作りました」マーク: 設定でのオンオフ (オフは版の文字) / 黒板に版が描かれる / 顔に画像を貼る・消す / 再読み込みで残る
import { chromium } from 'playwright';
import path from 'path';
const html = path.resolve('dist/library-viewer.html');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
function check(c, m) { if (!c) throw new Error('FAIL: ' + m); console.log('  ok  ' + m); }
await page.goto('file://' + html);
await page.waitForTimeout(1200);
const canStore = await page.evaluate(() => { Storage.set('lv.probe', 1); return Storage.get('lv.probe', 0) === 1; });
await page.evaluate(() => { Storage.remove('lv.madeBy'); Storage.remove('lv.face'); });
await page.reload(); await page.waitForTimeout(1200);

// 既定: 版の文字だけ
check(await page.locator('#ver-text').isVisible() && await page.locator('#made-by').isHidden(), 'by default the header shows the version text, not the mark');
check((await page.textContent('#ver-text')).match(/^v\d+$/), 'the version text is v + number: ' + await page.textContent('#ver-text'));

// 設定でオン → マークに入れ替わる
await page.click('#btn-settings');
await page.click('label.switch-label[for="chk-made-by"]');
await page.waitForTimeout(300);
check(await page.locator('#made-by').isVisible() && await page.locator('#ver-text').isHidden(), 'switching the mark on replaces the version text with the picture');
check(await page.evaluate(() => Storage.get('lv.madeBy', false)) === true, 'the choice is stored');
await page.keyboard.press('Escape');

// 黒板に版が書かれている (大きい方のキャンバスで見る)
await page.click('#made-by');
await page.waitForSelector('#made-by-dialog[open]');
const px = (sel, fx, fy) => page.evaluate(([sel, fx, fy]) => { const c = document.querySelector(sel), g = c.getContext('2d'); const d = g.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data; return [d[0], d[1], d[2], d[3]]; }, [sel, fx, fy]);
const bright = await page.evaluate(() => { const c = document.querySelector('#made-by-big'), g = c.getContext('2d'); const s = c.width; const d = g.getImageData(Math.round(s * 0.3), Math.round(s * 0.62), Math.round(s * 0.4), Math.round(s * 0.25)).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200 && d[i + 3] > 200) n++; return n; });
check(bright > 300, 'the chalkboard carries white chalk text (the version): ' + bright + ' bright pixels');
const boardEdge = await px('#made-by-big', 0.24, 0.84);
check(boardEdge[1] > boardEdge[0] && boardEdge[3] > 200, 'the board itself stays dark green where there is no text: ' + boardEdge);
const faceBefore = await px('#made-by-big', 0.5, 0.36);
check(faceBefore[3] < 40, 'the face is a transparent hole before an image is chosen: ' + faceBefore);
await page.screenshot({ path: 'test/out/shot-40-made-by.png' });

// 顔に画像を貼る (赤い正方形) → 穴が赤くなる。髪 (穴の外) はそのまま
await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.fillStyle = '#e02020'; g.fillRect(0, 0, 64, 64); await MadeBy.setFace(c.toDataURL('image/png')); });
await page.waitForTimeout(200);
const faceAfter = await px('#made-by-big', 0.5, 0.36);
check(faceAfter[0] > 180 && faceAfter[1] < 90 && faceAfter[3] > 200, 'a chosen image fills the face: ' + faceAfter);
const hair = await px('#made-by-big', 0.26, 0.42);
check(!(hair[0] > 180 && hair[1] < 90), 'the image stays inside the hole (hair is not red): ' + hair);
const smallFace = await px('#made-by canvas', 0.5, 0.36);
check(smallFace[0] > 180 && smallFace[1] < 90, 'the header mark shows the face too: ' + smallFace);
await page.screenshot({ path: 'test/out/shot-41-made-by-face.png' });
check(await page.locator('#made-by-file').getAttribute('accept') === 'image/*', 'the file picker accepts images');

// 再読み込みしても残る
if (canStore) {
  await page.reload(); await page.waitForTimeout(1500);
  check(await page.locator('#made-by').isVisible(), 'the mark stays on after a reload');
  const again = await px('#made-by canvas', 0.5, 0.36);
  check(again[0] > 180 && again[1] < 90, 'the face image survives a reload: ' + again);
  await page.click('#made-by');
  await page.waitForSelector('#made-by-dialog[open]');
}
// 顔を消す → 穴に戻る
await page.click('#made-by-clear');
await page.waitForTimeout(200);
const cleared = await px('#made-by-big', 0.5, 0.36);
check(cleared[3] < 40, '顔を消す empties the hole again: ' + cleared);
await page.keyboard.press('Escape');
// オフに戻すと版の文字
await page.evaluate(() => MadeBy.setEnabled(false));
check(await page.locator('#ver-text').isVisible() && await page.locator('#made-by').isHidden(), 'switching off brings the version text back');
console.log('errors:', errors.length ? errors.join(' | ') : 'none');
if (errors.length) throw new Error('page errors');
await browser.close();
console.log('MADE-BY TEST PASSED');
