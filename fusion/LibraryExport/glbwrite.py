# -*- coding: utf-8 -*-
"""GLB ライター (純 Python。Fusion が無くても動く)

ビューアの src/js/02-glb.js の write() と同じ GLB を書く。**2 つは必ず同時に直す**。
  入力: { 'name': str,
          'root': {'name': str, 'meshIndex': int|None, 'children': [...]},
          'meshes': [{'name': str, 'positions': [x,y,z,...] (mm), 'normals': [...], 'indices': [...], 'color': [r,g,b]|None}] }
  出力: bytes (glTF 2.0 バイナリ)。ジオメトリは mm / Z-up のまま置き、
        ルートノードに Y-up / m への行列を持たせる (他のビューアでも正しく見える)。
        1 ボディ = 1 プリミティブ + 1 マテリアル + 1 ノード。
"""
import json
import struct
import gzip
import sys
from array import array

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
ROOT_EXTRAS = {'libraryViewer': {'upAxis': 'Z', 'unit': 'mm'}}
ROOT_MATRIX = [0.001, 0, 0, 0, 0, 0, -0.001, 0, 0, 0.001, 0, 0, 0, 0, 0, 1]   # Z-up mm → Y-up m
DEFAULT_COLOR = [0.8, 0.8, 0.8, 1]


def _pad4(n):
    return (n + 3) & ~3


def _le_bytes(typecode, values):
    """float32 / uint32 のリトルエンディアン列。array は CPU の並びなので、ビッグエンディアンなら反転する"""
    a = array(typecode, values)
    if a.itemsize != 4:                       # 'I' が 4 バイトでない処理系向け
        a = array('L' if typecode == 'I' else typecode, values)
    if sys.byteorder == 'big':
        a.byteswap()
    return a.tobytes()


def write(model):
    gltf = {
        'asset': {'version': '2.0', 'generator': 'Library Viewer (Fusion mesh export)'},
        'scene': 0, 'scenes': [{'nodes': [0]}],
        'nodes': [], 'meshes': [], 'materials': [], 'accessors': [], 'bufferViews': [], 'buffers': []
    }
    parts = []
    offset = [0]

    def add_view(data, target):
        gltf['bufferViews'].append({'buffer': 0, 'byteOffset': offset[0], 'byteLength': len(data), 'target': target})
        parts.append(data)
        padded = _pad4(len(data))
        if padded != len(data):
            parts.append(b'\0' * (padded - len(data)))
        offset[0] += padded
        return len(gltf['bufferViews']) - 1

    mesh_ids = []
    for i, m in enumerate(model['meshes']):
        pos = list(m['positions'])
        nrm = list(m['normals'])
        idx = list(m['indices'])
        if pos:
            mn = [min(pos[k::3]) for k in range(3)]
            mx = [max(pos[k::3]) for k in range(3)]
        else:
            mn, mx = [0, 0, 0], [0, 0, 0]
        pv = add_view(_le_bytes('f', pos), 34962)
        nv = add_view(_le_bytes('f', nrm), 34962)
        iv = add_view(_le_bytes('I', idx), 34963)
        gltf['accessors'].append({'bufferView': pv, 'componentType': 5126, 'count': len(pos) // 3, 'type': 'VEC3', 'min': mn, 'max': mx})
        pa = len(gltf['accessors']) - 1
        gltf['accessors'].append({'bufferView': nv, 'componentType': 5126, 'count': len(nrm) // 3, 'type': 'VEC3'})
        na = len(gltf['accessors']) - 1
        gltf['accessors'].append({'bufferView': iv, 'componentType': 5125, 'count': len(idx), 'type': 'SCALAR'})
        ia = len(gltf['accessors']) - 1
        c = m.get('color')
        name = m.get('name') or ('solid_' + str(i))
        mat = {'name': name,
               'pbrMetallicRoughness': {'baseColorFactor': [c[0], c[1], c[2], 1] if c else DEFAULT_COLOR, 'metallicFactor': 0.1, 'roughnessFactor': 0.6},
               'doubleSided': True}
        if not c:
            mat['extras'] = {'defaultColor': True}
        gltf['materials'].append(mat)
        gltf['meshes'].append({'name': name, 'primitives': [{'attributes': {'POSITION': pa, 'NORMAL': na}, 'indices': ia, 'material': len(gltf['materials']) - 1}]})
        mesh_ids.append(len(gltf['meshes']) - 1)

    def add_node(t):
        n = {'name': t.get('name') or ''}
        gltf['nodes'].append(n)
        nid = len(gltf['nodes']) - 1
        mi = t.get('meshIndex')
        if mi is not None and mi < len(mesh_ids):
            n['mesh'] = mesh_ids[mi]
        kids = t.get('children') or []
        if kids:
            n['children'] = [add_node(k) for k in kids]
        return nid

    gltf['nodes'].append({'name': model.get('name') or 'model', 'matrix': ROOT_MATRIX, 'extras': ROOT_EXTRAS})
    gltf['nodes'][0]['children'] = [add_node(model['root'])]
    gltf['buffers'].append({'byteLength': offset[0]})

    json_bytes = json.dumps(gltf, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    json_padded = _pad4(len(json_bytes))
    bin_len = offset[0]
    total = 12 + 8 + json_padded + 8 + bin_len
    out = bytearray()
    out += struct.pack('<III', GLB_MAGIC, 2, total)
    out += struct.pack('<II', json_padded, CHUNK_JSON)
    out += json_bytes + b' ' * (json_padded - len(json_bytes))     # JSON は空白でパディング
    out += struct.pack('<II', bin_len, CHUNK_BIN)
    for p in parts:
        out += p
    return bytes(out)


def write_gz(model):
    """glb を gzip した bytes と、素の glb のサイズ。共有フォルダに置くのはこちら (<名前>.glb.gz)"""
    raw = write(model)
    return gzip.compress(raw, compresslevel=6), len(raw)


def count(model):
    return {'solids': len(model['meshes']), 'triangles': sum(len(m['indices']) // 3 for m in model['meshes'])}
