using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Archai.Air;
using Newtonsoft.Json.Linq;

namespace Archai.Revit;

internal static class Geometry
{
    public static double Feet(double mm) => mm / 304.8;
    public static XYZ Xyz(Point2 p, double z = 0) => new XYZ(Feet(p.X), -Feet(p.Y), Feet(z));
    public static List<Curve> Curves(AirDocument source, AirElement e, double elevation, bool closed, List<string> warnings)
    {
        var curves = new List<Curve>();
        XYZ Point(Point2 p) => Xyz(source.World(e, p), elevation);
        var first = default(Point2); var last = default(Point2);
        if (e.Raw["path"] is JObject path)
        {
            first = last = Point2.Read(path["start"]!);
            foreach (var segment in (JArray)path["segments"]!)
            {
                var kind = segment.S("kind");
                if (kind == "line")
                {
                    var next = Point2.Read(segment["to"]!); AddLine(curves, Point(last), Point(next)); last = next;
                }
                else if (kind == "arc")
                {
                    var center = Point2.Read(segment["center"]!); var radius = segment.N("radius");
                    var start = segment.N("startAngle"); var sweep = segment.N("endAngle") - start;
                    if (segment.B("clockwise") && sweep > 0) sweep -= 2 * Math.PI;
                    if (!segment.B("clockwise") && sweep < 0) sweep += 2 * Math.PI;
                    Point2 At(double angle) => new Point2(center.X + radius * Math.Cos(angle), center.Y + radius * Math.Sin(angle));
                    if (last.Distance(At(start)) > 0.1) throw new FormatException("Discontinuous AIR arc path.");
                    int pieces = Math.Max(1, (int)Math.Ceiling(Math.Abs(sweep) / Math.PI));
                    for (int i = 0; i < pieces; i++)
                    {
                        var a = start + sweep * i / pieces; var b = start + sweep * (i + 1) / pieces;
                        curves.Add(Arc.Create(Point(At(a)), Point(At(b)), Point(At((a + b) / 2))));
                    }
                    last = At(start + sweep);
                }
                else
                {
                    warnings.Add("Bezier/quadratic curve approximated by 64 straight native segments.");
                    var partial = new JObject { ["start"] = new JArray(last.X, last.Y), ["segments"] = new JArray(segment.DeepClone()) };
                    var points = AirDocument.SamplePath(partial);
                    for (int i = 1; i < points.Count; i++) AddLine(curves, Point(points[i - 1]), Point(points[i]));
                    last = points[points.Count - 1];
                }
            }
        }
        else
        {
            var points = source.Footprint(e);
            if (points.Count < 2) throw new FormatException("Not enough points.");
            first = points[0]; last = points[points.Count - 1];
            for (int i = 1; i < points.Count; i++) AddLine(curves, Point(points[i - 1]), Point(points[i]));
        }
        if (closed && first.Distance(last) > 0.001) AddLine(curves, Point(last), Point(first));
        if (curves.Count == 0) throw new FormatException("Empty or degenerate geometry.");
        return curves;
    }
    private static void AddLine(List<Curve> curves, XYZ a, XYZ b)
    {
        if (a.DistanceTo(b) < 1e-8) return;
        curves.Add(Line.CreateBound(a, b));
    }
    public static CurveLoop Loop(IEnumerable<Curve> curves)
    {
        var loop = new CurveLoop(); foreach (var c in curves) loop.Append(c); return loop;
    }
    public static CurveArray Array(IEnumerable<Curve> curves)
    {
        var array = new CurveArray(); foreach (var c in curves) array.Append(c); return array;
    }
    public static void Set(Element element, BuiltInParameter key, double value)
    {
        var p = element.get_Parameter(key);
        if (p == null || p.IsReadOnly || !p.Set(value)) throw new InvalidOperationException($"Cannot set {key} on {element.GetType().Name}.");
    }
}
