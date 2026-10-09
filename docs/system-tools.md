# System tools — built-in behaviour and the R2 `system/` folder

Status: **implemented** (2026-09-18). Deviations from the reviewed proposal are marked *Note*.

System tools are the six built-in architecture tools: **Wall, Column, Door, Window, Stairs,
Railing**. (Curtain wall, Facade element, Room and Room divider are unchanged by this proposal.)

Every system tool has:

1. **One built-in default type** — works with no network, no catalog.
2. **Extra types loaded from R2** under `system/<tool>/`, one `.cai` package per type.
3. **Parameter ownership** controlled in the type configuration panel. Shared values are edited
   there; exposed instance values are edited in the Inspector.

## Editing type and instance parameters

Select an element and open its type card in the Inspector. Each parameter has one ownership
control: unchecked means **Type · shared**, checked means **Instance · edit in inspector**.
Apply saves ownership changes. Type edits update placed elements using the same type and keep
their instance values. Unchecking an instance parameter starts from the selected instance's
current value; Apply makes that value shared again and removes the old overrides.

Elevation, door threshold, and window sill are always instance-only. They appear in the type
panel for reference, but both the value and ownership checkbox are locked. Name, location,
rotation, and placement geometry are also instance fields. Level-linked elevations are edited
through their level and offset controls.

The Inspector shows canonical dimensions once: width/depth or diameter replace duplicate
bounding-box editors. Exposed wall layers can be edited in the instance inspector. Configuration
previews use live instance values plus pending type edits; these are dimension/profile schematics,
while the type card retains the library thumbnail.

In the node graph, **Instance** fields accept inputs and **Type** fields remain read-only outputs.
Connected fields show their driving variable and disable manual editing. Edit values or links,
then press **Run** to update the referenced instances. The status reports unapplied graph edits
and the result of each run. A parameter controlled by a level cannot also be driven through an
elevation, sill, or threshold graph input.

Wall path geometry is instance placement. The Inspector has one selector and shows start/end
coordinates for straight walls, bend/centre/radius for arcs, and handle count plus each handle's
coordinates for Bézier walls. Coordinates use project space and project units. Handle counts
are even (2–64); adding pairs subdivides the curve without changing its shape. The type window
mirrors these controls read-only, together with level links, offsets, visibility, pinned state,
and other instance settings. Door, window, column and stair controls follow the selected mode;
irrelevant controls are hidden in the inspector, type window and graph.

Grid dragging uses a stable reference: an object's origin, a line's first point, or the selection
bounds for groups/multiple objects. Boundary snapping preserves the grid coordinate along a
wall instead of using the raw pointer coordinate. Wall endpoints can join the middle of another
wall; T-junction outlines open at the branch, and the join toggle can separate/rejoin them.

Document model stays primitive-only: a placed element is still a `line`/`rect`/`group` with
`meta.arch = { type, typeId, parameters, ... }`. Switching type re-derives geometry from the
parameters; it never stores type-specific element kinds.

---

## 1. Built-in behaviour per tool

### Wall

| | |
|---|---|
| Geometry | Polyline. Each segment is a `line` element whose stroke is the **total thickness**. No resize handles; only the two endpoints can be dragged. No diagonal scaling (rotation handle hidden). |
| Layers | `parameters.layers = [{ name, role: 'finish' \| 'core', thickness }]`. Total thickness = sum. Default: one core layer, 200 mm. Layers are drawn as thin separator lines inside the stroke, core hatched lighter. |
| Location line | `parameters.locationLine = 'centre' \| 'inside' \| 'outside'`. The drawn path is the location line; the stroke is offset from it accordingly (inside = the face nearest the *drawing direction's right side*, matching Revit's convention; documented in the dialog). |
| Snapping while drawing | Cursor snaps (18 px tolerance) to, in priority order: wall endpoints → wall **centre line** → wall **outside face** → wall **inside face** → grid. The snap target is shown in the overlay (small label "centre / inside / outside"). `Alt` disables all snapping. |
| Joins | Unchanged: consecutive segments and endpoint-coincident walls record `joints`. Mitres are drawn from the join metadata using the total thickness. |
| Configure dialog | Type picker (Default + R2 types + local imports), location line, editable layer table (add / remove / reorder, name, role, thickness), live section swatch. |
| Hosting | Doors and windows are *hosted* by their wall: moving the wall moves them, and the Layers panel lists them under the wall. Any element can be hosted on any other by dragging it onto a row in Layers (`set-host`); dropping on empty space unhosts. |

### Column

| | |
|---|---|
| Geometry | Placed at a click. `parameters.shape = 'rectangle' \| 'circle'`. Rectangle → `rect` element `width × depth`; circle → `ellipse` element `diameter`. |
| Editing | Resize handles allowed (they edit `width`/`depth` or `diameter`); rotation allowed for rectangles. |
| 3D | `parameters.height` (default 3000 mm) stored for the future 3D workspace; not drawn in 2D. |
| Material | `parameters.material` (concrete / steel / timber) drives the fill hatch. |
| Default categories | Two built-in shapes: **Rectangular** and **Circular** (the `shape` parameter). R2 types add presets (e.g. steel I-section). *Note:* a column type's `views/top` is shown in the dialog only; the board always draws the parametric rectangle/circle. |

### Door

| | |
|---|---|
| Geometry | Fixed-size 2D line symbol (leaf + swing arc) drawn from `parameters.width` (default 900). **Not scalable** — no resize or rotate handles. Width is edited only in the dialog. |
| Hosting | Unchanged: snaps onto a wall, records an `opening` in the host wall; drag moves it along the wall. |
| Symbol | Built-in symbol is the regular single swing. `handing` flips the leaf, `openingSide` flips the arc to the other wall face. |
| Default type | One: **Single swing**. Other operations (double, sliding, folding) come from R2 as separate types with their own symbol. |

### Window

| | |
|---|---|
| Geometry | `rect` frame + centre glazing line. `parameters.width` (default 1200) along the wall, **depth always equals the host wall's total thickness** (recomputed whenever the wall's layers change; unhosted windows use 150). |
| Editing | Only the two jamb handles **along the host wall** are shown; dragging one changes `width` while the other jamb stays put (`resize-window`). Perpendicular handles and rotation are hidden; the Inspector's Height field is disabled. |
| Hosting | Same as door. |
| Default type | One: **Fixed**. |

### Stairs

| | |
|---|---|
| Parameters | `width` (1000), `riserHeight` (175), `treadDepth` (280), `totalRise` (3000 — default floor-to-floor), `landingDepth` (1000). |
| Drawing (step-by-step, Revit style) | 1. Click the **start** of the run. 2. Move the cursor: the run grows one tread at a time in the cursor direction (snapped to 0/45/90°), overlay shows `n / N risers` where `N = ceil(totalRise / riserHeight)`. 3. Click to end the run at the current tread count. 4. If risers remain, press **L** (or click the "Add landing" chip) to append a landing of `landingDepth`; the next run starts from the landing and can turn 90° (L / U-shaped stairs come from this, no separate "type"). 5. Repeat until `N` risers are placed; the tool finishes automatically, or **Enter** finishes early, **Escape** cancels. |
| Result | One `group` containing tread lines, landing rects, the UP arrow and the "UP" label. `meta.arch` stores the runs/landings so the dialog can rebuild them after a parameter change. |
| Editing | Group is not resizable; change parameters in the dialog and the stair rebuilds. |
| Default type | One: **Straight, open tread**. R2 types: presets of the numbers plus tread style (nosing, closed riser). |

### Railing

| | |
|---|---|
| Geometry | Polyline like Wall: `parameters.thickness` (80) stroke, endpoint-only editing, endpoint snapping to stair edges, wall faces and other railings. No layers. |
| Parameters | `thickness`, `height` (1100, 3D only), `balusterSpacing` (120, drawn as ticks along the line). |
| Default type | One: **Baluster**. R2 types: glass, cable, solid panel (change the tick pattern). |

---

## 2. Cloudflare R2 `system/` folder

```text
<bucket root>
├── catalog.json                       ← existing index, gains a "system" array
├── Furnish/…                          ← regular assets, unchanged
└── system/
    ├── wall/
    │   ├── brick-cavity.cai
    │   └── stud-partition.cai
    ├── column/
    │   └── steel-i-section.cai
    ├── door/
    │   └── double-swing.cai
    ├── window/
    │   └── casement.cai
    ├── stair/
    │   └── closed-riser.cai
    └── railing/
        └── glass-panel.cai
```

- Folder name = tool id (`wall`, `column`, `door`, `window`, `stair`, `railing`). One `.cai` per type.
- `system/` is **never shown** in the Assets tab. Types appear only in that tool's Configure dialog.
- `npm run catalog:cai -- <folder>` scans `system/`, validates each package against the
  tool's schema (section 3), and writes them to `catalog.json`:

```json
{
  "version": 1,
  "source": "cloudflare-r2:archai-assets",
  "folders": ["…"],
  "packages": [{ "key": "Furnish/Beds/platform-bed.cai" }],
  "system": [
    { "tool": "wall",   "key": "system/wall/brick-cavity.cai" },
    { "tool": "column", "key": "system/column/steel-i-section.cai" }
  ]
}
```

- The app loads the `system` list once, caches it (IndexedDB, same as local packages), and merges it
  with the built-in defaults. If R2 is unreachable the built-in types still work.
- Local `.cai` types can also be imported from the Configure dialog ("Import type…") and are stored
  in the local store; they are listed under a "Local" heading.

### Package layout for a system type

```text
<type>.cai
├── metadata.json        required
├── mapping.json         required
├── views/
│   ├── top.png|svg      required for door, window, column, stair (the plan symbol / footprint)
│   ├── front.png        required for door, window, column, stair
│   ├── side.png         required for door, window, column, stair
│   └── section.png      required for wall, railing (cross-section swatch shown in the dialog)
└── models/
    └── model.glb        optional for wall & railing (they are extruded from parameters); required otherwise
```

Common `metadata.json` shape:

```json
{
  "caiVersion": 1,
  "id": "wall-brick-cavity",
  "name": "Brick cavity wall",
  "kind": "system",
  "system": {
    "type": "wall",
    "parameters": { "…tool-specific, see section 3…" }
  },
  "size": { "width": 0, "height": 0 },
  "tags": ["external", "masonry"]
}
```

`category` is not used for system types (the folder is implied by `system.type`). `size` is only
meaningful for placed types (door, window, column); walls/railings/stairs set it to `0 × 0`.

---

## 3. How to create a new type — per tool

All steps share the same tail:

1. Create a folder, add `metadata.json`, `mapping.json`, `views/`, `models/` as below.
2. Zip the folder contents (not the folder itself) and rename to `<id>.cai`.
3. Put it in `r2-upload-folder/system/<tool>/`.
4. Run `npm run catalog:cai -- C:\path\to\r2-upload-folder` — it validates the package and updates `catalog.json`.
5. Upload `catalog.json` and the new `.cai` to R2, keeping the relative keys.
6. In the app: place the tool's default element → select it → *Configure* → pick the type.

### Wall type

`system.parameters`:

```json
{
  "layers": [
    { "name": "Render",   "role": "finish", "thickness": 20 },
    { "name": "Brick",    "role": "core",   "thickness": 102 },
    { "name": "Cavity",   "role": "core",   "thickness": 50 },
    { "name": "Block",    "role": "core",   "thickness": 100 },
    { "name": "Plaster",  "role": "finish", "thickness": 13 }
  ],
  "locationLine": "centre"
}
```

- Layers are listed **outside → inside**. At least one `core` layer. Thicknesses in mm; total is derived.
- `views/section.png`: a cross-section swatch (any size, ~1:1 aspect per 100 mm) — shown in the dialog only.
- No `top/front/side` views, no model needed.
- Validation: every layer has `name`, `role ∈ {finish, core}`, `thickness > 0`.

### Column type

```json
{
  "shape": "rectangle",
  "width": 300,
  "depth": 300,
  "height": 3000,
  "material": "steel"
}
```

- `shape` is `rectangle` (needs `width`, `depth`) or `circle` (needs `diameter`).
- `views/top.png|svg` is the plan footprint drawn at `size`; it's used as the fill of the column when
  present (e.g. an I-section outline), otherwise the plain rectangle/circle is drawn.
- `views/front.png`, `views/side.png`, `models/model.glb` required.
- `size` = `{ width, depth }` (or `diameter × diameter`).

### Door type

```json
{
  "operation": "double-swing",
  "width": 1800,
  "leafCount": 2,
  "handing": "left",
  "openingSide": "inside",
  "threshold": 0
}
```

- `views/top.svg` **must be an SVG** — it is the plan symbol. Draw it at `size.width × size.height` in mm
  units, wall face along the top edge (y = 0), leaf swinging toward +y. ArchAI mirrors it for handing
  and flips it for `openingSide`; it never scales it.
- `views/front.png`, `views/side.png`, `models/model.glb` required.
- `size.width` is the opening width; `size.height` is the symbol's depth (swing radius).

### Window type

```json
{
  "mechanism": "casement",
  "width": 1200,
  "height": 1200,
  "sill": 900,
  "openingDirection": "outward"
}
```

- `views/top.svg` required, SVG. Draw at `size.width × 150`. ArchAI stretches it **horizontally only**
  to the instance width and **vertically** to the host wall thickness; keep the frame lines at the
  left/right edges and the glazing line across the middle so stretching looks right.
- `views/front.png`, `views/side.png`, `models/model.glb` required.
- `size` = `{ width, 150 }`.

### Stair type

```json
{
  "width": 1200,
  "riserHeight": 170,
  "treadDepth": 290,
  "totalRise": 3000,
  "landingDepth": 1200,
  "treadStyle": "closed-riser",
  "nosing": 25
}
```

- A stair type is a **preset of numbers plus tread style**; the step-by-step drawing is always done by
  the built-in tool. `treadStyle ∈ {open, closed-riser}` and `nosing` change how tread lines are drawn.
- `views/top.png` = a sample of a few treads (dialog preview), `front.png`, `side.png`, `models/model.glb`
  (one tread + riser module, repeated in 3D).
- `size` = `{ width, treadDepth }`.

### Railing type

```json
{
  "thickness": 60,
  "height": 1100,
  "balusterSpacing": 0,
  "pattern": "glass-panel"
}
```

- `pattern ∈ {baluster, glass-panel, cable, solid}` picks the plan tick pattern; `balusterSpacing = 0`
  means no ticks.
- `views/section.png` required (rail section swatch); no top/front/side; model optional.

---

## 4. Open questions for review

1. **Wall face snapping direction** — "inside" relative to drawing direction (Revit) or relative to the
   nearest enclosed room? I propose drawing direction for now (rooms may not exist yet).
2. **Stairs `totalRise`** — there is no "level height" in the document. Default 3000, editable per
   instance, or add `workspace.levelHeight` and default from that? I propose adding `workspace.levelHeight`.
3. **Curtain wall / facade element** — leave as they are, or fold curtain wall into the Wall tool as a
   wall type (`layers: [{ role: 'core', thickness: 100, name: 'Glazing' }]`)? I propose leaving them.
4. **Models for wall/railing types** — optional as proposed, or required like the other packages?

Decisions taken ("go" on 2026-09-18): 1 drawing direction; 2 per-stair `totalRise` (default 3000, no
`workspace.levelHeight` yet); 3 curtain wall / facade element untouched; 4 models optional for
line-based types.

---

## 5. Where things live

| Concern | File |
|---|---|
| Parameter contract per tool (zod), defaults, package validation | `src/catalog/system-schemas.ts` |
| Dialog field definitions | `src/assets/system-assets.ts` |
| Geometry from parameters (door/window templates, column rect, stair treads, wall offsets) | `src/assets/system-geometry.ts` |
| `meta.arch` readers, resize rules, hosting | `src/assets/arch-meta.ts` |
| Rebuild / resize / endpoint / stair / host commands | `src/commands/builtin/system.ts` |
| Placement (`create-arch-element`, `create-wall-segments`) | `src/commands/builtin/assets.ts` |
| Cursor snapping to wall ends and faces | `src/interaction/wallFaceSnap.ts` |
| R2 index + `system/` loading | `src/catalog/cai.ts`, `src/catalog/hybrid.ts` |
| Catalog validator | `scripts/build-cai-catalog.mjs` (`npm run catalog:cai -- <folder>`) |
| Example packages | `scripts/make-sample-system-types.mjs` (`npm run catalog:samples -- <folder>`) |

## Wall joints

Walls are drawn as filled bodies with square, mitred corners (`src/render/wallBody.ts`): each
face is extended to meet the joined wall's face, T/multi-joints are squared off by half the
neighbour's thickness, and door/window intervals are cut out as holes. Joints are recorded on
both walls (`meta.arch.joints.start|end = { enabled, with: [ids] }`) and made automatically:

- a wall run whose last point lands within 120 mm of its first point closes on itself;
- a run whose free ends land within 120 mm of an existing wall end snaps onto it
  (`joinWallEnd` in `src/commands/builtin/wallJoints.ts`);
- dragging an unjoined end (or Alt-dragging to detach) next to another wall end joins them;
- the Inspector's **Join with neighbouring walls** link icon (`set-wall-joints`) separates both
  ends or joins them again with whatever ends they touch. Walls have no "closed shape" option.
