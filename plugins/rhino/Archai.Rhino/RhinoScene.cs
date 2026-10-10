using System;
using System.Collections.Generic;
using System.Linq;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;
using Archai.Plugins;

namespace Archai.Rhino;

/// <summary>Reads a Rhino document as ArchAI scene objects and adds imported ones back.</summary>
internal static class RhinoScene
{
    public static double Millimetres(RhinoDoc doc) => RhinoMath.UnitScale(doc.ModelUnitSystem, UnitSystem.Millimeters);

    /// <summary>Objects the Live Bridge brought in from ArchAI (never sent back).</summary>
    public static bool IsLive(ObjectAttributes attributes) => attributes.GetUserString("archai.live") == "1";

    /// <summary>Removes what the Live Bridge brought in.</summary>
    public static void ClearLive(RhinoDoc doc)
    {
        var settings = new ObjectEnumeratorSettings { HiddenObjects = true, LockedObjects = true, IncludeLights = false };
        foreach (var obj in doc.Objects.GetObjectList(settings))
            if (IsLive(obj.Attributes)) doc.Objects.Delete(obj, true, true);
    }

    public static List<SceneObject> Collect(RhinoDoc doc, bool skipLive = false, ProgressReport? progress = null)
    {
        var mm = Millimetres(doc);
        var materials = new Dictionary<string, GlbMaterial>();
        var objects = new List<SceneObject>();
        var settings = new ObjectEnumeratorSettings
        {
            VisibleFilter = true,
            HiddenObjects = false,
            LockedObjects = true,
            ObjectTypeFilter = ObjectType.Brep | ObjectType.Extrusion | ObjectType.Surface | ObjectType.Mesh | ObjectType.SubD | ObjectType.InstanceReference,
        };
        var all = doc.Objects.GetObjectList(settings).ToList();
        for (var index = 0; index < all.Count; index++)
        {
            var obj = all[index];
            progress.Step(index, all.Count, $"Reading object {index + 1} of {all.Count}");
            var layer = doc.Layers[obj.Attributes.LayerIndex];
            if (layer != null && !layer.IsVisible) continue;
            if (skipLive && IsLive(obj.Attributes)) continue;
            var item = new SceneObject
            {
                // The full id (older plugins sent its first 12 digits: ArchAI moves the link).
                Id = obj.Id.ToString("N"),
                Was = obj.Id.ToString("N").Substring(0, 12),
                Archai = obj.Attributes.GetUserString("archai.copy") is { Length: > 0 } copy ? copy : null,
                Name = !string.IsNullOrWhiteSpace(obj.Attributes.Name) ? obj.Attributes.Name : obj is InstanceObject instance ? instance.InstanceDefinition?.Name ?? "Block" : obj.ShortDescription(false),
                Category = layer?.FullPath ?? "",
            };
            try { Add(doc, obj, obj.Geometry, obj.Attributes, Transform.Identity, item, mm, materials, 0); } catch { continue; }
            if (item.Triangles.Count > 0) objects.Add(item);
        }
        return objects;
    }

    private static void Add(RhinoDoc doc, RhinoObject owner, GeometryBase geometry, ObjectAttributes attributes, Transform transform, SceneObject item, double mm, Dictionary<string, GlbMaterial> materials, int depth)
    {
        if (depth > 16) return;
        if (owner is InstanceObject instance && geometry is InstanceReferenceGeometry)
        {
            instance.Explode(true, out var pieces, out var pieceAttributes, out var pieceTransforms);
            for (int i = 0; i < pieces.Length; i++)
            {
                if (pieces[i] is InstanceObject) continue;
                try { Add(doc, pieces[i], pieces[i].Geometry, pieceAttributes[i], pieceTransforms[i], item, mm, materials, depth + 1); } catch { }
            }
            return;
        }
        var meshes = Meshes(geometry);
        if (meshes.Count == 0) return;
        var material = MaterialOf(doc, owner, attributes, materials);
        foreach (var source in meshes)
        {
            var mesh = source.DuplicateMesh();
            if (!transform.IsIdentity) mesh.Transform(transform);
            mesh.Faces.ConvertQuadsToTriangles();
            ArchaiPoint P(int index) { var v = mesh.Vertices[index]; return ArchaiPoint.FromZUp(v.X, v.Y, v.Z, mm); }
            foreach (var face in mesh.Faces) item.Add(material, P(face.A), P(face.B), P(face.C));
        }
    }

    private static List<Mesh> Meshes(GeometryBase geometry)
    {
        var parameters = MeshingParameters.QualityRenderMesh;
        switch (geometry)
        {
            case Mesh mesh: return new List<Mesh> { mesh };
            case Brep brep: return (Mesh.CreateFromBrep(brep, parameters) ?? Array.Empty<Mesh>()).ToList();
            case Extrusion extrusion: return (Mesh.CreateFromBrep(extrusion.ToBrep(), parameters) ?? Array.Empty<Mesh>()).ToList();
            case Surface surface: return (Mesh.CreateFromBrep(surface.ToBrep(), parameters) ?? Array.Empty<Mesh>()).ToList();
            case SubD subd: { var mesh = Mesh.CreateFromSubD(subd, 3); return mesh != null ? new List<Mesh> { mesh } : new List<Mesh>(); }
            default: return new List<Mesh>();
        }
    }

    private static GlbMaterial MaterialOf(RhinoDoc doc, RhinoObject owner, ObjectAttributes attributes, Dictionary<string, GlbMaterial> materials)
    {
        var layer = doc.Layers[attributes.LayerIndex];
        var index = attributes.MaterialSource == ObjectMaterialSource.MaterialFromLayer ? layer?.RenderMaterialIndex ?? -1 : attributes.MaterialIndex;
        if (index >= 0 && index < doc.Materials.Count)
        {
            var source = doc.Materials[index];
            var key = "m" + index;
            if (materials.TryGetValue(key, out var found)) return found;
            var colour = source.DiffuseColor;
            var name = string.IsNullOrWhiteSpace(source.Name) ? "Material " + index : source.Name;
            return materials[key] = new GlbMaterial
            {
                Name = name,
                R = colour.R / 255.0, G = colour.G / 255.0, B = colour.B / 255.0,
                Opacity = 1 - Math.Max(0, Math.Min(1, source.Transparency)),
                Roughness = 1 - Math.Max(0, Math.Min(1, source.Shine / Material.MaxShine)) * 0.85,
                Metalness = name.IndexOf("metal", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("steel", StringComparison.OrdinalIgnoreCase) >= 0 ? 0.8 : 0,
            };
        }
        // No render material: the display colour, as Rhino shades it.
        var draw = attributes.DrawColor(doc);
        var drawKey = $"{layer?.Name ?? "Default"} #{draw.R:x2}{draw.G:x2}{draw.B:x2}";
        if (materials.TryGetValue(drawKey, out var cached)) return cached;
        return materials[drawKey] = new GlbMaterial { Name = drawKey, R = draw.R / 255.0, G = draw.G / 255.0, B = draw.B / 255.0, Roughness = 0.8 };
    }

    /// <summary>Named perspective views as VR stops.</summary>
    public static List<VrStop> Cameras(RhinoDoc doc)
    {
        var mm = Millimetres(doc);
        var stops = new List<VrStop>();
        for (int i = 0; i < doc.NamedViews.Count; i++)
        {
            var view = doc.NamedViews[i];
            var viewport = view.Viewport;
            if (viewport == null || !viewport.IsPerspectiveProjection) continue;
            var eye = viewport.CameraLocation;
            var direction = viewport.CameraDirection;
            stops.Add(VrStop.FromCamera(view.Name, ArchaiPoint.FromZUp(eye.X, eye.Y, eye.Z, mm), ArchaiPoint.FromZUp(direction.X, direction.Y, direction.Z, 1)));
        }
        return stops;
    }

    /// <summary>Adds imported objects as meshes under an "ArchAI &lt;name&gt;" layer with a sublayer per level; returns the count.</summary>
    public static int Import(RhinoDoc doc, AirFile.Contents contents, string? rootLayer = null, bool live = false, ProgressReport? progress = null)
    {
        var total = contents.Objects.Count;
        var done = 0;
        var mm = Millimetres(doc);
        var root = LayerIndex(doc, rootLayer ?? "ArchAI " + contents.Name, Guid.Empty);
        var materialIndex = new Dictionary<string, int>();
        var count = 0;
        foreach (var level in AirFile.ByLevel(contents.Objects))
        {
            var layer = level.Key.Length > 0 ? LayerIndex(doc, level.Key, doc.Layers[root].Id) : root;
            foreach (var item in level)
            {
                progress.Step(done, total, $"Adding element {done + 1} of {total}");
                done++;
                var ids = new List<Guid>();
                foreach (var part in item.Parts)
                {
                    var mesh = new Mesh();
                    for (int i = 0; i + 2 < part.Positions.Length; i += 3)
                    {
                        var (x, y, z) = HostAxes.ToZUp(part.Positions[i], part.Positions[i + 1], part.Positions[i + 2], mm);
                        mesh.Vertices.Add(x, y, z);
                    }
                    for (int i = 0; i + 2 < part.Indices.Length; i += 3) mesh.Faces.AddFace(part.Indices[i], part.Indices[i + 1], part.Indices[i + 2]);
                    if (mesh.Faces.Count == 0) continue;
                    mesh.Normals.ComputeNormals();
                    mesh.Compact();
                    var m = part.Material;
                    var colour = System.Drawing.Color.FromArgb((int)Math.Round(m.R * 255), (int)Math.Round(m.G * 255), (int)Math.Round(m.B * 255));
                    if (!materialIndex.TryGetValue(m.Name, out var mi))
                    {
                        var material = new Material { Name = m.Name, DiffuseColor = colour, Transparency = 1 - m.Opacity };
                        materialIndex[m.Name] = mi = doc.Materials.Add(material);
                    }
                    var attributes = new ObjectAttributes
                    {
                        Name = item.Name,
                        LayerIndex = layer,
                        ColorSource = ObjectColorSource.ColorFromObject,
                        ObjectColor = colour,
                        MaterialSource = ObjectMaterialSource.MaterialFromObject,
                        MaterialIndex = mi,
                    };
                    if (item.Type.Length > 0) attributes.SetUserString("archai.type", item.Type);
                    if (live) attributes.SetUserString("archai.live", "1");
                    var id = doc.Objects.AddMesh(mesh, attributes);
                    if (id != Guid.Empty) ids.Add(id);
                }
                if (ids.Count > 1) doc.Groups.Add(item.Name, ids);
                if (ids.Count > 0) count++;
            }
        }
        doc.Views.Redraw();
        return count;
    }

    // ---- Live Bridge ----------------------------------------------------------------------------

    public const string CopiesLayer = "ArchAI Copies";

    /// <summary>Ids of every object that could be sent (hidden ones too), not what ArchAI sent.</summary>
    public static List<string> AllIds(RhinoDoc doc)
    {
        var settings = new ObjectEnumeratorSettings { HiddenObjects = true, LockedObjects = true, IncludeLights = false, ObjectTypeFilter = ObjectType.Brep | ObjectType.Extrusion | ObjectType.Surface | ObjectType.Mesh | ObjectType.SubD | ObjectType.InstanceReference };
        return doc.Objects.GetObjectList(settings).Where(o => !IsLive(o.Attributes)).Select(o => o.Id.ToString("N")).ToList();
    }

    /// <summary>
    /// Applies a Live Bridge pull element by element: ArchAI's elements as meshes on the ArchAI Live
    /// layer (tagged "archai.id", replaced or removed one by one), editable copies as one mesh each
    /// on the "ArchAI Copies" layer (sent back as copies; replaced in place, keeping their id), and
    /// ArchAI's moves and names applied to the model's own objects.
    /// </summary>
    public static void Apply(RhinoDoc doc, BridgeDelta delta, string liveLayer)
    {
        var mm = Millimetres(doc);
        if (delta.Fresh) ClearLive(doc);
        var settings = new ObjectEnumeratorSettings { HiddenObjects = true, LockedObjects = true, IncludeLights = false };
        var live = new Dictionary<string, List<Guid>>();
        var copies = new Dictionary<string, Guid>();
        foreach (var obj in doc.Objects.GetObjectList(settings))
        {
            var archai = obj.Attributes.GetUserString("archai.id");
            if (obj.Attributes.GetUserString("archai.copy") is { Length: > 0 } copyOf) copies[copyOf] = obj.Id;
            else if (!string.IsNullOrEmpty(archai) && IsLive(obj.Attributes))
            {
                if (!live.TryGetValue(archai, out var list)) live[archai] = list = new List<Guid>();
                list.Add(obj.Id);
            }
        }
        void Remove(string archaiId)
        {
            if (!live.TryGetValue(archaiId, out var ids)) return;
            foreach (var id in ids) doc.Objects.Delete(id, true);
            live.Remove(archaiId);
        }
        foreach (var removed in delta.Removed) Remove(removed);
        foreach (var update in delta.Updates)
        {
            if (!Guid.TryParse(update.Ref, out var id) || doc.Objects.FindId(id) is not RhinoObject obj) continue;
            if (update.Move != null)
            {
                var (x, y, z) = HostAxes.MoveToZUp(update.Move, mm);
                doc.Objects.Transform(obj, Transform.Translation(x, y, z), true);
            }
            if (!string.IsNullOrEmpty(update.Name) && doc.Objects.FindId(id) is RhinoObject moved)
            {
                var attributes = moved.Attributes.Duplicate();
                attributes.Name = update.Name;
                doc.Objects.ModifyAttributes(moved, attributes, true);
            }
        }
        foreach (var node in delta.Nodes)
        {
            var target = (string?)node.Archai["ref"];
            Guid copyId = Guid.Empty;
            if (target != null && Guid.TryParse(target, out var own) && doc.Objects.FindId(own) != null) copyId = own;
            else if (copies.TryGetValue(node.ArchaiId, out var existing)) copyId = existing;
            if (copyId != Guid.Empty)
            {
                // The model's copy of an ArchAI element: its shape follows ArchAI's.
                if (Joined(node, mm) is Mesh replaced) doc.Objects.Replace(copyId, replaced);
                continue;
            }
            Remove(node.ArchaiId);
            var editable = node.Archai["editable"] is Newtonsoft.Json.Linq.JArray;
            if (editable)
            {
                if (Joined(node, mm) is not Mesh mesh) continue;
                var first = node.Parts.FirstOrDefault()?.Material ?? GlbMaterial.Default;
                var attributes = new ObjectAttributes
                {
                    Name = node.Name,
                    LayerIndex = LayerIndex(doc, CopiesLayer, Guid.Empty),
                    ColorSource = ObjectColorSource.ColorFromObject,
                    ObjectColor = System.Drawing.Color.FromArgb((int)Math.Round(first.R * 255), (int)Math.Round(first.G * 255), (int)Math.Round(first.B * 255)),
                };
                attributes.SetUserString("archai.id", node.ArchaiId);
                attributes.SetUserString("archai.copy", node.ArchaiId);
                doc.Objects.AddMesh(mesh, attributes);
                continue;
            }
            var contents = new AirFile.Contents { Name = delta.Name };
            contents.Objects.Add(node);
            var before = new HashSet<Guid>(doc.Objects.GetObjectList(settings).Select(o => o.Id));
            Import(doc, contents, liveLayer, live: true);
            var colour = (string?)node.Archai["color"];
            foreach (var obj in doc.Objects.GetObjectList(settings).Where(o => !before.Contains(o.Id)).ToList())
            {
                var attributes = obj.Attributes.Duplicate();
                attributes.SetUserString("archai.id", node.ArchaiId);
                // Its source app's colour, so each model reads apart.
                if (colour is { Length: 7 }) attributes.ObjectColor = System.Drawing.ColorTranslator.FromHtml(colour);
                doc.Objects.ModifyAttributes(obj, attributes, true);
            }
        }
        doc.Views.Redraw();
    }

    /// <summary>All of an ArchAI node's triangles as one Rhino mesh (an editable copy is one object).</summary>
    private static Mesh? Joined(ImportObject item, double mm)
    {
        var mesh = new Mesh();
        foreach (var part in item.Parts)
        {
            var offset = mesh.Vertices.Count;
            for (int i = 0; i + 2 < part.Positions.Length; i += 3)
            {
                var (x, y, z) = HostAxes.ToZUp(part.Positions[i], part.Positions[i + 1], part.Positions[i + 2], mm);
                mesh.Vertices.Add(x, y, z);
            }
            for (int i = 0; i + 2 < part.Indices.Length; i += 3) mesh.Faces.AddFace(offset + part.Indices[i], offset + part.Indices[i + 1], offset + part.Indices[i + 2]);
        }
        if (mesh.Faces.Count == 0) return null;
        mesh.Normals.ComputeNormals();
        mesh.Compact();
        return mesh;
    }

    private static int LayerIndex(RhinoDoc doc, string name, Guid parent)
    {
        name = new string(name.Select(c => char.IsControl(c) || "[]:;\"".IndexOf(c) >= 0 ? '_' : c).ToArray()).Trim();
        if (name.Length == 0) name = "ArchAI";
        var path = parent == Guid.Empty ? name : doc.Layers.FindId(parent).FullPath + ModelComponent.NamePathSeparator + name;
        var existing = doc.Layers.FindByFullPath(path, -1);
        if (existing >= 0) return existing;
        return doc.Layers.Add(new Layer { Name = name, ParentLayerId = parent });
    }

}
