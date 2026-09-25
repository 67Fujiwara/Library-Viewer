// Fusion スクリプトの GLB ライター (fusion/LibraryExport/glbwrite.py) が書いた glb を
// ビューアの GLB.read と gltf-transform の両方で読む (Fusion 無しで通る部分の確認)
import fs from 'node:fs';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { NodeIO } from '@gltf-transform/core';
const require = createRequire(import.meta.url);
const GLB = require('../src/js/02-glb.js');
function check(c, m) { if (!c) throw new Error('FAIL: ' + m); console.log('  ok  ' + m); }

const stat = JSON.parse(execFileSync('python3', ['test/fusion_glb_box.py']).toString());
console.log('  python:', JSON.stringify(stat));
const raw = fs.readFileSync('test/out/fusion_mesh.glb');
const gz = fs.readFileSync('test/out/fusion_mesh.glb.gz');
check(raw.length === stat.raw, 'raw glb size matches what write_gz reported');
check(Buffer.compare(zlib.gunzipSync(gz), raw) === 0, 'glb.gz gunzips to the same bytes (' + gz.length + ' → ' + raw.length + ')');

// ビューア側のリーダー
const model = GLB.read(new Uint8Array(raw));
check(model.name === 'MESH_MACHINE', 'root name: ' + model.name);
check(model.meshes.length === 2 && stat.solids === 2, '2 solids');
const names = model.root.children.map(c => c.name);
check(names.join(',') === 'BASE_PLATE,UNIT_A:1', 'occurrence hierarchy kept: ' + names.join(','));
check(model.root.children[1].children[0].name === 'POST', 'body inside the occurrence');
const post = model.meshes[model.root.children[1].children[0].meshIndex];
let mx = -Infinity, mn = Infinity;
for (let i = 0; i < post.positions.length; i += 3) { mx = Math.max(mx, post.positions[i]); mn = Math.min(mn, post.positions[i]); }
check(Math.abs(mx - 60) < 1e-3 && Math.abs(mn - 40) < 1e-3, 'coordinates are in mm (POST x: ' + mn + '..' + mx + ' = 50 ± 10)');
check(post.indices.length / 3 === 12 && stat.triangles === 24, 'triangle counts (12 per box)');
check(model.meshes[0].color && !post.color, 'color kept for BASE_PLATE, default (null) for POST');
check(post.positions instanceof Float32Array && post.indices instanceof Uint32Array, 'typed arrays');

// 一般の glTF ツールでも読める
const doc = await new NodeIO().readBinary(new Uint8Array(raw));
const gm = doc.getRoot().listMeshes();
check(gm.length === 2, 'gltf-transform reads 2 meshes: ' + gm.map(m => m.getName()).join(','));
const rootNode = doc.getRoot().listScenes()[0].listChildren()[0];
check(rootNode.getMatrix()[0] === 0.001, 'root node carries the Z-up mm → Y-up m matrix');
console.log('fusion glb writer OK');
