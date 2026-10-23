using UnrealBuildTool;
public class ArchaiRenderEditorTarget : TargetRules
{
    public ArchaiRenderEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.Latest;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("ArchaiRender");
    }
}
