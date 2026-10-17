# Large-project interaction performance

17 October 2026. Implemented in source and packaged as desktop build 0.2.2.31. The installed copy in `C:\Program Files\ArchAI` was upgraded successfully (installer exit code 0). Its application archive matches the tested package by SHA-256. The installed executable also passed an isolated-profile launch and 1,000-element rendering/picking check. Existing user projects and settings were not modified by the verification.

Pointer picking in documents with at least 256 elements now uses a cached bounding-volume tree before the existing exact shape checks. The index belongs to the immutable element table and is released when that table is collected. Edits create a new index; undo can reuse the old one. Small documents and mutable command drafts retain the simple traversal. Picking preserves front-to-back order, scopes, ancestor visibility/locking, curved lines, strokes and acceptance filters.

The board retains its SVG React children during pan/zoom, updating the containing transform without recreating every element node. The empty-board check also follows element-table changes rather than scanning all ids on every store update. Element subscriptions still update shapes when edited.

3D geometry reuse now depends on workspace graphics rather than the entire workspace object. Background, grid, unit and display-style changes no longer discard all built objects. Graphics changes and LOD changes continue to invalidate the appropriate build inputs.

## Synthetic measurements

Filled root rectangles distributed on a grid; half the queries hit a rectangle and half miss the model. Warm times are the median of five batches of 500 queries. The linear comparison reproduces the previous picking traversal specialised to these filled rectangles. Every query's result was compared before timing.

| Elements | First indexed pick, including construction | Previous linear pick | Warm indexed pick |
| ---: | ---: | ---: | ---: |
| 1,000 | 10.71 ms | 0.148 ms | 0.00243 ms |
| 5,000 | 41.34 ms | 0.618 ms | 0.00231 ms |
| 10,000 | 46.10 ms | 1.039 ms | 0.00212 ms |

These measure pointer picking only, not whole-app speed or frame rate. Index construction still has a cost after an edit. Dense overlapping elements can yield many candidates. Import, GPU rendering, mesh decoding and real-project memory were not measured in this diagnostic.

Reproduce with `npx vitest run --config scripts/picking-performance.config.ts`. This replaces `docs/picking-performance-results.json`.

## Validation

- Full unit suite: 696 passed before the additional detached-scope regression; final picking suite: 4 passed, including that regression.
- Large-board browser regression: 1,000 elements, selection before/after viewport changes and an edit passed.
- Existing board/group browser checks: 15 of 17 passed initially. The door configuration check passed on rerun. The remaining primary-flow check expects the rectangle tool to switch to Select; it also fails on the original source, with the same assertion.
- Application and Electron TypeScript checks passed. The combined typecheck remains blocked by existing `unknown` toolbar errors in `e2e/vr-tabletop.spec.ts:132`.
- Lint of changed code passed. Production web build passed with existing bundle-size and import warnings.

## Project opening update (desktop version remains 0.2.2.31)

Installed successfully in `C:\Program Files\ArchAI` with installer exit code 0. The installed application archive matches the new package by SHA-256, and the installed copy passed the loading/mesh-readiness smoke test using a separate test profile. User project data was not changed by verification.

Opening a local, online or picked AIR project now shows a full-screen loading view. It paints before project reads/validation, prepares imported mesh plans and catalog plan images, and preloads model resources for documents with 3D views. The overlay stays through the board commit and first paint; pointer input, shortcuts and menu commands are blocked during the transition. Startup also has a loading placeholder while the session restores.

An Open button no longer bubbles to its project card and starts a second open. Overlapping opens are rejected. Storage reads are limited to eight geometry blobs at a time, missing blob data fails the open instead of presenting an incomplete model, pending local saves are flushed, and loading an existing working copy no longer immediately autosaves it again. Sheet, 3D and component-editor state from the previous document is cleared on load.

Mesh plan nodes subscribe to their own cached plan instead of the entire document and every plan completion, reducing redraws as background work completes. Catalog top-view preparation loads the requested definition rather than scanning/loading all definitions per thumbnail, yields before GPU renders, and waits for existing model loads.

Validation: 700 unit tests passed, then the added previous-view reset regression passed with the focused document suite (48 tests). Five browser checks passed, covering loader visibility before storage reads, input blocking, failure recovery, a 1,000-element board, and group selection in 2D/3D. Application typecheck, Electron build and web build passed; lint has no errors and retains the existing HomeScreen hook warning. The packaged desktop passed an isolated-profile test including a real GLB: its mesh plan was ready when the loading screen closed.

## Perspective pinning, staged 3D opening and save controls

Installed successfully as **0.2.2.31** in `C:\Program Files\ArchAI` (installer exit code 0). The installed archive matches the final package by SHA-256. The installed copy passed the isolated-profile desktop check for loading, 1,000-element selection, pinned camera opening, disabling local autosave and manual saving. User project files/settings were not modified by the check.

Perspective camera navigation now respects pins on the view portal, camera marker or their parent rig. Orbit, pan, zoom and Frame all are disabled while pinned; camera-save commands also refuse to change a pinned camera. Unpinning restores navigation. Identical camera saves are skipped.

3D opening shows a dedicated loading view before resource preparation. Geometry construction yields between elements, including children inside source groups, and styling yields between meshes. Dense feature-edge extraction runs in a worker and reuses the existing geometry cache. Models/textures already loading are awaited. Initial resources are prepared once, view settings are applied before construction, and shaders are compiled before revealing the live canvas. Closing during loading disposes the view safely; procedural geometry is released on close.

The group breadcrumb bar moves to the bottom in 3D. The 2D drawing toolbar is hidden there, 3D controls wrap, and side panels start below the measured toolbar height. The main top bar also wraps when space is limited.

Settings includes **Autosave local projects** (default On). When Off, local working-copy writes, including background/unload flushes, wait for an explicit save. The top bar displays **Unsaved changes**, **Saving…**, **Saved**, or a retry action after a failed save; clicking the state saves the working copy and, for a linked file, offers the existing file save. Online projects always retain automatic local saving and cloud synchronization regardless of this preference.

Validation: **705 unit tests passed** in 114 files. Browser checks cover pinned/unpinned gestures and framing, top-control/panel spacing at 980 px, local autosave off and manual save, cancellation, and worker-based edges on a 22,000-triangle GLB. Existing group and project-loading checks also passed. The packaged desktop passed the previous 1,000-element/mesh-opening check plus pinned-camera opening and manual saving, using an isolated profile. These tests do not establish a capacity limit or an end-to-end speedup for every large model; a single expensive native geometry builder can still exceed a time slice.


## Background model updates and bulk conflict resolution

Model normal repair and complex closed-polygon extrusion now run in a dedicated cancellable geometry worker using transferable binary geometry. The UI keeps the previously committed scene visible during preparation and shows an Updating model status. Scene construction and styling yield between elements/meshes, and new shaders are prepared before swapping in replacements. New edits abort obsolete worker calculations; closing the view cancels pending work. Unchanged children inside imported/source groups are retained and only moved into replacement groups at commit. Changes to unrelated binary blobs no longer invalidate their geometry.

This is a staged separation of expensive geometry work, not a separate thread for every application operation. Document commands, asset decoding, Three.js object construction, section caps and GPU rendering still have main-thread costs. No universal speedup factor is claimed.

The Live Bridge conflict panel has Take source for all, Keep ArchAI for all and Select all conflicts. Resolution snapshots the displayed conflict IDs, ignores duplicates/stale entries, and is one undo step. Held mass deletions retain their existing separate controls.

Validation: 709 unit tests in 114 files passed; seven camera/loading/autosave/background-update/conflict browser tests passed, including normal repair on a 22,000-triangle imported GLB and a deliberately delayed geometry worker proving the prior scene remains visible and a newer edit terminates stale work. Two project-opening browser regressions also passed. Application TypeScript, changed-code lint and production web build passed. Desktop packaging/installation verification is recorded below after completion.

Desktop verification: installed in C:\Program Files\ArchAI as 0.2.2.31, installer exit code 0. Packaged and installed app.asar SHA-256: 0EC7316D894ED94764613442D992CFCA5630C1D3619412FE2847CD91EADC6A08. Both packaged and installed executables passed the isolated-profile check including a real geometry worker, bulk conflict resolution, 1,000-element picking, project/3D loading, pinned camera and manual saving. The additional unrelated-blob reuse regression passed in the 56-test focused suite; the existing 2D/3D group browser checks also passed. User project data was not modified by verification.
