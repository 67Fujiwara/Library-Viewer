# Fusion スクリプトの GLB ライター (glbwrite.py) を Fusion 無しで通す。
# Fusion の TriangleMesh と同じ形 (座標 cm・節点番号) の箱を作り、
#   - BASE_PLATE (200mm。量子化の上限 196mm を超えるので float32 のまま。法線あり)
#   - POST (20mm。int16 に量子化。法線なし = ビューアが計算) を **同じメッシュのまま 2 か所に置く** (インスタンス化)
# ビューアが読めるかは fusion_glb_test.mjs / library_test.mjs が見る。
import os, sys, json, math
from array import array
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, '..', 'fusion', 'LibraryExport'))
import glbwrite

CM_TO_MM = 10.0

def box_cm(x, y, z, sx, sy, sz):
    """Fusion の nodeCoordinatesAsFloat / normalVectorsAsFloat / nodeIndices と同じ並びの箱 (cm)"""
    pos, nrm, idx = [], [], []
    faces = [((1, 0, 0), (0, 1, 0), (0, 0, 1)), ((-1, 0, 0), (0, 0, 1), (0, 1, 0)), ((0, 1, 0), (0, 0, 1), (1, 0, 0)),
             ((0, -1, 0), (1, 0, 0), (0, 0, 1)), ((0, 0, 1), (1, 0, 0), (0, 1, 0)), ((0, 0, -1), (0, 1, 0), (1, 0, 0))]
    h = (sx / 2, sy / 2, sz / 2)
    for n, u, v in faces:
        base = len(pos) // 3
        for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            pos += [x + n[0] * h[0] + su * u[0] * h[0] + sv * v[0] * h[0],
                    y + n[1] * h[1] + su * u[1] * h[1] + sv * v[1] * h[1],
                    z + n[2] * h[2] + su * u[2] * h[2] + sv * v[2] * h[2]]
            nrm += list(n)
        idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    return pos, nrm, idx

def as_fusion_mesh(name, color, geom, packed, with_normals=True):
    pos, nrm, idx = geom
    if packed:   # Fusion スクリプトの tessellate() と同じ形 (cm → mm、array に畳む)
        return {'name': name, 'positions': array('f', (v * CM_TO_MM for v in pos)), 'normals': array('f', nrm) if with_normals else None, 'indices': array('I', idx), 'color': color}
    return {'name': name, 'positions': [v * CM_TO_MM for v in pos], 'normals': nrm if with_normals else None, 'indices': idx, 'color': color}

def translate(tx, ty, tz, rz_deg=0):
    """glTF の列優先 4x4 (mm)。z 軸まわりの回転 + 平行移動"""
    c, s = math.cos(math.radians(rz_deg)), math.sin(math.radians(rz_deg))
    return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]

meshes = [
    as_fusion_mesh('BASE_PLATE', [0.6, 0.6, 0.65], box_cm(0, 0, 0.5, 20, 12, 1), True),          # 200 x 120 x 10 mm (float32 のまま)
    as_fusion_mesh('POST', None, box_cm(0, 0, 6, 2, 2, 10), False, with_normals=False),          # 20 x 20 x 100 mm、部品の原点 (量子化)
]
model = {
    'name': 'MESH_MACHINE',
    'root': {'name': 'MESH_MACHINE', 'meshIndex': None, 'matrix': None, 'children': [
        {'name': 'BASE_PLATE', 'meshIndex': 0, 'matrix': None, 'children': []},
        {'name': 'UNIT_A:1', 'meshIndex': None, 'matrix': None, 'children': [{'name': 'POST', 'meshIndex': 1, 'matrix': translate(50, 0, 0), 'children': []}]},
        {'name': 'UNIT_A:2', 'meshIndex': None, 'matrix': None, 'children': [{'name': 'POST', 'meshIndex': 1, 'matrix': translate(150, 30, 0, 90), 'children': []}]},
    ]},
    'meshes': meshes,
}
out = os.path.join(here, 'out')
os.makedirs(out, exist_ok=True)
gz, raw_size = glbwrite.write_gz(model)
with open(os.path.join(out, 'fusion_mesh.glb'), 'wb') as f:
    f.write(glbwrite.write(model))
with open(os.path.join(out, 'fusion_mesh.glb.gz'), 'wb') as f:
    f.write(gz)
plain = glbwrite.write(model, quantize=False)          # gltf-transform (拡張なし) で読む用
with open(os.path.join(out, 'fusion_mesh_plain.glb'), 'wb') as f:
    f.write(plain)
print(json.dumps({'raw': raw_size, 'gz': len(gz), 'plain': len(plain), **glbwrite.count(model)}))
