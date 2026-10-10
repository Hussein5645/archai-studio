"""The current level as ArchAI objects, and .AIR files imported into it.

Axes: Unreal is left-handed with Z up, so ArchAI's plan (x right, y down) maps to Unreal (X, Y)
directly: ArchAI (x, plan y, elevation) mm = Unreal (X, Y, Z) cm x 10. The reflection against a
right-handed host flips triangle winding, which is reversed on the way out and back in.
"""
import os
import re
import tempfile

import unreal

from . import archai_core as core

_actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)


def _colour_of(material, cache):
    if material is None:
        return core.DEFAULT_MATERIAL
    name = material.get_name()
    if name in cache:
        return cache[name]
    colour = None
    if isinstance(material, unreal.MaterialInstance):
        for parameter in ("BaseColor", "Base Color", "Color", "Albedo", "Tint", "DiffuseColor"):
            try:
                value = unreal.MaterialEditingLibrary.get_material_instance_vector_parameter_value(material, parameter)
                if value is not None and (value.r or value.g or value.b):
                    colour = (core.srgb(value.r), core.srgb(value.g), core.srgb(value.b))
                    break
            except Exception:  # noqa: BLE001
                pass
    if colour is None:
        colour = (0.78, 0.79, 0.81)
    cache[name] = core.Material(name, colour[0], colour[1], colour[2])
    return cache[name]


def _add_static_mesh(item, mesh, transforms, materials_of, cache):
    for lod_section in range(mesh.get_num_sections(0)):
        vertices, triangles, _normals, _uvs, _tangents = unreal.ProceduralMeshLibrary.get_section_from_static_mesh(mesh, 0, lod_section)
        if not triangles:
            continue
        flipped = []
        for i in range(0, len(triangles) - 2, 3):
            flipped += (triangles[i], triangles[i + 2], triangles[i + 1])
        material = _colour_of(materials_of(lod_section), cache)
        for transform in transforms:
            positions = []
            for v in vertices:
                w = transform.transform_location(v)
                positions += (w.x * 10.0, w.y * 10.0, w.z * 10.0)
            item.add_mesh(material, positions, flipped)


LIVE_TAG = "ArchAILive"


def is_live(actor):
    """Actors the Live Bridge brought in from ArchAI (never sent back)."""
    try:
        return any(str(tag) == LIVE_TAG for tag in actor.tags)
    except Exception:  # noqa: BLE001
        return False


class Progress:
    """Unreal's progress dialog (ScopedSlowTask, kept open across calls). `update(text,
    fraction)` works as a core progress callback; game thread only."""

    def __init__(self, title):
        self.title = title
        self.task = None
        self.done = 0.0

    def begin(self, text=""):
        if self.task is None:
            self.task = unreal.ScopedSlowTask(100.0, "ArchAI " + self.title)
            self.task.__enter__()
            self.task.make_dialog(False)
            self.done = 0.0
        self.update(text, None)

    def update(self, text, fraction=None):
        if self.task is None:
            self.begin(text)
        amount = 0.0
        if fraction is not None:
            target = max(0.0, min(1.0, fraction)) * 100.0
            amount = max(0.0, target - self.done)
            self.done += amount
        self.task.enter_progress_frame(amount, "ArchAI %s: %s" % (self.title, text))

    def end(self):
        if self.task is not None:
            self.task.__exit__(None, None, None)
            self.task = None


def collect(skip_live=False, progress=None):
    """Static meshes (and instanced static meshes) of the level's visible actors."""
    objects, cache = [], {}
    actors = list(_actors.get_all_level_actors())
    for index, actor in enumerate(actors):
        core.step(progress, index, len(actors), "Reading actor %d of %d" % (index + 1, len(actors)))
        if actor.is_hidden_ed() or actor.is_temporarily_hidden_in_editor():
            continue
        if skip_live and is_live(actor):
            continue
        item = core.SceneObject(actor.get_name()[:64], actor.get_actor_label(), str(actor.get_folder_path()))
        # Live Bridge: an editable copy of an ArchAI element.
        item.archai = _tag(actor, "archai_copy:")
        for component in actor.get_components_by_class(unreal.StaticMeshComponent):
            mesh = component.static_mesh
            if mesh is None or not component.is_visible():
                continue
            if isinstance(component, unreal.InstancedStaticMeshComponent):
                transforms = [component.get_instance_transform(i, True) for i in range(component.get_instance_count())]
            else:
                transforms = [component.get_world_transform()]
            try:
                _add_static_mesh(item, mesh, transforms, component.get_material, cache)
            except Exception as error:  # noqa: BLE001 - e.g. a mesh without CPU access in a cooked build
                unreal.log_warning("ArchAI: %s skipped: %s" % (actor.get_actor_label(), error))
        if item.triangle_count:
            objects.append(item)
    return objects


def cameras():
    stops = []
    for actor in _actors.get_all_level_actors():
        if not isinstance(actor, unreal.CameraActor) or actor.is_hidden_ed():
            continue
        eye = actor.get_actor_location()
        forward = actor.get_actor_forward_vector()
        stops.append(core.camera_stop(actor.get_actor_label(), (eye.x * 10.0, eye.y * 10.0, eye.z * 10.0), (forward.x, forward.y, forward.z)))
    return sorted(stops, key=lambda s: s.name)


def level_name():
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    return world.get_name() if world else "Unreal level"


def document_key():
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    return "unreal|" + (world.get_path_name() if world else level_name())


def send(path, progress=None):
    objects = collect(progress=core.scaled(progress, 0.0, 0.9))
    if progress:
        progress("Writing the .AIR file", 0.95)
    exchange = core.write_exchange(level_name(), "Unreal", unreal.SystemLibrary.get_engine_version(), document_key()[7:], objects)
    if not exchange["meshes"]:
        raise ValueError("There are no visible static meshes in the level to send.")
    core.save_exchange(path, exchange)
    return len(exchange["meshes"])


# ---- import ---------------------------------------------------------------------------------

_mapping = None


def _import_glb(path, destination):
    task = unreal.AssetImportTask()
    task.filename = path
    task.destination_path = destination
    task.automated = True
    task.replace_existing = True
    task.save = False
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    return [unreal.load_asset(p) for p in task.imported_object_paths]


def _importer_mapping():
    """How the glTF importer maps glTF metres to Unreal centimetres, measured once with a probe
    triangle (importers differ between engine versions): a 3x3 matrix M with ue = M . gltf."""
    global _mapping
    if _mapping is not None:
        return _mapping
    writer = core.GlbWriter()
    writer.begin_node("ArchAIProbe")
    writer.add(core.DEFAULT_MATERIAL, [1, 0, 0, 0, 2, 0, 0, 0, 3], [0, 1, 2])
    probe = os.path.join(tempfile.gettempdir(), "ArchAIProbe.glb")
    with open(probe, "wb") as f:
        f.write(writer.to_glb())
    assets = _import_glb(probe, "/Game/ArchAI/_Probe")
    mesh = next((a for a in assets if isinstance(a, unreal.StaticMesh)), None)
    if mesh is None:
        raise RuntimeError("Unreal's glTF importer is not available. Enable the glTF Importer (or Interchange) plugin.")
    vertices = unreal.ProceduralMeshLibrary.get_section_from_static_mesh(mesh, 0, 0)[0]
    # Each probe vertex lies on one glTF axis, so each gives one column of M.
    columns = [None, None, None]
    for v in vertices:
        for axis, length in enumerate((1.0, 2.0, 3.0)):
            values = (v.x, v.y, v.z)
            if max(abs(c) for c in values) > 1e-6 and abs(max(abs(c) for c in values) / 100.0 - length) < 1e-3:
                columns[axis] = [c / length for c in values]
    unreal.EditorAssetLibrary.delete_directory("/Game/ArchAI/_Probe")
    if None in columns:
        raise RuntimeError("Unreal's glTF importer moved the probe mesh; ArchAI cannot place imports exactly.")
    _mapping = [[columns[c][r] for c in range(3)] for r in range(3)]
    return _mapping


def _safe(name):
    return re.sub(r"[^A-Za-z0-9_]+", "_", name).strip("_")[:60] or "ArchAI"


def import_air(path):
    """Imports an .AIR file: static meshes under /Game/ArchAI/<name>/<level>, placed in the level
    in folders ArchAI/<name>/<level>. Returns (name, count)."""
    name, objects = core.read_air(path)
    return name, import_objects(name, objects, os.path.basename(path))


LIVE_ASSETS = "/Game/ArchAI/Live"


def clear_live():
    """Removes what the Live Bridge brought in: its actors and their meshes."""
    for actor in _actors.get_all_level_actors():
        if is_live(actor):
            _actors.destroy_actor(actor)
    if unreal.EditorAssetLibrary.does_directory_exist(LIVE_ASSETS):
        unreal.EditorAssetLibrary.delete_directory(LIVE_ASSETS)


def signature():
    """A cheap fingerprint of the level's own static mesh actors, to notice edits (the Live Bridge polls it)."""
    parts = []
    for actor in _actors.get_all_level_actors():
        if is_live(actor) or not actor.get_components_by_class(unreal.StaticMeshComponent):
            continue
        t = actor.get_actor_transform()
        parts.append((actor.get_name(), str(t.translation), str(t.rotation), str(t.scale3d), actor.is_hidden_ed()))
    return hash(tuple(sorted(parts)))


def live_exchange():
    """The level for the Live Bridge (without what ArchAI sent)."""
    return core.write_exchange(level_name(), "Unreal", unreal.SystemLibrary.get_engine_version(), level_name(), collect(skip_live=True))


def import_objects(name, objects, label=None, live=False):
    m = _importer_mapping()
    # The glTF to write so the importer's mapping M lands each point where ArchAI wants it:
    # ue_target = (x, plan y, elevation) cm = M . g  =>  g = M^-1 . ue_target (M is orthogonal: M^-1 = M^T).
    inverse = [[m[c][r] for c in range(3)] for r in range(3)]
    flip = _determinant(m) > 0  # importer keeps winding only when it already mirrors right- to left-handed
    count = 0
    with unreal.ScopedSlowTask(len(objects), ("Updating from " + name) if live else "Opening " + (label or name)) as progress:
        progress.make_dialog(True)
        for level, items in core.by_level(objects):
            writer = core.GlbWriter()
            for item in items:
                writer.begin_node(_safe(item.name))
                for part in item.parts:
                    p = part.positions
                    positions = []
                    for i in range(0, len(p) - 2, 3):
                        # glTF metres (x, up, plan y) -> Unreal target cm (x, plan y, up).
                        t = (p[i] * 100.0, p[i + 2] * 100.0, p[i + 1] * 100.0)
                        positions += [(inverse[r][0] * t[0] + inverse[r][1] * t[1] + inverse[r][2] * t[2]) / 100.0 for r in range(3)]
                    idx = list(part.indices)
                    if flip:
                        for i in range(0, len(idx) - 2, 3):
                            idx[i + 1], idx[i + 2] = idx[i + 2], idx[i + 1]
                    writer.add(part.material, positions, idx)
                progress.enter_progress_frame(1)
            glb = os.path.join(tempfile.gettempdir(), "ArchAI_%s.glb" % _safe(level or name))
            with open(glb, "wb") as f:
                f.write(writer.to_glb())
            if live:
                folder = "ArchAI Live/%s" % (_safe(level) if level else "Model")
                destination = "%s/%s" % (LIVE_ASSETS, _safe(level) if level else "Model")
            else:
                folder = "ArchAI/%s/%s" % (_safe(name), _safe(level) if level else "Model")
                destination = "/Game/ArchAI/%s/%s" % (_safe(name), _safe(level) if level else "Model")
            for asset in _import_glb(glb, destination):
                if not isinstance(asset, unreal.StaticMesh):
                    continue
                actor = _actors.spawn_actor_from_object(asset, unreal.Vector(0, 0, 0), unreal.Rotator(0, 0, 0))
                if actor:
                    actor.set_actor_label(asset.get_name())
                    actor.set_folder_path(folder)
                    if live:
                        actor.set_editor_property("tags", [unreal.Name(LIVE_TAG)])
                    count += 1
    return count


# ---- Live Bridge ----------------------------------------------------------------------------

COPIES_ASSETS = "/Game/ArchAI/Copies"


def _tag(actor, prefix):
    try:
        for tag in actor.tags:
            text = str(tag)
            if text.startswith(prefix):
                return text[len(prefix):]
    except Exception:  # noqa: BLE001
        pass
    return None


def all_ids():
    """Names of every static mesh actor that could be sent (hidden ones too), not what ArchAI sent."""
    return [actor.get_name()[:64] for actor in _actors.get_all_level_actors()
            if not is_live(actor) and actor.get_components_by_class(unreal.StaticMeshComponent)]


def _asset_name(archai_id):
    return "AI_" + _safe(archai_id)


def _import_elements(items, destination):
    """One glTF for these ArchAI elements, one node (so one static mesh asset) per element, named
    after its id; returns {element id: static mesh}."""
    if not items:
        return {}
    m = _importer_mapping()
    inverse = [[m[c][r] for c in range(3)] for r in range(3)]
    flip = _determinant(m) > 0
    writer = core.GlbWriter()
    names = {}
    for item in items:
        name = _asset_name(item.archai.get("id", ""))
        names[name] = item.archai.get("id", "")
        writer.begin_node(name)
        for part in item.parts:
            p = part.positions
            positions = []
            for i in range(0, len(p) - 2, 3):
                t = (p[i] * 100.0, p[i + 2] * 100.0, p[i + 1] * 100.0)
                positions += [(inverse[r][0] * t[0] + inverse[r][1] * t[1] + inverse[r][2] * t[2]) / 100.0 for r in range(3)]
            idx = list(part.indices)
            if flip:
                for i in range(0, len(idx) - 2, 3):
                    idx[i + 1], idx[i + 2] = idx[i + 2], idx[i + 1]
            writer.add(part.material, positions, idx)
    glb = os.path.join(tempfile.gettempdir(), "ArchAI_bridge.glb")
    with open(glb, "wb") as f:
        f.write(writer.to_glb())
    meshes = {}
    for asset in _import_glb(glb, destination):
        if isinstance(asset, unreal.StaticMesh) and asset.get_name() in names:
            meshes[names[asset.get_name()]] = asset
    return meshes


def apply_delta(delta):
    """A Live Bridge pull, element by element: ArchAI's elements as actors in the ArchAI Live
    folder (tagged ArchAILive and archai:<id>; replaced or removed one by one), editable copies as
    ordinary actors in the ArchAI Copies folder (their mesh re-imported in place), and ArchAI's
    moves and names applied to the level's own actors."""
    if delta.fresh:
        clear_live()
    live, copies, own = {}, {}, {}
    for actor in _actors.get_all_level_actors():
        copy_of = _tag(actor, "archai_copy:")
        if copy_of:
            copies[copy_of] = actor
        elif is_live(actor) and _tag(actor, "archai:"):
            live.setdefault(_tag(actor, "archai:"), []).append(actor)
        own[actor.get_name()[:64]] = actor

    def remove(archai_id):
        for actor in live.pop(archai_id, []):
            _actors.destroy_actor(actor)
        path = "%s/%s" % (LIVE_ASSETS, _asset_name(archai_id))
        if unreal.EditorAssetLibrary.does_asset_exist(path):
            unreal.EditorAssetLibrary.delete_asset(path)
    for archai_id in delta.removed:
        remove(archai_id)
    for update in delta.updates:
        actor = own.get(update.get("ref"))
        if actor is None:
            continue
        move = update.get("move")
        if move:
            # ArchAI mm (x, plan y, elevation) -> Unreal cm (x, plan y, up).
            actor.add_actor_world_offset(unreal.Vector(move[0] / 10.0, move[1] / 10.0, move[2] / 10.0), False, False)
        if update.get("name"):
            actor.set_actor_label(update["name"])
    fresh_live, fresh_copies, reshaped = [], [], []
    for item in delta.nodes:
        archai_id = item.archai.get("id")
        target = own.get(item.archai.get("ref") or "") or copies.get(archai_id)
        if target is not None:
            reshaped.append(item)
            continue
        remove(archai_id)
        (fresh_copies if item.archai.get("editable") else fresh_live).append(item)
    # Copies keep their actor: re-importing their asset in place gives them ArchAI's shape.
    _import_elements(reshaped, COPIES_ASSETS)
    for archai_id, mesh in _import_elements(fresh_live, LIVE_ASSETS).items():
        actor = _actors.spawn_actor_from_object(mesh, unreal.Vector(0, 0, 0), unreal.Rotator(0, 0, 0))
        if actor:
            item = next(i for i in fresh_live if i.archai.get("id") == archai_id)
            actor.set_actor_label(item.name)
            actor.set_folder_path("ArchAI Live/%s" % (_safe(item.level) if item.level else "Model"))
            actor.set_editor_property("tags", [unreal.Name(LIVE_TAG), unreal.Name("archai:" + archai_id)])
    for archai_id, mesh in _import_elements(fresh_copies, COPIES_ASSETS).items():
        actor = _actors.spawn_actor_from_object(mesh, unreal.Vector(0, 0, 0), unreal.Rotator(0, 0, 0))
        if actor:
            item = next(i for i in fresh_copies if i.archai.get("id") == archai_id)
            actor.set_actor_label(item.name)
            actor.set_folder_path("ArchAI Copies")
            actor.set_editor_property("tags", [unreal.Name("archai_copy:" + archai_id)])


def _determinant(m):
    return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))


def prepare_tour(progress=None):
    name = level_name()
    objects = collect(progress=progress)
    if progress:
        progress("Building the VR model", None)
    glb, tour, triangles, stops = core.build_tour(name, "Unreal", objects, cameras())
    return glb, tour, triangles, stops, name, document_key()
