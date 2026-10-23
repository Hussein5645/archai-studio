# Release 0.3.0.6 — Rendering inside saved views

- Default / Unreal Engine / Baked rendering belongs to each saved 3D view.
- Unreal uses the regular light toolbar and existing Inspector, with no dark render frame.
- Point, spot and area lights are available from the bottom toolbar and saved with the view.
- Cached images replace live Unreal scenes on the Board; Default views show previews while loading.
- Layer visibility is scoped to the view or Board. The eye's context menu applies global visibility.
- Direct 3D placement supports native architecture paths, columns, points, rectangles and imports.
- VR publishing requires current baked data for Unreal views; raw views retain raw publishing.
- This computer's Lightmass worker creates verified static-lit Windows/PC VR output. Browser/Quest
  links and the Baked preview use a separate optimized vertex-lighting derivative, not Lightmass maps.

Validation: production build, 766 tests across 133 files, three browser interaction tests,
changed-source lint, actual native embedding/image/export/reload/cleanup, all five styles and a
native placement event. Lightmass verified three meshes with lightmaps and its cooked Shipping
player rendered a capture. Headset hardware and production uploads were not exercised.

Repository-wide lint also reports eight existing errors in unrelated modeling, template and
material-library files; those files were not changed by this release.
