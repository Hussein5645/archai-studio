# Modeling interaction audit

This audit maps the current modeling workspace to the shared direct-modeling interaction contract.
It is intentionally incremental: body recipes, Manifold evaluation, CAI packaging, materials,
layers, view planes, cameras, LODs, and the existing history remain the system of record.

## Architecture map

| Concern | Existing implementation | Shared boundary / action |
| --- | --- | --- |
| Workspace shell | `ModelingApp.tsx`, `Modeling.module.css` | Canvas-first shell, compact tool flyouts, persistent trays, status bar and Measurements field |
| Pointer/camera routing | `viewport.ts` | Normalized plane projection; left pointer belongs to tools, middle orbit, Shift+middle pan, wheel zoom-to-cursor |
| Tool state | `tools/sketch.ts`, `tools/extrude.ts` | `ModelingTool` lifecycle and controller in `tool-contract.ts`; unfinished sketch state is cancelled on tool switches |
| Snapping | `snap.ts` | Candidate model, ranking, visibility filtering, cycling and locks in `inference.ts`; sketch snapping now routes through it |
| Measurements | Ad-hoc parsing in sketch and app key handlers | Universal parsing in `measurement.ts` for lengths, units, pairs, angles, radius/diameter, `xN`, and `/N` |
| Work plane | Store state plus viewport ray/plane projection | Camera-independent construction, three-point creation, offset, flip, local-axis rotation and ray projection in `work-plane.ts` |
| Preview geometry | `sketchPreview`, `scene.setPreviewMesh` | Remains transient and excluded from persistence/history; tool switching clears it |
| Transactions/history | Store snapshots | Bodies, sketches, materials, and work-plane operations are atomic undo entries; gizmo drags record once at drag start |
| Geometry mutation | Kernel modules and `SolidTool` | Preserved; UI services produce intent while Manifold evaluation remains behind the existing kernel client |
| Selection | Viewport raycasting plus store selection | Still split across viewport/sketch tool; drag-window filters and editing contexts remain Phase 4/5 work |

## Tool contract audit

| Tool family | Preview | Typed input | Cancel / cleanup | Atomic undo | Shared inference | Remaining work |
| --- | --- | --- | --- | --- | --- | --- |
| Line / polyline / rectangle / circle / polygon / arc | Yes | Yes | Escape, Backspace for chains, tool-switch cleanup | Yes | Yes | Rectangle modes, richer arc variants |
| Freehand / offset | Yes | Options value | Escape / tool-switch cleanup | Yes | Partial | Smoothing controls and invalid offset diagnostics |
| Extrude / push-pull / revolve | Kernel mesh preview | Yes | Preview removed on switch | Yes | Face selection uses raycast | Repeat distance and through-solid cut polish |
| Mirror / pattern / boolean / paint | Contextual options; kernel result after commit | Options values | Tool switch safe | Yes | Selection raycast | Direct canvas previews and array entry |
| Body move / rotate | TransformControls | Gizmo snapping | Release restores tool | One entry per drag | No | Base-point Move/Copy and protractor workflow |
| Work plane | Translucent plane and normal gizmo | Exact offset/rotation | Escape cancels placement | Yes | Face/reference-plane picking | Three-point UI sequence and edge+normal UI |

## Phase status

Phase 1 now has the canvas-first shell, compact grouped tools, persistent collapsible trays,
global keyboard measurement capture, stable tool-switch cancellation, universal status guidance,
and navigation that stays available during drawing.

Phase 2 now has the reusable inference core and preferences, candidate cycling support in active
sketch tools, temporary Alt suppression, Shift/axis direction locks, visible inference labels,
camera-independent work-plane selection, exact offset, flip, local-axis rotation, lock/reset, and
perspective projection onto the active plane.

The next implementation pass should deepen Phase 2 candidate collection from rendered body and
import geometry (midpoints, intersections, occlusion, tangency, extensions), then complete the
remaining Phase 3 drawing variants before adding new advanced tools.
