#!/usr/bin/env python3
"""Library Viewer ビルド。

テンプレート HTML に three.js / occt-import-js / gzip+base64 した WASM /
アプリの CSS・JS を文字列置換で差し込み、dist/library-viewer.html を作る。
バンドラは使わない。

  python3 build.py
"""
import base64, gzip, os, sys, glob, subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
NM = os.path.join(ROOT, 'node_modules')
OUT = os.path.join(ROOT, 'dist', 'library-viewer.html')


def read(p, mode='r'):
    with open(p, mode, encoding=None if 'b' in mode else 'utf-8') as f:
        return f.read()


def build_version():
    """版は小数点なしの通し番号。git のコミット数を使う。

    git が無い環境 (ソースだけコピーした PC など) のために VERSION に控えを残し、
    そちらを読む。ビューアのヘッダーに v12 のように出る。
    """
    path = os.path.join(ROOT, 'VERSION')
    n = None
    try:
        r = subprocess.run(['git', 'rev-list', '--count', 'HEAD'], cwd=ROOT,
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            n = int(r.stdout.strip())
    except Exception:
        pass
    if n is None:
        try:
            n = int(read(path).strip())
        except Exception:
            n = 0
    else:
        try:
            if not os.path.exists(path) or read(path).strip() != str(n):
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(str(n) + '\n')
        except Exception:
            pass
    return str(n)


def main():
    template = read(os.path.join(ROOT, 'src', 'template.html'))
    three = read(os.path.join(NM, 'three', 'build', 'three.min.js'))
    occt_js = read(os.path.join(NM, 'occt-import-js', 'dist', 'occt-import-js.js'))
    wasm = read(os.path.join(NM, 'occt-import-js', 'dist', 'occt-import-js.wasm'), 'rb')
    wasm_b64 = base64.b64encode(gzip.compress(wasm, compresslevel=9)).decode('ascii')

    css = read(os.path.join(ROOT, 'src', 'app.css'))
    js_files = sorted(glob.glob(os.path.join(ROOT, 'src', 'js', '*.js')))
    app_js = '\n'.join(f'// ---- {os.path.basename(p)} ----\n' + read(p) for p in js_files)

    version = build_version()
    for name, body in (('three', three), ('occt', occt_js), ('app', app_js)):
        if '</script' in body.lower():
            sys.exit(f'ERROR: "</script" found in {name} — HTML would break')

    html = template
    for key, val in (
        ('{{VERSION}}', version),
        ('{{APP_CSS}}', css),
        ('{{THREE_JS}}', three),
        ('{{OCCT_JS}}', occt_js),
        ('{{WASM_GZ_B64}}', wasm_b64),
        ('{{APP_JS}}', app_js),
    ):
        if key not in html:
            sys.exit(f'ERROR: placeholder {key} missing in template')
        html = html.replace(key, val)   # str.replace はエスケープ解釈しない (re.sub は使わない)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(html)
    size = os.path.getsize(OUT)
    print(f'built {os.path.relpath(OUT, ROOT)}  {size/1024/1024:.2f} MB  (wasm gz+b64 {len(wasm_b64)/1024/1024:.2f} MB, three {len(three)/1024:.0f} KB, occt js {len(occt_js)/1024:.0f} KB, app {len(app_js)/1024:.0f} KB)')
    if size > 5 * 1024 * 1024:
        print('WARNING: over 5 MB target')


if __name__ == '__main__':
    main()
