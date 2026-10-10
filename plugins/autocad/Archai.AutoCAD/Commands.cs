using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.Colors;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;
using Archai.Plugins;
using Archai.Plugins.Windows;
using Newtonsoft.Json;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;

namespace Archai.AutoCAD;

/// <summary>The ArchAI commands of AutoCAD (ribbon tab "ArchAI", or type them).</summary>
public sealed class Commands
{
    [CommandMethod("-ARCHAIEXPORT")]
    public void ExportTo()
    {
        // Scripts and accoreconsole: the file path on the command line, no windows.
        var doc = AcApp.DocumentManager.MdiActiveDocument;
        var path = doc?.Editor.GetString(new Autodesk.AutoCAD.EditorInput.PromptStringOptions("\n.AIR file to write: ") { AllowSpaces = true });
        if (doc == null || path == null || path.Status != Autodesk.AutoCAD.EditorInput.PromptStatus.OK) return;
        var objects = DrawingScene.Collect(doc.Database);
        var exchange = Exchange.Write(Path.GetFileNameWithoutExtension(doc.Name), "AutoCAD", AcApp.Version.ToString(), doc.Name, objects, out var written);
        File.WriteAllText(path.StringResult, exchange.ToString(Formatting.None));
        doc.Editor.WriteMessage($"\nArchAI: {written} objects written to {path.StringResult}\n");
    }

    [CommandMethod("-ARCHAIIMPORT")]
    public void ImportFrom()
    {
        var doc = AcApp.DocumentManager.MdiActiveDocument;
        var path = doc?.Editor.GetString(new Autodesk.AutoCAD.EditorInput.PromptStringOptions("\n.AIR file to read: ") { AllowSpaces = true });
        if (doc == null || path == null || path.Status != Autodesk.AutoCAD.EditorInput.PromptStatus.OK) return;
        var count = DrawingScene.Import(doc.Database, AirFile.Read(path.StringResult));
        doc.Editor.WriteMessage($"\nArchAI: {count} elements imported\n");
    }

    [CommandMethod("ARCHAIWEB")]
    public void OpenWeb() => VrShare.OpenInBrowser("https://archai-studio-six.vercel.app/");

    /// <summary>Send to ArchAI: the drawing's 3D objects as an exchange .AIR file.</summary>
    [CommandMethod("ARCHAIEXPORT")]
    public void Export()
    {
        var doc = AcApp.DocumentManager.MdiActiveDocument;
        if (doc == null) return;
        var picker = new Microsoft.Win32.SaveFileDialog
        {
            Filter = "ArchAI document (*.AIR)|*.AIR",
            Title = "Send to ArchAI",
            FileName = Path.GetFileNameWithoutExtension(doc.Name) + ".AIR",
            InitialDirectory = SafeDirectory(doc.Name),
        };
        if (picker.ShowDialog() != true) return;
        try
        {
            List<SceneObject> objects;
            using (var progress = new ArchaiProgress("Send to ArchAI"))
            {
                progress.Report("Reading the drawing's 3D objects...", 0);
                objects = DrawingScene.Collect(doc.Database, progress: ((ProgressReport)progress.Report).Range(0, 0.85));
                progress.Report($"Writing {objects.Count} objects to the .AIR file", 0.9);
                var exchange = Exchange.Write(Path.GetFileNameWithoutExtension(doc.Name), "AutoCAD", AcApp.Version.ToString(), doc.Name, objects, out var written);
                if (written == 0)
                {
                    progress.Dispose();
                    ArchaiDialog.Show("Send to ArchAI", "There are no 3D objects (solids, surfaces, meshes, 3D faces) in model space to send.");
                    return;
                }
                File.WriteAllText(picker.FileName, exchange.ToString(Formatting.None));
            }
            ArchaiDialog.Show("Sent to ArchAI", $"{objects.Count} object{(objects.Count == 1 ? "" : "s")} saved to {Path.GetFileName(picker.FileName)}.\n\nOpen it in ArchAI (Open file) to work on it: each object comes in as a 3D element with its colours.");
        }
        catch (System.Exception ex) { ArchaiDialog.Error("Send to ArchAI", ex.Message); }
    }

    /// <summary>Open .AIR: one block per ArchAI element on a layer per level.</summary>
    [CommandMethod("ARCHAIIMPORT")]
    public void Import()
    {
        var doc = AcApp.DocumentManager.MdiActiveDocument;
        if (doc == null) return;
        var picker = new Microsoft.Win32.OpenFileDialog { Filter = "ArchAI document (*.AIR)|*.AIR", Title = "Open .AIR in AutoCAD" };
        if (picker.ShowDialog() != true) return;
        try
        {
            int count;
            string name;
            using (var progress = new ArchaiProgress("Open .AIR"))
            {
                progress.Report("Reading " + Path.GetFileName(picker.FileName) + "...", null);
                var contents = AirFile.Read(picker.FileName);
                name = contents.Name;
                progress.Report($"Adding {contents.Objects.Count} elements to the drawing...", 0.1);
                using (doc.LockDocument()) count = DrawingScene.Import(doc.Database, contents, progress: ((ProgressReport)progress.Report).Range(0.1, 1));
            }
            doc.Editor.Regen();
            ArchaiDialog.Show("Opened .AIR", $"{name}: {count} element{(count == 1 ? "" : "s")} added as blocks at their ArchAI position, on ArchAI layers per level.\n\nUndo removes the import.");
        }
        catch (System.Exception ex) { ArchaiDialog.Error("Open .AIR", ex.Message); }
    }

    /// <summary>Open in VR: the drawing's 3D objects as a VR tour on ArchAI's share service.</summary>
    [CommandMethod("ARCHAIVR")]
    public void Vr()
    {
        var doc = AcApp.DocumentManager.MdiActiveDocument;
        if (doc == null) return;
        var share = VrShare.Config("AutoCAD");
        if (share == null) { ArchaiDialog.Show("Open in VR", VrShare.NoKey); return; }
        try
        {
            VrTour.Result tour;
            VrShare.Published link;
            var name = Path.GetFileNameWithoutExtension(doc.Name);
            using (var progress = new ArchaiProgress("Open in VR"))
            {
                progress.Report("Reading the drawing's 3D objects...", 0);
                var objects = DrawingScene.Collect(doc.Database, progress: ((ProgressReport)progress.Report).Range(0, 0.3));
                var cameras = DrawingScene.Cameras(doc.Database);
                progress.Report("Building the VR model", null);
                tour = VrTour.Build(name, "AutoCAD", objects, cameras);
                if (tour.Model.Length == 0)
                {
                    progress.Dispose();
                    ArchaiDialog.Show("Open in VR", "There are no 3D objects (solids, surfaces, meshes, 3D faces) in model space to show.");
                    return;
                }
                progress.Report($"Uploading {Progress.Megabytes(tour.Model.Length)} to the VR viewer...", 0.35);
                var upload = ((ProgressReport)progress.Report).Range(0.35, 1);
                link = progress.Run(() => VrShare.Publish(share, "autocad|" + doc.Name, tour.Model, tour.Json, upload));
            }
            VrShare.OpenInBrowser(link.Url);
            try { System.Windows.Clipboard.SetText(link.Url); } catch { }
            ArchaiDialog.Show("Opened in VR", VrShare.Message(name, tour, link), link.Url);
        }
        catch (System.Exception ex) { ArchaiDialog.Error("Open in VR", (ex is AggregateException { InnerException: not null } a ? a.InnerException! : ex).Message); }
    }

    private static string SafeDirectory(string path)
    {
        try { var dir = Path.GetDirectoryName(path); if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir)) return dir!; } catch { }
        return Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
    }
}

/// <summary>Reads model space as ArchAI scene objects and writes imported ones back.</summary>
internal static class DrawingScene
{
    /// <summary>Millimetres per drawing unit (INSUNITS); unitless drawings are taken as millimetres.</summary>
    public static double Millimetres(Database db) => db.Insunits switch
    {
        UnitsValue.Inches => 25.4,
        UnitsValue.Feet => 304.8,
        UnitsValue.Centimeters => 10,
        UnitsValue.Meters => 1000,
        UnitsValue.Decimeters => 100,
        UnitsValue.Kilometers => 1_000_000,
        UnitsValue.Yards => 914.4,
        UnitsValue.Miles => 1_609_344,
        UnitsValue.Microns => 0.001,
        _ => 1,
    };

    public static List<SceneObject> Collect(Database db, bool skipLive = false, ProgressReport? progress = null)
    {
        var objects = new List<SceneObject>();
        var mm = Millimetres(db);
        var materials = new Dictionary<string, GlbMaterial>();
        using var tr = db.TransactionManager.StartOpenCloseTransaction();
        var space = (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForRead);
        var ids = new List<ObjectId>();
        foreach (ObjectId each in space) ids.Add(each);
        for (var index = 0; index < ids.Count; index++)
        {
            var id = ids[index];
            progress.Step(index, ids.Count, $"Reading object {index + 1} of {ids.Count}");
            if (!(tr.GetObject(id, OpenMode.ForRead) is Entity entity) || !entity.Visible) continue;
            var layer = (LayerTableRecord)tr.GetObject(entity.LayerId, OpenMode.ForRead);
            if (layer.IsOff || layer.IsFrozen) continue;
            // What the live link brought in from ArchAI never goes back.
            if (skipLive && layer.Name.StartsWith(Live.LayerPrefix, StringComparison.OrdinalIgnoreCase)) continue;
            var item = new SceneObject
            {
                Id = "h" + entity.Handle,
                Name = entity is BlockReference block ? BlockName(tr, block) : entity.GetRXClass().DxfName.ToLowerInvariant() is var dxf && dxf.Length > 0 ? char.ToUpperInvariant(dxf[0]) + dxf.Substring(1) : "Object",
                Category = entity.Layer,
                // Live Bridge: an editable copy of an ArchAI element.
                Archai = BridgeTags.Read(entity).CopyOf,
            };
            try { Add(tr, entity, Matrix3d.Identity, null, item, mm, materials, 0); } catch { continue; }
            if (item.Triangles.Count > 0) objects.Add(item);
        }
        return objects;
    }

    private static string BlockName(Transaction tr, BlockReference block)
    {
        try { return block.IsDynamicBlock ? ((BlockTableRecord)tr.GetObject(block.DynamicBlockTableRecord, OpenMode.ForRead)).Name : block.Name; } catch { return block.Name; }
    }

    private static void Add(Transaction tr, Entity entity, Matrix3d transform, Color? byBlock, SceneObject item, double mm, Dictionary<string, GlbMaterial> materials, int depth)
    {
        if (depth > 16) return;
        var material = MaterialOf(tr, entity, byBlock, materials);
        void Polygon(IList<Point3d> points)
        {
            ArchaiPoint P(Point3d p) { var w = p.TransformBy(transform); return ArchaiPoint.FromZUp(w.X, w.Y, w.Z, mm); }
            for (int i = 1; i + 1 < points.Count; i++) item.Add(material, P(points[0]), P(points[i]), P(points[i + 1]));
        }
        switch (entity)
        {
            case BlockReference block:
                {
                    var definition = (BlockTableRecord)tr.GetObject(block.BlockTableRecord, OpenMode.ForRead);
                    var inner = transform * block.BlockTransform;
                    var colour = entity.Color.IsByBlock ? byBlock : Resolve(tr, entity, byBlock);
                    foreach (ObjectId id in definition)
                    {
                        if (tr.GetObject(id, OpenMode.ForRead) is Entity child && child.Visible && !(child is AttributeDefinition))
                        {
                            try { Add(tr, child, inner, colour, item, mm, materials, depth + 1); } catch { }
                        }
                    }
                    return;
                }
            case Face face:
                {
                    var points = new List<Point3d> { face.GetVertexAt(0), face.GetVertexAt(1), face.GetVertexAt(2) };
                    var fourth = face.GetVertexAt(3);
                    if (fourth.DistanceTo(points[2]) > 1e-9) points.Add(fourth);
                    Polygon(points);
                    return;
                }
            case SubDMesh mesh:
                Faces(mesh.Vertices, mesh.FaceArray, Polygon);
                return;
            case Solid3d _:
            case Autodesk.AutoCAD.DatabaseServices.Surface _:
            case Region _:
            case PolyFaceMesh _:
            case PolygonMesh _:
            case Body _:
                {
                    var faceter = new MeshFaceterData { FaceterMeshType = 2, FaceterDevSurface = 0, FaceterGridRatio = 0, FaceterMaxGrid = 4096, FaceterMinUGrid = 0, FaceterMinVGrid = 0, FaceterMaxEdgeLength = 0, FaceterDevNormal = 15 };
                    var data = SubDMesh.GetObjectMesh(entity, faceter);
                    Faces(data.VertexArray, data.FaceArray, Polygon);
                    return;
                }
        }
    }

    /// <summary>AutoCAD face lists: a vertex count, then that many indices, repeated.</summary>
    private static void Faces(Point3dCollection vertices, Int32Collection faces, Action<IList<Point3d>> polygon)
    {
        for (int i = 0; i < faces.Count;)
        {
            var n = faces[i++];
            if (n < 3 || i + n > faces.Count) { i += Math.Max(n, 0); continue; }
            var points = new List<Point3d>(n);
            for (int k = 0; k < n; k++) points.Add(vertices[faces[i + k]]);
            i += n;
            polygon(points);
        }
    }

    private static Color Resolve(Transaction tr, Entity entity, Color? byBlock)
    {
        if (entity.Color.IsByLayer) return ((LayerTableRecord)tr.GetObject(entity.LayerId, OpenMode.ForRead)).Color;
        if (entity.Color.IsByBlock) return byBlock ?? Color.FromColorIndex(ColorMethod.ByAci, 7);
        return entity.Color;
    }

    private static GlbMaterial MaterialOf(Transaction tr, Entity entity, Color? byBlock, Dictionary<string, GlbMaterial> materials)
    {
        var colour = Resolve(tr, entity, byBlock);
        System.Drawing.Color rgb;
        try { rgb = colour.ColorValue; } catch { rgb = System.Drawing.Color.FromArgb(200, 202, 206); }
        // ACI 7 (white/black by background) reads as a light grey in a lit model.
        if (colour.ColorMethod == ColorMethod.ByAci && colour.ColorIndex == 7) rgb = System.Drawing.Color.FromArgb(214, 216, 220);
        var name = entity.Material is { Length: > 0 } m && !m.Equals("ByLayer", StringComparison.OrdinalIgnoreCase) && !m.Equals("ByBlock", StringComparison.OrdinalIgnoreCase) && !m.Equals("Global", StringComparison.OrdinalIgnoreCase)
            ? $"{m} #{rgb.R:x2}{rgb.G:x2}{rgb.B:x2}"
            : $"{entity.Layer} #{rgb.R:x2}{rgb.G:x2}{rgb.B:x2}";
        if (materials.TryGetValue(name, out var material)) return material;
        var opacity = 1.0;
        try { if (entity.Transparency.IsByAlpha) opacity = entity.Transparency.Alpha / 255.0; } catch { }
        return materials[name] = new GlbMaterial { Name = name, R = rgb.R / 255.0, G = rgb.G / 255.0, B = rgb.B / 255.0, Opacity = opacity, Roughness = 0.8 };
    }

    /// <summary>Named views with perspective on (cameras placed with CAMERA make them) as VR stops.</summary>
    public static List<VrStop> Cameras(Database db)
    {
        var stops = new List<VrStop>();
        var mm = Millimetres(db);
        using var tr = db.TransactionManager.StartOpenCloseTransaction();
        var views = (ViewTable)tr.GetObject(db.ViewTableId, OpenMode.ForRead);
        foreach (ObjectId id in views)
        {
            var view = (ViewTableRecord)tr.GetObject(id, OpenMode.ForRead);
            if (!view.PerspectiveEnabled) continue;
            var eye = view.Target + view.ViewDirection;
            var forward = -view.ViewDirection;
            stops.Add(VrStop.FromCamera(view.Name, ArchaiPoint.FromZUp(eye.X, eye.Y, eye.Z, mm), ArchaiPoint.FromZUp(forward.X, forward.Y, forward.Z, 1)));
        }
        return stops;
    }

    /// <summary>Adds imported objects as blocks (one per element) inserted at the origin, on a layer per level.</summary>
    /// <summary>Removes what the live link brought in: entities on the ArchAI Live layers and their block definitions.</summary>
    public static void ClearLive(Database db)
    {
        using var tr = db.TransactionManager.StartTransaction();
        var space = (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForRead);
        var definitions = new HashSet<ObjectId>();
        foreach (ObjectId id in space)
        {
            if (!(tr.GetObject(id, OpenMode.ForRead) is Entity entity) || !entity.Layer.StartsWith(Live.LayerPrefix, StringComparison.OrdinalIgnoreCase)) continue;
            if (entity is BlockReference reference) definitions.Add(reference.BlockTableRecord);
            entity.UpgradeOpen();
            entity.Erase();
        }
        foreach (var id in definitions)
        {
            var definition = (BlockTableRecord)tr.GetObject(id, OpenMode.ForWrite);
            if (definition.GetBlockReferenceIds(true, false).Count == 0) definition.Erase();
        }
        tr.Commit();
    }

    /// <param name="created">Live Bridge: each new block reference with the object it was made of.</param>
    /// <param name="layer">Puts everything on this layer instead of a layer per level.</param>
    public static int Import(Database db, AirFile.Contents contents, string layerPrefix = "ArchAI", ProgressReport? progress = null, Action<ImportObject, ObjectId>? created = null, string? layer = null)
    {
        var mm = Millimetres(db);
        var count = 0;
        var total = contents.Objects.Count;
        using var tr = db.TransactionManager.StartTransaction();
        var blocks = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForWrite);
        var layers = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForWrite);
        var space = (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForWrite);
        var prefix = Clean(contents.Name, 40);
        foreach (var level in AirFile.ByLevel(contents.Objects))
        {
            var layerName = layer ?? Clean(layerPrefix + " " + (level.Key.Length > 0 ? level.Key : contents.Name), 200);
            if (!layers.Has(layerName))
            {
                var record = new LayerTableRecord { Name = layerName };
                layers.Add(record);
                tr.AddNewlyCreatedDBObject(record, true);
            }
            foreach (var item in level)
            {
                progress.Step(count, total, $"Adding element {count + 1} of {total}");
                var name = Unique(blocks, Clean($"{prefix} {item.Name}", 200));
                var definition = new BlockTableRecord { Name = name, Origin = Point3d.Origin };
                blocks.Add(definition);
                tr.AddNewlyCreatedDBObject(definition, true);
                Fill(tr, db, definition, item, mm, Matrix3d.Identity);
                var reference = new BlockReference(Point3d.Origin, definition.ObjectId) { Layer = layerName };
                space.AppendEntity(reference);
                tr.AddNewlyCreatedDBObject(reference, true);
                created?.Invoke(item, reference.ObjectId);
                count++;
            }
        }
        tr.Commit();
        return count;
    }

    /// <summary>Adds an object's meshes to a block definition; <paramref name="toLocal"/> maps world to the definition.</summary>
    public static void Fill(Transaction tr, Database db, BlockTableRecord definition, ImportObject item, double mm, Matrix3d toLocal)
    {
        foreach (var part in item.Parts)
        {
            var vertices = new Point3dCollection();
            for (int i = 0; i + 2 < part.Positions.Length; i += 3)
            {
                var (x, y, z) = HostAxes.ToZUp(part.Positions[i], part.Positions[i + 1], part.Positions[i + 2], mm);
                vertices.Add(new Point3d(x, y, z).TransformBy(toLocal));
            }
            var faces = new Int32Collection();
            for (int i = 0; i + 2 < part.Indices.Length; i += 3)
            {
                // glTF to Z-up keeps handedness, so the winding stays.
                faces.Add(3); faces.Add(part.Indices[i]); faces.Add(part.Indices[i + 1]); faces.Add(part.Indices[i + 2]);
            }
            if (faces.Count == 0) continue;
            var mesh = new SubDMesh();
            mesh.SetDatabaseDefaults(db);
            mesh.SetSubDMesh(vertices, faces, 0);
            mesh.Layer = "0";
            var m = part.Material;
            mesh.Color = Color.FromRgb((byte)Math.Round(m.R * 255), (byte)Math.Round(m.G * 255), (byte)Math.Round(m.B * 255));
            if (m.Opacity < 0.999) mesh.Transparency = new Transparency((byte)Math.Round(m.Opacity * 255));
            definition.AppendEntity(mesh);
            tr.AddNewlyCreatedDBObject(mesh, true);
        }
    }

    private static string Clean(string name, int length)
    {
        var cleaned = Regex.Replace(name, @"[<>/\\"":;?*|,=`]", "_").Trim();
        if (cleaned.Length == 0) cleaned = "ArchAI";
        return cleaned.Length <= length ? cleaned : cleaned.Substring(0, length);
    }

    private static string Unique(BlockTable blocks, string name)
    {
        if (!blocks.Has(name)) return name;
        for (int i = 2; ; i++) if (!blocks.Has($"{name} ({i})")) return $"{name} ({i})";
    }
}
