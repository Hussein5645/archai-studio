# Opening Revit models

Status: **implemented** (2026-10-07).

`.rvt` is a closed Autodesk format that only Revit can read, so the route goes through the ArchAI
add-in for Revit (`revit/`, the same add-in that imports `.AIR` into Revit):

1. In Revit: **ArchAI tab → Send to ArchAI** saves `<model>.AIR`.
2. In ArchAI: **Open file** and pick that `.AIR`. It opens as a new project (one undo step).

Picking a `.rvt` directly in ArchAI explains this instead of failing silently.

## What comes across

| Revit | ArchAI | Notes |
|---|---|---|
| Levels | Levels | Elements are linked to their level (offset kept). |
| Basic walls | Walls | Centre line (location line converted), height, base, compound layers in order with roles (core / finish), names and **materials**. Arcs are tessellated. Exterior on side A. |
| Doors, windows in those walls | Hosted doors / windows | Width, height, sill / threshold, position along the wall, handing, swing side. They cut their wall. |
| Floors, ceilings (flat) | Floors / ceilings | Outline, openings, thickness, bottom elevation, core material. |
| Columns (architectural and structural, vertical) | Columns | Centre, size in the column's own axes, rotation, height, round by family name, material. |
| Railings not on stairs | Railings | Path, top rail height, base. |
| Rooms | Rooms | Boundary (finish faces), "number name". |
| Everything else in model categories (roofs, stairs and their railings, curtain walls with panels and mullions, stacked walls, sloped floors, furniture, casework, plumbing, site...) | Mesh elements | Binary glTF per element with its Revit materials; a box on the board that moves / rotates / lifts it; each Revit material is a paintable slot. |
| Annotation, views, sheets, grids, links | — | Not exported. |

Materials become library materials (colour, transparency, shininess → roughness, metal by name).

## Files

- Revit add-in: `revit/Archai.Revit/ArchaiExporter.cs` (reads the model), `GlbWriter.cs` (meshes),
  `App.cs` (`Send to ArchAI` button, `ExportCommand.Write`).
- Unattended export (tests, scripts): start Revit with
  `ARCHAI_EXPORT_AUTORUN="<model.rvt>|<output.AIR>"`; it exports, writes `<output>.done` (or
  `.failed`) and exits.
- Exchange format: `src/revit/exchange.ts` (`archaiRevit: 1`, millimetres, plan y down).
- Import: `src/revit/importRevit.ts` (`import-revit-model`), hooked into `open-document`.
- Mesh elements: `src/view3d/meshes.ts` (`meta.mesh = { blobId, category, height }` on a rect).
