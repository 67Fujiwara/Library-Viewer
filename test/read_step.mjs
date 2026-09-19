// occt-import-js で生成した STEP を読み、階層と名前を確認する
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const occtimportjs = require('occt-import-js');

const occt = await occtimportjs();
const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.0012, angularDeflection: 0.5 };
function dump(node, depth = 0) {
  console.log('  '.repeat(depth) + (node.name || '(no name)') + '  meshes=' + JSON.stringify(node.meshes));
  for (const c of node.children || []) dump(c, depth + 1);
}
let ok = true;
for (const f of ['box.step', 'assembly.step', 'assembly_b.step']) {
  const buf = fs.readFileSync('test/out/' + f);
  const r = occt.ReadStepFile(new Uint8Array(buf), params);
  console.log(`== ${f}: success=${r.success} meshes=${r.meshes.length}`);
  if (!r.success) { ok = false; continue; }
  dump(r.root);
  for (const m of r.meshes) {
    const p = m.attributes.position.array;
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[i + k]); mx[k] = Math.max(mx[k], p[i + k]); }
    console.log(`   mesh "${m.name}" verts=${p.length / 3} tris=${m.index.array.length / 3} color=${JSON.stringify(m.color)} bbox=${mn.map(v=>v.toFixed(1))}..${mx.map(v=>v.toFixed(1))}`);
  }
}
if (!ok) process.exit(1);
