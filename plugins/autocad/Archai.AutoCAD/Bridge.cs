using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.AutoCAD.Colors;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Archai.Plugins;
using Newtonsoft.Json.Linq;

namespace Archai.AutoCAD;

/// <summary>
/// Live Bridge tags on entities (XData of the "ARCHAI" application): <c>id</c>, the ArchAI element
/// a received object shows, and <c>copy</c>, the ArchAI element an editable copy was made from.
/// </summary>
internal static class BridgeTags
{
    public const string AppName = "ARCHAI";

    public static (string? Id, string? CopyOf) Read(Entity entity)
    {
        using var data = entity.GetXDataForApplication(AppName);
        if (data == null) return (null, null);
        string? id = null, copy = null;
        foreach (var value in data.AsArray())
        {
            if (value.TypeCode != (short)DxfCode.ExtendedDataAsciiString || !(value.Value is string text)) continue;
            if (text.StartsWith("id:", StringComparison.Ordinal)) id = text.Substring(3);
            else if (text.StartsWith("copy:", StringComparison.Ordinal)) copy = text.Substring(5);
        }
        return (id, copy);
    }

    public static void Write(Transaction tr, Database db, Entity entity, string id, string? copyOf)
    {
        var apps = (RegAppTable)tr.GetObject(db.RegAppTableId, OpenMode.ForRead);
        if (!apps.Has(AppName))
        {
            apps.UpgradeOpen();
            var app = new RegAppTableRecord { Name = AppName };
            apps.Add(app);
            tr.AddNewlyCreatedDBObject(app, true);
        }
        var values = new List<TypedValue> { new TypedValue((int)DxfCode.ExtendedDataRegAppName, AppName), new TypedValue((int)DxfCode.ExtendedDataAsciiString, "id:" + id) };
        if (copyOf != null) values.Add(new TypedValue((int)DxfCode.ExtendedDataAsciiString, "copy:" + copyOf));
        using var buffer = new ResultBuffer(values.ToArray());
        entity.XData = buffer;
    }
}

/// <summary>The drawing's side of a Live Bridge pull (Archai.Plugins.BridgeDelta).</summary>
internal static class DrawingBridge
{
    public const string CopiesLayer = "ArchAI Copies";

    /// <summary>Every entity of model space that could be sent (hidden or on frozen layers too), not what ArchAI sent.</summary>
    public static List<string> AllIds(Database db)
    {
        var ids = new List<string>();
        using var tr = db.TransactionManager.StartOpenCloseTransaction();
        var space = (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForRead);
        foreach (ObjectId id in space)
        {
            if (!(tr.GetObject(id, OpenMode.ForRead) is Entity entity)) continue;
            if (entity.Layer.StartsWith(Live.LayerPrefix, StringComparison.OrdinalIgnoreCase)) continue;
            ids.Add("h" + entity.Handle);
        }
        return ids;
    }

    /// <summary>
    /// Applies a pull element by element: ArchAI's elements as blocks on the ArchAI Live layers
    /// (tagged with their element, replaced or removed one by one), editable copies as blocks on the
    /// "ArchAI Copies" layer (sent back as copies; replaced in place, so they keep their handle), and
    /// ArchAI's moves of the drawing's own entities. Names have no place on AutoCAD entities.
    /// </summary>
    public static void Apply(Database db, BridgeDelta delta)
    {
        var mm = DrawingScene.Millimetres(db);
        if (delta.Fresh) DrawingScene.ClearLive(db);
        var live = new Dictionary<string, ObjectId>();
        var copies = new Dictionary<string, ObjectId>();
        using (var tr = db.TransactionManager.StartTransaction())
        {
            var space = (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForRead);
            foreach (ObjectId id in space)
            {
                if (!(tr.GetObject(id, OpenMode.ForRead) is Entity entity)) continue;
                var (archai, copyOf) = BridgeTags.Read(entity);
                if (copyOf != null) copies[copyOf] = id;
                else if (archai != null && entity.Layer.StartsWith(Live.LayerPrefix, StringComparison.OrdinalIgnoreCase)) live[archai] = id;
            }
            foreach (var removed in delta.Removed)
            {
                if (live.TryGetValue(removed, out var id)) { Erase(tr, id); live.Remove(removed); }
            }
            foreach (var update in delta.Updates)
            {
                if (update.Move == null || !TryHandle(db, update.Ref, out var id)) continue;
                if (!(tr.GetObject(id, OpenMode.ForWrite) is Entity entity)) continue;
                var (x, y, z) = HostAxes.MoveToZUp(update.Move, mm);
                entity.TransformBy(Matrix3d.Displacement(new Vector3d(x, y, z)));
            }
            // An editable copy whose geometry ArchAI changed: its block gets the new meshes, where the user put it.
            foreach (var node in delta.Nodes)
            {
                var target = (string?)node.Archai["ref"];
                ObjectId copyId = ObjectId.Null;
                if (target != null && TryHandle(db, target, out var own)) copyId = own;
                else if (copies.TryGetValue(node.ArchaiId, out var existing)) copyId = existing;
                if (copyId.IsNull || !(tr.GetObject(copyId, OpenMode.ForRead) is BlockReference reference)) continue;
                var definition = (BlockTableRecord)tr.GetObject(reference.BlockTableRecord, OpenMode.ForWrite);
                foreach (ObjectId child in definition) tr.GetObject(child, OpenMode.ForWrite).Erase();
                DrawingScene.Fill(tr, db, definition, node, mm, reference.BlockTransform.Inverse());
                reference.UpgradeOpen();
                reference.RecordGraphicsModified(true);
                node.Archai["applied"] = true;
            }
            foreach (var node in delta.Nodes)
            {
                if (node.Archai["applied"] != null) continue;
                if (live.TryGetValue(node.ArchaiId, out var id)) { Erase(tr, id); live.Remove(node.ArchaiId); }
            }
            tr.Commit();
        }
        // New and changed elements: one block each, tagged.
        foreach (var node in delta.Nodes.Where(n => n.Archai["applied"] == null))
        {
            var editable = node.Archai["editable"] is JArray;
            var contents = new AirFile.Contents { Name = delta.Name };
            contents.Objects.Add(node);
            DrawingScene.Import(db, contents, Live.LayerPrefix, null, (item, referenceId) =>
            {
                using var tr = db.TransactionManager.StartTransaction();
                var entity = (Entity)tr.GetObject(referenceId, OpenMode.ForWrite);
                BridgeTags.Write(tr, db, entity, item.ArchaiId, editable ? item.ArchaiId : null);
                if (!editable && (string?)item.Archai["color"] is { Length: 7 } colour)
                    entity.Color = Color.FromRgb(Convert.ToByte(colour.Substring(1, 2), 16), Convert.ToByte(colour.Substring(3, 2), 16), Convert.ToByte(colour.Substring(5, 2), 16));
                tr.Commit();
            }, editable ? CopiesLayer : null);
        }
    }

    private static void Erase(Transaction tr, ObjectId id)
    {
        var entity = (Entity)tr.GetObject(id, OpenMode.ForWrite);
        var definition = entity is BlockReference reference ? reference.BlockTableRecord : ObjectId.Null;
        entity.Erase();
        if (!definition.IsNull)
        {
            var record = (BlockTableRecord)tr.GetObject(definition, OpenMode.ForWrite);
            if (record.GetBlockReferenceIds(true, false).Count == 0) record.Erase();
        }
    }

    /// <summary>The entity a Live Bridge id ("h" + handle) names.</summary>
    public static bool TryHandle(Database db, string id, out ObjectId objectId)
    {
        objectId = ObjectId.Null;
        if (id.Length < 2 || id[0] != 'h') return false;
        try
        {
            objectId = db.GetObjectId(false, new Handle(Convert.ToInt64(id.Substring(1), 16)), 0);
            return !objectId.IsNull && !objectId.IsErased;
        }
        catch (Exception) { return false; }
    }
}
