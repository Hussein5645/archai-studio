using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;
using Archai.Plugins;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;

namespace Archai.AutoCAD.BridgeTest;

/// <summary>
/// ARCHAIBRIDGEAGENT (accoreconsole, Live Bridge end-to-end test): runs the plugin's real drawing
/// functions (collect, element-by-element apply, all ids) with a LiveLink against the ArchAI
/// desktop app on ARCHAI_LIVE_PORT, doing the steps the driver writes into the control file
/// (ARCHAI_BRIDGE_CONTROL, role "C") and reporting the drawing into ARCHAI_BRIDGE_STATUS. The
/// command loops on AutoCAD's main thread and runs the link's host work there.
/// </summary>
public sealed class Agent
{
    [CommandMethod("ARCHAIBRIDGEAGENT")]
    public void Run()
    {
        var control = Environment.GetEnvironmentVariable("ARCHAI_BRIDGE_CONTROL") ?? "";
        var statusFile = Environment.GetEnvironmentVariable("ARCHAI_BRIDGE_STATUS") ?? "";
        const string role = "C";
        var doc = AcApp.DocumentManager.MdiActiveDocument;
        var db = doc.Database;
        var queue = new ConcurrentQueue<Action>();
        var statuses = new List<string>();
        var link = new LiveLink("autocad:C:/bridge-test/C.dwg", "AutoCAD", "Drawing C")
        {
            OnHost = queue.Enqueue,
            Export = () => Exchange.Write("Drawing C", "AutoCAD", "test", "C.dwg", DrawingScene.Collect(db, skipLive: true), out _),
            Apply = delta => DrawingBridge.Apply(db, delta),
            AllIds = () => DrawingBridge.AllIds(db),
            StatusChanged = s => { lock (statuses) statuses.Add(s); },
        };

        // A 1 x 1 x 3 m box at x = 10 m (millimetre drawing).
        ObjectId box;
        using (var tr = db.TransactionManager.StartTransaction())
        {
            var space = (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForWrite);
            var solid = new Solid3d();
            solid.SetDatabaseDefaults(db);
            solid.CreateBox(1000, 1000, 3000);
            solid.TransformBy(Matrix3d.Displacement(new Vector3d(10500, 500, 1500)));
            box = space.AppendEntity(solid);
            tr.AddNewlyCreatedDBObject(solid, true);
            tr.Commit();
        }

        var done = new HashSet<string>();
        var deadline = DateTime.UtcNow.AddMinutes(10);
        while (DateTime.UtcNow < deadline)
        {
            while (queue.TryDequeue(out var work)) { try { work(); } catch (System.Exception e) { lock (statuses) statuses.Add("host error: " + e.Message); } }
            string[] steps;
            try { steps = (JObject.Parse(File.ReadAllText(control))[role] as JArray)?.Select(s => (string?)s ?? "").ToArray() ?? Array.Empty<string>(); }
            catch { steps = Array.Empty<string>(); }
            foreach (var step in steps)
            {
                if (!done.Add(step)) continue;
                switch (step)
                {
                    case "start": link.Start(); break;
                    case "move":
                        using (var tr = db.TransactionManager.StartTransaction())
                        {
                            ((Entity)tr.GetObject(box, OpenMode.ForWrite)).TransformBy(Matrix3d.Displacement(new Vector3d(2000, 0, 0)));
                            tr.Commit();
                        }
                        link.ModelChanged();
                        break;
                    case "delete":
                        using (var tr = db.TransactionManager.StartTransaction())
                        {
                            tr.GetObject(box, OpenMode.ForWrite).Erase();
                            tr.Commit();
                        }
                        link.ModelChanged();
                        break;
                    case "push": link.ModelChanged(); break;
                    case "stop":
                        link.Dispose();
                        Report(db, statusFile, statuses, link);
                        return;
                }
            }
            Report(db, statusFile, statuses, link);
            Thread.Sleep(50);
        }
        link.Dispose();
    }

    private static void Report(Database db, string file, List<string> statuses, LiveLink link)
    {
        var entities = new JArray();
        using (var tr = db.TransactionManager.StartOpenCloseTransaction())
        {
            var space = (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForRead);
            foreach (ObjectId id in space)
            {
                if (!(tr.GetObject(id, OpenMode.ForRead) is Entity entity)) continue;
                var (archai, copy) = BridgeTags.Read(entity);
                double[]? center = null;
                try
                {
                    var e = entity.GeometricExtents;
                    center = new[] { (e.MinPoint.X + e.MaxPoint.X) / 2, (e.MinPoint.Y + e.MaxPoint.Y) / 2, (e.MinPoint.Z + e.MaxPoint.Z) / 2 };
                }
                catch { }
                entities.Add(new JObject { ["handle"] = "h" + entity.Handle, ["layer"] = entity.Layer, ["archai_id"] = archai, ["copy_of"] = copy, ["center"] = center == null ? null : new JArray(center.Select(v => Math.Round(v, 1))) });
            }
        }
        string[] last;
        lock (statuses) last = statuses.Skip(Math.Max(0, statuses.Count - 5)).ToArray();
        var json = new JObject { ["role"] = "C", ["entities"] = entities, ["status"] = link.LastStatus, ["statuses"] = new JArray(last) };
        try
        {
            File.WriteAllText(file + ".tmp", json.ToString(Formatting.None));
            File.Copy(file + ".tmp", file, true);
        }
        catch { }
    }
}
