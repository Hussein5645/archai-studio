"""
ArchAI plugin core for Python hosts (Blender, 3ds Max, Unreal): the Python twin of
plugins/dotnet/Archai.Plugins.Core. Pure standard library (Python 3.7+), so each plugin ships
this one file.

- Units and axes: ArchAI uses millimetres with plan x right, plan y down (a Z-up right-handed
  host's -Y) and elevation up. glTF, ArchAI's 3D scene and the VR viewer use metres with
  (x, up, plan y).
- Exchange file: what ArchAI opens from other apps (src/revit/exchange.ts, `archaiRevit: 1`).
- .AIR import: ArchAI documents carry a 3D snapshot (`scene3d`, binary glTF) for other apps.
- VR: a tour in the SJP-VR viewer format uploaded to ArchAI's VR share service.
"""
import base64
import datetime
import json
import math
import os
import re
import struct
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from array import array

VERSION = "0.4.1"
WEB_URL = "https://archai-studio-six.vercel.app/"
DEFAULT_SHARE_URL = "https://archai-vr-share.mklkoklpp.workers.dev"
MAX_MODEL_BYTES = 95 * 1024 * 1024
MAX_STOPS = 40
LOOK_DISTANCE = 3.0
EYE_HEIGHT = 1.6
NO_SNAPSHOT = ("This .AIR file has no 3D model saved in it. Open it in ArchAI (0.2.2.8 or later) "
               "and save it once, then import it again.")
NO_KEY = "Open in VR publishes with your ArchAI account: start ArchAI and sign in (top right)."


# ---- materials and scene objects --------------------------------------------------------

class Material:
    """A glTF metallic-roughness material; colours are sRGB 0..1."""

    def __init__(self, name="Material", r=0.8, g=0.8, b=0.8, opacity=1.0, roughness=0.8, metalness=0.0):
        self.name = name or "Material"
        self.r, self.g, self.b = float(r), float(g), float(b)
        self.opacity, self.roughness, self.metalness = float(opacity), float(roughness), float(metalness)

    @property
    def hex(self):
        return "#%02x%02x%02x" % tuple(int(round(max(0.0, min(1.0, c)) * 255)) for c in (self.r, self.g, self.b))


DEFAULT_MATERIAL = Material("Default", 0.78, 0.79, 0.81)


def linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def srgb(c):
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


class Part:
    """Triangles of one material: flat positions (ArchAI mm: x, plan y, elevation) and indices."""

    def __init__(self, material):
        self.material = material
        self.positions = []
        self.indices = []


class SceneObject:
    """One host object to send to ArchAI or to VR."""

    def __init__(self, id="", name="", category=""):
        self.id, self.name, self.category = id, name, category
        self.parts = {}

    def part(self, material):
        part = self.parts.get(material.name)
        if part is None:
            part = self.parts[material.name] = Part(material)
        return part

    def add_mesh(self, material, positions, indices):
        """positions: flat ArchAI millimetres; indices: flat triangle indices into them."""
        part = self.part(material)
        base = len(part.positions) // 3
        part.positions.extend(positions)
        part.indices.extend(i + base for i in indices)

    @property
    def triangle_count(self):
        return sum(len(p.indices) // 3 for p in self.parts.values())


def from_z_up(x, y, z, millimetres):
    """A Z-up right-handed host point (in host units of `millimetres` mm) in ArchAI millimetres."""
    return (x * millimetres, -y * millimetres, z * millimetres)


def to_z_up(x, y, z, millimetres):
    """glTF metres (x, up, plan y) to a Z-up right-handed host point in host units."""
    return (x * 1000.0 / millimetres, -z * 1000.0 / millimetres, y * 1000.0 / millimetres)


class Bounds:
    def __init__(self):
        self.min = [math.inf] * 3
        self.max = [-math.inf] * 3

    @property
    def empty(self):
        return self.min[0] > self.max[0]

    def add_positions(self, positions):
        for axis in range(3):
            values = positions[axis::3]
            if values:
                self.min[axis] = min(self.min[axis], min(values))
                self.max[axis] = max(self.max[axis], max(values))

    @staticmethod
    def of(objects):
        bounds = Bounds()
        for o in objects:
            for p in o.parts.values():
                if p.indices:
                    bounds.add_positions(p.positions)
        return bounds


# ---- binary glTF ---------------------------------------------------------------------------

class GlbWriter:
    """One node and mesh per begin_node(), one primitive per material, positions only, uint32 indices."""

    def __init__(self):
        self.nodes = []
        self.triangle_count = 0

    def begin_node(self, name, extras=None):
        self.nodes.append({"name": name or "", "extras": extras, "parts": {}})

    def add(self, material, positions, indices):
        """positions: flat floats as written; indices: flat triangle indices."""
        if not self.nodes:
            self.begin_node("")
        parts = self.nodes[-1]["parts"]
        part = parts.get(material.name)
        if part is None:
            part = parts[material.name] = (material, array("f"), array("I"))
        base = len(part[1]) // 3
        part[1].extend(positions)
        part[2].extend(i + base for i in indices)
        self.triangle_count += len(indices) // 3

    def to_glb(self, generator="ArchAI plugin"):
        binary = bytearray()
        views, accessors, meshes, nodes, materials, material_index = [], [], [], [], [], {}
        for node in self.nodes:
            primitives = []
            for material, positions, indices in node["parts"].values():
                if not indices:
                    continue
                count = len(positions) // 3
                mins = [min(positions[a::3]) for a in range(3)]
                maxs = [max(positions[a::3]) for a in range(3)]
                views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(positions) * 4, "target": 34962})
                binary += positions.tobytes() if _little else _swap(positions)
                accessors.append({"bufferView": len(views) - 1, "componentType": 5126, "count": count, "type": "VEC3", "min": mins, "max": maxs})
                position_accessor = len(accessors) - 1
                views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(indices) * 4, "target": 34963})
                binary += indices.tobytes() if _little else _swap(indices)
                accessors.append({"bufferView": len(views) - 1, "componentType": 5125, "count": len(indices), "type": "SCALAR"})
                if material.name not in material_index:
                    entry = {"name": material.name, "doubleSided": True, "pbrMetallicRoughness": {
                        "baseColorFactor": [linear(material.r), linear(material.g), linear(material.b), material.opacity],
                        "metallicFactor": material.metalness, "roughnessFactor": material.roughness}}
                    if material.opacity < 0.999:
                        entry["alphaMode"] = "BLEND"
                    materials.append(entry)
                    material_index[material.name] = len(materials) - 1
                primitives.append({"attributes": {"POSITION": position_accessor}, "indices": len(accessors) - 1,
                                   "material": material_index[material.name], "mode": 4})
            if not primitives:
                continue
            meshes.append({"name": node["name"], "primitives": primitives})
            gltf_node = {"mesh": len(meshes) - 1}
            if node["name"]:
                gltf_node["name"] = node["name"]
            if node["extras"]:
                gltf_node["extras"] = node["extras"]
            nodes.append(gltf_node)
        document = {
            "asset": {"version": "2.0", "generator": generator}, "scene": 0,
            "scenes": [{"nodes": list(range(len(nodes)))}], "nodes": nodes, "meshes": meshes,
            "materials": materials, "accessors": accessors, "bufferViews": views,
            "buffers": [{"byteLength": len(binary)}],
        }
        text = json.dumps(document, separators=(",", ":")).encode("utf-8")
        text += b" " * ((4 - len(text) % 4) % 4)
        binary += b"\0" * ((4 - len(binary) % 4) % 4)
        return (struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(binary))
                + struct.pack("<II", len(text), 0x4E4F534A) + text
                + struct.pack("<II", len(binary), 0x004E4942) + bytes(binary))


import sys as _sys
_little = _sys.byteorder == "little"


def _swap(values):
    copy = array(values.typecode, values)
    copy.byteswap()
    return copy.tobytes()


class ImportPart:
    """Triangles of one material of an imported object, in world glTF metres (x, up, plan y)."""

    def __init__(self, material, positions, indices):
        self.material, self.positions, self.indices = material, positions, indices


class ImportObject:
    def __init__(self, name="", level="", type=""):
        self.name, self.level, self.type = name, level, type
        self.parts = []

    @property
    def triangle_count(self):
        return sum(len(p.indices) // 3 for p in self.parts)


_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
_FORMATS = {5126: ("f", 4), 5125: ("I", 4), 5123: ("H", 2), 5122: ("h", 2), 5121: ("B", 1), 5120: ("b", 1)}
_NORMALISE = {5123: 65535.0, 5122: 32767.0, 5121: 255.0, 5120: 127.0}


def read_glb(data):
    """Objects of a binary glTF with world positions. Nodes with `extras.archai` (ArchAI's .AIR
    snapshot) are one object each with everything below them; otherwise every mesh node is one."""
    if len(data) < 20 or struct.unpack_from("<I", data, 0)[0] != 0x46546C67:
        raise ValueError("Not a binary glTF file.")
    gltf, binary, offset = None, b"", 12
    while offset + 8 <= len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8: offset + 8 + length]
        if kind == 0x4E4F534A:
            gltf = json.loads(bytes(chunk).decode("utf-8"))
        elif kind == 0x004E4942:
            binary = bytes(chunk)
        offset += 8 + length
    if gltf is None:
        raise ValueError("The glTF file has no JSON chunk.")
    return _GltfScene(gltf, binary).objects()


class _GltfScene:
    def __init__(self, gltf, binary):
        self.gltf, self.binary = gltf, binary
        self.nodes = gltf.get("nodes", [])
        self.tagged = any(isinstance((n.get("extras") or {}).get("archai"), dict) for n in self.nodes)
        self.materials = {}
        self.result = []

    def objects(self):
        scenes = self.gltf.get("scenes") or [{"nodes": list(range(len(self.nodes)))}]
        for root in scenes[self.gltf.get("scene", 0)].get("nodes", []):
            self.visit(root, _IDENTITY, None)
        return [o for o in self.result if o.parts]

    def visit(self, index, parent, owner):
        node = self.nodes[index]
        world = _multiply(parent, _local(node))
        archai = (node.get("extras") or {}).get("archai")
        if isinstance(archai, dict) or (not self.tagged and "mesh" in node and owner is None):
            archai = archai if isinstance(archai, dict) else {}
            name = node.get("name") or ""
            if not name and "mesh" in node:
                name = self.gltf["meshes"][node["mesh"]].get("name") or ""
            kind = archai.get("type") or archai.get("kind") or ""
            owner = ImportObject(name or kind or "Object", archai.get("level") or "", kind)
            self.result.append(owner)
        if "mesh" in node and owner is not None:
            self.add_mesh(node["mesh"], world, owner)
        for child in node.get("children", []):
            self.visit(child, world, owner if self.tagged else None)

    def accessor(self, index):
        accessor = self.gltf["accessors"][index]
        if "sparse" in accessor:
            raise ValueError("Sparse glTF accessors are not supported.")
        view = self.gltf["bufferViews"][accessor["bufferView"]]
        code, size = _FORMATS[accessor["componentType"]]
        components = _COMPONENTS[accessor["type"]]
        start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        count = accessor["count"]
        stride = view.get("byteStride") or size * components
        if stride == size * components:
            values = array(code)
            values.frombytes(self.binary[start: start + count * stride])
            if not _little:
                values.byteswap()
            values = list(values)
        else:
            values = []
            for i in range(count):
                values.extend(struct.unpack_from("<" + code * components, self.binary, start + i * stride))
        if accessor.get("normalized") and accessor["componentType"] in _NORMALISE:
            scale = _NORMALISE[accessor["componentType"]]
            values = [max(v / scale, -1.0) for v in values]
        return values

    def add_mesh(self, index, world, owner):
        mirrored = _determinant(world) < 0
        for primitive in self.gltf["meshes"][index].get("primitives", []):
            if primitive.get("mode", 4) != 4 or "POSITION" not in primitive.get("attributes", {}):
                continue
            local = self.accessor(primitive["attributes"]["POSITION"])
            m = world
            positions = []
            for i in range(0, len(local) - 2, 3):
                x, y, z = local[i], local[i + 1], local[i + 2]
                positions.append(m[0] * x + m[4] * y + m[8] * z + m[12])
                positions.append(m[1] * x + m[5] * y + m[9] * z + m[13])
                positions.append(m[2] * x + m[6] * y + m[10] * z + m[14])
            indices = [int(v) for v in self.accessor(primitive["indices"])] if "indices" in primitive else list(range(len(local) // 3))
            if mirrored:
                for i in range(0, len(indices) - 2, 3):
                    indices[i + 1], indices[i + 2] = indices[i + 2], indices[i + 1]
            owner.parts.append(ImportPart(self.material(primitive.get("material")), positions, indices))

    def material(self, index):
        if index is None:
            return DEFAULT_MATERIAL
        if index not in self.materials:
            source = self.gltf.get("materials", [])[index]
            pbr = source.get("pbrMetallicRoughness", {})
            factor = pbr.get("baseColorFactor", [1, 1, 1, 1])
            self.materials[index] = Material(
                source.get("name") or "Material %d" % index, srgb(factor[0]), srgb(factor[1]), srgb(factor[2]),
                factor[3] if source.get("alphaMode") == "BLEND" else 1.0,
                pbr.get("roughnessFactor", 1.0), pbr.get("metallicFactor", 1.0))
        return self.materials[index]


_IDENTITY = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def _multiply(a, b):
    return [sum(a[k * 4 + row] * b[col * 4 + k] for k in range(4)) for col in range(4) for row in range(4)]


def _determinant(m):
    return (m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2])
            + m[8] * (m[1] * m[6] - m[5] * m[2]))


def _local(node):
    if "matrix" in node:
        return [float(v) for v in node["matrix"]]
    tx, ty, tz = node.get("translation", [0, 0, 0])
    qx, qy, qz, qw = node.get("rotation", [0, 0, 0, 1])
    sx, sy, sz = node.get("scale", [1, 1, 1])
    x2, y2, z2 = qx + qx, qy + qy, qz + qz
    xx, xy, xz, yy, yz, zz = qx * x2, qx * y2, qx * z2, qy * y2, qy * z2, qz * z2
    wx, wy, wz = qw * x2, qw * y2, qw * z2
    return [(1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
            (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
            (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
            tx, ty, tz, 1]


# ---- exchange file (to ArchAI) and .AIR import (from ArchAI) ---------------------------------

def _truncate(text, length):
    text = str(text or "")
    return text if len(text) <= length else text[:length]


def write_exchange(name, app, app_version, source, objects):
    """The exchange file ArchAI opens: every object as a mesh element (binary glTF in millimetres
    as (x, elevation, plan y) from its box corner, winding as the Revit add-in writes it)."""
    meshes = []
    for number, o in enumerate(objects, 1):
        parts = [p for p in o.parts.values() if p.indices]
        if not parts:
            continue
        box = Bounds()
        for p in parts:
            box.add_positions(p.positions)
        writer = GlbWriter()
        for p in parts:
            local = []
            pos = p.positions
            for i in range(0, len(pos) - 2, 3):
                local += (pos[i] - box.min[0], pos[i + 2] - box.min[2], pos[i + 1] - box.min[1])
            flipped = []
            idx = p.indices
            for i in range(0, len(idx) - 2, 3):
                flipped += (idx[i], idx[i + 2], idx[i + 1])
            writer.add(p.material, local, flipped)
        meshes.append({
            "id": _truncate(o.id or "o%d" % number, 64),
            "name": _truncate(o.name, 120),
            "category": _truncate(o.category, 80),
            "level": None,
            "origin": [round(box.min[0], 1), round(box.min[1], 1), round(box.min[2], 1)],
            "size": [round(box.max[a] - box.min[a], 1) for a in range(3)],
            "glb": base64.b64encode(writer.to_glb("ArchAI %s plugin" % app)).decode("ascii"),
        })
    return {
        "archaiRevit": 1, "app": app, "name": _truncate(name or app + " model", 200),
        "source": _truncate(source, 1000), "revitVersion": _truncate("%s %s" % (app, app_version), 40),
        "materials": [], "levels": [], "meshes": meshes,
    }


def save_exchange(path, exchange):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(exchange, f, separators=(",", ":"))


def read_air(path):
    """(name, [ImportObject]) of an .AIR file in world glTF metres (x, up, plan y): an ArchAI
    document's 3D snapshot, or the meshes of an exchange file another plugin wrote."""
    with open(path, "r", encoding="utf-8") as f:
        try:
            root = json.load(f)
        except ValueError:
            raise ValueError(os.path.basename(path) + " is not an ArchAI .AIR file.")
    name = os.path.splitext(os.path.basename(path))[0]
    if isinstance(root, dict) and "archaiRevit" in root:
        levels = {l.get("id"): l.get("name", "") for l in root.get("levels", [])}
        objects = []
        for mesh in root.get("meshes", []):
            origin = mesh.get("origin")
            if not mesh.get("glb") or not origin or len(origin) < 3:
                continue
            ox, oy, oz = origin[0], origin[1], origin[2]
            item = ImportObject(mesh.get("name") or mesh.get("category") or "Mesh", levels.get(mesh.get("level"), ""), mesh.get("category", ""))
            for read in read_glb(base64.b64decode(mesh["glb"])):
                for part in read.parts:
                    p = part.positions
                    world = []
                    for i in range(0, len(p) - 2, 3):
                        world += ((p[i] + ox) / 1000.0, (p[i + 1] + oz) / 1000.0, (p[i + 2] + oy) / 1000.0)
                    idx = part.indices
                    flipped = []
                    for i in range(0, len(idx) - 2, 3):
                        flipped += (idx[i], idx[i + 2], idx[i + 1])
                    item.parts.append(ImportPart(part.material, world, flipped))
            if item.parts:
                objects.append(item)
        return root.get("name") or name, objects
    if not isinstance(root, dict) or "schemaVersion" not in root:
        raise ValueError(os.path.basename(path) + " is not an ArchAI .AIR file.")
    name = ((root.get("meta") or {}).get("name") or name)
    snapshot = root.get("scene3d") or {}
    if not isinstance(snapshot.get("data"), str):
        raise ValueError(NO_SNAPSHOT)
    return name, read_glb(base64.b64decode(snapshot["data"]))


def by_level(objects):
    """[(level name, [objects])] lowest level first, objects without a level last."""
    groups = {}
    for o in objects:
        groups.setdefault(o.level or "", []).append(o)

    def lowest(item):
        heights = [p.positions[i] for o in item[1] for p in o.parts for i in range(1, len(p.positions), 3)]
        return (1 if item[0] == "" else 0, min(heights) if heights else 0)
    return sorted(groups.items(), key=lowest)


# ---- VR tours -------------------------------------------------------------------------------

class VrStop:
    def __init__(self, name, x, z, floor, look_x, look_z):
        self.id = ""
        self.name = _truncate((name or "View").strip() or "View", 120)
        self.x, self.z, self.floor, self.look_x, self.look_z = x, z, floor, look_x, look_z


def camera_stop(name, eye_mm, direction, floor_mm=None):
    """A stop at a camera: eye in ArchAI mm (x, plan y, elevation), direction (dx, dplan_y, _)."""
    x, z = eye_mm[0] / 1000.0, eye_mm[1] / 1000.0
    dx, dz = direction[0], direction[1]
    length = math.hypot(dx, dz)
    if length < 1e-9:
        dx, dz, length = 1.0, 0.0, 1.0
    floor = floor_mm / 1000.0 if floor_mm is not None else eye_mm[2] / 1000.0 - EYE_HEIGHT
    return VrStop(name, x, z, floor, x + dx / length * LOOK_DISTANCE, z + dz / length * LOOK_DISTANCE)


def outside_stop(bounds, ground_mm=None):
    cx, cz = (bounds.min[0] + bounds.max[0]) / 2000.0, (bounds.min[1] + bounds.max[1]) / 2000.0
    back = max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) / 2000.0 + 5
    floor = (ground_mm if ground_mm is not None else bounds.min[2]) / 1000.0
    return VrStop("Outside", cx, cz + back, floor, cx, cz)


def vr_model(objects, bounds, ground_mm=None, generator="ArchAI plugin"):
    """GlbWriter of the VR model: a node per object in glTF metres, plus a ground disc."""
    writer = GlbWriter()
    for o in objects:
        parts = [p for p in o.parts.values() if p.indices]
        if not parts:
            continue
        writer.begin_node(o.name)
        for p in parts:
            pos = p.positions
            gltf = []
            for i in range(0, len(pos) - 2, 3):
                gltf += (pos[i] / 1000.0, pos[i + 2] / 1000.0, pos[i + 1] / 1000.0)
            writer.add(p.material, gltf, p.indices)
    if not bounds.empty:
        cx, cz = (bounds.min[0] + bounds.max[0]) / 2000.0, (bounds.min[1] + bounds.max[1]) / 2000.0
        radius = max(max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) / 2000.0 * 4, 60)
        y = (ground_mm if ground_mm is not None else bounds.min[2]) / 1000.0 - 0.025
        positions, indices = [cx, y, cz], []
        for i in range(64):
            a = 2 * math.pi * i / 64
            positions += (cx + math.cos(a) * radius, y, cz + math.sin(a) * radius)
            indices += (0, 1 + (i + 1) % 64, 1 + i)
        writer.begin_node("Ground")
        writer.add(Material("Ground", 0xd9 / 255.0, 0xdb / 255.0, 0xd5 / 255.0, roughness=1), positions, indices)
    return writer


def tour_json(name, credit, stops, start=None):
    for i, s in enumerate(stops):
        s.id = "s%d" % (i + 1)
    r = lambda v: round(v, 3)
    return {
        "format": "archai-vr", "version": 1, "name": _truncate(name or "Model", 120),
        # A new model URL each time: the share service lets browsers cache models for a day.
        "model": "model.glb?v=" + datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S"),
        "lighting": "live", "exposure": 1.1, "credit": credit,
        "start": (start if start in stops else stops[0]).id,
        "spaces": [{"id": s.id, "name": s.name, "center": [r(s.x), r(s.z)], "look": [r(s.look_x), r(s.look_z)], "floor": r(s.floor)} for s in stops],
    }


def build_tour(name, app, objects, cameras, start_camera=None, ground_mm=None):
    """(glb bytes, tour dict, triangles, stops); glb is b"" when there is nothing to show."""
    bounds = Bounds.of(objects)
    writer = vr_model(objects, bounds, ground_mm, "ArchAI %s plugin" % app)
    if bounds.empty:
        return b"", {}, 0, 0
    stops = list(cameras)[:MAX_STOPS] or [outside_stop(bounds, ground_mm)]
    start = next((s for s in stops if s.name == start_camera), None)
    return writer.to_glb("ArchAI %s plugin" % app), tour_json(name, app + " model via ArchAI", stops, start), writer.triangle_count, len(stops)


# ---- the share service: account ---------------------------------------------------------

def share_config(app=""):
    """(url, token): the share service and the ArchAI account to publish with, or None.

    Publishing needs an account: the plugin asks the ArchAI desktop app for the signed-in session
    over the live link (GET /live/account, see electron/liveLink.ts). When nobody is signed in,
    ArchAI comes to the front with its sign-in dialog; when it is not running it is started.
    NO_KEY then says what to do. ARCHAI_VR_SHARE_URL overrides the service."""
    global NO_KEY
    url = (os.environ.get("ARCHAI_VR_SHARE_URL", "").strip() or DEFAULT_SHARE_URL).rstrip("/")
    port = os.environ.get("ARCHAI_LIVE_PORT", "")
    base = "http://127.0.0.1:%d" % (int(port) if port.isdigit() else LIVE_PORT)
    request = urllib.request.Request(base + "/live/account?prompt=1&app=" + urllib.parse.quote(app),
                                     headers={"X-ArchAI-Live": "1"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            account = json.loads(response.read().decode("utf-8"))
        token = str(account.get("token") or "")
        if account.get("signedIn") and token:
            return (url, token)
        NO_KEY = ("Open in VR publishes with your ArchAI account. Sign in in ArchAI (it is asking now), "
                  "then run Open in VR again.")
    except Exception:
        exe = installed_archai()
        try:
            if exe:
                os.startfile(exe)  # noqa: S606 - the user's own ArchAI
        except Exception:
            exe = None
        NO_KEY = ("Open in VR publishes with your ArchAI account. ArchAI is starting: sign in there (top right), "
                  "then run Open in VR again." if exe else
                  "Open in VR publishes with your ArchAI account: install and start the ArchAI desktop app, "
                  "sign in (top right), then run Open in VR again.")
    return None


# ---- progress ----------------------------------------------------------------------------

def megabytes(size):
    """`4.2 MB` for status lines."""
    return "%.1f MB" % (size / 1048576.0) if size >= 1048576 else "%d KB" % max(1, size // 1024)


def scaled(progress, start, end):
    """A progress(text, fraction) whose 0..1 lands in [start, end] of `progress`."""
    if progress is None:
        return None
    return lambda text, fraction=None: progress(text, None if fraction is None else start + (end - start) * fraction)


def step(progress, index, count, text):
    """Item `index` of `count` done (at most ~50 reports per run)."""
    if progress is None or count <= 0:
        return
    stride = max(1, count // 50)
    if index % stride == 0 or index == count - 1:
        progress(text, float(index) / count)


def _send(url, method, body, headers, sent=None, timeout=600):
    """An HTTP(S) request whose body is written in chunks; `sent(done, total)` follows it.
    Returns (status, headers dict, body bytes)."""
    import http.client
    parts = urllib.parse.urlsplit(url)
    connection_type = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(parts.hostname, parts.port, timeout=timeout)
    try:
        target = parts.path + ("?" + parts.query if parts.query else "")
        connection.putrequest(method, target)
        for name, value in headers.items():
            connection.putheader(name, value)
        connection.putheader("Content-Length", str(len(body)))
        connection.endheaders()
        chunk = 64 * 1024
        for offset in range(0, len(body), chunk):
            connection.send(body[offset:offset + chunk])
            if sent:
                sent(min(len(body), offset + chunk), len(body))
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


class DelayedProgress(object):
    """Shows a task's progress only when it lasts longer than `delay` seconds (live-link syncs:
    the usual quick ones never pop anything). `begin(text)`, `update(text, fraction)` and
    `end()` are the host's own progress UI and are called through `on_main`; `report` and
    `finished` may be called from any thread."""

    def __init__(self, begin, update, end, on_main, delay=1.0):
        import threading
        self._begin, self._update, self._end, self._on_main = begin, update, end, on_main
        self._delay = delay
        self._lock = threading.Lock()
        self._timer = None
        self._active = False
        self._shown = False
        self._last = ("", None)

    def report(self, text, fraction=None):
        import threading
        with self._lock:
            self._last = (text, fraction)
            if not self._active:
                self._active = True
                self._timer = threading.Timer(self._delay, self._show)
                self._timer.daemon = True
                self._timer.start()
            shown = self._shown
        if shown:
            self._on_main(lambda: self._update(text, fraction))

    def _show(self):
        with self._lock:
            if not self._active or self._shown:
                return
            self._shown = True
            text, fraction = self._last

        def begin():
            self._begin(text)
            self._update(text, fraction)
        self._on_main(begin)

    def finished(self):
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            was_shown = self._shown
            self._active = self._shown = False
        if was_shown:
            self._on_main(self._end)


# ---- the share service ----------------------------------------------------------------------

def _call(config, method, path, body, content_type, progress=None):
    url, token = config
    if progress is not None:
        status, _, data = _send(url + path, method, body, {"Authorization": "Bearer " + token, "Content-Type": content_type, "User-Agent": "ArchAI-plugin/" + VERSION},
                                sent=lambda done, total: progress("Uploading %s of %s" % (megabytes(done), megabytes(total)), float(done) / total))
        if status < 200 or status >= 300:
            raise RuntimeError("VR share service: %d %s" % (status, data.decode("utf-8", "replace")))
        return data.decode("utf-8")
    request = urllib.request.Request(url + path, data=body, method=method,
                                     headers={"Authorization": "Bearer " + token, "Content-Type": content_type, "User-Agent": "ArchAI-plugin/" + VERSION})
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise RuntimeError("VR share service: %d %s" % (error.code, detail or error.reason))


def upload_tour(config, previous_id, model, tour, progress=None):
    """`progress(text, fraction)` follows the model upload."""
    if len(model) > MAX_MODEL_BYTES:
        raise RuntimeError("The model is %d MB; the VR share service takes up to 95 MB. Hide what you do not need to see and try again." % (len(model) // 1048576))
    reserved = _call(config, "POST", "/tours", json.dumps({"id": previous_id} if previous_id else {}).encode("utf-8"), "application/json")
    tour_id = json.loads(reserved).get("id", "")
    if not re.match(r"^[a-z0-9]{4,16}$", tour_id or ""):
        raise RuntimeError("VR share service returned an invalid tour id")
    # The model first: the tour file is what makes the link show the new version.
    _call(config, "PUT", "/tours/%s/model.glb" % tour_id, model, "model/gltf-binary", progress)
    _call(config, "PUT", "/tours/%s/tour.json" % tour_id, json.dumps(tour, separators=(",", ":")).encode("utf-8"), "application/json")
    return tour_id, "%s/v/%s" % (config[0], tour_id)


def _links_file():
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "ArchAI", "vr-links.json")


def _links():
    try:
        with open(_links_file(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def publish(config, document_key, model, tour, progress=None):
    """Uploads, reusing the link this document had; returns the short link. `progress(text,
    fraction)` follows the upload."""
    links = _links()
    tour_id, link = upload_tour(config, links.get(document_key), model, tour, progress)
    links[document_key] = tour_id
    try:
        os.makedirs(os.path.dirname(_links_file()), exist_ok=True)
        with open(_links_file(), "w", encoding="utf-8") as f:
            json.dump(links, f, indent=2)
    except Exception:
        pass
    return link


def open_in_browser(url):
    try:
        webbrowser.open(url)
    except Exception:
        pass


def vr_message(name, triangles, stops, link):
    heavy = ("\n\n%s triangles is a lot for a standalone headset; hide detail you do not need and publish again." % format(triangles, ",")) if triangles > 1000000 else ""
    return ("%s is online with %d stop%s (%s triangles).\n\nOn the headset, open this link in the browser and press Enter VR:\n%s\n\n"
            "Publishing this model again updates the same link.%s") % (name, stops, "" if stops == 1 else "s", format(triangles, ","), link, heavy)


# ---- live link -------------------------------------------------------------------------------

LIVE_PORT = 47821


def installed_archai():
    """ArchAI.exe in its usual install folders (ARCHAI_EXE overrides), or None."""
    candidates = [os.environ.get("ARCHAI_EXE", "")]
    if os.name == "nt":
        candidates += [os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "ArchAI", "ArchAI.exe"),
                       os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "ArchAI", "ArchAI.exe")]
    return next((path for path in candidates if path and os.path.isfile(path)), None)


def _protocol_registered():
    """Whether Windows knows the archai:// link (ArchAI installed somewhere else)."""
    try:
        import winreg
        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, "archai"))
        return True
    except OSError:
        return False


class LiveLink(object):
    """Live link with the ArchAI desktop app (electron/liveLink.ts in ArchAI; the Python twin of
    Archai.Plugins.LiveLink). While running, the host's model goes to the open ArchAI project a
    moment after each change, and ArchAI's model comes back when it changes there.

    The host gives:
    - export(): its model as an exchange dict (write_exchange), called on the host's main thread;
    - import_(name, objects): replace the ArchAI layer / collection with these ImportObjects
      (world glTF metres), main thread;
    - on_main(fn): run fn on the host's main thread soon (a timer, a slate tick...);
    - status(text): optional, any thread;
    - progress(text, fraction) and finished(): optional, any thread: the phases of a sync (reading,
      sending, ArchAI updating, receiving, building) and its end; DelayedProgress shows them only
      for slow syncs.
    The host calls changed() from its change events; ignore events while `importing` is true or
    for a moment after an import (`quiet()`), they are ArchAI's own model arriving.
    Networking runs on a background thread; the host API is only touched through on_main.
    """

    DEBOUNCE = 1.5
    POLL = 2.0

    def __init__(self, key, app, name, export, import_, on_main, status=None, progress=None, finished=None):
        import threading
        self._progress = progress
        self._finished = finished
        self.key = key[:300]
        self.app = app
        self.name = name
        self._export = export
        self._import = import_
        self._on_main = on_main
        self._status = status
        self.running = False
        self.importing = False
        self.last_status = "Off"
        self._quiet_until = 0.0
        self._push_at = None
        self._last_pulled = -1
        self._last_seen = -1
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._thread = None
        port = os.environ.get("ARCHAI_LIVE_PORT", "")
        self._base = "http://127.0.0.1:%d" % (int(port) if port.isdigit() else LIVE_PORT)

    # -- host side --

    def start(self):
        import threading
        if self.running:
            return
        self.running = True
        self._last_pulled = -1
        self._push_at = 0.0
        self._report("Connecting to ArchAI...")
        self._thread = threading.Thread(target=self._loop, name="ArchAI live link", daemon=True)
        self._thread.start()

    def stop(self):
        if not self.running:
            return
        self.running = False
        self._wake.set()
        try:
            self._request("POST", "/live/stop", json.dumps({"key": self.key}).encode("utf-8"), timeout=3)
        except Exception:
            pass
        self._report("Off")

    def quiet(self):
        """True for a moment after an import: host change events are ArchAI's model arriving."""
        import time
        return self.importing or time.time() < self._quiet_until

    def changed(self):
        import time
        if not self.running or self.quiet():
            return
        with self._lock:
            self._push_at = time.time() + self.DEBOUNCE
        self._wake.set()

    # -- background thread --

    def _report(self, text):
        self.last_status = text
        if self._status:
            try:
                self._status(text)
            except Exception:
                pass

    _launched_at = 0.0
    _launched = False

    def _launch(self, query):
        """Starts the ArchAI desktop app through its archai:// link (registered by its installer),
        at most once a minute; False when the link cannot be opened (ArchAI is not installed)."""
        import time
        if time.time() - self._launched_at < 60:
            return self._launched
        self._launched_at = time.time()
        url = "archai://live?" + query
        try:
            exe = installed_archai()
            if exe:
                import subprocess
                subprocess.Popen([exe], close_fds=True)
            elif os.name == "nt" and _protocol_registered():
                os.startfile(url)  # noqa: S606 - the user's own ArchAI
            elif os.name != "nt":
                import subprocess
                subprocess.Popen(["open" if _sys.platform == "darwin" else "xdg-open", url])
            else:
                self._launched = False
                return False
            self._launched = True
        except Exception:  # noqa: BLE001
            self._launched = False
        return self._launched

    def _request(self, method, path, body=None, timeout=180):
        request = urllib.request.Request(self._base + path, data=body, method=method,
                                         headers={"X-ArchAI-Live": "1", "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers), response.read()

    def _phase(self, text, fraction):
        if self._progress:
            self._progress(text, fraction)

    def _pull(self, path):
        """GET with the download's progress (status, headers, bytes)."""
        request = urllib.request.Request(self._base + path, headers={"X-ArchAI-Live": "1"})
        with urllib.request.urlopen(request, timeout=180) as response:
            total = int(response.headers.get("Content-Length") or 0)
            chunks = []
            done = 0
            while True:
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
                done += len(chunk)
                if total:
                    self._phase("Receiving %s of %s" % (megabytes(done), megabytes(total)), 0.1 + 0.5 * done / total)
            return response.status, dict(response.headers), b"".join(chunks)

    def _main(self, fn):
        """Runs fn on the host's main thread and waits for its result."""
        import threading
        done = threading.Event()
        box = {}

        def run():
            try:
                box["value"] = fn()
            except Exception as error:  # noqa: BLE001 - reported to the user
                box["error"] = error
            finally:
                done.set()
        self._on_main(run)
        while self.running and not done.wait(0.25):
            pass
        if "error" in box:
            raise box["error"]
        return box.get("value")

    def _loop(self):
        import time
        while self.running:
            self._wake.wait(self.POLL)
            self._wake.clear()
            if not self.running:
                break
            with self._lock:
                due = self._push_at is not None and time.time() >= self._push_at
                waiting = self._push_at is not None and not due
            if waiting:
                # Wake up again when the debounce is over.
                time.sleep(min(self.DEBOUNCE, max(0.05, self._push_at - time.time())))
                self._wake.set()
                continue
            try:
                self._tick(due)
            except urllib.error.HTTPError as error:
                try:
                    message = json.loads(error.read().decode("utf-8")).get("error") or str(error)
                except Exception:
                    message = str(error)
                self._report("Live link: " + message)
            except Exception as error:  # noqa: BLE001
                self._report("Live link: %s" % error)
            finally:
                if self._finished:
                    self._finished()

    def _tick(self, push):
        import time
        query = "key=%s&name=%s&app=%s" % (urllib.request.quote(self.key, safe=""), urllib.request.quote(self.name, safe=""), urllib.request.quote(self.app, safe=""))
        try:
            _, _, body = self._request("GET", "/live/status?" + query, timeout=5)
            status = json.loads(body.decode("utf-8"))
        except (urllib.error.URLError, ConnectionError, OSError):
            self._report("Starting ArchAI..." if self._launch(query) else "Install and start the ArchAI desktop app to sync")
            return
        document = status.get("document")
        if not document:
            # ArchAI opens a project for this model on its own (the one linked before, or a new one).
            self._report("Opening a project in ArchAI...")
            return
        project = document.get("name") or "ArchAI"
        up_to_date = self._last_seen == self._last_pulled and self._last_pulled >= 0
        if push:
            with self._lock:
                self._push_at = None
            self._phase("Reading the %s model" % self.app, None)
            exchange = self._main(self._export)
            if exchange is not None:
                exchange["app"] = self.app
                payload = json.dumps({"key": self.key, "app": self.app, "name": self.name, "model": exchange}, separators=(",", ":")).encode("utf-8")

                def sent(done, total):
                    if done < total:
                        self._phase("Sending %s of %s to ArchAI" % (megabytes(done), megabytes(total)), 0.1 + 0.6 * done / total)
                    else:
                        self._phase("ArchAI is updating the project", 0.75)
                code, _, body = _send(self._base + "/live/push", "POST", payload, {"X-ArchAI-Live": "1", "Content-Type": "application/json"}, sent=sent, timeout=180)
                if code >= 400:
                    raise RuntimeError(json.loads(body.decode("utf-8") or "{}").get("error") or "ArchAI could not take the model (%d)" % code)
                revision = json.loads(body.decode("utf-8")).get("revision", 0)
                if up_to_date:
                    self._last_pulled = revision
                self._last_seen = revision
                self._report("Sent to %s %s" % (project, time.strftime("%H:%M:%S")))
            return
        revision = status.get("revision", 0)
        self._last_seen = revision
        if revision == self._last_pulled:
            return
        self._phase("ArchAI is preparing its model", None)
        code, headers, data = self._pull("/live/pull?key=" + urllib.request.quote(self.key))
        if code == 204 or not data:
            return
        lower = {k.lower(): v for k, v in headers.items()}
        pulled = int(lower.get("x-archai-revision", revision) or revision)
        name = urllib.request.unquote(lower.get("x-archai-name", project))
        objects = read_glb(data)
        self._phase("Building %d objects in %s" % (len(objects), self.app), 0.65)

        def apply():
            self.importing = True
            try:
                self._import(name, objects)
            finally:
                self.importing = False
                self._quiet_until = time.time() + 2.0
        self._main(apply)
        self._last_pulled = self._last_seen = pulled
        self._report("Updated from %s %s" % (project, time.strftime("%H:%M:%S")))
