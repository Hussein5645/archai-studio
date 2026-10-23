"""Worker-side static-lighting preparation. Never runs in the distributed viewer."""
import json
import os
import struct
import traceback
import unreal

root = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
report = {"success": False}
try:
    with open(os.path.join(root, "Input/render.json"), encoding="utf-8") as source:
        render = json.load(source)
    levels = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    if unreal.EditorAssetLibrary.does_asset_exist("/Game/Archai/BakedScene"):
        if not levels.load_level("/Game/Archai/BakedScene"):
            raise RuntimeError("Could not reopen the generated bake level")
        for actor in actors.get_all_level_actors():
            if not isinstance(actor, unreal.WorldSettings):
                actors.destroy_actor(actor)
        # Only generated content in this dedicated, marked bake workspace is replaced.
        if unreal.EditorAssetLibrary.does_directory_exist("/Game/Archai/Imported"):
            removed = unreal.EditorAssetLibrary.delete_directory("/Game/Archai/Imported")
            if not removed and unreal.EditorAssetLibrary.list_assets("/Game/Archai/Imported", recursive=True, include_folder=False):
                raise RuntimeError("Could not replace the generated import")
    elif not levels.new_level("/Game/Archai/BakedScene"):
        raise RuntimeError("Could not create the bake level")
    manager = unreal.InterchangeManager.get_interchange_manager_scripted()
    source = unreal.InterchangeManager.create_source_data(os.path.join(root, "Input/scene.glb"))
    params = unreal.ImportAssetParameters()
    params.set_editor_property("is_automated", True)
    if not manager.import_scene("/Game/Archai/Imported", source, params):
        raise RuntimeError("Unreal scene import failed")
    meshes = [actor for actor in actors.get_all_level_actors() if isinstance(actor, unreal.StaticMeshActor)]
    if not meshes:
        raise RuntimeError("The imported scene contains no meshes")
    if unreal.ArchaiRenderGameMode.prepare_lightmap_u_vs() != len(meshes):
        raise RuntimeError("Could not generate lightmap UVs for every mesh")
    with open(os.path.join(root, "Input/scene.glb"), "rb") as source_file:
        binary = source_file.read()
    gltf = json.loads(binary[20:20 + struct.unpack_from("<I", binary, 12)[0]])
    bindings = {node.get("name", "node_%d" % index): node.get("extras", {}).get("archai", {}).get("id")
                for index, node in enumerate(gltf.get("nodes", [])) if "mesh" in node}
    for actor in meshes:
        component = actor.static_mesh_component
        component.set_mobility(unreal.ComponentMobility.STATIC)
        component.set_editor_property("override_light_map_res", True)
        component.set_editor_property("overridden_light_map_res", 128)
        for slot in range(component.get_num_materials()):
            material = component.get_material(slot)
            if isinstance(material, unreal.MaterialInstanceConstant):
                unreal.MaterialEditingLibrary.set_material_usage_override(material, unreal.MaterialUsage.MATUSAGE_STATIC_LIGHTING, True, True)
            elif material and material.get_path_name().startswith("/Game/Archai/"):
                unreal.MaterialEditingLibrary.set_base_material_usage(material, unreal.MaterialUsage.MATUSAGE_STATIC_LIGHTING, True)
            elif material:
                raise RuntimeError("A bake material must be owned by the generated scene")
        matches = [source_id for name, source_id in bindings.items() if source_id and
                   (actor.get_actor_label() == name or actor.get_actor_label().endswith("_" + name))]
        if len(matches) != 1:
            raise RuntimeError("Missing source identity for " + actor.get_actor_label())
        actor.set_editor_property("tags", [unreal.Name("ArchaiObject=" + matches[0])])
    settings = render["settings"]
    sun = actors.spawn_actor_from_class(unreal.DirectionalLight, unreal.Vector(0, 0, 1000))
    sun.light_component.set_mobility(unreal.ComponentMobility.STATIC)
    sun.light_component.set_editor_property('atmosphere_sun_light',True)
    direction = render.get("sunDirection", [0.5, 0.7, 0.5])
    vector = unreal.Vector(-direction[0], -direction[2], -direction[1])
    sun.set_actor_rotation(unreal.MathLibrary.conv_vector_to_rotator(vector), False)
    # Use normalized sun/sky strengths with display exposure for the baked output.
    # Keep this pair independent of the live Lumen physical-camera calibration.
    sun.light_component.set_intensity(settings["sunIntensity"] if settings["sunEnabled"] else 0)
    for light in settings.get("lights", []):
        if not light.get("enabled", True):
            continue
        kind = light["kind"]
        light_class = unreal.SpotLight if kind == "spot" else unreal.RectLight if kind == "area" else unreal.PointLight
        position = light["position"]
        actor = actors.spawn_actor_from_class(light_class, unreal.Vector(position[0] * 100, position[2] * 100, position[1] * 100))
        actor.set_actor_label(light["name"])
        actor.set_actor_rotation(unreal.Rotator(light.get("tilt", -90), light.get("yaw", 0), 0), False)
        component = actor.light_component
        component.set_mobility(unreal.ComponentMobility.STATIC)
        component.set_editor_property("intensity_units", unreal.LightUnits.LUMENS)
        component.set_intensity(light["intensity"])
        component.set_editor_property("attenuation_radius", light.get("radius", 10) * 100)
        color = light.get("color", "#fff0d0").lstrip("#")
        component.set_light_color(unreal.LinearColor(int(color[0:2], 16) / 255, int(color[2:4], 16) / 255, int(color[4:6], 16) / 255))
        if kind == "area":
            component.set_editor_property("source_width", light.get("size", 1) * 100)
            component.set_editor_property("source_height", light.get("height",light.get("size", 1)) * 100)
        if kind == 'spot':
            outer = light.get('outerCone',45)
            component.set_editor_property('outer_cone_angle',outer)
            component.set_editor_property('inner_cone_angle',min(light.get('innerCone',20),outer))
    sky = actors.spawn_actor_from_class(unreal.SkyLight, unreal.Vector())
    sky.light_component.set_mobility(unreal.ComponentMobility.STATIC)
    sky.light_component.set_editor_property('source_type',unreal.SkyLightSourceType.SLS_SPECIFIED_CUBEMAP)
    sky.light_component.set_cubemap(unreal.load_asset('/Engine/MapTemplates/Sky/DaylightAmbientCubemap'))
    sky.light_component.set_editor_property('lower_hemisphere_is_black',False)
    sky.light_component.set_intensity(settings["skyIntensity"])
    actors.spawn_actor_from_class(unreal.SkyAtmosphere, unreal.Vector())
    # Keep environment geometry out of Lightmass world bounds and photon allocation.
    post = actors.spawn_actor_from_class(unreal.PostProcessVolume, unreal.Vector())
    post.set_editor_property("unbound", True)
    look = post.get_editor_property("settings")
    look.set_editor_property("override_auto_exposure_method", True)
    look.set_editor_property("auto_exposure_method", unreal.AutoExposureMethod.AEM_MANUAL)
    look.set_editor_property("override_auto_exposure_bias", True)
    look.set_editor_property("auto_exposure_bias", settings["exposure"])
    look.set_editor_property("override_auto_exposure_apply_physical_camera_exposure", True)
    look.set_editor_property("auto_exposure_apply_physical_camera_exposure", False)
    for key, value in [('camera_iso',100), ('camera_shutter_speed',125), ('depth_of_field_fstop',8), ('bloom_intensity',settings.get('bloom',0.1)), ('bloom_threshold',3), ('vignette_intensity',0)]:
        look.set_editor_property('override_' + key, True)
        look.set_editor_property(key,value)
    post.set_editor_property("settings", look)
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    world.get_world_settings().set_editor_property("force_no_precomputed_lighting", False)
    world.get_world_settings().set_editor_property("default_game_mode", unreal.ArchaiRenderGameMode)
    camera = render.get("camera")
    if camera:
        position, target = camera["position"], camera["target"]
        origin = unreal.Vector(position[0]/10, position[2]/10, position[1]/10)
        destination = unreal.Vector(target[0]/10, target[2]/10, target[1]/10)
        viewpoint = actors.spawn_actor_from_class(unreal.CameraActor, origin)
        viewpoint.set_actor_rotation(unreal.MathLibrary.find_look_at_rotation(origin, destination), False)
    else:
        lower = [float('inf')] * 3
        upper = [float('-inf')] * 3
        for mesh in meshes:
            center, extent = mesh.get_actor_bounds(False)
            for index, axis in enumerate(['x','y','z']):
                lower[index] = min(lower[index],getattr(center,axis)-getattr(extent,axis))
                upper[index] = max(upper[index],getattr(center,axis)+getattr(extent,axis))
        target = unreal.Vector(*[(a+b)/2 for a,b in zip(lower,upper)])
        radius = max(300,sum(((b-a)/2)**2 for a,b in zip(lower,upper))**0.5)
        origin = target + unreal.Vector(-radius,-radius,radius*0.8)
        viewpoint = actors.spawn_actor_from_class(unreal.CameraActor,origin)
        viewpoint.set_actor_rotation(unreal.MathLibrary.find_look_at_rotation(origin,target),False)
    unreal.EditorAssetLibrary.save_directory("/Game/Archai", only_if_is_dirty=False, recursive=True)
    if not levels.save_current_level():
        raise RuntimeError("Could not save bake scene")
    report.update(success=True, meshes=len(meshes))
except Exception as error:
    report.update(error=str(error), traceback=traceback.format_exc())
    unreal.log_error(report["traceback"])
with open(os.path.join(root, "bake-import.json"), "w", encoding="utf-8") as target:
    json.dump(report, target, indent=2)
