using System.Runtime.InteropServices;
using Eto.Drawing;
using Eto.Forms;
using Rhino;
using Archai.Plugins;

namespace Archai.Rhino;

/// <summary>The ArchAI panel: the three actions with the ArchAI icon set, and a link to the web app.</summary>
[Guid("8B1D7C40-3F2E-4A9B-9C61-2D7E5B0A44F1")]
public sealed class ArchaiPanel : Panel
{
    private static readonly Color Muted = Color.FromArgb(0x6B, 0x70, 0x7A);

    private readonly Label status = new Label { Text = "Live Bridge: off", TextColor = Muted, Font = SystemFonts.Default(8.5f), Wrap = WrapMode.Word };

    public ArchaiPanel()
    {
        Live.StatusChanged += text => Application.Instance.AsyncInvoke(() => status.Text = "Live Bridge: " + text);
        var header = new StackLayout
        {
            Orientation = Orientation.Horizontal,
            Spacing = 10,
            VerticalContentAlignment = VerticalAlignment.Center,
            Items =
            {
                new ImageView { Image = ArchaiPlugin.Icon("logo", 48), Size = new Size(36, 36) },
                new StackLayout
                {
                    Items =
                    {
                        new Label { Text = "ArchAI", Font = SystemFonts.Bold(13) },
                        new Label { Text = "Design, share and walk through in VR", TextColor = Muted, Font = SystemFonts.Default(8.5f) },
                    },
                },
            },
        };
        Content = new StackLayout
        {
            Padding = new Padding(12),
            Spacing = 8,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Items =
            {
                header,
                new Label { Text = " " },
                Action("export", "Send to ArchAI", "Save the visible model as an .AIR file for ArchAI.", "_ArchaiSend"),
                Action("import", "Open .AIR", "Bring an ArchAI file in as meshes, a layer per level.", "_ArchaiOpenAir"),
                Action("sync", "Live Bridge", "Sync with the project open in the ArchAI desktop app as you work: Rhino's model goes to ArchAI, ArchAI's model comes back on the ArchAI Live layer. Click again to stop.", "_ArchaiLive"),
                status,
                Action("sync", "Link to project...", "Choose the ArchAI project this model syncs with: ArchAI shows its projects.", "_ArchaiLinkProject"),
                Action("vr", "Open in VR", "Walk through the model on a headset or in a browser. Named perspective views become stops.", "_ArchaiVR"),
                Action("web", "ArchAI on the web", "Open the ArchAI web app.", null),
            },
        };
    }

    private static Control Action(string icon, string title, string description, string? command)
    {
        var button = new Button
        {
            Text = title,
            Image = ArchaiPlugin.Icon(icon, 32),
            ImagePosition = ButtonImagePosition.Left,
            MinimumSize = new Size(0, 44),
            ToolTip = description,
        };
        button.Click += (_, _) =>
        {
            if (command == null) VrShare.OpenInBrowser("https://archai-studio-six.vercel.app/");
            else RhinoApp.RunScript(command, false);
        };
        return new StackLayout
        {
            Spacing = 2,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Items = { button, new Label { Text = description, TextColor = Muted, Font = SystemFonts.Default(8.5f), Wrap = WrapMode.Word } },
        };
    }
}

/// <summary>The end of a command: the message, an optional link to copy or open, and Done.</summary>
internal sealed class ResultDialog : Dialog
{
    public ResultDialog(string title, string message, string? link)
    {
        Title = title;
        Resizable = false;
        Width = 460;
        var layout = new StackLayout { Padding = new Padding(18), Spacing = 12, HorizontalContentAlignment = HorizontalAlignment.Stretch };
        layout.Items.Add(new StackLayout
        {
            Orientation = Orientation.Horizontal,
            Spacing = 10,
            VerticalContentAlignment = VerticalAlignment.Center,
            Items = { new ImageView { Image = ArchaiPlugin.Icon("logo", 32), Size = new Size(26, 26) }, new Label { Text = title, Font = SystemFonts.Bold(12) } },
        });
        layout.Items.Add(new Label { Text = message, Wrap = WrapMode.Word, Width = 420 });
        var buttons = new StackLayout { Orientation = Orientation.Horizontal, Spacing = 8 };
        if (link != null)
        {
            layout.Items.Add(new TextBox { Text = link, ReadOnly = true, Font = new Font(FontFamilies.Monospace, 11) });
            var copy = new Button { Text = "Copy link" };
            copy.Click += (_, _) => { new Clipboard().Text = link; copy.Text = "Copied"; };
            var open = new Button { Text = "Open in browser" };
            open.Click += (_, _) => VrShare.OpenInBrowser(link);
            buttons.Items.Add(copy);
            buttons.Items.Add(open);
        }
        var done = new Button { Text = "Done" };
        done.Click += (_, _) => Close();
        DefaultButton = done;
        AbortButton = done;
        buttons.Items.Add(done);
        layout.Items.Add(new StackLayoutItem(buttons, HorizontalAlignment.Right));
        Content = layout;
    }
}
