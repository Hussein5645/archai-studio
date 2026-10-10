using System;
using System.IO;
using System.Reflection;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Archai.Air;
using Newtonsoft.Json;
using Archai.Plugins.Windows;
using Forms = System.Windows.Forms;

namespace Archai.Revit;

public sealed class App : IExternalApplication
{
    public Result OnStartup(UIControlledApplication app)
    {
        // An "ArchAI" tab of its own on the ribbon (another ArchAI add-in may have made it already):
        // exchange with ArchAI, VR, and the web app, each with the shared ArchAI icon set (plugins/icons).
        const string tab = "ArchAI";
        try { app.CreateRibbonTab(tab); } catch (Autodesk.Revit.Exceptions.ArgumentException) { }
        var assembly = Assembly.GetExecutingAssembly().Location;
        PushButtonData Button(string id, string text, Type command, string icon, string tip, string? more = null) => new PushButtonData(id, text, assembly, command.FullName)
        {
            ToolTip = tip,
            LongDescription = more ?? "",
            LargeImage = ArchaiIcons.Load(icon, 32),
            Image = ArchaiIcons.Load(icon, 16),
            ToolTipImage = ArchaiIcons.Load(icon, 128),
        };
        var exchange = app.CreateRibbonPanel(tab, "ArchAI");
        exchange.AddItem(Button("ArchaiExport", "Send to\nArchAI", typeof(ExportCommand), "export",
            "Save this model as an .AIR file to open in ArchAI.",
            "Walls with their layers and materials, doors, windows, floors, ceilings, columns, railings, levels and rooms become native ArchAI elements; everything else (roofs, stairs, curtain walls, furniture...) comes as 3D meshes with its materials. Open the file in ArchAI with Open file."));
        exchange.AddItem(Button("ArchaiImportAir", "Open\n.AIR", typeof(ImportCommand), "import",
            "Bring an ArchAI .AIR document into this project as native Revit elements.",
            "Levels, walls, floors, ceilings, doors, windows, columns, stairs, railings and rooms become native Revit elements; a report lists what was approximated or skipped."));
        var live = app.CreateRibbonPanel(tab, "Live Bridge");
        live.AddItem(Button("ArchaiLive", "Live\nBridge", typeof(LiveCommand), "sync",
            "Sync this model with the project open in the ArchAI desktop app as you work. Click again to stop.",
            "Your changes go to ArchAI a moment after you make them (as Send to ArchAI writes them), and ArchAI's model comes back as ArchAI Live generic models, replaced on every update and never sent back."));
        live.AddItem(Button("ArchaiPause", "Pause /\nresume", typeof(PauseCommand), "sync",
            "Pause the Live Bridge to work in Revit undisturbed; click again to resume.",
            "While paused nothing is sent or received. Resuming sends everything you changed meanwhile."));
        live.AddItem(Button("ArchaiLinkProject", "Link to\nproject", typeof(LinkProjectCommand), "sync",
            "Choose the ArchAI project this model syncs with: ArchAI shows its projects.",
            "The link is remembered on this computer; until you change it, the Live Bridge only syncs this model with that project."));
        var vr = app.CreateRibbonPanel(tab, "VR");
        vr.AddItem(Button("ArchaiOpenVr", "Open\nin VR", typeof(VrCommand), "vr",
            "Walk through this model in a VR headset (Meta Quest Browser) or any browser.",
            "Uploads the model with a stop at every camera view and placed room, opens it in the ArchAI VR viewer and gives a short link to open on the headset. From an orthographic 3D view, only what that view shows is sent. Publishing the same model again keeps its link."));
        var web = app.CreateRibbonPanel(tab, "Web");
        web.AddItem(Button("ArchaiOpenWeb", "ArchAI\nWeb", typeof(OpenArchaiCommand), "web", "Open the ArchAI web app in your browser."));
        // Unattended export (tests, scripts): ARCHAI_EXPORT_AUTORUN="<model.rvt>|<output.AIR>" opens the
        // model once Revit is idle, exports it, writes <output>.done (or .failed) and exits Revit.
        var autorun = Environment.GetEnvironmentVariable("ARCHAI_EXPORT_AUTORUN");
        if (!string.IsNullOrWhiteSpace(autorun)) app.Idling += (sender, _) => RunAutorun(sender as UIApplication, autorun!);
        return Result.Succeeded;
    }
    public Result OnShutdown(UIControlledApplication app) => Result.Succeeded;

    private static bool autorunDone;
    private static void RunAutorun(UIApplication? ui, string spec)
    {
        if (autorunDone || ui == null) return;
        autorunDone = true;
        var parts = spec.Split('|');
        var output = parts.Length > 1 ? parts[1] : Path.ChangeExtension(parts[0], ".AIR");
        try
        {
            var doc = ui.Application.OpenDocumentFile(parts[0]);
            var summary = ExportCommand.Write(doc, output);
            doc.Close(false);
            File.WriteAllText(output + ".done", summary);
        }
        catch (Exception ex) { File.WriteAllText(output + ".failed", ex.ToString()); }
        ui.PostCommand(RevitCommandId.LookupPostableCommandId(PostableCommand.ExitRevit));
    }
}

[Transaction(TransactionMode.ReadOnly)]
public sealed class OpenArchaiCommand : IExternalCommand
{
    public const string Url = "https://archai-studio-six.vercel.app/";
    public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
    {
        try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Url) { UseShellExecute = true }); return Result.Succeeded; }
        catch (Exception ex) { message = ex.Message; return Result.Failed; }
    }
}

[Transaction(TransactionMode.ReadOnly)]
public sealed class ExportCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
    {
        var doc = data.Application.ActiveUIDocument?.Document;
        if (doc == null || doc.IsFamilyDocument)
        {
            ArchaiDialog.Show("Send to ArchAI", "Open a Revit project to send it to ArchAI.");
            return Result.Cancelled;
        }
        var folder = string.IsNullOrEmpty(doc.PathName) ? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments) : Path.GetDirectoryName(doc.PathName)!;
        using var picker = new Forms.SaveFileDialog
        {
            Filter = "ArchAI document (*.AIR)|*.AIR",
            Title = "Send to ArchAI",
            InitialDirectory = folder,
            FileName = Path.GetFileNameWithoutExtension(string.IsNullOrEmpty(doc.PathName) ? doc.Title : doc.PathName) + ".AIR",
        };
        if (picker.ShowDialog() != Forms.DialogResult.OK) return Result.Cancelled;
        try
        {
            string summary;
            using (var progress = new ArchaiProgress("Send to ArchAI"))
            {
                progress.Report("Reading the model...", 0);
                summary = Write(doc, picker.FileName, progress.Report);
            }
            ArchaiDialog.Show("Sent to ArchAI", summary + "\n\nOpen " + Path.GetFileName(picker.FileName) + " in ArchAI (Open file) to work on it.");
            return Result.Succeeded;
        }
        catch (Exception ex) { message = ex.Message; return Result.Failed; }
    }

    /// <summary>Exports a document to an ArchAI .AIR file; returns a one-paragraph summary.</summary>
    public static string Write(Document doc, string path, Archai.Plugins.ProgressReport? progress = null)
    {
        var exporter = new ArchaiExporter(doc) { Progress = progress };
        var model = exporter.Export();
        File.WriteAllText(path, model.ToString(Formatting.None));
        var counts = string.Join(", ", exporter.Counts.OrderByDescending(c => c.Value).Select(c => $"{c.Value} {c.Key}{(c.Value == 1 ? "" : "s")}"));
        var warnings = exporter.Warnings.Count > 0 ? "\n" + exporter.Warnings.Count + " element(s) could not be read; see " + Path.GetFileName(path) + ".log" : "";
        if (exporter.Warnings.Count > 0) File.WriteAllLines(path + ".log", exporter.Warnings);
        return $"Exported {counts}.{warnings}";
    }
}

[Transaction(TransactionMode.Manual)]
public sealed class ImportCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
    {
        var doc = data.Application.ActiveUIDocument?.Document;
        if (doc == null || doc.IsFamilyDocument)
        {
            ArchaiDialog.Show("Open .AIR", "Open a Revit project before importing an AIR file.");
            return Result.Cancelled;
        }
        using var picker = new Forms.OpenFileDialog { Filter = "ArchAI document (*.AIR)|*.AIR", Title = "Import ArchAI model", CheckFileExists = true };
        if (picker.ShowDialog() != Forms.DialogResult.OK) return Result.Cancelled;
        try
        {
            var source = AirDocument.Parse(File.ReadAllText(picker.FileName));
            var confirm = new TaskDialog("Import ArchAI model")
            {
                MainInstruction = $"Import {source.Name} ({source.Elements.Count} source elements)",
                MainContent = "Creates a new copy at the Revit internal origin. Stored millimetres are converted to feet and the AIR Y axis is reversed. Existing model elements are not replaced.\n\nSupported architectural objects become native Revit elements. Catalog meshes, text, images and unsupported shapes are listed in the report. Generated families require Revit metric family templates.",
                CommonButtons = TaskDialogCommonButtons.Ok | TaskDialogCommonButtons.Cancel,
                DefaultButton = TaskDialogResult.Ok
            };
            if (confirm.Show() != TaskDialogResult.Ok) return Result.Cancelled;
            var importer = new NativeImporter(doc, source);
            ImportReport report;
            using (var progress = new ArchaiProgress("Open .AIR"))
            {
                progress.Report($"Building {source.Elements.Count} elements in Revit...", 0);
                importer.Progress = progress.Report;
                report = importer.Run();
            }
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ArchAI", "Revit", "Reports");
            string reportInfo;
            try
            {
                Directory.CreateDirectory(directory);
                var path = Path.Combine(directory, "import-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".json");
                File.WriteAllText(path, JsonConvert.SerializeObject(report, Formatting.Indented));
                reportInfo = "Report: " + path;
            }
            catch (Exception ex) { reportInfo = "Import completed, but report could not be saved: " + ex.Message; }
            var created = report.Items.Count(i => i.Status == "created");
            var failed = report.Items.Count(i => i.Status == "failed");
            ArchaiDialog.Show("ArchAI import complete", $"{created} source objects imported. {failed} failed.\n{report.Items.Count(i => i.Status == "skipped")} skipped.\n\n{reportInfo}\n\nUse Undo once to remove this import. Review the report's warnings before relying on geometric fidelity.");
            return Result.Succeeded;
        }
        catch (Exception ex) { message = ex.Message; return Result.Failed; }
    }
}

public sealed class ImportReport
{
    public string DocumentId { get; set; } = "";
    public string RevitVersion { get; set; } = "";
    public DateTime ImportedUtc { get; set; } = DateTime.UtcNow;
    public List<ImportItem> Items { get; } = new List<ImportItem>();
}
public sealed class ImportItem
{
    public string SourceId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Type { get; set; } = "";
    public string Status { get; set; } = "";
    public string Detail { get; set; } = "";
    public List<string> RevitUniqueIds { get; set; } = new List<string>();
    public List<string> Warnings { get; } = new List<string>();
}

// Fail the current object rather than leave an unresolved modal failure dialog.
internal sealed class ImportFailures : IFailuresPreprocessor
{
    private readonly List<string> warnings;
    public ImportFailures(List<string> warnings) { this.warnings = warnings; }
    public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
    {
        var errors = false;
        foreach (var failure in accessor.GetFailureMessages())
        {
            warnings.Add(failure.GetDescriptionText());
            if (failure.GetSeverity() == FailureSeverity.Warning) accessor.DeleteWarning(failure);
            else errors = true;
        }
        return errors ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
    }
}
