using UnrealBuildTool;
public class ArchaiRender : ModuleRules
{
    public ArchaiRender(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
        PrivateDependencyModuleNames.AddRange(new[] { "InputCore", "Json", "Slate", "SlateCore", "InterchangeCore", "InterchangeEngine", "InterchangePipelines", "MeshDescription", "StaticMeshDescription", "ImageWrapper", "RenderCore", "RHI" });
        if (Target.Platform == UnrealTargetPlatform.Win64) PublicSystemLibraries.AddRange(new[] { "bcrypt.lib", "user32.lib", "gdi32.lib" });
    }
}
