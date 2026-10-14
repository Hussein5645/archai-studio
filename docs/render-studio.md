# ArchAI VR Preparation

The former Render Studio is now focused on preparing and publishing VR scenes and 360 images.
Open it from **3D view → VR → Prepare Rendered VR Link**. The `open-render-studio` command and
the `/render` window route remain compatible, with the new command label and workspace.

## Authoring

Add elements/furniture, move/rotate/scale objects, and assign/edit materials on the board or
in the 3D view. The preparation window follows project edits through the existing live link.
Duplicate model placement, painting and material editing controls have been removed here.

Saved Render settings retain their `render:<document id>` storage key. Legacy entourage is
preserved read-only and included in both outputs. Unavailable legacy content blocks preparation
with an actionable error. New content belongs to the board.

## Preparation

Choose a physical sun/sky or library HDRI, adjust lighting/exposure/ground, and frame the scene
using the project cameras or VR stops. Fast preview is the default; Rendered preview uses
progressive path tracing for reviewing the scene. Ambient occlusion/bloom controls affect the
preview. They are not embedded post-processing in the baked output. Panoramas are captured at
the selected world position; the viewer selects arrival direction using the saved camera stop.

## Outputs

- **Baked 3D VR**: worker-based diffuse vertex lighting, retaining material textures and
  walkable geometry, then an unlit GLB export and VR link. Review the actual bake in the viewport.
- **360 image**: full path-traced equirectangular PNG, downloadable and publishable as a link
  to the dedicated fixed-viewpoint browser/WebXR viewer. A single monoscopic image per link.

Both offer Fast/Balanced/High Quality. Progress and cancellation are available during preparation;
publishing switches manifests only after the new asset upload succeeds. Project/light/quality
changes flag the prepared result as outdated and prevent publishing it. Preparation results are
held in memory; settings, selected quality/output and published IDs persist across sessions.

See [vr-tours.md](vr-tours.md) for the bake approximations, format, storage and deployment order.

## Code

| Piece | Location |
| --- | --- |
| Preparation UI | `src/studio/RenderStudio.tsx` |
| Preview/path-traced panorama engine | `src/studio/engine.ts` |
| Bake orchestration/export | `src/studio/bake.ts` |
| Detached geometry/material batching | `src/studio/bakeGeometry.ts` |
| Worker and diffuse ray sampling | `src/studio/bake.worker.ts`, `bakeTrace.ts` |
| Quality/invalidation/link keys | `src/studio/vrPreparation.ts` |
| Raw export batching | `src/view3d/vrOptimise.ts` |
| Live link and legacy settings | `src/studio/link.ts`, `settings.ts` |
| Publishing | `src/view3d/vrShare.ts`, `workers/vr-share` |
| Viewer routing and panoramas | SJP-VR: `js/boot.js`, `js/panorama.js` |

## Desktop GPU backend

The Windows app uses Chromium's ANGLE OpenGL backend to reduce path-tracer shader compilation
time. `ARCHAI_ANGLE=d3d11|vulkan|gl` overrides it. The browser route is available for development;
the production browser app directs users to the desktop app for preparation.
