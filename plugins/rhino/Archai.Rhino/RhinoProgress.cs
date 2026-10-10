using System;
using System.Threading;
using Rhino;
using Rhino.UI;
using Archai.Plugins;

namespace Archai.Rhino;

/// <summary>
/// Progress in Rhino's status bar: the progress meter (with its percentage) and the command prompt
/// for the status line. <see cref="Report"/> may be called from any thread; on Rhino's UI thread it
/// also lets Rhino repaint now and then, so the meter moves during long synchronous work.
/// </summary>
internal sealed class RhinoProgress : IDisposable
{
    private const int Steps = 1000;
    private readonly string title;
    private bool shown;
    private int disposed;
    private DateTime lastPaint = DateTime.MinValue;

    public RhinoProgress(string title) => this.title = title;

    public void Report(string text, double? fraction)
    {
        if (Volatile.Read(ref disposed) != 0) return;
        if (RhinoApp.InvokeRequired) RhinoApp.InvokeOnUiThread(new Action(() => Apply(text, fraction, false)));
        else Apply(text, fraction, true);
    }

    private void Apply(string text, double? fraction, bool pump)
    {
        if (Volatile.Read(ref disposed) != 0) return;
        var label = $"{title}: {text}";
        var position = fraction is double f ? (int)Math.Round(Math.Max(0, Math.Min(1, f)) * Steps) : 0;
        if (!shown)
        {
            StatusBar.ShowProgressMeter(0, Steps, title, true, fraction != null);
            shown = true;
        }
        if (fraction != null) StatusBar.UpdateProgressMeter(title, position, true);
        RhinoApp.SetCommandPrompt(label);
        // Synchronous work on the UI thread: repaint about ten times a second.
        if (pump && DateTime.UtcNow - lastPaint > TimeSpan.FromMilliseconds(100))
        {
            lastPaint = DateTime.UtcNow;
            RhinoApp.Wait();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        void Hide()
        {
            if (shown) StatusBar.HideProgressMeter();
            RhinoApp.SetCommandPrompt("Command");
        }
        if (RhinoApp.InvokeRequired) RhinoApp.InvokeOnUiThread(new Action(Hide));
        else Hide();
    }
}

/// <summary>The live link's sync progress in the status bar, for syncs longer than a second.</summary>
internal sealed class RhinoLiveProgress : IDisposable
{
    private static readonly TimeSpan ShowAfter = TimeSpan.FromSeconds(1);
    private readonly object gate = new object();
    private RhinoProgress? meter;
    private Timer? timer;
    private bool active;
    private string text = "";
    private double? fraction;

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
            meter?.Report(status, value);
        }
    }

    private void Show()
    {
        lock (gate)
        {
            if (!active || meter != null) return;
            meter = new RhinoProgress("ArchAI live link");
            meter.Report(text, fraction);
        }
    }

    public void Finished()
    {
        lock (gate)
        {
            active = false;
            timer?.Dispose();
            timer = null;
            meter?.Dispose();
            meter = null;
        }
    }

    public void Dispose() => Finished();
}
