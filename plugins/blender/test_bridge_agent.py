"""One Blender in the Live Bridge end-to-end test (driven by scripts/bridge-e2e.mjs):
   blender --background --factory-startup --python plugins/blender/test_bridge_agent.py -- <staging dir> <role A|B> <control file> <status file>
Runs the add-on's real live-link functions (export, per-element apply, all ids) against the ArchAI
desktop app on ARCHAI_LIVE_PORT, doing the step the driver writes into the control file and
reporting the scene into the status file. Background Blender has no timers: main-thread work
queued by the link is run here."""
import json
import os
import sys
import threading
import time

import bpy

args = sys.argv[sys.argv.index("--") + 1:]
staging, role, control, status_file = args[0], args[1], args[2], args[3]
sys.path.insert(0, staging)
import archai  # noqa: E402

archai.register()
core = archai.core
bpy.ops.wm.read_factory_settings(use_empty=True)

queue, lock = [], threading.Lock()


def on_main(fn):
    with lock:
        queue.append(fn)


statuses = []
key = "blender:C:/bridge-test/%s.blend" % role
link = core.LiveLink(key, "Blender", "Scene " + role, archai._live_export, archai._live_import, on_main, statuses.append,
                     apply=archai._live_apply, all_ids=archai._live_all_ids)

if role == "A":
    bpy.ops.mesh.primitive_cube_add(size=2, location=(1, -1, 1))
    bpy.context.active_object.name = "Wall A"
else:
    bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=3, location=(6, -1, 1.5))
    bpy.context.active_object.name = "Column B"


def mine():
    return next((o for o in bpy.context.scene.objects if o.name.startswith("Wall A" if role == "A" else "Column B") and not archai.is_live(o) and not o.get("archai_copy_of")), None)


def report():
    from mathutils import Vector
    objects = []
    for obj in bpy.context.scene.objects:
        corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
        center = sum(corners, Vector()) / 8.0
        objects.append({
            "name": obj.name, "uid": obj.get("archai_uid"), "live": archai.is_live(obj), "archai_id": obj.get("archai_id"),
            "copy_of": obj.get("archai_copy_of"), "location": [round(v, 4) for v in obj.matrix_world.translation],
            "center": [round(v, 4) for v in center],
            "hidden": obj.hide_get(), "color": [round(c, 3) for c in obj.color],
            "collections": [c.name for c in obj.users_collection],
        })
    with open(status_file + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"role": role, "objects": objects, "status": link.last_status, "statuses": statuses[-5:], "time": time.time()}, f)
    try:
        os.replace(status_file + ".tmp", status_file)
    except PermissionError:
        pass  # the driver is reading it (Windows); the next report replaces it


done = set()
deadline = time.time() + 600
while time.time() < deadline:
    with lock:
        work, queue[:] = list(queue), []
    for fn in work:
        fn()
    try:
        with open(control, "r", encoding="utf-8") as f:
            steps = json.load(f).get(role, [])
    except Exception:
        steps = []
    for step in steps:
        if step in done:
            continue
        done.add(step)
        obj = mine()
        if step == "start":
            link.start()
        elif step == "move" and obj:
            obj.location.x += 2.0
            link.changed()
        elif step == "hide" and obj:
            obj.hide_set(True)
            link.changed()
        elif step == "unhide" and obj:
            obj.hide_set(False)
            link.changed()
        elif step == "delete" and obj:
            bpy.data.objects.remove(obj, do_unlink=True)
            link.changed()
        elif step == "rename-copy":
            copy = next((o for o in bpy.context.scene.objects if o.get("archai_copy_of")), None)
            if copy:
                copy.name = "Copy renamed in " + role
                link.changed()
        elif step == "rename" and obj:
            obj.name = "Wall A renamed"
            link.changed()
        elif step == "push":
            link.changed()
        elif step == "stop":
            link.stop()
            report()
            sys.exit(0)
    report()
    time.sleep(0.05)
link.stop()
