using System.Drawing;
using System.Windows.Forms;

namespace Archai.Setup;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            if (args.Length == 2 && args[0] == "--self-test")
            {
                SelfTests.Run(args[1]).GetAwaiter().GetResult();
                return 0;
            }
            if (args.Length == 2 && args[0] == "--render-previews")
            {
                Directory.CreateDirectory(args[1]);
                using var form = new SetupWizard(false, true);
                form.RenderPreviews(args[1]);
                return 0;
            }
            using var mutex = new Mutex(true, "Local\\ArchAI.Revit.Setup", out var owns);
            if (!owns) { MessageBox.Show("ArchAI setup is already running.", "ArchAI"); return 1; }
            Application.Run(new SetupWizard(args.Contains("--uninstall")));
            return 0;
        }
        catch (Exception ex)
        {
            if (args.Length == 2 && args[0] == "--self-test")
            { Directory.CreateDirectory(args[1]); File.WriteAllText(Path.Combine(args[1], "FAILED.txt"), ex.ToString()); }
            else MessageBox.Show(ex.Message, "ArchAI setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
