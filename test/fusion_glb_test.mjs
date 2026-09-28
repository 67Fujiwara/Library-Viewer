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
check(stat.unique === 4 && stat.solids === 5, 'four unique meshes placed as five solids (POST is instanced)');
const json = JSON.parse(raw.subarray(20, 20 + raw.readUInt32LE(12)).toString());
check(json.meshes.length === 4, 'the file holds each mesh once: ' + json.meshes.length);
check((json.extensionsRequired || []).includes('KHR_mesh_quantization'), 'declares KHR_mesh_quantization');
const posTypes = json.meshes.map(m => json.accessors[m.primitives[0].attributes.POSITION].componentType);
check(posTypes[0] === 5126 && posTypes[1] === 5122, 'the 200mm plate stays float32, the 20mm post is int16: ' + posTypes);
check(json.accessors[json.meshes[0].primitives[0].indices].componentType === 5123, 'indices are uint16');
check(json.meshes[1].primitives[0].attributes.NORMAL === undefined, 'no normals stored for the post');

// ビューア側のリーダー: 配置ごとに焼き込んで 3 つのメッシュになる
const model = GLB.read(new Uint8Array(raw));
check(model.name === 'MESH_MACHINE', 'root name: ' + model.name);
check(model.meshes.length === 5, 'reader expands the instances into 5 meshes');
const names = model.root.children.map(c => c.name);
check(names.join(',') === 'BASE_PLATE,UNIT_A:1,UNIT_A:2,COVER,BUTTON', 'occurrence hierarchy kept: ' + names.join(','));
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
check(post1.indices.length / 3 === 12 && stat.triangles === 60, 'triangle counts (12 per box, 60 placed)');
check(plate.color && !post1.color, 'color kept for BASE_PLATE, default (null) for POST');
// 透明な外観: 4 つ目の alpha が baseColorFactor と alphaMode = BLEND になり、読むと opacity に乗る
const cover = model.meshes[model.root.children[3].meshIndex], coverMat = json.materials[json.meshes[2].primitives[0].material];
check(coverMat.alphaMode === 'BLEND' && Math.abs(coverMat.pbrMetallicRoughness.baseColorFactor[3] - 0.3) < 1e-6, 'a transparent appearance is written with alpha 0.3 and alphaMode BLEND');
check(Math.abs(cover.opacity - 0.3) < 1e-6 && plate.opacity === 1 && post1.opacity === 1, 'GLB.read exposes it as opacity (0.3), opaque parts stay 1');
// ビューア側のライターで書き直しても (変換キャッシュの経路) 透明さが残る
const again = GLB.read(GLB.write(model));
const coverAgain = again.meshes[again.root.children[3].meshIndex];
check(Math.abs(coverAgain.opacity - 0.3) < 1e-6 && again.meshes[again.root.children[0].meshIndex].opacity === 1, 'GLB.write → GLB.read keeps the opacity (conversion cache round trip)');
// 面ごとの色: 頂点色 COLOR_0 (uint8 正規化) → 読むと colors に乗る。材質は白 + vertexColors。往復でも残る
const btnPrim = json.meshes[3].primitives[0], btnAcc = json.accessors[btnPrim.attributes.COLOR_0], btnMat = json.materials[btnPrim.material];
check(btnAcc && btnAcc.componentType === 5121 && btnAcc.normalized === true && btnAcc.type === 'VEC3', 'per-face colors are written as a normalized uint8 COLOR_0 attribute');
check(btnMat.pbrMetallicRoughness.baseColorFactor.slice(0, 3).join() === '1,1,1' && btnMat.extras && btnMat.extras.vertexColors, 'the material is white with extras.vertexColors so the vertex colors show through');
const button = model.meshes[model.root.children[4].meshIndex];
check(button.colors instanceof Uint8Array && button.colors.length === button.positions.length && button.colors[16 * 3] === 255 && button.colors[16 * 3 + 1] === 0 && button.colors[0] === 255 && button.colors[1] === 255, 'GLB.read exposes the vertex colors (top face red, the rest yellow)');
const btnAgain = again.meshes[again.root.children[4].meshIndex];
check(btnAgain.colors && btnAgain.colors.length === button.colors.length && btnAgain.colors[16 * 3 + 1] === 0 && btnAgain.colors[1] === 255, 'GLB.write → GLB.read keeps the vertex colors (conversion cache round trip)');
check(!cover.colors && !plate.colors, 'meshes without per-face colors have none');
check(post1.positions instanceof Float32Array && post1.indices instanceof Uint32Array, 'typed arrays');
const pv = (i) => json.bufferViews[json.accessors[json.meshes[i].primitives[0].attributes.POSITION].bufferView].byteLength;
check(pv(1) === 24 * 3 * 2 && pv(0) === 24 * 3 * 4, 'quantized positions take 2 bytes per coordinate (' + pv(1) + ' B vs ' + pv(0) + ' B for 24 nodes)');

// 一般の glTF ツールでも読める (量子化拡張の無い版で)
const doc = await new NodeIO().readBinary(new Uint8Array(fs.readFileSync('test/out/fusion_mesh_plain.glb')));
const gm = doc.getRoot().listMeshes();
check(gm.length === 4, 'gltf-transform reads 4 meshes: ' + gm.map(m => m.getName()).join(','));
check(gm.some(m => m.listPrimitives()[0].getAttribute('COLOR_0') && m.listPrimitives()[0].getAttribute('COLOR_0').getNormalized()), 'gltf-transform sees the normalized COLOR_0 attribute');
check(doc.getRoot().listMaterials().some(m => m.getAlphaMode() === 'BLEND' && Math.abs(m.getBaseColorFactor()[3] - 0.3) < 1e-6), 'gltf-transform sees the BLEND material with alpha 0.3');
const rootNode = doc.getRoot().listScenes()[0].listChildren()[0];
check(rootNode.getMatrix()[0] === 0.001, 'root node carries the Z-up mm → Y-up m matrix');
const plain = GLB.read(new Uint8Array(fs.readFileSync('test/out/fusion_mesh_plain.glb')));
check(plain.meshes.length === 5 && Math.abs(ext(plain.meshes[2]).mn[0] - 140) < 1e-4, 'the plain (float32) file reads the same way');
// Fusion の API を偽オブジェクトで置き換えて collect_meshes を通す (同じ部品の使い回し / 行列の検査 / 退避)
console.log(execFileSync('python3', ['test/fusion_collect_test.py']).toString().trimEnd());
console.log('fusion glb writer OK');
