import json
import os
import unreal

root = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).load_level("/Game/Archai/BakedScene")
count = unreal.ArchaiRenderGameMode.verify_baked_lighting()
with open(os.path.join(root, "bake-verification.json"), "w", encoding="utf-8") as target:
    json.dump({"success": count > 0, "meshesWithLightmaps": count, "engine": "Unreal Lightmass", "quality": "Preview"}, target, indent=2)
