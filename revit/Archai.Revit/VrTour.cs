using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Archai.Plugins;
using Archai.Plugins.Windows;

namespace Archai.Revit;

/// <summary>
/// "Open in VR": the model and a tour in the SJP-VR viewer format, uploaded to ArchAI's VR share
/// service exactly like ArchAI's VR link (plugins/dotnet/Archai.Plugins.Core), then opened as the
/// short link a headset (Meta Quest Browser) can open. Stops are the model's perspective cameras and
/// its placed rooms. Publishing the same model again keeps its link.
/// </summary>
[Transaction(TransactionMode.ReadOnly)]
public sealed class VrCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
    {
        var ui = data.Application.ActiveUIDocument;
        var doc = ui?.Document;
        if (doc == null || doc.IsFamilyDocument)
        {
            ArchaiDialog.Show("Open in VR", "Open a Revit project to see it in VR.");
            return Result.Cancelled;
        }
        var share = VrShare.Config("Revit");
        if (share == null)
        {
            ArchaiDialog.Show("Open in VR", VrShare.NoKey);
            return Result.Cancelled;
        }
        try
        {
            VrTour.Result tour;
            VrShare.Published link;
            using (var progress = new ArchaiProgress("Open in VR"))
            {
                progress.Report("Collecting the model's geometry...");
                tour = VrModel.Build(doc, ui!.ActiveView, out var scoped);
                if (tour.Model.Length == 0)
                {
                    progress.Dispose();
                    ArchaiDialog.Show("Open in VR", "There is no model geometry to show" + (scoped ? " in this 3D view." : "."));
                    return Result.Cancelled;
                }
                progress.Report($"Uploading {Math.Max(1, tour.Model.Length / 1048576)} MB to the VR viewer...");
                var key = "revit|" + (string.IsNullOrEmpty(doc.PathName) ? "unsaved:" + doc.Title : doc.PathName);
                link = progress.Run(() => VrShare.Publish(share, key, tour.Model, tour.Json));
            }
            VrShare.OpenInBrowser(link.Url);
            try { System.Windows.Clipboard.SetText(link.Url); } catch { }
            ArchaiDialog.Show("Opened in VR", VrShare.Message((string)tour.Json["name"]!, tour, link), link.Url);
            return Result.Succeeded;
        }
        catch (Exception ex)
        {
            message = (ex is AggregateException { InnerException: not null } aggregate ? aggregate.InnerException! : ex).Message;
            return Result.Failed;
        }
    }
}

/// <summary>The VR tour of a Revit model.</summary>
internal static class VrModel
{
    private const double Metres = 0.3048;

    // Revit feet → viewer metres: x = Revit X, z = plan y (-Revit Y), as ArchAI's scene.
    private static (double X, double Z) Scene(XYZ p) => (p.X * Metres, -p.Y * Metres);

    public static VrTour.Result Build(Document doc, View? active, out bool scoped)
    {
        // An orthographic 3D view limits the model to what it shows (hidden categories stay out).
        var view = active is View3D { IsTemplate: false, IsPerspective: false } v3 ? v3 : null;
        scoped = view != null;
        var collector = (view != null ? new FilteredElementCollector(doc, view.Id) : new FilteredElementCollector(doc)).WhereElementIsNotElementType().WhereElementIsViewIndependent();
        var exporter = new ArchaiExporter(doc);
        var objects = new List<SceneObject>();
        foreach (var element in collector)
        {
            List<(GlbMaterial Material, (double X, double Y, double Z) A, (double X, double Y, double Z) B, (double X, double Y, double Z) C)> triangles;
            try { triangles = exporter.Triangles(element); } catch { continue; }
            if (triangles.Count == 0) continue;
            var item = new SceneObject { Id = "e" + element.Id.Value, Name = element.Name, Category = element.Category?.Name ?? "" };
            ArchaiPoint P((double X, double Y, double Z) p) => new ArchaiPoint(p.X, p.Y, p.Z);
            foreach (var (material, a, b, c) in triangles) item.Add(material, P(a), P(b), P(c));
            objects.Add(item);
        }
        var name = string.IsNullOrWhiteSpace(doc.Title) ? "Revit model" : Path.GetFileNameWithoutExtension(doc.Title);
        var bounds = Bounds.Of(objects);
        var result = new VrTour.Result();
        if (bounds.IsEmpty) return result;

        var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().Select(l => l.ProjectElevation * Metres).OrderBy(e => e).ToList();
        // The ground: the level closest to project zero (or the model's underside).
        var ground = levels.Count > 0 ? levels.OrderBy(Math.Abs).First() : bounds.MinZ / 1000;
        var writer = VrTour.Model(objects, bounds, ground * 1000, "ArchAI Revit plugin");

        var stops = Cameras(doc, levels);
        stops.AddRange(Rooms(doc));
        if (stops.Count == 0) stops.Add(VrTour.Outside(bounds, ground * 1000));
        stops = stops.Take(VrTour.MaxStops).ToList();
        // Start where the user is looking when they are in a camera view.
        var start = active is View3D { IsPerspective: true } camera ? stops.FirstOrDefault(s => s.Name == camera.Name) : null;
        result.Model = writer.ToGlb("ArchAI Revit plugin");
        result.Triangles = writer.TriangleCount;
        result.Json = VrTour.Json(name, "Revit model via ArchAI", stops, start);
        result.Stops = stops.Count;
        return result;
    }

    /// <summary>Perspective 3D views: the visitor stands on the level under the camera, facing its way.</summary>
    private static List<VrStop> Cameras(Document doc, List<double> levels)
    {
        var stops = new List<VrStop>();
        foreach (var view in new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>().Where(v => v.IsPerspective && !v.IsTemplate).OrderBy(v => v.Name))
        {
            try
            {
                var orientation = view.GetOrientation();
                var eye = orientation.EyePosition.Z * Metres;
                // The level under the eye when it is at standing height above one, else an eye height below it (aerial views float).
                var below = levels.Where(e => e <= eye).DefaultIfEmpty(double.NaN).Max();
                double? floor = !double.IsNaN(below) && eye - below < 3 ? below * 1000 : null;
                var e3 = orientation.EyePosition;
                var f = orientation.ForwardDirection;
                stops.Add(VrStop.FromCamera(view.Name, ArchaiPoint.FromZUp(e3.X, e3.Y, e3.Z, 304.8), ArchaiPoint.FromZUp(f.X, f.Y, f.Z, 1), floor));
            }
            catch { }
        }
        return stops;
    }

    /// <summary>Placed rooms, lowest level first: the visitor stands on the room's point, facing into the room.</summary>
    private static IEnumerable<VrStop> Rooms(Document doc)
    {
        var rooms = new List<(double Floor, string Number, VrStop Stop)>();
        foreach (var room in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).OfType<Room>())
        {
            try
            {
                if (room.Area <= 0 || !(room.Location is LocationPoint location)) continue;
                var (x, z) = Scene(location.Point);
                var floor = location.Point.Z * Metres;
                var box = room.get_BoundingBox(null);
                double lookX = x + VrStop.LookDistance, lookZ = z;
                if (box != null)
                {
                    var (cx, cz) = Scene((box.Min + box.Max) / 2);
                    var (dx, dz) = (cx - x, cz - z);
                    var length = Math.Sqrt(dx * dx + dz * dz);
                    // Towards the middle of the room, or along its longer side when standing in the middle already.
                    if (length > 0.5) (lookX, lookZ) = (x + dx / length * VrStop.LookDistance, z + dz / length * VrStop.LookDistance);
                    else if (box.Max.Y - box.Min.Y > box.Max.X - box.Min.X) (lookX, lookZ) = (x, z - VrStop.LookDistance);
                }
                var name = (room.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? "").Trim();
                var number = (room.Number ?? "").Trim();
                var label = string.Join(" ", new[] { number, name }.Where(s => s.Length > 0));
                if (label.Length > 120) label = label.Substring(0, 120);
                rooms.Add((floor, number, new VrStop { Name = label.Length > 0 ? label : "Room", X = x, Z = z, Floor = floor, LookX = lookX, LookZ = lookZ }));
            }
            catch { }
        }
        return rooms.OrderBy(r => r.Floor).ThenBy(r => r.Number, StringComparer.OrdinalIgnoreCase).Select(r => r.Stop);
    }
}
