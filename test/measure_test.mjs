// 計測モード: スナップ・距離・ΔXYZ を、寸法が分かっているテスト STEP で検証する。
// assembly.step の BASE_PLATE は 300 x 200 x 20 mm (原点から)、HEAD_UNIT は 90..210 / 60..140 / 270..330。
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
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

await page.goto('file://' + html);
await page.waitForTimeout(1200);
await page.setInputFiles('#file-input', [{ name: 'assembly.step', mimeType: 'application/step', buffer: fs.readFileSync('test/out/assembly.step') }]);
await page.waitForFunction(() => App.devices().length === 1, null, { timeout: 60000 });
await page.waitForTimeout(500);

// M キーで計測モードに入る
await page.click('#gl', { position: { x: 700, y: 700 } });
await page.keyboard.press('m');
await page.waitForTimeout(300);
check(await page.$eval('#measure-bar', e => !e.hidden), 'measure bar shown at the bottom');
check(await page.$eval('#chk-measure', e => e.checked), 'HUD toggle reflects measure mode');
check((await page.textContent('#measure-hint')) === '1 点目をクリック', 'hint asks for the first point');

/* ワールド座標を画面座標に投影してクリックする（カメラ操作に依存しない）。
 * 角のちょうど上はシルエット境界でレイが外れることがあるので、面の内側へ数 px 寄せる。 */
async function clickWorld(x, y, z, inset = 9) {
  const p = await page.evaluate(([x, y, z, inset]) => {
    const s = Viewer3D.toScreen(new THREE.Vector3(x, y, z));
    const c = Viewer3D.toScreen(new THREE.Vector3(150, 100, z));   // 同じ高さの中心へ寄せる
    const dx = c.x - s.x, dy = c.y - s.y, len = Math.hypot(dx, dy) || 1;
    const r = document.querySelector('#gl').getBoundingClientRect();
    return { x: r.left + s.x + dx / len * inset, y: r.top + s.y + dy / len * inset };
  }, [x, y, z, inset]);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(80);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
}
const readout = () => page.evaluate(() => ({
  dist: document.querySelector('#m-dist').textContent,
  dx: document.querySelector('#m-dx').textContent, dy: document.querySelector('#m-dy').textContent, dz: document.querySelector('#m-dz').textContent,
  p1: document.querySelector('#m-p1').textContent, p2: document.querySelector('#m-p2').textContent,
  label: document.querySelector('#measure-label').hidden ? null : document.querySelector('#measure-label').textContent,
}));

// BASE_PLATE 天面の対角 2 頂点 (0,0,20) → (300,200,20): 自動スナップで頂点に吸着するはず
await clickWorld(0, 0, 20);
check((await page.textContent('#measure-hint')).includes('2 点目'), 'hint asks for the second point after one click');
await clickWorld(300, 200, 20);
let r = await readout();
console.log('   ', JSON.stringify(r));
check(r.p1.startsWith('頂点') && r.p2.startsWith('頂点'), 'both points snapped to vertices');
check(near(parseFloat(r.dist), Math.hypot(300, 200)), 'diagonal distance = ' + r.dist + ' (expect 360.56)');
check(near(parseFloat(r.dx), 300) && near(parseFloat(r.dy), 200) && near(parseFloat(r.dz), 0), 'ΔX/ΔY/ΔZ = 300 / 200 / 0');
check(r.label && near(parseFloat(r.label), 360.56), '3D label shows the distance: ' + r.label);
const pts = await page.evaluate(() => Measure.points());
check(near(pts[0].x, 0) && near(pts[0].y, 0) && near(pts[0].z, 20), 'point 1 snapped exactly to (0,0,20)');
check(near(pts[1].x, 300) && near(pts[1].y, 200) && near(pts[1].z, 20), 'point 2 snapped exactly to (300,200,20)');
await page.screenshot({ path: outDir + '/shot-14-measure.png' });

// 高さ方向: BASE_PLATE 天面の角 → HEAD_UNIT 天面の角 (Z 差 310)
await clickWorld(0, 0, 20);
await clickWorld(90, 60, 330);
r = await readout();
check(near(parseFloat(r.dz), 310), 'ΔZ across parts = ' + r.dz + ' (expect 310)');

// 面スナップ: HEAD_UNIT 天面 (z=330、手前に何も無い) の中央をクリック
await page.click('label[for="snap-face"]');
await page.click('#measure-clear');
await clickWorld(150, 100, 330, 0);
r = await readout();
check(r.p1.startsWith('面'), 'face snap mode reports 面: ' + r.p1);
const fp = (await page.evaluate(() => Measure.points()))[0];
check(near(fp.z, 330, 0.2), 'face point lies on the top face (z=' + fp.z.toFixed(2) + ')');
check(near(fp.x, 150, 1) && near(fp.y, 100, 1), 'face point is where the cursor was, not snapped away');

// 頂点スナップ固定: 面の中央をクリックしても最寄り頂点に吸着する
await page.click('label[for="snap-vertex"]');
await page.click('#measure-clear');
await clickWorld(150, 100, 330, 0);
const vp = (await page.evaluate(() => Measure.points()))[0];
check(vp.kind === 'vertex' && [90, 210].includes(Math.round(vp.x)) && [60, 140].includes(Math.round(vp.y)) && near(vp.z, 330),
  'vertex mode snaps to a corner of the face: ' + JSON.stringify(vp));

// クリア / Escape / 終了
await page.click('#measure-clear');
r = await readout();
check(r.dist === '–' && r.p1 === '–', 'clear resets the readout');
await page.click('label[for="snap-auto"]');
await clickWorld(0, 0, 20);
check((await page.evaluate(() => Measure.points())).length === 1, 'one point placed before Escape');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check((await page.evaluate(() => Measure.points())).length === 0, 'Escape clears the points');
check(await page.evaluate(() => Measure.isActive()), 'Escape with no points still in measure mode');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check(!(await page.evaluate(() => Measure.isActive())), 'second Escape leaves measure mode');
check(await page.$eval('#measure-bar', e => e.hidden), 'measure bar hidden after exit');

// 計測を抜けたら通常の部品選択に戻る
await clickWorld(150, 100, 330, 0);
check((await page.textContent('#sel-info')).includes('HEAD_UNIT'), 'part selection works again after exiting measure mode');

// 計測中は部品選択にならない
await page.click('label[for="chk-measure"]');
await page.waitForTimeout(200);
const selBefore = await page.textContent('#sel-info');
await clickWorld(0, 0, 20);
check((await page.textContent('#sel-info')) === selBefore, 'clicking in measure mode does not change the selection');
await page.screenshot({ path: outDir + '/shot-15-measure-bar.png' });

// ---- 円スナップ: 穴の中心と径 (公称が分かっている holes.step で検証) ----
await page.evaluate(() => App.clearDevices());
await page.setInputFiles('#file-input', [{ name: 'holes.step', mimeType: 'application/step', buffer: fs.readFileSync('test/out/holes.step') }]);
await page.waitForFunction(() => App.devices().length === 1, null, { timeout: 60000 });
await page.waitForTimeout(500);
check((await page.evaluate(() => Measure.points())).length === 0, 'loading another model clears the measurement');
await page.evaluate(() => { Measure.setActive(true); });
await page.click('label[for="snap-circle"]');

// 板は 200x120x10、φ16 の穴が (50,60) と (150,60)、φ25 が (100,30)。上面 z=10 をクリックする
async function clickAt(x, y, z) {
  const p = await page.evaluate(([x, y, z]) => {
    const s = Viewer3D.toScreen(new THREE.Vector3(x, y, z));
    const r = document.querySelector('#gl').getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, [x, y, z]);
  await page.mouse.move(p.x, p.y); await page.waitForTimeout(80);
  await page.mouse.click(p.x, p.y); await page.waitForTimeout(150);
}
// 穴のまわりの上面をクリックする (いちばん自然な操作。近い方の穴の円が拾われる)
await clickAt(50, 74, 10);
await clickAt(150, 74, 10);
let cp = await page.evaluate(() => Measure.points());
console.log('   ', JSON.stringify(cp));
check(cp.length === 2 && cp.every(p => p.kind === 'circle'), 'both picks snapped to circles');
check(near(cp[0].radius, 8, 1e-4) && near(cp[1].radius, 8, 1e-4), 'radius = 8.0000 for both holes');
check(near(cp[0].x, 50, 1e-4) && near(cp[0].y, 60, 1e-4) && near(cp[0].z, 10, 1e-4), 'hole 1 centre = (50, 60, 10)');
check(near(cp[1].x, 150, 1e-4) && near(cp[1].y, 60, 1e-4) && near(cp[1].z, 10, 1e-4), 'hole 2 centre = (150, 60, 10)');
r = await readout();
check(r.dist === '100.00' && r.dx === '100.00' && r.dy === '0.00' && r.dz === '0.00', 'hole centre distance = 100.00 (ΔX 100, ΔY 0, ΔZ 0): ' + JSON.stringify(r));
check(r.p1.includes('円 φ16.00'), 'readout shows the diameter: ' + r.p1);
const exact = await page.evaluate(() => { const p = Measure.points(); return Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y, p[1].z - p[0].z); });
console.log('    穴中心間距離 (生値):', exact.toFixed(9), 'mm  誤差', Math.abs(exact - 100).toExponential(2), 'mm');
check(Math.abs(exact - 100) < 1e-4, 'centre-to-centre error below 0.0001 mm');
await page.screenshot({ path: outDir + '/shot-16-circle.png' });

// φ25 の穴
await clickAt(100, 46, 10);
cp = await page.evaluate(() => Measure.points());
check(cp.length === 1 && near(cp[0].radius, 12.5, 1e-4) && near(cp[0].x, 100, 1e-4) && near(cp[0].y, 30, 1e-4), 'φ25 hole centre and radius: ' + JSON.stringify(cp[0]));

// ---- 角度計測: 板の角 (0,0,10) を頂点に、X 方向と Y 方向で 90 度 ----
await page.click('label[for="mm-angle"]');
check(!(await page.$eval('#readout-angle', e => e.hidden)) && await page.$eval('#readout-dist', e => e.hidden), 'angle readout row shown');
check((await page.evaluate(() => Measure.points())).length === 0, 'switching mode clears the points');
await page.click('label[for="snap-vertex"]');
await clickAt(195, 5, 10);      // X 軸側の角へ向かう点
await clickAt(5, 5, 10);        // 角 (頂点)
await clickAt(5, 115, 10);      // Y 軸側
const ap = await page.evaluate(() => Measure.points());
console.log('   ', JSON.stringify(ap));
check(ap.length === 3 && ap.every(p => p.kind === 'vertex'), 'three vertices picked for the angle');
const ang = await page.textContent('#m-ang');
check(ang === '90.00', 'angle between the plate edges = ' + ang + '°');
check((await page.textContent('#measure-label')) === '90.00°', '3D label shows the angle');
await page.screenshot({ path: outDir + '/shot-17-angle.png' });

// 角度モードは 3 点目のあとリセットされる
await clickAt(195, 5, 10);
check((await page.evaluate(() => Measure.points())).length === 1, 'a fourth click starts a new angle');

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
console.log('MEASURE TEST PASSED');
