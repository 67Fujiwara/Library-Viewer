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
    def calculate(s):
        if s.body.broken == 'raise': raise RuntimeError('2 : InternalValidationError : facesToFacet_.size() > 0')   # 実機で起きた
        return None if s.body.broken else Mesh(s.body.pts)
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
class BrokenOcc:
    """外部参照が読めないオカレンス: component / bRepBodies / childOccurrences を触ると RuntimeError"""
    def __init__(s, name): s.name, s.appearance = name, None
    @property
    def isVisible(s): raise RuntimeError('2 : InternalValidationError : path.valid()')   # 実機ではここで先に落ちた
    @property
    def component(s): raise RuntimeError("3 : The occurrence's referenced component is unavailable (broken or missing external reference).")
    @property
    def bRepBodies(s): raise RuntimeError('3 : unavailable')
    @property
    def childOccurrences(s): raise RuntimeError('3 : unavailable')
class Root:
    def __init__(s): s.name = 'ROOT'; s.bRepBodies = Coll(); s.occurrences = Coll()
class Design:
    def __init__(s): s.rootComponent = Root()

adsk = types.SimpleNamespace(doEvents=lambda: None, fusion=types.SimpleNamespace(TriangleMeshQualityOptions=types.SimpleNamespace(LowQualityTriangleMesh=0, NormalQualityTriangleMesh=1, HighQualityTriangleMesh=2)), core=types.SimpleNamespace())
ns = {'adsk': adsk, 'array': array, 'gc': gc, 're': re, 'json': json, 'os': os}
exec(src[src.index('CM_TO_MM ='):src.index('CM_TO_MM =') + len('CM_TO_MM = 10.0')], ns)
exec(src[src.index('MESH_QUALITY = ['):src.index('class CommandCreatedHandler')], ns)
exec(src[src.index('BROKEN_REFS = []'):src.index('def placement_of')], ns)
exec(src[src.index('def component_tree'):src.index('# ---- メッシュで格納')], ns)
exec(src[src.index('def read_json'):src.index('def library_layout')], ns)
exec(src[src.index("def script_version"):src.index("SETTINGS_PATH =")], ns)
ns['_DIR'] = os.path.join(here, '..', 'fusion', 'LibraryExport')
ns['body_color'] = lambda body, occ=None: body.appearance or (occ.appearance if occ is not None else None)   # 外観は色そのものを入れておく

def check(c, m):
    if not c: raise SystemExit('FAIL: ' + m)
    print('  ok  ' + m)

tri = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]                                 # cm
bolt = Comp('c-bolt', 'BOLT', [Body('body1', tri), Body('hidden', tri, visible=False)])
design = Design()
design.rootComponent.bRepBodies.append(Body('PLATE', tri))
design.rootComponent.bRepBodies.append(Body('CORRUPT', tri, broken='raise'))   # calculate() が例外を投げるボディ
T = lambda x, y=0, z=0: [[1,0,0,x],[0,1,0,y],[0,0,1,z],[0,0,0,1]]
design.rootComponent.occurrences.extend([
    Occ('BOLT:1', bolt, T(5)), Occ('BOLT:2', bolt, T(10)), Occ('BOLT:3', bolt, T(15, 2)),
    Occ('BOLT:4', bolt, T(20), lie=True),                                # 行列が実体と合わない → 焼き込み
    Occ('BOLT:5', bolt, T(25), color=[0.1, 0.2, 0.3]),                  # 色違い → 別メッシュ
    Occ('GHOST:1', bolt, T(30), visible=False),
    BrokenOcc('LINKED_UNIT:1'),                                          # 外部参照が読めない → 飛ばして数える
])
model, stat = ns['collect_meshes'](design, 'normal')
check(stat['bodies'] == 6 and stat['triangles'] == 6, 'PLATE + 5 visible bolt placements = 6 solids (%d)' % stat['bodies'])
check(stat['failed'] == 1 and stat['failedNames'] == ['CORRUPT'], 'a body whose calculate() raises is counted as failed with its name, not a crash (%d, %s)' % (stat['failed'], stat['failedNames']))
check(stat['unique'] == 4, 'meshes stored once per (component, body, color) + fallback: PLATE, BOLT, BOLT(colored), BOLT(baked) = 4 (%d)' % stat['unique'])
check(stat['fallback'] == 1 and stat['hidden'] == 5, 'one placement fell back to baking; hidden bodies skipped (%d / %d)' % (stat['fallback'], stat['hidden']))
check(stat['broken'] == 1 and ns['BROKEN_REFS'] == ['LINKED_UNIT:1'], 'an occurrence that fails even on isVisible (path.valid) is skipped and named (%d, %s)' % (stat['broken'], ns['BROKEN_REFS']))
check('LINKED_UNIT' in ns['broken_note']() and '外部参照' in ns['broken_note'](), 'the note names the broken reference: ' + ns['broken_note']().split(chr(10))[0])
check(ns['count_visible_bodies'](design.rootComponent) == 7, 'count_visible_bodies survives the broken reference (PLATE + CORRUPT + 5 bolts = %d)' % ns['count_visible_bodies'](design.rootComponent))
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
check(not any(r['name'] == 'LINKED_UNIT:1' for r in crows), 'component_tree skips the broken reference')
# split_units: ルートにボディが無いデザインで、壊れた参照を飛ばしてユニットを数える
d2 = Design(); d2.rootComponent.occurrences.extend([Occ('BOLT:1', bolt, T(5)), Occ('BOLT:2', bolt, T(10)), BrokenOcc('LINKED_UNIT:2')])
units = ns['split_units'](d2)
check(units is not None and len(units) == 2 and 'LINKED_UNIT:2' in ns['BROKEN_REFS'], 'split_units skips the broken reference instead of raising (%s)' % (units and len(units)))
# library_file: 名簿・ルールの置き場所。ビューアが models/ を開いているとその中に書かれるので、そこも見る
import tempfile, shutil
tmp = tempfile.mkdtemp()
try:
    lf = ns['library_file']
    check(lf(tmp, 'members.json') == os.path.join(tmp, 'members.json'), 'library_file: nothing exists → root (where it will be written)')
    os.makedirs(os.path.join(tmp, 'models'))
    with open(os.path.join(tmp, 'models', 'members.json'), 'w', encoding='utf-8') as f:
        json.dump({'members': [{'department': '設計1課', 'name': '藤原'}]}, f)
    check(lf(tmp, 'members.json') == os.path.join(tmp, 'models', 'members.json'), 'library_file: root has none but models/ has it → models/ (viewer opened models/)')
    check(ns['library_members'](tmp) == [('設計1課', '藤原')], 'library_members reads the roster the viewer wrote inside models/')
    check(lf(os.path.join(tmp, 'models'), 'members.json') == os.path.join(tmp, 'models', 'members.json'), 'library_file: root = models/ itself → there')
    with open(os.path.join(tmp, 'members.json'), 'w', encoding='utf-8') as f:
        json.dump({'members': [{'department': '設計2課', 'name': '鈴木'}]}, f)
    check(lf(tmp, 'members.json') == os.path.join(tmp, 'members.json'), 'library_file: root wins when both exist')
    os.remove(os.path.join(tmp, 'models', 'members.json'))
    check(lf(os.path.join(tmp, 'models'), 'members.json') == os.path.join(tmp, 'members.json'), 'library_file: root = models/ with the file in the parent → parent')
    check(ns['library_members'](os.path.join(tmp, 'models')) == [('設計2課', '鈴木')], 'library_members follows it')
    # 名簿が無くても、models/<部署>/<担当者>/ のフォルダにいる組は候補になる (格納した人はフォルダにいる)
    os.remove(os.path.join(tmp, 'members.json'))
    for p in (('設計1課', '藤原', 'P2026-007_メッシュ機H', '_'), ('設計2課', '鈴木', 'P2026-002_搬送装置B', '_'), ('_', '_', 'X', '_'), ('inbox',)):
        os.makedirs(os.path.join(tmp, 'models', *p), exist_ok=True)
    with open(os.path.join(tmp, 'models', 'catalog.json'), 'w') as f:
        f.write('{}')
    fm = ns['folder_members'](tmp)
    check(fm == [('設計1課', '藤原'), ('設計2課', '鈴木')], 'folder_members lists 部署/担当者 pairs from models/, skipping _ / inbox / files: %s' % (fm,))
    check(ns['library_members'](tmp) == fm and ns['library_members'](os.path.join(tmp, 'models')) == fm, 'library_members falls back to the folders (root or root = models/)')
    with open(os.path.join(tmp, 'members.json'), 'w', encoding='utf-8') as f:
        json.dump({'members': [{'department': '設計1課', 'name': '山田'}, {'department': '設計1課', 'name': '藤原'}]}, f)
    check(ns['library_members'](tmp) == [('設計1課', '山田'), ('設計1課', '藤原'), ('設計2課', '鈴木')], 'roster entries come first, folder-only pairs are appended without duplicates')
    other = tempfile.mkdtemp(); os.makedirs(os.path.join(other, 'src', 'js'))
    check(ns['folder_members'](other) == [], 'a folder without models/ yields no candidates (unrelated folders are not departments)')
    shutil.rmtree(other, ignore_errors=True)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
check(ns['script_version']().isdigit(), 'script_version reads the VERSION next to the script (v%s); the dialog title shows it' % ns['script_version']())
# 外観の色: 種類ごとに直す (金属は暗く / 透明は alpha / 古い外観の透明度も alpha)。偽の Appearance で通す
class FColor:
    def __init__(s, r, g, b): s.red, s.green, s.blue = r, g, b
class FProp:
    def __init__(s, pid, value): s.id, s.value = pid, value
class FProps:
    def __init__(s, items): s._items = items
    @property
    def count(s): return len(s._items)
    def item(s, i): return s._items[i]
    def itemById(s, pid):
        for p in s._items:
            if p.id == pid: return p
        return None
class FApp:
    def __init__(s, name, items): s.name, s.id, s.appearanceProperties = name, 'id-' + name, FProps(items)
lin = ns['srgb_to_linear']
paint = ns['appearance_color'](FApp('Paint', [FProp('opaque_albedo', FColor(30, 30, 30))]))
check(len(paint) == 3 and abs(paint[0] - lin(30)) < 1e-9, 'a painted appearance keeps its albedo as is (no alpha): %s' % paint)
steel = ns['appearance_color'](FApp('Steel', [FProp('surface_roughness', 0.3), FProp('metal_f0', FColor(200, 200, 200))]))
check(len(steel) == 3 and abs(steel[0] - lin(200) * ns['METAL_SHADE']) < 1e-9, 'a metal appearance is darkened by METAL_SHADE (f0 is a reflectance, not the visible grey): %.3f' % steel[0])
acr = ns['appearance_color'](FApp('Acrylic', [FProp('transparent_ior', 1.49), FProp('transparent_color', FColor(250, 250, 250))]))
check(len(acr) == 4 and acr[3] == ns['CLEAR_ALPHA'], 'a transparent appearance gets alpha CLEAR_ALPHA: %s' % acr)
old = ns['appearance_color'](FApp('OldPlastic', [FProp('generic_diffuse', FColor(255, 0, 0)), FProp('generic_transparency', 0.6)]))
check(len(old) == 4 and abs(old[3] - 0.4) < 1e-9 and abs(old[0] - 1.0) < 1e-9, 'a legacy appearance with generic_transparency 0.6 gets alpha 0.4: %s' % old)
opaque_old = ns['appearance_color'](FApp('OldOpaque', [FProp('generic_diffuse', FColor(0, 255, 0)), FProp('generic_transparency', 0.0)]))
check(len(opaque_old) == 3, 'generic_transparency 0 stays opaque')
check(ns['appearance_color'](FApp('Steel', [FProp('metal_f0', FColor(10, 10, 10))])) == steel, 'the color cache is keyed by (name, id): the same appearance returns the cached color')
# 古い (Protein) 系の id と、候補に無い id からの「色らしい」選び方
pv = ns['appearance_color'](FApp('Vinyl', [FProp('plasticvinyl_color', FColor(0, 0, 255))]))
check(len(pv) == 3 and abs(pv[2] - 1.0) < 1e-9 and abs(pv[0]) < 1e-9, 'a Protein plastic/vinyl appearance is read from plasticvinyl_color: %s' % pv)
odd = ns['appearance_color'](FApp('Odd', [FProp('odd_f0', FColor(255, 255, 255)), FProp('odd_specular', FColor(200, 200, 200)), FProp('odd_diffuse', FColor(255, 0, 0))]))
check(abs(odd[0] - 1.0) < 1e-9 and abs(odd[1]) < 1e-9, 'an unknown schema picks the diffuse-looking color, not f0 / specular: %s' % odd)
only_f0 = ns['appearance_color'](FApp('OnlyF0', [FProp('x_f0', FColor(128, 128, 128))]))
check(only_f0 is not None and len(only_f0) == 3, 'if only a reflectance color exists it is still used rather than the default')
rep = ns['appearance_report']()
check(any(r.startswith('Odd ×0: odd_diffuse → #ff0000') for r in rep) and any('Acrylic' in r and 'α0.30' in r for r in rep), 'the appearance report lists property id, sRGB hex and alpha per appearance: %s' % rep[:3])
print('collect_meshes OK')
