using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;

namespace Archai.Plugins;

/// <summary>
/// Progress of long plugin work (Send to ArchAI, Open .AIR, Open in VR, live-link syncs): a status
/// line and a fraction 0..1, or null when the amount of work is not known. Hosts show it in their
/// own UI (the shared progress window, Rhino's status bar meter...). May be called from any thread.
/// </summary>
public delegate void ProgressReport(string text, double? fraction);

public static class Progress
{
    /// <summary>"4.2 MB" for status lines.</summary>
    public static string Megabytes(long bytes) =>
        bytes >= 1048576 ? $"{bytes / 1048576.0:0.0} MB" : $"{Math.Max(1, bytes / 1024)} KB";

    /// <summary>A report whose 0..1 lands in [from, to] of <paramref name="report"/> (one phase of a bigger task).</summary>
    public static ProgressReport? Range(this ProgressReport? report, double from, double to) =>
        report == null ? null : (text, fraction) => report(text, fraction is double f ? from + (to - from) * f : (double?)null);

    /// <summary>
    /// Maps item <paramref name="index"/> of <paramref name="count"/> into [from, to], at most about
    /// 50 reports per run so tight loops stay fast.
    /// </summary>
    public static void Step(this ProgressReport? report, int index, int count, string text, double from = 0, double to = 1)
    {
        if (report == null || count <= 0) return;
        var stride = Math.Max(1, count / 50);
        if (index % stride != 0 && index != count - 1) return;
        report(text, from + (to - from) * index / count);
    }
}

/// <summary>An upload body that reports how much of it has been sent.</summary>
public sealed class ProgressContent : HttpContent
{
    private const int Chunk = 64 * 1024;
    private readonly byte[] data;
    private readonly Action<long, long> sent;

    public ProgressContent(byte[] data, string mediaType, Action<long, long> sent)
    {
        this.data = data;
        this.sent = sent;
        Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(mediaType);
    }

    protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context)
    {
        for (var offset = 0; offset < data.Length; offset += Chunk)
        {
            var count = Math.Min(Chunk, data.Length - offset);
            await stream.WriteAsync(data, offset, count).ConfigureAwait(false);
            sent(offset + count, data.Length);
        }
    }

    protected override bool TryComputeLength(out long length)
    {
        length = data.Length;
        return true;
    }
}
