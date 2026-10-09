using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Windows.Forms;

namespace Archai.Setup;

internal sealed class SetupWizard : Form
{
    private readonly Release release = Release.Load();
    private readonly Installer installer = Installer.ForUser();
    private readonly Panel content = new Panel();
    private readonly Label title = new Label(), subtitle = new Label(), stepText = new Label();
    private readonly Button next = new Button(), back = new Button(), cancel = new Button();
    private readonly List<CheckBox> versions = new List<CheckBox>();
    private readonly RadioButton install = new RadioButton(), remove = new RadioButton();
    private readonly bool preview;
    private readonly Color ink = Color.FromArgb(23, 35, 52), muted = Color.FromArgb(90, 104, 121), accent = Color.FromArgb(26, 110, 236);
    private int step;
    private bool busy, completed;
    private CancellationTokenSource? cancellation;
    private List<string> selected = new List<string>();
    private bool removing;
    private readonly List<string> log = new List<string>();
    public SetupWizard(bool uninstall, bool preview = false)
    {
        this.preview = preview;
        Text = "ArchAI — Revit Plugin Setup";
        ClientSize = new Size(860, 610);
        FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = UiFont(9.5f); BackColor = Color.White;
        AutoScaleMode = AutoScaleMode.None;
        var brand = new BrandPanel { Bounds = new Rectangle(0, 0, 210, 610), BackColor = ink };
        Controls.Add(brand);
        LabelAt(brand, "ARCHAI", 26, 150, 175, 44, 20, Color.White, true);
        LabelAt(brand, "REVIT TOOLS", 28, 195, 165, 28, 9, Color.FromArgb(150, 185, 220), true);
        LabelAt(brand, "AIR into\nnative Revit.", 28, 266, 165, 80, 16, Color.White, true);
        LabelAt(brand, "Native elements.\nEditable families.", 28, 355, 165, 62, 10, Color.FromArgb(174, 188, 204));
        LabelAt(brand, "2024  /  2025\n2026  /  2027", 28, 465, 165, 62, 11, Color.White);
        LabelAt(brand, "BETA  ·  " + release.Version, 28, 559, 166, 32, 8, Color.FromArgb(150, 185, 220));
        ConfigureLabel(stepText, 244, 24, 570, 25, 9, accent, true);
        ConfigureLabel(title, 244, 58, 570, 43, 23, ink, true);
        ConfigureLabel(subtitle, 246, 108, 570, 44, 10, muted);
        Controls.AddRange(new Control[] { stepText, title, subtitle });
        content.Bounds = new Rectangle(246, 164, 570, 358); Controls.Add(content);
        var rule = new Panel { Bounds = new Rectangle(210, 539, 650, 1), BackColor = Color.FromArgb(226, 232, 240) }; Controls.Add(rule);
        ButtonAt(back, "Back", 246, 556, 84, false); ButtonAt(cancel, "Cancel", 591, 556, 98, false); ButtonAt(next, "Continue", 703, 556, 113, true);
        next.Click += async (_, _) => await Next(); back.Click += (_, _) => ShowSelection();
        cancel.Click += (_, _) => { if (busy) cancellation?.Cancel(); else Close(); };
        FormClosing += (_, e) => { if (busy) { e.Cancel = true; cancellation?.Cancel(); } };
        install.Checked = !uninstall; remove.Checked = uninstall;
        ShowSelection();
    }
    private static Font UiFont(float points, bool bold = false) => new Font("Segoe UI", points * 96 / 72, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel);
    private void ConfigureLabel(Label label, int x, int y, int w, int h, float size, Color color, bool bold = false)
    { label.Bounds = new Rectangle(x, y, w, h); label.Font = UiFont(size, bold); label.ForeColor = color; }
    private Label LabelAt(Control parent, string text, int x, int y, int w, int h, float size, Color color, bool bold = false)
    { var label = new Label { Text = text }; ConfigureLabel(label, x, y, w, h, size, color, bold); parent.Controls.Add(label); return label; }
    private void ButtonAt(Button button, string text, int x, int y, int w, bool primary)
    {
        button.Text = text; button.Bounds = new Rectangle(x, y, w, 36); button.FlatStyle = FlatStyle.Flat;
        button.BackColor = primary ? accent : Color.White; button.ForeColor = primary ? Color.White : ink;
        button.FlatAppearance.BorderColor = primary ? accent : Color.FromArgb(208, 217, 228);
        Controls.Add(button);
    }
    private void ShowSelection()
    {
        step = 0; completed = false; next.Enabled = true; back.Visible = false; cancel.Text = "Cancel"; next.Text = "Continue";
        stepText.Text = "01  /  CHOOSE VERSIONS"; title.Text = "Set up your Revit plugin";
        subtitle.Text = "Choose your Revit versions. Installs for your Windows user.";
        content.Controls.Clear(); versions.Clear();
        install.Text = "Install / repair"; install.Bounds = new Rectangle(0, 0, 176, 28);
        remove.Text = "Remove plugin"; remove.Bounds = new Rectangle(200, 0, 180, 28);
        content.Controls.Add(install); content.Controls.Add(remove);
        for (int i = 0; i < release.Packages.Count; i++)
        {
            var year = release.Packages[i].Year;
            bool present = preview ? year == "2025" : Installer.RevitPresent(year);
            bool installed = !preview && installer.Installed(year);
            var row = new Panel { Bounds = new Rectangle(0, 40 + i * 49, 568, 43), BackColor = Color.FromArgb(245, 248, 252) };
            var check = new CheckBox { Text = "Revit " + year, Tag = year, Bounds = new Rectangle(15, 8, 185, 28), Checked = selected.Count > 0 ? selected.Contains(year) : remove.Checked ? installed : present, Font = UiFont(11, true), ForeColor = ink };
            row.Controls.Add(check); versions.Add(check);
            LabelAt(row, installed ? "Plugin installed" : present ? "Detected on this computer" : "Revit not detected", 275, 13, 280, 23, 9, present || installed ? accent : muted);
            content.Controls.Add(row);
        }
        LabelAt(content, "Internet is required for installation. Close Revit before continuing.\nVersions not detected can be selected for a custom Revit installation.", 0, 244, 568, 48, 9, muted);
        LabelAt(content, "BETA RELEASE", 0, 300, 568, 20, 9, Color.FromArgb(151, 102, 20), true);
        LabelAt(content, "Some AIR elements are approximated or unsupported. Review the import report.\nPlugin validation inside Revit is still pending.", 0, 323, 568, 35, 8.5f, muted);
    }
    private void ShowReview()
    {
        step = 1; back.Visible = true; next.Text = removing ? "Remove" : "Install";
        stepText.Text = "02  /  REVIEW"; title.Text = removing ? "Ready to remove" : "Ready to install";
        subtitle.Text = removing ? "Removes the selected plugin copies and keeps your Revit projects." : "Downloads and verifies the matching plugin packages.";
        content.Controls.Clear();
        LabelAt(content, "SELECTED VERSIONS", 0, 4, 570, 25, 9, accent, true);
        LabelAt(content, string.Join("   ·   ", selected.Select(y => "Revit " + y)), 0, 35, 570, 38, 15, ink, true);
        LabelAt(content, "INSTALLATION FOLDER", 0, 93, 570, 22, 9, accent, true);
        LabelAt(content, @"%APPDATA%\Autodesk\Revit\Addins\<year>", 0, 122, 568, 40, 11, ink);
        LabelAt(content, removing ? "Only ArchAI plugin files are removed. Import reports and generated project content are preserved." : "No administrator access needed. Revit metric family templates are required when importing doors, windows, columns and solids.", 0, 188, 568, 62, 10, muted);
        LabelAt(content, removing ? "You can reinstall later using this setup." : "After installation: open a project and use the\nArchAI tab (Export to ArchAI / Import .AIR)", 0, 275, 568, 67, 12, ink, true);
    }
    private async Task Next()
    {
        if (completed) { Close(); return; }
        if (step == 0)
        {
            selected = versions.Where(c => c.Checked).Select(c => (string)c.Tag).ToList(); removing = remove.Checked;
            if (selected.Count == 0) { MessageBox.Show(this, "Select at least one Revit version.", "ArchAI"); return; }
            if (removing && selected.All(y => !installer.Installed(y))) { MessageBox.Show(this, "No ArchAI plugin is installed for these versions.", "ArchAI"); return; }
            ShowReview(); return;
        }
        await Execute();
    }
    private async Task Execute()
    {
        busy = true; next.Enabled = false; back.Visible = false;
        cancellation = new CancellationTokenSource(); log.Clear();
        stepText.Text = "03  /  " + (removing ? "REMOVING" : "INSTALLING");
        title.Text = removing ? "Removing the plugin" : "Installing your plugin";
        subtitle.Text = "Keep this window open while setup completes.";
        content.Controls.Clear();
        var status = LabelAt(content, "Preparing…", 0, 15, 568, 48, 12, ink, true);
        var progress = new ProgressBar { Bounds = new Rectangle(0, 84, 568, 14), Maximum = selected.Count, Style = ProgressBarStyle.Continuous };
        content.Controls.Add(progress);
        var details = new TextBox { Bounds = new Rectangle(0, 126, 568, 202), Multiline = true, ReadOnly = true, BorderStyle = BorderStyle.None, BackColor = Color.FromArgb(245, 248, 252), ForeColor = muted, ScrollBars = ScrollBars.Vertical };
        content.Controls.Add(details);
        var reporter = new Progress<string>(text => { status.Text = text; });
        void Log(string text) { log.Add(text); details.AppendText(text + Environment.NewLine); }
        try
        {
            Installer.RequireRevitClosed();
            if (removing)
            {
                installer.Remove(selected); Log("Selected plugin copies removed.");
                try { installer.UnregisterIfEmpty(); } catch (Exception ex) { Log("Plugin removed, but maintenance registration needs review: " + ex.Message); }
            }
            else
            {
                var prepared = new Dictionary<string, Dictionary<string, byte[]>>();
                foreach (var year in selected)
                {
                    var package = release.Packages.Single(p => p.Year == year);
                    var bytes = await Installer.Download(package, text => ((IProgress<string>)reporter).Report(text), cancellation.Token);
                    prepared.Add(year, Installer.Unpack(bytes)); progress.Value++;
                    Log($"Revit {year}: downloaded and SHA-256 verified.");
                }
                cancellation.Token.ThrowIfCancellationRequested();
                Installer.RequireRevitClosed(); // Revit may have opened while downloading.
                cancel.Enabled = false; status.Text = "Writing plugin files…";
                installer.Install(prepared); Log("Plugin files and Revit add-in manifests installed.");
                try { Installer.RegisterMaintenance(release); Log("Added to Windows Installed apps for repair and removal."); }
                catch (Exception ex) { Log("Plugin installed. Maintenance shortcut could not be registered: " + ex.Message); }
            }
            completed = true; next.Text = "Finish";
            title.Text = removing ? "Plugin removed" : "You're ready to import";
            subtitle.Text = removing ? "The selected Revit versions no longer load the ArchAI plugin." : "Start Revit and open the ArchAI tab.";
            status.Text = string.Join(", ", selected.Select(y => "Revit " + y));
            stepText.Text = "04  /  COMPLETE"; cancel.Visible = false; progress.Value = progress.Maximum;
            Log(removing ? "Your Revit projects and import reports were preserved." : "For generated families, install the matching Revit English metric family templates.");
        }
        catch (OperationCanceledException)
        {
            title.Text = "Setup cancelled"; subtitle.Text = "No plugin files were changed."; next.Text = "Retry";
            Log("Cancelled before installation.");
        }
        catch (Exception ex)
        {
            title.Text = "Setup needs attention"; subtitle.Text = ex.Message; next.Text = "Retry";
            Log(ex.ToString());
        }
        finally
        {
            busy = false; next.Enabled = true; cancel.Enabled = true;
            if (!completed) { back.Visible = true; cancel.Text = "Close"; }
            try
            {
                var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ArchAI", "RevitSetup", "Logs"); Directory.CreateDirectory(folder);
                File.WriteAllLines(Path.Combine(folder, "setup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".log"), log);
            }
            catch (IOException) { /* Do not hide installation outcome if logging fails. */ }
            cancellation.Dispose(); cancellation = null;
        }
    }
    internal void RenderPreviews(string folder)
    {
        // Offscreen rendering of our own forms for layout checks; no installation actions.
        ShowInTaskbar = false; Opacity = 0; Show(); Application.DoEvents();
        using (var image = new Bitmap(Width, Height)) { DrawToBitmap(image, new Rectangle(0, 0, Width, Height)); image.Save(Path.Combine(folder, "setup-versions.png"), ImageFormat.Png); }
        selected = new List<string> { "2025" }; ShowReview(); PerformLayout(); Application.DoEvents();
        using (var image = new Bitmap(Width, Height)) { DrawToBitmap(image, new Rectangle(0, 0, Width, Height)); image.Save(Path.Combine(folder, "setup-review.png"), ImageFormat.Png); }
        Hide();
    }
    private sealed class BrandPanel : Panel
    {
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e); e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using var pen = new Pen(Color.FromArgb(91, 173, 255), 4);
            e.Graphics.DrawLines(pen, new[] { new Point(28, 114), new Point(76, 38), new Point(124, 114), new Point(28, 114) });
            e.Graphics.DrawLine(pen, 51, 82, 101, 82);
            using var faint = new Pen(Color.FromArgb(48, 66, 86), 1);
            for (int i = 0; i < 6; i++) e.Graphics.DrawLine(faint, 132 + i * 13, 0, 210, 70 + i * 27);
        }
    }
}
