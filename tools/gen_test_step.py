#!/usr/bin/env python3
"""AP214 STEP テストデータ生成。

手元に STEP がない環境で occt-import-js の動作確認をするための
最小限の B-rep 生成器。外部ライブラリ不要。

  python3 tools/gen_test_step.py <出力ディレクトリ>

生成物:
  box.step        直方体 1 個 (MANIFOLD_SOLID_BREP)
  assembly.step   3 部品 + サブアセンブリの階層 (NEXT_ASSEMBLY_USAGE_OCCURRENCE)
  assembly_b.step 同じ構成で寸法違い (横断一覧の検証用)
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


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "test/out"
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "box.step"), "w") as f:
        f.write(gen_box())
    with open(os.path.join(out, "assembly.step"), "w") as f:
        f.write(gen_assembly())
    with open(os.path.join(out, "assembly_b.step"), "w") as f:
        f.write(gen_assembly(scale=1.4, fname="assembly_b.step", root="DEVICE_B"))
    print("wrote", os.listdir(out))
