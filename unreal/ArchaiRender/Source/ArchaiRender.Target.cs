using UnrealBuildTool;
public class ArchaiRenderTarget : TargetRules
{
    public ArchaiRenderTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Game;
        DefaultBuildSettings = BuildSettingsVersion.Latest;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("ArchaiRender");
    }
}
