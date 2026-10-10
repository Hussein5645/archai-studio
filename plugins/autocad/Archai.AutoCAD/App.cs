using System;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.Runtime;
using Autodesk.Windows;
using Archai.Plugins.Windows;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;

[assembly: ExtensionApplication(typeof(Archai.AutoCAD.App))]
[assembly: CommandClass(typeof(Archai.AutoCAD.Commands))]
[assembly: CommandClass(typeof(Archai.AutoCAD.LiveCommands))]

namespace Archai.AutoCAD;

/// <summary>Adds the ArchAI ribbon tab once AutoCAD's ribbon exists.</summary>
public sealed class App : IExtensionApplication
{
    public void Initialize()
    {
        // accoreconsole has no ribbon (nor AdWindows): the commands still load.
        try { Hook(); } catch { }
    }

    private void Hook()
    {
        if (ComponentManager.Ribbon != null) AddTab();
        else ComponentManager.ItemInitialized += OnRibbon;
    }

    public void Terminate() { }

    private void OnRibbon(object? sender, RibbonItemEventArgs e)
    {
        if (ComponentManager.Ribbon == null) return;
        ComponentManager.ItemInitialized -= OnRibbon;
        AddTab();
    }

    private static void AddTab()
    {
        var ribbon = ComponentManager.Ribbon;
        if (ribbon == null || ribbon.FindTab("ARCHAI_TAB") != null) return;
        var tab = new RibbonTab { Title = "ArchAI", Id = "ARCHAI_TAB" };
        tab.Panels.Add(Panel("ArchAI",
            Button("Send to\nArchAI", "ARCHAIEXPORT", "export", "Save the drawing's 3D objects as an .AIR file to open in ArchAI."),
            Button("Open\n.AIR", "ARCHAIIMPORT", "import", "Bring an ArchAI .AIR file into this drawing: one block per element, a layer per level.")));
        tab.Panels.Add(Panel("Live Bridge",
            Button("Live\nBridge", "ARCHAILIVE", "sync", "Sync this drawing with the project open in the ArchAI desktop app as you work: your 3D objects go to ArchAI, ArchAI's model comes back on the ArchAI Live layers. Click again to stop.")));
        tab.Panels.Add(Panel("VR",
            Button("Open\nin VR", "ARCHAIVR", "vr", "Walk through the drawing's 3D objects in a VR headset (Meta Quest Browser) or any browser. Named perspective views and cameras become stops.")));
        tab.Panels.Add(Panel("Web", Button("ArchAI\nWeb", "ARCHAIWEB", "web", "Open the ArchAI web app in your browser.")));
        ribbon.Tabs.Add(tab);
    }

    private static RibbonPanel Panel(string title, params RibbonButton[] buttons)
    {
        var source = new RibbonPanelSource { Title = title };
        foreach (var button in buttons) source.Items.Add(button);
        return new RibbonPanel { Source = source };
    }

    private static RibbonButton Button(string text, string command, string icon, string tip) => new RibbonButton
    {
        Text = text,
        ShowText = true,
        ShowImage = true,
        Size = RibbonItemSize.Large,
        Orientation = System.Windows.Controls.Orientation.Vertical,
        LargeImage = ArchaiIcons.Load(icon, 32),
        Image = ArchaiIcons.Load(icon, 16),
        ToolTip = new RibbonToolTip { Title = text.Replace("\n", " "), Content = tip, Command = command },
        CommandParameter = "_." + command + " ",
        CommandHandler = new SendCommand(),
    };

    private sealed class SendCommand : System.Windows.Input.ICommand
    {
#pragma warning disable CS0067
        public event EventHandler? CanExecuteChanged;
#pragma warning restore CS0067
        public bool CanExecute(object? parameter) => true;
        public void Execute(object? parameter)
        {
            if (parameter is RibbonButton { CommandParameter: string command })
                AcApp.DocumentManager.MdiActiveDocument?.SendStringToExecute(command, true, false, false);
        }
    }
}
