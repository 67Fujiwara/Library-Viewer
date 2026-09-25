# Fusion スクリプトの GLB ライター (glbwrite.py) を Fusion 無しで通す。
# Fusion の TriangleMesh と同じ形 (座標 cm・法線・節点番号) の箱を 2 つ作り、
# オカレンス階層に入れて glb / glb.gz を書く。ビューアが読めるかは fusion_glb_test.mjs が見る。
import os, sys, json
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

def as_fusion_mesh(name, color, geom):
    pos, nrm, idx = geom
    # Fusion スクリプトの tessellate() と同じ変換: cm → mm
    return {'name': name, 'positions': [v * CM_TO_MM for v in pos], 'normals': nrm, 'indices': idx, 'color': color}

meshes = [
    as_fusion_mesh('BASE_PLATE', [0.6, 0.6, 0.65], box_cm(0, 0, 0.5, 20, 12, 1)),     # 200 x 120 x 10 mm
    as_fusion_mesh('POST', None, box_cm(5, 0, 6, 2, 2, 10)),                          # 20 x 20 x 100 mm, x=+50mm
]
model = {
    'name': 'MESH_MACHINE',
    'root': {'name': 'MESH_MACHINE', 'meshIndex': None, 'children': [
        {'name': 'BASE_PLATE', 'meshIndex': 0, 'children': []},
        {'name': 'UNIT_A:1', 'meshIndex': None, 'children': [{'name': 'POST', 'meshIndex': 1, 'children': []}]},
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
print(json.dumps({'raw': raw_size, 'gz': len(gz), **glbwrite.count(model)}))
