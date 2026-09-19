// GLB ライターを @gltf-transform/core で、ZIP ライターを unzip で検証する
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { NodeIO } from '@gltf-transform/core';
const require = createRequire(import.meta.url);
const occtimportjs = require('occt-import-js');
const GLB = require('../src/js/02-glb.js');
const ZIP = require('../src/js/03-zip.js');

const occt = await occtimportjs();
const buf = fs.readFileSync('test/out/assembly.step');
const r = occt.ReadStepFile(new Uint8Array(buf), { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.0012, angularDeflection: 0.5 });
if (!r.success) throw new Error('step read failed');

// occt の root → 内部ツリー (ノードの meshes は葉として展開)
function toTree(node) {
  const t = { name: node.name, meshIndex: null, children: [] };
  const kids = (node.children || []).map(toTree);
  const ms = node.meshes || [];
  if (ms.length === 1 && kids.length === 0) { t.meshIndex = ms[0]; t.name = t.name || r.meshes[ms[0]].name; }
  else ms.forEach(i => kids.push({ name: r.meshes[i].name, meshIndex: i, children: [] }));
  t.children = kids;
  return t;
}
const root = toTree(r.root.children[0]);
const model = {
  name: root.name, root,
  meshes: r.meshes.map(m => ({ name: m.name, positions: m.attributes.position.array, normals: m.attributes.normal.array, indices: m.index.array, color: m.color || null }))
};
const glb = GLB.write(model);
fs.mkdirSync('test/out', { recursive: true });
fs.writeFileSync('test/out/assembly.glb', glb);

const io = new NodeIO();
const doc = await io.readBinary(glb);
const rootG = doc.getRoot();
console.log('gltf-transform: meshes=', rootG.listMeshes().map(m => m.getName()));
for (const m of rootG.listMeshes()) {
  const p = m.listPrimitives()[0];
  const pos = p.getAttribute('POSITION');
  console.log(`  ${m.getName()} verts=${pos.getCount()} idx=${p.getIndices().getCount()} min=${pos.getMin([0,0,0]).map(v=>v.toFixed(1))} max=${pos.getMax([0,0,0]).map(v=>v.toFixed(1))} color=${p.getMaterial().getBaseColorFactor().map(v=>v.toFixed(2))}`);
}
function walk(n, d = 0) { console.log('  '.repeat(d) + 'node ' + n.getName() + (n.getMesh() ? ' [mesh]' : '')); n.listChildren().forEach(c => walk(c, d + 1)); }
rootG.listScenes()[0].listChildren().forEach(n => walk(n));

// 自前リーダーで往復
const back = GLB.read(glb);
if (back.name !== model.name) throw new Error('name mismatch ' + back.name);
if (back.meshes.length !== 3) throw new Error('mesh count');
if (back.root.children[1].name !== 'ARM_UNIT' || back.root.children[1].children.length !== 2) throw new Error('tree mismatch ' + JSON.stringify(back.root));
if (back.meshes[0].indices.length !== model.meshes[0].indices.length) throw new Error('index mismatch');
console.log('GLB round-trip OK:', JSON.stringify(back.root).slice(0, 200));

// ZIP
const zip = ZIP.write([
  { name: 'models/設計1課/P2026-001_装置A/ワークX/assembly.glb', data: glb },
  { name: 'models/設計1課/P2026-001_装置A/ワークX/step/assembly.step', data: new Uint8Array(buf) },
  { name: 'models/設計1課/P2026-001_装置A/ワークX/meta.json', data: new TextEncoder().encode(JSON.stringify({ deviceName: '装置A' })) },
]);
fs.writeFileSync('test/out/store.zip', zip);
fs.rmSync('test/out/unz', { recursive: true, force: true });
console.log(execSync('cd test/out && unzip -o -q store.zip -d unz && find unz -type f | sort && unzip -t store.zip').toString());
const glb2 = fs.readFileSync('test/out/unz/models/設計1課/P2026-001_装置A/ワークX/assembly.glb');
await io.readBinary(new Uint8Array(glb2));
console.log('ZIP OK: unzipped glb readable, bytes=', glb2.length);
