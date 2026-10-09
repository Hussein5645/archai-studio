# Modeling workspace (`/modeling`)

A separate window for authoring free-form assets and packaging them as `.CAI`. It has no
project document: its state lives in `src/modeling/store.ts` and its three.js scene in
`src/modeling/scene.ts`. The window imports GLB layers, draws **sketches** on fixed view planes or a face-matched **work plane**
and turns them into **bodies** with a solid kernel (extrude, primitives; see
[modeling-tools.md](modeling-tools.md)), shows everything in split views with display styles,
and lets the user place the 2D view planes and cameras. Everything autosaves locally.

## Opening it

- **Create** in the Assets library (or `open-modeling`, Mod+Alt+C) asks for the asset's name, then
  opens the workspace at `/modeling?asset=<id>&name=<name>`. The old packaging dialog is gone;
  new `.CAI` assets always start here.
- Web: a new tab (`platform.window.openModeling`). Desktop: IPC `archai:window:openModeling` →
  a second `BrowserWindow` (`dist/index.html#/modeling?…` when packaged, since file:// cannot
  route by path). `src/app/main.tsx` mounts `ModelingApp` for either form.
- **Autosave**: every change (metadata, layers, cameras, planes, layout, styles) is written to
  IndexedDB under the asset id, plus one binary record per imported GLB
  (`src/modeling/persistence.ts`). Reopening the same URL restores everything.

## Layout

| Area | Contents |
| --- | --- |
| Top bar | Name and save status, layout toggle (single / two / four panes), **Frame model**, **Undo / Redo**, **Package .CAI** |
| Left | **Asset** (name, package id, category, tags; the size is measured from the visible model, not typed) and the **Tools** palette (Sketch: select / rectangle / circle / polygon / polyline / freehand / offset; Solid: extrude, push/pull, revolve and primitives; Modify: mirror, pattern, boolean, paint; gizmo mode) |
| Centre | **Options bar** for the active tool (grid, snap, sides, extrude distance / operation / target, the typed value) above the viewport: 1, 2 or 4 panes; each pane header picks its view (**3D**, **Top**, **Front**, **Side**, or any camera) and its display style |
| Right | **Layers** tree (model layers, sketches, bodies with their features, cameras, view planes), the **Inspector** for whatever is selected, and the **Materials** panel |

Every panel collapses from its header.

### Levels of detail and packaging

The **Asset** panel lists the layers with a *low LOD* checkbox: the high level of detail packages
every visible layer, the low one only the ticked layers (also a toggle in the layer Inspector).
Each pane header has a **High LOD / Low LOD** switch next to the view and style, so the low
version can be checked in any view.

**Package .CAI** (`src/modeling/package.ts`) exports the visible layers as `models/model.glb`
(and the low-LOD layers as `models/model-low.glb`; with none ticked it asks whether to package
without — boards on low LOD then show a box), renders the top / front / side views from the model
in every display style (cut at the view planes), writes the metadata (size measured from the
model, `modelHeight`, tags, `lod`, the cameras relative to the model) and mapping, and downloads
`<id>.cai`. See [cai-format.md](cai-format.md).

### Sketches

Sketch tools (`L` open line, `R` rectangle, `C` circle, `P` polygon, `W` closed polyline,
`A` chained arcs, `F` freehand) draw from **any pane**, always on the **work plane** (the offset is
frozen into the sketch, so moving the plane afterwards does not move the drawing). Views only change
what is seen: opening Top, Bottom, Front, Back, Right or Left does not move the drawing onto that
plane — use **Set work plane** (a view plane, a face, or 3 points) for that. A view in which the
work plane is edge-on cannot be drawn in; the options bar says so. Set plane copies a
model surface or reference plane without changing the current view; the work plane can then slide
along its normal with its orange gizmo or a typed offset. Drag to draw (Alt
from the centre), or type a size while dragging (`1200x800`, `300`) and press Enter; a polyline
takes clicks and closes on its first point, Enter or double-click, and `A` (or the *Arc*
checkbox) makes the next segment an arc through a third click; a freehand stroke is simplified
into a closed outline on release. Points snap to shape vertices and centres, to alignment with
the previous point, and to the grid (options bar). Shapes go into the selected sketch when it is
on that plane, otherwise into the newest unused sketch there or a new one (**New sketch** forces
one). With the select tool (`Esc`), click a shape to select it, drag it to move it, and edit its
coordinates and **offset** (grow / shrink) in the Inspector; the **offset** tool (`O`) adds an
offset copy of a clicked shape (rings, frames); `Delete` removes a shape. A sketch's closed
shapes form its region: a shape fully inside another becomes a hole, overlapping shapes merge,
and the sketch's **corner radius** rounds every convex corner. Sketches draw through the model in
2D panes and as lines on their plane in 3D.

### Snapping and picking

While drawing, the pointer snaps to the vertices, edge midpoints and edges of bodies, imported
layers and the linked project, and to where project edges cross the work plane; the snapped vertex
or edge is highlighted in 3D (a green dot, a thick edge) and a marker whose shape and colour say
what was snapped (green square end, cyan triangle midpoint, magenta diamond on an edge, orange
cross intersection) is drawn on the work plane at a fixed screen size in every pane.

With **Select**, the linked project's vertices, edges and faces highlight under the pointer and can
be clicked. The Inspector shows their position, length or area and offers **Move work plane here**,
**Work plane on face** and **Trace onto work plane** (the edge or face outline becomes sketch curves).
A selected body's vertices and edges highlight the same way before they are picked for direct edits.

### Parameters

The **Parameters** panel holds the asset's named values: lengths, angles, counts, numbers and
on / off switches, optionally with limits, or **computed by a formula** of other parameters. Press
**fx** beside any number in the Inspector (a primitive's size, an extrude distance, a sketch shape's
position or size, a pattern's count and step, a body's position and rotation…) to drive it by a
formula such as `(panel - bays * opening) / (bays + 1)`: numbers, parameter names, `+ - * / ^ %`,
brackets, comparisons, `and / or / not`, `min max floor ceil round abs sqrt sin cos tan clamp` and
`if(condition, then, else)`. A driven number follows its formula (typing a value there does not
stick); clearing the formula (or pressing the active fx) frees it at its current value. Renaming a
parameter updates every formula. A facade pattern, for example: a panel, an opening cut repeated
by a linear pattern whose count is `floor(panel / spacing)` and step is `spacing`.

Parameters marked **Editable on the board** travel with the package (`models/recipe.json`, see
[cai-format.md](cai-format.md)): each placed copy gets its own values in the board Inspector and as
parametric graph sockets, and is rebuilt from the recipe. Derived parameters can be shown on the
board as read-only results. Parameters live in `src/modeling/parameters.ts`; the store applies the
formulas in the same update as every recipe change.

### Bodies

**Extrude** (`E`): with a sketch or one of its shapes selected, a translucent preview shows the
prism for the distance in the options bar; drag the arrow in a 3D pane (release commits), type
a distance and press Enter, or press **Extrude**. **New body** starts an `Extrude N` body;
**Add** and **Cut** append a feature to the target body (the newest by default). **Revolve**
(`V`) spins the selected sketch about its u or v direction at a position, by an angle, with the
same new / add / cut choice. **Push/pull** (`Q`): hover a face of a body in a 3D pane, click it,
then drag the arrow or type a distance — pulling out adds material, pushing in cuts (the face
outline becomes a hidden sketch on the face plane). **Mirror** (`M`), **Pattern** (`N`, linear
or radial) and **Boolean** (`B`: select the body to change, then click the tool body; it is
hidden and kept for editing) append features to the selected body from the options bar. The
**Tools** panel also adds a **Box**, **Cylinder**, **Sphere** or **Cone** body resting on the
ground beside what is already modeled. A body is a recipe (`src/modeling/kernel/types.ts`) evaluated by the
Manifold WASM kernel in a Web Worker; its mesh is regenerated whenever the recipe (or a sketch
it uses) changes and never stored (`src/modeling/bodies.ts`). In Layers a body expands into
its features; selecting one edits it in the Inspector (profile, distance, operation; primitive
shape and size) and `Delete` removes it. In a 3D pane, click a body to select it and drag the
gizmo to move it (`G`) or rotate it (`T`, 10 mm / 15° snapping). The body Inspector edits its
name, visibility, low LOD flag, material and placement, and shows the triangle count, volume and
kernel timings. A recipe that fails to evaluate keeps its last mesh and shows a warning badge on
the body and the feature. **Undo / redo** (`Mod+Z`, `Mod+Shift+Z`) cover bodies, sketches and
materials. Bodies package into the GLBs like layers, with their PBR materials.

### Materials

The **Materials** panel lists the asset's materials (seeded from the preset library) as
swatches; the selected one's name, colour, roughness, metalness and opacity are editable, **Add**
duplicates it, **Apply to body** gives it to the selected body, and the **Paint** tool (`K`)
applies it to any body clicked in a pane.

### Layers tree

- **Model** — one entry per imported GLB (only GLB/glTF is accepted), with the file's node
  tree underneath; each node has its own visibility toggle. Import scale defaults to ×1000
  (glTF is in metres) and can be changed in the Inspector.
- **Cameras** — **Add** creates a camera in front of the model. Cameras are scene objects: click
  the body (eye) or the sphere (aim point) in a 3D pane and move it with the gizmo, or
  **right-click** it → *Pilot in this pane* to look through it. Orbiting in a camera pane moves
  that camera.
- **View planes** — top / front / side with their positions; **Reset** puts them just outside the
  model.

### Inspector

Shows the selection: a body, a feature, a sketch or a shape (see above), a layer (name,
visibility, import scale, size, node/triangle counts, delete), a node (name, layer, vertices,
triangles, materials, visibility), a plane (position along its axis) or a camera (name, eye,
aim, FOV, pilot, delete). With nothing selected it summarises the model.

## Viewport (`src/modeling/viewport.ts`)

One `WebGLRenderer` draws every pane with scissor rectangles; each pane owns a camera,
`OrbitControls` and a **display style**: *Realistic* (the GLB materials), *Color* (flat colours,
unlit), *Shaded* (uniform grey, lit), *Wireframe*, *Hidden line* (white faces with feature edges).
Styles swap materials on the shared scene while that pane renders (`ModelingScene.applyStyle`).

- **3D** — perspective orbit. The three view planes are drawn as translucent coloured planes
  (top = blue, front = green, side = red). Click one to select it; a `TransformControls` gizmo
  constrained to the plane's axis (top → Y, front → Z, side → X) moves it. Planes cannot be
  added or removed. Cameras are picked and moved the same way.
- **Top / Front / Side** — orthographic views locked to the matching plane (right-drag pans,
  wheel zooms; the left button belongs to the sketch tools). The model is clipped at the plane
  (`renderer.clippingPlanes`), so moving a plane in 3D or typing its position changes the 2D
  view. The view's own plane is hidden; the other two show edge-on as lines. Clicks pick shapes
  (those on the pane's plane first) and bodies, ignoring what the plane clips away.
- **Camera panes** — look through one camera; guides are hidden. Orbiting writes the eye and
  aim point back to that camera, and its object in the other panes follows.

Imports are re-grounded (centred in plan, resting on Y = 0). The first import moves the planes
just outside the model.

## Project camera view (board)

Related changes in the main workboard:

- The camera marker has two handles like a wall: the **eye** and the **aim point**. Dragging
  either (or moving / rotating the marker) updates the portal camera (`syncCameraFromMarker`
  in `src/commands/helpers.ts`), and the live view re-aims through `useSceneView`. Orbiting in
  the perspective view still writes the eye / aim back to the marker (`set-view3d-camera`).
- New plan symbol (`src/render/shapes.tsx`): camera body with lens, dashed sight line, aim
  crosshair, FOV fan whose radius follows the aim distance, and the name / FOV label.
- Toolbar icon is now the video-camera glyph.
