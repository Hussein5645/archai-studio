"""Developer feasibility stage: import an Archai scene into a dedicated Unreal project.

This runs on a preparation worker/editor, never inside the customer runtime.
"""
import json
import os
import struct
import traceback

import unreal

root = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
report_path = os.path.join(root, "preparation-report.json")
report = {"success": False, "stage": "editor-import", "runtimeValidated": False}
try:
    with open(os.path.join(root, "Input", "manifest.json"), encoding="utf-8") as source:
        manifest = json.load(source)
    with open(os.path.join(root, "Input", "render.json"), encoding="utf-8") as source:
        render = json.load(source)
    level = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    if not level.new_level("/Game/Archai/Scene"):
        raise RuntimeError("Could not create the preparation level")
    manager = unreal.InterchangeManager.get_interchange_manager_scripted()
    data = unreal.InterchangeManager.create_source_data(os.path.join(root, "Input", "scene.glb"))
    parameters = unreal.ImportAssetParameters()
    parameters.set_editor_property("is_automated", True)
    if not manager.import_scene("/Game/Archai/Imported", data, parameters):
        raise RuntimeError("Unreal Interchange rejected the scene")
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    imported = [actor for actor in actors.get_all_level_actors() if isinstance(actor, unreal.StaticMeshActor)]
    if not imported:
        raise RuntimeError("No static mesh actors were imported")
    with open(os.path.join(root, "Input", "scene.glb"), "rb") as source:
        glb = source.read()
    magic, version, total = struct.unpack_from("<III", glb)
    if magic != 0x46546C67 or version != 2 or total != len(glb):
        raise RuntimeError("Invalid binary glTF header")
    chunk_size, chunk_type = struct.unpack_from("<II", glb, 12)
    if chunk_type != 0x4E4F534A:
        raise RuntimeError("Missing binary glTF scene description")
    gltf = json.loads(glb[20:20 + chunk_size])
    object_table = {item["id"]: item for item in manifest["objects"]}
    bindings = {}
    for index, node in enumerate(gltf.get("nodes", [])):
        if "mesh" not in node:
            continue
        extras = node.get("extras", {})
        source_id = extras.get("archai", {}).get("id") or extras.get("elementId")
        if source_id in object_table:
            bindings[node.get("name") or "node_%d" % index] = source_id
    mapped = []
    for actor in imported:
        label = actor.get_actor_label()
        candidates = [source_id for name, source_id in bindings.items()
                      if label == name or label.endswith("_" + name)]
        if len(candidates) != 1:
            raise RuntimeError("Could not uniquely bind imported actor '%s' to an Archai object" % label)
        source_id = candidates[0]
        item = object_table[source_id]
        actor.set_editor_property("tags", [unreal.Name("ArchaiObject=" + source_id),
                                           unreal.Name("ArchaiProject=" + manifest["projectId"])])
        actor.set_folder_path(unreal.Name("Archai/" + (item.get("parentId") or "Model")))
        actor.set_actor_label((item.get("name") or source_id) + " [" + source_id + "]")
        mapped.append({"name": actor.get_actor_label(), "sourceId": source_id,
                       "parentId": item.get("parentId"), "class": actor.get_class().get_name()})
    settings = render["settings"]
    sun = actors.spawn_actor_from_class(unreal.DirectionalLight, unreal.Vector(0, 0, 1000))
    sun.set_actor_label("Archai Sun")
    # Initial approximation only: physical sun/time and full look mapping require validation.
    sun.set_actor_rotation(unreal.Rotator(-settings["altitude"], settings["azimuth"], 0), False)
    sun.light_component.set_intensity(settings["sunIntensity"] if settings["sunEnabled"] else 0)
    sky = actors.spawn_actor_from_class(unreal.SkyLight, unreal.Vector(0, 0, 0))
    sky.set_actor_label("Archai Sky")
    sky.light_component.set_intensity(settings["skyIntensity"])
    actors.spawn_actor_from_class(unreal.SkyAtmosphere, unreal.Vector(0, 0, 0))
    if not unreal.EditorAssetLibrary.save_directory("/Game/Archai", only_if_is_dirty=False, recursive=True):
        raise RuntimeError("Could not save imported Unreal assets")
    if not level.save_current_level():
        raise RuntimeError("Could not save the prepared level")
    report.update(success=True, projectId=manifest["projectId"], sourceRevision=manifest["sourceRevision"],
                  renderRevision=manifest["renderRevision"], staticMeshActors=len(imported),
                  identityMappedActors=len(mapped), actors=mapped,
                  warnings=["Editor import only; packaged runtime and lighting equivalence are not yet validated."])
except Exception as error:
    report.update(error=str(error), traceback=traceback.format_exc())
    unreal.log_error(report["traceback"])
finally:
    with open(report_path, "w", encoding="utf-8") as target:
        json.dump(report, target, indent=2)
