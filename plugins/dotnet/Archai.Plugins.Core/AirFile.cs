using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Archai.Plugins;

/// <summary>
/// Reads an .AIR file for import into a host app: an ArchAI document through the 3D snapshot ArchAI
/// saves in it (`scene3d`), or an exchange file another plugin wrote (its meshes). Objects come back
/// in world glTF metres (x, up, plan y); see <see cref="HostAxes"/>.
/// </summary>
public static class AirFile
{
    public sealed class Contents
    {
        public string Name = "";
        public readonly List<ImportObject> Objects = new List<ImportObject>();
    }

    public const string NoSnapshot = "This .AIR file has no 3D model saved in it. Open it in ArchAI (0.2.2.8 or later) and save it once, then import it again.";

    public static Contents Read(string path)
    {
        JObject root;
        using (var reader = new JsonTextReader(new StreamReader(path)) { DateParseHandling = DateParseHandling.None, MaxDepth = 256 })
        {
            try { root = JObject.Load(reader); }
            catch (JsonException) { throw new FormatException(Path.GetFileName(path) + " is not an ArchAI .AIR file."); }
        }
        var contents = new Contents { Name = Path.GetFileNameWithoutExtension(path) };
        if (root["archaiRevit"] != null)
        {
            contents.Name = (string?)root["name"] is { Length: > 0 } exchangeName ? exchangeName : contents.Name;
            var levels = (root["levels"] as JArray ?? new JArray()).ToDictionary(l => (string?)l["id"] ?? "", l => (string?)l["name"] ?? "");
            foreach (var mesh in root["meshes"] as JArray ?? new JArray())
            {
                var data = (string?)mesh["glb"];
                var origin = mesh["origin"] as JArray;
                if (data == null || origin == null || origin.Count < 3) continue;
                double ox = (double)origin[0], oy = (double)origin[1], oz = (double)origin[2];
                var parts = GlbReader.Read(Convert.FromBase64String(data)).SelectMany(o => o.Parts).ToList();
                if (parts.Count == 0) continue;
                var item = new ImportObject
                {
                    Name = (string?)mesh["name"] is { Length: > 0 } n ? n : (string?)mesh["category"] ?? "Mesh",
                    Type = (string?)mesh["category"] ?? "",
                    Level = levels.TryGetValue((string?)mesh["level"] ?? "", out var level) ? level : "",
                };
                foreach (var part in parts)
                {
                    // Millimetres (x, elevation, plan y) from the box corner, with the winding flipped back.
                    var p = part.Positions;
                    for (int i = 0; i + 2 < p.Length; i += 3)
                    {
                        p[i] = (float)((p[i] + ox) / 1000); p[i + 1] = (float)((p[i + 1] + oz) / 1000); p[i + 2] = (float)((p[i + 2] + oy) / 1000);
                    }
                    for (int i = 0; i + 2 < part.Indices.Length; i += 3) (part.Indices[i + 1], part.Indices[i + 2]) = (part.Indices[i + 2], part.Indices[i + 1]);
                    item.Parts.Add(part);
                }
                contents.Objects.Add(item);
            }
            return contents;
        }
        if (root["schemaVersion"] == null) throw new FormatException(Path.GetFileName(path) + " is not an ArchAI .AIR file.");
        contents.Name = (string?)root["meta"]?["name"] is { Length: > 0 } name ? name : contents.Name;
        var snapshot = root["scene3d"];
        if (!(snapshot?["data"] is JValue { Type: JTokenType.String } encoded)) throw new FormatException(NoSnapshot);
        contents.Objects.AddRange(GlbReader.Read(Convert.FromBase64String((string)encoded!)));
        return contents;
    }

    /// <summary>The levels in import order, objects without a level last ("").</summary>
    public static IEnumerable<IGrouping<string, ImportObject>> ByLevel(IEnumerable<ImportObject> objects) =>
        objects.GroupBy(o => o.Level ?? "").OrderBy(g => g.Key.Length == 0 ? 1 : 0).ThenBy(g => g.Min(o => o.Parts.SelectMany(p => Heights(p)).DefaultIfEmpty(0).Min()));

    private static IEnumerable<float> Heights(ImportPart part)
    {
        for (int i = 1; i < part.Positions.Length; i += 3) yield return part.Positions[i];
    }
}
