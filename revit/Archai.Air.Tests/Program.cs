using Archai.Air;
using Newtonsoft.Json.Linq;

int passed = 0;
void Check(string label, Action test) { test(); passed++; Console.WriteLine("PASS " + label); }
void Equal(double actual, double expected) { if (Math.Abs(actual - expected) > 1e-7) throw new Exception($"Expected {expected}; got {actual}."); }
void Reject(Action action) { try { action(); } catch (FormatException) { return; } catch (Newtonsoft.Json.JsonException) { return; } throw new Exception("Invalid input accepted."); }
AirDocument Parse(string elements) => AirDocument.Parse("{\"schemaVersion\":1,\"id\":\"test\",\"workspace\":{\"unit\":\"ft\"},\"elements\":" + elements + "}");

Check("millimetres remain storage units regardless of display unit", () => {
    var doc = Parse("{\"a\":{\"id\":\"a\",\"kind\":\"rect\",\"x\":304.8,\"y\":1000,\"width\":100,\"height\":100}}");
    var point = doc.World(doc.Elements["a"], new Point2(0, 0)); Equal(point.X, 304.8); Equal(point.Y, 1000);
});
Check("nested clockwise rotations are composed in source coordinates", () => {
    var doc = Parse("{\"g\":{\"id\":\"g\",\"kind\":\"group\",\"x\":1000,\"y\":2000,\"rotation\":90},\"a\":{\"id\":\"a\",\"kind\":\"rect\",\"parentId\":\"g\",\"x\":100,\"y\":50,\"rotation\":90}}");
    var p = doc.World(doc.Elements["a"], new Point2(10, 0)); Equal(p.X, 940); Equal(p.Y, 2100); Equal(doc.Angle(doc.Elements["a"]), -Math.PI);
});
Check("host elevations and instance overrides", () => {
    var doc = Parse("{\"w\":{\"id\":\"w\",\"meta\":{\"instanceElevation\":3000,\"arch\":{\"type\":\"wall\"}}},\"d\":{\"id\":\"d\",\"meta\":{\"host\":\"w\",\"arch\":{\"type\":\"window\",\"parameters\":{\"sill\":900}}}},\"x\":{\"id\":\"x\",\"meta\":{\"instanceElevation\":5000,\"host\":\"w\",\"arch\":{\"type\":\"door\",\"parameters\":{\"threshold\":20}}}}}");
    Equal(doc.Elevation(doc.Elements["d"]), 3900); Equal(doc.Elevation(doc.Elements["x"]), 5000);
});
Check("level and slab elevations", () => {
    var doc = Parse("{\"l\":{\"id\":\"l\",\"meta\":{\"level\":{\"elevation\":-1200}}},\"f\":{\"id\":\"f\",\"meta\":{\"solid\":{\"elevation\":400,\"height\":200},\"arch\":{\"type\":\"floor\"}}}}");
    Equal(doc.Elevation(doc.Elements["l"]), -1200); Equal(doc.Elevation(doc.Elements["f"]), 400);
});
Check("cycles and missing parents fail before import", () => {
    Reject(() => Parse("{\"a\":{\"id\":\"a\",\"parentId\":\"a\"}}"));
    Reject(() => Parse("{\"a\":{\"id\":\"a\",\"parentId\":\"missing\"}}"));
    Reject(() => Parse("{\"a\":{\"id\":\"a\",\"meta\":{\"host\":\"b\"}},\"b\":{\"id\":\"b\",\"meta\":{\"host\":\"a\"}}}"));
});
Check("future schema, mismatched ids, duplicates, trailing data are rejected", () => {
    Reject(() => AirDocument.Parse("{\"schemaVersion\":2}"));
    Reject(() => Parse("{\"a\":{\"id\":\"b\"}}"));
    Reject(() => Parse("{\"a\":{\"id\":\"a\"},\"a\":{\"id\":\"a\"}}"));
    Reject(() => AirDocument.Parse("{\"schemaVersion\":1,\"id\":\"x\",\"elements\":{}} {}"));
});
Check("arc sampling respects radians and direction", () => {
    var path = JObject.Parse("{\"start\":[100,0],\"segments\":[{\"kind\":\"arc\",\"center\":[0,0],\"radius\":100,\"startAngle\":0,\"endAngle\":1.5707963267948966}]}");
    var points = AirDocument.SamplePath(path); Equal(points.Last().X, 0); Equal(points.Last().Y, 100);
});
Check("Bezier uses analytic source instead of stale points", () => {
    var doc = Parse("{\"a\":{\"id\":\"a\",\"points\":[[0,0],[1,1]],\"path\":{\"start\":[0,0],\"segments\":[{\"kind\":\"quadratic\",\"control\":[100,100],\"to\":[200,0]}]}}}");
    var points = doc.Footprint(doc.Elements["a"]); Equal(points.Last().X, 200); Equal(points[32].Y, 50);
});
Check("concave room gets an interior point", () => {
    var polygon = new[] { new Point2(0,0), new Point2(10,0), new Point2(10,2), new Point2(2,2), new Point2(2,10), new Point2(0,10) };
    var p = AirDocument.Interior(polygon);
    if (!(p.X > 0 && p.Y > 0 && (p.X < 2 || p.Y < 2))) throw new Exception("Point outside L-shaped room.");
    Reject(() => AirDocument.Interior(new[] { new Point2(0,0), new Point2(1,0), new Point2(2,0) }));
});
Check("stair children are not double imported", () => {
    var doc = Parse("{\"s\":{\"id\":\"s\",\"kind\":\"group\",\"meta\":{\"arch\":{\"type\":\"stair\"}}},\"t\":{\"id\":\"t\",\"kind\":\"rect\",\"parentId\":\"s\"}}");
    if (!doc.IsStairPart(doc.Elements["t"]) || doc.IsStairPart(doc.Elements["s"])) throw new Exception("Wrong stair child classification.");
});
Console.WriteLine($"{passed} AIR contract tests passed.");
