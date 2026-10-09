using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Archai.Plugins;

/// <summary>
/// Client of ArchAI's VR share service (workers/vr-share; the same calls as src/view3d/vrShare.ts):
/// reserve or reuse a short tour id, upload the model and the tour file, and return the short link
/// a headset opens (`&lt;service&gt;/v/&lt;id&gt;`, which redirects to the SJP-VR viewer).
/// </summary>
public static class VrShare
{
    public const long MaxModelBytes = 95L * 1024 * 1024;
    private const string DefaultUrl = "https://archai-vr-share.mklkoklpp.workers.dev";

    public sealed class Settings
    {
        public string Url = "", Token = "";
    }

    public sealed class Published
    {
        public string Id = "", Url = "";
    }

    /// <summary>
    /// The service and the ArchAI account to publish with. Publishing needs an account: the plugin
    /// asks the ArchAI desktop app for the signed-in session over the live link
    /// (GET /live/account, see electron/liveLink.ts); when nobody is signed in ArchAI comes to the
    /// front with its sign-in dialog, and when it is not running it is started. Null then, with
    /// <see cref="NoKey"/> saying what to do. ARCHAI_VR_SHARE_URL overrides the service.
    /// </summary>
    public static Settings? Config(string app = "")
    {
        var url = (Environment.GetEnvironmentVariable("ARCHAI_VR_SHARE_URL") ?? "").Trim().TrimEnd('/');
        if (url.Length == 0) url = DefaultUrl;
        var port = int.TryParse(Environment.GetEnvironmentVariable("ARCHAI_LIVE_PORT"), out var p) ? p : LiveLink.DefaultPort;
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            http.DefaultRequestHeaders.Add("X-ArchAI-Live", "1");
            var body = Task.Run(() => http.GetStringAsync($"http://127.0.0.1:{port}/live/account?prompt=1&app={Uri.EscapeDataString(app)}")).GetAwaiter().GetResult();
            var account = JObject.Parse(body);
            var token = account["token"]?.ToString() ?? "";
            if (account["signedIn"]?.Value<bool>() == true && token.Length > 0) return new Settings { Url = url, Token = token };
            NoKey = "Open in VR publishes with your ArchAI account. Sign in in ArchAI (it is asking now), then run Open in VR again.";
        }
        catch (Exception)
        {
            var exe = LiveLink.InstalledArchai();
            try { if (exe != null) System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(exe) { UseShellExecute = true })?.Dispose(); } catch { }
            NoKey = exe != null
                ? "Open in VR publishes with your ArchAI account. ArchAI is starting: sign in there (top right), then run Open in VR again."
                : "Open in VR publishes with your ArchAI account: install and start the ArchAI desktop app, sign in (top right), then run Open in VR again.";
        }
        return null;
    }

    /// <summary>Why <see cref="Config"/> returned null.</summary>
    public static string NoKey { get; private set; } = "Open in VR publishes with your ArchAI account: start ArchAI and sign in (top right).";

    public static async Task<Published> Upload(Settings settings, string? previousId, byte[] model, JObject tour)
    {
        if (model.Length > MaxModelBytes) throw new InvalidOperationException($"The model is {model.Length / 1048576} MB; the VR share service takes up to 95 MB. Hide what you do not need to see and try again.");
        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", settings.Token);
        async Task<string> Call(HttpMethod method, string path, HttpContent content)
        {
            using var request = new HttpRequestMessage(method, settings.Url + path) { Content = content };
            using var response = await http.SendAsync(request).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"VR share service: {(int)response.StatusCode} {(body.Length > 0 ? body : response.ReasonPhrase)}");
            return body;
        }
        HttpContent Json(string text) => new StringContent(text, Encoding.UTF8, "application/json");

        var reserved = await Call(HttpMethod.Post, "/tours", Json(previousId != null ? new JObject { ["id"] = previousId }.ToString(Formatting.None) : "{}")).ConfigureAwait(false);
        var id = JObject.Parse(reserved)["id"]?.ToString() ?? "";
        if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-z0-9]{4,16}$")) throw new InvalidOperationException("VR share service returned an invalid tour id");
        // The model first: the tour file is what makes the link show the new version.
        var glb = new ByteArrayContent(model);
        glb.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("model/gltf-binary");
        await Call(HttpMethod.Put, $"/tours/{id}/model.glb", glb).ConfigureAwait(false);
        await Call(HttpMethod.Put, $"/tours/{id}/tour.json", Json(tour.ToString(Formatting.None))).ConfigureAwait(false);
        return new Published { Id = id, Url = $"{settings.Url}/v/{id}" };
    }

    /// <summary>
    /// Uploads a tour for the model at <paramref name="documentKey"/> (an app name and file path),
    /// reusing its earlier link, and remembers the link. Blocks; run it off the UI thread if you can.
    /// </summary>
    public static Published Publish(Settings settings, string documentKey, byte[] model, JObject tour)
    {
        var link = Task.Run(() => Upload(settings, PreviousId(documentKey), model, tour)).GetAwaiter().GetResult();
        Remember(documentKey, link.Id);
        return link;
    }

    public static void OpenInBrowser(string url)
    {
        try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    // ---- the tour id of each model, so republishing keeps its link -----------------------

    private static string LinksFile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ArchAI", "vr-links.json");

    private static JObject Links()
    {
        try { return File.Exists(LinksFile) ? JObject.Parse(File.ReadAllText(LinksFile)) : new JObject(); } catch { return new JObject(); }
    }

    public static string? PreviousId(string key) => Links()[key]?.ToString();

    public static void Remember(string key, string id)
    {
        try
        {
            var links = Links();
            links[key] = id;
            Directory.CreateDirectory(Path.GetDirectoryName(LinksFile)!);
            File.WriteAllText(LinksFile, links.ToString(Formatting.Indented));
        }
        catch { }
    }

    public static string Message(string name, VrTour.Result tour, Published link)
    {
        var heavy = tour.Triangles > 1_000_000 ? $"\n\n{tour.Triangles:N0} triangles is a lot for a standalone headset; hide detail you do not need and publish again." : "";
        return $"{name} is online with {tour.Stops} stop{(tour.Stops == 1 ? "" : "s")} ({tour.Triangles:N0} triangles).\n\nOn the headset, open this link in the browser and press Enter VR (it is on your clipboard):\n{link.Url}\n\nPublishing this model again updates the same link.{heavy}";
    }
}
