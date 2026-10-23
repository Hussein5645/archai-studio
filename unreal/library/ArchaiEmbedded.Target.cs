using UnrealBuildTool;
public class ArchaiEmbeddedTarget : TargetRules
{
    public ArchaiEmbeddedTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Game;
        DefaultBuildSettings = BuildSettingsVersion.Latest;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        LinkType = TargetLinkType.Monolithic;
        bShouldCompileAsDLL = true;
        bUseLoggingInShipping = true;
        BuildEnvironment = TargetBuildEnvironment.Unique;
        GlobalDefinitions.Add("UE_LIBRARY_ENABLED=1");
        ExtraModuleNames.AddRange(new[] { "ArchaiRender", "UELibrary" });
    }
}
