// ネーミングルール: ビューア (03b-naming.js) と Fusion スクリプト (LibraryExport.py) の parse / format が
// 同じ答えを返すか。取引先を末尾に足した既定で、取引先の無い古い名前も読めるか。
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
global.Storage = { get: () => null, set: () => {} };
global.sanitizeSegment = (s) => String(s || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+$/, '_');   // 00-util.js と同じ
const Naming = require('../src/js/03b-naming.js');
function check(c, m) { if (!c) throw new Error('FAIL: ' + m); console.log('  ok  ' + m); }

const R = Naming.DEFAULT;
check(R.pattern.endsWith('_{customer}'), 'the default pattern ends with {customer}: ' + R.pattern);
const cases = [
  'P2026-001_検査装置A_ワークX_設計1課_山田_〇〇工業.step',   // 取引先あり
  'P2026-001_検査装置A_ワークX_設計1課_山田_.step',           // 取引先は空 (区切りを続けて書く)
  'P2026-001_検査装置A_ワークX_設計1課_山田.step',            // 取引先の無い古い名前
  'P2026-001_組立_ライン_E__設計2課_鈴木 v2.stp',            // 装置名に区切り + ワーク空 + 取引先なし + Fusion の v2
  'P2026-001_検査装置A_ワークX_設計1課.step',                 // 担当者が無い → 読めない
  'P2026-002_搬送_装置B_ワークY_設計2課_鈴木_△△製作所.step',  // 装置名に区切り + 取引先あり
];
const js = cases.map(n => Naming.parse(n, R));
check(js[0].customer === '〇〇工業' && js[0].owner === '山田', 'customer parsed when present');
check(js[1].customer === '' && js[1].owner === '山田', 'trailing separator = empty customer');
check(js[2] && js[2].customer === '' && js[2].owner === '山田' && js[2].department === '設計1課', 'a legacy name without customer still parses (trailing optional field absent)');
check(js[3] && js[3].deviceName === '組立_ライン_E' && js[3].workpiece === '' && js[3].owner === '鈴木', 'greedy device name + empty workpiece + absent customer: ' + JSON.stringify(js[3]));
check(js[4] === null, 'a name missing a required field is rejected');
check(js[5].deviceName === '搬送_装置B' && js[5].customer === '△△製作所', 'greedy device name with customer present');
const fmt = Naming.format({ projectCode: 'P1', deviceName: '装置', workpiece: '', department: '設計', owner: '山田', customer: '' }, R);
check(fmt === 'P1_装置__設計_山田_', 'format writes every field (trailing separator for an empty customer): ' + fmt);
check(Naming.parse(fmt + '.step', R).deviceName === '装置', 'format → parse round-trips');

// Fusion スクリプト側 (adsk 無しで naming_* だけ取り出して同じ入力を流す)
const py = `
import re, json, sys
src = open('fusion/LibraryExport/LibraryExport.py', encoding='utf-8').read()
ns = {'re': re, 'os': None, 'json': json}
exec(src[src.index('NAMING_FIELDS ='):src.index('# ---- ユニットごとの分割書き出し')], ns)
cases = json.loads(sys.argv[1])
R = ns['NAMING_DEFAULT']
out = [ns['naming_parse'](c, R) for c in cases]
out.append(ns['naming_format']({'projectCode': 'P1', 'deviceName': '装置', 'workpiece': '', 'department': '設計', 'owner': '山田', 'customer': ''}, R))
print(json.dumps(out, ensure_ascii=False))
`;
const pyOut = JSON.parse(execFileSync('python3', ['-c', py, JSON.stringify(cases)]).toString());
cases.forEach((c, i) => {
  check(JSON.stringify(pyOut[i]) === JSON.stringify(js[i]), 'Fusion script agrees: ' + c + ' → ' + JSON.stringify(pyOut[i]));
});
check(pyOut[cases.length] === fmt, 'Fusion script formats the same: ' + pyOut[cases.length]);
console.log('NAMING TEST PASSED');
