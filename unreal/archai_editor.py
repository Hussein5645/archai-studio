"""ArchAI's Editor handoff. All visualization and output tools remain in Unreal."""
import json
import os
import struct
import traceback
import unreal

ROOT = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
MAP = "/Game/Archai/Scene"
_tick = None
_elapsed = 0.0
_revision = None
_loaded = False
_paused = False
_model_hash = None


def _report(**values):
    values["pid"] = os.getpid()
    target = os.path.join(ROOT, "ArchaiSource", "status.json")
    with open(target + ".tmp", "w", encoding="utf-8") as output:
        json.dump(values, output)
    os.replace(target + ".tmp", target)


def _source(actor):
    return any(str(tag) == "ArchaiSource" for tag in actor.tags)


def _tag(actor, prefix):
    return next((str(tag)[len(prefix):] for tag in actor.tags if str(tag).startswith(prefix)), None)


def frame_model():
    actors = [actor for actor in unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()
              if isinstance(actor, unreal.StaticMeshActor) and _source(actor)]
    if not actors:
        return
    boxes = [actor.get_actor_bounds(False) for actor in actors]
    lower = [min(getattr(center, axis) - getattr(extent, axis) for center, extent in boxes) for axis in ("x", "y", "z")]
    upper = [max(getattr(center, axis) + getattr(extent, axis) for center, extent in boxes) for axis in ("x", "y", "z")]
    center = unreal.Vector(*[(low + high) / 2 for low, high in zip(lower, upper)])
    radius = max(upper[index] - lower[index] for index in range(3))
    position = center + unreal.Vector(-max(radius, 300), -max(radius, 300), max(radius * 0.65, 200))
    unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).set_level_viewport_camera_info(position, unreal.MathLibrary.find_look_at_rotation(position, center))


def _setup_lighting(actors, settings):
    sun = actors.spawn_actor_from_class(unreal.DirectionalLight, unreal.Vector(0, 0, 1000))
    sun.set_actor_label("Sun — edit lighting here")
    sun.light_component.set_intensity(settings["sunIntensity"] * 10000)
    sun.set_actor_rotation(unreal.Rotator(-35, -45, 0), False)
    sky = actors.spawn_actor_from_class(unreal.SkyLight, unreal.Vector())
    sky.light_component.set_intensity(settings["skyIntensity"])
    actors.spawn_actor_from_class(unreal.SkyAtmosphere, unreal.Vector())
    post = actors.spawn_actor_from_class(unreal.PostProcessVolume, unreal.Vector())
    post.set_editor_property("unbound", True)
    look = post.get_editor_property("settings")
    look.set_editor_property("override_auto_exposure_method", True)
    look.set_editor_property("auto_exposure_method", unreal.AutoExposureMethod.AEM_MANUAL)
    look.set_editor_property("override_auto_exposure_bias", True)
    look.set_editor_property("auto_exposure_bias", settings["exposure"])
    look.set_editor_property("override_auto_exposure_apply_physical_camera_exposure", True)
    look.set_editor_property("auto_exposure_apply_physical_camera_exposure", False)
    post.set_editor_property("settings", look)


def synchronize():
    global _revision, _loaded, _model_hash
    with open(os.path.join(ROOT, "ArchaiSource", "pending.json"), encoding="utf-8") as source:
        pending = json.load(source)
    revision = pending["revision"]
    if revision == _revision:
        return
    _revision = revision  # A failed revision is retried explicitly, not every editor tick.
    levels = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    if not _loaded:
        if unreal.EditorAssetLibrary.does_asset_exist(MAP):
            if not levels.load_level(MAP):
                raise RuntimeError("Could not load the ArchAI scene")
        elif not levels.new_level(MAP):
            raise RuntimeError("Could not create the ArchAI scene")
        _loaded = True
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    # Do not replace geometry in another level or during Play/VR Preview.
    if world.get_path_name().split(".")[0] != MAP or unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_game_world():
        _revision = None
        return
    previous = list(actors.get_all_level_actors())
    old = [actor for actor in previous if _source(actor)]
    if _model_hash == pending["modelHash"]:
        _report(state="ready", revision=revision, modelHash=_model_hash,
                meshActors=sum(isinstance(actor, unreal.StaticMeshActor) for actor in old),
                project=os.path.join(ROOT, "ArchaiScene.uproject"))
        return
    overrides = {}
    for actor in old:
        if isinstance(actor, unreal.StaticMeshActor):
            component = actor.static_mesh_component
            overrides[_tag(actor, "ArchaiNode=") or actor.get_actor_label()] = {
                slot: component.get_material(slot) for slot in range(component.get_num_materials())
                if component.get_material(slot) and component.get_material(slot).get_path_name() != _tag(actor, "ArchaiMaterial%d=" % slot)}
    input_dir = os.path.join(ROOT, "ArchaiSource", revision)
    with open(os.path.join(input_dir, "scene.glb"), "rb") as source:
        binary = source.read()
    gltf = json.loads(binary[20:20 + struct.unpack_from("<I", binary, 12)[0]])
    bindings = {node.get("name", ""): node.get("extras", {}).get("archai", {})
                for node in gltf.get("nodes", []) if "mesh" in node}
    _report(state="loading", revision=revision)
    manager = unreal.InterchangeManager.get_interchange_manager_scripted()
    params = unreal.ImportAssetParameters()
    params.set_editor_property("is_automated", True)
    imported = []
    try:
        ok = manager.import_scene("/Game/Archai/Source/R" + revision,
                                  unreal.InterchangeManager.create_source_data(os.path.join(input_dir, "scene.glb")), params)
        imported = [actor for actor in actors.get_all_level_actors() if actor not in previous]
        if not ok:
            raise RuntimeError("Unreal could not import the model")
        meshes = [actor for actor in imported if isinstance(actor, unreal.StaticMeshActor)]
        expected = sum(1 for node in gltf.get("nodes", []) if "mesh" in node)
        if len(meshes) != expected:
            raise RuntimeError("The imported mesh count does not match the source")
        for actor in imported:
            actor.set_editor_property("tags", [unreal.Name("ArchaiSource")])
            actor.set_folder_path(unreal.Name("Archai Model"))
        for actor in meshes:
            name = actor.get_actor_label()
            matches = [(key, data) for key, data in bindings.items() if name == key or name.endswith("_" + key)]
            if len(matches) != 1 or not matches[0][1].get("id"):
                raise RuntimeError("Missing source identity for " + name)
            key, identity = matches[0]
            actor.set_actor_label(key)
            component = actor.static_mesh_component
            tags = [unreal.Name("ArchaiSource"), unreal.Name("ArchaiObject=" + identity["id"]), unreal.Name("ArchaiNode=" + key),
                    unreal.Name("ArchaiParent=" + str(identity.get("parentId") or ""))]
            tags.extend(unreal.Name("ArchaiMaterial%d=" % slot + component.get_material(slot).get_path_name())
                        for slot in range(component.get_num_materials()) if component.get_material(slot))
            actor.set_editor_property("tags", tags)
            component.set_mobility(unreal.ComponentMobility.STATIC)
            for slot, material in overrides.get(key, {}).items():
                if material and slot < component.get_num_materials():
                    component.set_material(slot, material)
    except Exception:
        for actor in imported:
            actors.destroy_actor(actor)
        raise
    for actor in old:
        actors.destroy_actor(actor)
    if not previous or not any(isinstance(actor, unreal.Light) for actor in previous):
        with open(os.path.join(input_dir, "render.json"), encoding="utf-8") as source:
            configuration = json.load(source)
        _setup_lighting(actors, configuration["settings"])
        camera = configuration.get("camera")
        if camera:
            position, target = camera["position"], camera["target"]
            origin = unreal.Vector(position[0] / 10, position[2] / 10, position[1] / 10)
            destination = unreal.Vector(target[0] / 10, target[2] / 10, target[1] / 10)
            unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).set_level_viewport_camera_info(origin, unreal.MathLibrary.find_look_at_rotation(origin, destination))
        else:
            frame_model()
    unreal.EditorAssetLibrary.save_directory("/Game/Archai/Source", only_if_is_dirty=True, recursive=True)
    levels.save_current_level()
    _model_hash = pending["modelHash"]
    _report(state="ready", revision=revision, modelHash=_model_hash, meshActors=len(meshes), project=os.path.join(ROOT, "ArchaiScene.uproject"))
    unreal.log("ArchAI: synchronized %d meshes. Lighting, cameras and output controls are in Unreal." % len(meshes))


def retry():
    global _revision
    _revision = None
    synchronize()


def toggle_sync():
    global _paused
    _paused = not _paused
    unreal.log("ArchAI live sync " + ("paused" if _paused else "enabled"))


def prepare_bake(show_message=True):
    """Prepare this editable level; Unreal's Build menu performs Lightmass baking."""
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    settings = world.get_world_settings()
    settings.set_editor_property("force_no_precomputed_lighting", False)
    meshes = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
    for actor in unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors():
        if isinstance(actor, unreal.StaticMeshActor):
            component = actor.static_mesh_component
            component.set_mobility(unreal.ComponentMobility.STATIC)
            mesh = component.static_mesh
            meshes.set_generate_lightmap_uv(mesh, True)
            mesh.set_editor_property("light_map_coordinate_index", 1)
            mesh.set_editor_property("light_map_resolution", 128)
            # Architectural surfaces need collision for a packaged walkable experience.
            body = mesh.get_editor_property("body_setup")
            body.set_editor_property("collision_trace_flag", unreal.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE)
            for slot in range(component.get_num_materials()):
                material = component.get_material(slot)
                if isinstance(material, unreal.MaterialInstanceConstant):
                    unreal.MaterialEditingLibrary.set_material_usage_override(material, unreal.MaterialUsage.MATUSAGE_STATIC_LIGHTING, True, True)
        elif isinstance(actor, unreal.Light):
            actor.light_component.set_mobility(unreal.ComponentMobility.STATIC)
        elif isinstance(actor, unreal.PostProcessVolume):
            look = actor.get_editor_property("settings")
            look.set_editor_property("override_dynamic_global_illumination_method", True)
            look.set_editor_property("dynamic_global_illumination_method", unreal.DynamicGlobalIlluminationMethod.NONE)
            actor.set_editor_property("settings", look)
    unreal.EditorAssetLibrary.save_directory("/Game/Archai", only_if_is_dirty=True, recursive=True)
    unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).save_current_level()
    if show_message:
        unreal.EditorDialog.show_message("Bake scene", "The level is prepared for static lighting. Use Build > Build Lighting Only. Use Platforms > Windows > Package Project to export. Configure your XR pawn and test VR Preview before headset delivery.", unreal.AppMsgType.OK)


def _poll(delta):
    global _elapsed
    _elapsed += delta
    if _elapsed < 1.0 or _paused:
        return
    _elapsed = 0.0
    try:
        synchronize()
    except Exception as error:
        _report(state="error", revision=_revision, error=str(error))
        unreal.log_error("ArchAI: " + traceback.format_exc())


def start():
    global _tick
    if _tick is not None:
        return
    menus = unreal.ToolMenus.get()
    main = menus.find_menu("LevelEditor.MainMenu")
    if main:
        menu = main.add_sub_menu("ArchAI", "ArchAI", "ArchAI", "ArchAI", "ArchAI scene tools")
        for name, label, action in (("Sync", "Synchronize model now", "retry"),
                                    ("Frame", "Frame model", "frame_model"),
                                    ("Live", "Pause / resume model synchronization", "toggle_sync"),
                                    ("Bake", "Prepare walkable scene for lighting bake", "prepare_bake")):
            entry = unreal.ToolMenuEntry(name="Archai" + name, type=unreal.MultiBlockType.MENU_ENTRY)
            entry.set_label(label)
            entry.set_string_command(unreal.ToolMenuStringCommandType.PYTHON, "", "import archai_editor; archai_editor.%s()" % action)
            menu.add_menu_entry("Scene", entry)
        menus.refresh_all_widgets()
    _tick = unreal.register_slate_post_tick_callback(_poll)
