using System;
using System.Collections.Generic;

namespace Archai.Plugins;

/// <summary>
/// A point in ArchAI's axes and units: millimetres, plan x to the right, plan y down (a Z-up,
/// right-handed host's -Y), elevation up. A host point (X, Y, Z) in millimetres is (X, -Y, Z).
/// </summary>
public readonly struct ArchaiPoint
{
    public readonly double X, PlanY, Elevation;
    public ArchaiPoint(double x, double planY, double elevation) { X = x; PlanY = planY; Elevation = elevation; }

    /// <summary>From a Z-up right-handed host point times the host unit's size in millimetres.</summary>
    public static ArchaiPoint FromZUp(double x, double y, double z, double millimetres) => new ArchaiPoint(x * millimetres, -y * millimetres, z * millimetres);

    /// <summary>glTF metres (x, up, plan y), what ArchAI's scene and the VR viewer use.</summary>
    public (double X, double Y, double Z) Gltf => (X / 1000, Elevation / 1000, PlanY / 1000);
}

/// <summary>One host object to send to ArchAI or to VR: its triangles in ArchAI millimetres.</summary>
public sealed class SceneObject
{
    public string Id = "";
    public string Name = "";
    public string Category = "";
    public string? Level;
    /// <summary>Live Bridge: the ArchAI element this object is an editable copy of (it came from ArchAI).</summary>
    public string? Archai;
    /// <summary>Live Bridge: the id an older plugin sent for this object (ArchAI moves its link).</summary>
    public string? Was;
    public readonly List<(GlbMaterial Material, ArchaiPoint A, ArchaiPoint B, ArchaiPoint C)> Triangles = new List<(GlbMaterial, ArchaiPoint, ArchaiPoint, ArchaiPoint)>();

    public void Add(GlbMaterial material, ArchaiPoint a, ArchaiPoint b, ArchaiPoint c) => Triangles.Add((material, a, b, c));
}

/// <summary>Converts imported glTF metres back to a Z-up right-handed host.</summary>
public static class HostAxes
{
    /// <summary>glTF metres (x, up, plan y) to host (X, Y, Z) in host units of <paramref name="millimetres"/> mm each.</summary>
    public static (double X, double Y, double Z) ToZUp(float x, float y, float z, double millimetres) =>
        (x * 1000 / millimetres, -z * 1000 / millimetres, y * 1000 / millimetres);

    /// <summary>A Live Bridge move (ArchAI plan mm: x right, plan y down, elevation) as a Z-up host vector.</summary>
    public static (double X, double Y, double Z) MoveToZUp(double[] move, double millimetres) =>
        (move[0] / millimetres, -move[1] / millimetres, move[2] / millimetres);
}

/// <summary>Bounds of a set of objects in ArchAI millimetres.</summary>
public sealed class Bounds
{
    public double MinX = double.MaxValue, MinY = double.MaxValue, MinZ = double.MaxValue, MaxX = double.MinValue, MaxY = double.MinValue, MaxZ = double.MinValue;
    public bool IsEmpty => MinX > MaxX;

    public void Add(ArchaiPoint p)
    {
        MinX = Math.Min(MinX, p.X); MaxX = Math.Max(MaxX, p.X);
        MinY = Math.Min(MinY, p.PlanY); MaxY = Math.Max(MaxY, p.PlanY);
        MinZ = Math.Min(MinZ, p.Elevation); MaxZ = Math.Max(MaxZ, p.Elevation);
    }

    public static Bounds Of(IEnumerable<SceneObject> objects)
    {
        var bounds = new Bounds();
        foreach (var o in objects)
            foreach (var t in o.Triangles) { bounds.Add(t.A); bounds.Add(t.B); bounds.Add(t.C); }
        return bounds;
    }
}
