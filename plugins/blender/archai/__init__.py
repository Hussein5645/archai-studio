"""ArchAI in Blender: send the scene to ArchAI, keep it in sync with the ArchAI desktop app (live
link), open .AIR files, walk through the scene in VR.

The sidebar tab "ArchAI" (N panel of the 3D View) holds the actions; File > Import / Export
also offer ArchAI (.AIR). See docs/plugins.md in the ArchAI repository.
"""
bl_info = {
    "name": "ArchAI",
    "author": "ArchAI",
    "version": (0, 4, 1),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > ArchAI; File > Import/Export > ArchAI (.AIR)",
    "description": "Send models to ArchAI, open .AIR files and walk through the scene in VR",
    "category": "Import-Export",
    "doc_url": "https://archai-studio-six.vercel.app/download.html",
}

import os
import threading

import bpy
import bpy.utils.previews
from bpy.props import StringProperty
from bpy_extras.io_utils import ExportHelper, ImportHelper

from . import archai_core as core

_icons = None
_job = {"thread": None, "result": None, "error": None, "progress": None, "meter": None}
_live = {"link": None, "queue": [], "status": ""}
LIVE_COLLECTION = "ArchAI Live"
# Editable copies of ArchAI elements (Live Bridge): ordinary objects, sent back to ArchAI.
COPIES_COLLECTION = "ArchAI Copies"


def icon(name):
    return _icons[name].icon_id if _icons and name in _icons else 0


# ---- the scene as ArchAI objects ------------------------------------------------------------

def millimetres(scene):
    return 1000.0 * (scene.unit_settings.scale_length or 1.0)


def material_of(material, cache):
    if material is None:
        return core.DEFAULT_MATERIAL
    if material.name in cache:
        return cache[material.name]
    r, g, b, a = material.diffuse_color
    roughness, metalness = material.roughness, material.metallic
    if material.use_nodes and material.node_tree:
        bsdf = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf:
            r, g, b, _ = bsdf.inputs["Base Color"].default_value
            a = bsdf.inputs["Alpha"].default_value
            roughness = bsdf.inputs["Roughness"].default_value
            metalness = bsdf.inputs["Metallic"].default_value
    # Blender colours are linear; ArchAI materials are sRGB.
    cache[material.name] = core.Material(material.name, core.srgb(r), core.srgb(g), core.srgb(b), a, roughness, metalness)
    return cache[material.name]


def is_live(obj):
    """Objects the Live Bridge brought in from ArchAI (never sent back)."""
    return bool(obj.get("archai_live")) if obj is not None else False


GEOMETRY_TYPES = {"MESH", "CURVE", "SURFACE", "META", "FONT"}


def ensure_ids(scene):
    """Gives every object of the scene a stable Live Bridge id (custom property `archai_uid`, kept
    in the .blend file). A duplicated object carries its original's id: it gets a new one (it is
    the object whose session doesn't match the one recorded with the id)."""
    import uuid
    seen = {}
    for obj in sorted(scene.objects, key=lambda o: o.name):
        if obj.type not in GEOMETRY_TYPES and obj.type != "EMPTY":
            continue
        uid = obj.get("archai_uid")
        session = getattr(obj, "session_uid", 0)
        if uid and uid in seen:
            first = seen[uid]
            # Two objects with one id: the copy is the one created in this session after it.
            copy = obj if first.get("archai_uid_session") == getattr(first, "session_uid", 0) else first
            if copy is first:
                seen[uid] = obj
                obj["archai_uid_session"] = session
            copy["archai_uid"] = uuid.uuid4().hex[:16]
            copy["archai_uid_session"] = getattr(copy, "session_uid", 0)
            seen[copy["archai_uid"]] = copy
            continue
        if not uid:
            uid = obj["archai_uid"] = uuid.uuid4().hex[:16]
        if obj.get("archai_uid_session") != session:
            obj["archai_uid_session"] = session
        seen[uid] = obj
    return seen


def object_id(obj):
    return str(obj.get("archai_uid") or obj.name[:12])


class Progress:
    """Blender's own progress display: the counter on the mouse cursor (0-100) and the status bar
    text. `update(text, fraction)` works as a core progress callback; main thread only."""

    def __init__(self, title):
        self.title = title
        self.started = False

    def begin(self, text=""):
        if not self.started:
            try:
                bpy.context.window_manager.progress_begin(0, 100)
            except Exception:  # noqa: BLE001 - no window (background mode)
                pass
            self.started = True
        self._status(text, None)

    def update(self, text, fraction=None):
        if not self.started:
            self.begin(text)
        if fraction is not None:
            try:
                bpy.context.window_manager.progress_update(int(round(max(0.0, min(1.0, fraction)) * 100)))
            except Exception:  # noqa: BLE001
                pass
        self._status(text, fraction)

    def end(self):
        if self.started:
            try:
                bpy.context.window_manager.progress_end()
            except Exception:  # noqa: BLE001
                pass
        self.started = False
        try:
            bpy.context.workspace.status_text_set(None)
        except Exception:  # noqa: BLE001
            pass

    def _status(self, text, fraction):
        line = "ArchAI %s: %s" % (self.title, text) + ("" if fraction is None else "  (%d%%)" % int(round(fraction * 100)))
        try:
            bpy.context.workspace.status_text_set(line)
        except Exception:  # noqa: BLE001
            pass


def collect(context, skip_live=False, progress=None):
    """Visible objects (with their modifiers, instances and geometry nodes) as ArchAI objects.
    `progress(text, fraction)` follows the objects read."""
    import numpy as np
    depsgraph = context.evaluated_depsgraph_get()
    mm = millimetres(context.scene)
    objects, materials = {}, {}
    total = max(1, len(context.view_layer.objects))
    for index, instance in enumerate(depsgraph.object_instances):
        core.step(progress, min(index, total - 1), total, "Reading object %d" % (index + 1))
        source = instance.object
        if source.type not in {"MESH", "CURVE", "SURFACE", "META", "FONT"}:
            continue
        owner = instance.parent if instance.is_instance and instance.parent else source
        if not owner.original.visible_get():
            continue
        if skip_live and is_live(owner.original):
            continue
        try:
            mesh = source.to_mesh()
        except RuntimeError:
            continue
        if mesh is None:
            continue
        try:
            mesh.calc_loop_triangles()
            if not mesh.loop_triangles:
                continue
            item = objects.get(owner.name)
            if item is None:
                item = objects[owner.name] = core.SceneObject(object_id(owner.original), owner.name, owner.original.users_collection[0].name if owner.original.users_collection else "")
                # Live Bridge: an editable copy of an ArchAI element, and the id older plugins used.
                item.archai = owner.original.get("archai_copy_of") or None
                item.was = owner.name[:12]
            count = len(mesh.vertices)
            co = np.empty(count * 3, dtype=np.float32)
            mesh.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            matrix = np.array(instance.matrix_world, dtype=np.float64)
            world = co @ matrix[:3, :3].T + matrix[:3, 3]
            # Z-up right-handed metres (scene units) -> ArchAI millimetres (x, plan y, elevation).
            archai = np.empty_like(world)
            archai[:, 0], archai[:, 1], archai[:, 2] = world[:, 0] * mm, -world[:, 1] * mm, world[:, 2] * mm
            flat = archai.ravel().tolist()
            tris = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int32)
            mesh.loop_triangles.foreach_get("vertices", tris)
            slots = np.empty(len(mesh.loop_triangles), dtype=np.int32)
            mesh.loop_triangles.foreach_get("material_index", slots)
            tris = tris.reshape(-1, 3)
            for slot in np.unique(slots):
                material = mesh.materials[slot] if slot < len(mesh.materials) else None
                item.add_mesh(material_of(material, materials), flat, tris[slots == slot].ravel().tolist())
        finally:
            source.to_mesh_clear()
    return [o for o in objects.values() if o.triangle_count]


def cameras(context):
    from mathutils import Vector
    mm = millimetres(context.scene)
    stops = []
    for obj in sorted(context.scene.objects, key=lambda o: o.name):
        if obj.type != "CAMERA" or not obj.visible_get():
            continue
        eye = obj.matrix_world.translation
        forward = obj.matrix_world.to_3x3() @ Vector((0, 0, -1))
        stops.append(core.camera_stop(obj.name, core.from_z_up(eye.x, eye.y, eye.z, mm), core.from_z_up(forward.x, forward.y, forward.z, 1)))
    return stops


def import_air(context, path, progress=None):
    if progress:
        progress("Reading " + os.path.basename(path), None)
    name, objects = core.read_air(path)
    return import_objects(context, name, objects, progress=core.scaled(progress, 0.1, 1.0))


def clear_live(context):
    """Removes what the Live Bridge brought in: the ArchAI Live collection and its objects."""
    root = bpy.data.collections.get(LIVE_COLLECTION)
    if root is None:
        return
    for collection in [root] + list(root.children_recursive):
        for obj in list(collection.objects):
            mesh = obj.data if obj.type == "MESH" else None
            bpy.data.objects.remove(obj, do_unlink=True)
            if mesh is not None and mesh.users == 0:
                bpy.data.meshes.remove(mesh)
    for child in list(root.children_recursive):
        bpy.data.collections.remove(child)


def import_objects(context, name, objects, live=False, progress=None, collection_name=None, created=None):
    """Adds ArchAI objects: a mesh per element, a collection per level. `created` (a list) receives
    the new objects; `collection_name` puts them in that collection (kept across calls)."""
    mm = millimetres(context.scene)
    total = len(objects)
    if live or collection_name:
        title = collection_name or LIVE_COLLECTION
        root = bpy.data.collections.get(title) or bpy.data.collections.new(title)
        if root.name not in context.scene.collection.children:
            context.scene.collection.children.link(root)
    else:
        root = bpy.data.collections.new("ArchAI " + name)
        context.scene.collection.children.link(root)
    materials, count = {}, 0
    for level, items in core.by_level(objects):
        collection = root
        if level:
            collection = next((c for c in root.children if c.get("archai_level") == level), None)
            if collection is None:
                collection = bpy.data.collections.new(level)
                collection["archai_level"] = level
                root.children.link(collection)
        for item in items:
            core.step(progress, count, total, "Adding element %d of %d" % (count + 1, total))
            vertices, faces, slots, slot_names = [], [], [], []
            for part in item.parts:
                base = len(vertices)
                p = part.positions
                for i in range(0, len(p) - 2, 3):
                    vertices.append(core.to_z_up(p[i], p[i + 1], p[i + 2], mm))
                idx = part.indices
                if part.material.name not in slot_names:
                    slot_names.append(part.material.name)
                slot = slot_names.index(part.material.name)
                for i in range(0, len(idx) - 2, 3):
                    faces.append((base + idx[i], base + idx[i + 1], base + idx[i + 2]))
                    slots.append(slot)
                if part.material.name not in materials:
                    materials[part.material.name] = make_material(part.material)
            mesh = bpy.data.meshes.new(item.name)
            mesh.from_pydata(vertices, [], faces)
            for material_name in slot_names:
                mesh.materials.append(materials[material_name])
            mesh.polygons.foreach_set("material_index", slots)
            mesh.validate()
            mesh.update()
            obj = bpy.data.objects.new(item.name, mesh)
            if item.type:
                obj["archai_type"] = item.type
            if live:
                obj["archai_live"] = 1
            collection.objects.link(obj)
            if created is not None:
                created.append(obj)
            count += 1
    return name, count


def make_material(source):
    existing = bpy.data.materials.get(source.name)
    if existing is not None:
        return existing
    material = bpy.data.materials.new(source.name)
    colour = (core.linear(source.r), core.linear(source.g), core.linear(source.b), source.opacity)
    material.diffuse_color = colour
    material.use_nodes = True
    bsdf = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf:
        bsdf.inputs["Base Color"].default_value = colour
        bsdf.inputs["Roughness"].default_value = source.roughness
        bsdf.inputs["Metallic"].default_value = source.metalness
        bsdf.inputs["Alpha"].default_value = source.opacity
    if source.opacity < 0.999 and hasattr(material, "blend_method"):
        material.blend_method = "BLEND"
    return material


def document_name(context):
    path = bpy.data.filepath
    return os.path.splitext(os.path.basename(path))[0] if path else "Blender scene"


# ---- operators ------------------------------------------------------------------------------

class ARCHAI_OT_send(bpy.types.Operator, ExportHelper):
    """Save the visible scene as an .AIR file to open in ArchAI"""
    bl_idname = "archai.send"
    bl_label = "Send to ArchAI"
    filename_ext = ".AIR"
    filter_glob: StringProperty(default="*.AIR;*.air", options={"HIDDEN"})

    def execute(self, context):
        meter = Progress("Send to ArchAI")
        try:
            meter.begin("Reading the scene")
            ensure_ids(context.scene)
            objects = collect(context, progress=core.scaled(meter.update, 0.0, 0.9))
            meter.update("Writing the .AIR file", 0.95)
        finally:
            meter.end()
        if not objects:
            self.report({"WARNING"}, "There are no visible meshes, curves or text objects to send.")
            return {"CANCELLED"}
        exchange = core.write_exchange(document_name(context), "Blender", bpy.app.version_string, bpy.data.filepath, objects)
        core.save_exchange(self.filepath, exchange)
        self.report({"INFO"}, "ArchAI: %d objects saved to %s. Open it in ArchAI (Open file)." % (len(exchange["meshes"]), os.path.basename(self.filepath)))
        return {"FINISHED"}


class ARCHAI_OT_open_air(bpy.types.Operator, ImportHelper):
    """Bring an ArchAI .AIR file in as objects, a collection per level"""
    bl_idname = "archai.open_air"
    bl_label = "Open .AIR"
    bl_options = {"REGISTER", "UNDO"}
    filename_ext = ".AIR"
    filter_glob: StringProperty(default="*.AIR;*.air", options={"HIDDEN"})

    def execute(self, context):
        try:
            meter = Progress("Open .AIR")
            try:
                name, count = import_air(context, self.filepath, meter.update)
            finally:
                meter.end()
        except (ValueError, OSError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        self.report({"INFO"}, "ArchAI: %s, %d elements added in the collection \"ArchAI %s\"." % (name, count, name))
        return {"FINISHED"}


class ARCHAI_OT_vr(bpy.types.Operator):
    """Walk through the visible scene in a VR headset (Meta Quest Browser) or any browser. Cameras become stops"""
    bl_idname = "archai.open_vr"
    bl_label = "Open in VR"

    def execute(self, context):
        if _job["thread"] is not None:
            self.report({"WARNING"}, "ArchAI is still uploading the previous VR tour.")
            return {"CANCELLED"}
        config = core.share_config("Blender")
        if config is None:
            self.report({"ERROR"}, core.NO_KEY)
            return {"CANCELLED"}
        name = document_name(context)
        start = context.scene.camera.name if context.scene.camera else None
        meter = Progress("Open in VR")
        meter.begin("Reading the scene")
        objects = collect(context, progress=core.scaled(meter.update, 0.0, 0.3))
        meter.update("Building the VR model", None)
        glb, tour, triangles, stops = core.build_tour(name, "Blender", objects, cameras(context), start)
        if not glb:
            meter.end()
            self.report({"WARNING"}, "There are no visible meshes, curves or text objects to show.")
            return {"CANCELLED"}
        key = "blender|" + (bpy.data.filepath or "unsaved:" + name)
        wm = context.window_manager
        wm.archai_status = "Uploading %d MB to the VR viewer..." % max(1, len(glb) // 1048576)
        meter.update("Uploading %s" % core.megabytes(len(glb)), 0.35)
        _job["meter"] = meter

        def work():
            try:
                upload = core.scaled(lambda text, fraction=None: _job.__setitem__("progress", (text, fraction)), 0.35, 1.0)
                _job["result"] = (core.publish(config, key, glb, tour, upload), name, triangles, stops)
            except Exception as error:  # noqa: BLE001 - shown to the user
                _job["error"] = str(error)

        _job.update(result=None, error=None, thread=threading.Thread(target=work, daemon=True))
        _job["thread"].start()
        bpy.app.timers.register(_poll, first_interval=0.2)
        return {"FINISHED"}


def _poll():
    meter = _job["meter"]
    if _job["thread"] is not None and _job["thread"].is_alive():
        if meter is not None and _job["progress"] is not None:
            meter.update(*_job["progress"])
        return 0.2
    if meter is not None:
        meter.end()
    _job["meter"] = _job["progress"] = None
    wm = bpy.context.window_manager
    _job["thread"] = None
    if _job["error"]:
        wm.archai_status = "VR upload failed: " + _job["error"]
    elif _job["result"]:
        link, name, triangles, stops = _job["result"]
        wm.archai_link = link
        wm.archai_status = "%s is online: %d stop%s, %s triangles." % (name, stops, "" if stops == 1 else "s", format(triangles, ","))
        core.open_in_browser(link)
        try:
            bpy.context.window_manager.clipboard = link
        except Exception:  # noqa: BLE001
            pass
    for window in wm.windows:
        for area in window.screen.areas:
            area.tag_redraw()
    return None


class ARCHAI_OT_copy_link(bpy.types.Operator):
    """Copy the VR link"""
    bl_idname = "archai.copy_link"
    bl_label = "Copy link"

    def execute(self, context):
        context.window_manager.clipboard = context.window_manager.archai_link
        self.report({"INFO"}, "Copied " + context.window_manager.archai_link)
        return {"FINISHED"}


class ARCHAI_OT_open_url(bpy.types.Operator):
    """Open in the browser"""
    bl_idname = "archai.open_url"
    bl_label = "Open"
    url: StringProperty()

    def execute(self, context):
        core.open_in_browser(self.url or core.WEB_URL)
        return {"FINISHED"}


# ---- Live Bridge ------------------------------------------------------------------------------

def _run_main():
    """Runs what the Live Bridge's thread queued for Blender's main thread."""
    queue, _live["queue"] = _live["queue"], []
    for fn in queue:
        fn()
    return None


def _on_main(fn):
    _live["queue"].append(fn)
    if not bpy.app.timers.is_registered(_run_main):
        bpy.app.timers.register(_run_main, first_interval=0.0)


def _live_status(text):
    _live["status"] = text

    def show():
        for window in bpy.context.window_manager.windows:
            for area in window.screen.areas:
                if area.type == "VIEW_3D":
                    area.tag_redraw()
    _on_main(show)


def _live_export():
    ensure_ids(bpy.context.scene)
    return core.write_exchange(document_name(bpy.context), "Blender", bpy.app.version_string, bpy.data.filepath, collect(bpy.context, skip_live=True))


def _live_import(name, objects):
    clear_live(bpy.context)
    import_objects(bpy.context, name, objects, live=True)


def _live_all_ids():
    """Every object of the scene that could be sent (hidden ones too): what is not here was deleted."""
    ids = ensure_ids(bpy.context.scene)
    return [uid for uid, obj in ids.items() if obj.type in GEOMETRY_TYPES and not is_live(obj)]


def _live_apply(delta):
    """A Live Bridge pull, element by element: ArchAI's elements in the ArchAI Live collection
    (replaced or removed one by one), editable copies as ordinary objects, and ArchAI's changes to
    this scene's own objects (moves and names) applied to them."""
    from mathutils import Vector
    context = bpy.context
    mm = millimetres(context.scene)
    if delta.fresh:
        clear_live(context)
    live = {}
    copies = {}
    own = {}
    for obj in context.scene.objects:
        if obj.get("archai_id") and is_live(obj):
            live[obj["archai_id"]] = obj
        if obj.get("archai_copy_of"):
            copies[obj["archai_copy_of"]] = obj
        if obj.get("archai_uid"):
            own[obj["archai_uid"]] = obj

    def remove(obj):
        mesh = obj.data if obj.type == "MESH" else None
        bpy.data.objects.remove(obj, do_unlink=True)
        if mesh is not None and mesh.users == 0:
            bpy.data.meshes.remove(mesh)

    for archai_id in delta.removed:
        if archai_id in live:
            remove(live.pop(archai_id))
    for item in delta.nodes:
        archai_id = item.archai.get("id")
        target = own.get(item.archai.get("ref")) or copies.get(archai_id)
        if target is not None and target.type == "MESH":
            # The scene's own copy of an ArchAI element: its mesh follows ArchAI's.
            replace_mesh(target, item, mm)
            continue
        if archai_id in live:
            remove(live.pop(archai_id))
        editable = item.archai.get("editable")
        created = []
        import_objects(context, delta.name, [item], live=not editable, collection_name=COPIES_COLLECTION if editable else None, created=created)
        for obj in created:
            obj["archai_id"] = archai_id
            if editable:
                obj["archai_copy_of"] = archai_id
                obj.pop("archai_live", None)
            colour = item.archai.get("color")
            if colour and len(colour) == 7:
                obj.color = (int(colour[1:3], 16) / 255.0, int(colour[3:5], 16) / 255.0, int(colour[5:7], 16) / 255.0, 1.0)
    for update in delta.updates:
        obj = own.get(update.get("ref"))
        if obj is None:
            continue
        move = update.get("move")
        if move:
            matrix = obj.matrix_world.copy()
            matrix.translation += Vector(core.move_to_z_up(move, mm))
            obj.matrix_world = matrix
        if update.get("name"):
            obj.name = update["name"]


def replace_mesh(obj, item, mm):
    """Gives `obj` the geometry of an ArchAI node (world positions), keeping its transform."""
    from mathutils import Vector
    inverse = obj.matrix_world.inverted()
    vertices, faces = [], []
    for part in item.parts:
        base = len(vertices)
        p = part.positions
        for i in range(0, len(p) - 2, 3):
            vertices.append(tuple(inverse @ Vector(core.to_z_up(p[i], p[i + 1], p[i + 2], mm))))
        idx = part.indices
        faces.extend((base + idx[i], base + idx[i + 1], base + idx[i + 2]) for i in range(0, len(idx) - 2, 3))
    mesh = bpy.data.meshes.new(obj.data.name)
    mesh.from_pydata(vertices, [], faces)
    for material in obj.data.materials:
        mesh.materials.append(material)
    mesh.validate()
    mesh.update()
    old = obj.data
    obj.data = mesh
    if old.users == 0:
        bpy.data.meshes.remove(old)


@bpy.app.handlers.persistent
def _depsgraph_changed(scene, depsgraph):
    link = _live["link"]
    if link is None or link.quiet():
        return
    for update in depsgraph.updates:
        target = update.id
        if isinstance(target, bpy.types.Object) and is_live(target.original):
            continue
        if isinstance(target, (bpy.types.Object, bpy.types.Mesh, bpy.types.Material, bpy.types.Collection)) and (update.is_updated_geometry or update.is_updated_transform or isinstance(target, bpy.types.Collection)):
            link.changed()
            return


@bpy.app.handlers.persistent
def _file_loaded(*_):
    stop_live()


def stop_live():
    link = _live["link"]
    _live["link"] = None
    if link is not None:
        link.stop()
    if _depsgraph_changed in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.remove(_depsgraph_changed)


def _live_key():
    return "blender:" + (bpy.data.filepath or "unsaved")


class ARCHAI_OT_link_project(bpy.types.Operator):
    """Choose the ArchAI project this scene syncs with: ArchAI shows its projects, pick one or start a new one"""
    bl_idname = "archai.link_project"
    bl_label = "Link to project..."

    def execute(self, context):
        link = _live["link"] or core.LiveLink(_live_key(), "Blender", document_name(context), lambda: None, lambda *a: None, _on_main)

        def work():
            try:
                document = link.choose_project()
                text = "Linked to %s" % document.get("name") if document else "Link to project: cancelled"
            except Exception as error:  # noqa: BLE001 - shown in the panel
                text = "Link to project: %s (is the ArchAI desktop app running?)" % error
            _live_status(text)
        threading.Thread(target=work, name="ArchAI link project", daemon=True).start()
        self.report({"INFO"}, "Choose the project in ArchAI.")
        return {"FINISHED"}


class ARCHAI_OT_live(bpy.types.Operator):
    """Sync this scene with the project open in the ArchAI desktop app as you work: your model goes to ArchAI, ArchAI's model comes back in the "ArchAI Live" collection. Click again to stop"""
    bl_idname = "archai.live"
    bl_label = "Live Bridge"

    def execute(self, context):
        if _live["link"] is not None:
            stop_live()
            self.report({"INFO"}, "ArchAI Live Bridge is off.")
            return {"FINISHED"}
        key = _live_key()
        meter = Progress("Live Bridge")
        gate = core.DelayedProgress(meter.begin, meter.update, meter.end, _on_main)
        _live["link"] = core.LiveLink(key, "Blender", document_name(context), _live_export, _live_import, _on_main, _live_status,
                                      progress=gate.report, finished=gate.finished, apply=_live_apply, all_ids=_live_all_ids)
        bpy.app.handlers.depsgraph_update_post.append(_depsgraph_changed)
        _live["link"].start()
        self.report({"INFO"}, "ArchAI Live Bridge is on.")
        return {"FINISHED"}


# ---- interface ------------------------------------------------------------------------------

class ARCHAI_PT_panel(bpy.types.Panel):
    bl_label = "ArchAI"
    bl_idname = "ARCHAI_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "ArchAI"

    def draw_header(self, context):
        self.layout.label(text="", icon_value=icon("logo"))

    def draw(self, context):
        layout = self.layout
        wm = context.window_manager
        layout.label(text="Design, share and walk through in VR")
        column = layout.column(align=False)
        column.scale_y = 1.6
        column.operator("archai.send", text="Send to ArchAI", icon_value=icon("export"))
        column.operator("archai.open_air", text="Open .AIR", icon_value=icon("import"))
        running = _live["link"] is not None
        column.operator("archai.live", text="Stop Live Bridge" if running else "Live Bridge", icon_value=icon("sync"), depress=running)
        column.operator("archai.link_project", text="Link to project...", icon="LINKED")
        if running and _live["status"]:
            for line in _wrap(_live["status"], 34):
                layout.label(text=line)
        busy = _job["thread"] is not None
        row = column.row()
        row.enabled = not busy
        row.operator("archai.open_vr", text="Uploading..." if busy else "Open in VR", icon_value=icon("vr"))
        if wm.archai_status:
            box = layout.box()
            for line in _wrap(wm.archai_status, 34):
                box.label(text=line)
            if wm.archai_link and not busy:
                box.prop(wm, "archai_link", text="")
                row = box.row(align=True)
                row.operator("archai.copy_link", icon="COPYDOWN")
                row.operator("archai.open_url", text="Open", icon="URL").url = wm.archai_link
        layout.separator()
        layout.operator("archai.open_url", text="ArchAI on the web", icon_value=icon("web")).url = core.WEB_URL


def _wrap(text, width):
    words, line, lines = text.split(), "", []
    for word in words:
        if len(line) + len(word) + 1 > width and line:
            lines.append(line)
            line = word
        else:
            line = (line + " " + word).strip()
    return lines + ([line] if line else [])


def menu_import(self, context):
    self.layout.operator("archai.open_air", text="ArchAI (.AIR)", icon_value=icon("import"))


def menu_export(self, context):
    self.layout.operator("archai.send", text="ArchAI (.AIR)", icon_value=icon("export"))


classes = (ARCHAI_OT_send, ARCHAI_OT_open_air, ARCHAI_OT_live, ARCHAI_OT_link_project, ARCHAI_OT_vr, ARCHAI_OT_copy_link, ARCHAI_OT_open_url, ARCHAI_PT_panel)


def register():
    global _icons
    _icons = bpy.utils.previews.new()
    folder = os.path.join(os.path.dirname(__file__), "icons")
    for name in ("logo", "export", "import", "sync", "vr", "web"):
        path = os.path.join(folder, name + ".png")
        if os.path.exists(path):
            _icons.load(name, path, "IMAGE")
    bpy.types.WindowManager.archai_status = StringProperty(default="")
    bpy.types.WindowManager.archai_link = StringProperty(name="VR link", default="")
    for cls in classes:
        bpy.utils.register_class(cls)
    bpy.types.TOPBAR_MT_file_import.append(menu_import)
    bpy.types.TOPBAR_MT_file_export.append(menu_export)
    bpy.app.handlers.load_post.append(_file_loaded)


def unregister():
    global _icons
    stop_live()
    if _file_loaded in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.remove(_file_loaded)
    bpy.types.TOPBAR_MT_file_import.remove(menu_import)
    bpy.types.TOPBAR_MT_file_export.remove(menu_export)
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
    del bpy.types.WindowManager.archai_status
    del bpy.types.WindowManager.archai_link
    if _icons is not None:
        bpy.utils.previews.remove(_icons)
        _icons = None
