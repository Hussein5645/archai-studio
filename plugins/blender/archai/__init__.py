"""ArchAI in Blender: send the scene to ArchAI, keep it in sync with the ArchAI desktop app (live
link), open .AIR files, walk through the scene in VR.

The sidebar tab "ArchAI" (N panel of the 3D View) holds the actions; File > Import / Export
also offer ArchAI (.AIR). See docs/plugins.md in the ArchAI repository.
"""
bl_info = {
    "name": "ArchAI",
    "author": "ArchAI",
    "version": (0, 4, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > ArchAI; File > Import/Export > ArchAI (.AIR)",
    "description": "Send models to ArchAI, open .AIR files and walk through the scene in VR",
    "category": "Import-Export",
    "doc_url": "https://archai2-0.vercel.app/download.html",
}

import os
import threading

import bpy
import bpy.utils.previews
from bpy.props import StringProperty
from bpy_extras.io_utils import ExportHelper, ImportHelper

from . import archai_core as core

_icons = None
_job = {"thread": None, "result": None, "error": None}
_live = {"link": None, "queue": [], "status": ""}
LIVE_COLLECTION = "ArchAI Live"


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
    """Objects the live link brought in from ArchAI (never sent back)."""
    return bool(obj.get("archai_live")) if obj is not None else False


def collect(context, skip_live=False):
    """Visible objects (with their modifiers, instances and geometry nodes) as ArchAI objects."""
    import numpy as np
    depsgraph = context.evaluated_depsgraph_get()
    mm = millimetres(context.scene)
    objects, materials = {}, {}
    for instance in depsgraph.object_instances:
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
                item = objects[owner.name] = core.SceneObject(owner.name[:12], owner.name, owner.original.users_collection[0].name if owner.original.users_collection else "")
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


def import_air(context, path):
    name, objects = core.read_air(path)
    return import_objects(context, name, objects)


def clear_live(context):
    """Removes what the live link brought in: the ArchAI Live collection and its objects."""
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


def import_objects(context, name, objects, live=False):
    mm = millimetres(context.scene)
    if live:
        root = bpy.data.collections.get(LIVE_COLLECTION) or bpy.data.collections.new(LIVE_COLLECTION)
        if root.name not in context.scene.collection.children:
            context.scene.collection.children.link(root)
    else:
        root = bpy.data.collections.new("ArchAI " + name)
        context.scene.collection.children.link(root)
    materials, count = {}, 0
    for level, items in core.by_level(objects):
        collection = root
        if level:
            collection = bpy.data.collections.new(level)
            root.children.link(collection)
        for item in items:
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
        objects = collect(context)
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
            name, count = import_air(context, self.filepath)
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
        glb, tour, triangles, stops = core.build_tour(name, "Blender", collect(context), cameras(context), start)
        if not glb:
            self.report({"WARNING"}, "There are no visible meshes, curves or text objects to show.")
            return {"CANCELLED"}
        key = "blender|" + (bpy.data.filepath or "unsaved:" + name)
        wm = context.window_manager
        wm.archai_status = "Uploading %d MB to the VR viewer..." % max(1, len(glb) // 1048576)

        def work():
            try:
                _job["result"] = (core.publish(config, key, glb, tour), name, triangles, stops)
            except Exception as error:  # noqa: BLE001 - shown to the user
                _job["error"] = str(error)

        _job.update(result=None, error=None, thread=threading.Thread(target=work, daemon=True))
        _job["thread"].start()
        bpy.app.timers.register(_poll, first_interval=0.5)
        return {"FINISHED"}


def _poll():
    if _job["thread"] is not None and _job["thread"].is_alive():
        return 0.5
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


# ---- live link ------------------------------------------------------------------------------

def _run_main():
    """Runs what the live link's thread queued for Blender's main thread."""
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
    return core.write_exchange(document_name(bpy.context), "Blender", bpy.app.version_string, bpy.data.filepath, collect(bpy.context, skip_live=True))


def _live_import(name, objects):
    clear_live(bpy.context)
    import_objects(bpy.context, name, objects, live=True)


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


class ARCHAI_OT_live(bpy.types.Operator):
    """Sync this scene with the project open in the ArchAI desktop app as you work: your model goes to ArchAI, ArchAI's model comes back in the "ArchAI Live" collection. Click again to stop"""
    bl_idname = "archai.live"
    bl_label = "Live link"

    def execute(self, context):
        if _live["link"] is not None:
            stop_live()
            self.report({"INFO"}, "ArchAI live link is off.")
            return {"FINISHED"}
        key = "blender:" + (bpy.data.filepath or "unsaved")
        _live["link"] = core.LiveLink(key, "Blender", document_name(context), _live_export, _live_import, _on_main, _live_status)
        bpy.app.handlers.depsgraph_update_post.append(_depsgraph_changed)
        _live["link"].start()
        self.report({"INFO"}, "ArchAI live link is on.")
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
        column.operator("archai.live", text="Stop live link" if running else "Live link", icon_value=icon("sync"), depress=running)
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


classes = (ARCHAI_OT_send, ARCHAI_OT_open_air, ARCHAI_OT_live, ARCHAI_OT_vr, ARCHAI_OT_copy_link, ARCHAI_OT_open_url, ARCHAI_PT_panel)


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
