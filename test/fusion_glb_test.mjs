// Fusion スクリプトの GLB ライター (fusion/LibraryExport/glbwrite.py) が書いた glb を
// ビューアの GLB.read と gltf-transform の両方で読む (Fusion 無しで通る部分の確認)。
// インスタンス化 (同じメッシュを 2 か所に置く)・int16 量子化・法線なし・uint16 index を含む
import fs from 'node:fs';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { NodeIO } from '@gltf-transform/core';
const require = createRequire(import.meta.url);
const GLB = require('../src/js/02-glb.js');
function check(c, m) { if (!c) throw new Error('FAIL: ' + m); console.log('  ok  ' + m); }
const ext = (m) => { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < m.positions.length; i += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], m.positions[i + a]); mx[a] = Math.max(mx[a], m.positions[i + a]); } return { mn, mx }; };

const stat = JSON.parse(execFileSync('python3', ['test/fusion_glb_box.py']).toString());
console.log('  python:', JSON.stringify(stat));
const raw = fs.readFileSync('test/out/fusion_mesh.glb');
const gz = fs.readFileSync('test/out/fusion_mesh.glb.gz');
check(raw.length === stat.raw, 'raw glb size matches what write_gz reported');
check(Buffer.compare(zlib.gunzipSync(gz), raw) === 0, 'glb.gz gunzips to the same bytes (' + gz.length + ' → ' + raw.length + ')');
check(stat.unique === 2 && stat.solids === 3, 'two unique meshes placed as three solids (POST is instanced)');
const json = JSON.parse(raw.subarray(20, 20 + raw.readUInt32LE(12)).toString());
check(json.meshes.length === 2, 'the file holds each mesh once: ' + json.meshes.length);
check((json.extensionsRequired || []).includes('KHR_mesh_quantization'), 'declares KHR_mesh_quantization');
const posTypes = json.meshes.map(m => json.accessors[m.primitives[0].attributes.POSITION].componentType);
check(posTypes[0] === 5126 && posTypes[1] === 5122, 'the 200mm plate stays float32, the 20mm post is int16: ' + posTypes);
check(json.accessors[json.meshes[0].primitives[0].indices].componentType === 5123, 'indices are uint16');
check(json.meshes[1].primitives[0].attributes.NORMAL === undefined, 'no normals stored for the post');

// ビューア側のリーダー: 配置ごとに焼き込んで 3 つのメッシュになる
const model = GLB.read(new Uint8Array(raw));
check(model.name === 'MESH_MACHINE', 'root name: ' + model.name);
check(model.meshes.length === 3, 'reader expands the instances into 3 meshes');
const names = model.root.children.map(c => c.name);
check(names.join(',') === 'BASE_PLATE,UNIT_A:1,UNIT_A:2', 'occurrence hierarchy kept: ' + names.join(','));
const post1 = model.meshes[model.root.children[1].children[0].meshIndex], post2 = model.meshes[model.root.children[2].children[0].meshIndex];
check(model.root.children[1].children[0].name === 'POST' && !model.root.children[1].children[0].children.length, 'the quantization wrapper node is collapsed into the part row');
const e1 = ext(post1), e2 = ext(post2);
check(Math.abs(e1.mn[0] - 40) < 0.004 && Math.abs(e1.mx[0] - 60) < 0.004, 'instance 1 sits at x = 50 ± 10 (quantization error < 3µm): ' + e1.mn[0].toFixed(4) + '..' + e1.mx[0].toFixed(4));
check(Math.abs(e2.mn[0] - 140) < 0.004 && Math.abs(e2.mx[0] - 160) < 0.004 && Math.abs(e2.mn[1] - 20) < 0.004, 'instance 2 sits at x = 150, y = 30 (rotated 90°): ' + e2.mn[0].toFixed(3) + '..' + e2.mx[0].toFixed(3) + ' / y ' + e2.mn[1].toFixed(3));
check(Math.abs(e1.mx[2] - 110) < 0.004 && Math.abs(e1.mn[2] - 10) < 0.004, 'z range 10..110 mm survives quantization');
const plate = model.meshes[model.root.children[0].meshIndex], ep = ext(plate);
check(ep.mn[0] === -100 && ep.mx[0] === 100, 'the float32 plate is exact: ' + ep.mn[0] + '..' + ep.mx[0]);
let unit = true; for (let i = 0; i < post1.normals.length; i += 3) { const l = Math.hypot(post1.normals[i], post1.normals[i + 1], post1.normals[i + 2]); if (Math.abs(l - 1) > 1e-4) unit = false; }
check(unit && post1.normals.length === post1.positions.length, 'normals are computed for the post (unit length)');
// 上面の法線が +z を向いている (箱の上面 4 節点 = 面 5 番目)
check(post1.normals[4 * 4 * 3 + 2] > 0.99, 'computed normal of the top face points +z: ' + post1.normals[4 * 4 * 3 + 2].toFixed(3));
check(post1.indices.length / 3 === 12 && stat.triangles === 36, 'triangle counts (12 per box, 36 placed)');
check(plate.color && !post1.color, 'color kept for BASE_PLATE, default (null) for POST');
check(post1.positions instanceof Float32Array && post1.indices instanceof Uint32Array, 'typed arrays');
const pv = (i) => json.bufferViews[json.accessors[json.meshes[i].primitives[0].attributes.POSITION].bufferView].byteLength;
check(pv(1) === 24 * 3 * 2 && pv(0) === 24 * 3 * 4, 'quantized positions take 2 bytes per coordinate (' + pv(1) + ' B vs ' + pv(0) + ' B for 24 nodes)');

// 一般の glTF ツールでも読める (量子化拡張の無い版で)
const doc = await new NodeIO().readBinary(new Uint8Array(fs.readFileSync('test/out/fusion_mesh_plain.glb')));
const gm = doc.getRoot().listMeshes();
check(gm.length === 2, 'gltf-transform reads 2 meshes: ' + gm.map(m => m.getName()).join(','));
const rootNode = doc.getRoot().listScenes()[0].listChildren()[0];
check(rootNode.getMatrix()[0] === 0.001, 'root node carries the Z-up mm → Y-up m matrix');
const plain = GLB.read(new Uint8Array(fs.readFileSync('test/out/fusion_mesh_plain.glb')));
check(plain.meshes.length === 3 && Math.abs(ext(plain.meshes[2]).mn[0] - 140) < 1e-4, 'the plain (float32) file reads the same way');
// Fusion の API を偽オブジェクトで置き換えて collect_meshes を通す (同じ部品の使い回し / 行列の検査 / 退避)
console.log(execFileSync('python3', ['test/fusion_collect_test.py']).toString().trimEnd());
console.log('fusion glb writer OK');
