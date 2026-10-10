using System;
using System.IO;
using Rhino;
using Rhino.Commands;
using Rhino.DocObjects;
using Archai.Plugins;

namespace Archai.Rhino;

/// <summary>
/// ArchaiLive: the Live Bridge with the ArchAI desktop app (Archai.Plugins.LiveLink). Rhino's model
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
            RhinoApp.WriteLine("ArchAI Live Bridge is off.");
            return Result.Success;
        }
        Live.Current?.Dispose();
        Live.Current = new Live(doc);
        RhinoApp.WriteLine("ArchAI Live Bridge is on: edits go to the project open in the ArchAI desktop app, and its model comes back on the \"ArchAI Live\" layer. Run ArchaiLive again to stop.");
        return Result.Success;
    }
}

/// <summary>ArchaiLinkProject: choose the ArchAI project this model syncs with (ArchAI shows its projects).</summary>
public sealed class ArchaiLinkProjectCommand : Command
{
    public override string EnglishName => "ArchaiLinkProject";
    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        var link = Live.Current?.Doc == doc ? Live.Current.Link : Live.NewLink(doc);
        RhinoApp.WriteLine("ArchAI: choose the project in ArchAI.");
        _ = System.Threading.Tasks.Task.Run(async () =>
        {
            string text;
            try { text = await link.ChooseProjectAsync().ConfigureAwait(false) is { } project ? $"ArchAI: this model is linked to {project.Name}." : "ArchAI: Link to project cancelled."; }
            catch (Exception error) { text = "ArchAI Link to project: " + error.Message + " (is the ArchAI desktop app running?)"; }
            RhinoApp.InvokeOnUiThread(new Action(() => RhinoApp.WriteLine(text)));
        });
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
    public LiveLink Link => link;

    /// <summary>A link for this model that is not running (to choose its project).</summary>
    public static LiveLink NewLink(RhinoDoc doc) => new LiveLink(Key(doc), "Rhino", Path.GetFileNameWithoutExtension(doc.Name ?? "Rhino model"));

    private static string Key(RhinoDoc doc) => "rhino:" + (string.IsNullOrEmpty(doc.Path) ? "unsaved:" + doc.RuntimeSerialNumber : doc.Path);
    private readonly RhinoLiveProgress progress = new RhinoLiveProgress();
    private string lastPrinted = "";

    public Live(RhinoDoc doc)
    {
        Doc = doc;
        var name = Path.GetFileNameWithoutExtension(doc.Name ?? "Rhino model");
        var key = Key(doc);
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
            // Live Bridge: element by element, and every object id (hiding deletes nothing in ArchAI).
            Apply = delta =>
            {
                var recording = doc.UndoRecordingEnabled;
                doc.UndoRecordingEnabled = false;
                try { RhinoScene.Apply(doc, delta, LayerName); }
                finally { doc.UndoRecordingEnabled = recording; }
            },
            AllIds = () => RhinoScene.AllIds(doc),
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
        if (doc != Doc || link.Importing) return;
        if (obj != null && RhinoScene.IsLive(obj.Attributes))
        {
            // Another app's geometry moved, edited, copied or deleted here: ArchAI's version is put back.
            if (obj.Attributes.GetUserString("archai.id") is { Length: > 0 } archaiId) link.Reset(new[] { archaiId });
            return;
        }
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
