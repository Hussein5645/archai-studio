using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Rhino;
using Rhino.Commands;
using Archai.Plugins;
using Newtonsoft.Json;

namespace Archai.Rhino;

/// <summary>Opens the ArchAI panel.</summary>
public sealed class ArchaiCommand : Command
{
    public override string EnglishName => "ArchAI";
    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        global::Rhino.UI.Panels.OpenPanel(typeof(ArchaiPanel).GUID);
        return Result.Success;
    }
}

/// <summary>Send to ArchAI: the visible 3D objects as an exchange .AIR file.</summary>
public sealed class ArchaiSendCommand : Command
{
    public override string EnglishName => "ArchaiSend";
    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        var path = mode == RunMode.Interactive ? Dialogs.SaveAir(doc) : Dialogs.ScriptedPath("ArchAI file to write");
        if (path == null) return Result.Cancel;
        try
        {
            int written;
            using (var progress = new RhinoProgress("Send to ArchAI"))
            {
                progress.Report("Reading the model", 0);
                var objects = RhinoScene.Collect(doc, progress: ((ProgressReport)progress.Report).Range(0, 0.85));
                var name = Path.GetFileNameWithoutExtension(doc.Name ?? "Rhino model");
                progress.Report($"Writing {objects.Count} objects to the .AIR file", 0.9);
                var exchange = Exchange.Write(name, "Rhino", RhinoApp.ExeVersion.ToString(), doc.Path ?? "", objects, out written);
                if (written > 0) File.WriteAllText(path, exchange.ToString(Formatting.None));
            }
            if (written == 0) { Dialogs.Show("Send to ArchAI", "There are no visible surfaces, polysurfaces, SubDs, meshes or blocks to send.", null, mode); return Result.Nothing; }
            Dialogs.Show("Sent to ArchAI", $"{written} object{(written == 1 ? "" : "s")} saved to {Path.GetFileName(path)}.\n\nOpen it in ArchAI (Open file) to work on it: each object comes in as a 3D element with its materials.", null, mode);
            return Result.Success;
        }
        catch (Exception ex) { Dialogs.Show("Send to ArchAI", ex.Message, null, mode); return Result.Failure; }
    }
}

/// <summary>Open .AIR: an ArchAI file's elements as meshes, a layer per level.</summary>
public sealed class ArchaiOpenAirCommand : Command
{
    public override string EnglishName => "ArchaiOpenAir";
    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        var path = mode == RunMode.Interactive ? Dialogs.OpenAir() : Dialogs.ScriptedPath("ArchAI file to read");
        if (path == null) return Result.Cancel;
        try
        {
            AirFile.Contents contents;
            int count;
            using (var progress = new RhinoProgress("Open .AIR"))
            {
                progress.Report("Reading " + Path.GetFileName(path), null);
                contents = AirFile.Read(path);
                progress.Report($"Adding {contents.Objects.Count} elements", 0.1);
                count = RhinoScene.Import(doc, contents, progress: ((ProgressReport)progress.Report).Range(0.1, 1));
            }
            doc.Views.ActiveView?.ActiveViewport.ZoomExtents();
            Dialogs.Show("Opened .AIR", $"{contents.Name}: {count} element{(count == 1 ? "" : "s")} added as meshes on the \"ArchAI {contents.Name}\" layer, a sublayer per level.\n\nUndo removes the import.", null, mode);
            return Result.Success;
        }
        catch (Exception ex) { Dialogs.Show("Open .AIR", ex.Message, null, mode); return Result.Failure; }
    }
}

/// <summary>Open in VR: the visible model as a VR tour on ArchAI's share service; named perspective views are stops.</summary>
public sealed class ArchaiVrCommand : Command
{
    public override string EnglishName => "ArchaiVR";
    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        var share = VrShare.Config("Rhino");
        if (share == null) { Dialogs.Show("Open in VR", VrShare.NoKey, null, mode); return Result.Failure; }
        try
        {
            var name = Path.GetFileNameWithoutExtension(doc.Name ?? "Rhino model");
            VrTour.Result tour;
            VrShare.Published link;
            using (var progress = new RhinoProgress("Open in VR"))
            {
                progress.Report("Reading the model", 0);
                var objects = RhinoScene.Collect(doc, progress: ((ProgressReport)progress.Report).Range(0, 0.3));
                progress.Report("Building the VR model", null);
                tour = VrTour.Build(name, "Rhino", objects, RhinoScene.Cameras(doc));
                if (tour.Model.Length == 0) { progress.Dispose(); Dialogs.Show("Open in VR", "There are no visible surfaces, polysurfaces, SubDs, meshes or blocks to show.", null, mode); return Result.Nothing; }
                progress.Report($"Uploading {Progress.Megabytes(tour.Model.Length)} to the VR viewer", 0.35);
                var key = "rhino|" + (string.IsNullOrEmpty(doc.Path) ? "unsaved:" + doc.RuntimeSerialNumber : doc.Path);
                var upload = ((ProgressReport)progress.Report).Range(0.35, 1);
                var task = Task.Run(() => VrShare.Publish(share, key, tour.Model, tour.Json, upload));
                while (!task.IsCompleted) { RhinoApp.Wait(); Thread.Sleep(15); }
                link = task.GetAwaiter().GetResult();
            }
            VrShare.OpenInBrowser(link.Url);
            try { System.Windows.Forms.Clipboard.SetText(link.Url); } catch { }
            RhinoApp.WriteLine("ArchAI VR: " + link.Url);
            Dialogs.Show("Opened in VR", VrShare.Message(name, tour, link), link.Url, mode);
            return Result.Success;
        }
        catch (Exception ex) { Dialogs.Show("Open in VR", (ex is AggregateException { InnerException: not null } a ? a.InnerException! : ex).Message, null, mode); return Result.Failure; }
    }
}

internal static class Dialogs
{
    public static string? SaveAir(RhinoDoc doc)
    {
        var dialog = new global::Rhino.UI.SaveFileDialog { Filter = "ArchAI document (*.AIR)|*.AIR", Title = "Send to ArchAI", FileName = Path.GetFileNameWithoutExtension(doc.Name ?? "Model") + ".AIR" };
        return dialog.ShowSaveDialog() ? dialog.FileName : null;
    }

    public static string? OpenAir()
    {
        var dialog = new global::Rhino.UI.OpenFileDialog { Filter = "ArchAI document (*.AIR)|*.AIR", Title = "Open .AIR in Rhino" };
        return dialog.ShowOpenDialog() ? dialog.FileName : null;
    }

    /// <summary>Scripted runs (-_ArchaiSend): the path from the command line.</summary>
    public static string? ScriptedPath(string prompt)
    {
        string path = "";
        return global::Rhino.Input.RhinoGet.GetString(prompt, false, ref path) == Result.Success && path.Length > 0 ? path.Trim('"') : null;
    }

    public static void Show(string title, string message, string? link, RunMode mode)
    {
        if (mode != RunMode.Interactive) { RhinoApp.WriteLine($"ArchAI: {title}: {message}"); return; }
        new ResultDialog(title, message, link).ShowModal(global::Rhino.UI.RhinoEtoApp.MainWindow);
    }
}
