// Shared WPF user interface of the ArchAI plugins for Windows hosts (Revit, AutoCAD): the icon set
// (plugins/icons, embedded as "archai.<name>-<size>.png"), progress windows and a result dialog.
// Linked into each plugin project; it has no dependency on the host's API.
using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace Archai.Plugins.Windows;

public static class ArchaiIcons
{
    /// <summary>An icon of the set at one of its rendered sizes (16, 20, 24, 32, 48, 64, 128, 256).</summary>
    public static BitmapSource Load(string name, int size)
    {
        var stream = typeof(ArchaiIcons).Assembly.GetManifestResourceStream($"archai.{name}-{size}.png") ?? throw new InvalidOperationException($"Icon {name}-{size} is not embedded.");
        var image = new BitmapImage();
        image.BeginInit();
        image.StreamSource = stream;
        image.CacheOption = BitmapCacheOption.OnLoad;
        image.EndInit();
        image.Freeze();
        return image;
    }
}

internal static class Theme
{
    // Frozen: windows on other threads (the progress window) use them too.
    public static readonly Brush Ink = Frozen(Color.FromRgb(0x1F, 0x21, 0x26));
    public static readonly Brush Muted = Frozen(Color.FromRgb(0x6B, 0x70, 0x7A));
    public static readonly Brush Accent = Frozen(Color.FromRgb(0x2F, 0x6F, 0xED));
    public static readonly Brush Border = Frozen(Color.FromRgb(0xE4, 0xE4, 0xE7));

    private static Brush Frozen(Color color)
    {
        var brush = new SolidColorBrush(color);
        brush.Freeze();
        return brush;
    }
    public static readonly Brush Surface = Brushes.White;
    public static readonly FontFamily Font = new FontFamily("Segoe UI");

    /// <summary>A borderless, rounded window with the ArchAI logo and a title row.</summary>
    public static (Window Window, StackPanel Body) Frame(string title, double width)
    {
        var window = new Window
        {
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ResizeMode = ResizeMode.NoResize,
            SizeToContent = SizeToContent.Height,
            Width = width,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            Topmost = true,
            ShowInTaskbar = false,
            FontFamily = Font,
            Title = title,
        };
        var body = new StackPanel { Margin = new Thickness(22, 18, 22, 20) };
        var header = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 12) };
        header.Children.Add(new Image { Source = ArchaiIcons.Load("logo", 32), Width = 26, Height = 26, Margin = new Thickness(0, 0, 10, 0) });
        header.Children.Add(new TextBlock { Text = title, FontSize = 16, FontWeight = FontWeights.SemiBold, Foreground = Ink, VerticalAlignment = VerticalAlignment.Center });
        body.Children.Add(header);
        window.Content = new Border
        {
            Background = Surface,
            BorderBrush = Border,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Margin = new Thickness(12),
            Effect = new System.Windows.Media.Effects.DropShadowEffect { BlurRadius = 24, ShadowDepth = 4, Opacity = 0.18 },
            Child = body,
        };
        header.MouseLeftButtonDown += (_, e) => { if (e.ButtonState == MouseButtonState.Pressed) window.DragMove(); };
        return (window, body);
    }

    public static Button Button(string text, bool primary)
    {
        var button = new Button
        {
            Content = text,
            Padding = new Thickness(16, 7, 16, 7),
            Margin = new Thickness(8, 0, 0, 0),
            FontSize = 13,
            FontWeight = primary ? FontWeights.SemiBold : FontWeights.Normal,
            Foreground = primary ? Brushes.White : Ink,
            Background = primary ? Accent : Brushes.White,
            BorderBrush = primary ? Accent : Border,
            Cursor = Cursors.Hand,
        };
        return button;
    }
}

/// <summary>
/// A small always-on-top progress window while the host is busy (Send to ArchAI, Open .AIR, Open in
/// VR, live-link syncs): a status line, a percentage and a bar that fills (or sweeps while the
/// amount of work is unknown). It runs on its own UI thread, so it keeps moving while the host's
/// main thread reads or builds geometry, and <see cref="Report"/> may be called from any thread.
/// </summary>
public sealed class ArchaiProgress : IDisposable
{
    private readonly Dispatcher dispatcher;
    private Window? window;
    private TextBlock? message;
    private TextBlock? percent;
    private ProgressBar? bar;
    private int disposed;

    public ArchaiProgress(string title)
    {
        Dispatcher? created = null;
        using var ready = new ManualResetEventSlim(false);
        var thread = new Thread(() =>
        {
            var (frame, body) = Theme.Frame(title, 420);
            var row = new DockPanel { Margin = new Thickness(0, 0, 0, 10), LastChildFill = true };
            percent = new TextBlock { FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = Theme.Ink, Margin = new Thickness(12, 0, 0, 0) };
            DockPanel.SetDock(percent, Dock.Right);
            row.Children.Add(percent);
            message = new TextBlock { FontSize = 13, Foreground = Theme.Muted, TextTrimming = TextTrimming.CharacterEllipsis };
            row.Children.Add(message);
            body.Children.Add(row);
            bar = new ProgressBar { IsIndeterminate = true, Height = 6, Minimum = 0, Maximum = 100, Foreground = Theme.Accent, BorderThickness = new Thickness(0), Background = Theme.Border };
            body.Children.Add(bar);
            window = frame;
            created = Dispatcher.CurrentDispatcher;
            ready.Set();
            Dispatcher.Run();
        })
        { IsBackground = true, Name = "ArchAI progress" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        ready.Wait();
        dispatcher = created!;
    }

    /// <summary>New status line; <paramref name="fraction"/> 0..1 fills the bar, null makes it sweep.</summary>
    public void Report(string text, double? fraction = null)
    {
        if (Volatile.Read(ref disposed) != 0) return;
        dispatcher.BeginInvoke(new Action(() =>
        {
            if (window == null || message == null || bar == null || percent == null) return;
            message.Text = text;
            if (fraction is double f)
            {
                bar.IsIndeterminate = false;
                bar.Value = Math.Max(0, Math.Min(1, f)) * 100;
                percent.Text = $"{Math.Round(bar.Value)}%";
            }
            else
            {
                bar.IsIndeterminate = true;
                percent.Text = "";
            }
            if (!window.IsVisible) window.Show();
        }));
    }

    /// <summary>Runs work off the host's UI thread while the host stays responsive; rethrows its error.</summary>
    public T Run<T>(Func<T> work)
    {
        var task = Task.Run(work);
        while (!task.IsCompleted) { Pump(); Thread.Sleep(15); }
        return task.GetAwaiter().GetResult();
    }

    private static void Pump()
    {
        var frame = new DispatcherFrame();
        Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false));
        Dispatcher.PushFrame(frame);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        dispatcher.BeginInvoke(new Action(() =>
        {
            window?.Close();
            Dispatcher.CurrentDispatcher.InvokeShutdown();
        }));
    }
}

/// <summary>
/// The live link's sync progress (<see cref="LiveLink.SyncProgress"/>) in an
/// <see cref="ArchaiProgress"/> window, only for syncs that take longer than <see cref="ShowAfter"/>:
/// the usual quick syncs after an edit never pop a window; a first sync or a big model does.
/// </summary>
public sealed class LiveProgress : IDisposable
{
    public static readonly TimeSpan ShowAfter = TimeSpan.FromSeconds(1);
    private readonly object gate = new object();
    private readonly string title;
    private ArchaiProgress? window;
    private Timer? timer;
    private bool active;
    private string text = "";
    private double? fraction;

    public LiveProgress(string app) => title = "ArchAI live link · " + app;

    public void Report(string status, double? value)
    {
        lock (gate)
        {
            text = status;
            fraction = value;
            if (!active)
            {
                active = true;
                timer = new Timer(_ => Show(), null, ShowAfter, Timeout.InfiniteTimeSpan);
            }
            window?.Report(status, value);
        }
    }

    private void Show()
    {
        lock (gate)
        {
            if (!active || window != null) return;
            window = new ArchaiProgress(title);
            window.Report(text, fraction);
        }
    }

    /// <summary>The sync is over (also called after syncs that had nothing to do).</summary>
    public void Finished()
    {
        lock (gate)
        {
            active = false;
            timer?.Dispose();
            timer = null;
            window?.Dispose();
            window = null;
        }
    }

    public void Dispose() => Finished();
}

/// <summary>The end of a command: a message, an optional link to copy or open, and Close.</summary>
public static class ArchaiDialog
{
    public static void Show(string title, string text, string? link = null)
    {
        var (window, body) = Theme.Frame(title, 480);
        body.Children.Add(new TextBlock { Text = text, FontSize = 13, Foreground = Theme.Ink, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 14) });
        if (link != null)
        {
            body.Children.Add(new TextBox
            {
                Text = link,
                IsReadOnly = true,
                FontSize = 15,
                FontFamily = new FontFamily("Consolas"),
                Padding = new Thickness(8, 6, 8, 6),
                Margin = new Thickness(0, 0, 0, 16),
                BorderBrush = Theme.Border,
            });
        }
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        if (link != null)
        {
            var copy = Theme.Button("Copy link", false);
            copy.Click += (_, _) => { try { Clipboard.SetText(link); copy.Content = "Copied"; } catch { } };
            var open = Theme.Button("Open in browser", false);
            open.Click += (_, _) => VrShare.OpenInBrowser(link);
            buttons.Children.Add(copy);
            buttons.Children.Add(open);
        }
        var close = Theme.Button("Done", true);
        close.IsDefault = true;
        close.IsCancel = true;
        close.Click += (_, _) => window.Close();
        buttons.Children.Add(close);
        body.Children.Add(buttons);
        window.ShowDialog();
    }

    public static void Error(string title, string text) => Show(title, text);
}
