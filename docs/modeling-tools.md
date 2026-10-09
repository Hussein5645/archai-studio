# Proposal: free-form modeling tools

Status: **in progress** (2026-09-19). Extends [modeling.md](modeling.md). Phases 0 (spike),
1 (sketch & extrude) and 2 (real modeling) are implemented; see §16 for what landed, what was
measured and where the implementation departs from the text below. Phases 3+ are still proposals.

## 0. Summary

The modeling workspace gets a **sketch-and-build** toolset: draw 2D profiles on the view planes
(or on a face of the model), turn them into solids (extrude, revolve, push/pull), combine solids
(union, subtract, mirror, pattern) and give them materials. It is simpler than Blender (no
vertex/edge editing, no sculpting) and simpler than Rhino (no NURBS), and it produces clean,
watertight models by construction, which is what makes them look good in a GLB.

Every model is stored as a **feature history** (the recipe), never as a mesh. The mesh is
regenerated from the recipe by a solid kernel (**Manifold**, WASM) running in a Web Worker. This
makes every step editable and undoable, and it is what makes **parametric elements** (§13) a
natural extension rather than a second system: a parametric element is a body whose recipe reads
named parameters and expressions instead of literal numbers, and the board regenerates it with
the same kernel when a parameter changes.

Packaging does not change: bodies are turned into meshes with PBR materials and go through the
existing `GLTFExporter` path into `models/model.glb` (+ `model-low.glb`) of the `.CAI`.

## 1. Goals and non-goals

Goals

- A first-time user can model a table, a chair, a cabinet with a drawer front, or a lamp in
  minutes, with typed dimensions in millimetres.
- Models look finished on the board and in 3D views: round things are smooth, boxes are crisp,
  materials are real PBR.
- Everything is editable after the fact (change a distance, move a hole) and undoable.
- Imported GLB layers and modeled bodies live side by side in the same asset.
- Works with touch (large handles, gizmo, numeric entry) and with keyboard shortcuts.

Non-goals (for this proposal)

- Vertex / edge / face mesh editing, sculpting, retopology.
- NURBS, surfaces that are not solids, true 3D edge fillets (see §7.3 for the workaround).
- Texturing (UV editing, image textures). Materials are colour + roughness + metalness + opacity.
- Animation, rigging, physics.

## 2. Kernel decision

| Option | Verdict |
| --- | --- |
| **Manifold** (`manifold-3d`, WASM, ~1 MB) | **Chosen.** Guaranteed watertight output; 2D `CrossSection` (polygons with holes, booleans, offset with round/miter joins), `extrude`, `revolve`, 3D booleans, `hull`, `refine`/`smooth`, transforms, volume/area, mesh in/out as flat typed arrays. Fast enough for live previews. Well maintained, used by OpenSCAD's web build. |
| OpenCascade.js | True B-rep CAD with edge fillets and STEP, but 30+ MB WASM, seconds to load, hard API. Too heavy for an asset editor. |
| three-bvh-csg | Pure JS, but no manifold guarantee: results can have holes and self-intersections, which break exports and later booleans. |
| Polygon extrusion only (no kernel) | Fastest start, but no booleans/holes/revolve; would be rebuilt within weeks. |

Manifold runs in a **Web Worker** (`src/modeling/kernel/worker.ts`), so the UI never blocks and
evaluation of a body can be cancelled when the user keeps dragging. The main thread sends
recipes and receives `{ positions, normals, indices, faceIds, materialIds }` typed arrays
(transferable), which become `THREE.BufferGeometry`.

## 3. Data model

New state in `src/modeling/store.ts` (all plain JSON, autosaved as today):

```ts
export interface Body {
  id: string;
  name: string;
  visible: boolean;
  lowLod: boolean;               // same meaning as for imported layers
  material: string;              // default MaterialId for faces without an override
  features: Feature[];           // evaluated in order; each may reference earlier ones by id
}

export type Feature =
  | Sketch | Primitive | Extrude | Revolve | Sweep
  | Boolean | Transform | Mirror | Pattern | Smooth | FaceMaterial;

/** A closed 2D drawing on a plane. Open shapes (lines, arcs) are construction geometry. */
export interface Sketch {
  kind: 'sketch'; id: string;
  name: string;                  // "Seat", "Leg profile": used to address its parameters (§13)
  plane: SketchPlane;            // { kind: 'plane', id: PlaneId } | { kind: 'face', bodyId, faceId } | { kind: 'custom', origin, normal, xAxis }
  shapes: Shape2D[];             // rect | circle | polygon | polyline | arc | freehand (already smoothed) | text? (later)
  corners?: { radius: Value };   // 2D fillet applied to every convex corner (CrossSection.offset trick)
  parameters: SketchParameter[]; // the profile's named dimensions and relations (§13.1)
}

/** A number, or an expression over sketch parameters (§13.2). Every dimension in a recipe is a Value. */
export type Value = number | { expr: string };

export interface Primitive {
  kind: 'primitive'; id: string;
  shape: 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'wedge';
  size: [number, number, number]; // mm; cylinder/cone use radius from size[0]/2
  segments?: number;              // default from size (see §7.2)
  placement: Placement;           // position, rotation (Euler, deg)
}

export interface Extrude {
  kind: 'extrude'; id: string;
  profile: string;                // Sketch id (all its closed regions)
  distance: number;               // mm, may be negative
  symmetric?: boolean;
  op: 'new' | 'add' | 'cut';      // cut = subtract from the body so far
  draft?: number;                 // deg, optional taper
}

export interface Revolve { kind: 'revolve'; id: string; profile: string; axis: Line2D; angle: number; op: 'new' | 'add' | 'cut' }
export interface Sweep   { kind: 'sweep';   id: string; profile: string; path: string; op: 'new' | 'add' | 'cut' }   // path = sketch with one open polyline/arc chain
export interface Boolean { kind: 'boolean'; id: string; op: 'union' | 'subtract' | 'intersect'; tool: string }        // tool = another Body id (consumed: hidden, kept for editing)
export interface Transform { kind: 'transform'; id: string; translate?: Vec3; rotate?: Vec3; scale?: Vec3 | number }
export interface Mirror  { kind: 'mirror';  id: string; plane: 'x' | 'y' | 'z' | { origin: Vec3; normal: Vec3 }; keepOriginal: boolean }
export interface Pattern { kind: 'pattern'; id: string; mode: 'linear' | 'radial'; count: number; step: Vec3 | { axis: Vec3; center: Vec3; angle: number } }
export interface Smooth  { kind: 'smooth';  id: string; level: 1 | 2; creaseAngle: number }                          // subdivision, §7.2
export interface FaceMaterial { kind: 'face-material'; id: string; faces: FaceRef[]; material: string }
```

Notes

- `Body.features` is evaluated left to right. Features that create solids (`primitive`, `extrude`
  with `op: 'new'`, `revolve`, `sweep`) start a body; `add`/`cut`/`boolean` combine with the
  running result. This keeps each body a single manifold at the end.
- **Face identity across regeneration** (needed for "sketch on face", per-face materials and
  push/pull): every face carries an id derived from `featureId + localFaceIndex` that Manifold
  preserves through booleans (`originalID` / face run ids). A face that vanishes after an edit
  simply drops its override; nothing breaks.
- `Sketch` stores shapes in the plane's 2D coordinates; the plane itself may move, so the sketch
  follows a moved view plane or an edited face.
- Materials are asset-level: `materials: Record<MaterialId, PbrMaterial>` with `{ name, color, roughness, metalness, opacity }`, seeded from a small preset library (§7.4).
- `ModelingState` also gains transient UI state (not autosaved): `tool`, `activeSketch`,
  `dragPreview`, `selection` extended with `{ kind: 'body' } | { kind: 'face' } | { kind: 'edge' } | { kind: 'feature' }`.

## 4. Evaluation pipeline

```
Body.features ──▶ kernel.evaluate(body, context) ──▶ ManifoldMesh ──▶ BufferGeometry + face map
                        │                                  │
                        │ per-feature cache                │ auto-smooth normals by angle (§7.1)
                        └─ (hash of feature + inputs)      └─ per-face material groups
```

- `src/modeling/kernel/` is **pure TypeScript with no three.js**: `types.ts` (the Feature
  types), `sketch.ts` (shapes → `CrossSection` regions, holes, corner fillets), `evaluate.ts`
  (feature → Manifold op), `mesh.ts` (Manifold → typed arrays + face ids), `worker.ts`.
- Cache: each feature's result is memoised by the hash of its own params plus the hashes of the
  features it reads. Editing the last extrude re-runs only the last extrude. Editing the first
  sketch re-runs everything after it (bodies are small; this is fine).
- Previews while dragging are evaluated with a throttle (~30 ms) and superseded requests are
  dropped in the worker; commit runs one final evaluation.
- Bodies that reference other bodies (`boolean.tool`) are evaluated in dependency order; cycles
  are rejected at edit time.
- Errors (empty region, self-intersecting sketch, degenerate revolve axis) mark the feature with
  an error badge in the tree and the body keeps its last good mesh.

## 5. Tools and interactions

Tools live in the existing **Tools** panel and get shortcuts; the active tool shows a small
options bar above the viewport (like the wall/stair strips on the board) with its parameters.

### 5.1 Sketch tools (2D)

Sketching happens **in a 2D pane** (top / front / side, or a pane temporarily aligned to a face)
so that what the user draws is exactly what they see. Selecting a sketch tool while a 3D pane is
active swaps the active pane to the sketch plane's 2D view (and back on finish).

| Tool | Key | Interaction |
| --- | --- | --- |
| Rectangle | `R` | Corner–corner, or centre–corner with Alt. Typed `W×H` while dragging. |
| Circle | `C` | Centre–radius, 2 points (a diameter) or 3 points on it (options bar); typed radius / diameter. |
| Polygon | `P` | Centre–radius with side count in the options bar (3–24). |
| Polyline | `L` | Click points; click the first point or `Enter` closes. Segments snap to 0/45/90 and 15° with Shift. Arc segment with `A` (three-point). |
| Arc | `A` | Start–end–through, centre–ends (typed angle), or tangent: click the end of a curve to continue it smoothly (elsewhere: a start, then the direction), then the end. |
| Ellipse | `EL` | Centre, the end of one axis, then the other radius (typed values with Enter). Four exact-looking Bézier quarters. |
| Pen curve | `SP` | Click for corners, press and drag for smooth points (the drag pulls out mirrored handles); click the first point to close, Enter or double-click finishes, Backspace removes a point. |
| Freehand | `F` | Drag a stroke; simplified (Douglas–Peucker) and smoothed (Catmull-Rom) into a polyline on release; closes if the ends are near. Good for organic outlines (cushion, leaf). |
| Offset | `O` | Selects a closed shape and offsets it inward/outward by a distance (rings, frames). |
| Corner radius | – | Options-bar field on any sketch: rounds all convex corners (§7.3). |

Sketch editing: shapes are selectable in the 2D pane; drag vertices, edges (keeps direction),
whole shapes; `Delete` removes. The Inspector lists numeric coordinates and dimensions.

**Snapping** (`src/modeling/snap.ts`): grid (from the options bar, default 10 mm), endpoints,
midpoints, centres, intersections, perpendicular/tangent from the last point, existing model
edges projected onto the plane, and the view planes. Inference lines are drawn in the plane
colour (blue/green/red) exactly like SketchUp so alignment is visible. Snap radius is 8 px with a
mouse and 18 px with touch (reusing the `data-touch` convention).

### 5.2 Solid tools (3D)

| Tool | Key | Interaction |
| --- | --- | --- |
| **Extrude** | `E` | With a sketch (or a closed region of it) selected: drag the arrow gizmo or type a distance. Options: symmetric, draft angle, operation (new body / add / cut). Cutting through an existing body is how holes and pockets are made. |
| **Push/pull** | `Q` | Click a **face** of a body and drag along its normal. Pulling outward adds material, pushing inward cuts. Implemented as a sketch-on-face of the face's outline plus an `extrude` (`add`/`cut`) appended to that body's history, so it stays editable. |
| **Revolve** | `V` | Sketch + axis line (a construction line in the sketch, or a plane axis); angle 360 default. Lamps, bowls, knobs, turned legs. |
| **Sweep** | – | Closed profile sketch + open path sketch (rails, pipes, mouldings). Phase 4. |
| **Primitives** | `B` | Box, cylinder, sphere, cone, torus, wedge. Click a plane/face to place, drag to size, or type dimensions. Always a new body. |
| **Boolean** | – | Select body A then B → union / subtract / intersect. B becomes a hidden "tool body" under A's feature (still editable, e.g. move the hole). |
| **Mirror** | `M` | About a plane axis or a picked face; keep original on/off. |
| **Pattern** | – | Linear (count, step) or radial (count, axis, angle). Chair legs, shelf slots, balusters. |
| **Move / Rotate / Scale** | `G` / `T` / `S` | `TransformControls` gizmo on a body (already used for planes/cameras); typed values; snap to grid and to faces ("place on face": drops the body so its bottom sits on the clicked face). Applies to the body as a `transform` feature. |
| **Smooth** | – | Toggle subdivision on a body with level and crease angle (§7.2). |
| **Material** | – | Paint bucket: click a body or a face with a material selected in the Materials panel. |

Every drag shows a live preview (translucent) and accepts a typed number at any time
(`300`, `300/2`, `-40`); `Enter` commits, `Esc` cancels. The Inspector shows the selected
feature's parameters after commit, so nothing is final.

### 5.3 Selection

Selection filter in the options bar: **Body** (default), **Face**, **Edge**. No vertex
selection. Hover highlights the candidate; click selects; Shift adds. Faces are picked by
raycast against the body mesh and mapped through the face map to a `FaceRef`; edges are the
feature edges computed for the hidden-line style (angle threshold), picked by distance.

### 5.4 Undo / redo

Zustand snapshot history of the persistent slice (bodies, materials, layers, cameras, planes).
Recipes are small, so snapshots are cheap; the mesh cache keyed by feature hashes means undo
does not re-evaluate unchanged features. `Mod+Z` / `Mod+Shift+Z` in the workspace, plus buttons in
its top bar.

## 6. Workspace changes

| Area | Change |
| --- | --- |
| **Tools** panel | Becomes the tool palette: Sketch group, Solid group, Modify group, Materials button. Replaces the placeholder text. |
| **Options bar** | Strip above the panes for the active tool's parameters, snapping toggles and the selection filter. |
| **Layers** tree | New **Bodies** section beside *Model* (imported), *Cameras* and *View planes*. A body expands into its feature list (icons per kind, error badge, hidden tool bodies indented). Drag to reorder, `Delete` to remove, click to select + show in Inspector, double-click a sketch to edit it. |
| **Inspector** | Body: name, material, visibility, low LOD, size, triangle count, smooth settings. Feature: its parameters (edit → re-evaluate). Face: material override. Sketch shape: coordinates/dimensions. |
| **Materials** panel | Right side tab next to Layers: swatch grid of the asset's materials with presets to add (§7.4), edit colour/roughness/metalness/opacity. |
| **2D panes** | Sketch editing surface; grid and snap indicators; the plane clip still applies to bodies so a sketch on a plane through the model shows the cut. |
| **3D pane** | Face/edge hover highlight, extrude/push-pull gizmo, body transform gizmo. Orbit stays on right-drag / two fingers (see [modeling.md](modeling.md)). |
| **Top bar** | Undo/redo; the LOD switch and **Package .CAI** are unchanged. |

Keyboard focus rules: shortcuts are active when the viewport has focus; typing a number while a
drag is live goes to the numeric entry, not to tool shortcuts.

## 7. Making models look good

### 7.1 Normals

Manifold output is flat-shaded triangles. On conversion, normals are computed with an **angle
threshold** (default 30°): triangles meeting at less than the threshold share smoothed normals
(cylinders and revolves look round), sharper edges keep hard normals (boxes stay crisp). The same
threshold drives the hidden-line feature edges, so what looks like an edge is an edge.

### 7.2 Curves and subdivision

- Circles/arcs are tessellated by size: segments = clamp(⌈circumference / 4 mm⌉, 24, 128), so a
  20 mm knob and a 600 mm table top both look round without exploding triangle counts.
- **Smooth** feature (Loop subdivision, `LoopSubdivision` from three.js addons, run in the
  worker on the final mesh): level 1–2, with **creases** kept for edges sharper than the crease
  angle. A boxy sofa or cushion becomes soft in one toggle while its base stays flat. Applied
  last, after all solids; the result is display/export geometry only (booleans never run on it).

### 7.3 Rounded corners without 3D fillets

True edge fillets on meshes are the classic hard problem and are out of scope. Two workarounds
cover most furniture:

- **Sketch corner radius** (`Sketch.corners.radius`, via `CrossSection.offset(−r).offset(+r)`
  with round joins): rounds the plan outline before extruding — table tops, seats, panels.
- **Smooth** (§7.2) for soft 3D rounding.

Documented as such in the UI ("Round corners" lives on the sketch and on Smooth, not on edges).

### 7.4 Materials

PBR only: `color`, `roughness`, `metalness`, `opacity` (alpha blend when < 1). Preset library
(~16): oak, walnut, birch, painted white, painted black, matte grey, brushed steel, chrome, brass,
fabric grey, fabric beige, leather brown, glass, frosted glass, concrete, ceramic white. Presets
are copied into the asset so packages are self-contained. Materials export as glTF
`pbrMetallicRoughness`; the board's *Realistic* style shows them as-is and *Color* uses the base
colour.

### 7.5 Low level of detail

The low-LOD subset (`model-low.glb`) can now be produced without the author choosing layers:
**Auto low LOD** in the Asset panel packages each visible body as its convex hull
(`Manifold.hull`) or, when a hull is clearly wrong (hollow shelves: hull volume > 3× body
volume), as its bounding box. Authors can still tick bodies/layers manually as today.

## 8. Packaging and persistence

- `packageAsset` gathers imported layers **and** body meshes (with `smooth` applied, materials as
  groups) into the objects passed to `GLTFExporter`; face material groups become glTF primitives.
  The view renders (top/front/side) and thumbnail use the same meshes. No format change in
  [cai-format.md](cai-format.md); `metadata.json` gains `"modeled": true` and the recipe is
  **also** stored as `models/recipe.json` so a `.CAI` can be re-opened in the workspace and
  edited later (import of a `.CAI` into the workspace becomes possible: layers from the GLB or,
  when a recipe exists, the editable bodies).
- Autosave: `bodies` and `materials` join the IndexedDB record (`persistence.ts`). Meshes are
  never persisted; they are regenerated on open (bodies evaluate in the worker on load).
- Import of GLB layers is unchanged; layers and bodies can be mixed in one asset. An imported
  layer's **mesh** is fixed (its vertices come from the file), but its placement, count,
  stretch and even its use as a solid can be parametric: see §13.8. Bodies are booleaned only
  with other bodies or with imports that pass the manifold check (§13.8, tier 4).

## 9. Touch

Handles/gizmos use the larger touch sizes already defined; the options bar is the primary way to
type numbers on touch (a numeric field with ± steppers). Long-press on a body/face opens the
context menu (extrude / push-pull / material / delete). Two-finger orbit/zoom is already there.

## 10. Code layout

```
src/modeling/
  kernel/                pure, no three.js — unit tested
    types.ts             Feature / Body / Shape2D / PbrMaterial
    sketch.ts            shapes → CrossSection (regions, holes, corner radius, tessellation)
    evaluate.ts          Body → Manifold (per-feature cache, dependency order)
    mesh.ts              Manifold → { positions, normals, indices, faceIds, groups } + angle-smoothed normals
    subdivide.ts         Loop subdivision with creases
    worker.ts            message protocol, cancellation, Manifold WASM init
    client.ts            main-thread API: evaluate(body) → Promise<MeshData>, preview(body) throttled
  tools/                 one file per tool: state machine (pointer events in plane/3D space) → store actions
    sketch/*.ts  extrude.ts  pushPull.ts  revolve.ts  primitive.ts  transform.ts  boolean.ts  pattern.ts  material.ts
  snap.ts                2D/3D snapping and inference lines
  store.ts               + bodies, materials, tool state, history
  scene.ts               + body meshes (from MeshData), face/edge highlight, previews
  viewport.ts            + sketch overlay in 2D panes, gizmos, picking of faces/edges
  ModelingApp.tsx        + Tools palette, options bar, Bodies tree, Materials panel, Inspector sections
  package.ts             + bodies → GLB, recipe.json, auto low LOD
```

Dependencies added: `manifold-3d` (WASM, loaded lazily on first use of a solid tool so the
board build is unaffected), three.js addons already present (`TransformControls`,
`LoopSubdivision`).

## 11. Testing

- Kernel unit tests (vitest, Node): a rectangle extruded 100 mm has volume w·h·100; a cut through
  a box has the expected volume; revolve of a rectangle gives a cylinder within tolerance;
  mirror/pattern counts; corner radius keeps area within bounds; every result `isManifold`.
  Golden triangle/vertex counts for the primitive set.
- Sketch → region tests: nested loops become holes, self-intersections are rejected with a
  message, freehand simplification keeps endpoints.
- Tool state machines tested with synthetic pointer sequences (like `useInteractions` tests).
- Playwright: model a table (rect → extrude → cylinder → pattern), package, place on a board,
  check the 3D view renders it.

## 12. Phases

| Phase | Scope | Exit criterion |
| --- | --- | --- |
| **0 · Spike** | Manifold in a worker, `Body`/`Primitive`/`Transform` types, box + cylinder placed with the gizmo, angle-smoothed normals, bodies exported into the `.CAI`, placed on a board. Undo. | A box and a cylinder modeled here show up on the board and in its 3D view; bundle/perf numbers measured. |
| **1 · Sketch & extrude** | Rectangle, circle, polygon, polyline with snapping in the 2D panes; extrude (new/add/cut) with drag + typed distance; Bodies tree with feature list; Inspector editing; materials with presets and paint. | A table and a shelf unit can be modeled and packaged with typed dimensions. |
| **2 · Real modeling** | Push/pull on faces, sketch on faces, boolean with tool bodies, revolve, mirror, linear/radial pattern, corner radius, offset, arcs, freehand, edge/face selection. | Chair, cabinet with drawer fronts and handles, pendant lamp, door leaf with panels. |
| **3 · Looks good** | Smooth (subdivision with creases), material panel polish, auto low LOD, hidden-line edges from the same threshold, touch pass, recipe.json round-trip (open a `.CAI` for editing). | A sofa with cushions looks right in Realistic on the board; packages re-open editable. |
| **4 · More tools** | Sweep, draft angle, wedge/torus, shell (approximate via inner offset boolean), text on sketch. | Mouldings, rails, pipes, engraved labels. |
| **5 · Parameters** | Sketch parameters with automatic shape dimensions, relations (expressions) inside and across sketches, feature fields driven by sketch parameters, Inspector tables, exposed overview, presets (§13.1–13.4). | A cabinet's width/height/depth/shelf count are set on its profiles once and the whole body follows. |
| **6 · Parametric elements on the board** | Package as a parametric `.CAI` (recipe + parameters), board-side kernel worker, parameter editing in the board Inspector, per-instance regeneration and caching, 2D symbol from the regenerated model (§13.5–13.8). | A parametric cabinet placed three times with three widths shows correctly in plan and 3D. |
| **7 · Parametric imports** | Imported GLB layers in the parametric system, tiers 1–5 (§13.8): placement and enable by expression, pattern/mirror instances, attach to a body face, stretch zones, use as a solid after the manifold check. | A sofa GLB stretches to any width with its arms intact; an imported handle follows a parametric drawer front; a balustrade repeats an imported baluster along a parametric rail. |
| **8 · Parametric system elements** | Doors, windows and stairs authored as parametric bodies with the reserved parameters the board's system tools drive (§13.10). | A modeled door package works with the door tool: the wall opening, swing and leaf follow the tool's width/height. |

Phase 0 is deliberately small and de-risks the three unknowns (WASM load in Vite/Electron, worker
throughput, export fidelity) before any tool UI is written.

## 13. Parametric modeling

Free-form modeling produces a recipe with literal numbers. Parametric modeling is the same recipe
where numbers can be **parameters and expressions**, plus the machinery to change them after the
asset is packaged: in the workspace (a family of variants) and on the board (each placed instance
has its own values). Nothing here needs a second modeling method; it layers on §3–§4.

### 13.1 Parameters live on sketch profiles

Parameters are **owned by sketches**, not by the asset. A sketch profile is where the dimensions
are, so that is where the user names them and relates them; the Inspector of a selected sketch
shows its parameter table. There is no separate asset-level parameter list.

```ts
export interface SketchParameter {
  id: string;                 // stable id; `name` is what users see and what expressions use
  name: string;               // identifier inside the sketch: width, height, radius, spacing
  type: 'length' | 'angle' | 'count' | 'boolean' | 'choice';
  value: Value;               // a literal (a driving parameter) or an expression (a relation, §13.2)
  min?: number; max?: number; step?: number;
  choices?: { id: string; label: string }[];
  exposed: boolean;           // shown on the board Inspector for the placed instance
  label?: string;             // board-facing label ("Seat width"); defaults to `Sketch name · name`
}
```

Where parameters come from:

- **Automatic**: every shape contributes its natural dimensions to the sketch when it is drawn:
  a rectangle `width` / `height`, a circle `radius`, a polygon `radius` / `sides`, an arc
  `radius`, an offset `distance`, the sketch `cornerRadius`. They are literals until the user
  edits them. Names are made unique inside the sketch (`width`, `width2`) and can be renamed.
- **User-added**: any extra named value the profile needs (`thickness`, `count`, `hasLip`).
- Each shape dimension is bound to its parameter through the shape itself (`rect.width:
  { param: 'width' }`), with an **anchor** per axis (`'min' | 'center' | 'max'`) that says which
  point stays fixed when the dimension changes. A polyline vertex can bind `x` / `y` to
  parameters or expressions as well. Sketches stay coordinate-based: no constraint solver (a
  documented non-goal); anchors + expressions cover the furniture cases.

### 13.2 Relations

A parameter whose `value` is an expression is a **relation**: `height = { expr: "width / 2" }`,
`spacing = { expr: "(width - 2 * margin) / (count - 1)" }`. Relations are edited in the same
table (an `=` toggle on the value cell switches literal ↔ expression, with autocomplete).

Scope rules:

- Inside a sketch, names are bare: `width`, `count`.
- Across sketches of the same asset, names are qualified by the sketch name: `Seat.width`,
  `Leg.radius`. A cabinet's `Side.height` can therefore be `= Front.height`, and a shelf
  sketch's `count` can drive a pattern.
- **Feature fields** (`Extrude.distance`, `Revolve.angle`, `Pattern.count` / `step`, `Transform`,
  `Mirror` plane offset, `Primitive.size`) are `Value`s too and may reference sketch parameters
  (`Extrude.distance = { expr: "Seat.thickness" }`), so the third dimension is driven from the
  profile that owns the number. `Feature.enabled?: Value` gates a whole feature (`"Seat.hasLip"`).
  Features do not define parameters of their own; if a feature needs a value with a name, the
  user adds it to the relevant sketch.

Expression language: numbers, bare and qualified parameter names, `+ - * / %`, parentheses,
comparison and `?:`, functions `min max abs round floor ceil sqrt sin cos tan` (degrees), unit
suffixes `mm cm m deg` (lengths are mm internally). A small recursive-descent parser in
`kernel/expr.ts`; no `eval`. Expressions resolve to a plain numeric recipe **before** the kernel
sees it (`resolve(asset) → bodies with literal Values`), so `evaluate()` and its cache are
unchanged: the cache key already hashes the resolved values. Resolution orders parameters by
dependency; a cycle, an unknown name or a division by zero marks the parameter (and the fields
that read it) with an error and keeps the last good value.

### 13.3 Inspector and overview

- **Sketch selected** → Inspector section *Parameters*: one row per parameter — name, value or
  expression, unit, min / max, *exposed* toggle — plus *Add parameter*. Rows that other sketches
  or features reference show a link count; deleting one is refused with the list of references,
  renaming rewrites the references. Editing a value re-resolves and re-evaluates every body that
  depends on it (the "try the family" loop).
- **Shape selected** in a sketch → its dimensions with the parameter each is bound to and the
  anchors.
- **Feature selected** → its fields, each with the `=` toggle and autocomplete of
  `Sketch.name` parameters.
- **Asset overview**: the Asset panel gains a read-only *Exposed parameters* list (every
  `exposed` parameter across sketches, grouped by sketch, with its board label), which is exactly
  what the board Inspector will show; it doubles as a check that the family is complete.

### 13.4 Presets and variants

A `preset` is a named set of values for exposed parameters, keyed by qualified name
(`presets: { id, name, values: Record<'Seat.width' | ..., number | boolean | string> }[]`), e.g.
*600 base unit*, *800 base unit*, *Tall*. Presets are what the catalog shows as the ready-made variants of
one package; the user can still edit any exposed parameter after placing. This reuses the idea
already shipped for wall layer presets ([3d-view-and-presets.md](3d-view-and-presets.md)).

### 13.5 Packaging a parametric `.CAI`

Beyond the fixed GLB (rendered with the default values, so old boards and the 2D views keep
working without a kernel), a parametric package adds:

```text
models/model.glb            everything at default values: imports (placed, stretched, patterned) + bodies
models/parts/<layerId>.glb  each imported GLB as imported (the unmodified source the recipe deforms/places)
models/recipe.json          { recipeVersion: 1, kernel: "manifold@x.y", materials, bodies (sketches carry
                              their parameters and relations), imports: [{ id, name, part, placement,
                              enabled, pattern, attach, stretches, asSolid }], presets }
metadata.json               "parametric": { "recipe": "models/recipe.json", "exposed": ["Seat.width", ...] }
```

Rules that keep packages small and safe: expressions only (no code); every preset must resolve
at packaging time; `views/top.png` etc. are still rendered for the defaults and serve as the
catalog thumbnail. `models/parts/` is only written for parametric packages that contain imports
(non-parametric packages keep shipping just `model.glb`); the source bytes are already in the
workspace's IndexedDB, so this is a copy, not a re-export.

### 13.6 Board side: instances with values

`AssetInstance` elements (`create-asset-instance`) gain
`params?: Record<string, number | boolean | string>` keyed by qualified parameter name
(`"Seat.width"`), holding only the values that differ from the package defaults. The board Inspector shows a **Parameters** section for a selected instance
with the exposed parameters in their groups (length fields in the document's units, choice
dropdowns, toggles, material pickers), plus the preset picker. `set-instance-params` is an
undoable mutation like any other; multi-selection edits apply to all selected instances of the
same package.

### 13.7 Board side: regeneration

- `src/parametric/` in the main app uses the same `kernel/` code (shared module), loaded lazily
  in a worker the first time a parametric instance appears; boards without parametric assets
  never load the WASM.
- Regenerated meshes are cached per `(packageId, resolvedParamsHash)`; identical instances share
  one mesh. Evaluation runs off the main thread with a placeholder (the default GLB, tinted)
  until the result arrives, so dragging a width field stays responsive.
- **Plan symbol**: the board draws asset instances from `views/top.png`. For a parametric
  instance whose values changed, the top view is re-rendered from the regenerated mesh with the
  existing offscreen renderer (`src/view3d/offscreen.ts`, already used for view renders) in the
  styles the package was rendered with, cached by the same hash. Front/side views likewise for
  elevations later. The element's `size` follows the regenerated bounds so snapping, walls and
  dimensions see the real footprint.
- 3D views use the regenerated mesh directly; low LOD uses the auto hull of the regenerated mesh
  (§7.5) so it also follows the parameters.
- **Packages that mix imported GLB layers and recipe bodies**: bodies are regenerated by the
  kernel; imports are loaded once from `models/parts/` and then placed, instanced, stretched or
  (tier 4) booleaned according to their resolved `imports[]` entry (§13.8). The result is one
  composed scene. Nothing in an import's mesh is recomputed unless a stretch or a solid
  conversion asks for it, so a package with imports regenerates about as fast as one without.

### 13.8 Imported GLB layers in a parametric asset

An import's vertices come from a file, so its *shape* cannot have sketch parameters. Everything
around the shape can, and one deformation (stretch zones) changes the shape in a controlled way.
The integration is tiered so that the easy, reliable parts ship first and the hard part is
opt-in with a check.

```ts
export interface ImportedLayer {           // extends today's Layer
  ...
  placement: { translate: Value3; rotate: Value3; scale: Value | Value3 };
  enabled?: Value;                          // boolean expression: the part is present or not
  pattern?: { mode: 'linear' | 'radial'; count: Value; step: Value3 | { axis: Vec3; center: Value3; angle: Value } };
  mirror?: { plane: 'x' | 'y' | 'z'; keepOriginal: boolean };
  attach?: { bodyId: string; faceId: string; offset: Value3; align: 'normal' | 'keep' };
  stretches?: { axis: 'x' | 'y' | 'z'; at: Value; amount: Value }[];
  asSolid?: { status: 'ok' | 'repaired' | 'failed'; volume: number };   // set by the manifold check
}
```

| Tier | What | How it works | Difficulty |
| --- | --- | --- | --- |
| **1 · Placement** | Position, rotation and scale of the import are `Value`s (expressions over sketch parameters); `enabled` shows/hides it. | A matrix per instance, evaluated at resolve time; the mesh is untouched. Non-uniform `scale` is allowed but the Inspector warns that details distort. | Trivial |
| **2 · Instances** | `pattern` and `mirror` repeat the import: balusters along a rail (`count = Rail.length / Rail.spacing`), knobs per drawer, four identical legs. | Instanced meshes (`InstancedMesh` on the board, node copies in the GLB); one mesh in memory. | Easy |
| **3 · Attach to a face** | The import is anchored to a face of a parametric body with an offset in the face's own frame, so it follows the face when the body regenerates: a handle on a drawer front, a tap on a basin, a lamp shade on a modeled base. | Face identity (§3) gives the face's origin and normal after every regeneration; the placement matrix is rebuilt from it. If the face disappears the import keeps its last world placement and shows a badge. | Medium |
| **4 · Stretch zones** | Cut planes on an axis: vertices beyond `at` move by `amount`; vertices before stay. Several zones per axis. A sofa keeps its arms and cushions intact and only the middle grows (`amount = Frame.width - 1800`); a table's legs stay square while the top lengthens. Optional `feather` blends across a band instead of a hard cut. | Vertex displacement on a copy of the mesh, done in the worker; normals recomputed; the *2D* views and the low LOD use the stretched result. This is the classic "stretchable mesh" technique (game 9-slice / Revit stretch). | Medium |
| **5 · Use as a solid** | The import becomes a body feature `{ kind: 'mesh', layerId }` and can be cut, booleaned, patterned and given per-face materials like any body: cut a cable hole through an imported desk, subtract an imported sink from a modeled counter. | Requires a manifold mesh. On import the kernel checks it (`Manifold.isManifold`); if it fails, a repair pass (merge vertices within 0.01 mm, drop degenerate triangles, fix winding, close small holes) is tried and the result recorded in `asSolid.status` with a note in the Inspector. Only `ok`/`repaired` imports can be used as solids; the others remain tiers 1–4. Most CAD-exported GLBs pass; scanned or game-asset meshes often do not. | Hard (mesh repair is best-effort; the check is honest about it) |

Where these show in the UI: the layer's Inspector gets *Placement* (with `=` toggles), *Instances*,
*Attach* (pick a face in a 3D pane), *Stretch* (add a zone by clicking a position on the axis in a
2D pane; a coloured band shows it) and *Solid* (status + *Use as solid*). Stretch amounts and
counts are normal `Value`s, so they can read any sketch parameter and be exposed on the board
through that parameter.

Costs and limits: stretch cannot invent geometry (a stretched cushion seam stays one seam);
attach follows a face, not an edge; tier 5 never runs on imports that fail the check. Materials
of imports are kept from the file (tier 5 additionally allows overrides per face).

### 13.9 Editing round trip

*Edit in modeling workspace* on a parametric instance opens the package's recipe in the
workspace (§8) with that instance's values as the working preset. *Save* re-packages and
updates the local catalog entry; instances keep their own values and regenerate against the new
recipe (a removed parameter falls back to the default with a notice).

### 13.10 System elements as parametric bodies

Doors, windows, columns and stairs on the board are already parameter-driven by their tools
(width, height, swing, sill…). Today their packages ship fixed views and models per type. With
parametric packages, a system package can **bind** exposed sketch parameters to the reserved
names the system tool drives (`metadata.parametric.bindings: { width: "Leaf.width", height:
"Leaf.height", ... }`): `width`, `height`, `thickness`, `elevation`, `swing`, `hinge` for doors;
`width`, `height`, `sill` for windows; `riser`, `tread`, `width`, `runs` for stairs. The tool
writes them, the recipe generates the leaf, frame, glazing or treads, and the plan symbol is derived
from the regenerated top view where the package opts in (`"parametric": { "symbol": "rendered" }`)
or stays the package's drawn symbol otherwise. This is the path to a door/window library that is
modeled once and fits any opening; a later proposal will detail the reserved names per type,
this one only reserves the mechanism.

### 13.11 Non-goals for the parametric side

- Geometric constraint solving (coincident/tangent/equal constraints with a solver).
- Scripting (JavaScript in packages). Expressions are deliberately not Turing-complete.
- Parameters that change topology unpredictably (e.g. a `count` that removes the face a material
  override lives on) are allowed, but the override simply drops (§3, face identity).
- Sketch-style parameters on an imported mesh's own shape (there is no profile to parameterise);
  what an import can do parametrically is listed in §13.8.
- Mesh repair beyond the best-effort pass of §13.8 tier 5; a mesh that stays non-manifold is
  used only as placed/instanced/stretched geometry.

## 14. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Manifold WASM loading in the packaged Electron build (file://) | Vite `?url` import + `locateFile`; verified in phase 0 on both web and desktop. |
| Sketch validity (self-intersecting polylines, freehand loops) | Validate on close; auto-fix by union of sub-loops when possible; otherwise show the error and keep the sketch open. |
| Face ids drifting after edits (materials/push-pull losing their face) | Ids derived from originating feature + local index, which Manifold propagates; a lost face just drops its override (never an error). |
| Users expecting edge fillets | Corner radius on sketches + Smooth cover most needs; the UI names them clearly. Real fillets are a documented non-goal. |
| Triangle counts from subdivision/patterns | Counts shown in the Inspector; Smooth is capped at level 2; export warns above 200k triangles. |
| Booleans with imported (non-manifold) GLBs | Not allowed; imported layers stay reference geometry. |
| Parametric regeneration cost on big boards | Cache by resolved values (identical instances share); worker; placeholder while pending; the default `model.glb` is always available as a fallback. |
| Expression errors in shipped packages | Packages are validated at packaging time (every preset must resolve); the board shows the default model and a badge when an instance's values fail to resolve. |
| Imported meshes failing the manifold check (tier 5) | Honest status on import; tiers 1–4 never need it; repair pass is best-effort and its result is shown, never silently applied. |
| Stretch zones producing ugly geometry on long triangles | Optional feather band; the 2D pane shows the cut; the Inspector previews the widest preset. Stretching across a curved area is the author's call. |
| Kernel version drift between packages and the app | `recipe.json` records the kernel version; the app re-evaluates and warns when volumes differ beyond tolerance from the shipped GLB. |

## 16. Implementation log

### Phase 0 · Spike (done, 2026-09-19)

What landed:

- `manifold-3d` 3.5.3 in a module Web Worker (`src/modeling/kernel/worker.ts`), started lazily
  on the first evaluation; the main-thread client (`kernel/client.ts`) keeps one request in
  flight and one waiting per body, so drags never queue stale work (a superseded request resolves
  to `null`). The WASM is loaded through Vite's `?url` import, which the build turns into a URL
  relative to the worker script, so it also resolves from `file://` in the packaged desktop app
  (emscripten uses XHR for file URIs). The CSP gained `'wasm-unsafe-eval'`.
- `kernel/types.ts` (`Body`, `Primitive`, `Transform`, `PbrMaterial`, `MeshData`),
  `kernel/evaluate.ts` (feature chain → Manifold, per-feature cache keyed by the hash of the
  chain, `FeatureError` naming the feature), `kernel/mesh.ts` (Manifold → typed arrays with
  angle-smoothed normals and the triangle runs per feature), `kernel/materials.ts` (the preset
  library), all pure and unit-tested in Node (`kernel/evaluate.test.ts`).
- Store: `bodies`, `materials` (seeded with the presets), transient `bodyInfo` (triangles,
  volume, evaluation error), `gizmoMode`, and an undo/redo history of `{ bodies, materials }`
  (`Mod+Z` / `Mod+Shift+Z` / `Mod+Y`, buttons in the top bar). Gizmo drags record one entry at
  drag start and update the placement transiently while dragging.
- Scene/viewport: body meshes in `content` (styles, clipping, LOD and the selection outline apply
  as for imports), picking selects a body, the gizmo moves (`G`) or rotates (`T`) it with 10 mm /
  15° snapping, `Delete` removes it. `src/modeling/bodies.ts` re-evaluates a body whenever its
  features change and keeps the last good mesh on an error (badge in Layers, message in the
  Inspector).
- UI: Tools panel with Box / Cylinder / Sphere / Cone (placed beside the existing model) and the
  gizmo mode; **Bodies** group in Layers; Body Inspector (name, visibility, low LOD, material,
  shape and size, position, rotation, triangle count, volume, kernel timings); bodies in the
  Asset panel's LOD list.
- Packaging and persistence: bodies export into `models/model.glb` / `model-low.glb` alongside
  imported layers with their PBR materials as glTF `pbrMetallicRoughness`; `metadata.json` gains
  `"modeled": true`; the recipe autosaves with the asset and is re-evaluated on open.

Measured (dev build, desktop Chromium): worker start including WASM compile 11–15 ms; a box
evaluates in ~0.3 ms, a 128-segment cylinder in 2–4 ms; the WASM is 541 KB (208 KB gzip) and the
worker script 46 KB, both only fetched when a body exists. A package with a box and a cylinder
placed on a board renders in the board's 3D view at both levels of detail.

Decisions that differ from the proposal above:

- **Body placement is a property of the body, not a `transform` feature.** The gizmo edits
  `Body.placement` (position + Euler rotation), which the scene applies to the mesh object, so
  moving a body never round-trips through the kernel and stays instant. The `Transform` feature
  still exists for transforms *inside* the history (before a boolean, for example). Booleans
  between bodies (phase 2) will bring the tool body into the target's frame using both
  placements.
- **Normals come from Manifold's `calculateNormals(0, 30°)`** rather than a hand-written pass:
  it splits vertices along edges sharper than the angle itself, so the output is already
  GL-ready and consistent with what booleans produce.
- **History covers bodies and materials only** for now. Layers involve scene objects and file
  bytes (undoing a removal would need a re-import), cameras and planes have their own gizmo drags;
  both join the history in phase 1 once the drag transaction pattern is shared.
- Primitives are `box | cylinder | sphere | cone` in phase 0; `wedge` and `torus` stay in phase 4.
  Round primitives take their diameter from the width (the Inspector locks depth, and height for
  a sphere).
- A body's first feature must be a primitive (or, from phase 1, an extrude); primitives after the
  first are rejected until `add`/`cut` operations exist.

### Phase 1 · Sketch & extrude (done, 2026-09-19)

What landed:

- **Sketches are asset-level objects** (`ModelingState.sketches`, `kernel/types.ts` `Sketch`):
  a plane + offset and a list of closed shapes (`rect`, `circle`, `polygon`, `polyline`).
  Bodies reference them from `Extrude.profile`, so one profile can be extruded, added or cut
  several times. The **Sketches** group in Layers lists them (plane, offset, shape count,
  visibility); the Inspector edits a sketch (name, visibility, shapes, extrude, delete) and a
  shape (numeric coordinates and dimensions).
- `kernel/sketch.ts`: plane frames (sketch `(u, v)` ↔ world, matching what each 2D pane shows),
  contours, and `sketchRegion()` — shapes are combined largest first; one fully inside the
  region so far becomes a hole, anything else merges, an island inside a hole is added back.
  `Extrude` in `kernel/evaluate.ts`: region → prism along the plane normal (negative distances
  go the other way, `symmetric` straddles the plane), transformed into the world and then into
  the target body's frame (the inverse of its placement), then `new` / `add` / `cut`. The cache
  key of an extrude includes its sketch and the body placement.
- **Sketch tools** (`tools/sketch.ts`, tested with synthetic pointer sequences): rectangle
  (corner–corner, Alt from the centre), circle, polygon (sides in the options bar), polyline
  (click points; click the first point, Enter or double-click closes; Backspace removes a
  point; Shift locks 45°). A typed size during a drag (`1200x800`, `300`, a segment length for
  polylines) replaces the drag length along its direction; Enter commits, Escape cancels.
  Shapes go into the selected sketch when it lies on the pane's plane, else into the most
  recent sketch on that plane that no body uses yet, else a new one (**New sketch** in the
  options bar forces one). The select tool drags shapes on the grid; Delete removes the
  selection (shape, sketch, feature or body).
- **Snapping** (`snap.ts`): shape vertices/centres within the radius (8 px mouse, 18 px touch),
  then alignment with the previous point on either axis, then the grid (options bar, default
  10 mm). A red cross marks the snap point.
- **2D panes are the sketching surface**: pointer events are converted to sketch coordinates on
  the pane's plane at its current offset (`viewport.ts`), sketches draw through the model there
  (depth test off) and with depth in 3D panes, hits ignore what the pane clips away, and bodies
  are picked double-sided so a section view still selects/paints them. Picking a sketch tool
  while the active pane is 3D switches to a 2D pane.
- **Extrude tool** (`tools/extrude.ts`): with a sketch (or one of its shapes) selected it shows
  a translucent kernel-evaluated preview (red for cuts) for the current distance / operation;
  the 3D gizmo becomes an arrow on the profile's centre constrained to the plane normal (release
  commits), a typed number + Enter or the options-bar button commit too. `new` makes an
  `Extrude N` body; `add` / `cut` append a feature to the target body (options bar, default: the
  most recent body).
- **Bodies tree with feature list**: a body expands into its features (icon per kind, error
  badge on the failing one); the **feature Inspector** edits an extrude (profile, distance,
  operation, symmetric), a primitive (shape, size, offset) or a transform, and deletes it (a
  body left without features goes with it).
- **Materials panel** (right column): swatches of the asset's materials, the selected one's
  name / colour / roughness / metalness / opacity, **Add** (duplicate), **Apply to body**, and
  the **Paint** tool (`K`) that gives a clicked body the material.
- Options bar above the panes (tool parameters, grid, snap, extrude options, the typed
  value), tool shortcuts `V R C P L E K` (`Escape` back to select), undo/redo now also covers
  sketches.

Verified in the browser: a 1200 × 800 tabletop typed while dragging, extruded −30 from the top
plane at 1100; four ⌀50 legs drawn as circles in one sketch at 0 and extruded 1070; a 200 × 100
cut through the top from a third sketch; a polyline closed by clicking its first point; shape
drag with undo; paint through a section view; the extrude arrow (Y-only) previewing and
committing on release.

Decisions that differ from the proposal above:

- **Sketches are not features inside a body** (§3 put `Sketch` in `Body.features`). As shared
  asset objects they can be reused by several bodies and `op: 'new'` never has to move a
  sketch out of one body into another. `Sketch.plane` is `{ id, offset }` with the offset frozen
  when the sketch starts: moving a view plane later does not move existing sketches (so two
  sketches on the top plane can sit at different heights).
- Sketch shapes are whole-shape editable (drag, numeric Inspector); vertex/edge dragging and
  the offset / corner-radius tools are left for phase 2 with arcs and freehand.
- Sketching happens only in 2D panes (question 4, as proposed); 3D panes pick shapes only while
  the extrude tool is active so bodies stay clickable.

### Phase 2 · Real modeling (done, 2026-09-19)

What landed:

- **Kernel features** (`kernel/types.ts`, `kernel/evaluate.ts`): `Revolve` (profile sketch +
  an axis line in sketch coordinates + angle; the region is moved so the axis becomes Manifold's
  Y, revolved, and mapped back through the plane frame; profiles crossing the axis are refused),
  `Mirror` (across a plane perpendicular to a body axis at an offset, with or without the
  original), `Pattern` (linear step × count, or radial about an axis through a centre with a
  sweep; full turns spread evenly), and `Boolean` with a **tool body** (the tool is evaluated
  with the same cache, placed as it is in the asset, brought into the target's frame, then
  union / subtract / intersect). `recipeSignature()` hashes a body with its sketches and its
  tool bodies recursively, so editing a tool body re-evaluates its users; cycles are refused.
- **Sketch geometry** (`kernel/sketch.ts`): polylines carry optional `bulges` (DXF-style arc
  segments, tessellated by size), every shape may carry an `offset` (grown or shrunk with round
  joins, which is how rings and frames are drawn), and a sketch may have a `cornerRadius`
  (shrink–grow with round joins rounds every convex corner). `SketchPlane` gained the `custom`
  kind (origin, normal, x axis in world space) for faces.
- **Faces** (`kernel/faces.ts`): Manifold's coplanar face ids become selectable faces. A face's
  plane and boundary loops (outline and holes) are recovered from the mesh; loop coordinates are
  rounded to 0.1 µm because float noise in the projection left hair-thin skins when the outline
  was cut back into the body.
- **Push/pull** (`tools/extrude.ts`, now `SolidTool` for extrude / revolve / push-pull): in a 3D
  pane the hovered face is highlighted; clicking picks it (selection `{ kind: 'face' }`), its
  outline becomes a sketch on the face plane, the arrow gizmo (constrained to the face normal
  via the gizmo's local space) or a typed distance sets the distance, and the commit adds the
  sketch (hidden) and an `extrude` add (pulled out) or cut (pushed in) to that body as one undo
  step. Faces of placed bodies work: the face plane carries the placement and the kernel brings
  the prism back into the body frame.
- **Sketch tools** (`tools/sketch.ts`): **freehand** (stroke simplified with Douglas–Peucker at
  half the snap radius into a closed outline), **offset** (click a shape to add a copy grown or
  shrunk by the option distance), **arc segments** in polylines (`A` or the *Arc* checkbox: the
  next segment takes a through point with a third click; Backspace unwinds it), and the
  **corner radius** field on the Sketch inspector / options bar.
- **Modify tools** in the options bar, applied to the selected body as features: **mirror**
  (axis, position, keep original), **pattern** (linear step or radial axis / centre / sweep,
  count), **boolean** (select the body to change, then click the tool body or pick it; the tool
  body is hidden and kept for editing). Feature inspectors edit all of them; feature rows show
  the tool body's name.
- Shortcuts: `F` freehand, `O` offset, `Q` push/pull, `V` revolve, `M` mirror, `N` pattern,
  `B` boolean; `Esc` is the select tool.

Verified in the browser: a box pulled 200 up from its top face and pushed 50 in from a side
face (clean 20/24-triangle results, volumes exact); a 60 × 300 profile typed in the front pane
and revolved 360° into a tube (volume within 0.04% of π(r₂² − r₁²)h); mirror × 2 and linear
pattern × 3 on that tube; the tube subtracted from the box through the boolean options bar
(tool hidden, box re-evaluated when the tool body changed later); offset copies, a freehand
stroke and a polyline with an arc segment drawn with synthetic pointer events.

Decisions that differ from the proposal above:

- **Sketch on face** is served by push/pull only: the face outline becomes a sketch on a custom
  plane automatically, but there is no "pane aligned to a face" to draw other shapes on. Drawing
  onto a face is done on the view plane at that offset (front/side/top), which covers drawer
  fronts, panels and handles. Free drawing on tilted faces waits for a custom-plane 2D pane.
- **Edge selection** is not implemented: nothing consumes it yet (no edge fillets by design;
  hidden-line edges are computed by the renderer). Face selection exists for push/pull; per-face
  materials (`FaceMaterial`) are deferred to phase 3 with the materials polish.
- The **revolve axis** is chosen in the options bar as the sketch's u or v direction at a
  position (and edited as origin + direction in the feature inspector) rather than picked from a
  construction line, because sketches only hold closed shapes.
- The **boolean tool body** stays a normal body in the Bodies list (hidden), not indented under
  the feature; the feature row names it and the Inspector links to it.

### Curve drawing & editing · Revit-style sketch mode (done, 2026-09-27)

What landed:

- **Planar arrangement** (`kernel/regions.ts`): every selected curve is split where it meets
  another (crossings, T-junctions, collinear overlaps, duplicates collapse), loose tails are
  trimmed off, and the closed faces that remain are found and nested. Curves that touch form one
  network whose faces are all solid (overlapping loops merge, a line across a loop just splits
  it); a network lying inside another network's face is an **opening**, one inside that an
  island again (even / odd depth). `sketchRegion()` now builds regions this way, so lines drawn
  past their corners, a `#` of four lines, or a rectangle drawn twice all extrude cleanly.
  Open ends, dangling tails, crossings and overlaps are reported for diagnostics.
- **Smart multi-curve extrude** (`tools/extrude.ts`): Extrude takes every selected curve
  (Shift/Ctrl+click or window-select), grouped by sketch (`toolOptions.extrude.profiles`, one
  feature per sketch). Clicking inside a region of the profile (away from its curves) picks or
  drops that region; the picks persist on the feature as seed points (`Extrude.regions`), so
  editing the curves later keeps the chosen faces. **Body per region** makes one body per
  region instead of one body. Open curve groups still become surface ribbons. The overlay tints
  picked regions green, dashes the ones left out and marks loose ends red / crossings amber;
  **Fix** extends near-miss ends to their corner, trims tails past corners and removes duplicate
  curves in one undo step. The whole commit (several features / bodies) is one undo step.
- **Sketch edit mode** (store `sketchEdit`, `SketchEditBar`): double-click a curve (or *Edit
  sketch* / *Edit profile* in the options bar) to edit one sketch in isolation, like Revit's
  Edit Boundary. Other sketches fade and are locked, bodies cannot be picked, drawing goes into
  the edited sketch and draw tools stay active. Undo works step by step inside the session but
  stops at its start; **Finish** (Enter) folds every change into one undo step, **Cancel**
  restores the sketch as it was.
- **Drawing options**: *Chain* for the line tool (default on; Esc ends the chain), *Radius*
  (rounds polyline / rectangle corners and chain joints with real arc segments), *Offset*
  (places lines and polylines to the left of where they are drawn), **Pick lines** (`PL`:
  click a body / imported / project edge, or a curve of another sketch, to copy it projected
  into the sketch), **centre-ends arcs** (Arc tool mode) and **tangent arcs** in polylines (`T`).
- **Snapping** (`snap.ts` `curveSnapCandidates`): end points, midpoints (arcs included),
  centres, quadrants, intersections, nearest point on a curve, and from the previous point
  perpendicular feet, circle tangents and extensions of lines past their ends. Each kind can be
  switched off in the Snaps popover.
- **Curves** (`curves.ts`): a polyline segment is a line, an arc (`bulges`) or a cubic Bézier
  (`handles`: its two control points). Curve edits convert sketch curves to exact paths and use
  the board's path maths (`src/drafting/paths.ts`), so trim, extend, corner, split, fillet, join,
  offset (a true parallel curve for open curves) and adding a point keep arcs and pen curves
  exact; circles can cut and bound other curves.
- **Grips** (`sketchEdit.ts` `shapeGrips` / `dragGrip`): selected curves show grips: polyline
  vertices and segment middles (drag the segment), arc middles (change the bow), Bézier handles
  (orange, tied to their point; a smooth point stays smooth), rectangle corners and sides,
  circle quadrants. Ends of other curves joined at a moved point follow it.
  Double-click a selected polyline to add a vertex; Delete removes a selected vertex. Dragging
  one curve of a multi-selection moves them all. The options bar edits the selected curve's
  length / angle, width / height, radius, an arc's radius / angle, or point X / Y directly.
  **Tab / Shift+Tab** steps through the points of the selected curve.
- **Layers**: a solid extruded from several profiles is listed under its sketch with its profile
  count; its feature lists *Profiles* and each *Profile n* (click to select those curves), and each
  loop says which solid uses it as a profile.
- **Curve modify tools** (`tools/modify.ts`, *Edit curves* group, Revit shortcuts): Move `MV`,
  Copy `CO` (with an array count), Rotate `RO`, Mirror `MM` (pick a line or two points; copies by
  default), Scale `RE`, Trim/Extend `TR` (to corner, or delete the clicked piece), Extend to
  boundary `ET`, Split `SL`, Fillet/Chamfer `FL` (also across two lines meeting at a point).
  Base points snap, typed distances / angles / factors apply with Enter, ghost previews follow
  the pointer. Ctrl+D duplicates the selected curves, Ctrl+C / Ctrl+V copy them between
  sketches (projected onto another plane when needed), and Delete removes all selected curves.

Decisions:

- Separate outer loops in one extrude make one body by default (*Body per region* splits them);
  overlapping loops merge (no XOR); edit mode is entered by double-click and by a button.
- Two-letter shortcuts are read from the last two letters typed within 0.9 s; a single-letter
  tool whose key starts a pair (e.g. `M` mirror before `MV`) activates briefly first.

## 15. Open questions for review

1. Kernel: Manifold as proposed, or start with polygon extrusion only and accept a rebuild later?
2. Is `recipe.json` inside the `.CAI` acceptable (packages stay editable), or should recipes stay
   only in the workspace's local storage?
3. First-milestone target assets — proposed: table, chair, cabinet with drawer fronts.
4. Should sketching also be allowed directly in the 3D pane (drawing on a plane in perspective),
   or is "sketch tools switch to the 2D pane" enough for v1? Proposed: 2D pane only in v1.
5. Auto low LOD (hull / box) on by default, or opt-in?
6. Parametric: are sketch parameters + relations + anchors enough, or do you want a real sketch
   constraint solver (much harder; I recommend not)?
9. Parametric: should a feature be allowed to reference a parameter of *any* sketch in the asset
   (proposed), or only of the sketch it consumes (stricter, simpler to explain)?
10. Imports: ship tiers 1–2 with phase 6 (they are cheap and make imports useful immediately)
    and tiers 3–5 as phase 7, as proposed, or hold all import integration until phase 7?
7. Parametric: should the plan symbol of a resized instance be re-rendered from the model (§13.7)
   or scaled from the package's drawn `top.png` in v1 (cheaper, wrong for non-uniform changes)?
8. Parametric system elements (§13.9): in scope for the first parametric milestone, or after
   regular parametric assets work on the board?
