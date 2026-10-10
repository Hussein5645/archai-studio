using System;
using System.IO;
using System.Runtime.InteropServices;
using Rhino;
using Rhino.PlugIns;

[assembly: Guid("6F3C2A61-9E1B-4C7A-B0D4-1A5E3C8F72B9")]
[assembly: PlugInDescription(DescriptionType.Organization, "ArchAI")]
[assembly: PlugInDescription(DescriptionType.WebSite, "https://archai-studio-six.vercel.app/")]
[assembly: PlugInDescription(DescriptionType.Icon, "archai.logo.ico")]

namespace Archai.Rhino;

/// <summary>ArchAI in Rhino: loads at startup so the ArchAI panel is available (Panels, or the ArchAI command).</summary>
public sealed class ArchaiPlugin : PlugIn
{
    public static ArchaiPlugin? Instance { get; private set; }
    public ArchaiPlugin() { Instance = this; }

    public override PlugInLoadTime LoadTime => PlugInLoadTime.AtStartup;

    protected override LoadReturnCode OnLoad(ref string errorMessage)
    {
        try
        {
            using var stream = Resource("logo.ico");
            global::Rhino.UI.Panels.RegisterPanel(this, typeof(ArchaiPanel), "ArchAI", new System.Drawing.Icon(stream));
        }
        catch (Exception ex) { RhinoApp.WriteLine("ArchAI: the panel could not be registered: " + ex.Message); }
        return LoadReturnCode.Success;
    }

    public static Stream Resource(string file) =>
        typeof(ArchaiPlugin).Assembly.GetManifestResourceStream("archai." + file) ?? throw new InvalidOperationException("Missing resource " + file);

    public static Eto.Drawing.Bitmap Icon(string name, int size)
    {
        using var stream = Resource($"{name}-{size}.png");
        return new Eto.Drawing.Bitmap(stream);
    }
}
