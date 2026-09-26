# -*- coding: utf-8 -*-
"""Library Export — Fusion 360 スクリプト

開いている設計を Library Viewer の共有フォルダ (ライブラリ) に案件情報付きで格納します。
ビューア側の「格納する」と同じフォルダ構造・同じ meta.json を作るので、
格納した直後から誰でも Library Viewer で開けます。

  設計者の操作: [ユーティリティ] → [スクリプトとアドイン] → LibraryExport → 実行
                → 案件コード / 装置名 / 対象ワーク / 部署 / 担当者 を入れて OK

  管理者の作業: なし。フォルダに置いたものがそのまま一覧になります。

格納の方式は 2 つ:
  ・メッシュで格納 (既定・推奨): Fusion が持っている三角形メッシュをそのまま glb.gz に書く。
    ビューア側の STEP 変換 (サイズの 2 乗で遅くなり、数百 MB では失敗する) を通らないので、
    どんな大きさでも開くのは一瞬。共有フォルダに置くのも最初から glb.gz だけ (STEP の 1/23)。
  ・STEP で格納: 従来どおり。ビューアが初回に開いたときに glb を作って書き戻す。
    大きいときは「ユニットごとに分けて書き出す」で分割する。

依存: Fusion 360 標準の Python のみ (外部ライブラリ不要)。glb の書き出しは同じフォルダの glbwrite.py。
設定 (ライブラリのパス) は ~/.library-viewer/fusion.json に保存されます。
"""
import adsk.core, adsk.fusion, traceback
import os, sys, json, re, datetime, gc
from array import array

# 同じフォルダの glbwrite.py (純 Python の GLB ライター。Fusion 無しでテスト済み)
# Fusion はスクリプトの Python を終了せずに使い回すので、一度 import したモジュールは
# ファイルを差し替えても古いまま残る。必ず reload して、上書きコピーした版を使う
import importlib
_DIR = os.path.dirname(os.path.abspath(__file__))
if _DIR not in sys.path:
    sys.path.insert(0, _DIR)
import glbwrite
glbwrite = importlib.reload(glbwrite)

_app = None
_ui = None
_handlers = []          # イベントハンドラを GC から守る
CMD_ID = 'libraryViewerExport'
SETTINGS_PATH = os.path.join(os.path.expanduser('~'), '.library-viewer', 'fusion.json')

# ビューアと同じ保存階層。**1 つに固定** (09-store.js の LAYOUT と必ず揃える)
def layout_segments(p):
    return ['models', p['dept'], p['owner'], p['code'] + '_' + p['dev'], p['work']]


LAYOUT_LABEL = 'models / 部署 / 担当者 / 案件コード_装置名 / 対象ワーク'


def sanitize(s):
    s = re.sub(r'[\\/:*?"<>|]', '_', (s or '').strip())
    return s or '_'


def load_settings():
    try:
        with open(SETTINGS_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def save_settings(d):
    try:
        os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
        with open(SETTINGS_PATH, 'w', encoding='utf-8') as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def read_json(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def now_iso():
    d = datetime.datetime.now().astimezone()
    return d.strftime('%Y-%m-%dT%H:%M:%S%z')[:-2] + ':' + d.strftime('%z')[-2:]


def library_members(root):
    """members.json → [(部署, 担当者)]。無ければ空。"""
    mj = read_json(os.path.join(root, 'members.json'))
    lst = mj if isinstance(mj, list) else (mj or {}).get('members', [])
    return [(m.get('department', ''), m.get('name', '')) for m in lst if m.get('department') and m.get('name')]


def library_layout(root):
    """library.json があるかどうか (階層そのものは 1 つに固定なので、記録の有無だけ見る)。"""
    cfg = read_json(os.path.join(root, 'library.json'))
    return cfg.get('layout') if cfg else None


# ---- ネーミングルール (ビューアの src/js/03b-naming.js と同じ規則) ----
NAMING_FIELDS = ('projectCode', 'deviceName', 'workpiece', 'customer', 'department', 'owner')
NAMING_OPTIONAL = ('workpiece', 'customer')   # 空でもよい項目
NAMING_DEFAULT = {'pattern': '{projectCode}_{deviceName}_{workpiece}_{department}_{owner}_{customer}', 'separator': '_'}
NAMING_GREEDY = 'deviceName'


def naming_rule(root):
    cfg = read_json(os.path.join(root, 'library.json')) if root else None
    rule = (cfg or {}).get('naming') or NAMING_DEFAULT
    return rule if naming_fields(rule) else NAMING_DEFAULT


def naming_fields(rule):
    out = []
    for part in str(rule.get('pattern', '')).split(rule.get('separator', '_')):
        m = re.match(r'^\{(\w+)\}$', part.strip())
        if not m or m.group(1) not in NAMING_FIELDS:
            return None
        out.append(m.group(1))
    return out or None


def naming_parse(name, rule):
    """ファイル名 / ドキュメント名 → dict | None。装置名だけ区切り文字を含んでよい。
    まず全項目で読み、駄目なら末尾の「空でもよい項目」を 1 つずつ無いものとして読み直す
    (取引先を足す前の古い名前との互換。03b-naming.js の parse と同じ規則)"""
    fields = naming_fields(rule)
    if not fields:
        return None
    sep = rule.get('separator', '_')
    base = re.sub(r'\.(step|stp)$', '', name, flags=re.I)
    base = re.sub(r'\s+v\d+$', '', base).strip()
    if sep == '_':
        base = base.replace('＿', '_')
    parts = [p.strip() for p in base.split(sep)]
    fields = list(fields)
    absent = []
    while True:
        out = _naming_parse_with(parts, fields, sep)
        if out is not None:
            for k in absent:
                out[k] = ''
            return out
        if fields[-1] not in NAMING_OPTIONAL or len(fields) <= 2:
            return None
        absent.append(fields.pop())


def _naming_parse_with(parts, fields, sep):
    if len(parts) < len(fields):
        return None
    gi = fields.index(NAMING_GREEDY) if NAMING_GREEDY in fields else len(fields) - 1
    out = {}
    for i in range(gi):
        out[fields[i]] = parts[i]
    after = len(fields) - gi - 1
    for i in range(after):
        out[fields[len(fields) - 1 - i]] = parts[len(parts) - 1 - i]
    out[fields[gi]] = sep.join(parts[gi:len(parts) - after])
    for k, v in out.items():
        if not v and k not in NAMING_OPTIONAL:
            return None
    return out


def naming_format(values, rule):
    fields = naming_fields(rule) or naming_fields(NAMING_DEFAULT)
    sep = rule.get('separator', '_')
    out = []
    for f in fields:
        v = re.sub(r'[\\/:*?"<>|]', '_', (values.get(f) or '').strip())
        out.append(v if f == NAMING_GREEDY else v.replace(sep, '-'))
    return sep.join(out)


# ---- ユニットごとの分割書き出し -------------------------------------------------
# 大きいアセンブリを 1 本の STEP にすると、ビューアの変換がメモリと時間で詰む
# (実測: 19MB 102 秒 / 59MB 12.7 分 / 373MB は失敗)。ルート直下のオカレンスごとに
# 分けて書き出し、組立位置は meta.json に持たせてビューア側で戻す。
#
# 注意: createSTEPExportOptions に渡すのは **Occurrence ではなく Component**。
# Component は自分の原点に置かれた形で書き出されるので、位置の扱いが曖昧にならない。
# (Occurrence を渡した場合に配置が保たれるかは Fusion の版によって当てにならない)
CM_TO_MM = 10.0   # Fusion API の長さは cm、STEP と meta.json は mm


def split_units(design):
    """分割して書き出せるならルート直下のオカレンス一覧、できないなら None。

    ルート直下に直接ボディがあるデザインは分割すると取りこぼすので None を返す。
    オカレンスが 1 つしかないときも分ける意味がないので None。
    """
    root = design.rootComponent
    if root.bRepBodies.count > 0:
        return None
    out = []
    for i in range(root.occurrences.count):
        occ = root.occurrences.item(i)
        comp = occ.component
        if comp.bRepBodies.count == 0 and comp.occurrences.count == 0:
            continue                      # 中身の無いオカレンスは書き出さない
        out.append(occ)
    return out if len(out) >= 2 else None


def placement_of(occ):
    """組立位置を「原点 + 3 軸」で返す (mm)。

    行列を 16 要素で渡すと行優先/列優先の取り違えが起きるので、
    getAsCoordinateSystem() で軸として取り出して明示的に書く。
    ビューア側 (GLB.place) は p' = origin + x*px + y*py + z*pz で戻す。
    """
    m = getattr(occ, 'transform2', None) or occ.transform
    res = m.getAsCoordinateSystem()
    vals = [v for v in res if not isinstance(v, bool)]   # 版によって先頭に成否が付く
    o, xa, ya, za = vals[0], vals[1], vals[2], vals[3]
    return {
        'origin': [o.x * CM_TO_MM, o.y * CM_TO_MM, o.z * CM_TO_MM],
        'x': [xa.x, xa.y, xa.z], 'y': [ya.x, ya.y, ya.z], 'z': [za.x, za.y, za.z],
    }


def unit_suffix(occ, used):
    """ユニットのファイル名に足す名前。"ARM:1" の :1 は落とし、重複は連番で避ける"""
    name = sanitize(occ.name.split(':')[0]) or 'UNIT'
    out, k = name, 2
    while out in used:
        out = name + '_' + str(k); k += 1
    used.add(out)
    return out


def component_tree(root_comp):
    """Fusion のオカレンス階層 → index.json 用のフラットな一覧 (名称・階層パス・深さ・ソリッド数)"""
    rows = []

    def count_bodies(comp):
        n = comp.bRepBodies.count
        for occ in comp.occurrences:
            n += count_bodies(occ.component)
        return n

    def walk(comp, name, path, depth):
        rows.append({'name': name, 'path': '/'.join(path), 'depth': depth, 'solids': count_bodies(comp)})
        # ボディ (ビューアのツリーの葉 = 部品) も名前を残す。これが無いと読み込んでいない装置が部品名で当たらない
        for body in comp.bRepBodies:
            if getattr(body, 'isVisible', True):
                rows.append({'name': body.name, 'path': '/'.join(path + [body.name]), 'depth': depth + 1, 'solids': 1})
        for occ in comp.occurrences:
            walk(occ.component, occ.name, path + [occ.name], depth + 1)

    walk(root_comp, root_comp.name, [root_comp.name], 0)
    return rows


# ---- メッシュで格納 ----------------------------------------------------------------
# STEP を経由せず、Fusion が持つ三角形メッシュを直接 glb にする。
#   body.meshManager.createMeshCalculator() → setQuality() → calculate() → TriangleMesh
# ボディは **Occurrence 経由 (occ.bRepBodies)** で取る。プロキシなので座標が組立位置に
# 置かれた状態で返り、placement の計算がそもそも要らない (occ.component.bRepBodies だと
# 部品自身の原点になり、同じ部品を 3 個並べても 3 個とも同じ場所に出る)。
# 座標は cm で返るので mm に直す。節点は元の曲面上に乗っているので計測の精度は落ちない。
MESH_QUALITY = [   # (id, 表示名, 曲面からのずれ mm, 隣り合う三角形の法線の角度差 度, setQuality の代替)
    ('coarse', '粗い', 0.20, 30.0, 'LowQualityTriangleMesh'),
    ('normal', '標準', 0.05, 15.0, 'NormalQualityTriangleMesh'),
    ('fine', '細かい', 0.01, 8.0, 'HighQualityTriangleMesh'),
]
# 三角形の数がそのままファイルサイズ (実測 7.5 バイト/三角形、gzip 後)。
# 小さい部品 (ねじ等) は同じ「ずれ」でも半径が小さいぶん分割が細かくなるので、部品の大きさに応じて
# ずれを緩める: tol = min(基準, max(0.01mm, 大きさ × 0.002))。20mm のねじなら 0.04mm (円周 14 分割)


def adaptive_tolerance(extent_mm, base_mm):
    return min(base_mm, max(0.01, extent_mm * 0.002))


def body_extent_mm(body):
    try:
        bb = body.boundingBox
        return max(bb.maxPoint.x - bb.minPoint.x, bb.maxPoint.y - bb.minPoint.y, bb.maxPoint.z - bb.minPoint.z) * CM_TO_MM
    except Exception:
        return 1000.0


# 外観の色。Fusion の Appearance は種類ごとに色のプロパティ id が違う
# (塗装・プラスチック = opaque_albedo / 金属 = metal_f0 / 積層 = layered_diffuse / ガラス = transparent_color …)。
# 1 つの id だけ見ると塗装以外が全部既定色に落ちる (実機で起きた) ので、優先順で探し、
# 無ければ最初の ColorProperty を使う。値は sRGB 0..255 なので **リニアに直して**渡す
# (ビューアは renderer.outputEncoding = sRGB で、glb の baseColorFactor はリニア。occt の色もリニア)。
COLOR_PROP_IDS = ['opaque_albedo', 'layered_diffuse', 'metal_f0', 'surface_albedo', 'generic_diffuse',
                  'transparent_color', 'glazing_transmittance_color', 'wood_color']
_color_cache = {}          # appearance.id → [r,g,b] | None
_uncolored_samples = []    # 色が取れなかった外観の見本 (格納後のメッセージに出す)


def srgb_to_linear(v):
    c = v / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _prop_color(prop):
    """Property → [r,g,b] リニア | None。型 (objectType) は見ない: value に red/green/blue が
    あれば色とみなす (FloatProperty などは AttributeError になって None)"""
    if prop is None:
        return None
    try:
        c = prop.value
        return [srgb_to_linear(c.red), srgb_to_linear(c.green), srgb_to_linear(c.blue)]
    except Exception:
        return None


def appearance_color(app):
    if app is None:
        return None
    key = None
    try:
        key = (app.name, app.id)          # id だけだと同じ値を返す版があり、全部が最初の色になった (実機)
        if not app.name or not app.id:
            key = None
        elif key in _color_cache:
            return _color_cache[key]
    except Exception:
        key = None
    color, last_err, props = None, '', None
    try:
        props = app.appearanceProperties
    except Exception as e:
        last_err = repr(e)
    if props is not None:
        for pid in COLOR_PROP_IDS:                       # 1 段ずつ守る (無い id で例外になっても次へ)
            try:
                color = _prop_color(props.itemById(pid))
            except Exception as e:
                color, last_err = None, repr(e)
            if color:
                break
        if color is None:                                # どれでもいいので最初の色プロパティ
            try:
                n = props.count
            except Exception as e:
                n, last_err = 0, repr(e)
            for i in range(n):
                try:
                    color = _prop_color(props.item(i))
                except Exception as e:
                    color, last_err = None, repr(e)
                if color:
                    break
    if color is None and len(_uncolored_samples) < 6:
        ids = []
        try:
            for i in range(props.count):
                try:
                    ids.append(props.item(i).id)
                except Exception:
                    pass
        except Exception:
            pass
        name = ''
        try:
            name = app.name
        except Exception:
            pass
        _uncolored_samples.append('%s: [%s]%s' % (name, ', '.join(ids[:12]), ('  err=' + last_err) if last_err else ''))
    if key is not None:
        _color_cache[key] = color
    return color


def body_color(body, occ=None):
    """外観の色 [r,g,b] (リニア 0..1)。ボディ → オカレンスの順に見る。取れなければ None (ビューアの既定色)"""
    for get in (lambda: body.appearance, lambda: occ.appearance if occ is not None else None):
        try:
            c = appearance_color(get())
        except Exception:
            c = None
        if c:
            return c
    return None


def tessellate(body, quality_id, color):
    """ボディ → glbwrite の mesh。座標は **そのボディの文脈のまま** (コンポーネントのボディなら部品の原点)。
    法線は書かない (ビューアが計算する。ファイルが 8% 小さい)"""
    q = next(x for x in MESH_QUALITY if x[0] == quality_id)
    calc = body.meshManager.createMeshCalculator()
    try:
        tol = adaptive_tolerance(body_extent_mm(body), q[2])
        calc.surfaceTolerance = tol / CM_TO_MM        # cm
        calc.normalDeviation = q[3]
    except Exception:
        calc.setQuality(getattr(adsk.fusion.TriangleMeshQualityOptions, q[4]))
    mesh = calc.calculate()
    if mesh is None:
        return None
    # その場で 4 バイトの array に畳む。Python の float のリストで抱えると 1 要素 32 バイトで、
    # 実測 2053 ボディ / 122 万三角形のアセンブリでは 400MB を超える (array なら 1/8)
    m = {'name': body.name,
         'positions': array('f', (v * CM_TO_MM for v in mesh.nodeCoordinatesAsFloat)),   # cm → mm
         'normals': None,
         'indices': array('I', mesh.nodeIndices),
         'color': color}
    del mesh, calc
    return m


def count_visible_bodies(root):
    """進捗バーの分母。走査だけなので速い"""
    n = 0
    for body in root.bRepBodies:
        if body.isVisible:
            n += 1
    def walk(occs):
        nonlocal n
        for occ in occs:
            if not occ.isVisible:
                continue
            for body in occ.bRepBodies:
                if body.isVisible:
                    n += 1
            walk(occ.childOccurrences)
    walk(root.occurrences)
    return n


class Cancelled(Exception):
    pass


def occurrence_matrix(occ):
    """オカレンスのワールド変換 (ルート基準) を glTF の列優先 16 要素 (mm) で。
    transform2 が正 (transform は誤った値を返す場合があり退役)。Matrix3D.asArray() は行優先なので転置する"""
    m = getattr(occ, 'transform2', None) or occ.transform
    a = m.asArray()                                 # 行優先 16 要素、平行移動は a[3], a[7], a[11] (cm)
    return [a[0], a[4], a[8], 0.0,
            a[1], a[5], a[9], 0.0,
            a[2], a[6], a[10], 0.0,
            a[3] * CM_TO_MM, a[7] * CM_TO_MM, a[11] * CM_TO_MM, 1.0]


def matrix_ok(occ, mtx):
    """行列の向き・単位の自己検査: B-rep の頂点 1 つを「部品の座標 × 行列」と「組立座標のプロキシ」で比べる。
    比べられるものが無ければ True (信じる)。ずれていれば False → その配置は焼き込みに退避する"""
    try:
        comp = occ.component
        for i in range(min(comp.bRepBodies.count, 3)):
            lb, pb = comp.bRepBodies.item(i), occ.bRepBodies.item(i)
            if lb.vertices.count == 0:
                continue
            lp, pp = lb.vertices.item(0).geometry, pb.vertices.item(0).geometry
            x, y, z = lp.x * CM_TO_MM, lp.y * CM_TO_MM, lp.z * CM_TO_MM
            wx = mtx[0] * x + mtx[4] * y + mtx[8] * z + mtx[12]
            wy = mtx[1] * x + mtx[5] * y + mtx[9] * z + mtx[13]
            wz = mtx[2] * x + mtx[6] * y + mtx[10] * z + mtx[14]
            d = ((wx - pp.x * CM_TO_MM) ** 2 + (wy - pp.y * CM_TO_MM) ** 2 + (wz - pp.z * CM_TO_MM) ** 2) ** 0.5
            return d < 0.01                         # 10µm
        return True
    except Exception:
        return True


def collect_meshes(design, quality_id, progress=None):
    """デザイン全体を glbwrite の model 形式に。ツリーは Fusion のオカレンス階層そのまま。
    **同じコンポーネントのボディは 1 回だけメッシュ化し** (部品の原点で)、配置はノードの行列で持つ
    (インスタンス化。ねじ・ローラーなど同じ部品が何十個も並ぶので、ファイルが桁で小さくなる)。
    行列の自己検査に落ちた配置だけ、組立座標のプロキシから焼き込む (fallback)。
    progress: adsk.core.ProgressDialog (省略可)。キャンセルされたら Cancelled を投げる。
    戻り: (model, {'bodies', 'unique', 'hidden', 'failed', 'triangles', 'colored', 'fallback'})"""
    root = design.rootComponent
    meshes, cache = [], {}          # cache: (コンポーネント id, ボディ番号, 色) → メッシュ番号
    stat = {'bodies': 0, 'unique': 0, 'hidden': 0, 'failed': 0, 'triangles': 0, 'seen': 0, 'colored': 0, 'fallback': 0,
            'small_tris': 0, 'top': [], 'colors': set()}
    _color_cache.clear(); del _uncolored_samples[:]

    def tick():
        stat['seen'] += 1
        if progress is not None:
            progress.progressValue = stat['seen']
            if progress.wasCancelled:
                raise Cancelled()
        if stat['seen'] % 25 == 0:
            adsk.doEvents()          # UI に息をさせる (固まったままだと落ちたように見える)
        if stat['seen'] % 200 == 0:
            gc.collect()

    def color_key(c):
        return None if not c else (round(c[0], 3), round(c[1], 3), round(c[2], 3))

    def comp_key(comp):
        try:
            return comp.id
        except Exception:
            return comp.name

    def place(node, name, mi, mtx, tris, extent):
        node['children'].append({'name': name, 'meshIndex': mi, 'matrix': mtx, 'children': []})
        stat['bodies'] += 1
        stat['triangles'] += tris
        if extent < 30.0:
            stat['small_tris'] += tris
        c = meshes[mi].get('color')
        if c:
            stat['colors'].add((round(c[0], 2), round(c[1], 2), round(c[2], 2)))
        top = stat['top']; top.append((tris, name)); top.sort(reverse=True); del top[8:]

    def add_root_bodies(node):
        for body in root.bRepBodies:
            if not body.isVisible:
                stat['hidden'] += 1; continue
            m = tessellate(body, quality_id, body_color(body))
            tick()
            if m is None:
                stat['failed'] += 1; continue
            meshes.append(m)
            if m['color']:
                stat['colored'] += 1
            place(node, body.name, len(meshes) - 1, None, len(m['indices']) // 3, body_extent_mm(body))

    def add_occ_bodies(occ, node):
        comp = occ.component
        ck = comp_key(comp)
        mtx = occurrence_matrix(occ)
        shared = matrix_ok(occ, mtx)
        if not shared:
            stat['fallback'] += 1
        n = comp.bRepBodies.count
        for i in range(n):
            pb = occ.bRepBodies.item(i)              # 組立座標のプロキシ (表示 / 色はこちらで見る)
            if not pb.isVisible:
                stat['hidden'] += 1; continue
            color = body_color(pb, occ)
            if shared:
                key = (ck, i, color_key(color))
                mi = cache.get(key)
                if mi is None:
                    m = tessellate(comp.bRepBodies.item(i), quality_id, color)   # 部品の原点で 1 回だけ
                    if m is None:
                        stat['failed'] += 1; tick(); continue
                    meshes.append(m); mi = len(meshes) - 1; cache[key] = mi
                    if color:
                        stat['colored'] += 1
                tick()
                place(node, pb.name, mi, mtx, len(meshes[mi]['indices']) // 3, body_extent_mm(pb))
            else:
                m = tessellate(pb, quality_id, color)                                # 焼き込み (共有しない)
                tick()
                if m is None:
                    stat['failed'] += 1; continue
                meshes.append(m)
                if color:
                    stat['colored'] += 1
                place(node, pb.name, len(meshes) - 1, None, len(m['indices']) // 3, body_extent_mm(pb))

    def walk(occs, node):
        for occ in occs:
            if not occ.isVisible:
                continue
            sub = {'name': occ.name, 'meshIndex': None, 'matrix': None, 'children': []}
            add_occ_bodies(occ, sub)
            walk(occ.childOccurrences, sub)
            if sub['children']:
                node['children'].append(sub)

    tree = {'name': root.name, 'meshIndex': None, 'matrix': None, 'children': []}
    add_root_bodies(tree)
    walk(root.occurrences, tree)
    stat['unique'] = len(meshes)
    return {'name': root.name, 'root': tree, 'meshes': meshes}, stat


def flatten_tree(root):
    """glb のノード階層 → index.json 用のフラットな一覧。09-store.js の flattenTree と同じ形
    (名称・階層パス・深さ・ソリッド数)。メッシュ格納では実際に書いた glb のノード (ボディの葉まで) を
    そのまま写すので、ビューアのツリーに出る名前と index.json の名前が一致する"""
    out = []

    def solids(n):
        return (1 if n.get('meshIndex') is not None else 0) + sum(solids(c) for c in n.get('children') or [])

    def walk(n, depth, path):
        p = path + [n.get('name') or '']
        out.append({'name': n.get('name') or '', 'path': '/'.join(p), 'depth': depth, 'solids': solids(n)})
        for c in n.get('children') or []:
            walk(c, depth + 1, p)

    walk(root, 0, [])
    return out


class CommandCreatedHandler(adsk.core.CommandCreatedEventHandler):
    def notify(self, args):
        try:
            cmd = args.command
            cmd.isRepeatable = False
            cmd.okButtonText = '格納する'
            # 既定の幅だとラベルが「案件コー…」と切れる。ラベル列が入る幅で開く
            try:
                cmd.setDialogInitialSize(560, 560)
                cmd.setDialogMinimumSize(500, 440)
            except Exception:
                pass
            inputs = cmd.commandInputs
            st = load_settings()
            root = st.get('libraryRoot', '')
            design = adsk.fusion.Design.cast(_app.activeProduct)
            doc_name = re.sub(r'\s+v\d+$', '', _app.activeDocument.name)

            rule = naming_rule(root)
            parsed = naming_parse(doc_name, rule) or {}
            inputs.addStringValueInput('libraryRoot', 'ライブラリ', root)
            inputs.addBoolValueInput('browse', 'フォルダを選ぶ…', False, '', False)

            inputs.addStringValueInput('projectCode', '案件コード *', parsed.get('projectCode') or '')
            inputs.addStringValueInput('deviceName', '装置名 *', parsed.get('deviceName') or (design.rootComponent.name if design else doc_name))
            inputs.addStringValueInput('workpiece', '対象ワーク', parsed.get('workpiece') or '')
            inputs.addStringValueInput('customer', '取引先', parsed.get('customer') or '')

            # 部署・担当者は名簿 (members.json) から選ぶ。手入力欄は置かない (名簿に無い人はビューアの「名簿」で足す)。
            # 名簿がまだ無いライブラリでだけ、代わりに文字入力にする
            members = library_members(root) if root else []
            # 前回の値は引き継がない。ドキュメント名がルールに合うときだけ入れる
            last_dept = parsed.get('department') or ''
            last_owner = parsed.get('owner') or ''
            if members:
                if last_dept and last_owner and (last_dept, last_owner) not in members:
                    members.append((last_dept, last_owner))       # ドキュメント名の人も選べるように
                depts = []
                for d, _ in members:
                    if d not in depts:
                        depts.append(d)
                dd2 = inputs.addDropDownCommandInput('dept', '部署 *', adsk.core.DropDownStyles.TextListDropDownStyle)
                cur_dept = last_dept if last_dept in depts else ''
                dd2.listItems.add(PLACEHOLDER, cur_dept == '')
                for d in depts:
                    dd2.listItems.add(d, d == cur_dept)
                dd3 = inputs.addDropDownCommandInput('owner', '担当者 *', adsk.core.DropDownStyles.TextListDropDownStyle)
                fill_owners(dd3, members, cur_dept, last_owner)
            else:
                inputs.addStringValueInput('dept', '部署 *', last_dept)
                inputs.addStringValueInput('owner', '担当者 *', last_owner)

            mesh_on = bool(st.get('lastMesh', True))
            chk_mesh = inputs.addBoolValueInput('mesh', 'メッシュで格納', True, '', mesh_on)
            chk_mesh.tooltip = ('Fusion のメッシュをそのまま glb.gz に書きます。ビューア側の STEP 変換を通らないので、\n'
                                'どんな大きさでも開くのは一瞬です。共有フォルダに置くのも glb.gz だけ (STEP の 1/23)。')
            ddq = inputs.addDropDownCommandInput('quality', '細かさ', adsk.core.DropDownStyles.TextListDropDownStyle)
            last_q = 'normal'                  # 初期値は毎回「標準」
            for qid, label, _t, _d, _q in MESH_QUALITY:
                ddq.listItems.add(label, qid == last_q)
            ddq.isEnabled = mesh_on
            adv = inputs.addGroupCommandInput('adv', '詳細')
            adv.isExpanded = False
            chk_keep = adv.children.addBoolValueInput('keepStep', 'STEP も書き出す', True, '', bool(st.get('lastKeepStep', False)))
            chk_keep.tooltip = 'メッシュで格納するときに STEP も step/ に置きます (後で細かさを変えて再変換したいとき)。容量は 23 倍になります。'
            chk_keep.isEnabled = mesh_on
            units = split_units(design) if design else None
            chk = adv.children.addBoolValueInput('split', 'ユニット分割', True, '', bool(st.get('lastSplit', False)) and bool(units) and not mesh_on)
            chk.isEnabled = bool(units) and not mesh_on
            chk.tooltip = ('STEP で格納するとき、大きいアセンブリはこちら。ルート直下のユニットごとに STEP を分け、組立位置は meta.json に残します。\n'
                           'ライブラリ上は 1 件のままで、ビューアで開くと全ユニットがまとめて読み込まれます。\n'
                           '(メッシュで格納するときは分割の必要がありません)'
                           if units else 'ルート直下にボディがある / ユニットが 1 つなので分割できません')
            inputs.addTextBoxCommandInput('preview', '保存先', '', 2, True)

            on_change = InputChangedHandler(); cmd.inputChanged.add(on_change); _handlers.append(on_change)
            on_exec = ExecuteHandler(); cmd.execute.add(on_exec); _handlers.append(on_exec)
            on_destroy = DestroyHandler(); cmd.destroy.add(on_destroy); _handlers.append(on_destroy)
            update_preview(inputs)
        except Exception:
            _ui.messageBox('LibraryExport:\n' + traceback.format_exc())


PLACEHOLDER = '（選択）'     # 部署・担当者は空から始める。_pick はこれを '' として返す


def fill_owners(dd, members, dept, selected):
    """担当者のドロップダウンを部署で絞って埋める。部署が未選択なら「（選択）」だけ"""
    dd.listItems.clear()
    names = [n for d, n in members if d == dept] if dept else []
    seen = []
    for n in names:
        if n not in seen:
            seen.append(n)
    dd.listItems.add(PLACEHOLDER, selected not in seen)
    for n in seen:
        dd.listItems.add(n, n == selected)


def _pick(inputs, cid):
    """ドロップダウンなら選択中の名前、文字入力ならその値"""
    inp = inputs.itemById(cid)
    dd = adsk.core.DropDownCommandInput.cast(inp)
    if dd:
        name = dd.selectedItem.name if dd.selectedItem else ''
        return '' if name == PLACEHOLDER else name
    return inp.value if inp else ''


def get_params(inputs):
    dept = _pick(inputs, 'dept')
    owner = _pick(inputs, 'owner')
    return {
        'root': inputs.itemById('libraryRoot').value.strip(),
        'codeRaw': inputs.itemById('projectCode').value.strip(), 'devRaw': inputs.itemById('deviceName').value.strip(),
        'workRaw': inputs.itemById('workpiece').value.strip(), 'customerRaw': inputs.itemById('customer').value.strip(),
        'deptRaw': dept.strip(), 'ownerRaw': owner.strip(),
        'code': sanitize(inputs.itemById('projectCode').value), 'dev': sanitize(inputs.itemById('deviceName').value),
        'work': sanitize(inputs.itemById('workpiece').value), 'dept': sanitize(dept), 'owner': sanitize(owner),
        'split': bool(inputs.itemById('split').value) if inputs.itemById('split') else False,
        'mesh': bool(inputs.itemById('mesh').value) if inputs.itemById('mesh') else False,
        'keepStep': bool(inputs.itemById('keepStep').value) if inputs.itemById('keepStep') else False,
        'quality': _quality_id(inputs),
    }


def _quality_id(inputs):
    dd = inputs.itemById('quality')
    sel = dd.selectedItem if dd else None
    for qid, label, _t, _d, _q in MESH_QUALITY:
        if sel and sel.name == label:
            return qid
    return 'normal'


def update_preview(inputs):
    p = get_params(inputs)
    segs = layout_segments(p)
    design = adsk.fusion.Design.cast(_app.activeProduct)
    units = split_units(design) if design else None
    if p['mesh']:
        note = 'メッシュ (glb.gz) で格納します。ビューアで開くのは一瞬です' + ('。STEP も step/ に置きます' if p['keepStep'] else '')
    elif p['split'] and units:
        note = 'STEP をユニット %d 件に分けて書き出します（ライブラリ上は 1 件）' % len(units)
    else:
        note = 'STEP 1 ファイルで書き出します（ビューアが初回に glb を作ります）'
    inputs.itemById('preview').text = (p['root'] or '（ライブラリ未設定）') + '/' + '/'.join(segs) + '/\n' + note


class InputChangedHandler(adsk.core.InputChangedEventHandler):
    def notify(self, args):
        try:
            inputs = args.inputs
            ch = args.input
            if ch.id == 'browse':
                dlg = _ui.createFolderDialog()
                dlg.title = 'ライブラリのフォルダ (DirectCloud の同期フォルダ) を選択'
                if dlg.showDialog() == adsk.core.DialogResults.DialogOK:
                    inputs.itemById('libraryRoot').value = dlg.folder
                    st = load_settings(); st['libraryRoot'] = dlg.folder; save_settings(st)
                    _ui.messageBox('ライブラリを設定しました。名簿・案件候補を反映するため、もう一度スクリプトを実行してください。')
                ch.value = False
            elif ch.id == 'mesh':
                on = bool(ch.value)
                inputs.itemById('quality').isEnabled = on
                inputs.itemById('keepStep').isEnabled = on
                sp = inputs.itemById('split')
                design = adsk.fusion.Design.cast(_app.activeProduct)
                sp.isEnabled = (not on) and bool(split_units(design) if design else None)
                if on:
                    sp.value = False
            elif ch.id == 'dept' and adsk.core.DropDownCommandInput.cast(ch):
                # 部署に応じて担当者リストを入れ替える
                root = inputs.itemById('libraryRoot').value.strip()
                members = library_members(root) if root else []
                sel = ch.selectedItem
                owner = adsk.core.DropDownCommandInput.cast(inputs.itemById('owner'))
                if owner:
                    fill_owners(owner, members, (sel.name if sel and sel.name != PLACEHOLDER else ''), '')
            update_preview(inputs)
        except Exception:
            _ui.messageBox('LibraryExport:\n' + traceback.format_exc())


class DestroyHandler(adsk.core.CommandEventHandler):
    """格納 / キャンセルでダイアログが閉じたらスクリプトを終える。
    run() で autoTerminate(False) にしている (ダイアログが生きている間はハンドラを動かす必要がある) ので、
    ここで terminate() を呼ばないと「スクリプトとアドイン」に実行中 (■) のまま残る"""
    def notify(self, args):
        try:
            adsk.terminate()
        except Exception:
            pass


class ExecuteHandler(adsk.core.CommandEventHandler):
    def notify(self, args):
        try:
            inputs = args.command.commandInputs
            p = get_params(inputs)
            if not p['root'] or not os.path.isdir(p['root']):
                _ui.messageBox('ライブラリのフォルダを設定してください。'); return
            if not p['codeRaw'] or not p['devRaw'] or not p['deptRaw'] or not p['ownerRaw']:
                _ui.messageBox('案件コード・装置名・部署・担当者は必須です。'); return
            design = adsk.fusion.Design.cast(_app.activeProduct)
            if not design:
                _ui.messageBox('デザインを開いた状態で実行してください。'); return

            # library.json が無ければ、選んだ階層でライブラリを初期化 (以後この階層で固定)
            if library_layout(p['root']) is None:
                with open(os.path.join(p['root'], 'library.json'), 'w', encoding='utf-8') as f:
                    json.dump({'schema': 'library-viewer/library/1', 'layout': LAYOUT_LABEL, 'naming': NAMING_DEFAULT, 'inboxAuto': False, 'createdAt': now_iso(),
                               'note': 'このファイルはライブラリの保存階層とネーミングルールを記録します。編集はビューアの「ネーミングルール」から。'}, f, ensure_ascii=False, indent=2)
            segs = layout_segments(p)
            target = os.path.join(p['root'], *segs)
            write_step = (not p['mesh']) or p['keepStep']
            os.makedirs(os.path.join(target, 'step') if write_step else target, exist_ok=True)

            doc = _app.activeDocument
            # STEP のファイル名はネーミングルールに従わせる (ビューアに直接ドロップしても案件情報が復元できる)
            base = naming_format({'projectCode': p['codeRaw'], 'deviceName': p['devRaw'], 'workpiece': p['workRaw'],
                                  'customer': p['customerRaw'], 'department': p['deptRaw'], 'owner': p['ownerRaw']}, naming_rule(p['root']))
            em = design.exportManager
            units = split_units(design) if (p['split'] and not p['mesh']) else None
            exported = []            # [(ファイル名, STEP のパス or None, 位置 or None, ルート名)]
            mesh_stat = None
            mesh_tree = None         # メッシュ格納で実際に書いた glb の階層 (index.json 用)
            if p['mesh']:
                # メッシュで格納: glb.gz を直接書く。STEP は「一緒に書き出す」のときだけ
                total = count_visible_bodies(design.rootComponent)
                pd = _ui.createProgressDialog()
                pd.isCancelButtonShown = True
                pd.show('ライブラリに格納', 'メッシュを取得中  %v / %m ボディ', 0, max(total, 1), 0)
                try:
                    model, mesh_stat = collect_meshes(design, p['quality'], pd)
                    pd.message = 'glb を書き込み中…'
                    adsk.doEvents()
                    if not model['meshes']:
                        pd.hide()
                        _ui.messageBox('表示されているボディがありません（非表示 %d / 失敗 %d）。' % (mesh_stat['hidden'], mesh_stat['failed'])); return
                    gz, raw_size = glbwrite.write_gz(model)
                    mesh_tree = flatten_tree(model['root'])
                    del model
                    with open(os.path.join(target, base + '.glb.gz'), 'wb') as f:
                        f.write(gz)
                except Cancelled:
                    pd.hide()
                    _ui.messageBox('格納を中止しました。'); return
                finally:
                    pd.hide()
                mesh_stat['glbSize'] = len(gz); mesh_stat['rawGlbSize'] = raw_size
                sp = None
                if p['keepStep']:
                    sp = os.path.join(target, 'step', base + '.step')
                    if not em.execute(em.createSTEPExportOptions(sp, design.rootComponent)):
                        _ui.messageBox('STEP の書き出しに失敗しました（glb は格納済み）。'); sp = None
                exported.append((base, sp, None, design.rootComponent.name))
            elif units:
                used = set()
                for occ in units:
                    fname = base + '_' + unit_suffix(occ, used)
                    sp = os.path.join(target, 'step', fname + '.step')
                    # Occurrence ではなく Component を渡す (自分の原点に置かれた形で出る)
                    if not em.execute(em.createSTEPExportOptions(sp, occ.component)):
                        _ui.messageBox('STEP の書き出しに失敗しました:\n' + occ.name); return
                    exported.append((fname, sp, placement_of(occ), occ.component.name))
            else:
                sp = os.path.join(target, 'step', base + '.step')
                if not em.execute(em.createSTEPExportOptions(sp, design.rootComponent)):
                    _ui.messageBox('STEP の書き出しに失敗しました。'); return
                exported.append((base, sp, None, design.rootComponent.name))

            # Fusion 側の出所情報 (ビューアの「Fusion で開く」リンクになる)
            source = {'cad': 'fusion', 'app': 'fusion-library-export', 'document': doc.name, 'exportedBy': '', 'fusionVersion': _app.version}
            try:
                source['exportedBy'] = _app.currentUser.displayName
            except Exception:
                pass
            try:
                df = doc.dataFile
                source['version'] = df.versionNumber
                source['dataFileId'] = df.id
                source['fusionWebURL'] = df.fusionWebURL
                source['project'] = df.parentProject.name
            except Exception:
                pass

            tree = mesh_tree if mesh_tree is not None else component_tree(design.rootComponent)
            files_meta = []
            for fname, sp, placement, root_name in exported:
                # glb の名前は .glb.gz (09-store.js と揃える)。STEP 格納ではビューアが初回に作る「予告」、
                # メッシュ格納では実物 (glbSize / triangles が入る)
                fm = {'name': fname, 'step': ('step/' + fname + '.step') if sp else None, 'glb': fname + '.glb.gz',
                      'stepSize': os.path.getsize(sp) if sp else None,
                      'glbSize': mesh_stat['glbSize'] if mesh_stat else None,
                      'rawGlbSize': mesh_stat['rawGlbSize'] if mesh_stat else None,
                      'triangles': mesh_stat['triangles'] if mesh_stat else None,
                      'solids': mesh_stat['bodies'] if mesh_stat else ((tree[0]['solids'] if tree else None) if placement is None else None),
                      'uniqueMeshes': mesh_stat['unique'] if mesh_stat else None,
                      'rootName': root_name}
                if placement is not None:
                    fm['placement'] = placement      # ビューアが組立位置を戻すのに使う
                files_meta.append(fm)
            meta = {
                'schema': 'library-viewer/1', 'projectCode': p['codeRaw'], 'deviceName': p['devRaw'], 'workpiece': p['workRaw'],
                'customer': p['customerRaw'], 'department': p['deptRaw'], 'owner': p['ownerRaw'], 'savedAt': now_iso(),
                # メッシュ格納: Fusion 側で決めた細かさ。STEP 格納: ビューアが初回に開いたときに決める (None)
                'precision': {'preset': p['quality'], 'by': 'fusion-mesh'} if p['mesh'] else None,
                'split': bool(units),
                'files': files_meta,
                'source': source,
            }
            with open(os.path.join(target, 'meta.json'), 'w', encoding='utf-8') as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
            with open(os.path.join(target, 'index.json'), 'w', encoding='utf-8') as f:
                json.dump({'schema': 'library-viewer/index/1',
                           'devices': [{'file': fm['name'], 'rootName': fm['rootName'],
                                        'tree': tree if not units else []} for fm in files_meta]}, f, ensure_ascii=False, indent=2)

            # 名簿にない人はその場で追加 (管理者レス)
            members = library_members(p['root'])
            if (p['deptRaw'], p['ownerRaw']) not in members:
                members.append((p['deptRaw'], p['ownerRaw']))
                with open(os.path.join(p['root'], 'members.json'), 'w', encoding='utf-8') as f:
                    json.dump({'schema': 'library-viewer/members/1', 'updatedAt': now_iso(),
                               'members': [{'department': d, 'name': n} for d, n in members]}, f, ensure_ascii=False, indent=2)

            st = load_settings()
            for k in ('lastProjectCode', 'lastWorkpiece', 'lastCustomer', 'lastDept', 'lastOwner', 'lastQuality'):
                st.pop(k, None)                    # 案件情報は毎回空から (前回の値を残さない)
            st.update({'libraryRoot': p['root'], 'lastSplit': bool(p['split']), 'lastMesh': bool(p['mesh']), 'lastKeepStep': bool(p['keepStep'])})
            save_settings(st)
            if mesh_stat:
                detail = ('\n\nメッシュで格納: ボディ %d 件 (種類 %d) / 三角形 %s / glb.gz %.1f MB' % (
                    mesh_stat['bodies'], mesh_stat['unique'], format(mesh_stat['triangles'], ','), mesh_stat['glbSize'] / 1048576.0) +
                    ('  ※ 行列の検査に落ちた配置 %d 件は焼き込み' % mesh_stat['fallback'] if mesh_stat['fallback'] else '') +
                    ('  (非表示 %d 件は含めていません)' % mesh_stat['hidden'] if mesh_stat['hidden'] else '') +
                    ('  ※ %d 件はメッシュにできませんでした' % mesh_stat['failed'] if mesh_stat['failed'] else '') +
                    '\n色: %d / %d 種類 (色の種類 %d)' % (mesh_stat['colored'], mesh_stat['unique'], len(mesh_stat['colors'])) +
                    '\n三角形の内訳: 30mm 未満の小物 %d%% / 多い順: %s' % (
                        int(100.0 * mesh_stat['small_tris'] / max(mesh_stat['triangles'], 1)),
                        ', '.join('%s %s' % (n, format(t, ',')) for t, n in mesh_stat['top'][:5])) +
                    ('\n色が取れなかった外観:\n  ' + '\n  '.join(_uncolored_samples) if _uncolored_samples else ''))
            else:
                detail = ('\n\nユニット %d 件に分けて書き出しました（ライブラリ上は 1 件です）。' % len(exported) if units else '')
            _ui.messageBox('格納しました:\n' + target + detail)
        except Exception:
            _ui.messageBox('LibraryExport:\n' + traceback.format_exc())


def run(context):
    global _app, _ui
    try:
        _app = adsk.core.Application.get()
        _ui = _app.userInterface
        cmd_def = _ui.commandDefinitions.itemById(CMD_ID)
        if cmd_def:
            cmd_def.deleteMe()
        cmd_def = _ui.commandDefinitions.addButtonDefinition(CMD_ID, 'Library に格納', 'STEP と案件情報を Library Viewer の共有フォルダに格納します')
        on_created = CommandCreatedHandler()
        cmd_def.commandCreated.add(on_created)
        _handlers.append(on_created)
        cmd_def.execute()
        adsk.autoTerminate(False)   # ダイアログが閉じるまでスクリプトを生かす
    except Exception:
        if _ui:
            _ui.messageBox('LibraryExport:\n' + traceback.format_exc())


def stop(context):
    try:
        cmd_def = _ui.commandDefinitions.itemById(CMD_ID)
        if cmd_def:
            cmd_def.deleteMe()
    except Exception:
        pass
