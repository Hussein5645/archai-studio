using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Archai.Plugins;

/// <summary>An ArchAI change to one of the host's own objects (Live Bridge).</summary>
public sealed class BridgeUpdate
{
    /// <summary>The host object's id (what the plugin sent as its id) and exchange collection.</summary>
    public string Ref = "";
    public string Kind = "";
    public string Element = "";
    public string Token = "";
    /// <summary>Plan translation and elevation change in ArchAI millimetres (see <see cref="HostAxes.MoveToZUp"/>), or null.</summary>
    public double[]? Move;
    public string? Name;
}

/// <summary>
/// What one Live Bridge pull changes in the host: <see cref="Nodes"/> to add or replace (by
/// <see cref="ImportObject.ArchaiId"/>; <c>Archai["editable"]</c> asks for an editable object of the
/// host's own, sent back with <see cref="SceneObject.Archai"/> set; <c>Archai["ref"]</c> names the
/// host's own copy to replace), <see cref="Removed"/> ArchAI ids to delete, <see cref="Updates"/>
/// for the host's own objects, and <see cref="Fresh"/> (drop everything ArchAI sent before).
/// </summary>
public sealed class BridgeDelta
{
    public string Name = "ArchAI";
    public readonly List<ImportObject> Nodes = new List<ImportObject>();
    public readonly List<string> Removed = new List<string>();
    public readonly List<BridgeUpdate> Updates = new List<BridgeUpdate>();
    public bool Fresh;
    public bool Empty => Nodes.Count == 0 && Removed.Count == 0 && Updates.Count == 0 && !Fresh;
}

/// <summary>
/// Live Bridge with the ArchAI desktop app (electron/liveLink.ts in ArchAI): while it is on, the
/// host's model goes to the open ArchAI project a moment after each edit, and ArchAI's model comes
/// back into the host (into one layer / group the plugin owns) when it changes there.
///
/// The host supplies four things: <see cref="Export"/> (its model as an exchange file, see
/// <see cref="Exchange"/>), <see cref="Import"/> (replace the ArchAI layer with these objects),
/// <see cref="OnHost"/> (run an action where the host API may be used, e.g. Revit's ExternalEvent,
/// AutoCAD's Idle, Rhino's UI thread) and calls <see cref="ModelChanged"/> from its change events.
/// While <see cref="Importing"/> is true the host's own change events are ArchAI's import.
///
/// Live Bridge (protocol 2, docs/live-bridge-proposal.md) when the host also supplies
/// <see cref="Apply"/> (a <see cref="BridgeDelta"/>, applied element by element) and
/// <see cref="AllIds"/> (every object id of the model, hidden ones too: pushes are then partial with
/// explicit deletions, so hiding never deletes in ArchAI). The model is bound to one ArchAI project
/// (remembered per model in %LOCALAPPDATA%\ArchAI\live-bridge.json, shared with the Python
/// plugins): the one open when it first connects, or the one chosen with <see cref="BindAsync"/>;
/// while ArchAI shows another project nothing is sent.
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
        public string? ProjectId;
        public long Revision;
        public long? Own;
        public int Protocol = 1;
        public bool Mismatch;
    }

    /// <summary>The host's model now (runs through <see cref="OnHost"/>).</summary>
    public Func<JObject>? Export;
    /// <summary>Replaces the ArchAI layer with ArchAI's model (runs through <see cref="OnHost"/>).</summary>
    public Action<AirFile.Contents>? Import;
    /// <summary>Live Bridge: applies a pull element by element (runs through <see cref="OnHost"/>).</summary>
    public Action<BridgeDelta>? Apply;
    /// <summary>Live Bridge: ids of every object of the host model, hidden ones too (runs through <see cref="OnHost"/>).</summary>
    public Func<IEnumerable<string>>? AllIds;
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
    /// <summary>The ArchAI project this model is bound to (Live Bridge), or null.</summary>
    public (string Id, string Name)? Project { get; private set; }
    private bool Bridge => Apply != null;

    private readonly HttpClient http;
    private readonly string baseUrl;
    private Timer? poll;
    private Timer? debounce;
    private int busy;
    private long lastPulled = -1;
    private long lastSeen = -1;
    private bool pushPending;
    private DateTime quietUntil = DateTime.MinValue;
    /// <summary>Host ids ArchAI has from this model; ArchAI element id → hash it sent; update tokens applied.</summary>
    private HashSet<string> known = new HashSet<string>();
    private Dictionary<string, string> have = new Dictionary<string, string>();
    private readonly HashSet<string> tokens = new HashSet<string>();

    public LiveLink(string key, string app, string name)
    {
        Key = key.Length > 300 ? key.Substring(0, 300) : key;
        App = app;
        Name = name;
        var port = int.TryParse(Environment.GetEnvironmentVariable("ARCHAI_LIVE_PORT"), out var p) ? p : DefaultPort;
        baseUrl = "http://127.0.0.1:" + port;
        http = new HttpClient { Timeout = TimeSpan.FromMinutes(3) };
        http.DefaultRequestHeaders.Add("X-ArchAI-Live", "1");
        var entry = BridgeState.Entry(Key);
        if (entry?["project"] is JObject project && (string?)project["id"] is { Length: > 0 } id) Project = (id, (string?)project["name"] ?? "");
        if (entry?["known"] is JArray ids) known = new HashSet<string>(ids.Select(i => (string?)i ?? "").Where(i => i.Length > 0));
    }

    /// <summary>Starts syncing: sends the model now, then follows edits both ways.</summary>
    public void Start()
    {
        if (Running) return;
        Running = true;
        lastPulled = -1;
        have = new Dictionary<string, string>();
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
        Report("Live Bridge is off");
    }

    /// <summary>The host's model changed: send it after a short pause.</summary>
    public void ModelChanged()
    {
        if (!Running) return;
        pushPending = true;
        debounce?.Dispose();
        // While ArchAI's model arrives most events are that import; an edit made meanwhile is sent
        // once it has settled (ArchAI ignores a model it already has).
        var wait = Importing || DateTime.UtcNow < quietUntil ? (quietUntil > DateTime.UtcNow ? quietUntil - DateTime.UtcNow : TimeSpan.Zero) + Debounce : Debounce;
        debounce = new Timer(_ => _ = Tick(), null, wait, Timeout.InfiniteTimeSpan);
    }

    /// <summary>The ArchAI projects this model can be linked to (Live Bridge): { open, projects: [{ id, name, updatedAt, online, open }] }.</summary>
    public async Task<JObject> ProjectsAsync()
    {
        using var response = await http.GetAsync(baseUrl + "/live/projects").ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(await ErrorOf(response).ConfigureAwait(false));
        return JObject.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
    }

    /// <summary>Links this model to an ArchAI project (opened there), or to a new one when <paramref name="projectId"/> is null.</summary>
    public async Task<(string Id, string Name)> BindAsync(string? projectId, string? newName = null)
    {
        var body = new JObject { ["key"] = Key, ["app"] = App, ["name"] = Name };
        if (!string.IsNullOrEmpty(projectId)) body["project"] = projectId;
        else body["newName"] = newName ?? Name;
        var result = await Post("/live/bind", body).ConfigureAwait(false);
        var id = (string?)result["document"]?["id"] ?? "";
        var name = (string?)result["document"]?["name"] ?? "";
        if (Project?.Id != id) known = new HashSet<string>();
        Project = (id, name);
        have = new Dictionary<string, string>();
        lastPulled = -1;
        SaveState();
        return (id, name);
    }

    /// <summary>
    /// Link to project…: ArchAI shows its project picker (it comes to the front) and this model links
    /// to the project the user picks there. Null when they cancel.
    /// </summary>
    public async Task<(string Id, string Name)?> ChooseProjectAsync()
    {
        using var content = new StringContent(new JObject { ["key"] = Key, ["app"] = App, ["name"] = Name, ["choose"] = true }.ToString(Formatting.None), Encoding.UTF8, "application/json");
        using var waiting = new HttpClient { Timeout = TimeSpan.FromMinutes(15) };
        waiting.DefaultRequestHeaders.Add("X-ArchAI-Live", "1");
        using var response = await waiting.PostAsync(baseUrl + "/live/bind", content).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(await ErrorOf(response).ConfigureAwait(false));
        var reply = JObject.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
        if ((bool?)reply["cancelled"] == true) return null;
        var id = (string?)reply["document"]?["id"] ?? "";
        var name = (string?)reply["document"]?["name"] ?? "";
        if (Project?.Id != id) known = new HashSet<string>();
        Project = (id, name);
        have = new Dictionary<string, string>();
        lastPulled = -1;
        SaveState();
        return (id, name);
    }

    private void SaveState() => BridgeState.Save(Key, Project == null ? null : new JObject
    {
        ["project"] = new JObject { ["id"] = Project.Value.Id, ["name"] = Project.Value.Name },
        ["known"] = new JArray(known.OrderBy(i => i, StringComparer.Ordinal)),
    });

    /// <summary>Asks ArchAI whether it is running and has a project open (null: not running).</summary>
    public async Task<Status> StatusAsync()
    {
        try
        {
            var query = "?key=" + Uri.EscapeDataString(Key) + "&name=" + Uri.EscapeDataString(Name) + "&app=" + Uri.EscapeDataString(App);
            if (Bridge) query += "&protocol=2&project=" + Uri.EscapeDataString(Project?.Id ?? "");
            using var response = await http.GetAsync(baseUrl + "/live/status" + query).ConfigureAwait(false);
            var body = JObject.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
            if (!response.IsSuccessStatusCode) return new Status { Running = true, Project = null };
            return new Status
            {
                Running = true,
                Project = (string?)body["document"]?["name"],
                ProjectId = (string?)body["document"]?["id"],
                Revision = (long?)body["revision"] ?? 0,
                Own = (long?)body["own"],
                Protocol = (int?)body["protocol"] ?? 1,
                Mismatch = body["mismatch"] is JObject,
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
            var bridge = Bridge && status.Protocol >= 2;
            if (bridge)
            {
                if (status.Mismatch)
                {
                    Report($"ArchAI shows {status.Project}; this model is linked to {Project?.Name ?? "another project"}. Open it in ArchAI, or link this model to the open project.");
                    return;
                }
                // First connection: linked to the project ArchAI shows.
                if (Project == null || Project.Value.Id != status.ProjectId) await BindAsync(status.ProjectId).ConfigureAwait(false);
            }
            var upToDate = lastSeen == lastPulled && lastPulled >= 0;
            if (pushPending)
            {
                pushPending = false;
                SyncProgress?.Invoke($"Reading the {App} model", null);
                var read = await OnHostAsync(() => (Model: Export?.Invoke(), Ids: bridge ? AllIds?.Invoke()?.ToList() : null)).ConfigureAwait(false);
                var exchange = read.Model;
                if (exchange != null)
                {
                    exchange["app"] = App;
                    var body = new JObject { ["key"] = Key, ["app"] = App, ["name"] = Name, ["model"] = exchange };
                    var sentIds = new HashSet<string>();
                    foreach (var collection in new[] { "levels", "walls", "openings", "slabs", "columns", "railings", "rooms", "meshes" })
                        if (exchange[collection] is JArray items) foreach (var item in items) if ((string?)item["id"] is { Length: > 0 } id) sentIds.Add(id);
                    var deleted = new List<string>();
                    var complete = read.Ids == null;
                    if (bridge)
                    {
                        if (!complete)
                        {
                            var everything = new HashSet<string>(read.Ids!);
                            deleted = known.Where(i => !everything.Contains(i) && !sentIds.Contains(i)).OrderBy(i => i, StringComparer.Ordinal).ToList();
                        }
                        body["protocol"] = 2;
                        body["project"] = Project?.Id ?? "";
                        body["changeId"] = Guid.NewGuid().ToString("N");
                        body["complete"] = complete;
                        body["deleted"] = new JArray(deleted);
                    }
                    void Sent(long sent, long total)
                    {
                        if (sent < total) SyncProgress?.Invoke($"Sending {Progress.Megabytes(sent)} of {Progress.Megabytes(total)} to ArchAI", 0.1 + 0.6 * sent / total);
                        else SyncProgress?.Invoke("ArchAI is updating the project", 0.75);
                    }
                    JObject result;
                    try { result = await Post("/live/push", body, Sent).ConfigureAwait(false); }
                    catch (HttpRequestException) { result = await Post("/live/push", body, Sent).ConfigureAwait(false); } // the reply was lost: the same change again
                    if ((string?)result["refused"] is { Length: > 0 })
                    {
                        Report((string?)result["message"] ?? "ArchAI did not take the model");
                        return;
                    }
                    if (bridge)
                    {
                        known = complete ? sentIds : new HashSet<string>(known.Where(i => !deleted.Contains(i)).Concat(sentIds));
                        SaveState();
                    }
                    var revision = (long?)result["revision"] ?? 0;
                    // Up to date before this push: nothing new to bring back.
                    if (upToDate) lastPulled = revision;
                    lastSeen = revision;
                    var conflicts = (int?)result["applied"]?["conflicts"] ?? 0;
                    var held = (int?)result["applied"]?["held"] ?? 0;
                    var note = conflicts > 0 ? $", {conflicts} conflicts to resolve in ArchAI" : held > 0 ? $", {held} deletions wait for confirmation in ArchAI" : "";
                    Report($"Sent to {status.Project} · {DateTime.Now:HH:mm:ss}{note}");
                }
                return;
            }
            lastSeen = status.Revision;
            // Changed by someone else since the last pull (our own pushes move lastPulled along).
            if (status.Revision == lastPulled) return;
            SyncProgress?.Invoke("ArchAI is preparing its model", null);
            var fresh = bridge && have.Count == 0;
            var path = "/live/pull?key=" + Uri.EscapeDataString(Key);
            if (bridge) path += "&protocol=2&project=" + Uri.EscapeDataString(Project?.Id ?? "") + (fresh ? "&fresh=1" : "");
            using var response = await http.GetAsync(baseUrl + path, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
            if (response.StatusCode == System.Net.HttpStatusCode.NoContent) return;
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException(await ErrorOf(response).ConfigureAwait(false));
            var glb = await ReadWithProgress(response, (read, total) => SyncProgress?.Invoke($"Receiving {Progress.Megabytes(read)} of {Progress.Megabytes(total)}", 0.1 + 0.5 * read / total)).ConfigureAwait(false);
            long.TryParse(HeaderOf(response, "X-ArchAI-Revision"), out var pulled);
            var name = Uri.UnescapeDataString(HeaderOf(response, "X-ArchAI-Name") ?? "ArchAI");
            if (bridge)
            {
                var objects = GlbReader.Read(glb, out var extras);
                var present = new HashSet<string>((extras["present"] as JArray ?? new JArray()).Select(i => (string?)i ?? ""));
                var delta = new BridgeDelta { Name = name, Fresh = fresh };
                delta.Nodes.AddRange(objects);
                delta.Removed.AddRange(have.Keys.Where(id => !present.Contains(id)));
                foreach (var u in extras["updates"] as JArray ?? new JArray())
                {
                    var token = (string?)u["token"] ?? "";
                    if (tokens.Contains(token)) continue;
                    delta.Updates.Add(new BridgeUpdate
                    {
                        Ref = (string?)u["ref"] ?? "",
                        Kind = (string?)u["kind"] ?? "",
                        Element = (string?)u["element"] ?? "",
                        Token = token,
                        Move = (u["move"] as JArray)?.Select(v => (double)v).ToArray(),
                        Name = (string?)u["name"],
                    });
                }
                if (!delta.Empty)
                {
                    SyncProgress?.Invoke($"Updating {delta.Nodes.Count + delta.Removed.Count + delta.Updates.Count} objects in {App}", 0.65);
                    await OnHostAsync<object?>(() =>
                    {
                        Importing = true;
                        try { Apply!(delta); }
                        finally { Importing = false; quietUntil = DateTime.UtcNow.AddSeconds(2); }
                        return null;
                    }).ConfigureAwait(false);
                }
                if (fresh) have = new Dictionary<string, string>();
                foreach (var id in delta.Removed) have.Remove(id);
                foreach (var o in objects) if (o.ArchaiId.Length > 0) have[o.ArchaiId] = (string?)o.Archai["hash"] ?? "";
                foreach (var id in present) if (id.Length > 0 && !have.ContainsKey(id)) have[id] = "";
                foreach (var u in delta.Updates) tokens.Add(u.Token);
                lastPulled = lastSeen = pulled;
                if (!delta.Empty) Report($"Updated from {status.Project} · {DateTime.Now:HH:mm:ss}");
                // Tell ArchAI where its changes landed (and which objects are now copies) right away.
                if (delta.Updates.Count > 0 || objects.Any(o => o.Archai["editable"] is JArray)) { pushPending = true; poll?.Change(TimeSpan.Zero, PollEvery); }
                return;
            }
            var contents = new AirFile.Contents { Name = name };
            contents.Objects.AddRange(GlbReader.Read(glb));
            SyncProgress?.Invoke($"Building {contents.Objects.Count} objects in {App}", 0.65);
            await OnHostAsync<object?>(() =>
            {
                Importing = true;
                try { Import?.Invoke(contents); }
                finally { Importing = false; quietUntil = DateTime.UtcNow.AddSeconds(2); }
                return null;
            }).ConfigureAwait(false);
            lastPulled = lastSeen = pulled;
            Report($"Updated from {status.Project} · {DateTime.Now:HH:mm:ss}");
        }
        catch (Exception error)
        {
            Report("Live Bridge: " + error.Message);
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

/// <summary>What this computer remembers of each model's Live Bridge link (shared with the Python plugins).</summary>
internal static class BridgeState
{
    private static readonly object Gate = new object();

    private static string FilePath => Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") is { Length: > 0 } local ? local : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ArchAI", "live-bridge.json");

    private static JObject Load()
    {
        try { return File.Exists(FilePath) ? JObject.Parse(File.ReadAllText(FilePath)) : new JObject(); }
        catch (Exception) { return new JObject(); }
    }

    public static JObject? Entry(string key)
    {
        lock (Gate) return Load()[key] as JObject;
    }

    public static void Save(string key, JObject? entry)
    {
        lock (Gate)
        {
            var state = Load();
            if (entry == null) state.Remove(key);
            else state[key] = entry;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                File.WriteAllText(FilePath, state.ToString(Formatting.None));
            }
            catch (Exception) { }
        }
    }
}
