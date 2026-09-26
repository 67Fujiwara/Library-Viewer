# -*- coding: utf-8 -*-
"""GLB ライター (純 Python。Fusion が無くても動く)

ビューアの src/js/02-glb.js の read() が読める GLB を書く。**2 つは必ず同時に直す**。
  入力: { 'name': str,
          'root': {'name': str, 'meshIndex': int|None, 'matrix': [16]|None, 'children': [...]},
          'meshes': [{'name': str, 'positions': [x,y,z,...] (mm), 'normals': [...]|None, 'indices': [...], 'color': [r,g,b]|None}] }
        positions / normals / indices は list でも array('f') / array('I') でもよい。
        color は **リニア** 0..1 (glTF の baseColorFactor の規約。sRGB を渡すと薄く出る)
  出力: bytes (glTF 2.0 バイナリ)。ジオメトリは mm / Z-up のまま置き、
        ルートノードに Y-up / m への行列を持たせる (他のビューアでも正しく見える)。

ファイルを小さくする 3 つの手 (実測: 曲面の多い 2000 ボディで 9.8MB → 1.1MB):
  1. **同じメッシュを複数のノードから参照する** (インスタンス化)。ノードは 'matrix' (glTF 列優先、mm) で
     位置を持つ。ねじ・ローラーなど同じ部品が何十個も並ぶアセンブリで桁違いに効く
  2. 位置を **int16 に量子化** (KHR_mesh_quantization)。メッシュの大きさが QUANT_MAX_EXTENT 以下のときだけ
     (刻みが 3µm 以下に収まる範囲)。大きい部品は float32 のまま (計測精度を落とさない)
  3. 法線を書かない (ビューアが計算する) / index は節点が 65536 未満なら uint16
  gzip は float32 の曲面座標にほとんど効かない (実測 24B/三角形 → 7.5B) ので、上の 3 つが本命
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
QUANT_MAX_EXTENT = 196.0      # mm。これ以下なら int16 の刻みが 196/65534 = 0.003mm 以下
QUANT_RANGE = 65534


def _pad4(n):
    return (n + 3) & ~3


def as_array(typecode, values):
    """list / array / bytes → array。すでに同じ型の array ならコピーしない"""
    if isinstance(values, array) and values.typecode == typecode:
        return values
    if isinstance(values, (bytes, bytearray, memoryview)):
        a = array(typecode); a.frombytes(values); return a
    a = array(typecode, values)
    return a


def _le_bytes(a):
    """array → リトルエンディアンのバイト列 (array は CPU の並びなので、ビッグエンディアンなら反転)"""
    if sys.byteorder == 'big':
        a = array(a.typecode, a); a.byteswap()
    return a.tobytes()


def _u32_or_u16(idx, node_count):
    if node_count < 65536:
        return as_array('H', idx), 5123
    return as_array('I', idx), 5125


def _quantize(pos, mn, mx):
    """位置を int16 に。戻り: (array('h'), translation, scale)。値 v は v = translation + scale * q で戻る"""
    ext = max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) or 1.0
    scale = ext / QUANT_RANGE
    q = array('h', [0]) * len(pos)
    for i in range(0, len(pos), 3):
        for a in range(3):
            q[i + a] = int(round((pos[i + a] - mn[a]) / scale)) - 32767
    translation = [mn[a] + 32767 * scale for a in range(3)]
    return q, translation, scale


def write(model, quantize=True):
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

    mesh_ids, dequant, used_quant = [], [], False
    for i, m in enumerate(model['meshes']):
        pos = as_array('f', m['positions'])
        nrm = m.get('normals')
        nrm = as_array('f', nrm) if nrm is not None and len(nrm) else None
        node_count = len(pos) // 3
        idx, idx_type = _u32_or_u16(m['indices'], node_count)
        if len(pos):
            mn = [min(pos[k::3]) for k in range(3)]
            mx = [max(pos[k::3]) for k in range(3)]
        else:
            mn, mx = [0, 0, 0], [0, 0, 0]
        ext = max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2])
        if quantize and len(pos) and ext <= QUANT_MAX_EXTENT:
            q, tr, sc = _quantize(pos, mn, mx)
            pv = add_view(_le_bytes(q), 34962)
            qmn = [min(q[k::3]) for k in range(3)]; qmx = [max(q[k::3]) for k in range(3)]
            gltf['accessors'].append({'bufferView': pv, 'componentType': 5122, 'count': node_count, 'type': 'VEC3', 'min': qmn, 'max': qmx})
            dequant.append((tr, [sc, sc, sc]))
            used_quant = True
        else:
            pv = add_view(_le_bytes(pos), 34962)
            gltf['accessors'].append({'bufferView': pv, 'componentType': 5126, 'count': node_count, 'type': 'VEC3', 'min': mn, 'max': mx})
            dequant.append(None)
        pa = len(gltf['accessors']) - 1
        attrs = {'POSITION': pa}
        if nrm is not None:
            nv = add_view(_le_bytes(nrm), 34962)
            gltf['accessors'].append({'bufferView': nv, 'componentType': 5126, 'count': len(nrm) // 3, 'type': 'VEC3'})
            attrs['NORMAL'] = len(gltf['accessors']) - 1
        iv = add_view(_le_bytes(idx), 34963)
        gltf['accessors'].append({'bufferView': iv, 'componentType': idx_type, 'count': len(idx), 'type': 'SCALAR'})
        ia = len(gltf['accessors']) - 1
        c = m.get('color')
        name = m.get('name') or ('solid_' + str(i))
        mat = {'name': name,
               'pbrMetallicRoughness': {'baseColorFactor': [c[0], c[1], c[2], 1] if c else DEFAULT_COLOR, 'metallicFactor': 0.1, 'roughnessFactor': 0.6},
               'doubleSided': True}
        if not c:
            mat['extras'] = {'defaultColor': True}
        gltf['materials'].append(mat)
        gltf['meshes'].append({'name': name, 'primitives': [{'attributes': attrs, 'indices': ia, 'material': len(gltf['materials']) - 1}]})
        mesh_ids.append(len(gltf['meshes']) - 1)

    def add_node(t):
        n = {'name': t.get('name') or ''}
        gltf['nodes'].append(n)
        nid = len(gltf['nodes']) - 1
        mtx = t.get('matrix')
        if mtx:
            n['matrix'] = [float(v) for v in mtx]
        mi = t.get('meshIndex')
        kids = []
        if mi is not None and mi < len(mesh_ids):
            dq = dequant[mi]
            if dq is None and not mtx:
                n['mesh'] = mesh_ids[mi]
            elif dq is None:
                n['mesh'] = mesh_ids[mi]
            else:
                # 量子化の戻し (translation / scale) は matrix と同じノードに置けないので、子ノードに持たせる
                inner = {'name': '', 'mesh': mesh_ids[mi], 'translation': dq[0], 'scale': dq[1]}
                gltf['nodes'].append(inner)
                kids.append(len(gltf['nodes']) - 1)
        for k in (t.get('children') or []):
            kids.append(add_node(k))
        if kids:
            n['children'] = kids
        return nid

    gltf['nodes'].append({'name': model.get('name') or 'model', 'matrix': ROOT_MATRIX, 'extras': ROOT_EXTRAS})
    gltf['nodes'][0]['children'] = [add_node(model['root'])]
    gltf['buffers'].append({'byteLength': offset[0]})
    if used_quant:
        gltf['extensionsUsed'] = ['KHR_mesh_quantization']
        gltf['extensionsRequired'] = ['KHR_mesh_quantization']

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


def write_gz(model, quantize=True):
    """glb を gzip した bytes と、素の glb のサイズ。共有フォルダに置くのはこちら (<名前>.glb.gz)"""
    raw = write(model, quantize)
    return gzip.compress(raw, compresslevel=9), len(raw)


def count(model):
    """solids = 配置の数 (同じメッシュを 3 か所に置けば 3)、triangles も配置ぶん、unique = メッシュの種類"""
    inst = [0]; tris = [0]
    def walk(t):
        mi = t.get('meshIndex')
        if mi is not None and mi < len(model['meshes']):
            inst[0] += 1; tris[0] += len(model['meshes'][mi]['indices']) // 3
        for k in (t.get('children') or []):
            walk(k)
    walk(model['root'])
    return {'solids': inst[0], 'triangles': tris[0], 'unique': len(model['meshes'])}
