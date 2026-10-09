# Proposal: better stair drawing, wall layer presets, 3D view

Status: **implemented** (2026-09-18) with the decisions below; the sections describe what shipped.

Decisions from review: presets live inside wall `.cai` packages (a package holds any number of
presets, importing one imports them all, saved presets are local and can be exported as a
package); plain `three` without React bindings; every element carries height and elevation
(sill / threshold for windows and doors) in the Inspector's *3D* section; landings were the
stair problem, so the run after a landing now starts from the landing's side (90-degree turn)
or comes back beside the first run on a doubled landing (U-turn).

## 1. Stair drawing

Current: click start, move to grow, click to end, `L` for landing, auto-finish. Improvements:

| Change | Detail |
|---|---|
| Free direction + Shift | Runs follow the cursor at any angle; **Shift** snaps to 15°, and a run after a landing snaps to 0°/±90° relative to the previous run by default. |
| Live dimensions | Caption becomes a small card next to the cursor: `Run 2 · 7 risers · 1960 mm · 11 left · L landing · Enter finish`. Treads are numbered in the preview. |
| Tool options bar | While the stair tool is active a strip above the board shows **Total rise**, **Riser**, **Tread**, **Width**, **Landing depth** and the *Type* picker. Values apply to the stair being drawn; no need to open Configure afterwards. Same strip serves walls (see §2). |
| Landing chip | The caption card has an **Add landing** button as an alternative to `L`; a landing preview follows the cursor before the next run starts. |
| Start snapping | Stair start/end snaps to wall faces, other stairs and landings (reuses the wall snap code). |
| Editing | Selecting a stair shows one handle per flight end; dragging it changes that run's tread count (rebuilds), so a stair can be reshaped without redrawing. |
| Direction flip | Inspector button **Reverse direction** (UP arrow flips). |

## 2. Wall layer presets

- A wall package's `metadata.system.presets` is a list of `{ id, name, layers, locationLine, height, elevation }`; each preset is one entry in the wall Type picker. The default has no presets.
- **Save preset** (name + current layers) in the wall Configure dialog writes to the local package `local-wall-presets`; those appear under **My presets**, can be deleted there, and **Export presets** downloads them as a presets file (`wall-presets.json`: `{ archaiPresets: 1, type, presets }`). **Import presets** reads such a file (or the presets inside a system `.cai`) back into My presets; **Import…** of a wall package lists its presets as well.
- **Use for new** makes the selected preset/type the default for the wall tool (also works for every other system tool).
- Commands: `save-wall-preset`, `delete-wall-preset`, `export-wall-presets`.

## 3. 3D view

### Model
- Walls carry their own `height` (default 3000) and `elevation`; there is no level height yet.
- The **3D portal** is a plain `rect` element with `meta.view3d = { camera: { position, target }, mode: 'perspective' | 'ortho' }`. No new element kind. The board renders a live WebGL canvas inside that rect (React portal positioned over the SVG); the rect can be moved/resized like any element. **Double-click** opens the same scene full-screen (`ui.view3d = { open, portalId }`); Escape returns to the board.
- Tool: **Build ▸ 3D view** drags out the rect; a default 3D view is offered from the empty-state too.

### Rendering (built-in geometry per system type)
| Type | 3D |
|---|---|
| Wall | Polyline extruded to level height, one mesh per layer band (finish/core colours), openings subtracted per door/window (`opening` interval × height/sill). |
| Door | Frame + leaf rotated open by `handing`/`openingSide`; height 2100 default (`parameters.height` added). |
| Window | Frame + glass pane at `sill`, `height`, depth = wall thickness. |
| Column | Box or cylinder, `height`. |
| Stair | Treads + risers from `flights`, riser height, closed/open style; landing slabs. |
| Railing | Posts every `balusterSpacing` + top rail at `height`, pattern → glass panel / cables / solid. |
| Room | Floor slab tinted with the room fill. |
| Everything else (rect/line/text/image) | Flat on the floor at z = 0. |
| Assets (`instance` of a catalog package) | GLB via GLTFLoader, FBX via FBXLoader, bytes taken from the package (`exportPackageBytes`), scaled to the instance footprint, cached per definition. Fallback while loading / without a model: extruded footprint box with the top image as texture. |

### Manipulation (two-way)
- Orbit / pan / zoom (OrbitControls). Click selects (shares `ui.selection`); Shift adds.
- Gizmo (TransformControls) moves in plan (G) and rotates about up (R); drags preview and commit through `move-selection` / `rotate-selection`, so the 2D board updates instantly, hosted elements follow, and undo is shared. Height is edited in the Inspector, not by dragging.
- Double-click an element in 3D → Configure dialog; parameter changes rebuild both views.
- Inspector shows the same panels in both modes.

### Dependencies
`three` only (OrbitControls, TransformControls, GLTFLoader and FBXLoader from `three/examples`).

### Files
`src/view3d/geometry.ts` (per-type 3D logic), `src/view3d/assets.ts` (GLB/FBX + textures), `src/view3d/SceneView.ts` (renderer, picking, gizmo), `src/view3d/useSceneView.ts` (store wiring), `src/view3d/View3DPortal.tsx`, `src/view3d/View3DWorkspace.tsx`, `src/commands/builtin/view3d.ts` (`create-view3d`, `set-view3d-camera`, `open-view3d`, `close-view3d`, `set-solid`). Tool: **3D view** in the toolbar (Shift+3).

### Out of scope for this pass
Levels/storeys, roofs, materials editor, shadows/renders, exporting 3D.

## Open questions
1. Stairs: anything specific that felt wrong when you tried it (direction, snapping, the caption, editing afterwards)? The list above is my guess.
2. Are the three R3F dependencies acceptable, or do you want plain `three` only?
3. Door/window heights: add `height`/`sill` to doors (2100/0) and keep window `height`/`sill` as is?
4. Should a 3D portal follow the whole board or only what's inside its 2D rectangle? (I propose: whole board; the rect is just where the viewport sits.)

---

## Update (same day): joints, presets everywhere, sections, lock view, papers

- **3D wall joints**: joined wall ends are squared off by half the thickness, so corners close.
- **Assets in 3D**: the GLB/FBX inside the `.CAI` package is used (a race that left the footprint box
  when the document changed while the model loaded is fixed).
- **Presets for every system tool**: `system.presets` is allowed in any system package; preset
  packages need no views or models. Local presets live in `local-<tool>-presets`; the dialog offers
  *Save preset / Delete / Import presets / Export presets* for all tools (`save-system-preset`,
  `delete-system-preset`, `import-system-presets`, `export-system-presets`).
- **Section view** (toolbar, Shift+S): click the two ends of a cut line; the portal shows an
  orthographic section looking to the right of the line (`meta.view3d.cut`), pan/zoom only, and the
  board draws the cut marker with arrows. Full screen and editing work like the 3D view.
- **Lock view** (camera icon on any 3D/section portal, `lock-view`; *Lock plan view as image* in the
  workspace inspector, `lock-plan-view`): rasterizes the view into an ordinary image element on the
  board.
- **Paper** (toolbar, Shift+P): a sheet (`meta.paper = { size, orientation, scale, title }`) sized in
  world mm at its scale (A4 landscape at 1:50 by default; drag for a custom sheet). It sits behind
  other elements. The Inspector edits size/orientation/scale/title and **Export PDF** renders
  everything on the sheet (plan, live 3D/section views, images) into a single-page PDF at the sheet
  size (`export-paper-pdf` (vector: the board SVG is converted with jsPDF + svg2pdf.js; 3D/section portals are embedded as 4× PNG snapshots; text uses the standard Helvetica font), 150 dpi).

## Update: per-view settings, sections, highlighting

- Every 3D / section / camera portal remembers its own **style**, **level of detail** and (for
  sections) **depth** in `meta.view3d` (`set-view3d-settings`, no history). The Inspector shows
  them under **View** when the portal is selected; "Board" means follow the document's Display
  settings. The full-screen workspace's style buttons write the same setting.
- Sections clip to the cut line: what lies in front of the line, beyond either end of it, or past
  the optional depth is not drawn; framing centres on the line and fits its length. The cut line
  is drawn on the board as a proper section marker (ticks, direction arrows, lettered bubbles and
  the section's name) by `src/render/shapes.tsx`; it follows the line as it is moved or flipped.
- Selected elements get an accent outline box drawn through everything in 3D and section views,
  on top of the tinted material.

## Board level (2026-10-08)

The board has a working elevation, the **board level** (`workspace.boardElevation`, mm): elements
drawn while it is not zero start at that height in 3D (their own base, e.g. a window sill, is
added on top). Levels, views, annotations, hosted elements and elements linked to a level keep
their own elevation. The status bar (bottom right) shows it with down / up buttons that step to
the previous / next level's elevation, or one storey (3000 mm) when there is none, and a menu of
the document's levels; Alt+PageUp / Alt+PageDown do the same (`board-level-up`,
`board-level-down`), and Inspector -> Workspace -> Display takes any value (`set-workspace
{ boardElevation }`). Code: `src/commands/boardLevel.ts` (applied by the executor after every
create command).

The board and 2D views (plans, sections) always draw placed assets from their 3D model; the level
of detail setting only changes 3D views (docs/cai-format.md).
