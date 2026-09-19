#!/usr/bin/env python3
"""Library Viewer ビルド。

テンプレート HTML に three.js / occt-import-js / gzip+base64 した WASM /
アプリの CSS・JS を文字列置換で差し込み、dist/library-viewer.html を作る。
バンドラは使わない。

  python3 build.py
"""
import base64, gzip, os, sys, glob, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
NM = os.path.join(ROOT, 'node_modules')
OUT = os.path.join(ROOT, 'dist', 'library-viewer.html')


def read(p, mode='r'):
    with open(p, mode, encoding=None if 'b' in mode else 'utf-8') as f:
        return f.read()


def main():
    template = read(os.path.join(ROOT, 'src', 'template.html'))
    three = read(os.path.join(NM, 'three', 'build', 'three.min.js'))
    occt_js = read(os.path.join(NM, 'occt-import-js', 'dist', 'occt-import-js.js'))
    wasm = read(os.path.join(NM, 'occt-import-js', 'dist', 'occt-import-js.wasm'), 'rb')
    wasm_b64 = base64.b64encode(gzip.compress(wasm, compresslevel=9)).decode('ascii')

    css = read(os.path.join(ROOT, 'src', 'app.css'))
    js_files = sorted(glob.glob(os.path.join(ROOT, 'src', 'js', '*.js')))
    app_js = '\n'.join(f'// ---- {os.path.basename(p)} ----\n' + read(p) for p in js_files)

    version = datetime.datetime.now().strftime('%Y.%m.%d')
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
