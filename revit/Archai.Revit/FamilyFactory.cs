using System;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Archai.Air;
using Newtonsoft.Json.Linq;

namespace Archai.Revit;

internal sealed class FamilyFactory
{
    private readonly Document project;
    private readonly AirDocument source;
    private readonly string batch;
    public FamilyFactory(Document project, AirDocument source, string batch) { this.project = project; this.source = source; this.batch = batch; }
    public FamilySymbol Create(AirElement e, List<string> warnings)
    {
        string template = e.Type == "door" ? "Metric Door.rft" : e.Type == "window" ? "Metric Window.rft" : e.Type == "column" ? "Metric Column.rft" : "Metric Generic Model.rft";
        var path = FindTemplate(template);
        using var family = project.Application.NewFamilyDocument(path);
        using var closeFamily = new FamilyCloser(family);
        using (var transaction = new Transaction(family, "Create ArchAI family"))
        {
            transaction.Start();
            var manager = family.FamilyManager;
            if (manager.CurrentType == null) manager.NewType("AIR dimensions");
            double width = e.Width, height = e.P("height", e.Type == "door" ? 2100 : e.Type == "window" ? 1200 : 3000);
            if (e.Type == "door" || e.Type == "window")
            {
                foreach (FamilyParameter p in manager.Parameters)
                {
                    if (p.Definition.Name == "Width" && !p.IsReadOnly && !p.IsDeterminedByFormula) manager.Set(p, Geometry.Feet(width));
                    if (p.Definition.Name == "Height" && !p.IsReadOnly && !p.IsDeterminedByFormula) manager.Set(p, Geometry.Feet(height));
                }
                family.Regenerate();
                // Replace the template opening so its extent is explicit, even with localized parameters.
                var openings = new FilteredElementCollector(family).OfClass(typeof(Opening)).ToElementIds();
                if (openings.Count > 0) family.Delete(openings);
                var host = new FilteredElementCollector(family).OfClass(typeof(Wall)).Cast<Wall>().FirstOrDefault()
                    ?? throw new InvalidOperationException("Door/window template must contain a wall host.");
                var opening = new CurveArray();
                var corners = new[] { new XYZ(-Geometry.Feet(width) / 2, 0, 0), new XYZ(Geometry.Feet(width) / 2, 0, 0), new XYZ(Geometry.Feet(width) / 2, 0, Geometry.Feet(height)), new XYZ(-Geometry.Feet(width) / 2, 0, Geometry.Feet(height)) };
                for (int i = 0; i < 4; i++) opening.Append(Line.CreateBound(corners[i], corners[(i + 1) % 4]));
                family.FamilyCreate.NewOpening(host, opening);
                var frameDepth = e.Type == "door" ? 150 : 90;
                var bar = e.Type == "door" ? 40.0 : 50.0;
                Box(family, -width / 2, -frameDepth / 2, 0, bar, frameDepth, height, "Frame");
                Box(family, width / 2 - bar, -frameDepth / 2, 0, bar, frameDepth, height, "Frame");
                Box(family, -width / 2, -frameDepth / 2, height - bar, width, frameDepth, bar, "Frame");
                if (e.Type == "window")
                {
                    Box(family, -width / 2, -frameDepth / 2, 0, width, frameDepth, bar, "Frame");
                    Box(family, -width / 2 + bar, -6, bar, width - 2 * bar, 12, height - 2 * bar, "Glass", 75);
                    if (e.Parameters.S("mechanism", "fixed") != "fixed") warnings.Add("Window is a generated fixed frame/glass family; operation hardware is not reproduced.");
                }
                else
                {
                    var operation = e.Parameters.S("operation", "swing");
                    var away = e.Parameters.S("openingSide", "inside") == "outside" ? -1 : 1;
                    var doubleDoor = operation == "double-swing";
                    var leafWidth = doubleDoor ? width / 2 - bar : width - 2 * bar;
                    var hinges = doubleDoor ? new[] { (-width / 2 + bar, 1), (width / 2 - bar, -1) }
                        : e.Parameters.S("handing", "left") == "right" ? new[] { (width / 2 - bar, -1) } : new[] { (-width / 2 + bar, 1) };
                    foreach (var pair in hinges)
                    {
                        var hinge = pair.Item1; var direction = pair.Item2;
                        double angle = operation == "swing" || doubleDoor ? -direction * away * Math.PI * 0.45 : 0;
                        var profile = new List<XYZ>();
                        foreach (var p in new[] { new Point2(0, -20), new Point2(direction * leafWidth, -20), new Point2(direction * leafWidth, 20), new Point2(0, 20) })
                        {
                            var x = hinge + p.X * Math.Cos(angle) - p.Y * Math.Sin(angle);
                            var y = p.X * Math.Sin(angle) + p.Y * Math.Cos(angle);
                            if (operation == "sliding") { x += direction * leafWidth * 0.5; y -= away * 60; }
                            profile.Add(new XYZ(Geometry.Feet(x), Geometry.Feet(y), 0));
                        }
                        Extrude(family, profile, height - bar, "Door leaf");
                    }
                    if (operation == "folding" || operation == "revolving") warnings.Add("Folding/revolving door operation is represented with a simple leaf, matching the AIR basic 3D representation only.");
                }
                warnings.Add("Generated size-specific hosted family: editable Revit solids, fixed geometry dimensions; frame depth uses the AIR default representation.");
            }
            else if (e.Type == "column")
            {
                var shape = e.Parameters.S("shape", "rectangle");
                if (shape == "circle")
                {
                    var radius = Geometry.Feet(e.P("diameter", 500)) / 2;
                    var profile = new CurveArray();
                    profile.Append(Arc.Create(XYZ.Zero, radius, 0, Math.PI, XYZ.BasisX, XYZ.BasisY));
                    profile.Append(Arc.Create(XYZ.Zero, radius, Math.PI, 2 * Math.PI, XYZ.BasisX, XYZ.BasisY));
                    Extrude(family, profile, 0, height, "Column");
                }
                else if (shape == "custom" && e.Parameters?["profile"] is JArray points)
                    Extrude(family, points.Select(Point2.Read).Select(p => new XYZ(Geometry.Feet((p.X - 0.5) * e.Width), -Geometry.Feet((p.Y - 0.5) * e.Depth), 0)).ToList(), height, "Column");
                else Box(family, -e.Width / 2, -e.Depth / 2, 0, e.Width, e.Depth, height, "Column");
                warnings.Add("Generated architectural column family with fixed size-specific solid geometry.");
            }
            else
            {
                var solidHeight = e.Type == "facade-element" ? e.P("height", 3000) : e.Meta?["solid"].N("height", 0) ?? 0;
                if (solidHeight <= 0) throw new InvalidOperationException("No explicit 3D solid height; a 2D footprint cannot establish a faithful family.");
                var points = source.Footprint(e);
                if (e.Kind == "line" && !e.Raw.B("closed")) throw new InvalidOperationException("Open geometry cannot be extruded into a family.");
                if (points.Count > 1 && points[0].Distance(points[points.Count - 1]) < 0.001) points.RemoveAt(points.Count - 1);
                Extrude(family, points.Select(p => Geometry.Xyz(p)).ToList(), solidHeight, "Solid");
                warnings.Add("Generated Generic Model family from the explicit footprint and extrusion height; external catalog meshes and modeling feature history are not converted.");
            }
            if (transaction.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Family transaction did not commit.");
        }
        // Family load requires the target document to be outside a transaction.
        var temp = Path.Combine(Path.GetTempPath(), "ArchaiRevit", batch);
        Directory.CreateDirectory(temp);
        var name = "AIR_" + e.Type.Replace('-', '_') + "_" + Guid.NewGuid().ToString("N");
        var file = Path.Combine(temp, name + ".rfa");
        try
        {
            family.SaveAs(file, new SaveAsOptions { OverwriteExistingFile = true });
            var loaded = family.LoadFamily(project) ?? throw new InvalidOperationException("Could not load generated family.");
            var symbolId = loaded.GetFamilySymbolIds().First();
            return (FamilySymbol)project.GetElement(symbolId);
        }
        finally
        {
            closeFamily.Dispose();
            try { if (File.Exists(file)) File.Delete(file); }
            catch (IOException ex) { warnings.Add("Temporary family could not be removed: " + ex.Message); }
        }
    }
    private sealed class FamilyCloser : IDisposable
    {
        private readonly Document document;
        private bool closed;
        public FamilyCloser(Document document) { this.document = document; }
        public void Dispose() { if (!closed && document.IsValidObject) { document.Close(false); closed = true; } }
    }
    private string FindTemplate(string name)
    {
        var roots = new[] {
            Environment.GetEnvironmentVariable("ARCHAI_REVIT_TEMPLATES") ?? "",
            project.Application.FamilyTemplatePath,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Autodesk", "RVT " + project.Application.VersionNumber, "Family Templates", "English")
        };
        foreach (var root in roots.Where(Directory.Exists))
        {
            var direct = Path.Combine(root, name);
            if (File.Exists(direct)) return direct;
            var found = Directory.EnumerateFiles(root, name, SearchOption.AllDirectories).FirstOrDefault();
            if (found != null) return found;
        }
        throw new FileNotFoundException($"Install the Revit {project.Application.VersionNumber} English metric family templates, or set ARCHAI_REVIT_TEMPLATES. Missing {name}.");
    }
    private static void Box(Document doc, double x, double y, double z, double w, double d, double h, string material, int transparency = 0)
    {
        var p = new[] { new XYZ(Geometry.Feet(x), Geometry.Feet(y), Geometry.Feet(z)), new XYZ(Geometry.Feet(x + w), Geometry.Feet(y), Geometry.Feet(z)), new XYZ(Geometry.Feet(x + w), Geometry.Feet(y + d), Geometry.Feet(z)), new XYZ(Geometry.Feet(x), Geometry.Feet(y + d), Geometry.Feet(z)) };
        Extrude(doc, p, h, material, transparency);
    }
    private static void Extrude(Document doc, IReadOnlyList<XYZ> points, double height, string material, int transparency = 0)
    {
        var profile = new CurveArray();
        for (int i = 0; i < points.Count; i++) profile.Append(Line.CreateBound(points[i], points[(i + 1) % points.Count]));
        Extrude(doc, profile, points[0].Z, height, material, transparency);
    }
    private static void Extrude(Document doc, CurveArray profile, double z, double height, string material, int transparency = 0)
    {
        var profiles = new CurveArrArray(); profiles.Append(profile);
        var plane = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisZ, new XYZ(0, 0, z)));
        var extrusion = doc.FamilyCreate.NewExtrusion(true, profiles, plane, Geometry.Feet(height));
        var existing = new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(m => m.Name == "AIR " + material);
        var id = existing?.Id ?? Material.Create(doc, "AIR " + material);
        var m = (Material)doc.GetElement(id); m.Transparency = transparency;
        extrusion.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM)?.Set(id);
    }
}
