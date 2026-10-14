using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Archai.Plugins;
using Newtonsoft.Json.Linq;

namespace Archai.Revit;

/// <summary>
/// Writes the open Revit model as an ArchAI Revit exchange file (docs/revit-import.md in the ArchAI
/// repo, schema in src/revit/exchange.ts): levels, walls with compound layers and materials,
/// hosted doors and windows, floors and ceilings with openings, columns, railings and rooms as
/// data ArchAI rebuilds natively, and every other model element as a binary glTF mesh.
///
/// Axes: ArchAI plan x = Revit X, plan y = -Revit Y, elevation = Revit Z; all in millimetres.
/// </summary>
internal sealed class ArchaiExporter
{
    private const double Mm = 304.8;
    private readonly Document doc;
    private readonly JArray materials = new JArray();
    private readonly Dictionary<long, string> materialIds = new Dictionary<long, string>();
    private readonly Dictionary<long, GlbMaterial> glbMaterials = new Dictionary<long, GlbMaterial>();
    private readonly HashSet<long> exported = new HashSet<long>();
    private readonly Dictionary<long, List<(double X, double Y)>> wallPaths = new Dictionary<long, List<(double X, double Y)>>();
    private readonly Options geometryOptions = new Options { DetailLevel = ViewDetailLevel.Fine, ComputeReferences = false, IncludeNonVisibleObjects = false };
    public readonly List<string> Warnings = new List<string>();
    public readonly Dictionary<string, int> Counts = new Dictionary<string, int>();

    public ArchaiExporter(Document doc, View3D? view = null)
    {
        this.doc = doc;
        if (view != null)
        {
            // Revit forbids an explicit detail level when a view supplies geometry.
            geometryOptions = new Options { View = view, ComputeReferences = false, IncludeNonVisibleObjects = false };
        }
    }

    private static long Key(ElementId id) => id.Value;
    private static string Id(Element element) => "e" + element.Id.Value;
    private static (double X, double Y) Plan(XYZ p) => (Math.Round(p.X * Mm, 1), Math.Round(-p.Y * Mm, 1));
    private static double Elevation(double feet) => Math.Round(feet * Mm, 1);
    private static JArray Point((double X, double Y) p) => new JArray(p.X, p.Y);
    private void Count(string kind) => Counts[kind] = Counts.TryGetValue(kind, out var n) ? n + 1 : 1;

    /// <summary>Progress of <see cref="Export"/> (Send to ArchAI shows it).</summary>
    public ProgressReport? Progress { get; set; }

    /// <summary>
    /// Live Bridge: every element as a generic mesh (no walls, slabs or levels rebuilt as ArchAI
    /// elements), so the same triangles reach ArchAI and every linked app.
    /// </summary>
    public bool MeshesOnly { get; set; }

    /// <summary>Only these elements (a sync of what changed); null: the whole model.</summary>
    public ICollection<long>? Only { get; set; }

    public JObject Export()
    {
        if (MeshesOnly)
        {
            var only = ExportMeshes();
            return new JObject
            {
                ["archaiRevit"] = 1,
                ["name"] = string.IsNullOrWhiteSpace(doc.Title) ? "Revit model" : System.IO.Path.GetFileNameWithoutExtension(doc.Title),
                ["source"] = doc.PathName ?? "",
                ["revitVersion"] = doc.Application.VersionNumber,
                ["materials"] = new JArray(),
                ["levels"] = new JArray(),
                ["meshes"] = only,
            };
        }
        Progress?.Invoke("Reading levels", 0.02);
        var levels = ExportLevels();
        Progress?.Invoke("Reading walls", 0.06);
        var walls = ExportWalls();
        Progress?.Invoke("Reading doors and windows", 0.2);
        var openings = ExportOpenings();
        Progress?.Invoke("Reading floors and roofs", 0.3);
        var slabs = ExportSlabs();
        Progress?.Invoke("Reading columns", 0.38);
        var columns = ExportColumns();
        Progress?.Invoke("Reading railings", 0.42);
        var railings = ExportRailings();
        Progress?.Invoke("Reading rooms", 0.46);
        var rooms = ExportRooms();
        var meshes = ExportMeshes();
        Progress?.Invoke("Writing the .AIR file", 0.98);
        return new JObject
        {
            ["archaiRevit"] = 1,
            ["name"] = string.IsNullOrWhiteSpace(doc.Title) ? "Revit model" : System.IO.Path.GetFileNameWithoutExtension(doc.Title),
            ["source"] = doc.PathName ?? "",
            ["revitVersion"] = doc.Application.VersionNumber,
            ["materials"] = materials,
            ["levels"] = levels,
            ["walls"] = walls,
            ["openings"] = openings,
            ["slabs"] = slabs,
            ["columns"] = columns,
            ["railings"] = railings,
            ["rooms"] = rooms,
            ["meshes"] = meshes,
        };
    }

    // ---- materials ------------------------------------------------------------------------

    private string? MaterialId(ElementId id)
    {
        if (id == null || id == ElementId.InvalidElementId) return null;
        if (materialIds.TryGetValue(Key(id), out var existing)) return existing;
        if (!(doc.GetElement(id) is Material material)) return null;
        var glb = GlbMaterialOf(id);
        var key = "m" + id.Value;
        materials.Add(new JObject
        {
            ["id"] = key,
            ["name"] = material.Name,
            ["color"] = $"#{(int)(glb.R * 255):x2}{(int)(glb.G * 255):x2}{(int)(glb.B * 255):x2}",
            ["opacity"] = Math.Round(glb.Opacity, 3),
            ["roughness"] = Math.Round(glb.Roughness, 3),
            ["metalness"] = glb.Metalness,
        });
        materialIds[Key(id)] = key;
        return key;
    }

    private static readonly GlbMaterial DefaultMaterial = new GlbMaterial { Name = "Default", R = 0.78, G = 0.79, B = 0.81 };

    private GlbMaterial GlbMaterialOf(ElementId id)
    {
        if (id == null || id == ElementId.InvalidElementId) return DefaultMaterial;
        if (glbMaterials.TryGetValue(Key(id), out var cached)) return cached;
        var result = DefaultMaterial;
        if (doc.GetElement(id) is Material material)
        {
            var colour = material.Color;
            var name = material.Name.ToLowerInvariant();
            var metal = new[] { "metal", "steel", "alumin", "copper", "brass", "chrome", "zinc", "iron" }.Any(name.Contains);
            result = new GlbMaterial
            {
                Name = material.Name,
                R = colour.IsValid ? colour.Red / 255.0 : 0.78,
                G = colour.IsValid ? colour.Green / 255.0 : 0.79,
                B = colour.IsValid ? colour.Blue / 255.0 : 0.81,
                Opacity = 1 - Math.Max(0, Math.Min(100, material.Transparency)) / 100.0,
                Roughness = 1 - Math.Max(0, Math.Min(128, material.Shininess)) / 128.0 * 0.85,
                Metalness = metal ? 0.8 : 0,
            };
        }
        glbMaterials[Key(id)] = result;
        return result;
    }

    // ---- levels ---------------------------------------------------------------------------

    private JArray ExportLevels()
    {
        var list = new JArray();
        foreach (var level in new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.ProjectElevation))
        {
            list.Add(new JObject { ["id"] = Id(level), ["name"] = level.Name, ["elevation"] = Elevation(level.ProjectElevation) });
            Count("level");
        }
        return list;
    }

    private string? LevelOf(Element element)
    {
        var id = element.LevelId;
        if (id == null || id == ElementId.InvalidElementId) return null;
        return doc.GetElement(id) is Level level ? Id(level) : null;
    }

    private double LevelElevation(ElementId id) => doc.GetElement(id) is Level level ? level.ProjectElevation : 0;

    // ---- walls ----------------------------------------------------------------------------

    private static List<XYZ> CurvePoints(Curve curve) => curve is Line ? new List<XYZ> { curve.GetEndPoint(0), curve.GetEndPoint(1) } : curve.Tessellate().ToList();

    private JArray ExportWalls()
    {
        var list = new JArray();
        foreach (var wall in new FilteredElementCollector(doc).OfClass(typeof(Wall)).Cast<Wall>())
        {
            try
            {
                // Curtain and stacked walls come in as meshes (panels, mullions, members).
                if (wall.WallType.Kind != WallKind.Basic || !(wall.Location is LocationCurve location)) continue;
                var structure = wall.WallType.GetCompoundStructure();
                var widthFeet = wall.Width;
                var orientation = wall.Orientation; // points to the exterior
                // Revit's location line may be a face or core line: move it to the wall's centre.
                var centreShift = CentreShift(wall, structure, widthFeet);
                var shift = orientation.Multiply(centreShift);
                var points = CurvePoints(location.Curve).Select(p => Plan(p + shift)).ToList();
                if (points.Count < 2) continue;
                // ArchAI draws layer 0 on the left of the path (plan y down): make that the exterior.
                var (ux, uy) = (points[1].X - points[0].X, points[1].Y - points[0].Y);
                var outside = (X: orientation.X, Y: -orientation.Y);
                if (uy * outside.X + -ux * outside.Y < 0) points.Reverse();
                var layers = new JArray();
                if (structure != null && structure.LayerCount > 0)
                {
                    var first = structure.GetFirstCoreLayerIndex();
                    var last = structure.GetLastCoreLayerIndex();
                    var index = 0;
                    foreach (var layer in structure.GetLayers())
                    {
                        var thickness = Math.Round(layer.Width * Mm, 1);
                        if (thickness >= 1)
                        {
                            var material = MaterialId(layer.MaterialId);
                            var name = doc.GetElement(layer.MaterialId) is Material m ? m.Name : layer.Function.ToString();
                            var entry = new JObject { ["name"] = Truncate(name, 60), ["role"] = index >= first && index <= last ? "core" : "finish", ["thickness"] = thickness };
                            if (material != null) entry["material"] = material;
                            layers.Add(entry);
                        }
                        index++;
                    }
                }
                if (!layers.Any(l => (string?)l["role"] == "core"))
                {
                    if (layers.Count > 0) layers[layers.Count / 2]!["role"] = "core";
                    else layers.Add(new JObject { ["name"] = "Core", ["role"] = "core", ["thickness"] = Math.Round(widthFeet * Mm, 1) });
                }
                var baseLevel = wall.get_Parameter(BuiltInParameter.WALL_BASE_CONSTRAINT)?.AsElementId() ?? wall.LevelId;
                var baseFeet = LevelElevation(baseLevel) + (wall.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.AsDouble() ?? 0);
                var heightFeet = wall.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM)?.AsDouble() ?? 0;
                if (heightFeet <= 0 && wall.get_BoundingBox(null) is BoundingBoxXYZ box) heightFeet = box.Max.Z - baseFeet;
                if (heightFeet <= 0) continue;
                list.Add(new JObject
                {
                    ["id"] = Id(wall),
                    ["name"] = Truncate(wall.WallType.Name, 120),
                    ["level"] = doc.GetElement(baseLevel) is Level level ? Id(level) : null,
                    ["points"] = new JArray(points.Select(Point)),
                    ["base"] = Elevation(baseFeet),
                    ["height"] = Elevation(heightFeet),
                    ["layers"] = layers,
                });
                wallPaths[Key(wall.Id)] = points;
                exported.Add(Key(wall.Id));
                Count("wall");
            }
            catch (Exception ex) { Warnings.Add($"Wall {wall.Id.Value}: {ex.Message}"); }
        }
        return list;
    }

    /// <summary>How far the wall centre lies from its location line, towards the exterior (feet).</summary>
    private static double CentreShift(Wall wall, CompoundStructure? structure, double width)
    {
        var key = wall.get_Parameter(BuiltInParameter.WALL_KEY_REF_PARAM)?.AsInteger() ?? 0;
        if (key == 0) return 0;
        // Distance from the exterior face to the line in question, measured inwards.
        double FromExterior(int line)
        {
            if (line == 2) return 0; // finish face: exterior
            if (line == 3) return width; // finish face: interior
            if (structure == null || structure.LayerCount == 0) return width / 2;
            var layers = structure.GetLayers();
            double before = 0, core = 0;
            for (int i = 0; i < layers.Count; i++)
            {
                if (i < structure.GetFirstCoreLayerIndex()) before += layers[i].Width;
                else if (i <= structure.GetLastCoreLayerIndex()) core += layers[i].Width;
            }
            return line == 4 ? before : line == 5 ? before + core : before + core / 2; // 1: core centre
        }
        // The location line sits FromExterior inwards from the exterior face; the centre at width / 2.
        return FromExterior(key) - width / 2;
    }

    // ---- doors and windows ----------------------------------------------------------------

    private static double Along(List<(double X, double Y)> path, (double X, double Y) p)
    {
        double best = double.MaxValue, along = 0, travelled = 0;
        for (int i = 0; i < path.Count - 1; i++)
        {
            var (ax, ay) = path[i]; var (bx, by) = path[i + 1];
            var length = Math.Sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
            if (length <= 0) continue;
            var t = Math.Max(0, Math.Min(length, ((p.X - ax) * (bx - ax) + (p.Y - ay) * (by - ay)) / length));
            var qx = ax + (bx - ax) * t / length; var qy = ay + (by - ay) * t / length;
            var d = Math.Sqrt((p.X - qx) * (p.X - qx) + (p.Y - qy) * (p.Y - qy));
            if (d < best) { best = d; along = travelled + t; }
            travelled += length;
        }
        return along;
    }

    private double Dimension(FamilyInstance instance, params BuiltInParameter[] parameters)
    {
        foreach (var source in new Element[] { instance, instance.Symbol })
            foreach (var parameter in parameters)
            {
                var value = source?.get_Parameter(parameter);
                if (value != null && value.StorageType == StorageType.Double && value.AsDouble() > 0) return value.AsDouble();
            }
        return 0;
    }

    private JArray ExportOpenings()
    {
        var list = new JArray();
        var categories = new[] { BuiltInCategory.OST_Doors, BuiltInCategory.OST_Windows };
        foreach (var category in categories)
        {
            foreach (var instance in new FilteredElementCollector(doc).OfCategory(category).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>())
            {
                try
                {
                    if (!(instance.Host is Wall wall) || !wallPaths.TryGetValue(Key(wall.Id), out var path) || !(instance.Location is LocationPoint point)) continue;
                    var door = category == BuiltInCategory.OST_Doors;
                    var width = Dimension(instance, door ? BuiltInParameter.DOOR_WIDTH : BuiltInParameter.WINDOW_WIDTH, BuiltInParameter.FAMILY_WIDTH_PARAM, BuiltInParameter.GENERIC_WIDTH);
                    var height = Dimension(instance, door ? BuiltInParameter.DOOR_HEIGHT : BuiltInParameter.WINDOW_HEIGHT, BuiltInParameter.FAMILY_HEIGHT_PARAM, BuiltInParameter.GENERIC_HEIGHT);
                    if (width <= 0 && instance.get_BoundingBox(null) is BoundingBoxXYZ box) { width = Math.Max(box.Max.X - box.Min.X, box.Max.Y - box.Min.Y); height = box.Max.Z - box.Min.Z; }
                    if (width <= 0 || height <= 0) continue;
                    var centre = Along(path, Plan(point.Point));
                    var sill = instance.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM)?.AsDouble() ?? 0;
                    var bottom = LevelElevation(instance.LevelId) + sill;
                    var facing = instance.FacingOrientation;
                    var wallOut = wall.Orientation;
                    list.Add(new JObject
                    {
                        ["id"] = Id(instance),
                        ["kind"] = door ? "door" : "window",
                        ["name"] = Truncate($"{instance.Symbol.FamilyName} {instance.Symbol.Name}", 120),
                        ["wall"] = Id(wall),
                        ["start"] = Math.Round(centre - width * Mm / 2, 1),
                        ["end"] = Math.Round(centre + width * Mm / 2, 1),
                        ["height"] = Elevation(height),
                        ["bottom"] = Elevation(bottom),
                        ["handing"] = instance.HandFlipped ? "right" : "left",
                        ["side"] = facing.DotProduct(wallOut) > 0 ? "inside" : "outside",
                    });
                    exported.Add(Key(instance.Id));
                    Count(door ? "door" : "window");
                }
                catch (Exception ex) { Warnings.Add($"Opening {instance.Id.Value}: {ex.Message}"); }
            }
        }
        return list;
    }

    // ---- floors and ceilings --------------------------------------------------------------

    private static List<(double X, double Y)> LoopPoints(CurveLoop loop)
    {
        var points = new List<(double X, double Y)>();
        foreach (var curve in loop)
            foreach (var p in CurvePoints(curve))
            {
                var q = Plan(p);
                if (points.Count == 0 || Math.Abs(points[points.Count - 1].X - q.X) > 0.5 || Math.Abs(points[points.Count - 1].Y - q.Y) > 0.5) points.Add(q);
            }
        if (points.Count > 1 && Math.Abs(points[0].X - points[points.Count - 1].X) < 0.5 && Math.Abs(points[0].Y - points[points.Count - 1].Y) < 0.5) points.RemoveAt(points.Count - 1);
        return points;
    }

    private static double Area(List<(double X, double Y)> points)
    {
        double sum = 0;
        for (int i = 0; i < points.Count; i++) { var a = points[i]; var b = points[(i + 1) % points.Count]; sum += a.X * b.Y - b.X * a.Y; }
        return Math.Abs(sum) / 2;
    }

    private JObject? Slab(HostObject host, string kind, IList<Reference> faces, double thicknessFeet, ElementId materialId)
    {
        var outline = new List<(double X, double Y)>();
        var holes = new List<List<(double X, double Y)>>();
        double z = double.NaN;
        foreach (var reference in faces)
        {
            if (!(host.GetGeometryObjectFromReference(reference) is PlanarFace face) || Math.Abs(face.FaceNormal.Z) < 0.999) return null;
            z = face.Origin.Z;
            var loops = face.GetEdgesAsCurveLoops().Select(LoopPoints).Where(l => l.Count >= 3).OrderByDescending(Area).ToList();
            if (loops.Count == 0) continue;
            if (outline.Count == 0) { outline = loops[0]; holes.AddRange(loops.Skip(1)); }
            else return null; // several separate faces: keep the true shape as a mesh
        }
        if (outline.Count < 3 || double.IsNaN(z) || thicknessFeet <= 0) return null;
        var bottom = kind == "floor" ? z - thicknessFeet : z;
        var slab = new JObject
        {
            ["id"] = Id(host),
            ["kind"] = kind,
            ["name"] = Truncate(doc.GetElement(host.GetTypeId())?.Name ?? kind, 120),
            ["level"] = LevelOf(host),
            ["outline"] = new JArray(outline.Select(Point)),
            ["holes"] = new JArray(holes.Select(h => new JArray(h.Select(Point)))),
            ["bottom"] = Elevation(bottom),
            ["thickness"] = Elevation(thicknessFeet),
        };
        var material = MaterialId(materialId);
        if (material != null) slab["material"] = material;
        return slab;
    }

    private static ElementId CoreMaterial(CompoundStructure? structure)
    {
        if (structure == null || structure.LayerCount == 0) return ElementId.InvalidElementId;
        var layers = structure.GetLayers();
        return layers[Math.Max(0, Math.Min(layers.Count - 1, structure.GetFirstCoreLayerIndex()))].MaterialId;
    }

    private JArray ExportSlabs()
    {
        var list = new JArray();
        foreach (var floor in new FilteredElementCollector(doc).OfClass(typeof(Floor)).Cast<Floor>())
        {
            try
            {
                var structure = floor.FloorType.GetCompoundStructure();
                var thickness = structure?.GetWidth() ?? floor.get_Parameter(BuiltInParameter.FLOOR_ATTR_THICKNESS_PARAM)?.AsDouble() ?? 0;
                var slab = Slab(floor, "floor", HostObjectUtils.GetTopFaces(floor), thickness, CoreMaterial(structure));
                if (slab == null) continue; // sloped or split: exported as a mesh
                list.Add(slab);
                exported.Add(Key(floor.Id));
                Count("floor");
            }
            catch (Exception ex) { Warnings.Add($"Floor {floor.Id.Value}: {ex.Message}"); }
        }
        foreach (var ceiling in new FilteredElementCollector(doc).OfClass(typeof(Ceiling)).Cast<Ceiling>())
        {
            try
            {
                var type = doc.GetElement(ceiling.GetTypeId()) as HostObjAttributes;
                var structure = type?.GetCompoundStructure();
                var thickness = structure?.GetWidth() ?? 0;
                if (thickness <= 0) thickness = 25 / Mm;
                var slab = Slab(ceiling, "ceiling", HostObjectUtils.GetBottomFaces(ceiling), thickness, CoreMaterial(structure));
                if (slab == null) continue;
                list.Add(slab);
                exported.Add(Key(ceiling.Id));
                Count("ceiling");
            }
            catch (Exception ex) { Warnings.Add($"Ceiling {ceiling.Id.Value}: {ex.Message}"); }
        }
        return list;
    }

    // ---- columns --------------------------------------------------------------------------

    private JArray ExportColumns()
    {
        var list = new JArray();
        var filter = new LogicalOrFilter(new ElementCategoryFilter(BuiltInCategory.OST_Columns), new ElementCategoryFilter(BuiltInCategory.OST_StructuralColumns));
        foreach (var column in new FilteredElementCollector(doc).WherePasses(filter).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>())
        {
            try
            {
                if (!(column.Location is LocationPoint point) || column.IsSlantedColumn) continue;
                // Size in the column's own axes: its symbol geometry's box.
                var symbolGeometry = column.GetOriginalGeometry(geometryOptions);
                var box = symbolGeometry?.GetBoundingBox();
                var world = column.get_BoundingBox(null);
                if (box == null || world == null) continue;
                var width = box.Max.X - box.Min.X;
                var depth = box.Max.Y - box.Min.Y;
                if (width <= 0 || depth <= 0) continue;
                var name = $"{column.Symbol.FamilyName} {column.Symbol.Name}";
                var round = new[] { "round", "circ", "cylind", "pipe" }.Any(name.ToLowerInvariant().Contains);
                var centre = Plan(point.Point);
                var material = column.get_Parameter(BuiltInParameter.STRUCTURAL_MATERIAL_PARAM)?.AsElementId() ?? ElementId.InvalidElementId;
                var entry = new JObject
                {
                    ["id"] = Id(column),
                    ["name"] = Truncate(name, 120),
                    ["level"] = LevelOf(column),
                    ["x"] = centre.X,
                    ["y"] = centre.Y,
                    ["width"] = Elevation(width),
                    ["depth"] = Elevation(depth),
                    ["round"] = round,
                    ["rotation"] = Math.Round(point.Rotation * 180 / Math.PI, 2),
                    ["base"] = Elevation(world.Min.Z),
                    ["height"] = Elevation(world.Max.Z - world.Min.Z),
                };
                var id = MaterialId(material);
                if (id != null) entry["material"] = id;
                list.Add(entry);
                exported.Add(Key(column.Id));
                Count("column");
            }
            catch (Exception ex) { Warnings.Add($"Column {column.Id.Value}: {ex.Message}"); }
        }
        return list;
    }

    // ---- railings and rooms ---------------------------------------------------------------

    private JArray ExportRailings()
    {
        var list = new JArray();
        foreach (var railing in new FilteredElementCollector(doc).OfClass(typeof(Railing)).Cast<Railing>())
        {
            try
            {
                // Stair railings slope with the stair: their true shape comes in as a mesh.
                if (railing.HasHost) continue;
                var points = new List<(double X, double Y)>();
                foreach (var curve in railing.GetPath())
                    foreach (var p in CurvePoints(curve))
                    {
                        var q = Plan(p);
                        if (points.Count == 0 || Math.Abs(points[points.Count - 1].X - q.X) > 0.5 || Math.Abs(points[points.Count - 1].Y - q.Y) > 0.5) points.Add(q);
                    }
                var box = railing.get_BoundingBox(null);
                if (points.Count < 2 || box == null) continue;
                var type = doc.GetElement(railing.GetTypeId()) as RailingType;
                var height = type?.TopRailHeight > 0 ? type.TopRailHeight : box.Max.Z - box.Min.Z;
                list.Add(new JObject
                {
                    ["id"] = Id(railing),
                    ["name"] = Truncate(type?.Name ?? "Railing", 120),
                    ["level"] = LevelOf(railing),
                    ["points"] = new JArray(points.Select(Point)),
                    ["base"] = Elevation(box.Min.Z),
                    ["height"] = Elevation(height),
                });
                exported.Add(Key(railing.Id));
                Count("railing");
            }
            catch (Exception ex) { Warnings.Add($"Railing {railing.Id.Value}: {ex.Message}"); }
        }
        return list;
    }

    private JArray ExportRooms()
    {
        var list = new JArray();
        var options = new SpatialElementBoundaryOptions { SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish };
        foreach (var room in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).OfType<Room>())
        {
            try
            {
                if (room.Area <= 0) continue;
                var loops = room.GetBoundarySegments(options);
                if (loops == null || loops.Count == 0) continue;
                var outline = loops
                    .Select(loop => { var points = new List<(double X, double Y)>(); foreach (var segment in loop) foreach (var p in CurvePoints(segment.GetCurve()).Take(CurvePoints(segment.GetCurve()).Count - 1)) points.Add(Plan(p)); return points; })
                    .Where(points => points.Count >= 3)
                    .OrderByDescending(Area)
                    .FirstOrDefault();
                if (outline == null) continue;
                list.Add(new JObject
                {
                    ["id"] = Id(room),
                    ["name"] = Truncate(room.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? "Room", 120),
                    ["number"] = Truncate(room.Number ?? "", 40),
                    ["level"] = LevelOf(room),
                    ["outline"] = new JArray(outline.Select(Point)),
                });
                Count("room");
            }
            catch (Exception ex) { Warnings.Add($"Room {room.Id.Value}: {ex.Message}"); }
        }
        return list;
    }

    // ---- meshes ---------------------------------------------------------------------------

    private static readonly HashSet<BuiltInCategory> NotGeometry = new HashSet<BuiltInCategory>
    {
        BuiltInCategory.OST_Rooms, BuiltInCategory.OST_Areas, BuiltInCategory.OST_Levels, BuiltInCategory.OST_Grids,
        BuiltInCategory.OST_Cameras, BuiltInCategory.OST_Lines, BuiltInCategory.OST_SketchLines, BuiltInCategory.OST_RvtLinks,
        BuiltInCategory.OST_IOSModelGroups, BuiltInCategory.OST_Viewers, BuiltInCategory.OST_SectionBox, BuiltInCategory.OST_PointClouds,
        BuiltInCategory.OST_ProjectBasePoint, BuiltInCategory.OST_SharedBasePoint, BuiltInCategory.OST_MEPSpaces, BuiltInCategory.OST_StairsPaths,
        // Stair runs, landings and supports are part of their stair's geometry.
        BuiltInCategory.OST_StairsRuns, BuiltInCategory.OST_StairsLandings, BuiltInCategory.OST_StairsStringerCarriage,
    };

    private JArray ExportMeshes()
    {
        var list = new JArray();
        IEnumerable<Element> candidates = Only != null
            ? Only.Select(id => doc.GetElement(new ElementId(id))).Where(e => e != null && !(e is ElementType) && e.ViewSpecific == false)!
            : new FilteredElementCollector(doc).WhereElementIsNotElementType().WhereElementIsViewIndependent();
        var total = Only?.Count ?? ((FilteredElementCollector)candidates).GetElementCount();
        var index = 0;
        var meshProgress = Progress.Range(0.5, 0.97);
        foreach (var element in candidates)
        {
            meshProgress.Step(index, total, $"Reading 3D geometry: element {index + 1} of {total}");
            index++;
            try
            {
                // Doors and windows in exported walls are rebuilt; ArchAI's own model (Live Bridge) never goes back.
                if (exported.Contains(Key(element.Id)) || Live.IsLive(element)) continue;
                var triangles = Triangles(element);
                if (triangles.Count == 0) continue;
                double minX = double.MaxValue, minY = double.MaxValue, minZ = double.MaxValue, maxX = double.MinValue, maxY = double.MinValue, maxZ = double.MinValue;
                foreach (var t in triangles)
                    foreach (var p in new[] { t.A, t.B, t.C })
                    {
                        minX = Math.Min(minX, p.X); maxX = Math.Max(maxX, p.X); minY = Math.Min(minY, p.Y); maxY = Math.Max(maxY, p.Y); minZ = Math.Min(minZ, p.Z); maxZ = Math.Max(maxZ, p.Z);
                    }
                var writer = new GlbWriter();
                // glTF axes: x = plan x, y = up, z = plan y; relative to the element's box corner.
                (double, double, double) Local((double X, double Y, double Z) p) => (p.X - minX, p.Z - minZ, p.Y - minY);
                // Reversing plan y mirrors the geometry, so each triangle's winding flips back.
                foreach (var t in triangles) writer.AddTriangle(t.Material, Local(t.A), Local(t.C), Local(t.B));
                if (writer.TriangleCount == 0) continue;
                var name = element.Name;
                if (element is FamilyInstance instance) name = $"{instance.Symbol.FamilyName} {instance.Symbol.Name}";
                list.Add(new JObject
                {
                    ["id"] = Id(element),
                    ["name"] = Truncate(string.IsNullOrWhiteSpace(name) ? element.Category.Name : name, 120),
                    ["category"] = Truncate(element.Category.Name, 80),
                    ["level"] = LevelOf(element),
                    ["origin"] = new JArray(Math.Round(minX, 1), Math.Round(minY, 1), Math.Round(minZ, 1)),
                    ["size"] = new JArray(Math.Round(maxX - minX, 1), Math.Round(maxY - minY, 1), Math.Round(maxZ - minZ, 1)),
                    ["glb"] = Convert.ToBase64String(writer.ToGlb()),
                });
                // Live Bridge: an editable copy of an ArchAI element.
                if (element is DirectShape copy && copy.ApplicationId == Live.CopyApplicationId && !string.IsNullOrEmpty(copy.ApplicationDataId)) ((JObject)list.Last!)["archai"] = Truncate(copy.ApplicationDataId, 64);
                Count("mesh");
            }
            catch (Exception ex) { Warnings.Add($"Element {element.Id.Value}: {ex.Message}"); }
        }
        return list;
    }

    /// <summary>
    /// Triangles of one model element in ArchAI millimetres (x, plan y, elevation); none for
    /// non-geometry categories and for family instances nested in another (they are in their parent).
    /// </summary>
    internal List<(GlbMaterial Material, (double X, double Y, double Z) A, (double X, double Y, double Z) B, (double X, double Y, double Z) C)> Triangles(Element element)
    {
        var triangles = new List<(GlbMaterial Material, (double X, double Y, double Z) A, (double X, double Y, double Z) B, (double X, double Y, double Z) C)>();
        if (element.Category == null || element.Category.CategoryType != CategoryType.Model) return triangles;
        if (NotGeometry.Contains((BuiltInCategory)element.Category.Id.Value)) return triangles;
        if (element is FamilyInstance { SuperComponent: not null }) return triangles;
        var geometry = element.get_Geometry(geometryOptions);
        if (geometry != null) Collect(geometry, element.Category.Material?.Id ?? ElementId.InvalidElementId, triangles);
        return triangles;
    }

    /// <summary>Triangles of a geometry tree in ArchAI millimetres (x, plan y, elevation).</summary>
    private void Collect(GeometryElement geometry, ElementId fallbackMaterial, List<(GlbMaterial, (double, double, double), (double, double, double), (double, double, double))> output)
    {
        (double, double, double) P(XYZ p) => (p.X * Mm, -p.Y * Mm, p.Z * Mm);
        foreach (var item in geometry)
        {
            switch (item)
            {
                case Solid solid when solid.Faces.Size > 0 && solid.Volume > 1e-9:
                    foreach (Face face in solid.Faces)
                    {
                        var mesh = face.Triangulate(0.5);
                        if (mesh == null) continue;
                        var material = GlbMaterialOf(face.MaterialElementId != ElementId.InvalidElementId ? face.MaterialElementId : fallbackMaterial);
                        for (int i = 0; i < mesh.NumTriangles; i++)
                        {
                            var triangle = mesh.get_Triangle(i);
                            output.Add((material, P(triangle.get_Vertex(0)), P(triangle.get_Vertex(1)), P(triangle.get_Vertex(2))));
                        }
                    }
                    break;
                case Mesh mesh:
                    {
                        var material = GlbMaterialOf(mesh.MaterialElementId != ElementId.InvalidElementId ? mesh.MaterialElementId : fallbackMaterial);
                        for (int i = 0; i < mesh.NumTriangles; i++)
                        {
                            var triangle = mesh.get_Triangle(i);
                            output.Add((material, P(triangle.get_Vertex(0)), P(triangle.get_Vertex(1)), P(triangle.get_Vertex(2))));
                        }
                        break;
                    }
                case GeometryInstance instance:
                    Collect(instance.GetInstanceGeometry(), fallbackMaterial, output);
                    break;
            }
        }
    }

    private static string Truncate(string value, int length) => value.Length <= length ? value : value.Substring(0, length);
}
