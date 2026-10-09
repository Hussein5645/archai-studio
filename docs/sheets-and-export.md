# Proposal: sheets, presentation diagrams and export

Status: **implemented** (2026-09-26): all six phases (quality core, sheet editor, editable views,
DXF, diagramming, analysis data), with the proposed defaults.

## Phase 1: what shipped

- **Bug fixed along the way:** the old exporter looked for `svg[data-testid="world"]`, but the board
  is now a `<div>` of several SVG paint layers interleaved with HTML portals, so PDFs had no vector
  linework. `src/render/boardRuns.ts` now holds the board's paint-order runs (shared by
  `Workboard` and the exporters), and each paint layer carries `data-run`.
- `src/export/compose.ts`: builds the sheet as a stack of layers in board paint order.
  - Vector layers are culled to the region, with computed styles inlined and the zoom-dependent
    `--px` minimums resolved to their true size.
  - `<image>` elements are baked to PNG data URLs at output resolution, with CSS filters and the
    colour mode applied (blob URLs and filters do not survive SVG-as-image or PDF).
  - In PDF, non-Latin text (Arabic and others) is baked to images at print resolution; Latin text
    stays real text.
  - 3D and section portals come from `SceneView.renderImage`. Site maps come from
    `src/export/mapImage.ts`, which fetches tiles at the print zoom and adds the boundary and the
    attribution.
- `SceneView.renderImage(w, h)`: renders at an exact pixel size, in tiles through camera view
  offsets (not capped by the GPU buffer). It fills the view rect without the UI title bar, leaves
  out the selection tint and gizmo, and scales line widths with the output.
- `src/export/quality.ts` (unit-tested): print sizes, canvas clamping, tiling, PNG `pHYs` and JPEG
  JFIF DPI metadata, and colour modes (colour / greyscale / black ink).
- Raster output (`raster.ts`): vector layers rasterized in 4096 px tiles; JPEG flattened on
  white. PDF (`pdf.ts`): multi-page, each page its own size. Rotated views are placed exactly;
  opaque renders are stored as JPEG 95%. SVG (`svg.ts`): a self-contained file at its size in mm.
- `platform.files.saveBinary`: a native Save dialog in Electron (`archai:files:saveBinary`), a
  download on the web, and a native bridge with download fallback.
- Commands: `export-paper` (format, dpi, quality, transparent, colorMode, allPapers; several
  images export as a ZIP), `export-paper-pdf` (alias), `open-export-dialog` (`Mod+Shift+P`, File
  menu, Inspector **Export...**) and `close-export-dialog`. `lock-view` takes `resolution` (long
  side in px, default 3200). `lock-plan-view` defaults to 3x the screen resolution.
- `src/ui/ExportDialog.tsx`: live sheet preview, format, DPI, colour mode, JPEG quality,
  transparent background, all sheets, and the exact pixel size with a note when it is clamped.

Known limits: analysis cards and AI portals are board controls and are not printed. A 3D view
must be mounted on the board to export (it always is while the board is open).

## Phase 2: what shipped (sheet editor)

- **Sheet mode** (`ui.sheet = { paperId, returnViewport }`). Open it with `open-sheet`, by
  double-clicking a paper, or from the Inspector's **Open sheet**. It closes with **Board**, Esc
  (the second Esc; the first clears the selection) or `close-sheet`, and the board viewport comes
  back as it was. The same Workboard paints only the paper's subtree (`boardRuns(elements,
  sheetId)`, with `data-sheet` on the world so exports rebuild the same runs), on a grey desk
  without the grid.
- **Scoped editing**: `hitTest`, `elementsInArea` and `selectableTarget` take the paper as the
  scope root, so clicks and marquee only reach sheet items, and selection stops at the paper's
  children. Camera and section origin handles are hidden. Anything created while a sheet is open
  (rect, line, text, image, instance) becomes a child of the paper in its local frame.
- **View frames** (`meta.sheetView { source, sourceId, crop, scale, title, number, showTitle }`,
  commands `add-sheet-view` and `set-sheet-view`):
  - Level plans and board areas redraw the real board elements in a nested SVG whose viewBox is
    the crop. They stay vector and live, and export as vector. A level plan shows only that
    level's elements (`frameContentIds`).
  - 3D, section and camera views render live from their source (kept mounted but hidden in sheet
    mode). They re-render at output resolution on export.
  - The default scale is the largest standard scale that fits 80% of the sheet. Changing the
    scale resizes the frame about its centre.
  - The drawing title reads "(1) GROUND PLAN / Scale 1:50". The dashed frame guide is screen-only
    (`data-screen-only`, dropped by exports).
- **Title block** (`add-title-block`, `set-title-block`): project, client, drawn, checked, date
  and revision are stored; the drawing title, sheet number (`paper.number`, new, default
  `A-10n`) and scale are read live.
- **Scale bar** (`add-scale-bar`, `set-scale-bar`): follows the selected or first view frame's
  scale, with a 1/2/5 × 10ⁿ length.
- **North arrow** (`add-north-arrow`, `set-north-arrow`): defaults to the site's north angle.
- **UI** (`src/sheets/SheetUI.tsx`):
  - A top bar: Board, sheet number and title (editable), size and scale, Fit, Export.
  - A left panel: views to place (level plans, sections, cameras, 3D views, marked "On sheet"),
    then the sheet's own Layers.
  - A sheet toolbar: Select, Hand, Text, Rectangle, Line, Image, Title block, Scale bar, North
    arrow.
  - Inspector sections for each item.
- Exporting another paper while a sheet is open briefly returns to the board, then reopens the
  sheet.
- Tests: `src/commands/builtin/sheets.test.ts` (7), plus `e2e/sheets.spec.ts`, which builds a
  sheet through the UI, exports it at 150 dpi (checks the exact A3 size) and leaves with Esc.

## Where we are today

- **Paper** (`meta.paper` on a rect, `src/commands/builtin/views.ts`) is a sheet on the board at a
  scale. Anything fully inside it becomes its child. Its only output is `export-paper-pdf`.
- **PDF** (`src/export/pdf.ts`) clones the live world `<svg>`, converts it with svg2pdf, and
  pastes 3D/section portals on top as PNGs at a fixed 4x of their *on-screen* pixel size.
- **Raster** (`src/export/raster.ts`) serializes the same SVG clone into an `<img>` and draws it
  to one canvas. Portal snapshots resize the live WebGL canvas.
- There is no PNG/JPG/SVG/DXF export, no analysis data export, and no dedicated sheet editing mode.

### Quality problems in the current pipeline (found while reading the code)

1. **Portal resolution depends on the screen.** A view that is 200 px wide on screen comes out
   800 px in the PDF, even on an A1 sheet. The resolution should come from the target DPI and
   the printed size.
2. **Snapshots resize the live canvas.** That causes flicker, is capped by the browser's max
   drawing-buffer size (about 4096 to 8192 px), and loses MSAA at large sizes.
3. **Styles are lost in the serialized SVG.** CSS-module classes and `var(--...)` colours do not
   travel into a standalone SVG `<img>`, so rasterized output can differ from the board.
   Fonts are not embedded either, and Arabic text needs an embedded font in PDF.
4. **Canvas size limits.** A single canvas fails above about 16k px per side (and about 268 MP
   in total), so a 300 dpi A1 PNG (9933 x 7016) is already close to the edge.
5. **Rotation in PDF.** A rotated portal is placed with an approximate rotation (the pivot is
   wrong; see the comment in `pdf.ts`).
6. **JPEG has no background.** Transparent areas turn black.

## Phase 3: what shipped (editable views)

- **Entering a view**: double-click a view frame in sheet mode, or use **Style elements...**
  (`enter-sheet-view`), with state `ui.sheet.viewEdit = { frameId, picked }`. Clicks inside
  the frame pick what it shows: plan and board frames hit-test the real elements at the matching
  crop point (`hitTest` has a new `accept` filter), and 3D, section and camera frames raycast
  their source (`SceneView.pickAt`). Shift toggles; a click outside the frame leaves it.
  **Similar** picks every element of the same type. In a view, Esc first clears the picks, then
  leaves; Delete hides the picked elements and never deletes the frame. The top bar shows a
  "› View" crumb with **Done**, and the left panel lists what is styled in the view.
- **Per-view overrides** (`meta.sheetView.overrides[elementId]`, `set-view-override` /
  `clear-view-override`):
  - fill, line colour, line weight (printed mm), opacity;
  - visibility (ghost / hidden), emphasis (outline / glow / shadow) with an accent colour;
  - label, and lift in mm (3D).
  - The model and other views are never touched, and changes undo like any edit.
  - Vector frames apply overrides with scoped CSS (`[data-vf] [data-vo]`, beating the elements'
    own styles) plus SVG glow and shadow filters.
  - 3D frames apply them as temporary material swaps in `SceneView.renderImage({ overrides,
    style, background, highlight, grid })`, restored after the render.
- **Image adjustments** (`set-view-adjustments`): brightness, contrast, saturation, a multiply
  tint with its amount, background, grain, and "fade everything not styled". 3D frames get a
  render style of their own (`set-view-render-style`). `src/sheets/frameRender.ts` renders 3D
  frames the same way on screen and in exports; sheet frames never show the ground grid.
- **Diagram recipes** (`apply-diagram-recipe`, `src/sheets/recipes.ts`):
  - massing, zoning (rooms coloured by name and labelled, walls dark), circulation, structure;
  - exploded axonometric (levels lifted apart, 3D only);
  - clear.
  - Everything a recipe sets stays editable.
- **Flatten** (`flatten-sheet-view`): replaces a frame with a plain image of it, with its
  styling, at the chosen DPI (undoable).
- **Export**:
  - 3D frames re-render with their styling at print resolution.
  - In PDF, frames that use filters or blend modes (`data-bake-pdf`) are baked to images at the
    output resolution; everything else stays vector.
  - Rendered frame images and images placed on a sheet are exempt from the board display style's
    image greying (`data-styled`).
- Fixed along the way: two frames showing the same source view no longer mount it twice.
- Tests: `sheetViews.test.ts` (8), plus `e2e/sheet-styling.spec.ts`. The e2e test enters a
  plan frame by double-click, picks a wall by clicking it in the frame, picks similar, styles the
  walls, applies a recipe and a tint to a camera frame, exports PNG and PDF, and flattens.

## Phase 4: what shipped (DXF / CAD)

- **Approach**: the composed sheet SVG (the one the PDF draws) is converted into CAD primitives
  (`src/export/dxf.ts` `svgToCad`), so every element renderer is reused and CAD output
  matches the drawing. Geometry parsing is pure and unit-tested (`src/export/svgGeometry.ts`):
  transform lists and path data, with curves and arcs flattened.
- **Scopes** (`export-paper` `format: 'dxf'`, `dxfScope`):
  - `sheet` (default): everything on the paper at 1:1 paper millimetres, with the sheet border.
    3D views and maps are outlined on A-ANNO-VIEW, not embedded.
  - `model`: only the drawing, at true size in real board coordinates. View frame contents are
    un-scaled from their crops; sheet annotation is left out.
  - Y is flipped (CAD is y-up); units are millimetres (`$INSUNITS` 4); `$EXTMIN` and
    `$EXTMAX` are set.
- **Layers**: AIA-style names per element type (A-WALL, A-DOOR, A-GLAZ, A-GLAZ-CWMG, A-FLOR-STRS,
  A-FLOR-HRAL, S-COLS, A-AREA, A-FURN, A-SITE, A-ANNO-TEXT/DIMS/SYMB/TTLB/VIEW/SHEET, A-DETL),
  with ACI colours and default lineweights. Fills go on a matching `-PATT` layer.
- **Entities**:
  - LWPOLYLINE for lines, polylines, rects, circles, ellipses and paths.
  - Solid HATCH for colour fills (near-white screen masks are skipped); ANSI31 for pattern fills.
  - TEXT with anchor, middle alignment, rotation and cap height; Unicode (Arabic) survives.
  - Near-black prints as colour 7; other colours as true colour.
- **Lineweights**: the printed stroke width (paper mm on the sheet; stroke ÷ view scale in
  model space), snapped to the standard DXF set. `@tarikjabiri/dxf` (MIT, no dependencies,
  AutoCAD 2007 output) writes no lineweights, so code 370 is injected through a narrow proxy
  around its writer, for entities and for layers.
- **UI**: a DXF format button in the Export dialog, with a *Sheet 1:1 / Model* choice in place
  of resolution, and a note on what each contains. All sheets export as a ZIP of DXFs.
- **Tests**:
  - `src/export/dxf.test.ts` (7): transforms, path flattening, sheet and model mapping,
    lineweights, and a round trip through `dxf-parser` (dev only). The round trip checks
    layers, polylines, lineweights and Unicode text; hatches are checked in the raw file because
    the parser skips them.
  - `e2e/dxf.spec.ts`: exports a real sheet in both scopes, parses it back, checks A3 bounds,
    layers, title-block text and true-size wall coordinates, and saves the DXFs with previews
    rendered from the parsed CAD.
- **Not done**: DWG; paper-space layouts with viewports (the sheet scope covers plotting);
  editable DXF dimensions (measures export as lines and text).

## Phase 5: what shipped (diagramming)

- **Elements**: ordinary lines and rects with `meta.diagram` (`src/diagrams/model.ts`), so
  they select, move, undo, export (PDF/PNG/SVG, DXF on A-ANNO-DIAG and A-ANNO-DIMS) and sit on
  sheets like anything else:
  - **arrow**: a polyline with heads (none, arrow, open, dot, tick) at either end;
  - **connector**: glued to the elements under its ends (clipped at their box edges), with
    straight, curved or orthogonal routing;
  - **callout**: a leader from a dot to a note with a landing;
  - **dimension**: a chained string with 45° ticks, extension lines and one length per segment
    in the document unit; it snaps to wall ends and faces while drawing;
  - **adjacency**: a dashed bubble-diagram link, glued to both ends;
  - **zone**: a rounded box, bubble (ellipse) or box, with a label and its area;
  - **tag**: a live label of an element. `{name}`, `{area}`, `{level}` and `{type}` read the
    target on every render, and a leader appears when the tag is moved off its target.
- **Glue**: a post-edit sync (`refreshConnectors`, run by the executor next to the rooms
  refresh) keeps glued ends on their elements as they move, and drops glue to deleted elements.
  Undo restores it. Glued ends also render live during a drag.
- **Pens by scale**: weights and text are in printed millimetres × the scale of the sheet the
  element sits on (1:100 on the open board), so a diagram prints the same at any scale.
- **Themes**: `workspace.diagramTheme` (Technical, Soft, Mono, Bold) sets ink, accent, zone
  palette (zones with equal labels share a colour), opacity, pen, text size, corner and weight
  for every diagram element. Each element can override its colour, fill and weight.
- **Commands**: `create-diagram`, `set-diagram`, `set-diagram-theme`, and
  `tool-diagram-{arrow,connector,callout,dimension,zone,tag,adjacency}`. Tool ids are
  `diagram:<kind>`.
- **UI**:
  - a **Diagram** menu on the board toolbar (the tools plus a theme picker);
  - the same tools on the sheet toolbar, with tool hints;
  - an Inspector section: note/label/template, colours, weight, dashed, heads, route, glue
    status with Unglue, zone shape and area, dimension offset, and the document theme.
- **Tests**: `diagrams.test.ts` (6), plus `e2e/diagrams.spec.ts`, which draws zones,
  adjacency, a chained dimension on a wall, a callout, an arrow and a tag with real mouse
  input, switches the theme and exports.

## Phase 6: what shipped (analysis data)

- **Sampling on the GPU, as displayed**: the analysis shader gained an `OUTPUT_VALUE` mode that
  writes the raw value (sun hours, lit 0/1, dB(A)) and the surface height.
  `AnalysisLayer.sampleValues` renders it top down into a float render target over the analysis
  box and reads it back, so exported numbers are the exact computation the 3D view draws.
  - Ground and roofs come from an unclipped pass.
  - Each level's floor comes from a pass clipped at the level's plan cut, keeping samples at
    floor height.
  - Wind reads its CPU solvers at their four heights, as m/s (ratio × free stream).
  - `SceneView.analysisSamples` exposes it.
- **Data** (`src/analysis/dataExport.ts`):
  - Grid samples: x, y, z in mm, the surface (Ground, Roof, level name, or wind height) and the
    value, at a chosen spacing (default 1 m).
  - Summaries per surface, room (closed room lines, on their level) and zone (diagram zones):
    samples, min, mean, max, and the share at or above a threshold. Defaults are 2 h of sun,
    55 dB(A) and 5 m/s.
  - A climate table: location, hourly sun altitude and azimuth for the study date, the
    solstices and the equinox, the fetched wind rose and mean speed, and sunshine hours.
  - Everything is CSV (safely quoted) or JSON.
- **Sheet charts**: `meta.chart` sheet items, drawn as plain vector (no gradients or filters) so
  they are crisp in PDF, SVG and DXF.
  - **Sun path**: polar and north-up, with the study day (hour marks), 21 Jun, the equinox and
    21 Dec, at the site's latitude.
  - **Wind rose**: 16 sectors from fetched statistics, else the study wind as an arrow.
  - **Legend**: the study's ramp in solid steps, with its units.
  - **Summary table**: a stored snapshot, since the samples need the running view.
- **Commands**: `export-analysis-data` (grid, summary or climate; CSV or JSON; spacing;
  threshold), `add-analysis-chart` (sun-path, wind-rose, legend) and `add-analysis-summary`.
  Grid and summary need the study running, because the values live in its 3D view; climate
  works any time.
- **UI**: a *Data and sheets* section on analysis origins (grid spacing, threshold, Grid,
  Summary and Climate CSV, Sun path / Wind rose / Legend / Summary table onto the open or first
  sheet), and an *Analysis* list in the sheet panel.
- **Tests**:
  - `dataExport.test.ts` (5): level and roof labelling, summaries with zones, CSV quoting, a
    London midsummer sun table, the commands.
  - `e2e/analysis-data.spec.ts`: runs a real sun-hours study of a U-shaped courtyard on the GPU
    and exports the grid through the download path. It checks 13–17 h maximum on 21 June in
    London and less sun just inside the south wall than on open ground, then places a sun path,
    legend and summary on a sheet.
- **Not done**: façade sampling (vertical surfaces; the proposal made it opt-in).

## Goals

1. A **full-screen sheet editor** for composing a paper: place views, diagrams, analysis
   legends, text, title block, scale bar and north arrow.
2. **Presentation-ready diagramming**: annotation and diagram tools that look finished without
   manual styling.
3. **Export through the paper** (which stays the export frame on the board) to **PDF, PNG,
   JPG, SVG and CAD (DXF)**, with print-grade quality.
4. **Better view-to-image quality**: lock view, snapshots and portals rendered at a target DPI.
5. **Analysis data export**: the numbers behind the sun, wind and noise studies, not only pictures.

## 1. Sheet editor mode

**Entry points:** double-click a paper, the Inspector's **Open sheet** button, `open-sheet {id}`,
or the new **Sheets** list in the left panel.

**Model:** no new storage. The sheet editor is a *mode* (`ui.sheet = { id } | null`) over the
existing paper element. Everything placed in it is a child of the paper, so it is also visible
on the board, moves with the paper, saves, undoes and syncs as usual, and stays operable by AI
through commands.

**Screen layout:**

```
+---------------------------------------------------------------+
| < Board   Sheet: A-101 Ground floor   A1 landscape  [Export v] |
+-------+---------------------------------------------+---------+
| Views |                                             | Inspector|
| (drag |            [ paper, centered, fit ]         | (sheet / |
|  onto |             grey surround, nothing          |  selected|
| sheet)|             else from the board             |  item)   |
|       |                                             |          |
+-------+---------------------------------------------+---------+
|  Select  Text  Title block  Scale bar  North  Legend  Diagram  |
+---------------------------------------------------------------+
```

- The canvas shows only the paper and its children, clipped to the sheet. It is the same
  Workboard renderer with a filter and a locked frame, not a second renderer.
- Snap to sheet margins, a layout grid (default 5 mm) and the edges and centres of other
  sheet items. Measurements are shown in **paper millimetres**.
- **Esc** or **< Board** returns to the board, at the paper.

**Sheet items (new):**

| Item | What it is | Stored as |
|---|---|---|
| **View frame** | A window onto a named view (plan region, section, elevation, camera, 3D) at its own scale (1:50, 1:100 ...), with a crop rectangle and a title label ("1  Ground floor plan  1:100") | rect, `meta.sheetView { sourceId, scale, crop, showTitle }` |
| **Title block** | A template-driven block: project, sheet name and number, date, scale, author, revision | group, `meta.titleBlock` |
| **Scale bar / north arrow** | Linked to the view frame they sit beside, so they update with its scale and rotation | `meta.scaleBar` / `meta.northArrow` |
| **Legend** | Auto-built from what is visible in a view: wall types, room colours, hatches, analysis ramps | group, `meta.legend { sourceId }` |
| **Analysis chart** | Sun path diagram, wind rose, sunshine hours bar chart, noise legend (vector) | group, `meta.chart { kind, sourceId }` |
| **Image / text** | The existing elements | unchanged |

**Why plan views change:** today a plan on a paper must physically lie under the paper, at the
paper's scale. A **view frame** lets one sheet hold a 1:100 plan, a 1:20 detail and a
perspective side by side. The plan content is rendered as **vector SVG** (the board's own SVG for
that region, transformed), so it stays vector in PDF, SVG and DXF. 3D, section and camera frames
are rendered by the offscreen renderer at export DPI (see section 4).

The current "draw under the paper" workflow keeps working. Content under a paper is still
exported as it is today.

### Editing inside a linked view (image-editor style)

A view frame is **live and editable**, not a flat picture. Double-click a view frame to *enter*
it, the way you would open a layer group in an image editor:

- **Pick individual elements** from the model inside the view: walls, rooms, doors, assets,
  massing, terrain. This works in plan views and in 3D, section and camera views, because the 3D
  scene is already built per element id. Shift or box selection adds more; *Select similar*
  picks every wall, every room of a type, and so on.
- **Style them for this view only.** Styles are stored as overrides on the view frame
  (`meta.sheetView.overrides[elementId]`), so the model and other views stay untouched:
  - colour or material swap, fill, opacity, line weight and line colour;
  - **emphasis**: highlight, outline or glow, drop shadow, "pop out" (everything else fades);
  - **ghost** (translucent grey), **hide**, and **isolate**;
  - a label or tag attached to the element.
- **Whole-view image adjustments**, as in image software: brightness, contrast, saturation,
  tint and duotone, background colour or transparent, sky and ground, ambient occlusion,
  outline (ink) edges, and a paper texture or grain.
- **Layers panel** (sheet editor, left side): the sheet's stack of view frames, diagrams, text
  and images, with visibility, lock, blend mode (multiply, screen, overlay) and opacity per
  layer. Inside an entered view, it lists the override groups ("Highlighted: 12 walls").
- **Diagram recipes**: one click applies a set of overrides and adjustments, and every recipe
  can still be edited afterwards:
  - *Massing* (white model, soft shadows, one accent colour);
  - *Zoning / program* (rooms coloured by function, walls ghosted, labels on);
  - *Circulation* (stairs and corridors highlighted, everything else faded, arrow overlays);
  - *Structure* (columns and core walls in colour, the rest ghosted);
  - *Exploded axon* (levels offset vertically, for 3D views);
  - *Analysis overlay* (the sun, wind or noise heatmap over a greyed model, legend added).
- Overrides follow the model: if a highlighted wall moves, the highlight moves with it; if it
  is deleted, its override is dropped.
- **Snapshot to image** ("Flatten", like rasterizing a layer): turns a styled view into a plain
  image at export DPI, for further free editing.

## 2. Presentation diagramming

A **Diagram** tool set, available on the board and in the sheet editor:

- **Arrows and connectors**: straight, curved and orthogonal; head styles; can attach to elements.
- **Callouts and tags**: leader plus text, room and element tags that read live data (name, area,
  level).
- **Zones and bubbles**: soft-cornered translucent areas for functional and zoning diagrams, with
  a label; adjacency lines between bubbles.
- **Dimension strings**: chained dimensions snapped to walls (reuses the measure logic).
- **Section/elevation marks and view titles** in the drawing-set convention.
- **Diagram styles**: a small set of presentation themes (*Technical*, *Soft*, *Mono*, *Dark
  board*) that set line weights, fonts, fills and palette for diagram elements together. They are
  built on the existing graphics presets (`doc.workspace.graphics`), so the look is centralised.
- **Line weights by scale**: printed pen widths (0.13 / 0.18 / 0.25 / 0.35 / 0.5 / 0.7 mm) are
  resolved per view frame scale, so a 1:100 and a 1:20 on the same sheet both print correctly.

## 3. Export (always through a paper)

One **Export** dialog, opened from the sheet editor header, the Inspector on a paper, or
`export-paper {id, format, ...}`:

| Format | Content | Options |
|---|---|---|
| **PDF** | Vector linework, text and hatches; 3D/section rendered at DPI; fonts embedded (Latin plus Arabic) | DPI for raster parts (150/300/600), colour / greyscale / black ink, multi-sheet (all or selected papers into one PDF) |
| **PNG** | Tiled raster at DPI, transparent or paper background | DPI or exact px size, background |
| **JPG** | Same as PNG, flattened on white | quality 60 to 100 |
| **SVG** | Vector sheet with inlined styles and fonts; 3D as embedded images | outline text on/off |
| **DXF (CAD)** | Model space in true mm: lines, polylines, arcs, text, hatches, blocks for assets. Layers follow element type and the layers tree. Optionally paper space with the sheet and view frames | scope: paper region or whole view; units mm/m; AutoCAD 2000 (AC1015) ASCII |

- **DWG** is not proposed: there is no open writer that runs in the browser. DXF opens in
  AutoCAD, Revit, Rhino, ArchiCAD and BricsCAD.
- **Batch**: "Export all sheets" produces one multi-page PDF or a ZIP of PNG/JPG/DXF (fflate is
  already a dependency).
- **Desktop**: new `platform.files.saveBinary(bytes, name, mime)` so Electron shows a native
  Save dialog. The web keeps downloading.

## 4. Rendering quality (applies to all exports and to Lock view)

- **Offscreen 3D renderer** (`src/view3d/offscreen.ts` already exists; extend it): renders any
  view into a `WebGLRenderTarget` at the exact pixel size for the printed size and DPI. It uses
  4x MSAA plus supersampling, and tiles the render when the size exceeds the GPU's max texture
  size. The live canvas is never resized, so there is no flicker, and output no longer depends
  on screen size.
- **Tiled rasterizer** for the SVG board: renders strips of at most 8192 px and stitches them
  (PNG is encoded by streaming rows through fflate's deflate), so a 600 dpi A0 works.
- **Style inlining**: before serializing, computed stroke, fill, font and opacity are copied
  onto the clone, `var(--...)` values are resolved, hatch `<pattern>` defs are carried over, and
  fonts are embedded as `@font-face` data URLs.
- **Exact rotation** of portals and view frames in PDF, using a matrix transform instead of
  jsPDF's corner rotation.
- **Lock view / snapshot** gains a resolution choice (screen x2, 150, 300 dpi at a scale) and
  uses the offscreen path.

## 5. Analysis data export

The analysis runs on the GPU (shaders), so today the values exist only as pixels. The proposal:

- **Point grid readback**: a sample grid (spacing set by the user, default 1 m) over the analysed
  surfaces. The same shader renders into a float render target and the values are read back.
  Output: `CSV` / `JSON` with x, y, z, level, and the value (sun hours, wind speed, dB).
- **Site and climate data** already held in `meta.location` and `WindData`: a CSV of hourly
  sun position (azimuth, altitude), wind rose bins and sunshine hours.
- **Summary**: min, max, mean and the percentage of area above a threshold, per room or zone.
  It can go on a sheet as a table item or be exported as CSV.
- **Charts on sheets**: the analysis chart items from section 1 read the same data.

## Commands (all AI-operable, as the project requires)

`open-sheet`, `close-sheet`, `add-sheet-view`, `set-sheet-view`, `add-title-block`,
`add-scale-bar`, `add-north-arrow`, `add-legend`, `add-analysis-chart`, `tool-diagram-*`,
`set-diagram-style`, `enter-sheet-view`, `set-view-override`, `clear-view-override`,
`set-view-adjustments`, `apply-diagram-recipe`, `flatten-sheet-view`, `export-paper` (format + options; `export-paper-pdf` stays as an alias),
`export-all-papers`, `export-analysis-data`, `lock-view` (with resolution).

## Proposed phases

1. **Quality core**: offscreen DPI renderer, tiled rasterizer, style and font inlining, the
   rotation fix, the Export dialog with PDF/PNG/JPG/SVG, `saveBinary`. *This improves everything
   that already exists.*
2. **Sheet editor**: mode, view frames (vector plan, raster 3D), title block, scale bar, north
   arrow, Sheets list, layers panel, multi-page PDF.
3. **Editable views**: enter a view, pick elements, per-view overrides, image adjustments,
   diagram recipes, flatten to image.
4. **DXF export**: writer, layer mapping, hatches, blocks, paper space.
5. **Diagramming**: arrows and connectors, callouts and tags, zones, dimension strings, diagram
   styles, pen weights by scale.
6. **Analysis data**: grid readback, CSV/JSON, summaries, charts and legends on sheets.

Each phase ships on its own and gets its own tests. There are unit tests for the DXF writer,
the tiling maths and the command contracts, and a Playwright test that exports a sheet and
checks the file size and dimensions.

## Decisions for review

1. **View frames vs. content under the paper.** Proposed: add view frames and keep the old way.
   Alternative: view frames only, and migrate existing papers.
2. **DXF scope.** Proposed: model space in true mm, plus optional paper space. Is model space
   alone enough to start with?
3. **Title block.** Proposed: one built-in template plus editable fields. Do you need custom or
   imported (SVG/DXF) title blocks?
4. **Phase order.** Proposed: quality first (1, then 2, 3, 4, 5, 6). Or should the sheet editor and
   editable views come first?
5. **Analysis grid default.** Proposed: 1 m spacing on floors and ground, plus façades opt-in.
6. **Override scope.** Proposed: overrides belong to one view frame. Should a styled view also be
   saveable as a reusable "view style" for other sheets and projects, like graphics presets?
