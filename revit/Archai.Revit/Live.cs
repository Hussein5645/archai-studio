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
/// Live link with the ArchAI desktop app (Archai.Plugins.LiveLink): the model goes to the open ArchAI
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
            ArchaiDialog.Show("Live link", "Open a Revit project to link it with ArchAI.");
            return Result.Cancelled;
        }
        if (Live.Current != null && Live.Current.Doc.Equals(doc))
        {
            Live.Current.Dispose();
            ArchaiDialog.Show("Live link", "The live link with ArchAI is off. The ArchAI Live shapes stay in the model until you delete them.");
            return Result.Succeeded;
        }
        Live.Current?.Dispose();
        Live.Current = new Live(data.Application, doc);
        ArchaiDialog.Show("Live link", "The live link with ArchAI is on.\n\nChanges you make go to the project open in the ArchAI desktop app a moment later, and ArchAI's model comes back as ArchAI Live generic models. Click Live link again to stop.");
        return Result.Succeeded;
    }
}

internal sealed class Live : IDisposable, IExternalEventHandler
{
    public const string ApplicationId = "ArchAI Live";
    public static Live? Current;

    public readonly Document Doc;
    private readonly UIApplication ui;
    private readonly LiveLink link;
    private readonly LiveProgress progress = new LiveProgress("Revit");
    private readonly ExternalEvent wake;
    private readonly ConcurrentQueue<Action> queue = new ConcurrentQueue<Action>();
    private readonly Dictionary<string, ElementId> materials = new Dictionary<string, ElementId>();

    public Live(UIApplication ui, Document doc)
    {
        this.ui = ui;
        Doc = doc;
        wake = ExternalEvent.Create(this);
        var name = Path.GetFileNameWithoutExtension(string.IsNullOrEmpty(doc.PathName) ? doc.Title : doc.PathName);
        link = new LiveLink("revit:" + (string.IsNullOrEmpty(doc.PathName) ? doc.Title : doc.PathName), "Revit", name)
        {
            OnHost = action => { queue.Enqueue(action); wake.Raise(); },
            Export = () => new ArchaiExporter(doc).Export(),
            Import = Replace,
        };
        // Slow syncs (a first sync, a big model) show a progress window; quick ones do not.
        link.SyncProgress = progress.Report;
        link.SyncFinished = progress.Finished;
        ui.Application.DocumentChanged += Changed;
        ui.Application.DocumentClosing += Closing;
        link.Start();
    }

    public string GetName() => "ArchAI live link";

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
        if (e.GetTransactionNames().Any(n => n == "ArchAI live link")) return;
        link.ModelChanged();
    }

    private void Closing(object? sender, DocumentClosingEventArgs e)
    {
        if (e.Document.Equals(Doc)) Dispose();
    }

    /// <summary>ArchAI's model as DirectShapes, replacing the previous ones.</summary>
    private void Replace(AirFile.Contents contents)
    {
        using var t = new Transaction(Doc, "ArchAI live link");
        t.Start();
        var old = new FilteredElementCollector(Doc).OfClass(typeof(DirectShape)).Cast<DirectShape>().Where(IsLive).Select(s => s.Id).ToList();
        if (old.Count > 0) Doc.Delete(old);
        foreach (var item in contents.Objects)
        {
            try
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
                var geometry = builder.GetBuildResult().GetGeometricalObjects();
                if (geometry.Count == 0) continue;
                var shape = DirectShape.CreateElement(Doc, new ElementId(BuiltInCategory.OST_GenericModel));
                shape.ApplicationId = ApplicationId;
                shape.ApplicationDataId = item.Type;
                shape.SetShape(geometry);
                shape.Name = Clean("ArchAI " + item.Name);
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
