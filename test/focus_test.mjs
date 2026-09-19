// 「この部品に寄る」: 対象が他の部品に隠れているときは、見える角度へ回り込んでから寄る。
// occluded.step は既定のカメラ角度から SMALL_PART が BIG_PLATE の陰に完全に隠れる配置。
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

/* 今のカメラから、選択中の部品が画面に見えているか (中心へレイを飛ばして最初に当たる部品で判定) */
const hitName = () => page.evaluate(() => {
  const cam = Viewer3D.camera();
  const node = App.selected();
  const box = new THREE.Box3();
  Viewer3D.leavesOf(node).forEach(n => { if (n.mesh) box.union(n.mesh.geometry.boundingBox); });
  const c = box.getCenter(new THREE.Vector3());
  const ray = new THREE.Raycaster();
  ray.set(cam.position, c.clone().sub(cam.position).normalize());
  const objs = [];
  App.devices().forEach(d => d.leaves.forEach(n => { if (n.mesh && n.visible !== false) objs.push(n.mesh); }));
  const hits = ray.intersectObjects(objs, false);
  return hits.length ? hits[0].object.userData.node.name : null;
});
const cam = () => page.evaluate(() => { const c = Viewer3D.camera(); return { x: c.position.x, y: c.position.y, z: c.position.z }; });

await page.goto('file://' + html);
await page.waitForTimeout(1200);
await page.setInputFiles('#file-input', [{ name: 'occluded.step', mimeType: 'application/step', buffer: fs.readFileSync('test/out/occluded.step') }]);
await page.waitForFunction(() => App.devices().length === 1, null, { timeout: 60000 });
await page.waitForTimeout(500);

// SMALL_PART を選ぶ。既定の角度では BIG_PLATE に隠れている
await page.locator('.tree-row', { hasText: 'SMALL_PART' }).first().locator('button.name').click();
await page.waitForTimeout(300);
check(await hitName() === 'BIG_PLATE', 'SMALL_PART is hidden behind BIG_PLATE at the default angle');
const before = await cam();
await page.screenshot({ path: outDir + '/shot-20-focus-before.png' });

// 「この部品に寄る」 → 見える角度へ回り込む
await page.click('#btn-fit-sel');
await page.waitForTimeout(900);   // アニメーションの完了を待つ
const after = await cam();
check(await hitName() === 'SMALL_PART', 'after 寄る, SMALL_PART is the first thing the camera sees');
const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
check(moved > 1, 'the camera actually moved (' + moved.toFixed(1) + ' mm)');
const score = await page.evaluate(() => Viewer3D.focusNode(App.selected()));
check(score > 0.9, 'visibility score at the chosen angle: ' + score.toFixed(2));
await page.waitForTimeout(900);
await page.screenshot({ path: outDir + '/shot-21-focus-after.png' });

// すでに見えている部品では角度を変えない (むやみに視点を動かさない)
await page.locator('.tree-row', { hasText: 'BIG_PLATE' }).first().locator('button.name').click();
await page.waitForTimeout(300);
const ang0 = await page.evaluate(() => { const c = Viewer3D.camera(); return c.position.clone().sub(new THREE.Vector3()).normalize().toArray(); });
const t0 = await page.evaluate(() => ({ t: Viewer3D.camera().position.toArray() }));
await page.click('#btn-fit-sel');
await page.waitForTimeout(900);
const dirBefore = await page.evaluate(() => Viewer3D.camera().getWorldDirection(new THREE.Vector3()).toArray());
check(await hitName() === 'BIG_PLATE', 'visible part stays visible after 寄る');
// 角度が保たれたか: 2 回目の 寄る で視線方向が変わらないこと
const d1 = await page.evaluate(() => Viewer3D.camera().getWorldDirection(new THREE.Vector3()).toArray());
await page.click('#btn-fit-sel');
await page.waitForTimeout(900);
const d2 = await page.evaluate(() => Viewer3D.camera().getWorldDirection(new THREE.Vector3()).toArray());
const dot = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
check(dot > 0.9999, 'angle preserved for an already visible part (dot=' + dot.toFixed(6) + ')');

// アニメーション中にユーザーが操作したら、そちらを優先して止まる
await page.locator('.tree-row', { hasText: 'SMALL_PART' }).first().locator('button.name').click();
await page.click('#btn-fit-sel');
await page.waitForTimeout(80);
await page.mouse.move(700, 400); await page.mouse.down(); await page.mouse.move(760, 400, { steps: 4 }); await page.mouse.up();
const mid = await cam();
await page.waitForTimeout(700);
const end = await cam();
const drift = Math.hypot(end.x - mid.x, end.y - mid.y, end.z - mid.z);
check(drift < 1e-6, 'dragging cancels the camera animation (drift ' + drift.toExponential(1) + ')');

// 計測にかかる時間 (ボタンを押してから角度が決まるまで)
const ms = await page.evaluate(() => { const t = performance.now(); Viewer3D.focusNode(App.selected()); return performance.now() - t; });
console.log('    focusNode の所要時間:', ms.toFixed(1), 'ms');
check(ms < 500, 'focusNode completes quickly (' + ms.toFixed(1) + ' ms)');

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
console.log('FOCUS TEST PASSED');
