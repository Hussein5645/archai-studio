"""Editor-side assertions for unreal-editor-smoke.mjs; never shipped with ArchAI."""
import json
import os
import traceback
import unreal
import archai_editor as bridge

unreal.EditorPythonScripting.set_keep_python_script_alive(True)

root = bridge.ROOT
stage = 0
elapsed = 0
light = camera = material = None
labels = []
tick = None


def poll(delta):
    global stage, elapsed, light, camera, material, labels
    elapsed += delta
    if elapsed > 180:
        finish({"success": False, "error": "Editor smoke timed out"})
        return
    try:
        status_file = os.path.join(root, "ArchaiSource", "status.json")
        if not os.path.exists(status_file):
            return
        with open(status_file, encoding="utf-8") as source:
            report = json.load(source)
        if report["state"] == "error":
            raise RuntimeError(report["error"])
        if report["state"] != "ready":
            return
        actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        meshes = [actor for actor in actors.get_all_level_actors() if isinstance(actor, unreal.StaticMeshActor) and bridge._source(actor)]
        if stage == 0:
            assert meshes
            light = actors.spawn_actor_from_class(unreal.PointLight, unreal.Vector(200, 300, 400))
            light.set_actor_label("Smoke preserved light")
            light.light_component.set_intensity(12345)
            camera = actors.spawn_actor_from_class(unreal.CameraActor, unreal.Vector(111, 222, 333))
            material = unreal.load_asset("/Engine/EngineMaterials/DefaultMaterial")
            assert material
            for actor in meshes:
                actor.static_mesh_component.set_material(0, material)
            labels = [actor.get_actor_label() for actor in meshes]
            unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).save_current_level()
            with open(os.path.join(root, "smoke-edited.json"), "w") as output:
                json.dump({"revision": report["revision"]}, output)
            stage = 1
        elif stage == 1 and os.path.exists(os.path.join(root, "smoke-next.json")):
            with open(os.path.join(root, "smoke-next.json")) as source:
                expected = json.load(source)
            if report["revision"] != expected["revision"]:
                return
            assert sorted(labels) == sorted(actor.get_actor_label() for actor in meshes)
            assert light.light_component.intensity == 12345
            assert camera.get_actor_location() == unreal.Vector(111, 222, 333)
            assert all(actor.static_mesh_component.get_material(0) == material for actor in meshes)
            assert all(any(str(tag).startswith("ArchaiObject=") for tag in actor.tags) for actor in meshes)
            bridge.prepare_bake(False)
            for actor in meshes:
                mesh = actor.static_mesh_component.static_mesh
                assert mesh.get_editor_property("light_map_coordinate_index") == 1
                assert mesh.get_editor_property("light_map_resolution") == 128
                assert actor.static_mesh_component.mobility == unreal.ComponentMobility.STATIC
                assert mesh.get_editor_property("body_setup").get_editor_property("collision_trace_flag") == unreal.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE
            finish({"success": True, "meshes": len(meshes), "lightingPreserved": True,
                    "cameraPreserved": True, "materialsPreserved": True, "sourceIds": True,
                    "nativeBakePreparation": True})
    except Exception:
        finish({"success": False, "error": traceback.format_exc()})


def finish(report):
    unreal.unregister_slate_post_tick_callback(tick)
    with open(os.path.join(root, "editor-verification.json"), "w") as output:
        json.dump(report, output, indent=2)
    unreal.SystemLibrary.quit_editor()


tick = unreal.register_slate_post_tick_callback(poll)
