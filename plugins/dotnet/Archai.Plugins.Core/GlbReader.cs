using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json.Linq;

namespace Archai.Plugins;

/// <summary>Triangles of one material of an imported object, in world glTF metres (x, up, plan y).</summary>
public sealed class ImportPart
{
    public GlbMaterial Material = GlbMaterial.Default;
    public float[] Positions = Array.Empty<float>();
    public int[] Indices = Array.Empty<int>();
}

/// <summary>One object to create in the host app: an ArchAI element (or a glTF node with a mesh).</summary>
public sealed class ImportObject
{
    public string Name = "";
    /// <summary>The ArchAI level (storey) name, or "" when none.</summary>
    public string Level = "";
    /// <summary>The ArchAI type (wall, door, floor...) or kind, or "".</summary>
    public string Type = "";
    public readonly List<ImportPart> Parts = new List<ImportPart>();
    public int TriangleCount => Parts.Sum(p => p.Indices.Length / 3);
}

/// <summary>
/// Reads a binary glTF into objects with their triangles in world coordinates. Nodes carrying
/// <c>extras.archai</c> (ArchAI's .AIR 3D snapshot) become one object each with everything below
/// them; otherwise every node with a mesh is an object. Lines, points and textures are skipped.
/// </summary>
public static class GlbReader
{
    public static List<ImportObject> Read(byte[] glb, double scale = 1)
    {
        if (glb.Length < 20 || BitConverter.ToUInt32(glb, 0) != 0x46546C67u) throw new FormatException("Not a binary glTF file.");
        JObject? json = null;
        byte[] bin = Array.Empty<byte>();
        var offset = 12;
        while (offset + 8 <= glb.Length)
        {
            var length = (int)BitConverter.ToUInt32(glb, offset);
            var type = BitConverter.ToUInt32(glb, offset + 4);
            if (type == 0x4E4F534Au) json = JObject.Parse(Encoding.UTF8.GetString(glb, offset + 8, length));
            else if (type == 0x004E4942u) { bin = new byte[length]; Array.Copy(glb, offset + 8, bin, 0, length); }
            offset += 8 + length;
        }
        if (json == null) throw new FormatException("The glTF file has no JSON chunk.");
        return new Scene(json, bin, scale).Objects();
    }

    private sealed class Scene
    {
        private readonly JObject json;
        private readonly byte[] bin;
        private readonly double scale;
        private readonly Dictionary<int, GlbMaterial> materials = new Dictionary<int, GlbMaterial>();
        private readonly List<ImportObject> objects = new List<ImportObject>();
        private readonly bool tagged;

        public Scene(JObject json, byte[] bin, double scale)
        {
            this.json = json; this.bin = bin; this.scale = scale;
            tagged = (json["nodes"] as JArray)?.Any(n => n["extras"]?["archai"] is JObject) == true;
        }

        public List<ImportObject> Objects()
        {
            var sceneIndex = (int?)json["scene"] ?? 0;
            var roots = json["scenes"]?[sceneIndex]?["nodes"] as JArray ?? new JArray(Enumerable.Range(0, (json["nodes"] as JArray)?.Count ?? 0));
            foreach (var root in roots) Visit((int)root, Matrix.Identity, null);
            return objects.Where(o => o.Parts.Count > 0).ToList();
        }

        private void Visit(int index, double[] parent, ImportObject? owner)
        {
            var node = json["nodes"]?[index] as JObject;
            if (node == null) return;
            var world = Matrix.Multiply(parent, Local(node));
            var archai = node["extras"]?["archai"] as JObject;
            if (archai != null || (!tagged && node["mesh"] != null && owner == null))
            {
                owner = new ImportObject
                {
                    Name = (string?)node["name"] ?? "",
                    Level = (string?)archai?["level"] ?? "",
                    Type = archai != null ? ((string?)archai["type"] is { Length: > 0 } t ? t : (string?)archai["kind"] ?? "") : "",
                };
                if (owner.Name.Length == 0 && node["mesh"] != null) owner.Name = (string?)json["meshes"]?[(int)node["mesh"]!]?["name"] ?? "";
                if (owner.Name.Length == 0) owner.Name = owner.Type.Length > 0 ? owner.Type : "Object";
                objects.Add(owner);
            }
            if (node["mesh"] != null && owner != null) AddMesh((int)node["mesh"]!, world, owner);
            if (node["children"] is JArray children)
            {
                // Untagged files: each child mesh node is its own object.
                foreach (var child in children) Visit((int)child, world, tagged ? owner : null);
            }
        }

        private void AddMesh(int index, double[] world, ImportObject owner)
        {
            if (!(json["meshes"]?[index]?["primitives"] is JArray primitives)) return;
            foreach (var primitive in primitives)
            {
                if (((int?)primitive["mode"] ?? 4) != 4) continue;
                var positionAccessor = (int?)primitive["attributes"]?["POSITION"];
                if (positionAccessor == null) continue;
                var local = ReadFloats(positionAccessor.Value, 3);
                var positions = new float[local.Length];
                for (int i = 0; i + 2 < local.Length; i += 3)
                {
                    var (x, y, z) = Matrix.Apply(world, local[i], local[i + 1], local[i + 2]);
                    positions[i] = (float)(x * scale); positions[i + 1] = (float)(y * scale); positions[i + 2] = (float)(z * scale);
                }
                var indices = primitive["indices"] != null ? ReadIndices((int)primitive["indices"]!) : Enumerable.Range(0, local.Length / 3).ToArray();
                // A mirrored transform flips the winding.
                if (Matrix.Determinant(world) < 0)
                    for (int i = 0; i + 2 < indices.Length; i += 3) (indices[i + 1], indices[i + 2]) = (indices[i + 2], indices[i + 1]);
                owner.Parts.Add(new ImportPart { Material = MaterialOf((int?)primitive["material"]), Positions = positions, Indices = indices });
            }
        }

        private GlbMaterial MaterialOf(int? index)
        {
            if (index == null) return GlbMaterial.Default;
            if (materials.TryGetValue(index.Value, out var cached)) return cached;
            var source = json["materials"]?[index.Value];
            var factor = source?["pbrMetallicRoughness"]?["baseColorFactor"] as JArray;
            double C(int i, double fallback) => factor != null && factor.Count > i ? (double)factor[i] : fallback;
            var material = new GlbMaterial
            {
                Name = (string?)source?["name"] is { Length: > 0 } name ? name : "Material " + index,
                R = GlbWriter.Srgb(C(0, 1)), G = GlbWriter.Srgb(C(1, 1)), B = GlbWriter.Srgb(C(2, 1)),
                Opacity = (string?)source?["alphaMode"] == "BLEND" ? C(3, 1) : 1,
                Roughness = (double?)source?["pbrMetallicRoughness"]?["roughnessFactor"] ?? 1,
                Metalness = (double?)source?["pbrMetallicRoughness"]?["metallicFactor"] ?? 1,
            };
            return materials[index.Value] = material;
        }

        private (int Offset, int Stride, int Count, int ComponentType, bool Normalized) View(int accessorIndex, int components)
        {
            var accessor = json["accessors"]![accessorIndex]!;
            if (accessor["sparse"] != null) throw new FormatException("Sparse glTF accessors are not supported.");
            var view = json["bufferViews"]![(int)accessor["bufferView"]!]!;
            if (((int?)view["buffer"] ?? 0) != 0) throw new FormatException("External glTF buffers are not supported.");
            var componentType = (int)accessor["componentType"]!;
            var size = componentType == 5126 || componentType == 5125 ? 4 : componentType == 5123 || componentType == 5122 ? 2 : 1;
            var offset = ((int?)view["byteOffset"] ?? 0) + ((int?)accessor["byteOffset"] ?? 0);
            var stride = (int?)view["byteStride"] ?? size * components;
            return (offset, stride, (int)accessor["count"]!, componentType, (bool?)accessor["normalized"] ?? false);
        }

        private double Component(int at, int componentType, bool normalized)
        {
            switch (componentType)
            {
                case 5126: return BitConverter.ToSingle(bin, at);
                case 5125: return BitConverter.ToUInt32(bin, at);
                case 5123: { double v = BitConverter.ToUInt16(bin, at); return normalized ? v / 65535 : v; }
                case 5122: { double v = BitConverter.ToInt16(bin, at); return normalized ? Math.Max(v / 32767, -1) : v; }
                case 5121: { double v = bin[at]; return normalized ? v / 255 : v; }
                case 5120: { double v = (sbyte)bin[at]; return normalized ? Math.Max(v / 127, -1) : v; }
                default: throw new FormatException("Unknown glTF component type " + componentType);
            }
        }

        private float[] ReadFloats(int accessorIndex, int components)
        {
            var (offset, stride, count, type, normalized) = View(accessorIndex, components);
            var size = type == 5126 || type == 5125 ? 4 : type == 5123 || type == 5122 ? 2 : 1;
            var result = new float[count * components];
            for (int i = 0; i < count; i++)
                for (int c = 0; c < components; c++) result[i * components + c] = (float)Component(offset + i * stride + c * size, type, normalized);
            return result;
        }

        private int[] ReadIndices(int accessorIndex)
        {
            var (offset, stride, count, type, _) = View(accessorIndex, 1);
            var result = new int[count];
            for (int i = 0; i < count; i++) result[i] = (int)Component(offset + i * stride, type, false);
            return result;
        }

        private static double[] Local(JObject node)
        {
            if (node["matrix"] is JArray m && m.Count == 16) return m.Select(v => (double)v).ToArray();
            var t = node["translation"] as JArray;
            var r = node["rotation"] as JArray;
            var s = node["scale"] as JArray;
            return Matrix.Compose(
                t != null ? ((double)t[0], (double)t[1], (double)t[2]) : (0, 0, 0),
                r != null ? ((double)r[0], (double)r[1], (double)r[2], (double)r[3]) : (0, 0, 0, 1),
                s != null ? ((double)s[0], (double)s[1], (double)s[2]) : (1, 1, 1));
        }
    }
}

/// <summary>Column-major 4x4 matrices, as glTF stores them.</summary>
internal static class Matrix
{
    public static readonly double[] Identity = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };

    public static double[] Multiply(double[] a, double[] b)
    {
        var r = new double[16];
        for (int col = 0; col < 4; col++)
            for (int row = 0; row < 4; row++)
            {
                double sum = 0;
                for (int k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
                r[col * 4 + row] = sum;
            }
        return r;
    }

    public static (double, double, double) Apply(double[] m, double x, double y, double z) =>
        (m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);

    public static double Determinant(double[] m) =>
        m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

    public static double[] Compose((double X, double Y, double Z) t, (double X, double Y, double Z, double W) q, (double X, double Y, double Z) s)
    {
        double x2 = q.X + q.X, y2 = q.Y + q.Y, z2 = q.Z + q.Z;
        double xx = q.X * x2, xy = q.X * y2, xz = q.X * z2, yy = q.Y * y2, yz = q.Y * z2, zz = q.Z * z2, wx = q.W * x2, wy = q.W * y2, wz = q.W * z2;
        return new[]
        {
            (1 - (yy + zz)) * s.X, (xy + wz) * s.X, (xz - wy) * s.X, 0,
            (xy - wz) * s.Y, (1 - (xx + zz)) * s.Y, (yz + wx) * s.Y, 0,
            (xz + wy) * s.Z, (yz - wx) * s.Z, (1 - (xx + yy)) * s.Z, 0,
            t.X, t.Y, t.Z, 1,
        };
    }
}
