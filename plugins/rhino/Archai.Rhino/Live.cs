using System;
using System.IO;
using Rhino;
using Rhino.Commands;
using Rhino.DocObjects;
using Archai.Plugins;

namespace Archai.Rhino;

/// <summary>
/// ArchaiLive: the live link with the ArchAI desktop app (Archai.Plugins.LiveLink). Rhino's model
/// goes to the open ArchAI project after each edit; ArchAI's model comes back as meshes on the
/// "ArchAI Live" layer, replaced on every update (and never sent back).
/// </summary>
public sealed class ArchaiLiveCommand : Command
{
    public override string EnglishName => "ArchaiLive";
    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        if (Live.Current != null && Live.Current.Doc == doc)
        {
            Live.Current.Dispose();
            RhinoApp.WriteLine("ArchAI live link is off.");
            return Result.Success;
        }
        Live.Current?.Dispose();
        Live.Current = new Live(doc);
        RhinoApp.WriteLine("ArchAI live link is on: edits go to the project open in the ArchAI desktop app, and its model comes back on the \"ArchAI Live\" layer. Run ArchaiLive again to stop.");
        return Result.Success;
    }
}

internal sealed class Live : IDisposable
{
    public const string LayerName = "ArchAI Live";
    public static Live? Current;
    /// <summary>Status line changes (the panel shows them).</summary>
    public static event Action<string>? StatusChanged;
    public static string Status => Current?.link.LastStatus ?? "Off";

    public readonly RhinoDoc Doc;
    private readonly LiveLink link;
    private readonly RhinoLiveProgress progress = new RhinoLiveProgress();
    private string lastPrinted = "";

    public Live(RhinoDoc doc)
    {
        Doc = doc;
        var name = Path.GetFileNameWithoutExtension(doc.Name ?? "Rhino model");
        var key = "rhino:" + (string.IsNullOrEmpty(doc.Path) ? "unsaved:" + doc.RuntimeSerialNumber : doc.Path);
        link = new LiveLink(key, "Rhino", name)
        {
            OnHost = action => RhinoApp.InvokeOnUiThread(action),
            Export = () => Exchange.Write(name, "Rhino", RhinoApp.ExeVersion.ToString(), doc.Path ?? "", RhinoScene.Collect(doc, skipLive: true), out _),
            Import = contents =>
            {
                // ArchAI's model is not part of Rhino's undo history.
                var recording = doc.UndoRecordingEnabled;
                doc.UndoRecordingEnabled = false;
                try
                {
                    RhinoScene.ClearLive(doc);
                    RhinoScene.Import(doc, contents, LayerName, live: true);
                }
                finally { doc.UndoRecordingEnabled = recording; }
            },
        };
        link.StatusChanged = status =>
        {
            StatusChanged?.Invoke(status);
            var kind = status.Split('·')[0].Trim();
            if (kind == lastPrinted) return;
            lastPrinted = kind;
            RhinoApp.InvokeOnUiThread(new Action(() => RhinoApp.WriteLine("ArchAI: " + status)));
        };
        // Slow syncs (a first sync, a big model) show in the status bar's progress meter.
        link.SyncProgress = progress.Report;
        link.SyncFinished = progress.Finished;
        RhinoDoc.AddRhinoObject += Added;
        RhinoDoc.DeleteRhinoObject += Deleted;
        RhinoDoc.ReplaceRhinoObject += Replaced;
        RhinoDoc.ModifyObjectAttributes += Modified;
        RhinoDoc.CloseDocument += Closed;
        link.Start();
    }

    private void Changed(RhinoDoc? doc, RhinoObject? obj)
    {
        if (doc != Doc || link.Importing || (obj != null && RhinoScene.IsLive(obj.Attributes))) return;
        link.ModelChanged();
    }

    private void Added(object? sender, RhinoObjectEventArgs e) => Changed(e.TheObject?.Document, e.TheObject);
    private void Deleted(object? sender, RhinoObjectEventArgs e) => Changed(e.TheObject?.Document, e.TheObject);
    private void Replaced(object? sender, RhinoReplaceObjectEventArgs e) => Changed(e.Document, e.NewRhinoObject);
    private void Modified(object? sender, RhinoModifyObjectAttributesEventArgs e) => Changed(e.Document, e.RhinoObject);
    private void Closed(object? sender, DocumentEventArgs e)
    {
        if (e.Document == Doc) Dispose();
    }

    public void Dispose()
    {
        if (Current == this) Current = null;
        RhinoDoc.AddRhinoObject -= Added;
        RhinoDoc.DeleteRhinoObject -= Deleted;
        RhinoDoc.ReplaceRhinoObject -= Replaced;
        RhinoDoc.ModifyObjectAttributes -= Modified;
        RhinoDoc.CloseDocument -= Closed;
        link.Dispose();
        progress.Dispose();
        StatusChanged?.Invoke("Off");
    }
}
