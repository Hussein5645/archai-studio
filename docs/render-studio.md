# Rendering saved 3D views

Each saved 3D view owns its renderer, style, lights and bake record in `meta.view3d`.
Choose Default, Unreal Engine or Baked scene in the View inspector. Style and renderer choices
remain in that inspector; there is no Render button on the application's top bar.

Unreal fills the regular 3D workspace behind floating panels and tools, using native clipping
to preserve their input. There is no separate dark workspace, Lighting tab or Editor window.
View exposes Render image, Bake/Rebake scene, Export interactive and Export to VR. It also
contains the saved per-view exposure slider. Edit board opens the Board alongside the scene.

## Lights, styles and previews

The bottom Lighting chooser creates normal point, spot or area light elements on the Board,
with properties and visibility handled through the regular element tools. Spotlights have source
and target endpoints/elevations; area lights have resizable areas. Edit color, lumens, reach,
orientation, source size and enabled state in Properties. Geometry updates preserve these settings.
Natural materials, warm clay, material colors, structure and architectural lines transfer to
Unreal. Line styles use solid edge geometry for Unreal.
Image export provides resolution presets/custom dimensions, quality and PNG/JPEG output.
Live views use content-addressed mesh/texture assets and element deltas instead of full GLB
imports. Exposure and light changes reuse geometry. Loading bars report preparation, native
element loading, image/export operations, publishing, preview saving and scene baking.

Unreal/Baked Board cards show saved images with no live scene mounted. Completed updates and
Back to Board capture previews. Default views show cached images while loading. Leaving Unreal
saves the native camera back to the same view.

The Layers eye changes visibility in the active view, or Board when editing the Board.
Right-click for Hide everywhere / Show everywhere; global actions clear local overrides.
Rendering, hit testing and exports resolve the same scope. Visibility commands support undo.

Default and live Unreal views feed floor intersections to Board creation commands for columns,
architectural paths, points, rectangles, catalog assets and model imports. Enter finishes paths;
Escape cancels. Room enclosures, level/profile sketches and general drafting remain Board
workflows. Baked shows a snapshot; switch to live rendering to edit the source.

## Local baking and VR

Interactive export offers a folder or an optimized WebXR link and records the active renderer,
style and bake availability. Real-time WebXR links do not require baking, including from Unreal
views. Choosing saved baked lighting requires a current bake (and browser data for web links).
Geometry, lighting and this view's visibility invalidate a bake; camera/style, exposure/bloom
and visibility in other views do not. A rebake replaces the record only after success, preserving
the last good bake on failure. Raw and baked links are stored independently for each view.

Baking creates two distinct artifacts:

- Unreal Lightmass: static-lit Windows/PC OpenXR experience. The worker imports stable IDs,
  generates UVs, bakes sun/sky/local lights, verifies every mesh's lightmaps and cooks a Shipping
  player. Current Lightmass quality is Preview.
- WebXR derivative: separate vertex-lighting bake for the Baked viewport and browser/Quest
  link, using the same scene and lights. These are not Unreal Lightmass lightmaps. Local lights
  include occlusion and falloff; spot/area illumination is approximate. Tour metadata carries
  normalization scale, exposure and tone mapping for SJP-VR.

View records and pending job IDs survive reopening. Browser binaries use local chunked storage,
scoped to unique view/revision IDs. Native artifacts use dedicated worker directories. Moving
an AIR file to another machine may require rebaking: binary artifacts are not embedded in AIR.
Publishing uses the existing authenticated service; no hosted GPU service is provisioned here.

The bundled runtime needs no Unreal Editor. This computer's worker uses
`F:/ur5.5/new/UE_5.8`. Override installation, sources or output root with `ARCHAI_UNREAL_ENGINE`,
`ARCHAI_UNREAL_SOURCES`, `ARCHAI_UNREAL_BAKES`. The installer includes worker source/scripts,
not an Editor installation. Without a configured worker, live runtime rendering still works.

## Checks

Command tests cover view isolation, invalidation and undoable visibility; lighting tests cover
local light color and occlusion. Browser tests cover inline switching, cached previews,
lighting/layer controls and direct placement. The native smoke script tests embedding, live
updates, image output, portable export, reload and cleanup. `--bake` runs the actual worker,
`--styles` captures each style, and `--placement` waits for a real native floor click.
Headset interaction and production uploads still require device/account testing.
## Release 0.3.0.10

See [release notes](release-0.3.0.10.md) for corrected Unreal surface lighting, View lighting presets and controls, renderer-aware folder/WebXR export, and independent native/browser bake preparation. Optimized WebXR links can use real-time lighting without baking; saved native Lightmass output is used by the baked Unreal folder option. Older saved bakes require rebaking under the new lighting calibration.

## Release 0.3.0.11

The Unreal viewport now uses a bundled engine DLL inside Archai's process, with an in-memory scene bridge, retained views and persistent geometry caching. Native input and placement, automatic/manual exposure, spotlight cones and rectangular light dimensions are supported. See [release notes](release-0.3.0.11.md) and [native integration](unreal-native-integration.md) for the verified installer, performance measurements and delivery limits.
