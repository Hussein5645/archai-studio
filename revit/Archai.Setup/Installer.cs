using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using Microsoft.Win32;

namespace Archai.Setup;

internal sealed class Package
{
    public string Year = "", Url = "", Sha256 = "";
    public long Size;
}
internal sealed class Release
{
    public string Version = "";
    public List<Package> Packages = new List<Package>();
    public static Release Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Archai.Setup.Packages.xml") ?? throw new InvalidOperationException("Missing package configuration.");
        var xml = XElement.Load(stream);
        return new Release {
            Version = (string)xml.Attribute("version")!,
            Packages = xml.Elements("Package").Select(e => new Package {
                Year = (string)e.Attribute("revitVersion")!, Url = (string)e.Attribute("url")!,
                Sha256 = (string)e.Attribute("sha256")!, Size = (long)e.Attribute("sizeBytes")!
            }).ToList()
        };
    }
}

internal sealed class Installer
{
    public const string PluginFolder = "Archai.AirImporter";
    public const string ManifestName = "Archai.AirImporter.addin";
    public const string ProductKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ArchAI.AIRImporter";
    public static readonly string[] Libraries = { "Archai.AirImporter.dll", "Archai.Air.dll", "Archai.Plugins.Core.dll", "Newtonsoft.Json.dll" };
    public static readonly string[] Documents = { "README.md", "THIRD-PARTY-NOTICES.txt", "native-smoke.AIR", "package.json" };
    public string Root { get; }
    public Installer(string root) { Root = Path.GetFullPath(root); }
    public static Installer ForUser() => new Installer(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Autodesk", "Revit", "Addins"));
    public string YearPath(string year)
    {
        if (!new[] { "2024", "2025", "2026", "2027" }.Contains(year)) throw new InvalidDataException("Unsupported Revit year.");
        return Path.Combine(Root, year);
    }
    public bool Installed(string year) => File.Exists(Path.Combine(YearPath(year), ManifestName));
    public static bool RevitPresent(string year)
    {
        if (File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Autodesk", "Revit " + year, "Revit.exe"))) return true;
        using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var key = machine.OpenSubKey(@"SOFTWARE\Autodesk\Revit\Autodesk Revit " + year);
        if (key == null) return false;
        var path = key.GetValue("InstallationLocation") as string;
        return path != null && File.Exists(Path.Combine(path, "Revit.exe"));
    }
    public static void RequireRevitClosed()
    {
        var processes = Process.GetProcessesByName("Revit");
        try { if (processes.Length != 0) throw new InvalidOperationException("Close all Revit windows, then try again. No installation files were changed."); }
        finally { foreach (var process in processes) process.Dispose(); }
    }
    public static string Hash(byte[] bytes)
    {
        using var algorithm = SHA256.Create();
        return BitConverter.ToString(algorithm.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }
    public static async Task<byte[]> Download(Package package, Action<string> progress, CancellationToken token)
    {
        var uri = new Uri(package.Url);
        if (uri.Scheme != "https") throw new InvalidDataException("Package URL must use HTTPS.");
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        using var handler = new HttpClientHandler { AllowAutoRedirect = false };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(90) };
        using var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, token);
        response.EnsureSuccessStatusCode();
        using var input = await response.Content.ReadAsStreamAsync();
        using var output = new MemoryStream();
        var buffer = new byte[32768];
        int read;
        while ((read = await input.ReadAsync(buffer, 0, buffer.Length, token)) > 0)
        {
            if (output.Length + read > package.Size) throw new InvalidDataException("Download exceeds the expected package size.");
            output.Write(buffer, 0, read);
            progress($"Downloading Revit {package.Year}: {output.Length / 1024} / {package.Size / 1024} KB");
        }
        var bytes = output.ToArray();
        Verify(package, bytes);
        return bytes;
    }
    public static void Verify(Package package, byte[] bytes)
    {
        if (bytes.Length != package.Size || Hash(bytes) != package.Sha256) throw new InvalidDataException($"Revit {package.Year} package checksum does not match. Installation stopped.");
    }
    public static Dictionary<string, byte[]> Unpack(byte[] bytes)
    {
        var files = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        using var memory = new MemoryStream(bytes);
        using var zip = new ZipArchive(memory, ZipArchiveMode.Read);
        long total = 0;
        foreach (var entry in zip.Entries)
        {
            var name = entry.FullName.Replace('\\', '/');
            if (name.StartsWith("/") || name.Contains(":") || name.Split('/').Any(p => p == ".." || p == ".")) throw new InvalidDataException("Unsafe ZIP entry path.");
            if (entry.Length > 10 * 1024 * 1024 || (total += entry.Length) > 25 * 1024 * 1024) throw new InvalidDataException("ZIP exceeds extraction limits.");
            string? destination = null;
            if (Libraries.Any(f => name == PluginFolder + "/" + f)) destination = name.Substring(PluginFolder.Length + 1);
            if (Documents.Contains(name)) destination = name;
            if (destination == null) continue; // Never execute archive scripts or trust its .addin paths.
            if (files.ContainsKey(destination)) throw new InvalidDataException("Duplicate ZIP payload entry.");
            using var input = entry.Open(); using var content = new MemoryStream(); input.CopyTo(content);
            files.Add(destination, content.ToArray());
        }
        foreach (var name in Libraries.Concat(Documents)) if (!files.ContainsKey(name)) throw new InvalidDataException("Package is missing " + name);
        return files;
    }
    private byte[] Manifest(string year)
    {
        var xml = new XDocument(new XDeclaration("1.0", "utf-8", null), new XElement("RevitAddIns",
            new XElement("AddIn", new XAttribute("Type", "Application"),
                new XElement("Name", "ArchAI AIR Importer"),
                new XElement("Assembly", Path.Combine(YearPath(year), PluginFolder, "Archai.AirImporter.dll")),
                new XElement("AddInId", "8D622CB4-3412-42FA-B14B-86ED12BCDC27"),
                new XElement("FullClassName", "Archai.Revit.App"),
                new XElement("VendorId", "ARAI"), new XElement("VendorDescription", "ArchAI native AIR importer"))));
        return Encoding.UTF8.GetBytes(xml.ToString());
    }
    public void Install(Dictionary<string, Dictionary<string, byte[]>> packages, Action<int>? afterWrite = null)
    {
        var changes = new Dictionary<string, byte[]?>();
        foreach (var package in packages)
        {
            foreach (var file in package.Value)
            {
                if (!Libraries.Concat(Documents).Contains(file.Key)) throw new InvalidDataException("Unexpected installation file.");
                changes.Add(Path.Combine(YearPath(package.Key), PluginFolder, file.Key), file.Value);
            }
            changes.Add(Path.Combine(YearPath(package.Key), ManifestName), Manifest(package.Key));
        }
        Apply(changes, afterWrite);
    }
    public void Remove(IEnumerable<string> years)
    {
        var changes = new Dictionary<string, byte[]?>();
        foreach (var year in years)
        {
            changes.Add(Path.Combine(YearPath(year), ManifestName), null);
            foreach (var file in Libraries.Concat(Documents)) changes.Add(Path.Combine(YearPath(year), PluginFolder, file), null);
        }
        Apply(changes, null);
        // Only remove a folder if empty; preserve any files the user added.
        foreach (var year in years)
        {
            var path = Path.Combine(YearPath(year), PluginFolder);
            if (Directory.Exists(path) && !Directory.EnumerateFileSystemEntries(path).Any()) Directory.Delete(path);
        }
    }
    private void ValidateTarget(string path)
    {
        if (!Path.GetFullPath(path).StartsWith(Root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Installation target escapes its root.");
        for (var directory = new DirectoryInfo(Path.GetDirectoryName(path)!); directory != null; directory = directory.Parent)
            if (directory.Exists && (directory.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Installation folder contains a junction or symbolic link: " + directory.FullName);
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Installation file is a symbolic link.");
    }
    private static void Write(string path, byte[]? content)
    {
        if (content == null) { if (File.Exists(path)) File.Delete(path); return; }
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllBytes(temporary, content);
            if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    private void Apply(Dictionary<string, byte[]?> changes, Action<int>? afterWrite)
    {
        var originals = new Dictionary<string, byte[]?>();
        foreach (var path in changes.Keys) { ValidateTarget(path); originals[path] = File.Exists(path) ? File.ReadAllBytes(path) : null; }
        var modified = new List<string>();
        try
        {
            foreach (var change in changes)
            {
                modified.Add(change.Key); Write(change.Key, change.Value); afterWrite?.Invoke(modified.Count);
            }
        }
        catch (Exception error)
        {
            var failures = new List<Exception> { error };
            foreach (var path in modified.AsEnumerable().Reverse())
                try { Write(path, originals[path]); } catch (Exception rollbackError) { failures.Add(rollbackError); }
            if (failures.Count > 1) throw new AggregateException("Installation failed and some original files could not be restored. See details.", failures);
            throw new IOException("Installation failed. All changed plugin files were restored. " + error.Message, error);
        }
    }
    public static void RegisterMaintenance(Release release)
    {
        var home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ArchAI", "RevitSetup", release.Version);
        Directory.CreateDirectory(home);
        var target = Path.Combine(home, "ArchAI-Revit-Setup.exe");
        var self = Assembly.GetExecutingAssembly().Location;
        if (!string.Equals(target, self, StringComparison.OrdinalIgnoreCase)) File.Copy(self, target, true);
        using var key = Registry.CurrentUser.CreateSubKey(ProductKey);
        key.SetValue("DisplayName", "ArchAI AIR Importer for Revit (Beta)"); key.SetValue("DisplayVersion", release.Version);
        key.SetValue("Publisher", "ArchAI"); key.SetValue("InstallLocation", home);
        key.SetValue("UninstallString", "\"" + target + "\" --uninstall");
        key.SetValue("ModifyPath", "\"" + target + "\"");
        key.SetValue("DisplayIcon", target); key.SetValue("NoModify", 0); key.SetValue("NoRepair", 0);
    }
    public void UnregisterIfEmpty()
    {
        if (!new[] { "2024", "2025", "2026", "2027" }.Any(Installed)) Registry.CurrentUser.DeleteSubKeyTree(ProductKey, false);
    }
}
