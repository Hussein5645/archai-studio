using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.DB.ExtensibleStorage;
using Archai.Air;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Archai.Revit;

internal sealed class NativeImporter
{
    private readonly Document doc;
    private readonly AirDocument source;
    private readonly string batch = Guid.NewGuid().ToString("N").Substring(0, 8);
    private readonly Dictionary<string, List<ElementId>> imported = new Dictionary<string, List<ElementId>>();
    private readonly Dictionary<string, Level> explicitLevels = new Dictionary<string, Level>();
    private readonly List<Level> levels = new List<Level>();
    private readonly Schema provenance;
    public NativeImporter(Document doc, AirDocument source)
    {
        this.doc = doc; this.source = source;
        var guid = new Guid("4c54085a-7f69-4d58-a183-ec2028e20771");
        provenance = Schema.Lookup(guid) ?? MakeSchema(guid);
    }
    private static Schema MakeSchema(Guid guid)
    {
        var builder = new SchemaBuilder(guid);
        builder.SetSchemaName("ArchaiAirSourceV1");
        builder.SetReadAccessLevel(AccessLevel.Public); builder.SetWriteAccessLevel(AccessLevel.Public);
        builder.AddSimpleField("DocumentId", typeof(string));
        builder.AddSimpleField("ElementId", typeof(string));
        builder.AddSimpleField("SourceJson", typeof(string));
        return builder.Finish();
    }
    private void Tag(Element target, AirElement e)
    {
        var entity = new Entity(provenance);
        entity.Set("DocumentId", source.Id); entity.Set("ElementId", e.Id);
        entity.Set("SourceJson", e.Raw.ToString(Formatting.None));
        target.SetEntity(entity);
        var comments = target.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
        if (comments != null && !comments.IsReadOnly) comments.Set($"AIR: {e.Name} | {e.Id}");
    }
    /// <summary>Progress of <see cref="Run"/> (Open .AIR shows it).</summary>
    public Archai.Plugins.ProgressReport? Progress { get; set; }

    public ImportReport Run()
    {
        var report = new ImportReport { DocumentId = source.Id, RevitVersion = doc.Application.VersionNumber };
        var factory = new FamilyFactory(doc, source, batch);
        using var all = new TransactionGroup(doc, "Import ArchAI AIR model");
        all.Start();
        var ordered = source.Elements.Values.OrderBy(Priority).ToList();
        for (var index = 0; index < ordered.Count; index++)
        {
            var e = ordered[index];
            Archai.Plugins.Progress.Step(Progress, index, ordered.Count, $"Building element {index + 1} of {ordered.Count}: {e.Name}");
            var item = new ImportItem { SourceId = e.Id, Name = e.Name, Type = e.Type.Length > 0 ? e.Type : e.Kind };
            report.Items.Add(item);
            var reason = SkipReason(e);
            if (reason != null) { item.Status = "skipped"; item.Detail = reason; continue; }
            using var objectGroup = new TransactionGroup(doc, "AIR " + e.Name);
            objectGroup.Start();
            try
            {
                List<Element> result;
                if (e.Type == "stair") result = Stair(e, item.Warnings);
                else
                {
                    FamilySymbol? symbol = NeedsFamily(e) ? factory.Create(e, item.Warnings) : null;
                    using var transaction = new Transaction(doc, "Create " + e.Name);
                    transaction.Start();
                    transaction.SetFailureHandlingOptions(transaction.GetFailureHandlingOptions().SetFailuresPreprocessor(new ImportFailures(item.Warnings)).SetClearAfterRollback(true));
                    result = Create(e, symbol, item.Warnings);
                    foreach (var element in result) Tag(element, e);
                    if (transaction.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Revit rejected this object's geometry; changes were rolled back.");
                }
                objectGroup.Assimilate();
                imported[e.Id] = result.Select(x => x.Id).ToList();
                item.RevitUniqueIds = result.Select(x => x.UniqueId).ToList();
                item.Status = "created";
            }
            catch (Exception ex)
            {
                if (objectGroup.GetStatus() == TransactionStatus.Started) objectGroup.RollBack();
                // No cached handles to rolled-back levels are reused by subsequent objects.
                levels.RemoveAll(l => !l.IsValidObject);
                foreach (var key in explicitLevels.Where(p => !p.Value.IsValidObject).Select(p => p.Key).ToList()) explicitLevels.Remove(key);
                item.Status = "failed"; item.Detail = ex.Message;
            }
        }
        if (report.Items.All(i => i.Status != "created")) all.RollBack(); else all.Assimilate();
        return report;
    }
    private static int Priority(AirElement e) => e.Type switch
    {
        "level" => 0, "wall" or "curtain-wall" => 1, "floor" or "ceiling" or "room-divider" => 2,
        "door" or "window" or "column" => 3, "stair" => 4, "railing" => 5, "room" => 6, _ => 7
    };
    private string? SkipReason(AirElement e)
    {
        if (source.IsStairPart(e) && e.Type != "railing") return "Generated stair display child; represented by its native parent stair.";
        if (e.Kind == "group" && e.Type != "stair") return "Organizational group; its children are imported separately.";
        if (e.Kind == "text" || e.Kind == "image") return "2D annotation/image has no native model-family geometry in this importer.";
        if (e.Type.Length == 0 && e.Meta?["solid"] == null) return "No architectural semantics or explicit solid geometry. Catalog/modeling meshes require a dedicated geometry converter.";
        if (e.Meta?["body"] != null || e.Meta?["modeling"] != null) return "Modeling feature geometry is not supported by this importer.";
        return null;
    }
    private static bool NeedsFamily(AirElement e) => e.Type == "door" || e.Type == "window" || e.Type == "column" || e.Type == "facade-element" || e.Type.Length == 0;
    private Level AtElevation(double mm, string? name = null)
    {
        var level = levels.FirstOrDefault(l => l.IsValidObject && Math.Abs(l.Elevation - Geometry.Feet(mm)) < 1e-7);
        if (level != null) return level;
        level = Level.Create(doc, Geometry.Feet(mm));
        level.Name = $"AIR {batch} {name ?? mm.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) + " mm"} {levels.Count + 1}";
        levels.Add(level);
        return level;
    }
    private Level BaseLevel(AirElement e)
    {
        var linked = e.Meta?["levelConstraint"].S("levelId") ?? "";
        if (linked.Length > 0)
        {
            if (explicitLevels.TryGetValue(linked, out var explicitLevel)) return explicitLevel;
            throw new InvalidOperationException("The linked AIR level failed to import: " + linked);
        }
        var elevation = Geometry.Feet(source.Elevation(e));
        return levels.Where(l => l.IsValidObject && l.Elevation <= elevation + 1e-7).OrderByDescending(l => l.Elevation).FirstOrDefault() ?? AtElevation(source.Elevation(e));
    }
    private List<Element> Create(AirElement e, FamilySymbol? symbol, List<string> warnings)
    {
        if (e.Type == "level")
        {
            // Explicit source datums stay distinct even when their elevations coincide.
            var level = Level.Create(doc, Geometry.Feet(source.Elevation(e)));
            level.Name = $"AIR {batch} {e.Name} {levels.Count + 1}";
            levels.Add(level); explicitLevels[e.Id] = level;
            return new List<Element> { level };
        }
        var baseLevel = BaseLevel(e);
        switch (e.Type)
        {
            case "wall": case "curtain-wall": return Walls(e, baseLevel, warnings);
            case "floor": case "ceiling": return new List<Element> { Slab(e, baseLevel, warnings) };
            case "room-divider": return RoomBoundary(e, baseLevel, warnings);
            case "room": return new List<Element> { Room(e, baseLevel, warnings) };
            case "railing": return new List<Element> { Rail(e, baseLevel, warnings) };
            default:
                if (symbol == null) throw new NotSupportedException("Unsupported AIR architectural type: " + e.Type);
                return new List<Element> { Instance(e, symbol, baseLevel, warnings) };
        }
    }
    private List<Element> Walls(AirElement e, Level level, List<string> warnings)
    {
        var curtain = e.Type == "curtain-wall";
        var template = new FilteredElementCollector(doc).OfClass(typeof(WallType)).Cast<WallType>().FirstOrDefault(t => t.Kind == (curtain ? WallKind.Curtain : WallKind.Basic))
            ?? throw new InvalidOperationException("Project contains no suitable wall type.");
        var type = (WallType)template.Duplicate($"AIR {batch} {e.Id}");
        if (!curtain)
        {
            var layers = new List<CompoundStructureLayer>();
            if (e.Parameters?["layers"] is JArray array)
                foreach (var l in array)
                    layers.Add(new CompoundStructureLayer(Geometry.Feet(l.N("thickness", 200)), l.S("role") == "core" ? MaterialFunctionAssignment.Structure : MaterialFunctionAssignment.Finish1, Material(l.S("name", "Wall"))));
            else layers.Add(new CompoundStructureLayer(Geometry.Feet(e.P("thickness", 200)), MaterialFunctionAssignment.Structure, Material("Wall")));
            var compound = CompoundStructure.CreateSimpleCompoundStructure(layers);
            type.SetCompoundStructure(compound);
        }
        else warnings.Add("Curtain wall uses a duplicated project curtain-wall type; custom mullion spacing, panel profiles and materials require review.");
        var curves = Geometry.Curves(source, e, source.Elevation(e), e.Raw.B("closed"), warnings);
        var result = new List<Element>();
        foreach (var curve in curves)
        {
            var wall = Wall.Create(doc, curve, type.Id, level.Id, Geometry.Feet(e.P("height", 3000)), Geometry.Feet(source.Elevation(e)) - level.Elevation, false, false);
            var location = e.Parameters.S("locationLine", "centre");
            var key = location == "inside" ? 3 : location == "outside" ? 2 : 0;
            wall.get_Parameter(BuiltInParameter.WALL_KEY_REF_PARAM)?.Set(key);
            // AIR placement already converted the traced location line to a stored centreline.
            // Setting the Revit location-line parameter must not offset this geometry a second time.
            WallUtils.DisallowWallJoinAtEnd(wall, 0); WallUtils.DisallowWallJoinAtEnd(wall, 1);
            result.Add(wall);
        }
        return result;
    }
    private ElementId Material(string name)
    {
        var label = "AIR " + batch + " " + name;
        return new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(m => m.Name == label)?.Id ?? Autodesk.Revit.DB.Material.Create(doc, label);
    }
    private Element Slab(AirElement e, Level level, List<string> warnings)
    {
        if (e.Kind == "line" && !e.Raw.B("closed")) throw new FormatException("Slab outline must be closed.");
        var floor = e.Type == "floor";
        var thickness = e.P("thickness", floor ? 200 : 100);
        var loop = Geometry.Loop(Geometry.Curves(source, e, 0, true, warnings));
        var layers = new List<CompoundStructureLayer> { new CompoundStructureLayer(Geometry.Feet(thickness), MaterialFunctionAssignment.Structure, Material(e.Parameters.S("material", "Slab"))) };
        // AIR solid.elevation is the BOTTOM; native slab elevation is its TOP.
        var offset = Geometry.Feet(source.Elevation(e) + thickness) - level.Elevation;
        if (floor)
        {
            var template = new FilteredElementCollector(doc).OfClass(typeof(FloorType)).Cast<FloorType>().FirstOrDefault(t => !t.IsFoundationSlab) ?? throw new InvalidOperationException("No floor type available.");
            var type = (FloorType)template.Duplicate($"AIR {batch} {e.Id}");
            type.SetCompoundStructure(CompoundStructure.CreateSimpleCompoundStructure(layers));
            var result = Floor.Create(doc, new List<CurveLoop> { loop }, type.Id, level.Id);
            Geometry.Set(result, BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM, offset);
            return result;
        }
        else
        {
            var template = new FilteredElementCollector(doc).OfClass(typeof(CeilingType)).Cast<CeilingType>().FirstOrDefault(t => t.GetCompoundStructure() != null) ?? throw new InvalidOperationException("No compound ceiling type available.");
            var type = (CeilingType)template.Duplicate($"AIR {batch} {e.Id}");
            type.SetCompoundStructure(CompoundStructure.CreateSimpleCompoundStructure(layers));
            var result = Ceiling.Create(doc, new List<CurveLoop> { loop }, type.Id, level.Id);
            // Revit ceiling height is the underside, unlike floors.
            Geometry.Set(result, BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM, Geometry.Feet(source.Elevation(e)) - level.Elevation);
            return result;
        }
    }
    private ViewPlan Plan(Level level)
    {
        var existing = new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>().FirstOrDefault(v => !v.IsTemplate && v.GenLevel?.Id == level.Id && v.ViewType == ViewType.FloorPlan);
        if (existing != null) return existing;
        var type = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().First(t => t.ViewFamily == ViewFamily.FloorPlan);
        return ViewPlan.Create(doc, type.Id, level.Id);
    }
    private List<Element> RoomBoundary(AirElement e, Level level, List<string> warnings)
    {
        var curves = Geometry.Curves(source, e, level.Elevation * 304.8, e.Raw.B("closed"), warnings);
        var plane = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisZ, new XYZ(0, 0, level.Elevation)));
        return doc.Create.NewRoomBoundaryLines(plane, Geometry.Array(curves), Plan(level)).Cast<Element>().ToList();
    }
    private Room Room(AirElement e, Level level, List<string> warnings)
    {
        if (e.Kind == "line" && !e.Raw.B("closed")) throw new FormatException("Room outline must be closed.");
        var point = source.World(e, AirDocument.Interior(source.Footprint(e)));
        var room = doc.Create.NewRoom(level, new UV(Geometry.Feet(point.X), -Geometry.Feet(point.Y)));
        room.Name = e.Name;
        var number = e.Arch.S("number"); if (number.Length > 0) room.Number = number;
        doc.Regenerate();
        if (room.Area <= 0) throw new InvalidOperationException("Room is not enclosed by imported native walls/room dividers. Add room boundaries in AIR and retry.");
        warnings.Add("Room enclosure is calculated by Revit from native boundaries; verify area and upper limit against AIR.");
        return room;
    }
    private FamilyInstance Instance(AirElement e, FamilySymbol symbol, Level level, List<string> warnings)
    {
        symbol.Activate(); doc.Regenerate();
        var elevation = source.Elevation(e);
        if (e.Type == "door" || e.Type == "window")
        {
            var opening = e.Arch?["opening"];
            var hostId = opening.S("wallId", e.Host);
            if (!imported.TryGetValue(hostId, out var candidates)) throw new InvalidOperationException("Door/window needs an imported AIR wall host.");
            var centerY = e.Arch.N("wallMountOffset", e.Type == "door" ? (e.Parameters.S("openingSide", "inside") == "outside" ? e.Depth : 0) : e.Depth / 2);
            var expected = Geometry.Xyz(source.World(e, new Point2(e.Width / 2, centerY)), elevation);
            var host = candidates.Select(id => doc.GetElement(id)).OfType<Wall>().OrderBy(w => ((LocationCurve)w.Location).Curve.Distance(new XYZ(expected.X, expected.Y, ((LocationCurve)w.Location).Curve.GetEndPoint(0).Z))).FirstOrDefault()
                ?? throw new InvalidOperationException("AIR host is not a native wall.");
            var hostCurve = ((LocationCurve)host.Location).Curve;
            var projected = hostCurve.Project(new XYZ(expected.X, expected.Y, hostCurve.GetEndPoint(0).Z))?.XYZPoint ?? throw new InvalidOperationException("Cannot project opening onto host wall.");
            if (new XYZ(projected.X, projected.Y, expected.Z).DistanceTo(expected) > host.Width / 2 + Geometry.Feet(10)) throw new InvalidOperationException("Opening is too far from its host wall.");
            var point = new XYZ(projected.X, projected.Y, Geometry.Feet(elevation));
            var instance = doc.Create.NewFamilyInstance(point, symbol, host, level, StructuralType.NonStructural);
            Geometry.Set(instance, BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM, Geometry.Feet(elevation) - level.Elevation);
            var desiredFacing = new XYZ(-Math.Sin(source.Angle(e)), Math.Cos(source.Angle(e)), 0);
            if (instance.CanFlipFacing && instance.FacingOrientation.DotProduct(desiredFacing) < 0) instance.flipFacing();
            warnings.Add("Review hosted family's facing/hand orientation in Revit; placement and sill are mapped from AIR.");
            return instance;
        }
        var local = e.Type == "column" ? new Point2(e.Width / 2, e.Depth / 2) : new Point2(0, 0);
        var origin = Geometry.Xyz(source.World(e, local), elevation);
        var placed = doc.Create.NewFamilyInstance(origin, symbol, level, StructuralType.NonStructural);
        if (Math.Abs(source.Angle(e)) > 1e-10) ElementTransformUtils.RotateElement(doc, placed.Id, Line.CreateBound(origin, origin + XYZ.BasisZ), source.Angle(e));
        return placed;
    }
    private Railing Rail(AirElement e, Level level, List<string> warnings)
    {
        var template = new FilteredElementCollector(doc).OfClass(typeof(RailingType)).Cast<RailingType>().FirstOrDefault() ?? throw new InvalidOperationException("Project has no railing type.");
        var type = (RailingType)template.Duplicate($"AIR {batch} {e.Id}");
        type.TopRailHeight = Geometry.Feet(e.P("height", 1100));
        var loop = Geometry.Loop(Geometry.Curves(source, e, 0, e.Raw.B("closed"), warnings));
        var result = Railing.Create(doc, loop, type.Id, level.Id);
        if (e.Meta.B("stairAttached"))
        {
            var parent = source.Ancestors(e).FirstOrDefault(a => a.Type == "stair");
            if (parent == null || !imported.TryGetValue(parent.Id, out var ids)) throw new InvalidOperationException("Attached stair railing's native stair was not imported.");
            result.HostId = ids[0];
            Geometry.Set(result, BuiltInParameter.STAIRS_RAILING_HEIGHT_OFFSET, Geometry.Feet(e.P("elevation", 0)));
        }
        else Geometry.Set(result, BuiltInParameter.STAIRS_RAILING_HEIGHT_OFFSET, Geometry.Feet(source.Elevation(e)) - level.Elevation);
        warnings.Add("Native railing follows the AIR plan path and top-rail height using a duplicated project type; custom baluster spacing and panel geometry require review.");
        return result;
    }
    private List<Element> Stair(AirElement e, List<string> warnings)
    {
        var flights = e.Arch?["flights"] as JArray ?? throw new FormatException("Stair has no flights.");
        var count = flights.Where(f => f.S("kind") == "run").Sum(f => (int)f.N("treads"));
        if (count < 2) throw new FormatException("Stair needs at least two risers.");
        var riser = e.P("riserHeight", 175); var tread = e.P("treadDepth", 280); var width = e.P("width", 1000);
        var rise = count * riser;
        var baseMm = source.Elevation(e);
        Level bottom, top;
        using (var tx = new Transaction(doc, "AIR stair levels"))
        {
            tx.Start(); bottom = AtElevation(baseMm); top = AtElevation(baseMm + rise);
            tx.SetFailureHandlingOptions(tx.GetFailureHandlingOptions().SetFailuresPreprocessor(new ImportFailures(warnings)).SetClearAfterRollback(true));
            if (tx.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Could not create stair levels.");
        }
        ElementId stairId;
        using (var scope = new StairsEditScope(doc, "AIR native stair"))
        {
            stairId = scope.Start(bottom.Id, top.Id);
            using (var tx = new Transaction(doc, "AIR runs and landings"))
            {
                tx.Start();
                tx.SetFailureHandlingOptions(tx.GetFailureHandlingOptions().SetFailuresPreprocessor(new ImportFailures(warnings)).SetClearAfterRollback(true));
                var stairs = (Stairs)doc.GetElement(stairId);
                var type = (StairsType)doc.GetElement(stairs.GetTypeId());
                var newType = (StairsType)type.Duplicate($"AIR {batch} {e.Id}");
                newType.MinRunWidth = Geometry.Feet(width);
                newType.MinTreadDepth = Geometry.Feet(tread);
                newType.MaxRiserHeight = Geometry.Feet(riser);
                stairs.ChangeTypeId(newType.Id);
                stairs.DesiredRisersNumber = count;
                stairs.ActualTreadDepth = Geometry.Feet(tread);
                doc.Regenerate();
                double height = 0;
                foreach (var f in flights)
                {
                    double angle = f.N("angle") * Math.PI / 180;
                    XYZ P(double along, double across, double z = 0) => Geometry.Xyz(source.World(e, new Point2(f.N("x") + Math.Cos(angle) * along - Math.Sin(angle) * across, f.N("y") + Math.Sin(angle) * along + Math.Cos(angle) * across)), z);
                    if (f.S("kind") == "landing")
                    {
                        double length = f.N("depth", e.P("landingDepth", 1000)), across = f.N("width", width), start = f.N("offset") - width / 2;
                        var corners = new[] { P(0, start), P(length, start), P(length, start + across), P(0, start + across) };
                        var curves = Enumerable.Range(0, 4).Select(i => (Curve)Line.CreateBound(corners[i], corners[(i + 1) % 4])).ToList();
                        StairsLanding.CreateSketchedLanding(doc, stairId, Geometry.Loop(curves), Geometry.Feet(height));
                    }
                    else
                    {
                        int treads = (int)f.N("treads");
                        if (treads < 2) throw new FormatException("A native sketched stair run requires at least two riser lines.");
                        double length = treads * tread;
                        var boundaries = new List<Curve> { Line.CreateBound(P(0, -width / 2), P(length, -width / 2)), Line.CreateBound(P(0, width / 2), P(length, width / 2)) };
                        var risers = Enumerable.Range(0, treads).Select(i => (Curve)Line.CreateBound(P(i * tread, -width / 2), P(i * tread, width / 2))).ToList();
                        // The API path must terminate on the last riser, not at the end of the final tread.
                        var path = new List<Curve> { Line.CreateBound(P(0, 0), P((treads - 1) * tread, 0)) };
                        StairsRun.CreateSketchedRun(doc, stairId, Geometry.Feet(height), boundaries, risers, path);
                        height += treads * riser;
                    }
                }
                if (tx.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Stair run transaction failed.");
            }
            scope.Commit(new ImportFailures(warnings));
        }
        var result = doc.GetElement(stairId) as Stairs ?? throw new InvalidOperationException("Revit rejected the native stair configuration.");
        using (var tx = new Transaction(doc, "AIR stair provenance"))
        {
            tx.Start(); Tag(result, e);
            // Imported AIR railings are separate objects. Remove Revit's automatic duplicates.
            foreach (var id in result.GetAssociatedRailings()) doc.Delete(id);
            if (tx.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Could not finalize stair.");
        }
        if (Math.Abs(rise - e.P("totalRise", 3000)) > 0.1) warnings.Add("Top level follows the AIR drawn treads × riser height, which differs from configured totalRise.");
        warnings.Add("Native sketched stair: Revit controls supports, tread/riser profiles and code constraints. Review custom nosing, open risers and landing thickness.");
        return new List<Element> { result };
    }
}
