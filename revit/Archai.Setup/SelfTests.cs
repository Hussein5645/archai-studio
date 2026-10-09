using System.IO.Compression;
using System.Text;
using System.Xml.Linq;

namespace Archai.Setup;

internal static class SelfTests
{
    public static async Task Run(string output)
    {
        output = Path.GetFullPath(output); Directory.CreateDirectory(output);
        var results = new List<string>();
        void Pass(string message) { results.Add("PASS " + message); }
        void Assert(bool ok, string message) { if (!ok) throw new Exception(message); }
        void Reject(Action action) { try { action(); } catch (InvalidDataException) { return; } throw new Exception("Unsafe input accepted."); }
        var release = Release.Load(); Assert(release.Packages.Count == 4, "Missing Revit version");
        var prepared = new Dictionary<string, Dictionary<string, byte[]>>();
        foreach (var package in release.Packages)
        {
            var bytes = await Installer.Download(package, _ => { }, CancellationToken.None);
            prepared.Add(package.Year, Installer.Unpack(bytes));
            var modified = (byte[])bytes.Clone(); modified[0] ^= 1;
            Reject(() => Installer.Verify(package, modified));
            Pass("Revit " + package.Year + " live Cloudflare download, size, SHA-256 and payload; tampering rejected");
        }
        using (var payload = new MemoryStream())
        {
            using (var zip = new ZipArchive(payload, ZipArchiveMode.Create, true))
            using (var writer = new StreamWriter(zip.CreateEntry("../escape.dll").Open())) writer.Write("bad");
            Reject(() => Installer.Unpack(payload.ToArray())); Pass("ZIP traversal rejected");
        }
        var sandbox = Path.Combine(output, "sandbox-" + Guid.NewGuid().ToString("N"));
        var engine = new Installer(sandbox);
        engine.Install(prepared);
        foreach (var year in prepared.Keys)
        {
            Assert(engine.Installed(year), "Manifest missing");
            var xml = XDocument.Load(Path.Combine(engine.YearPath(year), Installer.ManifestName));
            var assembly = xml.Descendants("Assembly").Single().Value;
            Assert(assembly.StartsWith(sandbox, StringComparison.OrdinalIgnoreCase) && File.Exists(assembly), "Incorrect manifest path");
            foreach (var file in prepared[year]) Assert(Installer.Hash(File.ReadAllBytes(Path.Combine(engine.YearPath(year), Installer.PluginFolder, file.Key))) == Installer.Hash(file.Value), "Installed file mismatch");
        }
        Pass("Four-version installation and manifests in isolated sandbox");
        var replacement = prepared.ToDictionary(p => p.Key, p => p.Value.ToDictionary(f => f.Key, f => Encoding.UTF8.GetBytes("replacement " + f.Key)));
        try { engine.Install(replacement, count => { if (count == 12) throw new IOException("Injected write failure"); }); throw new Exception("Rollback test did not fail"); }
        catch (IOException) { }
        foreach (var pair in prepared)
            foreach (var file in pair.Value) Assert(Installer.Hash(File.ReadAllBytes(Path.Combine(engine.YearPath(pair.Key), Installer.PluginFolder, file.Key))) == Installer.Hash(file.Value), "Rollback did not restore original");
        Pass("Mid-install failure restores previous plugin files across versions");
        engine.Install(prepared); Pass("Repair is repeatable");
        var unrelated = Path.Combine(engine.YearPath("2025"), Installer.PluginFolder, "user-file.txt"); File.WriteAllText(unrelated, "preserve");
        engine.Remove(prepared.Keys);
        Assert(prepared.Keys.All(y => !engine.Installed(y)), "Uninstall left manifests");
        Assert(File.ReadAllText(unrelated) == "preserve", "Uninstall removed user data");
        Pass("Removal deletes only owned plugin files and preserves user files");
        Reject(() => engine.YearPath("../escape")); Pass("Invalid Revit target rejected");
        results.Add("All tests passed. No real Revit add-in folders or registry keys were changed.");
        File.WriteAllLines(Path.Combine(output, "results.txt"), results);
    }
}
