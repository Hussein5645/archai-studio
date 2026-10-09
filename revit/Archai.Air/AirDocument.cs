using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Archai.Air;

public static class Json
{
    public static double N(this JToken? token, string name, double fallback = 0)
    {
        var value = token?[name];
        if (value == null || value.Type == JTokenType.Null) return fallback;
        if (value.Type != JTokenType.Integer && value.Type != JTokenType.Float)
            throw new FormatException($"{name} must be a number.");
        var n = (double)value;
        if (double.IsNaN(n) || double.IsInfinity(n)) throw new FormatException($"{name} must be finite.");
        return n;
    }
    public static string S(this JToken? token, string name, string fallback = "") => (string?)token?[name] ?? fallback;
    public static bool B(this JToken? token, string name, bool fallback = false) => (bool?)token?[name] ?? fallback;
}

public readonly struct Point2
{
    public readonly double X, Y;
    public Point2(double x, double y) { X = x; Y = y; }
    public static Point2 Read(JToken token) => new Point2((double)token[0]!, (double)token[1]!);
    public double Distance(Point2 other) => Math.Sqrt(Math.Pow(X - other.X, 2) + Math.Pow(Y - other.Y, 2));
}

public sealed class AirElement
{
    public JObject Raw { get; }
    public string Id => Raw.S("id");
    public string Kind => Raw.S("kind");
    public string Name => Raw.S("name", Type.Length == 0 ? Kind : Type);
    public string Parent => Raw.S("parentId");
    public JToken? Meta => Raw["meta"];
    public JToken? Arch => Meta?["arch"];
    public JToken? Parameters => Arch?["parameters"];
    public string Type => Meta?["level"] is JObject ? "level" : Arch.S("type");
    public string Host => Meta.S("host");
    public double Width => Raw.N("width", Parameters.N("width", 900));
    public double Depth => Raw.N("height", Parameters.N("depth", 500));
    public double P(string key, double fallback) => Parameters.N(key, Arch.N(key, fallback));
    public AirElement(JObject raw) { Raw = raw; }
}

public sealed class AirDocument
{
    public JObject Raw { get; }
    public Dictionary<string, AirElement> Elements { get; } = new Dictionary<string, AirElement>();
    public string Id => Raw.S("id");
    public string Name => Raw["meta"].S("name", "AIR import");
    private AirDocument(JObject raw)
    {
        Raw = raw;
        if (raw.N("schemaVersion", -1) != 1) throw new FormatException("Only ArchAI AIR schemaVersion 1 is supported.");
        if (string.IsNullOrWhiteSpace(Id)) throw new FormatException("Document id is missing.");
        if (!(raw["elements"] is JObject table)) throw new FormatException("AIR elements must be an object.");
        foreach (var entry in table.Properties())
        {
            if (!(entry.Value is JObject value)) throw new FormatException($"Invalid element {entry.Name}.");
            var element = new AirElement(value);
            if (element.Id != entry.Name) throw new FormatException($"Element id mismatch: {entry.Name}.");
            _ = value.N("x"); _ = value.N("y"); _ = value.N("rotation");
            Elements.Add(entry.Name, element);
        }
        foreach (var e in Elements.Values)
        {
            _ = Ancestors(e).ToList();
            if (e.Host.Length > 0 && !Elements.ContainsKey(e.Host)) throw new FormatException($"Missing host {e.Host} for {e.Id}.");
            _ = Elevation(e);
        }
    }
    public static AirDocument Parse(string text)
    {
        using var reader = new JsonTextReader(new StringReader(text)) { MaxDepth = 128, DateParseHandling = DateParseHandling.None };
        var root = JObject.Load(reader, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error });
        if (reader.Read()) throw new FormatException("Unexpected content after AIR document.");
        return new AirDocument(root);
    }
    public IEnumerable<AirElement> Ancestors(AirElement e)
    {
        var visited = new HashSet<string> { e.Id };
        while (e.Parent.Length > 0)
        {
            if (!Elements.TryGetValue(e.Parent, out var parent)) throw new FormatException($"Missing parent {e.Parent}.");
            if (!visited.Add(parent.Id)) throw new FormatException("Cyclic AIR parent hierarchy.");
            yield return parent;
            e = parent;
        }
    }
    public Point2 World(AirElement e, Point2 point)
    {
        foreach (var item in new[] { e }.Concat(Ancestors(e)))
        {
            var angle = item.Raw.N("rotation") * Math.PI / 180;
            point = new Point2(item.Raw.N("x") + Math.Cos(angle) * point.X - Math.Sin(angle) * point.Y,
                item.Raw.N("y") + Math.Sin(angle) * point.X + Math.Cos(angle) * point.Y);
        }
        return point;
    }
    public double Angle(AirElement e) => -(e.Raw.N("rotation") + Ancestors(e).Sum(p => p.Raw.N("rotation"))) * Math.PI / 180;
    public bool IsStairPart(AirElement e) => Ancestors(e).Any(p => p.Type == "stair");
    public double Elevation(AirElement e) => Elevation(e, new HashSet<string>());
    private double Elevation(AirElement e, HashSet<string> seen)
    {
        if (!seen.Add(e.Id)) throw new FormatException("Cyclic AIR host hierarchy.");
        if (e.Type == "level") return e.Meta?["level"].N("elevation") ?? 0;
        if (e.Meta?["instanceElevation"] != null) return e.Meta.N("instanceElevation");
        var key = e.Type == "door" ? "threshold" : e.Type == "window" ? "sill" : "elevation";
        var elevation = e.P(key, e.Meta?["solid"].N("elevation", e.Type == "window" ? 900 : 0) ?? 0);
        if (e.Host.Length > 0) elevation += Elevation(Elements[e.Host], seen);
        return elevation;
    }
    public List<Point2> Footprint(AirElement e)
    {
        List<Point2> points;
        if (e.Raw["path"] is JObject path) points = SamplePath(path);
        else if (e.Raw["points"] is JArray array) points = array.Select(Point2.Read).ToList();
        else points = new List<Point2> { new Point2(0, 0), new Point2(e.Width, 0), new Point2(e.Width, e.Depth), new Point2(0, e.Depth) };
        return points;
    }
    public static List<Point2> SamplePath(JObject path)
    {
        var from = Point2.Read(path["start"]!);
        var result = new List<Point2> { from };
        foreach (var s in (JArray)path["segments"]!)
        {
            var kind = s.S("kind");
            if (kind == "line") { from = Point2.Read(s["to"]!); result.Add(from); continue; }
            var steps = 64;
            var start = s.N("startAngle"); var sweep = s.N("endAngle") - start;
            if (kind == "arc")
            {
                if (s.B("clockwise") && sweep > 0) sweep -= 2 * Math.PI;
                if (!s.B("clockwise") && sweep < 0) sweep += 2 * Math.PI;
            }
            for (int i = 1; i <= steps; i++)
            {
                double t = (double)i / steps, u = 1 - t;
                Point2 p;
                if (kind == "arc")
                {
                    var c = Point2.Read(s["center"]!); var r = s.N("radius");
                    p = new Point2(c.X + r * Math.Cos(start + sweep * t), c.Y + r * Math.Sin(start + sweep * t));
                }
                else
                {
                    var to = Point2.Read(s["to"]!);
                    var c1 = Point2.Read(s[kind == "quadratic" ? "control" : "control1"]!);
                    var c2 = kind == "quadratic" ? c1 : Point2.Read(s["control2"]!);
                    p = kind == "quadratic"
                        ? new Point2(u * u * from.X + 2 * u * t * c1.X + t * t * to.X, u * u * from.Y + 2 * u * t * c1.Y + t * t * to.Y)
                        : new Point2(u * u * u * from.X + 3 * u * u * t * c1.X + 3 * u * t * t * c2.X + t * t * t * to.X, u * u * u * from.Y + 3 * u * u * t * c1.Y + 3 * u * t * t * c2.Y + t * t * t * to.Y);
                }
                result.Add(p);
            }
            from = result[result.Count - 1];
        }
        return result;
    }
    // A scanline interior point works for concave rooms, unlike averaging their vertices.
    public static Point2 Interior(IReadOnlyList<Point2> polygon)
    {
        if (polygon.Count < 3) throw new FormatException("A room needs a closed polygon.");
        var ys = polygon.Select(p => p.Y).Distinct().OrderBy(y => y).ToList();
        double bestWidth = 0; var best = new Point2();
        for (int k = 1; k < ys.Count; k++)
        {
            double y = (ys[k - 1] + ys[k]) / 2;
            var xs = new List<double>();
            for (int i = 0; i < polygon.Count; i++)
            {
                var a = polygon[i]; var b = polygon[(i + 1) % polygon.Count];
                if ((a.Y > y) != (b.Y > y)) xs.Add(a.X + (y - a.Y) * (b.X - a.X) / (b.Y - a.Y));
            }
            xs.Sort();
            for (int i = 1; i < xs.Count; i += 2)
                if (xs[i] - xs[i - 1] > bestWidth) { bestWidth = xs[i] - xs[i - 1]; best = new Point2((xs[i] + xs[i - 1]) / 2, y); }
        }
        if (bestWidth <= 0) throw new FormatException("Degenerate room boundary.");
        return best;
    }
}
