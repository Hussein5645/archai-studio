using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace Archai.Plugins;

/// <summary>A stop of a VR tour, in viewer metres: plan position (x, z), floor height and a look point.</summary>
public sealed class VrStop
{
    public string Id = "", Name = "";
    public double X, Z, Floor, LookX, LookZ;

    /// <summary>How far ahead of a stop its look point lies, in metres (as in ArchAI).</summary>
    public const double LookDistance = 3;
    /// <summary>Standing eye height used to put a camera's visitor on a floor, in metres.</summary>
    public const double EyeHeight = 1.6;

    /// <summary>
    /// A stop at a camera: standing an eye height below it (or on <paramref name="floorMm"/>), facing
    /// the camera's plan direction (<paramref name="direction"/>.X, .PlanY; Elevation is ignored).
    /// </summary>
    public static VrStop FromCamera(string name, ArchaiPoint eye, ArchaiPoint direction, double? floorMm = null)
    {
        var (x, _, z) = eye.Gltf;
        double dx = direction.X, dz = direction.PlanY;
        var length = Math.Sqrt(dx * dx + dz * dz);
        if (length < 1e-9) (dx, dz, length) = (1, 0, 1);
        return new VrStop
        {
            Name = Exchange.Truncate(string.IsNullOrWhiteSpace(name) ? "View" : name.Trim(), 120),
            X = x, Z = z,
            Floor = floorMm.HasValue ? floorMm.Value / 1000 : eye.Elevation / 1000 - EyeHeight,
            LookX = x + dx / length * LookDistance, LookZ = z + dz / length * LookDistance,
        };
    }
}

/// <summary>
/// A VR tour in the SJP-VR viewer's format (docs/vr-tours.md in ArchAI): the model as one binary
/// glTF in metres with a ground disc, and the tour file with its stops.
/// </summary>
public static class VrTour
{
    public const int MaxStops = 40;

    public sealed class Result
    {
        public byte[] Model = Array.Empty<byte>();
        public JObject Json = new JObject();
        public int Triangles, Stops;
    }

    /// <summary>The model: one node per object, plus a ground disc at <paramref name="groundMm"/> (default: the model's underside).</summary>
    public static GlbWriter Model(IEnumerable<SceneObject> objects, Bounds bounds, double? groundMm = null, string generator = "ArchAI plugin")
    {
        var writer = new GlbWriter();
        foreach (var o in objects)
        {
            if (o.Triangles.Count == 0) continue;
            writer.BeginNode(o.Name);
            foreach (var (material, a, b, c) in o.Triangles) writer.AddTriangle(material, a.Gltf, b.Gltf, c.Gltf);
        }
        if (!bounds.IsEmpty) AddGround(writer, bounds, (groundMm ?? bounds.MinZ) / 1000);
        return writer;
    }

    /// <summary>A disc under the model so visitors never look into a void (as ArchAI's VR export).</summary>
    public static void AddGround(GlbWriter writer, Bounds bounds, double groundMetres)
    {
        var cx = (bounds.MinX + bounds.MaxX) / 2000;
        var cz = (bounds.MinY + bounds.MaxY) / 2000;
        var radius = Math.Max(bounds.MaxX - bounds.MinX, bounds.MaxY - bounds.MinY) / 2000;
        var disc = new GlbMaterial { Name = "Ground", R = 0xd9 / 255.0, G = 0xdb / 255.0, B = 0xd5 / 255.0, Roughness = 1 };
        var r = Math.Max(radius * 4, 60);
        var y = groundMetres - 0.025;
        const int segments = 64;
        writer.BeginNode("Ground");
        for (int i = 0; i < segments; i++)
        {
            double a0 = 2 * Math.PI * i / segments, a1 = 2 * Math.PI * (i + 1) / segments;
            writer.AddTriangle(disc, (cx, y, cz), (cx + Math.Cos(a1) * r, y, cz + Math.Sin(a1) * r), (cx + Math.Cos(a0) * r, y, cz + Math.Sin(a0) * r));
        }
    }

    /// <summary>Standing outside the model, looking at it: the stop when there is nothing better.</summary>
    public static VrStop Outside(Bounds bounds, double? groundMm = null)
    {
        var cx = (bounds.MinX + bounds.MaxX) / 2000;
        var cz = (bounds.MinY + bounds.MaxY) / 2000;
        var back = Math.Max(bounds.MaxX - bounds.MinX, bounds.MaxY - bounds.MinY) / 2000 + 5;
        return new VrStop { Name = "Outside", X = cx, Z = cz + back, Floor = (groundMm ?? bounds.MinZ) / 1000, LookX = cx, LookZ = cz };
    }

    /// <summary>The tour file; <paramref name="start"/> is the stop the visitor arrives at (default the first).</summary>
    public static JObject Json(string name, string credit, IList<VrStop> stops, VrStop? start = null)
    {
        for (int i = 0; i < stops.Count; i++) stops[i].Id = "s" + (i + 1);
        double R(double v) => Math.Round(v, 3);
        return new JObject
        {
            ["format"] = "archai-vr",
            ["version"] = 1,
            ["name"] = Exchange.Truncate(string.IsNullOrWhiteSpace(name) ? "Model" : name, 120),
            // A new model URL each time: the share service lets browsers cache models for a day.
            ["model"] = "model.glb?v=" + DateTime.UtcNow.ToString("yyyyMMddHHmmss"),
            ["lighting"] = "live",
            ["exposure"] = 1.1,
            ["credit"] = credit,
            ["start"] = (start != null && stops.Contains(start) ? start : stops[0]).Id,
            ["spaces"] = new JArray(stops.Select(s => new JObject
            {
                ["id"] = s.Id,
                ["name"] = s.Name,
                ["center"] = new JArray(R(s.X), R(s.Z)),
                ["look"] = new JArray(R(s.LookX), R(s.LookZ)),
                ["floor"] = R(s.Floor),
            })),
        };
    }

    /// <summary>A whole tour from host objects and camera stops (an outside stop when there are none).</summary>
    public static Result Build(string name, string app, IList<SceneObject> objects, IList<VrStop> cameras, string? startCamera = null, double? groundMm = null)
    {
        var bounds = Bounds.Of(objects);
        var writer = Model(objects, bounds, groundMm, "ArchAI " + app + " plugin");
        var result = new Result { Triangles = writer.TriangleCount };
        if (bounds.IsEmpty) return result;
        var stops = cameras.Take(MaxStops).ToList();
        if (stops.Count == 0) stops.Add(Outside(bounds, groundMm));
        result.Model = writer.ToGlb("ArchAI " + app + " plugin");
        result.Json = Json(name, app + " model via ArchAI", stops, stops.FirstOrDefault(s => s.Name == startCamera));
        result.Stops = stops.Count;
        return result;
    }
}
