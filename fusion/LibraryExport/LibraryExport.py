# -*- coding: utf-8 -*-
"""Library Export — Fusion 360 スクリプト

開いている設計を STEP で書き出し、Library Viewer の共有フォルダ (ライブラリ) に
案件情報付きで格納します。ビューア側の「格納する」と同じフォルダ構造・同じ meta.json を
作るので、格納した直後から誰でも Library Viewer で開けます。

  設計者の操作: [ユーティリティ] → [スクリプトとアドイン] → LibraryExport → 実行
                → 案件コード / 装置名 / 対象ワーク / 部署 / 担当者 を入れて OK

  管理者の作業: なし。フォルダに置いたものがそのまま一覧になります。
                glb (表示用) は Library Viewer が初回に開いたときに自動生成して書き戻します。

依存: Fusion 360 標準の Python のみ (外部ライブラリ不要)。
設定 (ライブラリのパス) は ~/.library-viewer/fusion.json に保存されます。
"""
import adsk.core, adsk.fusion, traceback
import os, json, re, datetime

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
            info = '共有フォルダ (Library Viewer のライブラリ) に STEP と案件情報を格納します。'
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

            inputs.addTextBoxCommandInput('preview', '保存先  (' + LAYOUT_LABEL + ')', '', 2, True)

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
    }


def update_preview(inputs):
    p = get_params(inputs)
    segs = layout_segments(p)
    inputs.itemById('preview').text = (p['root'] or '（ライブラリ未設定）') + '\n' + '/'.join(segs) + '/'


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
            os.makedirs(os.path.join(target, 'step'), exist_ok=True)

            doc = _app.activeDocument
            # STEP のファイル名はネーミングルールに従わせる (ビューアに直接ドロップしても案件情報が復元できる)
            base = naming_format({'projectCode': p['codeRaw'], 'deviceName': p['devRaw'], 'workpiece': p['workRaw'],
                                  'customer': p['customerRaw'], 'department': p['deptRaw'], 'owner': p['ownerRaw']}, naming_rule(p['root']))
            step_path = os.path.join(target, 'step', base + '.step')
            em = design.exportManager
            opts = em.createSTEPExportOptions(step_path, design.rootComponent)
            if not em.execute(opts):
                _ui.messageBox('STEP の書き出しに失敗しました。'); return

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
            meta = {
                'schema': 'library-viewer/1', 'projectCode': p['codeRaw'], 'deviceName': p['devRaw'], 'workpiece': p['workRaw'],
                'customer': p['customerRaw'], 'department': p['deptRaw'], 'owner': p['ownerRaw'], 'savedAt': now_iso(),
                'precision': None,   # glb はビューアが初回に開いたときに生成する
                'files': [{'name': base, 'step': 'step/' + base + '.step', 'glb': base + '.glb', 'stepSize': os.path.getsize(step_path), 'glbSize': None,
                           'triangles': None, 'solids': tree[0]['solids'] if tree else None, 'rootName': design.rootComponent.name}],
                'source': source,
            }
            with open(os.path.join(target, 'meta.json'), 'w', encoding='utf-8') as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
            with open(os.path.join(target, 'index.json'), 'w', encoding='utf-8') as f:
                json.dump({'schema': 'library-viewer/index/1', 'devices': [{'file': base, 'rootName': design.rootComponent.name, 'tree': tree}]}, f, ensure_ascii=False, indent=2)

            # 名簿にない人はその場で追加 (管理者レス)
            members = library_members(p['root'])
            if (p['deptRaw'], p['ownerRaw']) not in members:
                members.append((p['deptRaw'], p['ownerRaw']))
                with open(os.path.join(p['root'], 'members.json'), 'w', encoding='utf-8') as f:
                    json.dump({'schema': 'library-viewer/members/1', 'updatedAt': now_iso(),
                               'members': [{'department': d, 'name': n} for d, n in members]}, f, ensure_ascii=False, indent=2)

            st = load_settings()
            st.update({'libraryRoot': p['root'], 'lastProjectCode': p['codeRaw'], 'lastWorkpiece': p['workRaw'],
                       'lastCustomer': p['customerRaw'], 'lastDept': p['deptRaw'], 'lastOwner': p['ownerRaw']})
            save_settings(st)
            _ui.messageBox('格納しました:\n' + target + '\n\nLibrary Viewer の「ライブラリ」タブに表示されます（初回に開いたとき glb が生成されます）。')
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
