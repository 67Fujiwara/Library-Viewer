#!/usr/bin/env python3
"""AP214 STEP テストデータ生成。

手元に STEP がない環境で occt-import-js の動作確認をするための
最小限の B-rep 生成器。外部ライブラリ不要。

  python3 tools/gen_test_step.py <出力ディレクトリ>
      box.step / assembly.step / assembly_b.step を作る (テスト用)

  python3 tools/gen_test_step.py --assembly <出力パス> <ルート名> [倍率]
      指定した名前・寸法のアセンブリ STEP を 1 つ作る (サンプルライブラリ生成用)
"""
import sys, os, datetime


class Writer:
    def __init__(self):
        self.lines = []
        self.n = 0

    def add(self, text):
        self.n += 1
        self.lines.append(f"#{self.n}={text};")
        return self.n

    def dump(self, filename):
        ts = datetime.datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        head = [
            "ISO-10303-21;",
            "HEADER;",
            "FILE_DESCRIPTION(('Library Viewer test data'),'2;1');",
            f"FILE_NAME('{filename}','{ts}',('Library Viewer'),(''),'','','');",
            "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
            "ENDSEC;",
            "DATA;",
        ]
        return "\n".join(head + self.lines + ["ENDSEC;", "END-ISO-10303-21;", ""])


def fmt(v):
    return repr(float(v))


class Ctx:
    """単位系・アプリケーションコンテキストなど 1 ファイルに 1 組の共通エンティティ。"""

    def __init__(self, w):
        self.w = w
        self.app = w.add("APPLICATION_CONTEXT('automotive design')")
        w.add(f"APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#{self.app})")
        self.prod_ctx = w.add(f"PRODUCT_CONTEXT('',#{self.app},'mechanical')")
        self.pd_ctx = w.add(f"PRODUCT_DEFINITION_CONTEXT('part definition',#{self.app},'design')")
        length = w.add("( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )")
        angle = w.add("( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )")
        solid = w.add("( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )")
        unc = w.add(f"UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#{length},'distance_accuracy_value','')")
        self.geom = w.add(
            f"( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#{unc})) "
            f"GLOBAL_UNIT_ASSIGNED_CONTEXT((#{length},#{angle},#{solid})) REPRESENTATION_CONTEXT('','') )")
        self.products = []

    def product(self, name):
        w = self.w
        p = w.add(f"PRODUCT('{name}','{name}','',(#{self.prod_ctx}))")
        pdf = w.add(f"PRODUCT_DEFINITION_FORMATION('','',#{p})")
        pd = w.add(f"PRODUCT_DEFINITION('design','',#{pdf},#{self.pd_ctx})")
        self.products.append(p)
        return p, pd

    def finish(self):
        ids = ",".join(f"#{p}" for p in self.products)
        self.w.add(f"PRODUCT_RELATED_PRODUCT_CATEGORY('part','',({ids}))")


def axis(w, origin=(0, 0, 0), z=(0, 0, 1), x=(1, 0, 0)):
    o = w.add(f"CARTESIAN_POINT('',({fmt(origin[0])},{fmt(origin[1])},{fmt(origin[2])}))")
    dz = w.add(f"DIRECTION('',({fmt(z[0])},{fmt(z[1])},{fmt(z[2])}))")
    dx = w.add(f"DIRECTION('',({fmt(x[0])},{fmt(x[1])},{fmt(x[2])}))")
    return w.add(f"AXIS2_PLACEMENT_3D('',#{o},#{dz},#{dx})")


def box_solid(w, name, L, W, H, origin=(0, 0, 0)):
    """直方体の MANIFOLD_SOLID_BREP を出力し、その id を返す。"""
    ox, oy, oz = origin
    P = [
        (ox, oy, oz), (ox + L, oy, oz), (ox + L, oy + W, oz), (ox, oy + W, oz),
        (ox, oy, oz + H), (ox + L, oy, oz + H), (ox + L, oy + W, oz + H), (ox, oy + W, oz + H),
    ]
    cp = [w.add(f"CARTESIAN_POINT('',({fmt(x)},{fmt(y)},{fmt(z)}))") for x, y, z in P]
    vp = [w.add(f"VERTEX_POINT('',#{c})") for c in cp]

    edges = {}

    def edge(a, b):
        key = (min(a, b), max(a, b))
        if key not in edges:
            i, j = key
            d = [P[j][k] - P[i][k] for k in range(3)]
            ln = sum(v * v for v in d) ** 0.5
            d = [v / ln for v in d]
            dr = w.add(f"DIRECTION('',({fmt(d[0])},{fmt(d[1])},{fmt(d[2])}))")
            vec = w.add(f"VECTOR('',#{dr},1.)")
            line = w.add(f"LINE('',#{cp[i]},#{vec})")
            edges[key] = w.add(f"EDGE_CURVE('',#{vp[i]},#{vp[j]},#{line},.T.)")
        return edges[key], (a < b)

    # 各面: (頂点ループ 外から見て反時計回り, 法線, 参照方向)
    faces = [
        ([0, 3, 2, 1], (0, 0, -1), (1, 0, 0)),   # bottom
        ([4, 5, 6, 7], (0, 0, 1), (1, 0, 0)),    # top
        ([0, 1, 5, 4], (0, -1, 0), (1, 0, 0)),   # front  y=0
        ([3, 7, 6, 2], (0, 1, 0), (1, 0, 0)),    # back   y=W
        ([0, 4, 7, 3], (-1, 0, 0), (0, 1, 0)),   # left   x=0
        ([1, 2, 6, 5], (1, 0, 0), (0, 1, 0)),    # right  x=L
    ]
    face_ids = []
    for loop, nrm, ref in faces:
        oes = []
        for k in range(4):
            a, b = loop[k], loop[(k + 1) % 4]
            ec, fwd = edge(a, b)
            oes.append(w.add(f"ORIENTED_EDGE('',*,*,#{ec},{'.T.' if fwd else '.F.'})"))
        el = w.add("EDGE_LOOP('',(" + ",".join(f"#{o}" for o in oes) + "))")
        fb = w.add(f"FACE_OUTER_BOUND('',#{el},.T.)")
        ax = axis(w, P[loop[0]], nrm, ref)
        pl = w.add(f"PLANE('',#{ax})")
        face_ids.append(w.add(f"ADVANCED_FACE('',(#{fb}),#{pl},.T.)"))
    shell = w.add("CLOSED_SHELL('',(" + ",".join(f"#{f}" for f in face_ids) + "))")
    return w.add(f"MANIFOLD_SOLID_BREP('{name}',#{shell})")


def circle_geom(w, cx, cy, z, r, axis_z=(0, 0, 1)):
    """CIRCLE と、角度 0 の位置 (cx+r, cy, z) にある頂点を作る。"""
    ax = axis(w, (cx, cy, z), axis_z, (1, 0, 0))
    circ = w.add(f"CIRCLE('',#{ax},{fmt(r)})")
    cp = w.add(f"CARTESIAN_POINT('',({fmt(cx + r)},{fmt(cy)},{fmt(z)}))")
    vp = w.add(f"VERTEX_POINT('',#{cp})")
    return circ, vp


def plate_with_holes(ctx, name, L, W, H, holes, color=None):
    """直方体の板に貫通穴をあけた B-rep。holes = [(cx, cy, r), ...]

    穴の中心と半径を厳密に指定できるので、計測精度の検証に使う。
    """
    w = ctx.w
    P = [(0, 0, 0), (L, 0, 0), (L, W, 0), (0, W, 0),
         (0, 0, H), (L, 0, H), (L, W, H), (0, W, H)]
    cp = [w.add(f"CARTESIAN_POINT('',({fmt(x)},{fmt(y)},{fmt(z)}))") for x, y, z in P]
    vp = [w.add(f"VERTEX_POINT('',#{c})") for c in cp]
    edges = {}

    def edge(a, b):
        key = (min(a, b), max(a, b))
        if key not in edges:
            i, j = key
            d = [P[j][k] - P[i][k] for k in range(3)]
            ln = sum(v * v for v in d) ** 0.5
            d = [v / ln for v in d]
            dr = w.add(f"DIRECTION('',({fmt(d[0])},{fmt(d[1])},{fmt(d[2])}))")
            vec = w.add(f"VECTOR('',#{dr},1.)")
            line = w.add(f"LINE('',#{cp[i]},#{vec})")
            edges[key] = w.add(f"EDGE_CURVE('',#{vp[i]},#{vp[j]},#{line},.T.)")
        return edges[key], (a < b)

    def loop_of(seq):
        oes = []
        for k in range(len(seq)):
            a, b = seq[k], seq[(k + 1) % len(seq)]
            ec, fwd = edge(a, b)
            oes.append(w.add(f"ORIENTED_EDGE('',*,*,#{ec},{'.T.' if fwd else '.F.'})"))
        return w.add("EDGE_LOOP('',(" + ",".join(f"#{o}" for o in oes) + "))")

    # 穴ごとに 上下の円エッジ + 継ぎ目 (シーム) を用意する
    hole_edges = []
    for cx, cy, r in holes:
        c_bot, v_bot = circle_geom(w, cx, cy, 0, r)
        c_top, v_top = circle_geom(w, cx, cy, H, r)
        e_bot = w.add(f"EDGE_CURVE('',#{v_bot},#{v_bot},#{c_bot},.T.)")
        e_top = w.add(f"EDGE_CURVE('',#{v_top},#{v_top},#{c_top},.T.)")
        sp = w.add(f"CARTESIAN_POINT('',({fmt(cx + r)},{fmt(cy)},{fmt(0)}))")
        sd = w.add("DIRECTION('',(0.,0.,1.))")
        sv = w.add(f"VECTOR('',#{sd},1.)")
        sl = w.add(f"LINE('',#{sp},#{sv})")
        e_seam = w.add(f"EDGE_CURVE('',#{v_bot},#{v_top},#{sl},.T.)")
        hole_edges.append((cx, cy, r, e_bot, e_top, e_seam))

    faces = []
    # 下面 (法線 -Z) / 上面 (法線 +Z): 外周の矩形 + 穴の円 (内周)
    for z, seq, nrm, reverse_inner in ((0, [0, 3, 2, 1], (0, 0, -1), False), (H, [4, 5, 6, 7], (0, 0, 1), True)):
        outer = w.add(f"FACE_OUTER_BOUND('',#{loop_of(seq)},.T.)")
        bounds = [outer]
        for cx, cy, r, e_bot, e_top, e_seam in hole_edges:
            ec = e_bot if z == 0 else e_top
            oe = w.add(f"ORIENTED_EDGE('',*,*,#{ec},{'.F.' if reverse_inner else '.T.'})")
            el = w.add(f"EDGE_LOOP('',(#{oe}))")
            bounds.append(w.add(f"FACE_BOUND('',#{el},.T.)"))
        ax = axis(w, (0, 0, z), nrm, (1, 0, 0))
        pl = w.add(f"PLANE('',#{ax})")
        faces.append(w.add("ADVANCED_FACE('',(" + ",".join(f"#{b}" for b in bounds) + f"),#{pl},.T.)"))
    # 側面 4 枚
    for seq, nrm, ref in (([0, 1, 5, 4], (0, -1, 0), (1, 0, 0)), ([3, 7, 6, 2], (0, 1, 0), (1, 0, 0)),
                          ([0, 4, 7, 3], (-1, 0, 0), (0, 1, 0)), ([1, 2, 6, 5], (1, 0, 0), (0, 1, 0))):
        fb = w.add(f"FACE_OUTER_BOUND('',#{loop_of(seq)},.T.)")
        ax = axis(w, P[seq[0]], nrm, ref)
        pl = w.add(f"PLANE('',#{ax})")
        faces.append(w.add(f"ADVANCED_FACE('',(#{fb}),#{pl},.T.)"))
    # 穴の内壁 (円筒面)。材料は外側にあるので same_sense を .F. にする
    for cx, cy, r, e_bot, e_top, e_seam in hole_edges:
        ax = axis(w, (cx, cy, 0), (0, 0, 1), (1, 0, 0))
        cyl = w.add(f"CYLINDRICAL_SURFACE('',#{ax},{fmt(r)})")
        o1 = w.add(f"ORIENTED_EDGE('',*,*,#{e_bot},.T.)")
        o2 = w.add(f"ORIENTED_EDGE('',*,*,#{e_seam},.T.)")
        o3 = w.add(f"ORIENTED_EDGE('',*,*,#{e_top},.F.)")
        o4 = w.add(f"ORIENTED_EDGE('',*,*,#{e_seam},.F.)")
        el = w.add(f"EDGE_LOOP('',(#{o1},#{o2},#{o3},#{o4}))")
        fb = w.add(f"FACE_OUTER_BOUND('',#{el},.T.)")
        faces.append(w.add(f"ADVANCED_FACE('',(#{fb}),#{cyl},.F.)"))

    shell = w.add("CLOSED_SHELL('',(" + ",".join(f"#{f}" for f in faces) + "))")
    solid = w.add(f"MANIFOLD_SOLID_BREP('{name}',#{shell})")

    p, pd = ctx.product(name)
    pds = w.add(f"PRODUCT_DEFINITION_SHAPE('','',#{pd})")
    ax0 = axis(w)
    rep = w.add(f"ADVANCED_BREP_SHAPE_REPRESENTATION('{name}',(#{ax0},#{solid}),#{ctx.geom})")
    w.add(f"SHAPE_DEFINITION_REPRESENTATION(#{pds},#{rep})")
    return pd, rep


def part(ctx, name, L, W, H, color=None):
    """単品 (製品定義 + ADVANCED_BREP_SHAPE_REPRESENTATION)。(pd, shape_rep) を返す。"""
    w = ctx.w
    p, pd = ctx.product(name)
    pds = w.add(f"PRODUCT_DEFINITION_SHAPE('','',#{pd})")
    ax = axis(w)
    solid = box_solid(w, name, L, W, H)
    rep = w.add(f"ADVANCED_BREP_SHAPE_REPRESENTATION('{name}',(#{ax},#{solid}),#{ctx.geom})")
    w.add(f"SHAPE_DEFINITION_REPRESENTATION(#{pds},#{rep})")
    if color:
        r, g, b = color
        col = w.add(f"COLOUR_RGB('',{fmt(r)},{fmt(g)},{fmt(b)})")
        fill = w.add(f"FILL_AREA_STYLE_COLOUR('',#{col})")
        fas = w.add(f"FILL_AREA_STYLE('',(#{fill}))")
        ssf = w.add(f"SURFACE_STYLE_FILL_AREA(#{fas})")
        sss = w.add(f"SURFACE_SIDE_STYLE('',(#{ssf}))")
        ssu = w.add(f"SURFACE_STYLE_USAGE(.BOTH.,#{sss})")
        psa = w.add(f"PRESENTATION_STYLE_ASSIGNMENT((#{ssu}))")
        si = w.add(f"STYLED_ITEM('',(#{psa}),#{solid})")
        w.add(f"MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(#{si}),#{ctx.geom})")
    return pd, rep


def assembly(ctx, name, children):
    """children: [(child_name_in_assy, (pd, rep), (x,y,z))]"""
    w = ctx.w
    p, pd = ctx.product(name)
    pds = w.add(f"PRODUCT_DEFINITION_SHAPE('','',#{pd})")
    origin = axis(w)
    child_axes = [axis(w, pos) for _, _, pos in children]
    items = ",".join(f"#{a}" for a in [origin] + child_axes)
    rep = w.add(f"SHAPE_REPRESENTATION('{name}',({items}),#{ctx.geom})")
    w.add(f"SHAPE_DEFINITION_REPRESENTATION(#{pds},#{rep})")
    for i, (cname, (cpd, crep), pos) in enumerate(children):
        nauo = w.add(f"NEXT_ASSEMBLY_USAGE_OCCURRENCE('{cname}','{cname}','',#{pd},#{cpd},$)")
        npds = w.add(f"PRODUCT_DEFINITION_SHAPE('','',#{nauo})")
        tr = w.add(f"ITEM_DEFINED_TRANSFORMATION('','',#{origin},#{child_axes[i]})")
        rr = w.add(
            f"( REPRESENTATION_RELATIONSHIP('','',#{crep},#{rep}) "
            f"REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#{tr}) SHAPE_REPRESENTATION_RELATIONSHIP() )")
        w.add(f"CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#{rr},#{npds})")
    return pd, rep


def gen_box():
    w = Writer()
    ctx = Ctx(w)
    part(ctx, "BOX", 100, 60, 40, color=(0.8, 0.5, 0.3))
    ctx.finish()
    return w.dump("box.step")


def gen_assembly(scale=1.0, fname="assembly.step", root="DEVICE_A"):
    w = Writer()
    ctx = Ctx(w)
    s = scale
    base = part(ctx, "BASE_PLATE", 300 * s, 200 * s, 20, color=(0.55, 0.55, 0.6))
    column = part(ctx, "COLUMN", 40, 40, 250 * s, color=(0.8, 0.5, 0.3))
    head = part(ctx, "HEAD_UNIT", 120 * s, 80, 60, color=(0.35, 0.7, 0.65))
    arm = assembly(ctx, "ARM_UNIT", [
        ("COLUMN", column, (0, 0, 0)),
        ("HEAD_UNIT", head, (-40 * s, -20, 250 * s)),
    ])
    assembly(ctx, root, [
        ("BASE_PLATE", base, (0, 0, 0)),
        ("ARM_UNIT", arm, (130 * s, 80, 20)),
    ])
    ctx.finish()
    return w.dump(fname)


def gen_occluded():
    """既定のカメラ角度から、小さい部品が大きな板の陰に完全に隠れる配置。

    既定視点は theta=-45°, phi=60° なので、視線方向は約 (0.61, -0.61, 0.50)。
    その延長線上に大きな板を置くと SMALL_PART が隠れる。「この部品に寄る」の検証用。
    """
    w = Writer()
    ctx = Ctx(w)
    small = part(ctx, "SMALL_PART", 20, 20, 20, color=(0.8, 0.5, 0.3))
    plate = part(ctx, "BIG_PLATE", 5, 400, 400, color=(0.55, 0.55, 0.6))
    assembly(ctx, "OCCLUDED", [
        ("SMALL_PART", small, (0, 0, 0)),
        ("BIG_PLATE", plate, (71, -200, -140)),
    ])
    ctx.finish()
    return w.dump("occluded.step")


def gen_backside():
    """大きな板の「裏」に小さな部品が付いた配置。

    既定のカメラは上から見下ろす (phi=60°) ので、板の下にある部品は完全に隠れる。
    見えるのは下から覗き込む角度だけ。「見やすい角度へ回り込む」の検証用。
    """
    w = Writer()
    ctx = Ctx(w)
    plate = part(ctx, "TOP_PLATE", 400, 400, 5, color=(0.55, 0.55, 0.6))
    small = part(ctx, "BACK_PART", 40, 40, 10, color=(0.8, 0.5, 0.3))
    assembly(ctx, "BACKSIDE", [
        ("TOP_PLATE", plate, (0, 0, 0)),
        ("BACK_PART", small, (180, 180, -12)),
    ])
    ctx.finish()
    return w.dump("backside.step")


def gen_holes():
    """穴の中心・径が厳密に分かっている板。計測精度の検証用。

    板 200 x 120 x 10、貫通穴 φ16 (r=8) の中心が (50,60) と (150,60) → 中心間距離ちょうど 100。
    もう 1 つ φ25 (r=12.5) の穴を (100,30) に。
    """
    w = Writer()
    ctx = Ctx(w)
    plate_with_holes(ctx, "HOLE_PLATE", 200, 120, 10, [(50, 60, 8), (150, 60, 8), (100, 30, 12.5)])
    ctx.finish()
    return w.dump("holes.step")


def gen_heavy(count=150):
    """重い STEP (性能計測用)。穴あき板を count 個ぶら下げたアセンブリ。

    形状を少しずつ変えて、OCC がメッシュを使い回せないようにしてある。
    """
    w = Writer()
    ctx = Ctx(w)
    children = []
    for i in range(count):
        L = 120 + (i % 7) * 13
        W = 80 + (i % 5) * 11
        holes = [(30 + (i % 3) * 5, 40, 6 + (i % 4)), (L - 30, W - 30, 5 + (i % 3))]
        name = f"PART_{i:03d}"
        pd = plate_with_holes(ctx, name, L, W, 8 + (i % 3), holes)
        children.append((name, pd, ((i % 12) * 200, (i // 12) * 150, 0)))
    assembly(ctx, "HEAVY_ASSY", children)
    ctx.finish()
    return w.dump("heavy.step")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--heavy":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 150
        out = sys.argv[3] if len(sys.argv) > 3 else "test/out/heavy.step"
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        with open(out, "w") as f:
            f.write(gen_heavy(n))
        print("wrote", out, os.path.getsize(out), "bytes")
        return
    if len(sys.argv) > 1 and sys.argv[1] == "--assembly":
        path, root = sys.argv[2], sys.argv[3]
        scale = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w") as f:
            f.write(gen_assembly(scale=scale, fname=os.path.basename(path), root=root))
        print("wrote", path)
        return
    out = sys.argv[1] if len(sys.argv) > 1 else "test/out"
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "box.step"), "w") as f:
        f.write(gen_box())
    with open(os.path.join(out, "assembly.step"), "w") as f:
        f.write(gen_assembly())
    with open(os.path.join(out, "assembly_b.step"), "w") as f:
        f.write(gen_assembly(scale=1.4, fname="assembly_b.step", root="DEVICE_B"))
    with open(os.path.join(out, "holes.step"), "w") as f:
        f.write(gen_holes())
    with open(os.path.join(out, "occluded.step"), "w") as f:
        f.write(gen_occluded())
    with open(os.path.join(out, "backside.step"), "w") as f:
        f.write(gen_backside())
    print("wrote", sorted(f for f in os.listdir(out) if f.endswith(".step")))


if __name__ == "__main__":
    main()
