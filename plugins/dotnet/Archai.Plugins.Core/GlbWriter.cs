using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json.Linq;

namespace Archai.Plugins;

/// <summary>A material of an exported mesh (glTF metallic-roughness); colours are sRGB 0..1.</summary>
public sealed class GlbMaterial
{
    public string Name = "Material";
    public double R = 0.8, G = 0.8, B = 0.8, Opacity = 1, Roughness = 0.8, Metalness = 0;

    public static readonly GlbMaterial Default = new GlbMaterial { Name = "Default", R = 0.78, G = 0.79, B = 0.81 };

    /// <summary>"#rrggbb" of the colour.</summary>
    public string Hex => $"#{Byte(R):x2}{Byte(G):x2}{Byte(B):x2}";
    private static int Byte(double c) => (int)Math.Round(Math.Max(0, Math.Min(1, c)) * 255);
}

/// <summary>
/// Collects triangles per node and material and writes one binary glTF: one node and mesh per
/// <see cref="BeginNode"/> (or a single one), one primitive per material, positions only (glTF
/// viewers compute flat normals), uint32 indices. Coordinates are written as given.
/// </summary>
public sealed class GlbWriter
{
    private sealed class Part
    {
        public readonly List<float> Positions = new List<float>();
        public readonly List<uint> Indices = new List<uint>();
        public readonly Dictionary<(float, float, float), uint> Lookup = new Dictionary<(float, float, float), uint>();
    }

    private sealed class Node
    {
        public string Name = "";
        public JObject? Extras;
        public readonly Dictionary<string, (GlbMaterial Material, Part Part)> Parts = new Dictionary<string, (GlbMaterial, Part)>();
    }

    private readonly List<Node> nodes = new List<Node>();
    public int TriangleCount { get; private set; }

    /// <summary>Starts a new node: the triangles added next belong to it.</summary>
    public void BeginNode(string name, JObject? extras = null) => nodes.Add(new Node { Name = name, Extras = extras });

    public void AddTriangle(GlbMaterial material, (double X, double Y, double Z) a, (double X, double Y, double Z) b, (double X, double Y, double Z) c)
    {
        if (nodes.Count == 0) BeginNode("");
        var node = nodes[nodes.Count - 1];
        if (!node.Parts.TryGetValue(material.Name, out var entry)) node.Parts[material.Name] = entry = (material, new Part());
        var part = entry.Part;
        uint Vertex((double X, double Y, double Z) p)
        {
            var key = ((float)p.X, (float)p.Y, (float)p.Z);
            if (part.Lookup.TryGetValue(key, out var index)) return index;
            index = (uint)(part.Positions.Count / 3);
            part.Positions.Add(key.Item1); part.Positions.Add(key.Item2); part.Positions.Add(key.Item3);
            part.Lookup[key] = index;
            return index;
        }
        var ia = Vertex(a); var ib = Vertex(b); var ic = Vertex(c);
        if (ia == ib || ib == ic || ia == ic) return;
        part.Indices.Add(ia); part.Indices.Add(ib); part.Indices.Add(ic);
        TriangleCount++;
    }

    public byte[] ToGlb(string generator = "ArchAI plugin")
    {
        var binary = new MemoryStream();
        var writer = new BinaryWriter(binary);
        var bufferViews = new JArray();
        var accessors = new JArray();
        var meshes = new JArray();
        var gltfNodes = new JArray();
        var materials = new JArray();
        var materialIndex = new Dictionary<string, int>();
        foreach (var node in nodes)
        {
            var primitives = new JArray();
            foreach (var (material, part) in node.Parts.Values)
            {
                if (part.Indices.Count == 0) continue;
                var positionOffset = (int)binary.Length;
                foreach (var value in part.Positions) writer.Write(value);
                var min = new[] { float.MaxValue, float.MaxValue, float.MaxValue };
                var max = new[] { float.MinValue, float.MinValue, float.MinValue };
                for (int i = 0; i < part.Positions.Count; i++) { min[i % 3] = Math.Min(min[i % 3], part.Positions[i]); max[i % 3] = Math.Max(max[i % 3], part.Positions[i]); }
                bufferViews.Add(new JObject { ["buffer"] = 0, ["byteOffset"] = positionOffset, ["byteLength"] = part.Positions.Count * 4, ["target"] = 34962 });
                accessors.Add(new JObject { ["bufferView"] = bufferViews.Count - 1, ["componentType"] = 5126, ["count"] = part.Positions.Count / 3, ["type"] = "VEC3", ["min"] = new JArray(min), ["max"] = new JArray(max) });
                var positionAccessor = accessors.Count - 1;
                var indexOffset = (int)binary.Length;
                foreach (var index in part.Indices) writer.Write(index);
                bufferViews.Add(new JObject { ["buffer"] = 0, ["byteOffset"] = indexOffset, ["byteLength"] = part.Indices.Count * 4, ["target"] = 34963 });
                accessors.Add(new JObject { ["bufferView"] = bufferViews.Count - 1, ["componentType"] = 5125, ["count"] = part.Indices.Count, ["type"] = "SCALAR" });
                if (!materialIndex.TryGetValue(material.Name, out var mi))
                {
                    var pbr = new JObject
                    {
                        ["baseColorFactor"] = new JArray(Linear(material.R), Linear(material.G), Linear(material.B), material.Opacity),
                        ["metallicFactor"] = material.Metalness,
                        ["roughnessFactor"] = material.Roughness,
                    };
                    var gltfMaterial = new JObject { ["name"] = material.Name, ["pbrMetallicRoughness"] = pbr, ["doubleSided"] = true };
                    if (material.Opacity < 0.999) gltfMaterial["alphaMode"] = "BLEND";
                    materials.Add(gltfMaterial);
                    materialIndex[material.Name] = mi = materials.Count - 1;
                }
                primitives.Add(new JObject { ["attributes"] = new JObject { ["POSITION"] = positionAccessor }, ["indices"] = accessors.Count - 1, ["material"] = mi, ["mode"] = 4 });
            }
            if (primitives.Count == 0) continue;
            meshes.Add(new JObject { ["name"] = node.Name, ["primitives"] = primitives });
            var gltfNode = new JObject { ["mesh"] = meshes.Count - 1 };
            if (node.Name.Length > 0) gltfNode["name"] = node.Name;
            if (node.Extras != null) gltfNode["extras"] = node.Extras;
            gltfNodes.Add(gltfNode);
        }
        writer.Flush();
        var json = new JObject
        {
            ["asset"] = new JObject { ["version"] = "2.0", ["generator"] = generator },
            ["scene"] = 0,
            ["scenes"] = new JArray(new JObject { ["nodes"] = new JArray(Enumerable.Range(0, gltfNodes.Count)) }),
            ["nodes"] = gltfNodes,
            ["meshes"] = meshes,
            ["materials"] = materials,
            ["accessors"] = accessors,
            ["bufferViews"] = bufferViews,
            ["buffers"] = new JArray(new JObject { ["byteLength"] = binary.Length }),
        };
        var jsonBytes = Pad(Encoding.UTF8.GetBytes(json.ToString(Newtonsoft.Json.Formatting.None)), 0x20);
        var binBytes = Pad(binary.ToArray(), 0);
        var output = new MemoryStream();
        var glb = new BinaryWriter(output);
        glb.Write(0x46546C67u); // "glTF"
        glb.Write(2u);
        glb.Write((uint)(12 + 8 + jsonBytes.Length + 8 + binBytes.Length));
        glb.Write((uint)jsonBytes.Length); glb.Write(0x4E4F534Au); glb.Write(jsonBytes); // "JSON"
        glb.Write((uint)binBytes.Length); glb.Write(0x004E4942u); glb.Write(binBytes); // "BIN\0"
        glb.Flush();
        return output.ToArray();
    }

    /// <summary>glTF colour factors are linear; host colours are sRGB.</summary>
    internal static double Linear(double c) => c <= 0.04045 ? c / 12.92 : Math.Pow((c + 0.055) / 1.055, 2.4);
    internal static double Srgb(double c) => c <= 0.0031308 ? c * 12.92 : 1.055 * Math.Pow(c, 1 / 2.4) - 0.055;

    private static byte[] Pad(byte[] bytes, byte fill)
    {
        var length = (bytes.Length + 3) & ~3;
        if (length == bytes.Length) return bytes;
        var padded = Enumerable.Repeat(fill, length).ToArray();
        Array.Copy(bytes, padded, bytes.Length);
        return padded;
    }
}
