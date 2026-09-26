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
_DIR = os.path.dirname(os.path.abspath(__file__))
if _DIR not in sys.path:
    sys.path.insert(0, _DIR)
import glbwrite

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
NAMING_DEFAULT = {'pattern': '{projectCode}_{deviceName}_{workpiece}_{department}_{owner}', 'separator': '_'}
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
    """ファイル名 / ドキュメント名 → dict | None。装置名だけ区切り文字を含んでよい。"""
    fields = naming_fields(rule)
    if not fields:
        return None
    sep = rule.get('separator', '_')
    base = re.sub(r'\.(step|stp)$', '', name, flags=re.I)
    base = re.sub(r'\s+v\d+$', '', base).strip()
    if sep == '_':
        base = base.replace('＿', '_')
    parts = [p.strip() for p in base.split(sep)]
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


def catalog_codes(root):
    cat = read_json(os.path.join(root, 'catalog.json')) or {}
    codes, works, customers = [], [], []
    for e in cat.get('entries', []):
        if e.get('projectCode') and e['projectCode'] not in codes:
            codes.append(e['projectCode'])
        if e.get('workpiece') and e['workpiece'] not in works:
            works.append(e['workpiece'])
        if e.get('customer') and e['customer'] not in customers:
            customers.append(e['customer'])
    return codes, works, customers


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
MESH_QUALITY = [   # (id, 表示名, TriangleMeshQualityOptions の名前)。ビューアの精度 3 段と同じ並び
    ('coarse', '粗い', 'LowQualityTriangleMesh'),
    ('normal', '標準', 'NormalQualityTriangleMesh'),
    ('fine', '細かい', 'HighQualityTriangleMesh'),
]


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


def _color_prop_value(prop):
    try:
        if prop is None or prop.objectType != adsk.core.ColorProperty.classType():
            return None
        c = prop.value
        if c is None:
            return None
        return [srgb_to_linear(c.red), srgb_to_linear(c.green), srgb_to_linear(c.blue)]
    except Exception:
        return None


def appearance_color(app):
    if app is None:
        return None
    key = None
    try:
        key = app.id
        if key in _color_cache:
            return _color_cache[key]
    except Exception:
        pass
    color = None
    try:
        props = app.appearanceProperties
        for pid in COLOR_PROP_IDS:
            color = _color_prop_value(props.itemById(pid))
            if color:
                break
        if color is None:
            for i in range(props.count):
                color = _color_prop_value(props.item(i))
                if color:
                    break
        if color is None and len(_uncolored_samples) < 6:
            ids = []
            for i in range(props.count):
                try:
                    ids.append(props.item(i).id)
                except Exception:
                    pass
            _uncolored_samples.append('%s: [%s]' % (app.name, ', '.join(ids[:12])))
    except Exception:
        color = None
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


def tessellate(body, quality_id, occ=None):
    calc = body.meshManager.createMeshCalculator()
    opt_name = next(q[2] for q in MESH_QUALITY if q[0] == quality_id)
    calc.setQuality(getattr(adsk.fusion.TriangleMeshQualityOptions, opt_name))
    mesh = calc.calculate()
    if mesh is None:
        return None
    # その場で 4 バイトの array に畳む。Python の float のリストで抱えると 1 要素 32 バイトで、
    # 実測 2053 ボディ / 122 万三角形のアセンブリでは 400MB を超える (array なら 1/8)
    m = {'name': body.name,
         'positions': array('f', (v * CM_TO_MM for v in mesh.nodeCoordinatesAsFloat)),   # cm → mm
         'normals': array('f', mesh.normalVectorsAsFloat),
         'indices': array('I', mesh.nodeIndices),
         'color': body_color(body, occ)}
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


def collect_meshes(design, quality_id, progress=None):
    """デザイン全体を glbwrite の model 形式に。ツリーは Fusion のオカレンス階層そのまま。
    progress: adsk.core.ProgressDialog (省略可)。キャンセルされたら Cancelled を投げる。
    戻り: (model, {'bodies', 'hidden', 'failed', 'triangles'})
    実測 (2053 ボディ / 122 万三角形 / 標準): 60 秒"""
    root = design.rootComponent
    meshes = []
    stat = {'bodies': 0, 'hidden': 0, 'failed': 0, 'triangles': 0, 'seen': 0, 'colored': 0}
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

    def add_bodies(bodies, node, occ=None):
        for body in bodies:
            if not body.isVisible:
                stat['hidden'] += 1; continue
            m = tessellate(body, quality_id, occ)
            tick()
            if m is None:
                stat['failed'] += 1; continue
            meshes.append(m)
            stat['bodies'] += 1
            if m['color']:
                stat['colored'] += 1
            stat['triangles'] += len(m['indices']) // 3
            node['children'].append({'name': body.name, 'meshIndex': len(meshes) - 1, 'children': []})

    def walk(occs, node):
        for occ in occs:
            if not occ.isVisible:
                continue
            sub = {'name': occ.name, 'meshIndex': None, 'children': []}
            add_bodies(occ.bRepBodies, sub, occ)     # 組立位置つきのプロキシ
            walk(occ.childOccurrences, sub)
            if sub['children']:
                node['children'].append(sub)

    tree = {'name': root.name, 'meshIndex': None, 'children': []}
    add_bodies(root.bRepBodies, tree)
    walk(root.occurrences, tree)
    return {'name': root.name, 'root': tree, 'meshes': meshes}, stat


class CommandCreatedHandler(adsk.core.CommandCreatedEventHandler):
    def notify(self, args):
        try:
            cmd = args.command
            cmd.isRepeatable = False
            cmd.okButtonText = '格納する'
            inputs = cmd.commandInputs
            st = load_settings()
            root = st.get('libraryRoot', '')
            design = adsk.fusion.Design.cast(_app.activeProduct)
            doc_name = re.sub(r'\s+v\d+$', '', _app.activeDocument.name)

            rule = naming_rule(root)
            parsed = naming_parse(doc_name, rule) or {}
            info = '共有フォルダ (Library Viewer のライブラリ) に 3D データと案件情報を格納します。'
            if parsed:
                info += '\nドキュメント名がネーミングルールに一致したので案件情報を自動入力しました。'
            inputs.addTextBoxCommandInput('info', '', info, 3, True)
            inputs.addStringValueInput('libraryRoot', 'ライブラリのフォルダ', root)
            inputs.addBoolValueInput('browse', 'フォルダを選ぶ…', False, '', False)

            inputs.addStringValueInput('projectCode', '案件コード *', parsed.get('projectCode') or st.get('lastProjectCode', ''))
            codes, works, customers = catalog_codes(root) if root else ([], [], [])
            dd = inputs.addDropDownCommandInput('codePick', '既存の案件から', adsk.core.DropDownStyles.TextListDropDownStyle)
            dd.listItems.add('（選択）', True)
            for c in codes[:50]:
                dd.listItems.add(c, False)
            inputs.addStringValueInput('deviceName', '装置名 *', parsed.get('deviceName') or (design.rootComponent.name if design else doc_name))
            inputs.addStringValueInput('workpiece', '対象ワーク', parsed.get('workpiece') if parsed else st.get('lastWorkpiece', ''))
            inputs.addStringValueInput('customer', '取引先', (parsed.get('customer') if parsed else None) or st.get('lastCustomer', ''))

            members = library_members(root) if root else []
            depts = []
            for d, _ in members:
                if d not in depts:
                    depts.append(d)
            dd2 = inputs.addDropDownCommandInput('dept', '部署 *', adsk.core.DropDownStyles.TextListDropDownStyle)
            last_dept = parsed.get('department') or st.get('lastDept', '')
            for d in depts:
                dd2.listItems.add(d, d == last_dept)
            dd2.listItems.add('（名簿にない部署を入力）', not depts or last_dept not in depts)
            inputs.addStringValueInput('deptText', '部署 (手入力)', last_dept if last_dept not in depts else '')
            dd3 = inputs.addDropDownCommandInput('owner', '担当者 *', adsk.core.DropDownStyles.TextListDropDownStyle)
            last_owner = parsed.get('owner') or st.get('lastOwner', '')
            for d, n in members:
                if d == (last_dept or (depts[0] if depts else '')):
                    dd3.listItems.add(n, n == last_owner)
            dd3.listItems.add('（名簿にない担当者を入力）', dd3.listItems.count == 0 or last_owner not in [n for _, n in members])
            inputs.addStringValueInput('ownerText', '担当者 (手入力)', last_owner if last_owner not in [n for _, n in members] else '')

            mesh_on = bool(st.get('lastMesh', True))
            chk_mesh = inputs.addBoolValueInput('mesh', 'メッシュで格納（推奨）', True, '', mesh_on)
            chk_mesh.tooltip = ('Fusion のメッシュをそのまま glb.gz に書きます。ビューア側の STEP 変換を通らないので、\n'
                                'どんな大きさでも開くのは一瞬です。共有フォルダに置くのも glb.gz だけ (STEP の 1/23)。')
            ddq = inputs.addDropDownCommandInput('quality', 'メッシュの細かさ', adsk.core.DropDownStyles.TextListDropDownStyle)
            last_q = st.get('lastQuality', 'normal')
            for qid, label, _ in MESH_QUALITY:
                ddq.listItems.add(label, qid == last_q)
            ddq.isEnabled = mesh_on
            chk_keep = inputs.addBoolValueInput('keepStep', 'STEP も一緒に書き出す', True, '', bool(st.get('lastKeepStep', False)))
            chk_keep.tooltip = 'メッシュで格納するときに STEP も step/ に置きます (後で細かさを変えて再変換したいとき)。容量は 23 倍になります。'
            chk_keep.isEnabled = mesh_on
            units = split_units(design) if design else None
            chk = inputs.addBoolValueInput('split', 'ユニットごとに分けて書き出す', True, '', bool(st.get('lastSplit', False)) and bool(units) and not mesh_on)
            chk.isEnabled = bool(units) and not mesh_on
            chk.tooltip = ('STEP で格納するとき、大きいアセンブリはこちら。ルート直下のユニットごとに STEP を分け、組立位置は meta.json に残します。\n'
                           'ライブラリ上は 1 件のままで、ビューアで開くと全ユニットがまとめて読み込まれます。\n'
                           '(メッシュで格納するときは分割の必要がありません)'
                           if units else 'ルート直下にボディがある / ユニットが 1 つなので分割できません')
            inputs.addTextBoxCommandInput('preview', '保存先  (' + LAYOUT_LABEL + ')', '', 3, True)

            on_change = InputChangedHandler(); cmd.inputChanged.add(on_change); _handlers.append(on_change)
            on_exec = ExecuteHandler(); cmd.execute.add(on_exec); _handlers.append(on_exec)
            update_preview(inputs)
        except Exception:
            _ui.messageBox('LibraryExport:\n' + traceback.format_exc())


def get_params(inputs):
    dept_sel = inputs.itemById('dept').selectedItem
    dept = dept_sel.name if dept_sel and not dept_sel.name.startswith('（') else inputs.itemById('deptText').value
    own_sel = inputs.itemById('owner').selectedItem
    owner = own_sel.name if own_sel and not own_sel.name.startswith('（') else inputs.itemById('ownerText').value
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
    for qid, label, _ in MESH_QUALITY:
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
    inputs.itemById('preview').text = (p['root'] or '（ライブラリ未設定）') + '\n' + '/'.join(segs) + '/\n' + note


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
            elif ch.id == 'codePick':
                sel = ch.selectedItem
                if sel and not sel.name.startswith('（'):
                    inputs.itemById('projectCode').value = sel.name
            elif ch.id == 'dept':
                # 部署に応じて担当者リストを入れ替える
                root = inputs.itemById('libraryRoot').value.strip()
                members = library_members(root) if root else []
                owner = inputs.itemById('owner')
                owner.listItems.clear()
                sel = ch.selectedItem
                for d, n in members:
                    if sel and d == sel.name:
                        owner.listItems.add(n, False)
                owner.listItems.add('（名簿にない担当者を入力）', owner.listItems.count == 0)
                if owner.listItems.count > 1:
                    owner.listItems.item(0).isSelected = True
            update_preview(inputs)
        except Exception:
            _ui.messageBox('LibraryExport:\n' + traceback.format_exc())


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

            tree = component_tree(design.rootComponent)
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
            st.update({'libraryRoot': p['root'], 'lastProjectCode': p['codeRaw'], 'lastWorkpiece': p['workRaw'],
                       'lastCustomer': p['customerRaw'], 'lastDept': p['deptRaw'], 'lastOwner': p['ownerRaw'],
                       'lastSplit': bool(p['split']), 'lastMesh': bool(p['mesh']), 'lastKeepStep': bool(p['keepStep']),
                       'lastQuality': p['quality']})
            save_settings(st)
            if mesh_stat:
                detail = ('\n\nメッシュで格納: ボディ %d 件 / 三角形 %s / glb.gz %.1f MB' % (
                    mesh_stat['bodies'], format(mesh_stat['triangles'], ','), mesh_stat['glbSize'] / 1048576.0) +
                    ('  (非表示 %d 件は含めていません)' % mesh_stat['hidden'] if mesh_stat['hidden'] else '') +
                    ('  ※ %d 件はメッシュにできませんでした' % mesh_stat['failed'] if mesh_stat['failed'] else '') +
                    '\n色: %d / %d 件' % (mesh_stat['colored'], mesh_stat['bodies']) +
                    ('\n色が取れなかった外観:\n  ' + '\n  '.join(_uncolored_samples) if _uncolored_samples else '') +
                    '\n\nLibrary Viewer の「ライブラリ」タブに表示され、そのまま開けます。')
            else:
                detail = (('\n\nユニット %d 件に分けて書き出しました（ライブラリ上は 1 件です）。' % len(exported) if units else '') +
                          '\n\nLibrary Viewer の「ライブラリ」タブに表示されます（初回に開いたとき glb が生成されます）。')
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
