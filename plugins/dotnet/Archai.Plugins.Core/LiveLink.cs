using System;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Archai.Plugins;

/// <summary>
/// Live link with the ArchAI desktop app (electron/liveLink.ts in ArchAI): while it is on, the
/// host's model goes to the open ArchAI project a moment after each edit, and ArchAI's model comes
/// back into the host (into one layer / group the plugin owns) when it changes there.
///
/// The host supplies four things: <see cref="Export"/> (its model as an exchange file, see
/// <see cref="Exchange"/>), <see cref="Import"/> (replace the ArchAI layer with these objects),
/// <see cref="OnHost"/> (run an action where the host API may be used, e.g. Revit's ExternalEvent,
/// AutoCAD's Idle, Rhino's UI thread) and calls <see cref="ModelChanged"/> from its change events.
/// While <see cref="Importing"/> is true the host's own change events are ArchAI's import: ignore them.
/// </summary>
public sealed class LiveLink : IDisposable
{
    public const int DefaultPort = 47821;
    private static readonly TimeSpan Debounce = TimeSpan.FromSeconds(1.5);
    private static readonly TimeSpan PollEvery = TimeSpan.FromSeconds(2);

    public sealed class Status
    {
        public bool Running;
        public string? Project;
        public long Revision;
        public long? Own;
    }

    /// <summary>The host's model now (runs through <see cref="OnHost"/>).</summary>
    public Func<JObject>? Export;
    /// <summary>Replaces the ArchAI layer with ArchAI's model (runs through <see cref="OnHost"/>).</summary>
    public Action<AirFile.Contents>? Import;
    /// <summary>Runs an action where the host API may be used.</summary>
    public Action<Action> OnHost = action => action();
    /// <summary>Short status for the UI ("Synced 2 s ago", "Start ArchAI…"); may come from any thread.</summary>
    public Action<string>? StatusChanged;
    /// <summary>
    /// Progress of the sync under way (reading, sending, ArchAI updating, receiving, building); may
    /// come from any thread. <see cref="SyncFinished"/> follows when that sync is over.
    /// </summary>
    public ProgressReport? SyncProgress;
    public Action? SyncFinished;

    public string Key { get; }
    public string App { get; }
    public string Name { get; set; }
    public bool Running { get; private set; }
    public bool Importing { get; private set; }
    public string LastStatus { get; private set; } = "";

    private readonly HttpClient http;
    private readonly string baseUrl;
    private Timer? poll;
    private Timer? debounce;
    private int busy;
    private long lastPulled = -1;
    private long lastSeen = -1;
    private bool pushPending;

    public LiveLink(string key, string app, string name)
    {
        Key = key.Length > 300 ? key.Substring(0, 300) : key;
        App = app;
        Name = name;
        var port = int.TryParse(Environment.GetEnvironmentVariable("ARCHAI_LIVE_PORT"), out var p) ? p : DefaultPort;
        baseUrl = "http://127.0.0.1:" + port;
        http = new HttpClient { Timeout = TimeSpan.FromMinutes(3) };
        http.DefaultRequestHeaders.Add("X-ArchAI-Live", "1");
    }

    /// <summary>Starts syncing: sends the model now, then follows edits both ways.</summary>
    public void Start()
    {
        if (Running) return;
        Running = true;
        lastPulled = -1;
        Report("Connecting to ArchAI…");
        pushPending = true;
        poll = new Timer(_ => _ = Tick(), null, TimeSpan.Zero, PollEvery);
    }

    public void Stop()
    {
        if (!Running) return;
        Running = false;
        poll?.Dispose();
        debounce?.Dispose();
        poll = null;
        debounce = null;
        _ = Post("/live/stop", new JObject { ["key"] = Key });
        Report("Live link is off");
    }

    /// <summary>The host's model changed: send it after a short pause.</summary>
    public void ModelChanged()
    {
        if (!Running || Importing) return;
        pushPending = true;
        debounce?.Dispose();
        debounce = new Timer(_ => _ = Tick(), null, Debounce, Timeout.InfiniteTimeSpan);
    }

    /// <summary>Asks ArchAI whether it is running and has a project open (null: not running).</summary>
    public async Task<Status> StatusAsync()
    {
        try
        {
            using var response = await http.GetAsync(baseUrl + "/live/status?key=" + Uri.EscapeDataString(Key) + "&name=" + Uri.EscapeDataString(Name) + "&app=" + Uri.EscapeDataString(App)).ConfigureAwait(false);
            var body = JObject.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
            if (!response.IsSuccessStatusCode) return new Status { Running = true, Project = null };
            return new Status
            {
                Running = true,
                Project = (string?)body["document"]?["name"],
                Revision = (long?)body["revision"] ?? 0,
                Own = (long?)body["own"],
            };
        }
        catch (Exception) { return new Status { Running = false }; }
    }

    private async Task Tick()
    {
        if (!Running || Interlocked.Exchange(ref busy, 1) == 1) return;
        try
        {
            var status = await StatusAsync().ConfigureAwait(false);
            if (!status.Running)
            {
                Report(LaunchArchai() ? "Starting ArchAI…" : "Install and start the ArchAI desktop app to sync");
                return;
            }
            // ArchAI opens a project for this model on its own (the one linked before, or a new one).
            if (status.Project == null) { Report("Opening a project in ArchAI…"); return; }
            var upToDate = lastSeen == lastPulled && lastPulled >= 0;
            if (pushPending)
            {
                pushPending = false;
                SyncProgress?.Invoke($"Reading the {App} model", null);
                var exchange = await OnHostAsync(() => Export?.Invoke()).ConfigureAwait(false);
                if (exchange != null)
                {
                    exchange["app"] = App;
                    var body = new JObject { ["key"] = Key, ["app"] = App, ["name"] = Name, ["model"] = exchange };
                    var result = await Post("/live/push", body, (sent, total) =>
                    {
                        if (sent < total) SyncProgress?.Invoke($"Sending {Progress.Megabytes(sent)} of {Progress.Megabytes(total)} to ArchAI", 0.1 + 0.6 * sent / total);
                        else SyncProgress?.Invoke("ArchAI is updating the project", 0.75);
                    }).ConfigureAwait(false);
                    var revision = (long?)result["revision"] ?? 0;
                    // Up to date before this push: nothing new to bring back.
                    if (upToDate) lastPulled = revision;
                    lastSeen = revision;
                    Report($"Sent to {status.Project} · {DateTime.Now:HH:mm:ss}");
                }
                return;
            }
            lastSeen = status.Revision;
            // Changed by someone else since the last pull (our own pushes move lastPulled along).
            if (status.Revision == lastPulled) return;
            SyncProgress?.Invoke("ArchAI is preparing its model", null);
            using var response = await http.GetAsync(baseUrl + "/live/pull?key=" + Uri.EscapeDataString(Key), HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
            if (response.StatusCode == System.Net.HttpStatusCode.NoContent) return;
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException(await ErrorOf(response).ConfigureAwait(false));
            var glb = await ReadWithProgress(response, (read, total) => SyncProgress?.Invoke($"Receiving {Progress.Megabytes(read)} of {Progress.Megabytes(total)}", 0.1 + 0.5 * read / total)).ConfigureAwait(false);
            long.TryParse(HeaderOf(response, "X-ArchAI-Revision"), out var pulled);
            var contents = new AirFile.Contents { Name = Uri.UnescapeDataString(HeaderOf(response, "X-ArchAI-Name") ?? "ArchAI") };
            contents.Objects.AddRange(GlbReader.Read(glb));
            SyncProgress?.Invoke($"Building {contents.Objects.Count} objects in {App}", 0.65);
            await OnHostAsync<object?>(() =>
            {
                Importing = true;
                try { Import?.Invoke(contents); }
                finally { Importing = false; }
                return null;
            }).ConfigureAwait(false);
            lastPulled = lastSeen = pulled;
            Report($"Updated from {status.Project} · {DateTime.Now:HH:mm:ss}");
        }
        catch (Exception error)
        {
            Report("Live link: " + error.Message);
        }
        finally
        {
            Interlocked.Exchange(ref busy, 0);
            SyncFinished?.Invoke();
        }
    }

    private DateTime launchedAt = DateTime.MinValue;

    /// <summary>
    /// Starts the ArchAI desktop app through its archai:// link (registered by its installer), at
    /// most once a minute. False when the link cannot be opened (ArchAI is not installed).
    /// </summary>
    private bool LaunchArchai()
    {
        if (DateTime.UtcNow - launchedAt < TimeSpan.FromSeconds(60)) return launched;
        launchedAt = DateTime.UtcNow;
        try
        {
            var exe = InstalledArchai();
            var url = "archai://live?key=" + Uri.EscapeDataString(Key) + "&app=" + Uri.EscapeDataString(App) + "&name=" + Uri.EscapeDataString(Name);
            if (exe != null) System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(exe) { UseShellExecute = true })?.Dispose();
            else if (ProtocolRegistered()) System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true })?.Dispose();
            else return launched = false;
            launched = true;
        }
        catch (Exception) { launched = false; }
        return launched;
    }

    /// <summary>ArchAI.exe in its usual install folders (ARCHAI_EXE overrides), or null.</summary>
    public static string? InstalledArchai()
    {
        var candidates = new[]
        {
            Environment.GetEnvironmentVariable("ARCHAI_EXE") ?? "",
            System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "ArchAI", "ArchAI.exe"),
            System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "ArchAI", "ArchAI.exe"),
        };
        foreach (var path in candidates) if (path.Length > 0 && System.IO.File.Exists(path)) return path;
        return null;
    }

    /// <summary>Whether Windows knows the archai:// link (ArchAI installed somewhere else).</summary>
    private static bool ProtocolRegistered()
    {
        try
        {
            using var query = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("reg", @"query HKCR\archai") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true });
            if (query == null) return false;
            query.WaitForExit(5000);
            return query.HasExited && query.ExitCode == 0;
        }
        catch (Exception) { return false; }
    }

    private bool launched;

    private Task<T> OnHostAsync<T>(Func<T> work)
    {
        var done = new TaskCompletionSource<T>();
        OnHost(() =>
        {
            try { done.TrySetResult(work()); }
            catch (Exception error) { done.TrySetException(error); }
        });
        return done.Task;
    }

    private async Task<JObject> Post(string path, JObject body, Action<long, long>? sent = null)
    {
        using HttpContent content = sent == null
            ? new StringContent(body.ToString(Formatting.None), Encoding.UTF8, "application/json")
            : new ProgressContent(Encoding.UTF8.GetBytes(body.ToString(Formatting.None)), "application/json", sent);
        using var response = await http.PostAsync(baseUrl + path, content).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(await ErrorOf(response).ConfigureAwait(false));
        var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        return text.Length > 0 ? JObject.Parse(text) : new JObject();
    }

    /// <summary>The body, reporting bytes read when the length is known.</summary>
    private static async Task<byte[]> ReadWithProgress(HttpResponseMessage response, Action<long, long> read)
    {
        var total = response.Content.Headers.ContentLength ?? 0;
        if (total <= 0) return await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
        using var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
        var data = new byte[total];
        var offset = 0;
        while (offset < total)
        {
            var count = await stream.ReadAsync(data, offset, (int)Math.Min(64 * 1024, total - offset)).ConfigureAwait(false);
            if (count <= 0) break;
            offset += count;
            read(offset, total);
        }
        if (offset == total) return data;
        Array.Resize(ref data, offset);
        return data;
    }

    private static async Task<string> ErrorOf(HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        try { return (string?)JObject.Parse(text)["error"] ?? text; }
        catch (JsonException) { return text.Length > 0 ? text : response.ReasonPhrase ?? "error"; }
    }

    private static string? HeaderOf(HttpResponseMessage response, string name) =>
        response.Headers.TryGetValues(name, out var values) ? string.Join("", values) : null;

    private void Report(string status)
    {
        LastStatus = status;
        StatusChanged?.Invoke(status);
    }

    public void Dispose()
    {
        Stop();
        http.Dispose();
    }
}
