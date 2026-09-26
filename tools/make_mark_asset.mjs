// 「私が作りました」マークの元絵を、埋め込める大きさに縮小して webp に再エンコードする。
//   node tools/make_mark_asset.mjs <元画像> [一辺 px=512]
// PIL も cwebp も無い環境でも動くように、Chromium (Playwright) のキャンバスでやる。
// 出力: src/assets/made-by-me.webp (透明を保つ)。顔の穴 (透明部分) の中心と半径も測って表示する
import { chromium } from 'playwright';
import fs from 'fs';
const src = process.argv[2], size = +(process.argv[3] || 512);
if (!src) { console.error('usage: node tools/make_mark_asset.mjs <image> [size]'); process.exit(1); }
const ext = src.split('.').pop().toLowerCase();
const mime = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[ext] || 'image/png';
const dataUrl = 'data:' + mime + ';base64,' + fs.readFileSync(src).toString('base64');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const out = await page.evaluate(async ({ dataUrl, size }) => {
  const img = new Image(); img.src = dataUrl; await img.decode();
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, size, size);
  // 透明な穴 (顔) の範囲: 中央から alpha の小さい画素を塗りつぶして測る (背景も透明なので外接矩形では測れない)
  const d = g.getImageData(0, 0, size, size).data;
  const seen = new Uint8Array(size * size), stack = [[Math.round(size * 0.5), Math.round(size * 0.35)]];
  let minX = size, maxX = 0, minY = size, maxY = 0, n = 0;
  while (stack.length) {
    const [x, y] = stack.pop(); if (x < 0 || y < 0 || x >= size || y >= size) continue;
    const i = y * size + x; if (seen[i]) continue; seen[i] = 1;
    if (d[i * 4 + 3] >= 24) continue;
    n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  const hole = n ? { cx: (minX + maxX) / 2 / size, cy: (minY + maxY) / 2 / size, rx: (maxX - minX) / 2 / size, ry: (maxY - minY) / 2 / size, pixels: n } : null;
  // 顔の穴は白い半透明のぼかしが焼き込まれている (中心 α≈11、縁で α≈200)。楕円の中の半透明画素を
  // 完全に透明にして、ビューアで顔画像をきれいに下に敷けるようにする (髪・帽子・輪郭は α≈253 なので残る)
  const E = { cx: 0.505, cy: 0.36, rx: 0.21, ry: 0.16 };
  const id = g.getImageData(0, 0, size, size), px = id.data;
  let punched = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x / size - E.cx) / E.rx, dy = (y / size - E.cy) / E.ry;
    if (dx * dx + dy * dy > 1) continue;
    const i = (y * size + x) * 4;
    if (px[i + 3] < 235) { px[i + 3] = 0; punched++; }
  }
  g.putImageData(id, 0, 0);
  return { webp: c.toDataURL('image/webp', 0.82), hole, punched, alphaCenter: px[(Math.round(size * 0.35) * size + Math.round(size * 0.5)) * 4 + 3] };
}, { dataUrl, size });
await browser.close();
const buf = Buffer.from(out.webp.split(',')[1], 'base64');
fs.writeFileSync('src/assets/made-by-me.webp', buf);
console.log('wrote src/assets/made-by-me.webp', buf.length, 'bytes; hole (flood):', JSON.stringify(out.hole), 'punched:', out.punched, 'alpha at face center:', out.alphaCenter);
