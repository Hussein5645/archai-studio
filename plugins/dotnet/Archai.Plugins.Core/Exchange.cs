using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace Archai.Plugins;

/// <summary>
/// The exchange file ArchAI opens (src/revit/exchange.ts in ArchAI, `archaiRevit: 1`): plugins other
/// than Revit send every object as a mesh element, one binary glTF each with its materials, in
/// millimetres as (x, elevation, plan y) relative to the object's box corner.
/// </summary>
public static class Exchange
{
    public static JObject Write(string name, string app, string appVersion, string source, IEnumerable<SceneObject> objects, out int written)
    {
        var meshes = new JArray();
        var index = 0;
        foreach (var o in objects)
        {
            index++;
            if (o.Triangles.Count == 0) continue;
            var box = new Bounds();
            foreach (var t in o.Triangles) { box.Add(t.A); box.Add(t.B); box.Add(t.C); }
            var writer = new GlbWriter();
            (double, double, double) Local(ArchaiPoint p) => (p.X - box.MinX, p.Elevation - box.MinZ, p.PlanY - box.MinY);
            // As the Revit add-in writes them: reversing plan y mirrors the geometry, so the winding flips back.
            foreach (var (material, a, b, c) in o.Triangles) writer.AddTriangle(material, Local(a), Local(c), Local(b));
            if (writer.TriangleCount == 0) continue;
            meshes.Add(new JObject
            {
                ["id"] = Truncate(o.Id.Length > 0 ? o.Id : "o" + index, 64),
                ["name"] = Truncate(o.Name, 120),
                ["category"] = Truncate(o.Category, 80),
                ["level"] = null,
                ["origin"] = new JArray(Math.Round(box.MinX, 1), Math.Round(box.MinY, 1), Math.Round(box.MinZ, 1)),
                ["size"] = new JArray(Math.Round(box.MaxX - box.MinX, 1), Math.Round(box.MaxY - box.MinY, 1), Math.Round(box.MaxZ - box.MinZ, 1)),
                ["glb"] = Convert.ToBase64String(writer.ToGlb("ArchAI " + app + " plugin")),
            });
        }
        written = meshes.Count;
        return new JObject
        {
            ["archaiRevit"] = 1,
            ["app"] = app,
            ["name"] = Truncate(string.IsNullOrWhiteSpace(name) ? app + " model" : name, 200),
            ["source"] = Truncate(source, 1000),
            ["revitVersion"] = Truncate(app + " " + appVersion, 40),
            ["materials"] = new JArray(),
            ["levels"] = new JArray(),
            ["meshes"] = meshes,
        };
    }

    internal static string Truncate(string value, int length) => value.Length <= length ? value : value.Substring(0, length);
}
