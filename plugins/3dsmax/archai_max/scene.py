"""The 3ds Max scene as ArchAI objects, and imported objects back into it (pymxs only, no UI,
so it also runs in 3dsmaxbatch)."""
import os

import pymxs
from pymxs import runtime as rt

from . import archai_core as core

# MAXScript helpers: one call per node instead of one per vertex.
rt.execute(r"""
fn archaiMeshData node = (
    local m = snapshotAsMesh node
    local verts = for i = 1 to m.numverts collect (getVert m i)
    local faces = for i = 1 to m.numfaces collect (getFace m i)
    local ids = for i = 1 to m.numfaces collect (getFaceMatID m i)
    delete m
    #(verts, faces, ids)
)
fn archaiMakeMesh verts faces = (
    mesh vertices:verts faces:faces
)
""")

_UNITS = {"millimeters": 1.0, "centimeters": 10.0, "meters": 1000.0, "kilometers": 1000000.0,
          "inches": 25.4, "feet": 304.8, "miles": 1609344.0}


def millimetres():
    """Millimetres per system unit."""
    kind = str(rt.units.SystemType).lower().lstrip("#")
    return _UNITS.get(kind, 25.4) * float(rt.units.SystemScale)


def _colour(value):
    return (value.r / 255.0, value.g / 255.0, value.b / 255.0)


def _material(material, wire, cache):
    """An ArchAI material from a Max material (Physical, Standard, PBR, Arnold standard surface),
    or from the node's wire colour when it has none."""
    if material is None:
        key = "Wire #%02x%02x%02x" % (int(wire.r), int(wire.g), int(wire.b))
        if key not in cache:
            cache[key] = core.Material(key, *_colour(wire), roughness=0.8)
        return cache[key]
    key = str(material.name)
    if key in cache:
        return cache[key]
    colour, opacity, roughness, metalness = (0.8, 0.8, 0.8), 1.0, 0.8, 0.0
    for prop, kind in (("base_color", "rgb"), ("baseColor", "rgb"), ("diffuse", "rgb"), ("Diffuse", "rgb")):
        if rt.isProperty(material, prop):
            value = rt.getProperty(material, prop)
            try:
                colour = _colour(value)
                break
            except Exception:  # noqa: BLE001 - not a colour
                pass
    for prop in ("roughness", "base_roughness"):
        if rt.isProperty(material, prop):
            try:
                roughness = float(rt.getProperty(material, prop))
                break
            except Exception:  # noqa: BLE001
                pass
    if rt.isProperty(material, "metalness"):
        try:
            metalness = float(rt.getProperty(material, "metalness"))
        except Exception:  # noqa: BLE001
            pass
    if rt.isProperty(material, "transparency"):
        try:
            opacity = 1.0 - float(rt.getProperty(material, "transparency"))
        except Exception:  # noqa: BLE001
            pass
    elif rt.isProperty(material, "opacity"):
        try:
            opacity = float(rt.getProperty(material, "opacity")) / 100.0
        except Exception:  # noqa: BLE001
            pass
    cache[key] = core.Material(key, colour[0], colour[1], colour[2], max(0.0, min(1.0, opacity)), roughness, metalness)
    return cache[key]


LIVE_LAYER = "ArchAI Live"


def is_live(node):
    """Nodes the live link brought in from ArchAI (never sent back)."""
    try:
        return bool(rt.getUserProp(node, "archai_live"))
    except Exception:  # noqa: BLE001
        return False


class Progress:
    """3ds Max's progress bar (MAXScript progressStart / progressUpdate) and the prompt line.
    `update(text, fraction)` works as a core progress callback; main thread only."""

    def __init__(self, title):
        self.title = title
        self.started = False

    def begin(self, text=""):
        if not self.started:
            try:
                rt.progressStart("ArchAI " + self.title)
            except Exception:  # noqa: BLE001
                pass
            self.started = True
        self._prompt(text, None)

    def update(self, text, fraction=None):
        if not self.started:
            self.begin(text)
        if fraction is not None:
            try:
                rt.progressUpdate(int(round(max(0.0, min(1.0, fraction)) * 100)))
            except Exception:  # noqa: BLE001
                pass
        self._prompt(text, fraction)

    def end(self):
        if self.started:
            try:
                rt.progressEnd()
            except Exception:  # noqa: BLE001
                pass
        self.started = False
        self._prompt("", None)

    def _prompt(self, text, fraction):
        line = "" if not text else "ArchAI %s: %s" % (self.title, text) + ("" if fraction is None else "  (%d%%)" % int(round(fraction * 100)))
        try:
            rt.replacePrompt(line)
        except Exception:  # noqa: BLE001
            pass


def collect(skip_live=False, progress=None):
    """Visible geometry nodes as ArchAI objects (world space, modifiers applied)."""
    mm = millimetres()
    objects, cache = [], {}
    nodes = list(rt.geometry)
    for index, node in enumerate(nodes):
        core.step(progress, index, len(nodes), "Reading object %d of %d" % (index + 1, len(nodes)))
        if node.isHidden or rt.classOf(node) == rt.Targetobject:
            continue
        if skip_live and is_live(node):
            continue
        if node.layer is not None and node.layer.isHidden:
            continue
        try:
            verts, faces, ids = rt.archaiMeshData(node)
        except Exception:  # noqa: BLE001 - not convertible to a mesh
            continue
        if not faces:
            continue
        item = core.SceneObject(str(node.handle), str(node.name), str(node.layer.name) if node.layer is not None else "")
        positions = []
        for v in verts:
            positions += core.from_z_up(v.x, v.y, v.z, mm)
        material = node.material
        multi = material is not None and rt.classOf(material) == rt.Multimaterial
        by_slot = {}
        for face, slot in zip(faces, ids):
            by_slot.setdefault(int(slot), []).extend((int(face.x) - 1, int(face.y) - 1, int(face.z) - 1))
        for slot, indices in by_slot.items():
            source = material
            if multi:
                ids_list = list(material.materialIDList)
                source = material.materialList[ids_list.index(slot)] if slot in ids_list else None
            item.add_mesh(_material(source, node.wirecolor, cache), positions, indices)
        objects.append(item)
    return objects


def cameras():
    mm = millimetres()
    stops = []
    for camera in sorted(rt.cameras, key=lambda c: str(c.name)):
        if rt.classOf(camera) == rt.Targetobject or camera.isHidden:
            continue
        eye = camera.pos
        # Cameras look down their local -Z.
        d = camera.dir
        stops.append(core.camera_stop(str(camera.name), core.from_z_up(eye.x, eye.y, eye.z, mm), core.from_z_up(-d.x, -d.y, -d.z, 1)))
    return stops


def document_name():
    name = str(rt.maxFileName)
    return os.path.splitext(name)[0] if name else "3ds Max scene"


def document_key():
    path = os.path.join(str(rt.maxFilePath), str(rt.maxFileName))
    return "3dsmax|" + (path if str(rt.maxFileName) else "unsaved:" + document_name())


def send(path, progress=None):
    objects = collect(progress=core.scaled(progress, 0.0, 0.9))
    if progress:
        progress("Writing the .AIR file", 0.95)
    exchange = core.write_exchange(document_name(), "3ds Max", str(rt.maxVersion()[0]), os.path.join(str(rt.maxFilePath), str(rt.maxFileName)), objects)
    if not exchange["meshes"]:
        raise ValueError("There are no visible geometry objects to send.")
    core.save_exchange(path, exchange)
    return len(exchange["meshes"])


def _make_material(source, cache):
    if source.name in cache:
        return cache[source.name]
    colour = rt.Color(source.r * 255, source.g * 255, source.b * 255)
    try:
        material = rt.PhysicalMaterial(name=source.name)
        material.base_color = colour
        material.roughness = source.roughness
        material.metalness = source.metalness
        material.transparency = 1.0 - source.opacity
    except Exception:  # noqa: BLE001 - older or limited Max: a standard material
        material = rt.StandardMaterial(name=source.name)
        material.diffuse = colour
        material.opacity = source.opacity * 100
    cache[source.name] = material
    return material


def import_air(path, progress=None):
    """Adds an .AIR file's elements: a mesh per material, grouped per element, a layer per level."""
    if progress:
        progress("Reading " + os.path.basename(path), None)
    name, objects = core.read_air(path)
    return name, import_objects(name, objects, progress=core.scaled(progress, 0.1, 1.0))


def clear_live():
    """Removes what the live link brought in."""
    with pymxs.undo(False):
        nodes = [node for node in rt.objects if is_live(node)]
        if nodes:
            rt.delete(nodes)


def signature():
    """A cheap fingerprint of the scene's own geometry, to notice edits (the live link polls it)."""
    parts = []
    for node in rt.geometry:
        if is_live(node):
            continue
        try:
            parts.append((int(node.handle), str(node.name), str(node.transform), bool(node.isHidden), str(node.material.name) if node.material else "", int(rt.getPolygonCount(node)[0])))
        except Exception:  # noqa: BLE001
            parts.append((int(node.handle), str(node.name)))
    return hash(tuple(parts))


def import_objects(name, objects, live=False, progress=None):
    mm = millimetres()
    cache, count = {}, 0
    total = len(objects)
    with pymxs.undo(not live, "Open .AIR"):
        for level, items in core.by_level(objects):
            layer_name = (LIVE_LAYER + " " + level).strip() if live else "ArchAI " + (level or name)
            layer = rt.LayerManager.getLayerFromName(layer_name) or rt.LayerManager.newLayerFromName(layer_name)
            for item in items:
                core.step(progress, count, total, "Adding element %d of %d" % (count + 1, total))
                nodes = []
                for part in item.parts:
                    p = part.positions
                    verts = [rt.Point3(*core.to_z_up(p[i], p[i + 1], p[i + 2], mm)) for i in range(0, len(p) - 2, 3)]
                    idx = part.indices
                    faces = [rt.Point3(idx[i] + 1, idx[i + 1] + 1, idx[i + 2] + 1) for i in range(0, len(idx) - 2, 3)]
                    if not faces:
                        continue
                    node = rt.archaiMakeMesh(verts, faces)
                    node.name = item.name
                    node.material = _make_material(part.material, cache)
                    node.wirecolor = rt.Color(part.material.r * 255, part.material.g * 255, part.material.b * 255)
                    if item.type:
                        rt.setUserProp(node, "archai_type", item.type)
                    if live:
                        rt.setUserProp(node, "archai_live", True)
                    layer.addNode(node)
                    nodes.append(node)
                if len(nodes) > 1:
                    group = rt.group(nodes, name=item.name)
                    if live:
                        rt.setUserProp(group, "archai_live", True)
                    layer.addNode(group)
                if nodes:
                    count += 1
    rt.redrawViews()
    return count


def live_exchange():
    """The scene for the live link (without what ArchAI sent)."""
    return core.write_exchange(document_name(), "3ds Max", str(rt.maxVersion()[0]), os.path.join(str(rt.maxFilePath), str(rt.maxFileName)), collect(skip_live=True))


def prepare_tour(progress=None):
    """(glb, tour, triangles, stops, name, key) of the visible scene."""
    name = document_name()
    active = rt.viewport.getCamera()
    start = str(active.name) if active is not None else None
    objects = collect(progress=progress)
    if progress:
        progress("Building the VR model", None)
    glb, tour, triangles, stops = core.build_tour(name, "3ds Max", objects, cameras(), start)
    return glb, tour, triangles, stops, name, document_key()
