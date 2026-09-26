# LibraryExport.py の collect_meshes を、Fusion の API を模した偽オブジェクトで通す (adsk 無し)。
#   - 同じコンポーネントの 3 配置 → メッシュは 1 つ、配置 3 つ、行列の平行移動は cm → mm
#   - 行列の自己検査 (matrix_ok) が落ちる配置は焼き込みに退避する
#   - 非表示のボディは出さない / 色の違う配置はメッシュを分ける
import os, sys, re, json, gc, types
from array import array
here = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(here, '..', 'fusion', 'LibraryExport', 'LibraryExport.py'), encoding='utf-8').read()

# ---- 偽 Fusion ----
class Pt:
    def __init__(s, x, y, z): s.x, s.y, s.z = x, y, z
class Mtx:
    def __init__(s, rows): s.rows = rows                       # 4x4 行優先 (cm)
    def asArray(s): return [v for r in s.rows for v in r]
class Mesh:
    def __init__(s, pts): s.nodeCoordinatesAsFloat = [c for p in pts for c in p]; s.nodeIndices = [0, 1, 2]; s.triangleCount = 1
class Calc:
    def __init__(s, body): s.body = body; s.surfaceTolerance = None; s.normalDeviation = None
    def setQuality(s, q): pass
    def calculate(s): return None if s.body.broken else Mesh(s.body.pts)
class MeshMgr:
    def __init__(s, body): s.body = body
    def createMeshCalculator(s): return Calc(s.body)
class Vtx:
    def __init__(s, p): s.geometry = p
class Coll(list):
    @property
    def count(s): return len(s)
    def item(s, i): return s[i]
class Body:
    def __init__(s, name, pts, visible=True, broken=False, color=None):
        s.name, s.pts, s.isVisible, s.broken = name, pts, visible, broken
        s.meshManager = MeshMgr(s); s.vertices = Coll([Vtx(Pt(*pts[0]))]); s.appearance = color
        s.boundingBox = types.SimpleNamespace(minPoint=Pt(0, 0, 0), maxPoint=Pt(1, 1, 1))
    def moved(s, m):   # プロキシ: 行列 (cm) で動かしたコピー
        def ap(p):
            x, y, z = p
            return (m[0][0]*x + m[0][1]*y + m[0][2]*z + m[0][3], m[1][0]*x + m[1][1]*y + m[1][2]*z + m[1][3], m[2][0]*x + m[2][1]*y + m[2][2]*z + m[2][3])
        return Body(s.name, [ap(p) for p in s.pts], s.isVisible, s.broken, s.appearance)
class Comp:
    def __init__(s, cid, name, bodies): s.id, s.name, s.bRepBodies = cid, name, Coll(bodies); s.occurrences = Coll()
class Occ:
    def __init__(s, name, comp, rows, visible=True, lie=False, color=None):
        s.name, s.component, s.isVisible, s.appearance = name, comp, visible, color
        s.transform2 = Mtx(rows)
        real = rows if not lie else [[1,0,0,99],[0,1,0,0],[0,0,1,0],[0,0,0,1]]   # lie: 行列が嘘 (プロキシは別の場所)
        s.bRepBodies = Coll([b.moved(real) for b in comp.bRepBodies])
        s.childOccurrences = Coll()
class Root:
    def __init__(s): s.name = 'ROOT'; s.bRepBodies = Coll(); s.occurrences = Coll()
class Design:
    def __init__(s): s.rootComponent = Root()

adsk = types.SimpleNamespace(doEvents=lambda: None, fusion=types.SimpleNamespace(TriangleMeshQualityOptions=types.SimpleNamespace(LowQualityTriangleMesh=0, NormalQualityTriangleMesh=1, HighQualityTriangleMesh=2)), core=types.SimpleNamespace())
ns = {'adsk': adsk, 'array': array, 'gc': gc, 're': re, 'json': json, 'os': os}
exec(src[src.index('CM_TO_MM ='):src.index('CM_TO_MM =') + len('CM_TO_MM = 10.0')], ns)
exec(src[src.index('MESH_QUALITY = ['):src.index('class CommandCreatedHandler')], ns)
exec(src[src.index('def component_tree'):src.index('# ---- メッシュで格納')], ns)
ns['body_color'] = lambda body, occ=None: body.appearance or (occ.appearance if occ is not None else None)   # 外観は色そのものを入れておく

def check(c, m):
    if not c: raise SystemExit('FAIL: ' + m)
    print('  ok  ' + m)

tri = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]                                 # cm
bolt = Comp('c-bolt', 'BOLT', [Body('body1', tri), Body('hidden', tri, visible=False)])
design = Design()
design.rootComponent.bRepBodies.append(Body('PLATE', tri))
T = lambda x, y=0, z=0: [[1,0,0,x],[0,1,0,y],[0,0,1,z],[0,0,0,1]]
design.rootComponent.occurrences.extend([
    Occ('BOLT:1', bolt, T(5)), Occ('BOLT:2', bolt, T(10)), Occ('BOLT:3', bolt, T(15, 2)),
    Occ('BOLT:4', bolt, T(20), lie=True),                                # 行列が実体と合わない → 焼き込み
    Occ('BOLT:5', bolt, T(25), color=[0.1, 0.2, 0.3]),                  # 色違い → 別メッシュ
    Occ('GHOST:1', bolt, T(30), visible=False),
])
model, stat = ns['collect_meshes'](design, 'normal')
check(stat['bodies'] == 6 and stat['triangles'] == 6, 'PLATE + 5 visible bolt placements = 6 solids (%d)' % stat['bodies'])
check(stat['unique'] == 4, 'meshes stored once per (component, body, color) + fallback: PLATE, BOLT, BOLT(colored), BOLT(baked) = 4 (%d)' % stat['unique'])
check(stat['fallback'] == 1 and stat['hidden'] == 5, 'one placement fell back to baking; hidden bodies skipped (%d / %d)' % (stat['fallback'], stat['hidden']))
kids = model['root']['children']
b1 = kids[1]['children'][0]
check(kids[1]['name'] == 'BOLT:1' and b1['meshIndex'] == kids[2]['children'][0]['meshIndex'], 'BOLT:1 and BOLT:2 share one mesh')
check(b1['matrix'][12] == 50.0 and kids[3]['children'][0]['matrix'][13] == 20.0, 'matrix translation is converted cm → mm (50, 20)')
shared = model['meshes'][b1['meshIndex']]
check(list(shared['positions'][:3]) == [0.0, 0.0, 0.0], 'shared mesh is tessellated at the component origin')
b4 = kids[4]['children'][0]
check(b4['matrix'] is None and model['meshes'][b4['meshIndex']]['positions'][0] == 990.0, 'the lying placement is baked in world coordinates (x = 99cm → 990mm) with no matrix')
check(model['meshes'][kids[5]['children'][0]['meshIndex']]['color'] == [0.1, 0.2, 0.3] and kids[5]['children'][0]['meshIndex'] != b1['meshIndex'], 'a differently colored placement gets its own mesh')
check(all(m['normals'] is None for m in model['meshes']), 'no normals are stored (viewer computes them)')
gz, raw = ns['glbwrite'].write_gz(model) if 'glbwrite' in ns else (None, None)
# index.json の階層一覧: ボディ (葉) の名前まで入る。読み込んでいない装置を部品名で探すのに使う
rows = ns['flatten_tree'](model['root'])
check(rows[0]['name'] == 'ROOT' and rows[0]['depth'] == 0 and rows[0]['solids'] == 6, 'flatten_tree: root row counts every placed body (6)')
check(any(r['name'] == 'body1' and r['depth'] == 2 and r['path'] == 'ROOT/BOLT:1/body1' and r['solids'] == 1 for r in rows), 'flatten_tree: body names are listed as leaves with their path')
check(not any(r['name'] in ('hidden', 'GHOST:1') for r in rows), 'flatten_tree: hidden bodies / occurrences are not listed')
crows = ns['component_tree'](design.rootComponent)
check(any(r['name'] == 'PLATE' and r['depth'] == 1 for r in crows) and any(r['name'] == 'body1' and r['path'] == 'ROOT/BOLT:1/body1' for r in crows), 'component_tree (STEP 格納): body names are listed too')
check(not any(r['name'] == 'hidden' for r in crows), 'component_tree: hidden bodies are not listed')
print('collect_meshes OK')
