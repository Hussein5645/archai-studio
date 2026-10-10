using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Archai.Plugins;
using Archai.Plugins.Windows;

namespace Archai.Revit;

/// <summary>
/// Live Bridge with the ArchAI desktop app (Archai.Plugins.LiveLink): the model goes to the open ArchAI
/// project (as Send to ArchAI writes it) after each change, and ArchAI's model comes back as
/// DirectShapes (Generic Models, ApplicationId "ArchAI Live"), replaced on every update and never
/// sent back. The button toggles it.
/// </summary>
[Transaction(TransactionMode.Manual)]
public sealed class LiveCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
    {
        var doc = data.Application.ActiveUIDocument?.Document;
        if (doc == null || doc.IsFamilyDocument)
        {
            ArchaiDialog.Show("Live Bridge", "Open a Revit project to link it with ArchAI.");
            return Result.Cancelled;
        }
        if (Live.Current != null && Live.Current.Doc.Equals(doc))
        {
            Live.Current.Dispose();
            ArchaiDialog.Show("Live Bridge", "The Live Bridge with ArchAI is off. The ArchAI Live shapes stay in the model until you delete them.");
            return Result.Succeeded;
        }
        Live.Current?.Dispose();
        Live.Current = new Live(data.Application, doc);
        ArchaiDialog.Show("Live Bridge", "The Live Bridge with ArchAI is on.\n\nChanges you make go to the project open in the ArchAI desktop app a moment later, and ArchAI's model comes back as ArchAI Live generic models. Click Live Bridge again to stop.");
        return Result.Succeeded;
    }
}

/// <summary>Link to project: choose the ArchAI project this model syncs with (ArchAI shows its projects).</summary>
[Transaction(TransactionMode.Manual)]
public sealed class LinkProjectCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
    {
        var doc = data.Application.ActiveUIDocument?.Document;
        if (doc == null || doc.IsFamilyDocument)
        {
            ArchaiDialog.Show("Link to project", "Open a Revit project to link it with ArchAI.");
            return Result.Cancelled;
        }
        var link = Live.Current != null && Live.Current.Doc.Equals(doc) ? Live.Current.Link : Live.NewLink(doc);
        try
        {
            // ArchAI comes to the front with its projects; Revit waits for the choice.
            var project = System.Threading.Tasks.Task.Run(() => link.ChooseProjectAsync()).GetAwaiter().GetResult();
            ArchaiDialog.Show("Link to project", project is { } p ? $"This model is linked to the ArchAI project {p.Name}. The Live Bridge syncs with it from now on." : "Cancelled: the link did not change.");
            return Result.Succeeded;
        }
        catch (Exception error)
        {
            ArchaiDialog.Show("Link to project", error.Message + "\n\nIs the ArchAI desktop app running?");
            return Result.Failed;
        }
    }
}

/// <summary>Pause / resume the Live Bridge: work in Revit undisturbed; resuming sends what changed meanwhile.</summary>
[Transaction(TransactionMode.Manual)]
public sealed class PauseCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
    {
        var live = Live.Current;
        if (live == null)
        {
            ArchaiDialog.Show("Live Bridge", "The Live Bridge is off. Turn it on with Live Bridge first.");
            return Result.Cancelled;
        }
        if (live.Link.Paused)
        {
            live.Link.Resume();
            ArchaiDialog.Show("Live Bridge", "The Live Bridge is syncing again. What you changed meanwhile is sent now.");
        }
        else
        {
            live.Link.Pause();
            ArchaiDialog.Show("Live Bridge", "The Live Bridge is paused: work in Revit undisturbed. Click Pause again to resume; your changes are sent then.");
        }
        return Result.Succeeded;
    }
}

internal sealed class Live : IDisposable, IExternalEventHandler
{
    public const string ApplicationId = "ArchAI Live";
    /// <summary>Editable copies of ArchAI elements: sent back to ArchAI as copies.</summary>
    public const string CopyApplicationId = "ArchAI Copy";
    public static Live? Current;

    public readonly Document Doc;
    private readonly UIApplication ui;
    private readonly LiveLink link;
    public LiveLink Link => link;

    /// <summary>A link for this model that is not running (to choose its project).</summary>
    public static LiveLink NewLink(Document doc) => new LiveLink("revit:" + (string.IsNullOrEmpty(doc.PathName) ? doc.Title : doc.PathName), "Revit", Path.GetFileNameWithoutExtension(string.IsNullOrEmpty(doc.PathName) ? doc.Title : doc.PathName));
    private readonly LiveProgress progress = new LiveProgress("Revit");
    private readonly ExternalEvent wake;
    private readonly ConcurrentQueue<Action> queue = new ConcurrentQueue<Action>();
    private readonly Dictionary<string, ElementId> materials = new Dictionary<string, ElementId>();
    /// <summary>ArchAI Live shapes in this model: element id → ArchAI element (edits to them are reset).</summary>
    private readonly Dictionary<long, string> liveShapes = new Dictionary<long, string>();
    /// <summary>Elements added or changed since the last sync.</summary>
    private readonly HashSet<long> changed = new HashSet<long>();
    private bool wholeModelSent;
    private bool firstSyncDone;

    public Live(UIApplication ui, Document doc)
    {
        this.ui = ui;
        Doc = doc;
        wake = ExternalEvent.Create(this);
        var name = Path.GetFileNameWithoutExtension(string.IsNullOrEmpty(doc.PathName) ? doc.Title : doc.PathName);
        link = new LiveLink("revit:" + (string.IsNullOrEmpty(doc.PathName) ? doc.Title : doc.PathName), "Revit", name)
        {
            OnHost = action => { queue.Enqueue(action); wake.Raise(); },
            // Generic meshes, and after the first sync only what changed (fast, so Revit is not held up).
            Export = ExportChanges,
            Import = Replace,
            // Live Bridge: element by element, and every element id (hiding deletes nothing in ArchAI).
            Apply = ApplyDelta,
            AllIds = () => new FilteredElementCollector(doc).WhereElementIsNotElementType().ToElementIds().Select(id => "e" + id.Value).ToList(),
        };
        // Only the first sync (the whole model) shows a progress window; later syncs are quiet.
        link.SyncProgress = (text, fraction) => { if (!firstSyncDone) progress.Report(text, fraction); };
        link.SyncFinished = () =>
        {
            progress.Finished();
            if (link.LastStatus.StartsWith("Updated") || link.LastStatus.StartsWith("Sent")) firstSyncDone = true;
        };
        ui.Application.DocumentChanged += Changed;
        ui.Application.DocumentClosing += Closing;
        link.Start();
    }

    public string GetName() => "ArchAI Live Bridge";

    public void Execute(UIApplication app)
    {
        while (queue.TryDequeue(out var action))
        {
            try { action(); }
            catch (Exception) { /* reported by the link */ }
        }
    }

    private void Changed(object? sender, DocumentChangedEventArgs e)
    {
        if (link.Importing || !e.GetDocument().Equals(Doc)) return;
        if (e.GetTransactionNames().Any(n => n == "ArchAI Live Bridge")) return;
        // Another app's geometry (ArchAI Live shapes) edited or deleted here: put back as ArchAI has it.
        var reset = new List<string>();
        foreach (var id in e.GetModifiedElementIds().Concat(e.GetDeletedElementIds()))
        {
            if (liveShapes.TryGetValue(id.Value, out var archaiId)) reset.Add(archaiId);
        }
        if (reset.Count > 0) link.Reset(reset);
        lock (changed)
        {
            foreach (var id in e.GetAddedElementIds().Concat(e.GetModifiedElementIds()))
                if (!liveShapes.ContainsKey(id.Value)) changed.Add(id.Value);
        }
        if (reset.Count == 0 || changed.Count > 0) link.ModelChanged();
    }

    /// <summary>The model as generic meshes: everything on the first sync, then only what changed.</summary>
    private Newtonsoft.Json.Linq.JObject ExportChanges()
    {
        List<long>? only = null;
        if (wholeModelSent)
        {
            lock (changed)
            {
                only = changed.ToList();
                changed.Clear();
            }
        }
        var exchange = new ArchaiExporter(Doc) { MeshesOnly = true, Only = only }.Export();
        wholeModelSent = true;
        return exchange;
    }

    private void Closing(object? sender, DocumentClosingEventArgs e)
    {
        if (e.Document.Equals(Doc)) Dispose();
    }

    /// <summary>ArchAI's model as DirectShapes, replacing the previous ones.</summary>
    private void Replace(AirFile.Contents contents)
    {
        using var t = new Transaction(Doc, "ArchAI Live Bridge");
        t.Start();
        var old = new FilteredElementCollector(Doc).OfClass(typeof(DirectShape)).Cast<DirectShape>().Where(IsLive).Select(s => s.Id).ToList();
        if (old.Count > 0) Doc.Delete(old);
        foreach (var item in contents.Objects)
        {
            try { Create(item, ApplicationId); }
            catch (Exception) { /* one element that Revit cannot take does not stop the rest */ }
        }
        t.Commit();
    }

    /// <summary>An ArchAI element's triangles as DirectShape geometry (empty when Revit can take none).</summary>
    private IList<GeometryObject> Geometry(ImportObject item)
    {
        var builder = new TessellatedShapeBuilder { Target = TessellatedShapeBuilderTarget.Mesh, Fallback = TessellatedShapeBuilderFallback.Salvage };
        builder.OpenConnectedFaceSet(false);
        foreach (var part in item.Parts)
        {
            var material = MaterialFor(part.Material);
            XYZ P(int index)
            {
                // glTF metres (x, up, plan y) to Revit feet (X, -plan y, up).
                var (x, y, z) = HostAxes.ToZUp(part.Positions[index * 3], part.Positions[index * 3 + 1], part.Positions[index * 3 + 2], 304.8);
                return new XYZ(x, y, z);
            }
            for (int i = 0; i + 2 < part.Indices.Length; i += 3)
            {
                var a = P(part.Indices[i]);
                var b = P(part.Indices[i + 1]);
                var c = P(part.Indices[i + 2]);
                if (a.IsAlmostEqualTo(b) || b.IsAlmostEqualTo(c) || a.IsAlmostEqualTo(c)) continue;
                builder.AddFace(new TessellatedFace(new List<XYZ> { a, b, c }, material));
            }
        }
        builder.CloseConnectedFaceSet();
        builder.Build();
        return builder.GetBuildResult().GetGeometricalObjects();
    }

    /// <summary>A DirectShape for an ArchAI element (Generic Model), tagged with its element id.</summary>
    private DirectShape? Create(ImportObject item, string applicationId)
    {
        var geometry = Geometry(item);
        if (geometry.Count == 0) return null;
        var shape = DirectShape.CreateElement(Doc, new ElementId(BuiltInCategory.OST_GenericModel));
        shape.ApplicationId = applicationId;
        shape.ApplicationDataId = item.ArchaiId.Length > 0 ? item.ArchaiId : item.Type;
        shape.SetShape(geometry);
        shape.Name = Clean("ArchAI " + item.Name);
        if (applicationId == ApplicationId && item.ArchaiId.Length > 0) liveShapes[shape.Id.Value] = item.ArchaiId;
        return shape;
    }

    /// <summary>
    /// A Live Bridge pull, element by element: ArchAI's elements as ArchAI Live DirectShapes
    /// (replaced or removed one by one), editable copies as "ArchAI Copy" DirectShapes (sent back
    /// as copies; reshaped in place, keeping their id), and ArchAI's moves of the model's own
    /// elements (where Revit does not own their position). Names stay Revit's (types and families).
    /// </summary>
    private void ApplyDelta(BridgeDelta delta)
    {
        using var t = new Transaction(Doc, "ArchAI Live Bridge");
        t.Start();
        var shapes = new FilteredElementCollector(Doc).OfClass(typeof(DirectShape)).Cast<DirectShape>().ToList();
        if (delta.Fresh) Doc.Delete(shapes.Where(IsLive).Select(s => s.Id).ToList());
        if (delta.Fresh) liveShapes.Clear();
        var live = shapes.Where(s => IsLive(s) && !delta.Fresh).GroupBy(s => s.ApplicationDataId ?? "").ToDictionary(g => g.Key, g => g.Select(s => s.Id).ToList());
        foreach (var shape in shapes.Where(s => IsLive(s) && !delta.Fresh && !string.IsNullOrEmpty(s.ApplicationDataId))) liveShapes[shape.Id.Value] = shape.ApplicationDataId;
        var copies = shapes.Where(s => s.ApplicationId == CopyApplicationId).GroupBy(s => s.ApplicationDataId ?? "").ToDictionary(g => g.Key, g => g.First());
        void Remove(string archaiId)
        {
            if (!live.TryGetValue(archaiId, out var ids)) return;
            foreach (var id in ids) liveShapes.Remove(id.Value);
            Doc.Delete(ids.Where(id => Doc.GetElement(id) != null).ToList());
            live.Remove(archaiId);
        }
        foreach (var removed in delta.Removed) Remove(removed);
        foreach (var update in delta.Updates)
        {
            if (update.Move == null || update.Ref.Length < 2 || update.Ref[0] != 'e' || !long.TryParse(update.Ref.Substring(1), out var value)) continue;
            var id = new ElementId(value);
            if (Doc.GetElement(id) == null) continue;
            var (x, y, z) = HostAxes.MoveToZUp(update.Move, 304.8);
            try { ElementTransformUtils.MoveElement(Doc, id, new XYZ(x, y, z)); } catch (Exception) { /* pinned or hosted: stays */ }
        }
        foreach (var node in delta.Nodes)
        {
            try
            {
                var target = (string?)node.Archai["ref"];
                DirectShape? copy = null;
                if (target != null && target.StartsWith("e") && long.TryParse(target.Substring(1), out var value)) copy = Doc.GetElement(new ElementId(value)) as DirectShape;
                copy ??= copies.TryGetValue(node.ArchaiId, out var existing) ? existing : null;
                if (copy != null)
                {
                    var geometry = Geometry(node);
                    if (geometry.Count > 0) copy.SetShape(geometry);
                    continue;
                }
                Remove(node.ArchaiId);
                Create(node, node.Archai["editable"] is Newtonsoft.Json.Linq.JArray ? CopyApplicationId : ApplicationId);
            }
            catch (Exception) { /* one element that Revit cannot take does not stop the rest */ }
        }
        t.Commit();
    }

    /// <summary>Revit names refuse \ : { } [ ] | ; &lt; &gt; ? ` ~.</summary>
    private static string Clean(string name)
    {
        var cleaned = new string(name.Select(c => "\\:{}[]|;<>?`~".IndexOf(c) >= 0 || char.IsControl(c) ? '_' : c).ToArray()).Trim();
        if (cleaned.Length == 0) cleaned = "ArchAI";
        return cleaned.Length <= 120 ? cleaned : cleaned.Substring(0, 120);
    }

    public static bool IsLive(Element element) => element is DirectShape shape && shape.ApplicationId == ApplicationId;

    private ElementId MaterialFor(GlbMaterial m)
    {
        var name = Clean("ArchAI " + m.Name);
        if (materials.TryGetValue(name, out var id) && Doc.GetElement(id) != null) return id;
        var existing = new FilteredElementCollector(Doc).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(x => x.Name == name);
        if (existing == null)
        {
            id = Material.Create(Doc, name);
            var material = (Material)Doc.GetElement(id);
            material.Color = new Color((byte)Math.Round(m.R * 255), (byte)Math.Round(m.G * 255), (byte)Math.Round(m.B * 255));
            material.Transparency = (int)Math.Round((1 - m.Opacity) * 100);
        }
        else id = existing.Id;
        return materials[name] = id;
    }

    public void Dispose()
    {
        if (Current == this) Current = null;
        progress.Dispose();
        ui.Application.DocumentChanged -= Changed;
        ui.Application.DocumentClosing -= Closing;
        link.Dispose();
        wake.Dispose();
    }
}
