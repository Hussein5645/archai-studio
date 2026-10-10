"""Tests of archai_core.py. Run with any Python 3.7+ (Blender's works):
   blender --background --factory-startup --python-exit-code 1 --python plugins/python/test_core.py -- [file.AIR ...]
Extra .AIR files (from ArchAI or another plugin) are read and summarised.
Set BLENDER_USER_CONFIG, BLENDER_USER_SCRIPTS, BLENDER_USER_EXTENSIONS and BLENDER_USER_DATAFILES to
empty folders first: a --factory-startup Blender on your own profile removes the Python packages
your installed extensions use (Blender puts them back on its next normal start)."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import archai_core as core  # noqa: E402


def near(a, b, tol=1e-4):
    assert abs(a - b) <= tol, "expected %r, got %r" % (b, a)


def box(name="box"):
    """1 m x 2 m x 3 m at host (10 m, 20 m, 0) in a Z-up millimetre host."""
    o = core.SceneObject(name, name, "Generic")
    corners = [(x, y, z) for z in (0, 1) for y in (0, 1) for x in (0, 1)]
    positions = []
    for x, y, z in corners:
        positions += core.from_z_up(10000 + x * 1000, 20000 + y * 2000, z * 3000, 1)
    # corner index = x + 2y + 4z
    faces = [0, 3, 1, 0, 2, 3, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 1, 3, 7, 1, 7, 5, 3, 2, 6, 3, 6, 7, 2, 0, 4, 2, 4, 6]
    o.add_mesh(core.Material("Red", 1, 0, 0), positions, faces)
    return o


tests = []
test = tests.append


@test
def axes():
    p = core.from_z_up(1, 2, 3, 1000)
    assert p == (1000, -2000, 3000)
    x, y, z = core.to_z_up(1, 3, -2, 1000)
    near(x, 1); near(y, 2); near(z, 3)


@test
def glb_round_trip():
    w = core.GlbWriter()
    w.begin_node("A", {"archai": {"id": "a", "type": "wall", "level": "Ground"}})
    w.add(core.Material("Grey", 0.5, 0.5, 0.5), [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2])
    w.begin_node("B", {"archai": {"id": "b", "kind": "rect"}})
    w.add(core.DEFAULT_MATERIAL, [0, 0, 5, 1, 0, 5, 0, 1, 5], [0, 1, 2])
    objects = core.read_glb(w.to_glb())
    assert [o.name for o in objects] == ["A", "B"]
    assert objects[0].type == "wall" and objects[0].level == "Ground" and objects[1].type == "rect"
    near(objects[0].parts[0].material.r, 0.5, 1e-3)
    near(objects[1].parts[0].positions[2], 5)


@test
def exchange_round_trip():
    exchange = core.write_exchange("Test", "Blender", "4.2", "c:/x.blend", [box()])
    mesh = exchange["meshes"][0]
    assert exchange["archaiRevit"] == 1 and exchange["app"] == "Blender"
    assert mesh["origin"] == [10000.0, -22000.0, 0.0] and mesh["size"] == [1000.0, 2000.0, 3000.0], mesh["origin"]
    path = os.path.join(tempfile.gettempdir(), "archai-core-py.AIR")
    core.save_exchange(path, exchange)
    name, objects = core.read_air(path)
    assert name == "Test" and len(objects) == 1 and objects[0].triangle_count == 12
    pos = objects[0].parts[0].positions
    near(min(pos[0::3]), 10, 1e-3); near(max(pos[1::3]), 3, 1e-3); near(min(pos[2::3]), -22, 1e-3)


@test
def document_without_snapshot():
    path = os.path.join(tempfile.gettempdir(), "archai-core-py-doc.AIR")
    with open(path, "w") as f:
        f.write('{"schemaVersion":9,"id":"d","meta":{"name":"Doc"},"elements":{}}')
    try:
        core.read_air(path)
    except ValueError as error:
        assert str(error) == core.NO_SNAPSHOT
    else:
        raise AssertionError("accepted")


@test
def vr_tour():
    camera = core.camera_stop("Entrance", core.from_z_up(5000, 20000, 1600, 1), core.from_z_up(1, 0, 0, 1))
    glb, tour, triangles, stops = core.build_tour("Test", "Blender", [box()], [camera])
    assert stops == 1 and triangles == 12 + 64 and tour["format"] == "archai-vr" and tour["start"] == "s1"
    space = tour["spaces"][0]
    assert space["center"] == [5.0, -20.0] and space["floor"] == 0.0 and space["look"] == [8.0, -20.0], space
    _, outside, _, _ = core.build_tour("Test", "Blender", [box()], [])
    assert outside["spaces"][0]["name"] == "Outside"
    names = [o.name for o in core.read_glb(glb)]
    assert names == ["box", "Ground"], names


failed = 0
for t in tests:
    try:
        t()
        print("PASS", t.__name__)
    except Exception as error:  # noqa: BLE001
        failed += 1
        print("FAIL", t.__name__, error)

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
for path in args:
    name, objects = core.read_air(path)
    print("%s: %d objects, %d triangles" % (name, len(objects), sum(o.triangle_count for o in objects)))
    for level, items in core.by_level(objects):
        print("  level %r: %d objects (%s)" % (level, len(items), ", ".join(sorted({o.type for o in items})[:8])))

print("%d passed, %d failed" % (len(tests) - failed, failed))
if failed:
    sys.exit(1)
