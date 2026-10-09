// Tests of the shared plugin core:  dotnet run --project plugins/dotnet/Archai.Plugins.Core.Tests
// Optional argument: an .AIR file saved by ArchAI, whose 3D snapshot is read and summarised.
using Archai.Plugins;
using Newtonsoft.Json.Linq;

int passed = 0;
void Check(string label, Action test) { test(); passed++; Console.WriteLine("PASS " + label); }
void Near(double actual, double expected, double tolerance = 1e-4) { if (Math.Abs(actual - expected) > tolerance) throw new Exception($"Expected {expected}; got {actual}."); }
void True(bool value, string what) { if (!value) throw new Exception("Expected " + what); }

// A 1 m x 2 m x 3 m box at host (10 m, 20 m, 0) in a Z-up millimetre host.
SceneObject Box(string name)
{
    var o = new SceneObject { Id = name, Name = name, Category = "Generic" };
    var red = new GlbMaterial { Name = "Red", R = 1, G = 0, B = 0 };
    ArchaiPoint P(double x, double y, double z) => ArchaiPoint.FromZUp(10000 + x * 1000, 20000 + y * 2000, z * 3000, 1);
    var c = new[] { P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0), P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1) };
    int[][] faces = { new[] { 0, 2, 1, 0, 3, 2 }, new[] { 4, 5, 6, 4, 6, 7 }, new[] { 0, 1, 5, 0, 5, 4 }, new[] { 1, 2, 6, 1, 6, 5 }, new[] { 2, 3, 7, 2, 7, 6 }, new[] { 3, 0, 4, 3, 4, 7 } };
    foreach (var f in faces) for (int i = 0; i < 6; i += 3) o.Add(red, c[f[i]], c[f[i + 1]], c[f[i + 2]]);
    return o;
}

Check("host Z-up points map to ArchAI plan y down and glTF y up", () =>
{
    var p = ArchaiPoint.FromZUp(1, 2, 3, 1000);
    Near(p.X, 1000); Near(p.PlanY, -2000); Near(p.Elevation, 3000);
    var (x, y, z) = p.Gltf; Near(x, 1); Near(y, 3); Near(z, -2);
    var back = HostAxes.ToZUp((float)x, (float)y, (float)z, 1000); Near(back.X, 1); Near(back.Y, 2); Near(back.Z, 3);
});

Check("a multi-node GLB reads back with names, materials and world positions", () =>
{
    var writer = new GlbWriter();
    writer.BeginNode("A", new JObject { ["archai"] = new JObject { ["id"] = "a", ["type"] = "wall", ["level"] = "Ground" } });
    writer.AddTriangle(new GlbMaterial { Name = "Grey", R = 0.5, G = 0.5, B = 0.5 }, (0, 0, 0), (1, 0, 0), (0, 1, 0));
    writer.BeginNode("B", new JObject { ["archai"] = new JObject { ["id"] = "b", ["kind"] = "rect" } });
    writer.AddTriangle(GlbMaterial.Default, (0, 0, 5), (1, 0, 5), (0, 1, 5));
    var objects = GlbReader.Read(writer.ToGlb());
    True(objects.Count == 2, "two objects");
    True(objects[0].Name == "A" && objects[0].Type == "wall" && objects[0].Level == "Ground", "node A tagged");
    True(objects[1].Type == "rect", "kind fallback");
    Near(objects[0].Parts[0].Material.R, 0.5, 1e-3);
    Near(objects[1].Parts[0].Positions[2], 5);
});

Check("node transforms (TRS, nested, mirrored) are applied", () =>
{
    var writer = new GlbWriter();
    writer.AddTriangle(GlbMaterial.Default, (0, 0, 0), (1, 0, 0), (0, 1, 0));
    var glb = writer.ToGlb();
    // Wrap the node in a parent translated by (5, 0, 0) and scaled by -1 in x.
    var jsonLength = BitConverter.ToInt32(glb, 12);
    var json = JObject.Parse(System.Text.Encoding.UTF8.GetString(glb, 20, jsonLength));
    ((JArray)json["nodes"]!).Add(new JObject { ["children"] = new JArray(0), ["translation"] = new JArray(5, 0, 0), ["scale"] = new JArray(-1, 1, 1) });
    json["scenes"]![0]!["nodes"] = new JArray(1);
    var bin = glb.Skip(20 + jsonLength).ToArray();
    var text = System.Text.Encoding.UTF8.GetBytes(json.ToString(Newtonsoft.Json.Formatting.None));
    var padded = text.Concat(Enumerable.Repeat((byte)0x20, (4 - text.Length % 4) % 4)).ToArray();
    var rebuilt = new List<byte>();
    rebuilt.AddRange(BitConverter.GetBytes(0x46546C67u)); rebuilt.AddRange(BitConverter.GetBytes(2u)); rebuilt.AddRange(BitConverter.GetBytes((uint)(12 + 8 + padded.Length + bin.Length)));
    rebuilt.AddRange(BitConverter.GetBytes((uint)padded.Length)); rebuilt.AddRange(BitConverter.GetBytes(0x4E4F534Au)); rebuilt.AddRange(padded); rebuilt.AddRange(bin);
    var objects = GlbReader.Read(rebuilt.ToArray());
    True(objects.Count == 1, "one object");
    var p = objects[0].Parts[0];
    Near(p.Positions[3], 4); // (1, 0, 0) -> (-1 + 5)
    True(p.Indices[1] == 2 && p.Indices[2] == 1, "winding flipped by the mirror");
});

Check("the exchange file round-trips through AirFile at the right place", () =>
{
    var exchange = Exchange.Write("Test", "Rhino", "8", "C:/model.3dm", new[] { Box("box") }, out var written);
    True(written == 1, "one mesh");
    True((int)exchange["archaiRevit"]! == 1, "exchange marker");
    var mesh = exchange["meshes"]![0]!;
    Near((double)mesh["origin"]![0]!, 10000); Near((double)mesh["origin"]![1]!, -22000); Near((double)mesh["size"]![2]!, 3000);
    var path = Path.Combine(Path.GetTempPath(), "archai-core-test.AIR");
    File.WriteAllText(path, exchange.ToString());
    var contents = AirFile.Read(path);
    True(contents.Name == "Test" && contents.Objects.Count == 1, "one imported object");
    var positions = contents.Objects[0].Parts.SelectMany(part => part.Positions).ToArray();
    Near(positions.Where((_, i) => i % 3 == 0).Min(), 10, 1e-3);
    Near(positions.Where((_, i) => i % 3 == 1).Max(), 3, 1e-3);
    Near(positions.Where((_, i) => i % 3 == 2).Min(), -22, 1e-3);
    var host = HostAxes.ToZUp(positions[0], positions[1], positions[2], 1000);
    True(host.X >= 10 - 1e-3 && host.X <= 11 + 1e-3 && host.Y >= 20 - 1e-3 && host.Y <= 22 + 1e-3, "back at host (10..11, 20..22)");
});

Check("an ArchAI document without a 3D snapshot asks for a re-save", () =>
{
    var path = Path.Combine(Path.GetTempPath(), "archai-core-test-doc.AIR");
    File.WriteAllText(path, "{\"schemaVersion\":9,\"id\":\"d\",\"meta\":{\"name\":\"Doc\"},\"elements\":{}}");
    try { AirFile.Read(path); throw new Exception("accepted"); } catch (FormatException ex) { True(ex.Message == AirFile.NoSnapshot, "the re-save message"); }
});

Check("a VR tour has stops from cameras, or one outside, and a ground disc", () =>
{
    var objects = new List<SceneObject> { Box("box") };
    var camera = VrStop.FromCamera("Entrance", ArchaiPoint.FromZUp(5000, 20000, 1600, 1), ArchaiPoint.FromZUp(1, 0, 0, 1));
    var tour = VrTour.Build("Test", "Rhino", objects, new[] { camera });
    True(tour.Stops == 1 && tour.Triangles == 12 + 64, "12 box + 64 ground triangles");
    var space = tour.Json["spaces"]![0]!;
    Near((double)space["center"]![0]!, 5); Near((double)space["center"]![1]!, -20); Near((double)space["floor"]!, 0); Near((double)space["look"]![0]!, 8);
    True((string)tour.Json["format"]! == "archai-vr" && (string)tour.Json["start"]! == "s1", "tour header");
    var outside = VrTour.Build("Test", "Rhino", objects, new List<VrStop>());
    True((string)outside.Json["spaces"]![0]!["name"]! == "Outside", "outside stop");
    var model = GlbReader.Read(tour.Model);
    True(model.Count == 2 && model[1].Name == "Ground", "box and ground nodes");
});

if (args.Length > 0)
{
    var contents = AirFile.Read(args[0]);
    Console.WriteLine($"{contents.Name}: {contents.Objects.Count} objects, {contents.Objects.Sum(o => o.TriangleCount)} triangles");
    foreach (var group in AirFile.ByLevel(contents.Objects)) Console.WriteLine($"  level '{group.Key}': {group.Count()} objects ({string.Join(", ", group.Select(o => o.Type).Distinct().Take(8))})");
}
Console.WriteLine($"{passed} passed");
