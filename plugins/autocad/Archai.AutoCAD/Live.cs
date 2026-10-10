using System;
using System.Collections.Concurrent;
using System.IO;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Runtime;
using Archai.Plugins;
using Archai.Plugins.Windows;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;

namespace Archai.AutoCAD;

/// <summary>
/// ARCHAILIVE: the Live Bridge with the ArchAI desktop app (Archai.Plugins.LiveLink). The drawing's
/// 3D objects go to the open ArchAI project after each edit; ArchAI's model comes back as blocks
/// on "ArchAI Live" layers, replaced on every update (and never sent back).
/// </summary>
public sealed class LiveCommands
{
    [CommandMethod("ARCHAILIVE", CommandFlags.Session)]
    public void Toggle()
    {
        var doc = AcApp.DocumentManager.MdiActiveDocument;
        if (doc == null) return;
        if (Live.Current != null && Live.Current.Document == doc)
        {
            Live.Current.Dispose();
            doc.Editor.WriteMessage("\nArchAI Live Bridge is off.\n");
            return;
        }
        Live.Current?.Dispose();
        Live.Current = new Live(doc);
        doc.Editor.WriteMessage("\nArchAI Live Bridge is on: edits go to the project open in the ArchAI desktop app, and its model comes back on the \"ArchAI Live\" layers. Run ARCHAILIVE again to stop.\n");
    }
}

internal sealed class Live : IDisposable
{
    public const string LayerPrefix = "ArchAI Live";
    public static Live? Current;

    public readonly Document Document;
    private readonly LiveLink link;
    private readonly LiveProgress progress = new LiveProgress("AutoCAD");
    private readonly ConcurrentQueue<Action> queue = new ConcurrentQueue<Action>();
    private bool idleHooked;
    private string lastShown = "";

    public Live(Document doc)
    {
        Document = doc;
        link = new LiveLink("autocad:" + doc.Name, "AutoCAD", Path.GetFileNameWithoutExtension(doc.Name))
        {
            OnHost = Enqueue,
            Export = () => Exchange.Write(Path.GetFileNameWithoutExtension(doc.Name), "AutoCAD", AcApp.Version.ToString(), doc.Name, DrawingScene.Collect(doc.Database, skipLive: true), out _),
            Import = contents =>
            {
                using (doc.LockDocument())
                {
                    DrawingScene.ClearLive(doc.Database);
                    DrawingScene.Import(doc.Database, contents, LayerPrefix);
                }
                doc.Editor.Regen();
            },
            // Live Bridge: element by element, and every entity id (hiding deletes nothing in ArchAI).
            Apply = delta =>
            {
                using (doc.LockDocument()) DrawingBridge.Apply(doc.Database, delta);
                doc.Editor.Regen();
            },
            AllIds = () => DrawingBridge.AllIds(doc.Database),
        };
        link.StatusChanged = status => Enqueue(() => Show(status));
        // Slow syncs (a first sync, a big drawing) show a progress window; quick ones do not.
        link.SyncProgress = progress.Report;
        link.SyncFinished = progress.Finished;
        doc.Database.ObjectAppended += Changed;
        doc.Database.ObjectModified += Changed;
        doc.Database.ObjectErased += Changed;
        doc.BeginDocumentClose += Closing;
        link.Start();
    }

    private void Changed(object? sender, EventArgs e)
    {
        if (!link.Importing) link.ModelChanged();
    }

    private void Closing(object? sender, DocumentBeginCloseEventArgs e) => Dispose();

    /// <summary>Runs on AutoCAD's main thread, when it is idle.</summary>
    private void Enqueue(Action action)
    {
        queue.Enqueue(action);
        if (idleHooked) return;
        idleHooked = true;
        AcApp.Idle += Drain;
    }

    private void Drain(object? sender, EventArgs e)
    {
        AcApp.Idle -= Drain;
        idleHooked = false;
        while (queue.TryDequeue(out var action))
        {
            try { action(); }
            catch (System.Exception ex) { Show("Live Bridge: " + ex.Message); }
        }
    }

    private void Show(string status)
    {
        // The command line gets state changes, not every sync.
        var kind = status.Split('·')[0].Trim();
        if (kind == lastShown) return;
        lastShown = kind;
        try { Document.Editor.WriteMessage("\nArchAI: " + status + "\n"); } catch { }
    }

    public void Dispose()
    {
        if (Current == this) Current = null;
        progress.Dispose();
        try
        {
            Document.Database.ObjectAppended -= Changed;
            Document.Database.ObjectModified -= Changed;
            Document.Database.ObjectErased -= Changed;
            Document.BeginDocumentClose -= Closing;
        }
        catch { }
        link.Dispose();
    }
}
