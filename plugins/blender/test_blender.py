"""Headless test of the Blender add-on:
   blender --background --factory-startup --python-exit-code 1 --python plugins/blender/test_blender.py -- <staging dir> [other.AIR]
<staging dir> holds the packaged add-on folder `archai` (build-plugins.ps1 makes it).
Set BLENDER_USER_CONFIG, BLENDER_USER_SCRIPTS, BLENDER_USER_EXTENSIONS and BLENDER_USER_DATAFILES to
empty folders first: a --factory-startup Blender on your own profile removes the Python packages
your installed extensions use (Blender puts them back on its next normal start)."""
import os
import sys

import bpy

args = sys.argv[sys.argv.index("--") + 1:]
sys.path.insert(0, args[0])
import archai  # noqa: E402

archai.register()
out = os.path.join(args[0], "blender-test.AIR")

# A 1 x 2 x 3 m box with its corner at (10, 20, 0), and a camera.
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(10.5, 21, 1.5))
cube = bpy.context.active_object
cube.scale = (1, 2, 3)
cube.name = "Box"
material = bpy.data.materials.new("Brick")
material.diffuse_color = (0.5, 0.1, 0.05, 1)
cube.data.materials.append(material)
bpy.ops.object.camera_add(location=(5, 20, 1.6), rotation=(1.5708, 0, -1.5708))
bpy.context.scene.camera = bpy.context.active_object

objects = archai.collect(bpy.context)
assert len(objects) == 1 and objects[0].triangle_count == 12, [(o.name, o.triangle_count) for o in objects]
assert bpy.ops.archai.send(filepath=out) == {"FINISHED"}
exchange = archai.core.read_air(out)
print("exported:", exchange[0], [(o.name, o.triangle_count) for o in exchange[1]])

stops = archai.cameras(bpy.context)
glb, tour, triangles, count = archai.core.build_tour("t", "Blender", objects, stops, bpy.context.scene.camera.name)
print("tour stop:", tour["spaces"][0])
assert tour["spaces"][0]["center"] == [5.0, -20.0], tour["spaces"][0]
assert abs(tour["spaces"][0]["look"][0] - 8.0) < 1e-3 and abs(tour["spaces"][0]["look"][1] + 20.0) < 1e-3, "camera looks along +x"

bpy.ops.object.select_all(action="DESELECT")
assert bpy.ops.archai.open_air(filepath=out) == {"FINISHED"}
imported = [o for o in bpy.data.objects if o.users_collection and o.users_collection[0].name.startswith("ArchAI")]
assert len(imported) == 1, imported
xs = [v.co.x for v in imported[0].data.vertices]
ys = [v.co.y for v in imported[0].data.vertices]
zs = [v.co.z for v in imported[0].data.vertices]
print("imported bounds:", min(xs), max(xs), min(ys), max(ys), min(zs), max(zs))
assert abs(min(xs) - 10) < 1e-3 and abs(max(ys) - 22) < 1e-3 and abs(max(zs) - 3) < 1e-3
assert imported[0].data.materials[0].name.startswith("Brick")

for extra in args[1:]:
    before = len(bpy.data.objects)
    assert bpy.ops.archai.open_air(filepath=extra) == {"FINISHED"}
    print("imported %s: %d objects" % (os.path.basename(extra), len(bpy.data.objects) - before))

archai.unregister()
print("BLENDER ADD-ON OK")
